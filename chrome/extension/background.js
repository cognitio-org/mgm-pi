// Service worker. Page channel: ping, place, split, poll, and openPanel, and nothing else.
// sender.url is never read. A sender with no origin, or any other origin, is dropped.
// Only tabs this extension opened are moved. The page cannot name a tab id.
// poll wakes a capture poll for the port's Floppy. The page cannot create a share.

import { isDongle, linkOrigin, originAllowed, parsePageMessage, pageReply } from "./protocol.js";
import {
  LINK_KEY,
  NOTIFIED_UI_KEY,
  PAGE_ORIGIN_KEY,
  PANEL_SESSION_KEY,
  POLL_MS,
  apiPath,
  approvalNotificationId,
  approvalView,
  linkUrl,
  notificationCopy,
  sessionIdOk,
  shouldNotifyApproval,
} from "./panel-model.js";
import {
  adjacencyMove,
  groupColor,
  groupTitle,
  joinWindow,
  placeAction,
  splitAvailability,
  splitPlan,
  SHARED_GROUP_COLOR,
  SHARED_GROUP_TITLE,
} from "./placement.js";
import {
  ALARM_NAME,
  ALARM_PERIOD_MINUTES,
  CAPTURE_STATUS_KEY,
  FAILURES_KEY,
  JPEG_BYTE_CAP,
  JPEG_LADDER,
  LINKED_SESSION_KEY,
  NATIVE_HOST,
  NOTICES_KEY,
  PANEL_REQUESTS_KEY,
  SHARE_MENU_ID,
  SHARE_MENU_TITLE,
  SHARES_KEY,
  bytesToBase64,
  captureNotice,
  captureResultError,
  captureTryAllowed,
  capturesPath,
  floppyMenuLabel,
  failRequestPath,
  floppyNameOf,
  hostCaptureReply,
  hostCapturedMessage,
  hostError,
  jpegFitsCap,
  jpegPayload,
  mayUploadCapture,
  menuItemIdForSession,
  nativeShareMessage,
  nativeUnshareMessage,
  originPermission,
  panelMessage,
  parseHostCapture,
  pendingPath,
  pendingRequests,
  readShareMap,
  recordFailure,
  recordedTabIds,
  rememberPanelRequest,
  removeSession,
  removeTab,
  revokeRequestPath,
  sessionForMenuClick,
  sessionIdFromPortName,
  sessionPath,
  sessionSummaries,
  shareAllowedAfterPermission,
  shareOwnerEmail,
  sharePath,
  sharePermissionOrigins,
  shareRecord,
  shareWhenTabGone,
  skipsNotification,
  tabCaptureBlock,
  tabPageUrl,
  tabStillShared,
  upsertShare,
} from "./share.js";

const PLACEMENTS_KEY = "placements";

let tail = Promise.resolve();

function enqueue(fn) {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function post(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // The page closed the port. Do not log: the payload is not a secret, but the port is gone.
  }
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.sessionId === "string" &&
    typeof value.tabId === "number" &&
    typeof value.windowId === "number" &&
    typeof value.groupId === "number"
  );
}

async function readPlacements() {
  const stored = await chrome.storage.local.get(PLACEMENTS_KEY);
  const value = stored[PLACEMENTS_KEY];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const map = {};
  for (const [sessionId, rec] of Object.entries(value)) {
    if (isRecord(rec) && rec.sessionId === sessionId) map[sessionId] = rec;
  }
  return map;
}

async function writePlacements(map) {
  await chrome.storage.local.set({ [PLACEMENTS_KEY]: map });
}

async function remember(sessionId, tabId) {
  const tab = await chrome.tabs.get(tabId);
  const map = await readPlacements();
  map[sessionId] = {
    sessionId,
    tabId: tab.id,
    windowId: tab.windowId,
    groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
  };
  await writePlacements(map);
  return tab;
}

async function liveRecord(sessionId) {
  const map = await readPlacements();
  const rec = map[sessionId];
  if (!rec) return null;
  try {
    await chrome.tabs.get(rec.tabId);
    return rec;
  } catch {
    delete map[sessionId];
    await writePlacements(map);
    return null;
  }
}

async function dropTab(tabId) {
  const map = await readPlacements();
  let changed = false;
  for (const [sessionId, rec] of Object.entries(map)) {
    if (rec.tabId === tabId) {
      delete map[sessionId];
      changed = true;
    }
  }
  if (changed) await writePlacements(map);
}

async function syncOwnedTab(tabId, tab) {
  if (!tab || typeof tab.id !== "number") return;
  const map = await readPlacements();
  let changed = false;
  for (const rec of Object.values(map)) {
    if (rec.tabId !== tabId) continue;
    const windowId = typeof tab.windowId === "number" ? tab.windowId : rec.windowId;
    const groupId = typeof tab.groupId === "number" ? tab.groupId : rec.groupId;
    if (rec.windowId !== windowId || rec.groupId !== groupId) {
      rec.windowId = windowId;
      rec.groupId = groupId;
      changed = true;
    }
  }
  if (changed) await writePlacements(map);
}

async function currentWindowId() {
  const win = await chrome.windows.getCurrent();
  if (!win || typeof win.id !== "number") throw new Error("place_failed");
  return win.id;
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true });
}

async function uncollapse(groupId) {
  if (typeof groupId !== "number" || groupId < 0) return;
  try {
    await chrome.tabGroups.update(groupId, { collapsed: false });
  } catch {
    // The group went away between the group call and the update.
  }
}

async function ensureSharedGroup(windowId, tabIds) {
  const existing = await chrome.tabGroups.query({ windowId, title: SHARED_GROUP_TITLE });
  if (existing.length > 0) {
    const groupId = existing[0].id;
    await chrome.tabs.group({ groupId, tabIds });
    await uncollapse(groupId);
    return groupId;
  }
  const groupId = await chrome.tabs.group({ createProperties: { windowId }, tabIds });
  await chrome.tabGroups.update(groupId, { title: groupTitle("shared"), color: SHARED_GROUP_COLOR, collapsed: false });
  return groupId;
}

/** `tabs.group` and `createSplit` reject a tab that is not in the target window. */
async function joinRecordedTab(sessionId, tabId, mode, targetWindowId) {
  const tab = await chrome.tabs.get(tabId);
  const join = joinWindow(mode, tab, targetWindowId);
  if (!join.move) return tabId;
  await chrome.tabs.move(tabId, { windowId: join.windowId, index: -1 });
  await remember(sessionId, tabId);
  return tabId;
}

async function ensureSessionTab(sessionId, origin, windowId) {
  const record = await liveRecord(sessionId);
  if (record) return joinRecordedTab(sessionId, record.tabId, "split", windowId);
  if (!originAllowed(origin)) throw new Error("place_failed");
  const href = `${origin}/sessions/${sessionId}`;
  const join = joinWindow("split", null, windowId);
  const tab = await chrome.tabs.create({ url: href, active: false, windowId: join.windowId });
  if (!tab || typeof tab.id !== "number") throw new Error("place_failed");
  await remember(sessionId, tab.id);
  return tab.id;
}

async function makeAdjacent(idA, idB) {
  const tabA = await chrome.tabs.get(idA);
  const tabB = await chrome.tabs.get(idB);
  if (tabA.windowId !== tabB.windowId) throw new Error("split_failed");
  const move = adjacencyMove(tabA.index, tabB.index);
  if (!move) return;
  const tabId = move.tab === "a" ? idA : idB;
  await chrome.tabs.move(tabId, { index: move.index });
}

async function performPlace(parsed) {
  const record = await liveRecord(parsed.sessionId);
  const decision = placeAction(parsed.mode, record, record !== null);
  if (decision.action === "focus") {
    if (decision.moveToShared) {
      const windowId = await currentWindowId();
      await joinRecordedTab(parsed.sessionId, record.tabId, "shared", windowId);
      await ensureSharedGroup(windowId, [record.tabId]);
    }
    const tab = await remember(parsed.sessionId, record.tabId);
    await uncollapse(tab.groupId);
    await focusTab(tab);
    return { ok: true };
  }
  if (decision.mode === "window") {
    const created = await chrome.windows.create({ url: parsed.href, focused: true, type: "normal" });
    let tab = created && created.tabs && created.tabs[0];
    if ((!tab || typeof tab.id !== "number") && created && typeof created.id === "number") {
      const tabs = await chrome.tabs.query({ windowId: created.id });
      tab = tabs[0];
    }
    if (!created || typeof created.id !== "number" || !tab || typeof tab.id !== "number") throw new Error("place_failed");
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: created.id } });
    await chrome.tabGroups.update(groupId, {
      title: groupTitle("window", parsed.title),
      color: groupColor(parsed.sessionId),
      collapsed: false,
    });
    const stored = await remember(parsed.sessionId, tab.id);
    await focusTab(stored);
    return { ok: true };
  }
  const windowId = await currentWindowId();
  const tab = await chrome.tabs.create({ url: parsed.href, active: true, windowId });
  if (!tab || typeof tab.id !== "number") throw new Error("place_failed");
  if (decision.mode === "shared") {
    await ensureSharedGroup(windowId, [tab.id]);
  } else {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, {
      title: groupTitle("own", parsed.title),
      color: groupColor(parsed.sessionId),
      collapsed: false,
    });
  }
  const stored = await remember(parsed.sessionId, tab.id);
  await focusTab(stored);
  return { ok: true };
}

async function performSplit(parsed, origin) {
  // createSplit is required. When it is missing, do not open a tab and do not open a window.
  const plan = splitPlan(typeof chrome.tabs?.createSplit === "function");
  if (!plan.ok) return { ok: false, error: plan.error };
  const windowId = await currentWindowId();
  const idA = await ensureSessionTab(parsed.sessionId, origin, windowId);
  const idB = await ensureSessionTab(parsed.otherSessionId, origin, windowId);
  if (idA === idB) return { ok: false, error: "split_failed" };
  await ensureSharedGroup(windowId, [idA, idB]);
  await makeAdjacent(idA, idB);
  try {
    await chrome.tabs.createSplit([idA, idB]);
  } catch {
    // Leave the tabs in the Floppies group. The page surfaces split_failed; the panel is later.
    await remember(parsed.sessionId, idA);
    await remember(parsed.otherSessionId, idB);
    return { ok: false, error: "split_failed" };
  }
  await remember(parsed.sessionId, idA);
  await remember(parsed.otherSessionId, idB);
  return { ok: true };
}

async function performOpenPanel() {
  if (!chrome.sidePanel || typeof chrome.sidePanel.open !== "function") return { ok: true };
  try {
    const windowId = await currentWindowId();
    await chrome.sidePanel.open({ windowId });
  } catch {
    // No panel page yet, or no user gesture. Accepting the message is enough.
  }
  return { ok: true };
}

async function onPageMessage(port, origin, message) {
  const parsed = parsePageMessage(message);
  if (!parsed.ok) {
    post(port, { ok: false, error: "rejected" });
    return;
  }
  if (parsed.t === "ping") {
    const manifest = chrome.runtime.getManifest();
    post(port, pageReply(message, manifest.version, chrome.runtime.id));
    post(port, splitAvailability(typeof chrome.tabs?.createSplit === "function"));
    return;
  }
  if (parsed.t === "poll") {
    post(port, { ok: true });
    // The page port is named floppy:<sessionId>. A poll with no name checks every active share.
    wakeSharePoll(sessionIdFromPortName(port.name));
    return;
  }
  try {
    if (parsed.t === "openPanel") post(port, await performOpenPanel());
    else if (parsed.t === "place") post(port, await performPlace(parsed));
    else if (parsed.t === "split") post(port, await performSplit(parsed, origin));
  } catch {
    const error = parsed.t === "split" ? "split_failed" : "place_failed";
    post(port, { ok: false, error });
  }
}

chrome.runtime.onConnectExternal.addListener((port) => {
  if (!originAllowed(port.sender?.origin)) {
    port.disconnect();
    return;
  }
  const origin = port.sender.origin;
  port.onMessage.addListener((message) => {
    enqueue(() => onPageMessage(port, origin, message)).catch(() => {
      post(port, { ok: false, error: "rejected" });
    });
  });
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!originAllowed(sender?.origin)) return;
  const origin = sender.origin;
  enqueue(() => onPageMessage({ postMessage: sendResponse }, origin, message)).catch(() => {
    sendResponse({ ok: false, error: "rejected" });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(() => dropTab(tabId)).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  enqueue(() => syncOwnedTab(tabId, tab)).catch(() => {});
});

chrome.tabs.onAttached.addListener((tabId, info) => {
  if (typeof info.newWindowId !== "number") return;
  enqueue(async () => {
    const map = await readPlacements();
    let changed = false;
    for (const rec of Object.values(map)) {
      if (rec.tabId !== tabId || rec.windowId === info.newWindowId) continue;
      rec.windowId = info.newWindowId;
      changed = true;
    }
    if (changed) await writePlacements(map);
  }).catch(() => {});
});

// Share and capture. The page channel cannot create a share. The panel calls in-extension
// messages; the context menu is the other gesture. Listeners are appended so placement stays as it is.

const TOKEN_KEY = "OUTFITTER_TOKEN";
const ORIGIN_KEY = "OUTFITTER_API";

let cachedLinkOrigin = null;
let linkOriginKnown = false;
let linkOriginEpoch = 0;

function markLinkOrigin(value) {
  cachedLinkOrigin = typeof value === "string" ? linkOrigin(value) : null;
  linkOriginKnown = true;
}

// A save that lands while this read is in flight must not be overwritten by the stale result.
const linkOriginReady = chrome.storage.local.get(ORIGIN_KEY).then(
  (stored) => {
    if (linkOriginEpoch === 0) markLinkOrigin(stored[ORIGIN_KEY]);
  },
  () => {
    if (linkOriginEpoch === 0) linkOriginKnown = true;
  },
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.hasOwn(changes, ORIGIN_KEY)) return;
  linkOriginEpoch += 1;
  markLinkOrigin(changes[ORIGIN_KEY].newValue);
});

function requestOrigins(origins) {
  if (!Array.isArray(origins) || origins.length === 0) return Promise.resolve(false);
  return chrome.permissions.request({ origins }).then((granted) => granted === true).catch(() => false);
}

function requestLinkOriginNow() {
  if (linkOriginKnown) return requestOrigins(sharePermissionOrigins("", cachedLinkOrigin));
  return linkOriginReady.then(() => requestOrigins(sharePermissionOrigins("", cachedLinkOrigin)));
}

function requestTabOriginNow(tab) {
  return requestOrigins(sharePermissionOrigins(tab ? tabPageUrl(tab) : "", ""));
}

// Click turn. One prompt covers the tab origin and the cached link origin.
// The cache is filled at startup; until then the tab origin is still requested in this turn.
function beginSharePermission(tab) {
  const tabUrl = tab ? tabPageUrl(tab) : "";
  if (linkOriginKnown) return requestOrigins(sharePermissionOrigins(tabUrl, cachedLinkOrigin));
  const tabNow = requestTabOriginNow(tab);
  const linkLater = requestLinkOriginNow();
  return Promise.all([tabNow, linkLater]).then(() => false);
}

let shareTail = Promise.resolve();
const inflight = new Map();
const notified = new Set();
// Set in the click or tab-close turn, before the queued revoke runs, so a poll that is
// already awaiting does not upload after the user revoked.
const blockedSessions = new Set();
const closedTabs = new Set();
const noticeSessions = new Map();
let nativePort = null;

function enqueueShare(fn) {
  const run = shareTail.then(fn, fn);
  shareTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function wakeSharePoll(sessionId) {
  enqueueShare(() => pollShares(sessionId)).catch(() => {});
}

function abortSession(sessionId) {
  const job = inflight.get(sessionId);
  if (job) job.controller.abort();
}

function abortTab(tabId) {
  for (const job of inflight.values()) {
    if (job.tabId === tabId) job.controller.abort();
  }
}

function abortByRequest(requestId) {
  for (const job of inflight.values()) {
    if (job.requestId === requestId) job.controller.abort();
  }
}

function haltSession(sessionId) {
  blockedSessions.add(sessionId);
  abortSession(sessionId);
}

function captureHalted(sessionId, tabId, controller) {
  if (blockedSessions.has(sessionId) || closedTabs.has(tabId)) return true;
  return controller ? !mayUploadCapture(controller.signal.aborted) : false;
}

async function readShares() {
  const stored = await chrome.storage.local.get(SHARES_KEY);
  return readShareMap(stored[SHARES_KEY]);
}

async function writeShares(map) {
  await chrome.storage.local.set({ [SHARES_KEY]: map });
}

async function linkAuth() {
  const stored = await chrome.storage.local.get([TOKEN_KEY, ORIGIN_KEY]);
  const token = stored[TOKEN_KEY];
  const origin = typeof stored[ORIGIN_KEY] === "string" ? linkOrigin(stored[ORIGIN_KEY]) : null;
  if (!isDongle(token) || origin === null) return null;
  return { token, origin };
}

async function linkFetch(path, options = {}) {
  const auth = await linkAuth();
  if (!auth) return { ok: false, status: 0, error: "no_dongle", body: null };
  try {
    const response = await fetch(`${auth.origin}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { ok: response.ok, status: response.status, error: response.ok ? null : "share_failed", body };
  } catch {
    return { ok: false, status: 0, error: "share_failed", body: null };
  }
}

async function readPanelIds() {
  const stored = await chrome.storage.local.get(PANEL_REQUESTS_KEY);
  const value = stored[PANEL_REQUESTS_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === "string");
}

async function readFailureMap() {
  const stored = await chrome.storage.local.get(FAILURES_KEY);
  const value = stored[FAILURES_KEY];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

async function failureCount(requestId) {
  const map = await readFailureMap();
  const count = map[requestId];
  return Number.isInteger(count) && count > 0 ? count : 0;
}

async function setCaptureStatus(status) {
  const stored = { ...status, at: Date.now() };
  await chrome.storage.local.set({ [CAPTURE_STATUS_KEY]: stored });
  try {
    await chrome.runtime.sendMessage({ t: "capture-status", ...stored });
  } catch {
    // No panel is listening. captureStatus in storage is what it reads.
  }
}

async function ensureAlarm(map) {
  const shares = map ?? (await readShares());
  if (Object.keys(shares).length === 0) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  // 0.5 minutes is the packed-extension floor: 30 seconds. See ALARM_PERIOD_MINUTES.
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
}

function connectNativePort() {
  if (nativePort) return nativePort;
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    // The host is not installed. Cloud capture does not need it.
    return null;
  }
  nativePort = port;
  port.onMessage.addListener((message) => {
    enqueueShare(() => onNativeCapture(message)).catch(() => {});
  });
  port.onDisconnect.addListener(() => {
    nativePort = null;
  });
  return port;
}

function postNative(message) {
  const port = connectNativePort();
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    nativePort = null;
  }
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function liveTab(tabId) {
  if (closedTabs.has(tabId)) return null;
  const tab = await getTab(tabId);
  if (tab === null || closedTabs.has(tabId)) return null;
  return tab;
}

async function linkOriginAccess() {
  const auth = await linkAuth();
  if (!auth) return "no_dongle";
  const pattern = originPermission(auth.origin);
  if (!pattern) return "no_dongle";
  try {
    return (await chrome.permissions.contains({ origins: [pattern] })) ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

async function showCaptureNotice(sessionId, requestId, fields) {
  const notice = captureNotice(fields);
  const stored = await chrome.storage.local.get(NOTICES_KEY);
  const existing = stored[NOTICES_KEY];
  const notices = existing !== null && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  notices[requestId] = sessionId;
  await chrome.storage.local.set({ [NOTICES_KEY]: notices });
  noticeSessions.set(requestId, sessionId);
  notified.add(requestId);
  try {
    await chrome.notifications.create(requestId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: notice.title,
      message: notice.message,
      buttons: [{ title: notice.button }],
      requireInteraction: true,
      priority: 2,
    });
  } catch {
    // Revoke is still on the panel and on tab close. Do not skip the shot.
  }
}

async function clearNotice(requestId) {
  const stored = await chrome.storage.local.get(NOTICES_KEY);
  const existing = stored[NOTICES_KEY];
  if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
    const next = { ...existing };
    delete next[requestId];
    await chrome.storage.local.set({ [NOTICES_KEY]: next });
  }
  noticeSessions.delete(requestId);
  try {
    await chrome.notifications.clear(requestId);
  } catch {
    // Already gone.
  }
}

async function clearNoticesForSession(sessionId) {
  const stored = await chrome.storage.local.get(NOTICES_KEY);
  const existing = stored[NOTICES_KEY];
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) return;
  const next = {};
  for (const [requestId, id] of Object.entries(existing)) {
    if (id === sessionId) await clearNotice(requestId);
    else next[requestId] = id;
  }
  await chrome.storage.local.set({ [NOTICES_KEY]: next });
}

async function revokeInflight(sessionId, requestId) {
  await linkFetch(revokeRequestPath(sessionId, requestId), { method: "POST" });
  await clearNotice(requestId);
}

async function jpegUnderCap(dataUrl) {
  if (jpegFitsCap(dataUrl)) return jpegPayload(dataUrl);
  let bitmap;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    for (let i = 1; i < JPEG_LADDER.length; i++) {
      const step = JPEG_LADDER[i];
      const width = Math.max(1, Math.round(bitmap.width * step.scale));
      const height = Math.max(1, Math.round(bitmap.height * step.scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) continue;
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: step.quality / 100 });
      if (blob.size > 0 && blob.size <= JPEG_BYTE_CAP) return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    }
  } catch {
    return null;
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
  return null;
}

async function prepareTab(tabId) {
  const tab = await getTab(tabId);
  if (tabCaptureBlock(tab)) return { ok: false, error: "tab_gone" };
  const url = tabPageUrl(tab);
  const pattern = originPermission(url);
  if (!pattern) return { ok: false, error: "permission_denied" };
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    granted = false;
  }
  if (!granted) return { ok: false, error: "permission_denied" };
  return {
    ok: true,
    tabId,
    windowId: tab.windowId,
    title: typeof tab.title === "string" ? tab.title : "",
    href: url,
  };
}

async function shootPrepared(prepared) {
  let previousId = null;
  let windowId = prepared.windowId;
  try {
    const current = await getTab(prepared.tabId);
    if (tabCaptureBlock(current) || current.id !== prepared.tabId) return { ok: false, error: "tab_gone" };
    if (typeof current.windowId === "number") windowId = current.windowId;
    const [previous] = await chrome.tabs.query({ active: true, windowId });
    if (previous && previous.id !== prepared.tabId) previousId = previous.id;
    await chrome.tabs.update(prepared.tabId, { active: true });
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (!active || active.id !== prepared.tabId) return { ok: false, error: "tab_gone" };
    const live = await getTab(prepared.tabId);
    if (tabCaptureBlock(live) || live.id !== prepared.tabId) return { ok: false, error: "tab_gone" };
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: JPEG_LADDER[0].quality,
    });
    const jpegBase64 = await jpegUnderCap(dataUrl);
    if (!jpegBase64) return { ok: false, error: "too_large" };
    return {
      ok: true,
      title: typeof live.title === "string" && live.title !== "" ? live.title : prepared.title,
      href: tabPageUrl(live) || prepared.href,
      jpegBase64,
    };
  } catch {
    const still = await getTab(prepared.tabId);
    if (tabCaptureBlock(still)) return { ok: false, error: "tab_gone" };
    return { ok: false, error: "permission_denied" };
  } finally {
    if (previousId !== null) {
      try {
        await chrome.tabs.update(previousId, { active: true });
      } catch {
        // The previously active tab closed during the shot.
      }
    }
  }
}

async function captureForTab(tabId) {
  const prepared = await prepareTab(tabId);
  if (!prepared.ok) return prepared;
  return shootPrepared(prepared);
}

async function shootAndUpload(share, request, ctx) {
  const controller = new AbortController();
  inflight.set(share.sessionId, { requestId: request.id, tabId: share.tabId, controller });
  try {
    const prepared = await prepareTab(share.tabId);
    if (captureHalted(share.sessionId, share.tabId, controller)) {
      await revokeInflight(share.sessionId, request.id);
      return "revoked";
    }
    if (!prepared.ok) return prepared.error;
    const panelIds = await readPanelIds();
    if (!notified.has(request.id) && !skipsNotification(request.id, panelIds, request.requesterEmail, ctx.ownerEmail)) {
      await showCaptureNotice(share.sessionId, request.id, {
        requesterEmail: request.requesterEmail,
        floppyName: ctx.floppyName,
        tabTitle: prepared.title,
      });
    }
    await setCaptureStatus({
      sessionId: share.sessionId,
      requestId: request.id,
      phase: "capturing",
      requesterEmail: request.requesterEmail,
      error: null,
    });
    if (captureHalted(share.sessionId, share.tabId, controller)) {
      await revokeInflight(share.sessionId, request.id);
      return "revoked";
    }
    const shot = await shootPrepared(prepared);
    if (captureHalted(share.sessionId, share.tabId, controller)) {
      await revokeInflight(share.sessionId, request.id);
      return "revoked";
    }
    if (!shot.ok) return shot.error;
    const uploaded = await linkFetch(capturesPath(share.sessionId), {
      method: "POST",
      body: {
        requestId: request.id,
        title: shot.title,
        url: shot.href,
        jpegBase64: shot.jpegBase64,
      },
      signal: controller.signal,
    });
    if (captureHalted(share.sessionId, share.tabId, controller)) {
      await revokeInflight(share.sessionId, request.id);
      return "revoked";
    }
    if (!uploaded.ok) return "upload_failed";
    await setCaptureStatus({
      sessionId: share.sessionId,
      requestId: request.id,
      phase: "done",
      requesterEmail: request.requesterEmail,
      error: null,
    });
    notified.delete(request.id);
    await clearNotice(request.id);
    return "uploaded";
  } catch {
    if (captureHalted(share.sessionId, share.tabId, controller)) {
      await revokeInflight(share.sessionId, request.id);
      return "revoked";
    }
    return "upload_failed";
  } finally {
    const current = inflight.get(share.sessionId);
    if (current && current.controller === controller) inflight.delete(share.sessionId);
  }
}

async function reportCaptureFailure(sessionId, requestId, error) {
  const reported = captureResultError(error);
  if (!reported) return;
  await linkFetch(failRequestPath(sessionId, requestId), {
    method: "POST",
    body: { error: reported },
  });
}

async function storedTerminalError(requestId) {
  const stored = await chrome.storage.local.get(CAPTURE_STATUS_KEY);
  const status = stored[CAPTURE_STATUS_KEY];
  if (!status || status.requestId !== requestId) return null;
  return status.error;
}

async function fulfillRequest(share, request, ctx) {
  if (inflight.has(share.sessionId)) return;
  const prior = await failureCount(request.id);
  if (!captureTryAllowed(prior)) {
    // The previous poll already gave up. Report again if that POST never landed.
    await reportCaptureFailure(share.sessionId, request.id, await storedTerminalError(request.id));
    return;
  }
  const outcome = await shootAndUpload(share, request, ctx);
  if (outcome === "uploaded" || outcome === "revoked") {
    if (outcome === "uploaded") {
      const cleared = { ...(await readFailureMap()) };
      delete cleared[request.id];
      await chrome.storage.local.set({ [FAILURES_KEY]: cleared });
    }
    return;
  }
  const failures = prior + 1;
  await chrome.storage.local.set({ [FAILURES_KEY]: recordFailure(await readFailureMap(), request.id, failures) });
  if (!captureTryAllowed(failures) || inflight.has(share.sessionId)) {
    await setCaptureStatus({
      sessionId: share.sessionId,
      requestId: request.id,
      phase: "error",
      requesterEmail: request.requesterEmail,
      error: outcome,
    });
    await reportCaptureFailure(share.sessionId, request.id, outcome);
    return;
  }
  const again = await shootAndUpload(share, request, ctx);
  if (again === "uploaded" || again === "revoked") {
    if (again === "uploaded") {
      const cleared = { ...(await readFailureMap()) };
      delete cleared[request.id];
      await chrome.storage.local.set({ [FAILURES_KEY]: cleared });
    }
    return;
  }
  await chrome.storage.local.set({
    [FAILURES_KEY]: recordFailure(await readFailureMap(), request.id, failures + 1),
  });
  await setCaptureStatus({
    sessionId: share.sessionId,
    requestId: request.id,
    phase: "error",
    requesterEmail: request.requesterEmail,
    error: again,
  });
  await reportCaptureFailure(share.sessionId, request.id, again);
}

async function pollOne(share) {
  const listed = await linkFetch(pendingPath(share.sessionId));
  if (!listed.ok) return;
  const requests = pendingRequests(listed.body);
  if (requests.length === 0) return;
  const [shareRes, sessionRes] = await Promise.all([
    linkFetch(sharePath(share.sessionId)),
    linkFetch(sessionPath(share.sessionId)),
  ]);
  const ctx = {
    ownerEmail: shareRes.ok ? shareOwnerEmail(shareRes.body) : null,
    floppyName: sessionRes.ok ? floppyNameOf(sessionRes.body) : "Floppy",
  };
  for (const request of requests) {
    if (inflight.has(share.sessionId)) return;
    await fulfillRequest(share, request, ctx);
  }
}

async function pollShares(onlySessionId) {
  const map = await readShares();
  const ids = onlySessionId ? (map[onlySessionId] ? [onlySessionId] : []) : Object.keys(map);
  for (const sessionId of ids) {
    if (inflight.has(sessionId)) continue;
    await pollOne(map[sessionId]);
  }
}

async function dropUnrecordedServerShare(sessionId, previous, tabId) {
  await linkFetch(sharePath(sessionId), { method: "DELETE" });
  // DELETE clears the session. Put back a different tab that already has a local record.
  if (!previous || previous.tabId === tabId) return;
  const prev = await liveTab(previous.tabId);
  if (!prev) return;
  await linkFetch(sharePath(sessionId), {
    method: "PUT",
    body: {
      tabTitle: typeof prev.title === "string" ? prev.title : "",
      tabUrl: tabPageUrl(prev),
    },
  });
}

async function commitShare(sessionId, tab) {
  const tabId = tab && Number.isInteger(tab.id) ? tab.id : null;
  if (tabId === null) return { ok: false, error: "tab_gone" };
  const access = await linkOriginAccess();
  if (access === "no_dongle") return { ok: false, error: "no_dongle" };
  const gate = shareAllowedAfterPermission({ linkGranted: access === "granted", tabGranted: false });
  if (!gate.ok) return gate;

  const map = await readShares();
  const previous = map[sessionId] ?? null;
  const live = await liveTab(tabId);
  if (shareWhenTabGone({ tabGone: live === null, putDone: false, recordStored: false }) === "skip") {
    return { ok: false, error: "tab_gone" };
  }
  const record = shareRecord({
    tabId: live.id,
    sessionId,
    windowId: typeof live.windowId === "number" ? live.windowId : NaN,
  });
  if (!record) return { ok: false, error: "share_failed" };
  const title = typeof live.title === "string" ? live.title : "";
  const url = tabPageUrl(live);
  const put = await linkFetch(sharePath(sessionId), { method: "PUT", body: { tabTitle: title, tabUrl: url } });
  if (!put.ok) {
    if (put.error === "no_dongle") return { ok: false, error: "no_dongle" };
    if (put.status === 409) return { ok: false, error: "share_conflict" };
    return { ok: false, error: "share_failed" };
  }
  const afterPut = await liveTab(tabId);
  if (shareWhenTabGone({ tabGone: afterPut === null, putDone: true, recordStored: false }) === "delete_server_share") {
    await dropUnrecordedServerShare(sessionId, previous, tabId);
    return { ok: false, error: "tab_gone" };
  }
  const next = upsertShare(map, record);
  try {
    await writeShares(next);
  } catch {
    await dropUnrecordedServerShare(sessionId, previous, tabId);
    return { ok: false, error: "share_failed" };
  }
  if (shareWhenTabGone({ tabGone: (await liveTab(tabId)) === null, putDone: true, recordStored: true }) === "leave_for_on_removed") {
    return { ok: false, error: "tab_gone" };
  }
  await chrome.storage.local.set({ [LINKED_SESSION_KEY]: sessionId });
  if (previous && previous.tabId !== record.tabId && !tabStillShared(previous.tabId, next)) {
    postNative(nativeUnshareMessage(previous.tabId));
  }
  postNative(nativeShareMessage({ tabId: record.tabId, title, url, sessionId }));
  await ensureAlarm(next);
  const tabPattern = originPermission(url);
  let tabGranted = false;
  if (tabPattern) {
    try {
      tabGranted = await chrome.permissions.contains({ origins: [tabPattern] });
    } catch {
      tabGranted = false;
    }
  }
  return shareAllowedAfterPermission({ linkGranted: true, tabGranted });
}

async function revokeSessionNow(sessionId) {
  const map = await readShares();
  const job = inflight.get(sessionId);
  if (job) await revokeInflight(sessionId, job.requestId);
  await linkFetch(sharePath(sessionId), { method: "DELETE" });
  const { map: next, removed } = removeSession(map, sessionId);
  await writeShares(next);
  if (removed && !tabStillShared(removed.tabId, next)) postNative(nativeUnshareMessage(removed.tabId));
  await ensureAlarm(next);
  await clearNoticesForSession(sessionId);
  blockedSessions.delete(sessionId);
}

function revokeShare(sessionId) {
  haltSession(sessionId);
  return enqueueShare(() => revokeSessionNow(sessionId));
}

async function revokeClosedTab(tabId) {
  let removed = [];
  try {
    const map = await readShares();
    const result = removeTab(map, tabId);
    removed = result.removed;
    if (removed.length === 0) return;
    for (const rec of removed) {
      const job = inflight.get(rec.sessionId);
      if (job && job.tabId === tabId) await revokeInflight(rec.sessionId, job.requestId);
      await linkFetch(sharePath(rec.sessionId), { method: "DELETE" });
      await clearNoticesForSession(rec.sessionId);
    }
    await writeShares(result.map);
    if (!tabStillShared(tabId, result.map)) postNative(nativeUnshareMessage(tabId));
    await ensureAlarm(result.map);
  } finally {
    closedTabs.delete(tabId);
    for (const rec of removed) blockedSessions.delete(rec.sessionId);
  }
}

async function moveShareWindow(tabId, windowId) {
  const map = await readShares();
  let changed = false;
  const next = {};
  for (const [sessionId, rec] of Object.entries(map)) {
    if (rec.tabId !== tabId || rec.windowId === windowId) {
      next[sessionId] = rec;
      continue;
    }
    const updated = shareRecord({ tabId: rec.tabId, sessionId: rec.sessionId, windowId });
    if (!updated) {
      next[sessionId] = rec;
      continue;
    }
    next[sessionId] = updated;
    changed = true;
  }
  if (changed) await writeShares(next);
}

async function resolveMenuSession(menuItemId) {
  const stored = await chrome.storage.local.get(LINKED_SESSION_KEY);
  const listed = await linkFetch("/api/sessions");
  return sessionForMenuClick({
    menuItemId,
    linkedSessionId: stored[LINKED_SESSION_KEY],
    sessions: listed.ok ? listed.body : [],
  });
}

async function showNeedFloppy() {
  try {
    await chrome.notifications.create("need-floppy", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: "Kernal",
      message: "Open the Kernal panel and pick a Floppy to share with.",
    });
  } catch {
    // The menu click did not start a share.
  }
}

async function showLinkPermissionDenied() {
  try {
    await chrome.notifications.create("link-permission", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: "Kernal",
      message: "Chrome did not allow the link origin. The share was not saved.",
    });
  } catch {
    // The click still did not store a share.
  }
}

async function installMenu() {
  await chrome.contextMenus.removeAll();
  await chrome.contextMenus.create({
    id: SHARE_MENU_ID,
    title: SHARE_MENU_TITLE,
    contexts: ["page"],
  });
}

async function refreshMenu() {
  await installMenu();
  const listed = await linkFetch("/api/sessions");
  const sessions = listed.ok ? sessionSummaries(listed.body) : [];
  if (sessions.length <= 1) return;
  for (const session of sessions) {
    const id = menuItemIdForSession(session.id);
    if (!id) continue;
    try {
      await chrome.contextMenus.create({
        id,
        parentId: SHARE_MENU_ID,
        title: floppyMenuLabel(session.name, session.id),
        contexts: ["page"],
      });
    } catch {
      // A refresh overlapped. The item already names this Floppy.
    }
  }
}

async function onNativeCapture(message) {
  const parsed = parseHostCapture(message);
  if (!parsed) return;
  const map = await readShares();
  const refused = hostCaptureReply(parsed.tabId, recordedTabIds(map));
  if (refused) {
    postNative(refused);
    return;
  }
  const shot = await captureForTab(parsed.tabId);
  if (!shot.ok) {
    postNative(hostError(shot.error));
    return;
  }
  postNative(hostCapturedMessage({
    tabId: parsed.tabId,
    title: shot.title,
    url: shot.href,
    jpegBase64: shot.jpegBase64,
  }));
}

async function announceShares() {
  const map = await readShares();
  for (const rec of Object.values(map)) {
    const tab = await getTab(rec.tabId);
    postNative(nativeShareMessage({
      tabId: rec.tabId,
      title: tab && typeof tab.title === "string" ? tab.title : "",
      url: tab ? tabPageUrl(tab) : "",
      sessionId: rec.sessionId,
    }));
  }
}

async function rememberRequest(requestId) {
  const ids = await readPanelIds();
  await chrome.storage.local.set({ [PANEL_REQUESTS_KEY]: rememberPanelRequest(ids, requestId) });
}

async function bootShare() {
  await refreshMenu();
  const map = await readShares();
  if (Object.keys(map).length === 0) return;
  await ensureAlarm(map);
  await announceShares();
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Click turn: request the tab origin and the link origin while this gesture counts.
  const grant = beginSharePermission(tab);
  enqueueShare(async () => {
    await grant;
    const sessionId = await resolveMenuSession(info.menuItemId);
    if (!sessionId) {
      if ((await linkOriginAccess()) === "denied") await showLinkPermissionDenied();
      else await showNeedFloppy();
      return;
    }
    if (!tab || typeof tab.id !== "number") return;
    const result = await commitShare(sessionId, tab);
    if (result && result.error === "link_permission_denied") await showLinkPermissionDenied();
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender?.id !== chrome.runtime.id) return;
  const parsed = panelMessage(message);
  if (!parsed) return;
  if (parsed.t === "panel-request") {
    rememberRequest(parsed.requestId)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, error: "share_failed" }));
    return true;
  }
  if (parsed.t === "revoke-share") {
    revokeShare(parsed.sessionId)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, error: "share_failed" }));
    return true;
  }
  // This message is the panel click. Request the link origin before tabs.query yields.
  const linkGrant = requestLinkOriginNow();
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const active = Array.isArray(tabs) ? tabs[0] : undefined;
    if (!active || typeof active.id !== "number") {
      sendResponse({ ok: false, error: "tab_gone" });
      return;
    }
    const tabGrant = requestTabOriginNow(active);
    enqueueShare(async () => {
      await linkGrant;
      await tabGrant;
      const result = await commitShare(parsed.sessionId, active);
      if (result && result.error === "link_permission_denied") await showLinkPermissionDenied();
      return result;
    })
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false, error: "share_failed" }));
  });
  return true;
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex !== 0 || notificationId === "need-floppy") return;
  const sessionId = noticeSessions.get(notificationId);
  if (typeof sessionId === "string") haltSession(sessionId);
  else abortByRequest(notificationId);
  enqueueShare(async () => {
    const stored = await chrome.storage.local.get(NOTICES_KEY);
    const notices = stored[NOTICES_KEY];
    const sessionId = notices && typeof notices === "object" ? notices[notificationId] : undefined;
    if (typeof sessionId !== "string") return;
    await revokeSessionNow(sessionId);
  }).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  wakeSharePoll(null);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  closedTabs.add(tabId);
  abortTab(tabId);
  enqueueShare(() => revokeClosedTab(tabId)).catch(() => {});
});

chrome.tabs.onAttached.addListener((tabId, info) => {
  if (typeof info.newWindowId !== "number") return;
  enqueueShare(() => moveShareWindow(tabId, info.newWindowId)).catch(() => {});
});

enqueueShare(() => bootShare()).catch(() => {});
// Side panel. The toolbar icon opens it. Approval notices while it is closed are not alarms:
// the share slice owns chrome.alarms. This block runs on panel close, startup, and tab
// activity, and it remembers the request id so a later wake does not notify twice.

if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function") {
  const pending = chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  if (pending && typeof pending.catch === "function") pending.catch(() => {});
}

chrome.runtime.onConnectExternal.addListener((port) => {
  const paired = port.sender?.origin;
  if (!originAllowed(paired)) return;
  chrome.storage.local.set({ [PAGE_ORIGIN_KEY]: paired }).catch(() => {});
});

async function sidePanelOpen() {
  if (!chrome.runtime.getContexts) return false;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
    return Array.isArray(contexts) && contexts.length > 0;
  } catch {
    return false;
  }
}

async function checkClosedPanelApproval() {
  if (await sidePanelOpen()) return;
  const stored = await chrome.storage.local.get([PANEL_SESSION_KEY, NOTIFIED_UI_KEY, TOKEN_KEY, LINK_KEY]);
  const sessionId = stored[PANEL_SESSION_KEY];
  const token = stored[TOKEN_KEY];
  const origin = stored[LINK_KEY];
  if (!isDongle(token) || linkOrigin(origin) === null) return;
  const href = linkUrl(origin, apiPath("session", sessionId));
  if (!href) return;
  const body = await readPending(href, token);
  const view = approvalView(body && body.pendingUiRequest);
  if (!view || !shouldNotifyApproval(false, view.id, stored[NOTIFIED_UI_KEY])) return;
  if (await sidePanelOpen()) return;
  const id = approvalNotificationId(view.id);
  if (!id || !chrome.notifications) return;
  const copy = notificationCopy(body.name, view.title);
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon.png"),
    title: copy.title,
    message: copy.message,
  });
  await chrome.storage.local.set({ [NOTIFIED_UI_KEY]: view.id });
}

async function readPending(href, token) {
  const res = await fetch(href, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  if (!res.ok) return null;
  const body = await res.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body;
}

let approvalRunning = false;
let approvalLast = 0;
let approvalTimer = null;

function wakeApprovalCheck(force) {
  if (!force) {
    const wait = POLL_MS - (Date.now() - approvalLast);
    if (wait > 0) {
      if (approvalTimer !== null) return;
      approvalTimer = setTimeout(() => {
        approvalTimer = null;
        wakeApprovalCheck(true);
      }, wait);
      return;
    }
  }
  if (approvalTimer !== null) {
    clearTimeout(approvalTimer);
    approvalTimer = null;
  }
  approvalLast = Date.now();
  if (approvalRunning) return;
  approvalRunning = true;
  checkClosedPanelApproval()
    .catch(() => {})
    .finally(() => {
      approvalRunning = false;
    });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "kernal-panel") return;
  port.onDisconnect.addListener(() => wakeApprovalCheck(true));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.t !== "remember-placement") return;
  const sessionId = message.sessionId;
  const tabId = message.tabId;
  if (!sessionIdOk(sessionId) || typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) {
    sendResponse({ ok: false });
    return true;
  }
  enqueue(() => remember(sessionId, tabId))
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});

if (chrome.notifications && typeof chrome.notifications.onClicked?.addListener === "function") {
  chrome.notifications.onClicked.addListener((id) => {
    if (typeof id !== "string" || !id.startsWith("approval:")) return;
    chrome.windows.getLastFocused({ windowTypes: ["normal"] }).then((win) => {
      if (!win || typeof win.id !== "number" || !chrome.sidePanel) return;
      chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
    }).catch(() => {});
  });
}

chrome.tabs.onActivated.addListener(() => wakeApprovalCheck(false));
chrome.tabs.onUpdated.addListener(() => wakeApprovalCheck(false));
chrome.runtime.onStartup.addListener(() => wakeApprovalCheck(true));
chrome.runtime.onInstalled.addListener(() => wakeApprovalCheck(true));

chrome.runtime.onMessageExternal.addListener((_message, sender) => {
  if (!originAllowed(sender?.origin)) return;
  wakeApprovalCheck(false);
});

wakeApprovalCheck(true);
