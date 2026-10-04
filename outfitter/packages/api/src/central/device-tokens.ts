// Central sign-in, CA-1 (#390, docs/specs/central-auth.md §1.2): device-code flow token formats and
// the routes that need no credential. Owned by task A.
//
// Three opaque tokens, each `<prefix>` + 32 random bytes base64url, stored as sha256 hex only (like
// a Dongle, tokens.ts). Their prefixes differ from the Dongle's `outf_` and from each other, so a
// token pasted in the wrong place is refused by its shape before any lookup.

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
