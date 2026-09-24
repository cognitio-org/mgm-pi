// Share record, jpeg cap, and the owner's panel-request notification skip.
// No Chrome APIs: the service worker and node:test both import this file.

/** Decoded jpeg cap. The API rejects a larger body with 413. */
export const JPEG_BYTE_CAP = 350000;

/**
 * Packed-extension floor for the alarms API, in minutes.
 * The alarms API reference (updated 2026-09-11) says Chrome limits alarms to at most
 * once every 30 seconds:
 * delayInMinutes or periodInMinutes below 0.5 is not honored and warns. Chrome 120
 * lowered that floor from 1 minute; the 30-second floor is still the one documented.
 * An unpacked extension is not clamped, but the share poll uses 0.5 so a packed
 * install and this checkout wake on the same period.
 */
export const ALARM_PERIOD_MINUTES = 0.5;

export const ALARM_NAME = "browser-share-poll";

export const NATIVE_HOST = "com.kernal.chrome";

export const SHARES_KEY = "shares";

/** Ids the side panel stored after it created a capture request. Those skip the notification. */
export const PANEL_REQUESTS_KEY = "panelCaptureRequestIds";

/** Last Floppy the panel shared with. The context menu uses it when several are open. */
export const LINKED_SESSION_KEY = "linkedSessionId";

/** `{sessionId, requestId, phase, requesterEmail, error}` for the panel. No image, no Dongle. */
export const CAPTURE_STATUS_KEY = "captureStatus";

export const FAILURES_KEY = "captureFailures";

export const NOTICES_KEY = "captureNotices";

export const SHARE_MENU_ID = "share-tab";

export const SHARE_MENU_TITLE = "Share this tab with the Floppy";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const MENU_PREFIX = "share-session:";

/** First step is the captureVisibleTab quality. Later steps recompress the same viewport. */
export const JPEG_LADDER = [
  { quality: 80, scale: 1 },
  { quality: 60, scale: 1 },
  { quality: 45, scale: 1 },
  { quality: 40, scale: 0.75 },
  { quality: 35, scale: 0.5 },
  { quality: 30, scale: 0.35 },
  { quality: 25, scale: 0.25 },
];

/** First try plus one automatic retry. A terminal error is then reported; other failures stay pending. */
export const MAX_CAPTURE_TRIES = 2;

/** Chrome outcomes the API turns into `browser.capture.result`. `upload_failed` is not one of them. */
export const CAPTURE_RESULT_ERRORS = ["permission_denied", "tab_gone", "too_large"];

export function isSessionId(value) {
  return typeof value === "string" && SESSION_ID.test(value);
}

/** `{tabId, sessionId, windowId}` or null. A page-supplied id never reaches this with a session from the page channel. */
export function shareRecord(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const { tabId, sessionId, windowId } = input;
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  if (!Number.isInteger(windowId)) return null;
  if (!isSessionId(sessionId)) return null;
  return { tabId, sessionId, windowId };
}

/** Drop malformed storage. The key is the session id, and it must match the record. */
export function readShareMap(stored) {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return {};
  const map = {};
  for (const [sessionId, rec] of Object.entries(stored)) {
    const parsed = shareRecord(rec);
    if (!parsed || parsed.sessionId !== sessionId) continue;
    map[sessionId] = parsed;
  }
  return map;
}

export function upsertShare(map, record) {
  return { ...map, [record.sessionId]: record };
}

export function removeSession(map, sessionId) {
  if (!Object.hasOwn(map, sessionId)) return { map, removed: null };
  const removed = map[sessionId];
  const next = { ...map };
  delete next[sessionId];
  return { map: next, removed };
}

export function removeTab(map, tabId) {
  const removed = [];
  const next = {};
  for (const [sessionId, rec] of Object.entries(map)) {
    if (rec.tabId === tabId) removed.push(rec);
    else next[sessionId] = rec;
  }
  return { map: next, removed };
}

export function tabStillShared(tabId, map) {
  return Object.values(map).some((rec) => rec.tabId === tabId);
}

export function recordedTabIds(map) {
  return Object.values(map).map((rec) => rec.tabId);
}

/** Page URL of a tab object. `pendingUrl` covers a tab that has not committed yet. */
export function tabPageUrl(tab) {
  if (tab === null || typeof tab !== "object") return "";
  if (typeof tab.url === "string" && tab.url !== "") return tab.url;
  if (typeof tab.pendingUrl === "string") return tab.pendingUrl;
  return "";
}

/** `https://host/*` for an http(s) tab, or null for chrome:, file:, and anything else. */
export function originPermission(url) {
  if (typeof url !== "string" || url === "") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return `${parsed.origin}/*`;
}

/**
 * Origins a share gesture must pass to permissions.request: the tab origin and the link origin.
 * The tab origin is for captureVisibleTab. The link origin is for extension-worker fetch.
 * The same origin is listed once. optional_host_permissions stays http and https wildcards,
 * not <all_urls>, so either pattern can be granted on its own.
 */
export function sharePermissionOrigins(tabUrl, apiOrigin) {
  const origins = [];
  const tabPattern = originPermission(tabUrl);
  const linkPattern = originPermission(typeof apiOrigin === "string" ? apiOrigin : "");
  if (tabPattern) origins.push(tabPattern);
  if (linkPattern && !origins.includes(linkPattern)) origins.push(linkPattern);
  return origins;
}

/** Link-origin denial blocks the share. Tab-origin denial does not. */
export function shareAllowedAfterPermission({ linkGranted, tabGranted }) {
  if (linkGranted !== true) return { ok: false, error: "link_permission_denied" };
  return { ok: true, permission: tabGranted === true ? "granted" : "denied" };
}

/**
 * The tab closed before tabs.onRemoved could see a share record.
 * Nothing has been PUT: do not PUT. PUT already happened: do not keep that server share.
 * A stored record is left for onRemoved.
 */
export function shareWhenTabGone({ tabGone, putDone, recordStored }) {
  if (tabGone !== true) return "proceed";
  if (recordStored === true) return "leave_for_on_removed";
  if (putDone === true) return "delete_server_share";
  return "skip";
}

/** Missing or discarded: do not activate it and do not capture some other tab. */
export function tabCaptureBlock(tab) {
  if (tab === null || typeof tab !== "object") return "tab_gone";
  if (tab.discarded === true) return "tab_gone";
  if (typeof tab.id !== "number") return "tab_gone";
  return null;
}

export function sharePath(sessionId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/browser/share`;
}

export function pendingPath(sessionId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/browser/requests?status=pending`;
}

export function revokeRequestPath(sessionId, requestId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/browser/requests/${encodeURIComponent(requestId)}/revoke`;
}

export function failRequestPath(sessionId, requestId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/browser/requests/${encodeURIComponent(requestId)}/fail`;
}

/** The error string to POST, or null when the request should stay pending. */
export function captureResultError(error) {
  return CAPTURE_RESULT_ERRORS.includes(error) ? error : null;
}

export function capturesPath(sessionId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/browser/captures`;
}

export function sessionPath(sessionId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}`;
}

/** Base64 payload, or null. Accepts a jpeg data URL. Whitespace is ignored. */
export function jpegPayload(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/^data:image\/jpeg;base64,/i, "").replace(/\s/g, "");
  if (cleaned.length === 0 || cleaned.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
  return cleaned;
}

/** Decoded byte length, or null when the payload is not base64. */
export function jpegDecodedLength(value) {
  const cleaned = jpegPayload(value);
  if (cleaned === null) return null;
  const pad = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  const length = (cleaned.length / 4) * 3 - pad;
  return length > 0 ? length : null;
}

export function jpegFitsCap(value) {
  const length = jpegDecodedLength(value);
  return length !== null && length <= JPEG_BYTE_CAP;
}

export function bytesToBase64(bytes) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * True only when this request id is one the owner's panel created.
 * A cloud request from the owner still notifies. Another email never skips.
 */
export function skipsNotification(requestId, panelRequestIds, requesterEmail, ownerEmail) {
  if (typeof requestId !== "string" || requestId.length === 0) return false;
  if (typeof requesterEmail !== "string" || requesterEmail === "") return false;
  if (typeof ownerEmail !== "string" || requesterEmail !== ownerEmail) return false;
  return Array.isArray(panelRequestIds) && panelRequestIds.includes(requestId);
}

export function rememberPanelRequest(ids, requestId) {
  const current = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id.length > 0) : [];
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return current;
  if (current.includes(requestId)) return current;
  return [...current, requestId].slice(-50);
}

export function captureNotice({ requesterEmail, floppyName, tabTitle }) {
  const who = typeof requesterEmail === "string" && requesterEmail !== "" ? requesterEmail : "Someone";
  const floppy = typeof floppyName === "string" && floppyName.trim() !== "" ? floppyName.trim() : "Floppy";
  const title = typeof tabTitle === "string" && tabTitle.trim() !== "" ? tabTitle.trim() : "shared tab";
  return {
    title: "Kernal",
    message: `${who} asked ${floppy} to see “${title}”.`,
    button: "Revoke",
  };
}

export function captureTryAllowed(priorFailures) {
  return Number.isInteger(priorFailures) && priorFailures >= 0 && priorFailures < MAX_CAPTURE_TRIES;
}

/** Revoke before the upload returns: do not upload. */
export function mayUploadCapture(aborted) {
  return aborted !== true;
}

export function recordFailure(map, requestId, count) {
  const base = map !== null && typeof map === "object" && !Array.isArray(map) ? map : {};
  const next = { ...base, [requestId]: count };
  const keys = Object.keys(next);
  if (keys.length <= 100) return next;
  const trimmed = {};
  for (const key of keys.slice(-100)) trimmed[key] = next[key];
  return trimmed;
}

export function nativeShareMessage({ tabId, title, url, sessionId }) {
  return { t: "share", tabId, title, url, sessionId };
}

export function nativeUnshareMessage(tabId) {
  return { t: "unshare", tabId };
}

/** Host → extension. Anything that is not `{t:"capture", tabId}` is ignored. */
export function parseHostCapture(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.t !== "capture" || !Number.isInteger(message.tabId)) return null;
  return { t: "capture", tabId: message.tabId };
}

/** Refuse a tab id this extension did not record. `null` means the capture may proceed. */
export function hostCaptureReply(tabId, recordedTabIds) {
  const recorded = Array.isArray(recordedTabIds) && recordedTabIds.some((id) => id === tabId);
  if (!Number.isInteger(tabId) || !recorded) return { t: "error", error: "not_shared" };
  return null;
}

export function hostCapturedMessage({ tabId, title, url, jpegBase64 }) {
  return { t: "captured", tabId, title, url, jpegBase64 };
}

export function hostError(error) {
  return { t: "error", error };
}

/** Panel → worker. Not a page-channel message. `panel-request` is an id the panel itself created. */
export function panelMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.t === "share-active" && isSessionId(message.sessionId)) {
    return { t: "share-active", sessionId: message.sessionId };
  }
  if (message.t === "revoke-share" && isSessionId(message.sessionId)) {
    return { t: "revoke-share", sessionId: message.sessionId };
  }
  if (message.t === "panel-request" && typeof message.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 128) {
    return { t: "panel-request", requestId: message.requestId };
  }
  return null;
}

/** Port name the session page opens: `floppy:<sessionId>`. */
export function sessionIdFromPortName(name) {
  if (typeof name !== "string" || !name.startsWith("floppy:")) return null;
  const id = name.slice("floppy:".length);
  return isSessionId(id) ? id : null;
}

export function menuItemSessionId(menuItemId) {
  if (typeof menuItemId !== "string" || !menuItemId.startsWith(MENU_PREFIX)) return null;
  const id = menuItemId.slice(MENU_PREFIX.length);
  return isSessionId(id) ? id : null;
}

export function menuItemIdForSession(sessionId) {
  if (!isSessionId(sessionId)) return null;
  return `${MENU_PREFIX}${sessionId}`;
}

export function floppyMenuLabel(name, sessionId) {
  const raw = typeof name === "string" && name.trim() !== "" ? name.trim() : sessionId;
  return [...raw].slice(0, 60).join("");
}

export function sessionSummaries(body) {
  if (!Array.isArray(body)) return [];
  const out = [];
  for (const row of body) {
    if (row === null || typeof row !== "object") continue;
    if (!isSessionId(row.id)) continue;
    if (row.status !== undefined && row.status !== "open") continue;
    out.push({ id: row.id, name: typeof row.name === "string" ? row.name : "" });
  }
  return out;
}

/**
 * Context-menu target. A child item names its Floppy. The parent item uses the linked
 * Floppy, or the only open one. Several open Floppies and no link: no guess.
 */
export function sessionForMenuClick({ menuItemId, linkedSessionId, sessions }) {
  const fromItem = menuItemSessionId(menuItemId);
  if (fromItem) return fromItem;
  if (menuItemId !== SHARE_MENU_ID) return null;
  const ids = sessionSummaries(sessions).map((row) => row.id);
  if (isSessionId(linkedSessionId) && ids.includes(linkedSessionId)) return linkedSessionId;
  if (ids.length === 1) return ids[0];
  if (ids.length === 0 && isSessionId(linkedSessionId)) return linkedSessionId;
  return null;
}

export function pendingRequests(body) {
  if (!Array.isArray(body)) return [];
  const out = [];
  for (const row of body) {
    if (row === null || typeof row !== "object") continue;
    if (typeof row.id !== "string" || row.id.length === 0 || row.id.length > 128) continue;
    if (row.status !== "pending") continue;
    if (row.kind === "click" || row.kind === "type") continue;
    out.push({
      id: row.id,
      requesterEmail: typeof row.requesterEmail === "string" ? row.requesterEmail : "",
    });
  }
  return out;
}

export function shareOwnerEmail(body) {
  if (body === null || typeof body !== "object") return null;
  return typeof body.ownerEmail === "string" && body.ownerEmail !== "" ? body.ownerEmail : null;
}

export function floppyNameOf(body) {
  if (body === null || typeof body !== "object") return "Floppy";
  if (typeof body.name !== "string" || body.name.trim() === "") return "Floppy";
  return body.name.trim();
}
