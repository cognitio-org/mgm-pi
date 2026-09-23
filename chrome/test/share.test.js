import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALARM_PERIOD_MINUTES,
  JPEG_BYTE_CAP,
  JPEG_LADDER,
  MAX_CAPTURE_TRIES,
  SHARE_MENU_ID,
  SHARE_MENU_TITLE,
  bytesToBase64,
  captureNotice,
  captureTryAllowed,
  capturesPath,
  floppyMenuLabel,
  floppyNameOf,
  hostCaptureReply,
  hostCapturedMessage,
  jpegDecodedLength,
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
  rememberPanelRequest,
  removeSession,
  removeTab,
  revokeRequestPath,
  sessionForMenuClick,
  sessionIdFromPortName,
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
} from "../extension/share.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const session = "550e8400-e29b-41d4-a716-446655440000";
const other = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

test("share.js does not call Chrome", () => {
  const source = read("../extension/share.js");
  assert.doesNotMatch(source, /\bchrome\./);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test("a share record is tabId, sessionId, and windowId", () => {
  assert.deepEqual(shareRecord({ tabId: 4, sessionId: session, windowId: 2, title: "no" }), {
    tabId: 4,
    sessionId: session,
    windowId: 2,
  });
  assert.equal(shareRecord({ tabId: 4, sessionId: session }), null);
  assert.equal(shareRecord({ tabId: -1, sessionId: session, windowId: 1 }), null);
  assert.equal(shareRecord({ tabId: 1.5, sessionId: session, windowId: 1 }), null);
  assert.equal(shareRecord({ tabId: 1, sessionId: "../x", windowId: 1 }), null);
  assert.equal(shareRecord(null), null);
});

test("storage drops a record whose session id does not match the key", () => {
  const map = readShareMap({
    [session]: { tabId: 4, sessionId: session, windowId: 2 },
    [other]: { tabId: 9, sessionId: session, windowId: 2 },
    bad: { tabId: "4", sessionId: "bad", windowId: 1 },
  });
  assert.deepEqual(map, { [session]: { tabId: 4, sessionId: session, windowId: 2 } });
  const next = upsertShare(map, { tabId: 8, sessionId: session, windowId: 3 });
  assert.equal(next[session].tabId, 8);
  assert.equal(map[session].tabId, 4);
  const removed = removeSession(next, session);
  assert.equal(removed.removed.tabId, 8);
  assert.deepEqual(removed.map, {});
  const byTab = removeTab(
    {
      [session]: { tabId: 4, sessionId: session, windowId: 1 },
      [other]: { tabId: 4, sessionId: other, windowId: 1 },
    },
    4,
  );
  assert.equal(byTab.removed.length, 2);
  assert.equal(tabStillShared(4, byTab.map), false);
});

test("jpeg byte cap is 350000", () => {
  assert.equal(JPEG_BYTE_CAP, 350000);
  const atCap = bytesToBase64(new Uint8Array(JPEG_BYTE_CAP));
  const over = bytesToBase64(new Uint8Array(JPEG_BYTE_CAP + 1));
  assert.equal(jpegDecodedLength(atCap), JPEG_BYTE_CAP);
  assert.equal(jpegFitsCap(atCap), true);
  assert.equal(jpegFitsCap(over), false);
  assert.equal(jpegFitsCap(`data:image/jpeg;base64,${atCap}`), true);
  assert.equal(jpegPayload("data:image/jpeg;base64,aaaa"), "aaaa");
  assert.equal(jpegFitsCap(""), false);
  assert.equal(jpegFitsCap("@@@"), false);
  assert.equal(jpegDecodedLength(bytesToBase64(new Uint8Array([1]))), 1);
  assert.equal(jpegDecodedLength(bytesToBase64(new Uint8Array([1, 2]))), 2);
  for (const step of JPEG_LADDER) {
    assert.equal(step.quality >= 1 && step.quality <= 100, true);
    assert.equal(step.scale > 0 && step.scale <= 1, true);
  }
});

test("the owner's panel request skips the notification, and nothing else does", () => {
  const id = "req-1";
  assert.equal(skipsNotification(id, [id], "owner@kernal.one", "owner@kernal.one"), true);
  assert.equal(skipsNotification(id, [id], "other@kernal.one", "owner@kernal.one"), false);
  assert.equal(skipsNotification(id, [], "owner@kernal.one", "owner@kernal.one"), false);
  assert.equal(skipsNotification(id, [id], "owner@kernal.one", ""), false);
  assert.equal(skipsNotification(id, "req-1", "owner@kernal.one", "owner@kernal.one"), false);
  const remembered = rememberPanelRequest(["older"], id);
  assert.deepEqual(remembered, ["older", id]);
  assert.deepEqual(rememberPanelRequest(remembered, id), remembered);
  const many = rememberPanelRequest(Array.from({ length: 50 }, (_, i) => `r${i}`), "fresh");
  assert.equal(many.length, 50);
  assert.equal(many.at(-1), "fresh");
  assert.equal(many.includes("r0"), false);
});

test("the capture notice names the requester, the Floppy, and the tab", () => {
  const notice = captureNotice({
    requesterEmail: "ada@kernal.one",
    floppyName: "Notes",
    tabTitle: "Spec",
  });
  assert.match(notice.message, /ada@kernal\.one/);
  assert.match(notice.message, /Notes/);
  assert.match(notice.message, /Spec/);
  assert.equal(notice.button, "Revoke");
});

test("one automatic retry then stop", () => {
  assert.equal(MAX_CAPTURE_TRIES, 2);
  assert.equal(captureTryAllowed(0), true);
  assert.equal(captureTryAllowed(1), true);
  assert.equal(captureTryAllowed(2), false);
  assert.equal(captureTryAllowed(-1), false);
  assert.equal(mayUploadCapture(false), true);
  assert.equal(mayUploadCapture(true), false);
});

test("packed alarms run every 30 seconds", () => {
  assert.equal(ALARM_PERIOD_MINUTES, 0.5);
  const source = read("../extension/share.js");
  assert.match(source, /30 seconds/);
  assert.match(source, /0\.5/);
});

test("a host capture for an unrecorded tab is refused", () => {
  assert.deepEqual(parseHostCapture({ t: "capture", tabId: 4 }), { t: "capture", tabId: 4 });
  assert.equal(parseHostCapture({ t: "capture", tabId: "4" }), null);
  assert.equal(parseHostCapture({ t: "list" }), null);
  assert.deepEqual(hostCaptureReply(9, [4]), { t: "error", error: "not_shared" });
  assert.equal(hostCaptureReply(4, [4]), null);
  assert.deepEqual(nativeShareMessage({ tabId: 4, title: "Spec", url: "https://example.com", sessionId: session }), {
    t: "share",
    tabId: 4,
    title: "Spec",
    url: "https://example.com",
    sessionId: session,
  });
  assert.deepEqual(nativeUnshareMessage(4), { t: "unshare", tabId: 4 });
  assert.equal(hostCapturedMessage({ tabId: 4, title: "Spec", url: "https://example.com", jpegBase64: "aa==" }).t, "captured");
});

test("origin permission is that tab's http(s) origin and nothing broader", () => {
  assert.equal(tabPageUrl({ url: "https://example.com/docs", pendingUrl: "https://other.example/" }), "https://example.com/docs");
  assert.equal(tabPageUrl({ pendingUrl: "https://example.com/pending" }), "https://example.com/pending");
  assert.equal(tabPageUrl(null), "");
  assert.equal(originPermission("https://example.com/docs"), "https://example.com/*");
  assert.equal(originPermission("http://localhost:5173/sessions/1"), "http://localhost:5173/*");
  assert.equal(originPermission("chrome://newtab"), null);
  assert.equal(originPermission("file:///tmp/a"), null);
  assert.equal(originPermission("https://user:pass@example.com/"), null);
  assert.equal(originPermission(""), null);
});

test("the origins we must request are the tab origin and the link origin", () => {
  assert.deepEqual(
    sharePermissionOrigins("https://docs.example/guide", "https://link.example.com"),
    ["https://docs.example/*", "https://link.example.com/*"],
  );
  assert.deepEqual(
    sharePermissionOrigins("https://link.example.com/already", "https://link.example.com"),
    ["https://link.example.com/*"],
  );
  assert.deepEqual(sharePermissionOrigins("chrome://newtab/", "https://link.example.com"), [
    "https://link.example.com/*",
  ]);
  assert.deepEqual(sharePermissionOrigins("https://docs.example/guide", ""), ["https://docs.example/*"]);
  assert.deepEqual(shareAllowedAfterPermission({ linkGranted: false, tabGranted: true }), {
    ok: false,
    error: "link_permission_denied",
  });
  assert.deepEqual(shareAllowedAfterPermission({ linkGranted: true, tabGranted: false }), {
    ok: true,
    permission: "denied",
  });
  assert.deepEqual(shareAllowedAfterPermission({ linkGranted: true, tabGranted: true }), {
    ok: true,
    permission: "granted",
  });
  const options = read("../extension/options.js");
  const submit = options.slice(options.indexOf('form.addEventListener("submit"'));
  const requestAt = submit.indexOf("permissions.request");
  const setAt = submit.indexOf("chrome.storage.local.set");
  assert.ok(requestAt !== -1 && setAt !== -1 && requestAt < setAt);
  assert.match(submit, /origins: \[linkPattern\]/);
  const worker = read("../extension/background.js");
  assert.match(worker, /sharePermissionOrigins\(/);
  assert.match(worker, /shareAllowedAfterPermission\(/);
});

test("tab gone before record => do not keep a server share", () => {
  assert.equal(shareWhenTabGone({ tabGone: true, putDone: false, recordStored: false }), "skip");
  assert.equal(shareWhenTabGone({ tabGone: true, putDone: true, recordStored: false }), "delete_server_share");
  assert.equal(shareWhenTabGone({ tabGone: true, putDone: true, recordStored: true }), "leave_for_on_removed");
  assert.equal(shareWhenTabGone({ tabGone: false, putDone: true, recordStored: false }), "proceed");
  const source = read("../extension/background.js");
  const start = source.indexOf("async function commitShare");
  const end = source.indexOf("async function revokeSessionNow");
  assert.ok(start !== -1 && end > start);
  const commit = source.slice(start, end);
  assert.match(commit, /liveTab\(tabId\)/);
  assert.match(commit, /delete_server_share/);
  assert.match(commit, /dropUnrecordedServerShare\(/);
  const putAt = commit.indexOf('method: "PUT"');
  const writeAt = commit.indexOf("writeShares(next)");
  assert.ok(putAt !== -1 && writeAt !== -1 && putAt < writeAt);
});

test("a missing or discarded tab is not captured", () => {
  assert.equal(tabCaptureBlock(null), "tab_gone");
  assert.equal(tabCaptureBlock({ id: 4, discarded: true }), "tab_gone");
  assert.equal(tabCaptureBlock({ discarded: false }), "tab_gone");
  assert.equal(tabCaptureBlock({ id: 4, discarded: false }), null);
});

test("poll uses the floppy port name and the page cannot name a share", () => {
  assert.equal(sessionIdFromPortName(`floppy:${session}`), session);
  assert.equal(sessionIdFromPortName("floppy:../x"), null);
  assert.equal(sessionIdFromPortName("place"), null);
  assert.deepEqual(panelMessage({ t: "share-active", sessionId: session }), { t: "share-active", sessionId: session });
  assert.deepEqual(panelMessage({ t: "revoke-share", sessionId: session }), { t: "revoke-share", sessionId: session });
  assert.deepEqual(panelMessage({ t: "panel-request", requestId: "req-1" }), { t: "panel-request", requestId: "req-1" });
  assert.equal(panelMessage({ t: "share-active" }), null);
  assert.equal(panelMessage({ t: "capture", tabId: 4 }), null);
  assert.equal(panelMessage({ t: "poll" }), null);
});

test("the context menu targets the named Floppy, else the only one", () => {
  assert.equal(SHARE_MENU_TITLE, "Share this tab with the Floppy");
  const rows = [
    { id: session, name: "Notes", status: "open" },
    { id: other, name: "Other", status: "closed" },
  ];
  assert.deepEqual(sessionSummaries(rows), [{ id: session, name: "Notes" }]);
  assert.equal(sessionForMenuClick({ menuItemId: SHARE_MENU_ID, linkedSessionId: other, sessions: rows }), session);
  assert.equal(
    sessionForMenuClick({ menuItemId: menuItemIdForSession(other), linkedSessionId: session, sessions: rows }),
    other,
  );
  assert.equal(
    sessionForMenuClick({
      menuItemId: SHARE_MENU_ID,
      linkedSessionId: "",
      sessions: [
        { id: session, name: "Notes", status: "open" },
        { id: other, name: "Other", status: "open" },
      ],
    }),
    null,
  );
  assert.equal(floppyMenuLabel("  Notes  ", session), "Notes");
  assert.equal(floppyNameOf({ name: "Notes" }), "Notes");
  assert.equal(floppyNameOf({}), "Floppy");
  assert.equal(shareOwnerEmail({ ownerEmail: "ada@kernal.one" }), "ada@kernal.one");
  assert.equal(shareOwnerEmail({}), null);
});

test("link routes are the browser share, pending queue, revoke, and capture paths", () => {
  assert.equal(sharePath(session), `/api/sessions/${session}/browser/share`);
  assert.equal(pendingPath(session), `/api/sessions/${session}/browser/requests?status=pending`);
  assert.equal(revokeRequestPath(session, "req/1"), `/api/sessions/${session}/browser/requests/${encodeURIComponent("req/1")}/revoke`);
  assert.equal(capturesPath(session), `/api/sessions/${session}/browser/captures`);
  assert.deepEqual(pendingRequests([{ id: "req-1", requesterEmail: "ada@kernal.one", status: "pending" }, { id: "req-2", status: "done" }]), [
    { id: "req-1", requesterEmail: "ada@kernal.one" },
  ]);
});

test("failure counts stay bounded", () => {
  const seeded = {};
  for (let i = 0; i < 100; i++) seeded[`r${i}`] = 1;
  const next = recordFailure(seeded, "fresh", 2);
  assert.equal(next.fresh, 2);
  assert.equal(Object.keys(next).length, 100);
  assert.equal(next.r0, undefined);
});

test("the manifest adds the share permissions and not all_urls", () => {
  const manifest = JSON.parse(read("../extension/manifest.json"));
  for (const name of ["notifications", "contextMenus", "alarms", "nativeMessaging"]) {
    assert.equal(manifest.permissions.includes(name), true, name);
  }
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.equal(manifest.host_permissions, undefined);
});

test("the service worker polls, talks to the host, and does not log the Dongle", () => {
  const source = read("../extension/background.js");
  assert.match(source, /wakeSharePoll\(sessionIdFromPortName\(port\.name\)\)/);
  assert.match(source, /connectNative\(NATIVE_HOST\)/);
  assert.match(source, /sender\?\.id !== chrome\.runtime\.id/);
  assert.doesNotMatch(source, /console\.(log|debug|info|warn|error)/);
  assert.doesNotMatch(source, /<all_urls>/);
  const share = read("../extension/share.js");
  assert.match(share, /com\.kernal\.chrome/);
});
