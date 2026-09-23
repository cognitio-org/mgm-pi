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

function isTabKey(key) {
  const lowered = key.toLowerCase();
  return lowered === "tabid" || lowered === "tab_id" || lowered === "tab";
}

// The page must not name a tab. A tab id anywhere in the payload is a reject, including a
// ping that grew one. Depth is capped so a hostile object cannot recurse forever.
function carriesTabId(value, depth) {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => carriesTabId(item, depth + 1));
  for (const key of Object.keys(value)) {
    if (isTabKey(key)) return true;
    if (carriesTabId(value[key], depth + 1)) return true;
  }
  return false;
}

/** Accepts exactly `{t:"ping"}`. Everything else is rejected, including the rest of the
 * page vocabulary (place, split, poll, openPanel) and any message that carries a tab id. */
export function parsePageMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, error: "rejected" };
  }
  if (Object.getPrototypeOf(message) !== Object.prototype) {
    return { ok: false, error: "rejected" };
  }
  if (carriesTabId(message, 0)) return { ok: false, error: "rejected" };
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
