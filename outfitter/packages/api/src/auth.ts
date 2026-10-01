// Identity for the callers the API trusts: browsers (behind IAP, or a personal API token),
// agentd (a Google ID token), and the "link" role's teleport routes (a personal API token only --
// that role has no IAP session at all).
//
// Browsers: IAP puts a signed JWT in x-goog-iap-jwt-assertion. We verify it against IAP's own
// rotating public keys (getIapPublicKeys) with audience = IAP_AUDIENCE. Despite the "OAuth client
// id" wording in some IAP docs (which applies to IAP fronted by an external HTTPS load balancer),
// IAP enabled directly *on* a Cloud Run service (our case, deploy/api.sh's `--iap` flag) signs the
// JWT's `aud` claim as the resource path `/projects/PROJECT_NUMBER/locations/REGION/services/
// SERVICE_NAME` — see the JWT payload claims table ("aud (Audience)" row, "Cloud Run") at
// https://cloud.google.com/iap/docs/signed-headers-howto. deploy/api.sh computes this value from
// `gcloud projects describe` and sets it as IAP_AUDIENCE automatically.
//
// Personal API tokens (E4.1b, src/tokens.ts, store/types.ts's ApiToken): an `outf_...` bearer
// token, verified by sha256 lookup against the tokens store. This is the *only* credential the
// "link" role's /api/* routes accept (see identityFromLinkRequest) -- that role has no IAP session
// to read, and per the E4.1 design decision (EPIC.md, docs/reports/critic-review-pr15.md finding
// #1) IAP's Google-managed OAuth client can never be used for programmatic access, so there is no
// IAP-based alternative for a laptop client. (Since IAP moved to the custom OAuth client in
// config.env, a *service account* can present an OIDC token IAP accepts -- the live-test identity,
// deploy/README.md "Live-test identity" (#219). Laptop clients still use `outf_` tokens on link.)
// The "web"/"all" role accepts either an IAP session or
// an `outf_` token (identityFromRequest), so the same personal token also works against a
// single-process dev/"all" deployment.
//
// agentd: presents `Authorization: Bearer <google id token>` minted for the outfitter-agent
// service account by the Cloud Run Job's metadata server, audience = OUTFITTER_ORIGIN. We verify
// with verifyIdToken and require the token's email to match AGENT_SA_EMAIL.
//
// OUTFITTER_DEV=1 replaces the IAP/agentd checks with fixed dev values so the stack runs with no
// GCP project. On the web/all role dev mode wins over any bearer, a Dongle included (tokens.test.ts
// pins this), so there every caller is the dev person -- a human writer for gurus-service.ts.
// identityFromLinkRequest never takes the shortcut: on the link role a token is verified the same
// way in dev and prod.

import { OAuth2Client } from "google-auth-library";
import type { FastifyReply, FastifyRequest } from "fastify";
import { tokenAudiences, type Config } from "./config.ts";
import type { ApiToken, ApiTokenKind, Store } from "./store/types.ts";
import { TOKEN_PREFIX, hashToken, isTokenActive, tokenKind } from "./tokens.ts";

export interface Identity {
  email: string;
  /** Operator role (EPIC.md Decisions table): allowed to manage secrets and deploy-level settings
   * via /api/operator/*. Computed once, here, wherever an Identity is built for the "web"/"all"
   * role (identityFromRequest) -- never on the "link" role: a link-role token identity is always
   * `operator: false`, even when its owner is on OUTFITTER_OPERATORS, because that role does not
   * register /api/operator/* (see identityFromLinkRequest below). */
  operator: boolean;
  /** Set when the caller used an `outf_` API token (a Dongle) rather than IAP or dev mode. A
   * Dongle is how an agent reaches the API from a laptop, so a few writes that only a person may
   * make (a tape's `adminTools`, gurus-service.ts) refuse it. */
  viaToken?: boolean;
}

/** True when `email` (trimmed, case-insensitive) is in `operators`. */
export function isOperator(email: string, operators: readonly string[]): boolean {
  const needle = email.trim().toLowerCase();
  return operators.some((op) => op.trim().toLowerCase() === needle);
}

/** A store carrying just the tokens collection -- all identityFromApiToken needs. */
type TokenStore = Pick<Store, "tokens">;

/** lastUsedAt is only rewritten this often per token (see identityFromApiToken), so a busy
 * teleport session doesn't turn every request into a store write. */
const LAST_USED_THROTTLE_MS = 60_000;

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
}

function headerString(req: RequestLike, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

const IAP_ISSUERS = ["https://cloud.google.com/iap"];

/** Resolves an `outf_...` bearer token to its stored record. Never reveals whether a rejected
 * token was unknown, revoked, expired (see tokens.ts's tokenExpiresAt) or of the wrong kind -- all
 * throw the same generic message, since telling them apart would confirm to a guesser that they'd
 * found a once-valid token. E9 §5.2: each kind works on its own routes only. A Dongle (`kind`
 * absent or "dongle") is what /api/* accepts; an A2A key is what the link role's /a2a accepts
 * (routes/a2a.ts). So an A2A key on /api/* and a Dongle on /a2a both get 401. Updates lastUsedAt
 * at most once per LAST_USED_THROTTLE_MS, best-effort (a failed update never fails the auth check
 * itself). */
export async function verifyApiToken(bearer: string, store: TokenStore, kind: ApiTokenKind): Promise<ApiToken> {
  const record = await store.tokens.findByHash(hashToken(bearer));
  const now = Date.now();
  if (!record || !isTokenActive(record, now) || tokenKind(record) !== kind) {
    throw new Error("invalid or revoked API token");
  }

  const lastUsed = record.lastUsedAt ? Date.parse(record.lastUsedAt) : Number.NaN;
  if (!Number.isFinite(lastUsed) || now - lastUsed >= LAST_USED_THROTTLE_MS) {
    try {
      await store.tokens.update(record.id, { lastUsedAt: new Date(now).toISOString() });
    } catch {
      // best-effort; a failed lastUsedAt write must never block auth.
    }
  }
  return record;
}

/** verifyApiToken for a Dongle (the only kind /api/* accepts), as its owner's identity. Always
 * `operator: false` here -- a token's owner only becomes an operator through identityFromRequest's
 * OUTFITTER_OPERATORS check, never on the "link" role (see identityFromLinkRequest). An A2A key
 * never resolves here; routes/a2a.ts calls verifyApiToken with "a2a" itself. */
export async function identityFromApiToken(bearer: string, store: TokenStore): Promise<Identity> {
  const record = await verifyApiToken(bearer, store, "dongle");
  return { email: record.ownerEmail, operator: false, viaToken: true };
}

/** The "link" role's only /api/* credential (see the module doc comment above): a personal API
 * token, unconditionally -- no IAP, no dev-mode shortcut. Deliberately never grants the operator
 * role (EPIC.md Decisions table): the link role does not register /api/operator/* (routes/index.ts),
 * so there's nothing an operator flag would unlock here -- but a token owner who happens to be on
 * OUTFITTER_OPERATORS must not read as
 * an operator through this path regardless. */
export async function identityFromLinkRequest(req: RequestLike, store: TokenStore): Promise<Identity> {
  const bearer = bearerFromHeader(req);
  if (!bearer) throw new Error("missing bearer token");
  return identityFromApiToken(bearer, store);
}

/** Verifies the caller's identity for the "web"/"all" roles: an `outf_` personal API token when
 * present, an IAP-signed header otherwise. Throws on failure. The operator flag (EPIC.md Decisions
 * table) is computed exactly here, for every path this function returns through -- dev mode,
 * token and IAP alike -- so there is one place that decides who is an operator. Dev mode
 * (`OUTFITTER_DEV=1`, identity `dev@localhost`) always counts as an operator, so local development
 * doesn't need OUTFITTER_OPERATORS set at all. */
export async function identityFromRequest(req: RequestLike, config: Config, store: TokenStore): Promise<Identity> {
  if (config.devMode) return { email: "dev@localhost", operator: true };

  const bearer = bearerFromHeader(req);
  if (bearer?.startsWith(TOKEN_PREFIX)) {
    const identity = await identityFromApiToken(bearer, store);
    return { email: identity.email, operator: isOperator(identity.email, config.operators), viaToken: true };
  }

  const jwt = headerString(req, "x-goog-iap-jwt-assertion");
  if (!jwt) throw new Error("missing x-goog-iap-jwt-assertion header");
  if (!config.iapAudience) throw new Error("IAP_AUDIENCE is not configured");

  const client = new OAuth2Client();
  const { pubkeys } = await client.getIapPublicKeys();
  const ticket = await client.verifySignedJwtWithCertsAsync(jwt, pubkeys, config.iapAudience, IAP_ISSUERS);
  const payload = ticket.getPayload();
  if (!payload?.email) throw new Error("IAP assertion has no email claim");
  // Finding #7 (docs/reports/security-review-pr1.md): defense in depth. verifySignedJwtWithCertsAsync
  // already validates signature/issuer/audience/expiry; this only matters if a token ever carried an
  // explicit `email_verified: false` (missing/undefined is fine -- most tokens don't set the claim).
  if (payload.email_verified === false) throw new Error("IAP assertion email is not verified");
  return { email: payload.email, operator: isOperator(payload.email, config.operators) };
}

/** Verifies agentd's bearer token and returns its identity. Throws on failure. agentd identities
 * are never operators -- the concept doesn't apply to the agent service account -- so this always
 * returns `operator: false`. */
export async function verifyAgentToken(bearer: string | undefined, config: Config): Promise<Identity> {
  if (!bearer) throw new Error("missing bearer token");

  if (config.devMode) {
    if (bearer !== config.devToken) throw new Error("dev token mismatch");
    return { email: config.agentSaEmail || "agent@dev.local", operator: false };
  }

  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({ idToken: bearer, audience: tokenAudiences(config) });
  const payload = ticket.getPayload();
  if (!payload?.email) throw new Error("agent id token has no email claim");
  // Finding #7 (docs/reports/security-review-pr1.md): same defense-in-depth as identityFromRequest.
  if (payload.email_verified === false) throw new Error("agent id token email is not verified");
  if (payload.email !== config.agentSaEmail) throw new Error("agent id token email does not match AGENT_SA_EMAIL");
  return { email: payload.email, operator: false };
}

/** Fastify preHandler guarding every /api/operator/* route (routes/operator.ts): 403 unless the
 * auth preHandler (server.ts) already resolved an operator identity for this request. Runs after
 * that preHandler in the route's own `preHandler` array, so `req.identity` is always set by the
 * time this runs on a route that has it registered at all (see docs/protocol.md for the auth
 * preHandler ordering). */
export async function requireOperator(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.identity?.operator) {
    reply.code(403).send({ error: "operator role required" });
  }
}

/** Verifies a Google-signed OIDC token from Cloud Tasks or Cloud Scheduler (audience = this
 * service's origin, email = TASKS_SA_EMAIL). Dev mode accepts the agent dev token instead. */
export async function verifyTasksToken(bearer: string | undefined, config: Config): Promise<void> {
  if (!bearer) throw new Error("missing bearer token");
  if (config.devMode) {
    if (bearer !== config.devToken) throw new Error("dev token mismatch");
    return;
  }
  if (!config.tasksSaEmail) throw new Error("TASKS_SA_EMAIL is not configured");
  const ticket = await new OAuth2Client().verifyIdToken({ idToken: bearer, audience: tokenAudiences(config) });
  const payload = ticket.getPayload();
  if (payload?.email_verified === false) throw new Error("tasks token email is not verified");
  if (payload?.email !== config.tasksSaEmail) throw new Error("tasks token email does not match TASKS_SA_EMAIL");
}

/** Parses `Authorization: Bearer <token>`, returning undefined if absent or malformed. */
export function bearerFromHeader(req: RequestLike): string | undefined {
  const header = headerString(req, "authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token;
}
