// Page-to-extension messages for the Chrome companion.
// No Chrome APIs: the service worker and node:test both import this file.
import { pageAsksForAction } from "./action.js";
import { pageAsksForDebugger } from "./inspect.js";
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

// Page vocabulary. Exact keys, not a walk over nested values: a title may say "tab", and a
// message is rejected for carrying `tabId` because that key is not in the set for its type.
const PAGE_KEYS = {
  ping: ["t"],
  poll: ["t"],
  openPanel: ["t"],
  place: ["t", "sessionId", "url", "title", "mode"],
  split: ["t", "sessionId", "otherSessionId"],
};

const PLACEMENT_MODES = new Set(["own", "shared", "window"]);

// Session ids are UUIDs (hyphens) or the unhyphenated ids the API already stores.
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function plainObject(message) {
  return message !== null && typeof message === "object" && !Array.isArray(message) && Object.getPrototypeOf(message) === Object.prototype;
}

function sameKeys(message, keys) {
  const own = Object.keys(message);
  if (own.length !== keys.length) return false;
  for (const key of keys) if (!Object.hasOwn(message, key)) return false;
  return true;
}

function isSessionId(value) {
  return typeof value === "string" && SESSION_ID.test(value);
}

/** True when `value` is the Floppy's own session URL on an allowlisted origin, with no userinfo,
 * query, or hash. The path is `/sessions/<sessionId>` and nothing else. */
export function isSessionUrl(sessionId, value) {
  if (!isSessionId(sessionId) || typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.search !== "" || url.hash !== "") return false;
  if (url.pathname !== `/sessions/${sessionId}`) return false;
  return originAllowed(url.origin);
}

function isTitle(value) {
  return typeof value === "string" && value.length <= 2000;
}

function reject() {
  return { ok: false, error: "rejected" };
}

/** Typed allowlist of page messages. Anything else is rejected, including `closeTab`, `capture`,
 * a click or keystrokes, a debugger attach, and any message that carries a `tabId` from the page.
 * Place and split do not include a tab id. The page cannot ask for an action or for DevTools. */
export function parsePageMessage(message) {
  if (!plainObject(message)) return reject();
  // Direct field check, not a recursive walk: only an own `tabId` is forbidden by name.
  if (Object.hasOwn(message, "tabId")) return reject();
  if (pageAsksForAction(message)) return reject();
  if (pageAsksForDebugger(message)) return reject();
  const type = message.t;
  const keys = PAGE_KEYS[type];
  if (!keys || !sameKeys(message, keys)) return reject();
  if (type === "ping" || type === "poll" || type === "openPanel") return { ok: true, t: type };
  if (type === "place") {
    if (!isSessionId(message.sessionId)) return reject();
    if (!isSessionUrl(message.sessionId, message.url)) return reject();
    if (!isTitle(message.title)) return reject();
    if (!PLACEMENT_MODES.has(message.mode)) return reject();
    return {
      ok: true,
      t: "place",
      sessionId: message.sessionId,
      href: message.url,
      title: message.title,
      mode: message.mode,
    };
  }
  if (!isSessionId(message.sessionId) || !isSessionId(message.otherSessionId)) return reject();
  if (message.sessionId === message.otherSessionId) return reject();
  return { ok: true, t: "split", sessionId: message.sessionId, otherSessionId: message.otherSessionId };
}

/** Synchronous ping reply: `{ok:true, version, id}`. A message the allowlist rejected is
 * `{ok:false, error:"rejected"}` and does not echo the payload. Other accepted messages are
 * acted on by the service worker; this helper returns null for them. */
export function pageReply(message, version, id) {
  const parsed = parsePageMessage(message);
  if (!parsed.ok) return { ok: false, error: "rejected" };
  if (parsed.t !== "ping") return null;
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
