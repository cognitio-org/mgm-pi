import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_PAGE_ORIGIN,
  LINK_KEY,
  NOTIFIED_UI_KEY,
  PAGE_ORIGIN_KEY,
  PANEL_SESSION_KEY,
  PLACEMENTS_KEY,
  POLL_MS,
  SHARE_UNAVAILABLE,
  TOKEN_KEY,
  apiPath,
  approvalNotificationId,
  approvalView,
  capturingText,
  floppyUrl,
  linkUrl,
  nextShareStatus,
  notificationCopy,
  openFloppyPlan,
  pageOriginForFloppy,
  placementRecord,
  pollDelay,
  publicError,
  sessionChoiceLabel,
  shareMessage,
  shareStatusText,
  shouldNotifyApproval,
  stateLine,
  steerBody,
  transcriptLines,
  uiResponseBody,
} from "../extension/panel-model.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const session = "550e8400-e29b-41d4-a716-446655440000";
const link = "https://outfitter-link-abc.a.run.app";

test("panel-model.js does not call Chrome", () => {
  const source = read("../extension/panel-model.js");
  assert.doesNotMatch(source, /\bchrome\./);
});

test("the Floppy URL is the paired page origin, never the link API origin", () => {
  assert.equal(floppyUrl("https://app.kernal.one", session), `https://app.kernal.one/sessions/${session}`);
  assert.equal(floppyUrl("http://localhost:5173", session), `http://localhost:5173/sessions/${session}`);
  assert.equal(floppyUrl("http://127.0.0.1:8080", session), `http://127.0.0.1:8080/sessions/${session}`);
  assert.equal(floppyUrl(link, session), null);
  assert.equal(floppyUrl("https://app.kernal.one.evil.com", session), null);
  assert.equal(floppyUrl("https://app.kernal.one", "../x"), null);
  assert.equal(pageOriginForFloppy("http://localhost:5173"), "http://localhost:5173");
  assert.equal(pageOriginForFloppy(link), DEFAULT_PAGE_ORIGIN);
  assert.equal(pageOriginForFloppy("http://localhost:5173/sessions/1"), DEFAULT_PAGE_ORIGIN);
  assert.equal(pageOriginForFloppy(undefined), DEFAULT_PAGE_ORIGIN);
  assert.equal(floppyUrl(pageOriginForFloppy(link), session), `https://app.kernal.one/sessions/${session}`);
});

test("link calls use the link origin and do not carry the Dongle in the URL", () => {
  assert.equal(linkUrl(link, apiPath("list")), `${link}/api/sessions`);
  assert.equal(linkUrl(link, apiPath("session", session)), `${link}/api/sessions/${session}`);
  assert.equal(linkUrl(link, apiPath("entries", session)), `${link}/api/sessions/${session}/entries`);
  assert.equal(linkUrl(link, apiPath("messages", session)), `${link}/api/sessions/${session}/messages`);
  assert.equal(linkUrl(link, apiPath("ui-response", session)), `${link}/api/sessions/${session}/ui-response`);
  assert.equal(linkUrl(link, apiPath("abort", session)), `${link}/api/sessions/${session}/abort`);
  assert.equal(apiPath("session", "../x"), null);
  assert.equal(linkUrl(link, "/api/sessions?token=outf_secret"), null);
  assert.equal(linkUrl("javascript:alert(1)", apiPath("list")), null);
  assert.equal(linkUrl("http://user:pass@localhost:8080", apiPath("list")), null);
});

test("the poll runs every 2 seconds only while the document is visible", () => {
  assert.equal(POLL_MS, 2000);
  assert.equal(pollDelay("visible"), 2000);
  assert.equal(pollDelay("hidden"), null);
  assert.equal(pollDelay("prerender"), null);
  assert.equal(pollDelay(undefined), null);
});

test("an approval notifies once per id and never while the panel is open", () => {
  assert.equal(shouldNotifyApproval(true, "q1", null), false);
  assert.equal(shouldNotifyApproval(false, "q1", null), true);
  assert.equal(shouldNotifyApproval(false, "q1", "q1"), false);
  assert.equal(shouldNotifyApproval(false, "q2", "q1"), true);
  assert.equal(shouldNotifyApproval(false, "", null), false);
  assert.equal(shouldNotifyApproval(false, null, null), false);
  assert.equal(approvalNotificationId("q1"), "approval:q1");
  assert.equal(approvalNotificationId(""), null);
  assert.deepEqual(notificationCopy("Notes", "Ship it?"), { title: "Notes", message: "Ship it?" });
  assert.deepEqual(notificationCopy("", ""), { title: "Floppy", message: "Approval waiting" });
});

test("approvals match the web answers and errors never echo a Dongle", () => {
  assert.deepEqual(approvalView({ id: "q1", method: "confirm", title: "Ship it?", message: "Now" }), {
    id: "q1",
    method: "confirm",
    title: "Ship it?",
    message: "Now",
  });
  assert.deepEqual(approvalView({ type: "extension_ui_request", id: "q2", method: "select", title: "Pick", options: ["a", "b"] }).options, ["a", "b"]);
  assert.equal(approvalView({ id: "q3", method: "input", title: "Name" }).method, "input");
  assert.equal(approvalView({ id: "q4", method: "editor", title: "Edit" }).unsupported, true);
  assert.equal(approvalView({ id: "q5", method: "notify", title: "Hi" }), null);
  assert.equal(approvalView(null), null);
  assert.deepEqual(uiResponseBody("q1", true), { id: "q1", value: true });
  assert.deepEqual(uiResponseBody("q1", false), { id: "q1", value: false });
  assert.deepEqual(uiResponseBody("q2", "a"), { id: "q2", value: "a" });
  assert.equal(uiResponseBody("q2", { leak: true }), null);
  assert.equal(publicError(401, { error: "nope" }), "The Dongle was rejected. Check the options page.");
  assert.equal(publicError(400, { error: "token outf_abcdefghijklmnopqrstuvwxyz0123456789ABC" }), "The link origin returned an error.");
  assert.deepEqual(steerBody("  hello  "), { text: "hello", behavior: "followUp" });
  assert.equal(steerBody("   "), null);
  assert.equal(steerBody("x".repeat(32001)), null);
});

test("transcript lines are plain text, newest last, and a capture is not a jpeg", () => {
  const entries = [];
  for (let i = 1; i <= 8; i += 1) entries.push({ type: "message", message: { role: "user", content: `line ${i}` } });
  entries.push({
    type: "message",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "secret thought" }, { type: "text", text: "done" }] },
  });
  entries.push({
    type: "custom",
    customType: "outfitter.browser.capture",
    data: { title: "Docs", jpegBase64: "aaaa", captureId: "c1" },
  });
  const lines = transcriptLines(entries);
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "You: line 5");
  assert.equal(lines[3], "You: line 8");
  assert.equal(lines[4], "Floppy: done");
  assert.equal(lines[5], "Captured: Docs");
  assert.equal(lines.some((line) => line.includes("thinking")), false);
  assert.equal(lines.some((line) => line.includes("jpeg") || line.includes("aaaa")), false);
  assert.deepEqual(transcriptLines([]), []);
});

test("share messages are the two worker messages, and silence is not a throw", () => {
  assert.deepEqual(shareMessage("share", session), { t: "share-active", sessionId: session });
  assert.deepEqual(shareMessage("revoke", session), { t: "revoke-share", sessionId: session });
  assert.equal(shareMessage("share", "../x"), null);
  assert.equal(shareStatusText(null, "status"), SHARE_UNAVAILABLE);
  assert.equal(shareStatusText(undefined, "share"), SHARE_UNAVAILABLE);
  assert.equal(shareStatusText({ ok: true, status: "shared", tabTitle: "Docs" }, "status"), "Shared: Docs");
  assert.equal(shareStatusText({ ok: true, status: "permission-denied" }, "status"), "Permission denied");
  assert.equal(shareStatusText({ ok: false, error: "permission_denied" }, "share"), "Permission denied");
  assert.equal(shareStatusText({ ok: true, status: "not-shared" }, "status"), "Not shared");
  assert.equal(shareStatusText({ ok: true }, "share"), "Shared");
  assert.equal(nextShareStatus("Shared: Docs", null, "status"), "Shared: Docs");
  assert.equal(nextShareStatus(SHARE_UNAVAILABLE, null, "status"), SHARE_UNAVAILABLE);
  assert.equal(capturingText({ capturingEmail: "a@b.c" }), "Capturing for a@b.c");
  assert.equal(capturingText({ capturing: "a@b.c" }), "Capturing for a@b.c");
  assert.equal(capturingText({}), null);
  assert.equal(capturingText(null), null);
});

test("Open Floppy focuses a live recorded tab and otherwise opens", () => {
  const record = { sessionId: session, tabId: 7, windowId: 3, groupId: 9 };
  assert.deepEqual(openFloppyPlan(record, true), { action: "focus", tabId: 7, windowId: 3 });
  assert.deepEqual(openFloppyPlan(record, false), { action: "open" });
  assert.deepEqual(placementRecord(session, { id: 4, windowId: 2, groupId: -1 }), {
    sessionId: session,
    tabId: 4,
    windowId: 2,
    groupId: -1,
  });
  assert.equal(placementRecord("../x", { id: 4, windowId: 2 }), null);
});

test("names and storage keys match the options page and the placement map", () => {
  assert.equal(stateLine({ name: "Notes", runState: "running" }), "Notes - running");
  assert.equal(stateLine({ runState: "failed", runStateReason: "sandbox refused" }), "Untitled - failed - sandbox refused");
  assert.equal(stateLine({}), "Untitled - no run");
  assert.equal(sessionChoiceLabel({ name: "Notes", runState: "idle" }), "Notes - idle");
  assert.equal(TOKEN_KEY, "OUTFITTER_TOKEN");
  assert.equal(LINK_KEY, "OUTFITTER_API");
  assert.equal(PAGE_ORIGIN_KEY, "pageOrigin");
  assert.equal(PANEL_SESSION_KEY, "panelSessionId");
  assert.equal(NOTIFIED_UI_KEY, "panelNotifiedUi");
  assert.equal(PLACEMENTS_KEY, "placements");
  const background = read("../extension/background.js");
  assert.match(background, /const PLACEMENTS_KEY = "placements"/);
});

test("the panel is an extension page and does not render a Dongle or capture", () => {
  const html = read("../extension/panel.html");
  const js = read("../extension/panel.js");
  const manifest = JSON.parse(read("../extension/manifest.json"));
  assert.doesNotMatch(html, /iframe/i);
  assert.doesNotMatch(html, /innerHTML/);
  assert.doesNotMatch(js, /innerHTML/);
  assert.doesNotMatch(js, /captureVisibleTab/);
  assert.doesNotMatch(js, /connectNative/);
  assert.doesNotMatch(js, /chrome\.alarms/);
  assert.doesNotMatch(js, /console\./);
  assert.doesNotMatch(js, /textContent\s*=\s*[^;\n]*token/i);
  assert.match(js, /floppyUrl\(pageOriginForFloppy/);
  assert.match(js, /shareMessage\(/);
  assert.match(read("../extension/panel-model.js"), /share-active/);
  assert.match(read("../extension/panel-model.js"), /revoke-share/);
  assert.equal(manifest.side_panel.default_path, "panel.html");
  assert.equal(manifest.permissions.includes("sidePanel"), true);
  assert.equal(manifest.permissions.includes("notifications"), true);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
});
