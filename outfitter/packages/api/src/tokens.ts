// Personal API tokens (E4.1b): plaintext format, hashing and display-prefix helpers. See
// store/types.ts's ApiToken doc comment and auth.ts's identityFromApiToken for how a token is
// verified. The plaintext is generated once at creation time and never stored or logged -- only
// its sha256 hash and an 8-char display prefix persist.

import { randomBytes, createHash } from "node:crypto";
import type { ApiToken, ApiTokenKind, TokenOwnerMatch } from "./store/types.ts";

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

/** Whether `token` still authenticates: not revoked and not past tokenExpiresAt. `!(now < …)`
 * rather than `now >= …` so an unparsable date (NaN) counts as expired, never as live. */
export function isTokenActive(token: Pick<ApiToken, "revokedAt" | "createdAt" | "expiresAt">, now = Date.now()): boolean {
  return !token.revokedAt && now < tokenExpiresAt(token);
}

/** E9 §5.2: a token's kind. Absent (every token minted before the field) is a Dongle. Anything
 * else stored there reads as "a2a" only when it is exactly that, so an unknown value never widens
 * what a token can reach: it is neither kind and fails both checks in auth.ts. */
export function tokenKind(token: Pick<ApiToken, "kind">): ApiTokenKind | undefined {
  if (token.kind === undefined || token.kind === "dongle") return "dongle";
  if (token.kind === "a2a") return "a2a";
  return undefined;
}

/** Consumer mail providers: a domain revoke there would hit every unrelated user who signed in
 * with one (IAP admits individual gmail.com addresses, for example). Revoke those by email. */
const SHARED_MAIL_DOMAINS = new Set([
  "@gmail.com",
  "@googlemail.com",
  "@outlook.com",
  "@hotmail.com",
  "@live.com",
  "@yahoo.com",
  "@icloud.com",
  "@me.com",
  "@proton.me",
  "@protonmail.com",
]);

/** Lowercases and trims a TokenOwnerMatch, and validates its shape: an email needs one "@" with
 * text on both sides, a domain is `@example.com` (a leading "@" is added if missing) with no other
 * "@" and at least one dot. ASCII only, so a look-alike character pasted into the operator's input
 * is refused rather than silently matching nothing. A domain matches that domain exactly, not its
 * subdomains. Returns an error string instead of throwing so the route can 400. */
export function normalizeOwnerMatch(input: { email?: unknown; domain?: unknown }): TokenOwnerMatch | { error: string } {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const rawDomain = typeof input.domain === "string" ? input.domain.trim().toLowerCase() : "";
  if (email && rawDomain) return { error: "give either email or domain, not both" };
  if (/[^\x21-\x7e]/.test(email + rawDomain)) return { error: "email or domain must be plain ASCII" };
  if (email) {
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return { error: "email must look like name@example.com" };
    return { email };
  }
  if (rawDomain) {
    const domain = rawDomain.startsWith("@") ? rawDomain : `@${rawDomain}`;
    if (!/^@[^@\s]+\.[^@\s]+$/.test(domain)) return { error: "domain must look like @example.com" };
    if (SHARED_MAIL_DOMAINS.has(domain)) return { error: `${domain} is a shared mail provider -- revoke by email instead` };
    return { domain };
  }
  return { error: "email or domain is required" };
}

/** Whether `ownerEmail` falls under `match` (already normalized -- see normalizeOwnerMatch). */
export function ownerMatches(ownerEmail: string, match: TokenOwnerMatch): boolean {
  const owner = ownerEmail.trim().toLowerCase();
  return "email" in match ? owner === match.email : owner.endsWith(match.domain);
}
