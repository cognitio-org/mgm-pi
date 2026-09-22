// Personal API tokens (E4.1b): plaintext format, hashing and display-prefix helpers. See
// store/types.ts's ApiToken doc comment and auth.ts's identityFromApiToken for how a token is
// verified. The plaintext is generated once at creation time and never stored or logged -- only
// its sha256 hash and an 8-char display prefix persist.

import { randomBytes, createHash } from "node:crypto";
import type { ApiToken, TokenOwnerMatch } from "./store/types.ts";

export const TOKEN_PREFIX = "outf_";

/** How long a token authenticates after creation. Long enough that a laptop's teleport setup
 * isn't a monthly chore, short enough that a forgotten or leaked token dies on its own. */
export const TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;

/** A new plaintext token: `outf_` + 32 random bytes, base64url-encoded. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** sha256 hex digest of a plaintext token -- the only form ever persisted. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** First 8 characters of the plaintext, for display in the tokens list (e.g. "outf_ab12"). Not a
 * secret on its own (32 bytes of entropy remain hidden), but still only computed at creation time
 * from the plaintext, same as the hash. */
export function tokenPrefix(token: string): string {
  return token.slice(0, 8);
}

/** When `token` stops authenticating: its own expiresAt, or createdAt + TOKEN_TTL_MS for a token
 * minted before expiresAt existed, so no token is exempt from the TTL. */
export function tokenExpiresAt(token: Pick<ApiToken, "createdAt" | "expiresAt">): number {
  if (token.expiresAt) return Date.parse(token.expiresAt);
  return Date.parse(token.createdAt) + TOKEN_TTL_MS;
}

/** Lowercases and trims a TokenOwnerMatch, and validates its shape: an email needs one "@" with
 * text on both sides, a domain is `@example.com` (a leading "@" is added if missing) with no other
 * "@" and at least one dot. Returns an error string instead of throwing so the route can 400. */
export function normalizeOwnerMatch(input: { email?: unknown; domain?: unknown }): TokenOwnerMatch | { error: string } {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const rawDomain = typeof input.domain === "string" ? input.domain.trim().toLowerCase() : "";
  if (email && rawDomain) return { error: "give either email or domain, not both" };
  if (email) {
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return { error: "email must look like name@example.com" };
    return { email };
  }
  if (rawDomain) {
    const domain = rawDomain.startsWith("@") ? rawDomain : `@${rawDomain}`;
    if (!/^@[^@\s]+\.[^@\s]+$/.test(domain)) return { error: "domain must look like @example.com" };
    return { domain };
  }
  return { error: "email or domain is required" };
}

/** Whether `ownerEmail` falls under `match` (already normalized -- see normalizeOwnerMatch). */
export function ownerMatches(ownerEmail: string, match: TokenOwnerMatch): boolean {
  const owner = ownerEmail.trim().toLowerCase();
  return "email" in match ? owner === match.email : owner.endsWith(match.domain);
}
