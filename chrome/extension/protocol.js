// Page-to-extension messages for the Chrome companion.
// No Chrome APIs: the service worker and node:test both import this file.
//
// externally_connectable is not the whole check. The service worker drops a sender whose
// origin is not one of the three allowlisted sites. Pass sender.origin only. A URL
// (sender.url) is a different string and must not be passed here; a missing origin fails closed.

const ALLOWED = [
  { protocol: "https:", hostname: "app.kernal.one" },
  { protocol: "http:", hostname: "localhost" },
  { protocol: "http:", hostname: "127.0.0.1" },
];

/** True when `origin` is the canonical sender.origin of one of the three sites.
 * The manifest match patterns omit the port, so http://localhost:5173 is the same site as
 * http://localhost. A path, query, userinfo, or non-canonical spelling is not an origin. */
export function originAllowed(origin) {
  if (typeof origin !== "string" || origin === "") return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  return ALLOWED.some((allowed) => url.protocol === allowed.protocol && url.hostname === allowed.hostname);
}

/** Accepts exactly `{t:"ping"}`: a plain object with one own key `t` whose value is `"ping"`.
 * Everything else is rejected, including the rest of the page vocabulary. */
export function parsePageMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, error: "rejected" };
  }
  if (Object.getPrototypeOf(message) !== Object.prototype) {
    return { ok: false, error: "rejected" };
  }
  if (Object.keys(message).length === 1 && Object.hasOwn(message, "t") && message.t === "ping") {
    return { ok: true, t: "ping" };
  }
  return { ok: false, error: "rejected" };
}

/** Reply for a page message. A ping becomes `{ok:true, version, id}`. Anything else is a fixed
 * rejection that does not echo the payload. */
export function pageReply(message, version, id) {
  const parsed = parsePageMessage(message);
  if (!parsed.ok) return { ok: false, error: "rejected" };
  return { ok: true, version, id };
}

// outf_ + 32 random bytes, base64url, no padding. Same shape as packages/api generateToken.
const DONGLE = /^outf_[A-Za-z0-9_-]{43}$/;

/** True when `value` is outf_ followed by 43 base64url characters. */
export function isDongle(value) {
  return typeof value === "string" && DONGLE.test(value);
}

/** `url.origin` for an http(s) URL with no username or password; null otherwise. */
export function linkOrigin(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin;
}
