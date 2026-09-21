// Personal API tokens (E4.1b): plaintext format, hashing and display-prefix helpers. See
// store/types.ts's ApiToken doc comment and auth.ts's identityFromApiToken for how a token is
// verified. The plaintext is generated once at creation time and never stored or logged -- only
// its sha256 hash and an 8-char display prefix persist.

import { randomBytes, createHash } from "node:crypto";

export const TOKEN_PREFIX = "outf_";

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
