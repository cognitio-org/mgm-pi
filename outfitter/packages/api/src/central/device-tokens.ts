// Central sign-in, CA-1 (#390, docs/specs/central-auth.md §1.2): device-code flow token formats and
// the routes that need no credential. Owned by task A.
//
// Three opaque tokens, each `<prefix>` + 32 random bytes base64url, stored as sha256 hex only (like
// a Dongle, tokens.ts). Their prefixes differ from the Dongle's `outf_` and from each other, so a
// token pasted in the wrong place is refused by its shape before any lookup.

import { randomBytes } from "node:crypto";

/** Kernal's access token: 1 hour, accepted on /api/* on link, web and all. */
export const ACCESS_TOKEN_PREFIX = "kda_";
/** Kernal's refresh token: rotated on every use; only POST /api/device/refresh and /revoke take it. */
export const REFRESH_TOKEN_PREFIX = "kdr_";
/** The device code Kernal polls with; only POST /api/device/token takes it. */
export const DEVICE_CODE_PREFIX = "kdc_";

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
/** Sliding: every rotation sets a new 30-day expiry. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
/** How long a replaced refresh token still works (§1.3). */
export const REFRESH_ROTATION_GRACE_MS = 60_000;
export const DEVICE_CODE_TTL_MS = 10 * 60_000;
export const DEVICE_POLL_INTERVAL_S = 5;
/** RFC 8628 §6.1's no-vowel alphabet: no words, no 0/O or 1/I confusion. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const USER_CODE_LENGTH = 8;

/** The /api/* routes server.ts's auth preHandler lets through with no identity: the device-code
 * flow's own endpoints, which carry their credential (a device code, a refresh token) in the body
 * and check it themselves. Registered on the link and all roles only. */
const PUBLIC_DEVICE_PATHS = new Set(["/api/device/code", "/api/device/token", "/api/device/refresh", "/api/device/revoke"]);

export function isPublicDevicePath(method: string, url: string): boolean {
  if (method !== "POST") return false;
  const path = url.split("?")[0] ?? "";
  return PUBLIC_DEVICE_PATHS.has(path);
}

/** An operator's CI token (§1.7): an access token with no refresh, as long as a Dongle. */
export const MACHINE_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;
/** RFC 8628 §3.2's grant type for POST /api/device/token. */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const randomToken = (prefix: string) => prefix + randomBytes(32).toString("base64url");

export const newAccessToken = (): string => randomToken(ACCESS_TOKEN_PREFIX);
export const newRefreshToken = (): string => randomToken(REFRESH_TOKEN_PREFIX);
export const newDeviceCode = (): string => randomToken(DEVICE_CODE_PREFIX);

/** sha256 hex, the only form stored: the same function as a Dongle's (tokens.ts). */
export { hashToken } from "../tokens.ts";

/** Uniform picks from `alphabet`: bytes at or above the largest multiple of its length are
 * redrawn, so no letter is likelier than another. */
function randomFrom(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** 8 letters from USER_CODE_ALPHABET, stored without the dash. */
export const newUserCode = (): string => randomFrom(USER_CODE_ALPHABET, USER_CODE_LENGTH);

/** `dev_` + 16 characters of base32 (a-z2-7), §1.1. */
export const newDeviceId = (): string => "dev_" + randomFrom("abcdefghijklmnopqrstuvwxyz234567", 16);

/** What a person typed (`bcdf-ghjk`, `BCDF GHJK`) as a stored user code: uppercased, everything
 * outside the alphabet dropped, then exactly 8 letters or undefined (§1.2). */
export function normalizeUserCode(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  let code = "";
  for (const ch of input.toUpperCase()) if (USER_CODE_ALPHABET.includes(ch)) code += ch;
  return code.length === USER_CODE_LENGTH ? code : undefined;
}

/** A stored user code as shown: `BCDF-GHJK`. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
