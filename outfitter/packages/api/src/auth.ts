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
// agentd: presents `Authorization: Bearer <google id token>` minted by its metadata server,
// audience = OUTFITTER_ORIGIN: for the outfitter-agent service account on Cloud Run, or for
// outfitter-sandbox (SANDBOX_SA_EMAIL, #202) on GKE. We verify with verifyIdToken and require the
// token's email to be one of the two; agentlink then holds a sandbox identity to gke runs.
//
// OUTFITTER_DEV=1 replaces the IAP/agentd checks with fixed dev values so the stack runs with no
// GCP project. On the web/all role dev mode wins over any bearer, a Dongle included (tokens.test.ts
// pins this), so there every caller is the dev person -- a human writer for gurus-service.ts. The
// exception is a device access token (`kda_`, #389 CA-1), verified in dev mode too, since the
// routes only a signed-in Kernal may use need its device id. identityFromLinkRequest never takes
// the shortcut: on the link role a token is verified the same way in dev and prod.
//
// Device access tokens (docs/specs/central-auth.md §1.6): `kda_...`, from the device-code login
// (central/device-login.ts), accepted on every role wherever a Dongle is, and likewise never an
// operator.

import { OAuth2Client } from "google-auth-library";
import type { FastifyReply, FastifyRequest } from "fastify";
import { tokenAudiences, type Config } from "./config.ts";
import type { ApiToken, ApiTokenKind, Store } from "./store/types.ts";
import { TOKEN_PREFIX, hashToken, isTokenActive, tokenKind } from "./tokens.ts";
import { ACCESS_TOKEN_PREFIX } from "./central/device-tokens.ts";
import { clientIp, deviceForAccessToken, dongleOwnerAllowed, isLoginAllowed } from "./central/device-login.ts";

export interface Identity {
  email: string;
  /** Operator role (EPIC.md Decisions table): allowed to manage secrets and deploy-level settings
   * via /api/operator/*. Computed once, here, wherever an Identity is built for the "web"/"all"
   * role (identityFromRequest) -- never for a token, on any role (#390): a token identity is always
   * `operator: false`, even when its owner is on OUTFITTER_OPERATORS. Only IAP and dev mode make
   * operators. */
  operator: boolean;
  /** Set when the caller used an `outf_` API token (a Dongle) or a device access token rather than
   * IAP or dev mode. A token is how an agent reaches the API from a laptop, so a few writes that
   * only a person may make (a tape's `adminTools`, gurus-service.ts, approving a device) refuse it. */
  viaToken?: boolean;
  /** #389 CA-1 (docs/specs/central-auth.md §1.6): set when the caller used a device access token
   * (`kda_`), to the device's id. Such a caller also has `viaToken: true` and is never an operator.
   * Routes that only a signed-in Kernal may use (key delivery, CA-4/CA-5) require it. */
  deviceId?: string;
}

/** True when `email` (trimmed, case-insensitive) is in `operators`. */
export function isOperator(email: string, operators: readonly string[]): boolean {
  const needle = email.trim().toLowerCase();
  return operators.some((op) => op.trim().toLowerCase() === needle);
}

/** A store carrying just the token collections: Dongles and device access tokens. */
type TokenStore = Pick<Store, "tokens" | "devices">;

/** What the allow-list check on a Dongle needs (#390, central/device-login.ts). Optional where it
 * is a parameter, so a caller without one keeps today's behaviour. */
type AllowConfig = Pick<Config, "devMode" | "loginAllow" | "operators">;

/** lastUsedAt is only rewritten this often per token (see identityFromApiToken), so a busy
 * teleport session doesn't turn every request into a store write. */
const LAST_USED_THROTTLE_MS = 60_000;

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  /** The socket address (Fastify's req.ip): a device's lastSeenIp when there's no X-Forwarded-For. */
  ip?: string;
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
/** verifyApiToken's refusal of the token itself (unknown, revoked, expired, the wrong kind), as
 * opposed to a store error, which is not the token's fault. */
export class InvalidApiTokenError extends Error {}

export async function verifyApiToken(bearer: string, store: Pick<Store, "tokens">, kind: ApiTokenKind): Promise<ApiToken> {
  const record = await store.tokens.findByHash(hashToken(bearer));
  const now = Date.now();
  if (!record || !isTokenActive(record, now) || tokenKind(record) !== kind) {
    throw new InvalidApiTokenError("invalid or revoked API token");
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
 * `operator: false`: no token makes an operator, on any role (#390). An A2A key
 * never resolves here; routes/a2a.ts calls verifyApiToken with "a2a" itself. */
export async function identityFromApiToken(bearer: string, store: Pick<Store, "tokens">, config?: AllowConfig): Promise<Identity> {
  const record = await verifyApiToken(bearer, store, "dongle");
  // #390 "tokens outlive the owner's access": once OUTFITTER_LOGIN_ALLOW is set, a Dongle whose
  // owner is no longer on it stops working, with the same refusal as any other bad token.
  if (config && !dongleOwnerAllowed(record.ownerEmail, config)) throw new InvalidApiTokenError("invalid or revoked API token");
  return { email: record.ownerEmail, operator: false, viaToken: true };
}

/** #389 CA-1 (docs/specs/central-auth.md §1.6): a device access token (`kda_`) as its owner's
 * identity, never an operator. Every refusal is the Dongle's generic one. Given a config, an owner
 * no longer on the login allow-list is refused too: a machine token (§1.7) never refreshes, so this
 * is the only place its owner's access is re-checked, and for a laptop it closes the up-to-an-hour
 * window before the next refresh. lastSeenAt/lastSeenIp are rewritten at most once per
 * LAST_USED_THROTTLE_MS, best-effort. */
export async function identityFromDeviceToken(bearer: string, store: Pick<Store, "devices">, ip?: string, config?: AllowConfig): Promise<Identity> {
  const now = Date.now();
  const device = await deviceForAccessToken(store, bearer, now);
  if (!device) throw new InvalidApiTokenError("invalid or revoked API token");
  if (config && !isLoginAllowed(device.ownerEmail, config)) throw new InvalidApiTokenError("invalid or revoked API token");
  const lastSeen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : Number.NaN;
  if (!Number.isFinite(lastSeen) || now - lastSeen >= LAST_USED_THROTTLE_MS) {
    try {
      await store.devices.update(device.id, { lastSeenAt: new Date(now).toISOString(), ...(ip ? { lastSeenIp: ip } : {}) });
    } catch {
      // best-effort, like a Dongle's lastUsedAt.
    }
  }
  return { email: device.ownerEmail, operator: false, viaToken: true, deviceId: device.id };
}

/** A bearer of either kind /api/* accepts: a device access token or a Dongle. */
async function identityFromBearer(bearer: string, req: RequestLike, store: TokenStore, config?: AllowConfig): Promise<Identity> {
  if (bearer.startsWith(ACCESS_TOKEN_PREFIX)) return identityFromDeviceToken(bearer, store, clientIp(req), config);
  return identityFromApiToken(bearer, store, config);
}

/** The "link" role's only /api/* credential (see the module doc comment above): a personal API
 * token, unconditionally -- no IAP, no dev-mode shortcut. Deliberately never grants the operator
 * role (EPIC.md Decisions table): the link role does not register /api/operator/* (routes/index.ts),
 * so there's nothing an operator flag would unlock here -- but a token owner who happens to be on
 * OUTFITTER_OPERATORS must not read as
 * an operator through this path regardless. */
export async function identityFromLinkRequest(req: RequestLike, store: TokenStore, config?: AllowConfig): Promise<Identity> {
  const bearer = bearerFromHeader(req);
  if (!bearer) throw new Error("missing bearer token");
  return identityFromBearer(bearer, req, store, config);
}

/** Verifies the caller's identity for the "web"/"all" roles: a device access token (`kda_`) or an
 * `outf_` personal API token when present, an IAP-signed header otherwise. Throws on failure. The
 * operator flag (EPIC.md Decisions table) is computed exactly here, for every path this function
 * returns through, so there is one place that decides who is an operator: IAP by
 * OUTFITTER_OPERATORS, dev mode (`OUTFITTER_DEV=1`, identity `dev@localhost`) always (so local
 * development doesn't need OUTFITTER_OPERATORS set at all), and a token never (#390: a Dongle used
 * to inherit its owner's operator role on "all"). */
export async function identityFromRequest(req: RequestLike, config: Config, store: TokenStore): Promise<Identity> {
  const bearer = bearerFromHeader(req);
  // #389: a device access token is verified even in dev mode. It is what a signed-in Kernal sends,
  // and the routes only a device may use (key delivery, CA-4/CA-5) need its deviceId.
  if (bearer?.startsWith(ACCESS_TOKEN_PREFIX)) return identityFromDeviceToken(bearer, store, clientIp(req), config);

  if (config.devMode) return { email: "dev@localhost", operator: true };

  // #390 Dongle fix 2: a token is never an operator, on any role; only IAP and dev mode are.
  if (bearer?.startsWith(TOKEN_PREFIX)) return identityFromApiToken(bearer, store, config);

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

/** Verifies agentd's bearer token and returns its identity: `email` is AGENT_SA_EMAIL or
 * SANDBOX_SA_EMAIL. Throws on failure. agentd identities are never operators -- the concept doesn't
 * apply to the agent service accounts -- so this always returns `operator: false`. */
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
  if (!agentEmails(config).includes(payload.email)) {
    throw new Error("agent id token email matches neither AGENT_SA_EMAIL nor SANDBOX_SA_EMAIL");
  }
  return { email: payload.email, operator: false };
}

/** The service accounts an agentd id token may carry: AGENT_SA_EMAIL and, when set,
 * SANDBOX_SA_EMAIL. Empty values never match (an unset AGENT_SA_EMAIL accepts no token at all). */
function agentEmails(config: Config): string[] {
  return [config.agentSaEmail, config.sandboxSaEmail].filter((e) => e !== "");
}

/** Whether `email` may act for a run the provider `provider` started. SANDBOX_SA_EMAIL is the GKE
 * sandboxes' identity (#202), so it's held to gke runs; AGENT_SA_EMAIL is accepted for every run,
 * since GKE sandboxes carry it until gke-iam.sh moves their Workload Identity binding. */
export function agentMayActForRun(email: string, provider: string | undefined, config: Config): boolean {
  if (config.sandboxSaEmail === "" || email !== config.sandboxSaEmail || email === config.agentSaEmail) return true;
  return provider === "gke";
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
