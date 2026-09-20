// Identity for the two callers the API trusts: browsers (behind IAP) and agentd (a Google ID token).
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
// agentd: presents `Authorization: Bearer <google id token>` minted for the outfitter-agent
// service account by the Cloud Run Job's metadata server, audience = OUTFITTER_ORIGIN. We verify
// with verifyIdToken and require the token's email to match AGENT_SA_EMAIL.
//
// OUTFITTER_DEV=1 replaces both checks with fixed dev values so the stack runs with no GCP project.

import { OAuth2Client } from "google-auth-library";
import type { Config } from "./config.ts";

export interface Identity {
  email: string;
}

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
}

function headerString(req: RequestLike, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

const IAP_ISSUERS = ["https://cloud.google.com/iap"];

/** Verifies the IAP-signed identity header and returns the caller's email. Throws on failure. */
export async function identityFromRequest(req: RequestLike, config: Config): Promise<Identity> {
  if (config.devMode) return { email: "dev@localhost" };

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
  return { email: payload.email };
}

/** Verifies agentd's bearer token and returns its identity. Throws on failure. */
export async function verifyAgentToken(bearer: string | undefined, config: Config): Promise<Identity> {
  if (!bearer) throw new Error("missing bearer token");

  if (config.devMode) {
    if (bearer !== config.devToken) throw new Error("dev token mismatch");
    return { email: config.agentSaEmail || "agent@dev.local" };
  }

  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({ idToken: bearer, audience: config.origin });
  const payload = ticket.getPayload();
  if (!payload?.email) throw new Error("agent id token has no email claim");
  // Finding #7 (docs/reports/security-review-pr1.md): same defense-in-depth as identityFromRequest.
  if (payload.email_verified === false) throw new Error("agent id token email is not verified");
  if (payload.email !== config.agentSaEmail) throw new Error("agent id token email does not match AGENT_SA_EMAIL");
  return { email: payload.email };
}

/** Parses `Authorization: Bearer <token>`, returning undefined if absent or malformed. */
export function bearerFromHeader(req: RequestLike): string | undefined {
  const header = headerString(req, "authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token;
}
