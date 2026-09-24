import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePageMessage } from "../extension/protocol.js";
import {
  actionMayRun,
  actionNotice,
  gateAction,
  kindAllowed,
  pageAsksForAction,
  parseActionBody,
  parseHostAction,
  pendingActions,
  readAllowMap,
  withKindAllowed,
} from "../extension/action.js";

test("a denied confirm does not click, and an unknown tab does not click", () => {
  let clicks = 0;
  const perform = () => {
    clicks += 1;
  };
  const denied = gateAction({
    tabId: 4,
    recordedTabIds: [4],
    confirm: "deny",
    allowOn: false,
    perform,
  });
  assert.deepEqual(denied, { clicked: false, error: "denied" });
  assert.equal(clicks, 0);

  const unknown = gateAction({
    tabId: 9,
    recordedTabIds: [4],
    confirm: "allow",
    allowOn: true,
    perform,
  });
  assert.deepEqual(unknown, { clicked: false, error: "not_shared" });
  assert.equal(clicks, 0);

  const waiting = gateAction({
    tabId: 4,
    recordedTabIds: [4],
    confirm: null,
    allowOn: false,
    perform,
  });
  assert.equal(waiting.clicked, false);
  assert.equal(waiting.error, "waiting");
  assert.equal(clicks, 0);

  const allowed = gateAction({
    tabId: 4,
    recordedTabIds: [4],
    confirm: "allow",
    allowOn: false,
    perform,
  });
  assert.equal(allowed.clicked, true);
  assert.equal(clicks, 1);
});

test("the kind switch defaults to off and is the only way to skip the confirm", () => {
  assert.equal(kindAllowed(readAllowMap(undefined), "sess", "click"), false);
  assert.equal(kindAllowed({}, "sess", "type"), false);
  assert.equal(actionMayRun(null, false), "wait");
  assert.equal(actionMayRun("deny", false), "deny");
  assert.equal(actionMayRun("deny", true), "run");
  const on = withKindAllowed({}, "sess", "click", true);
  assert.equal(kindAllowed(on, "sess", "click"), true);
  assert.equal(kindAllowed(on, "sess", "type"), false);
  let clicks = 0;
  const ran = gateAction({
    tabId: 4,
    recordedTabIds: [4],
    confirm: null,
    allowOn: kindAllowed(on, "sess", "click"),
    perform: () => {
      clicks += 1;
    },
  });
  assert.equal(ran.clicked, true);
  assert.equal(clicks, 1);
});

test("the page channel cannot ask for a click or keystrokes", () => {
  const messages = [
    { t: "click", selector: "#go" },
    { t: "type", selector: "#q", text: "hello" },
    { t: "action", kind: "click", selector: "a" },
    { t: "browser_action", kind: "type", selector: "input", text: "x" },
    { t: "keydown", key: "Enter" },
    { t: "keypress", key: "a" },
    { keystrokes: "hello" },
    { t: "ping", selector: "#x" },
    { t: "ping", kind: "click" },
  ];
  for (const message of messages) {
    assert.equal(pageAsksForAction(message), true, JSON.stringify(message));
    const parsed = parsePageMessage(message);
    assert.deepEqual(parsed, { ok: false, error: "rejected" });
    const encoded = JSON.stringify(parsed);
    assert.equal(encoded.includes("#"), false);
    assert.equal(encoded.includes("hello"), false);
    assert.equal(encoded.includes("Enter"), false);
  }
  assert.equal(parsePageMessage({ t: "place", sessionId: "s", url: "https://app.kernal.one/sessions/s", title: "click the button", mode: "own" }).ok, true);
});

test("an action body is click or type with a CSS selector, never JavaScript", () => {
  assert.deepEqual(parseActionBody({ kind: "click", selector: " div > button.ok " }), { kind: "click", selector: "div > button.ok" });
  assert.deepEqual(parseActionBody({ kind: "type", selector: "#q", text: "hi" }), { kind: "type", selector: "#q", text: "hi" });
  assert.equal(parseActionBody({ kind: "click", selector: "#q", text: "no" }), null);
  assert.equal(parseActionBody({ kind: "click", selector: "javascript:alert(1)" }), null);
  assert.equal(parseActionBody({ kind: "click", selector: "a[href='javascript:alert(1)']" }), null);
  assert.equal(parseActionBody({ kind: "type", selector: "#q", text: "ok", code: "alert(1)" }), null);
  assert.equal(parseActionBody({ kind: "eval", selector: "#q" }), null);
  assert.equal(parseHostAction({ t: "action", tabId: 9, kind: "click", selector: "#nope" }).tabId, 9);
  assert.equal(parseHostAction({ t: "action", tabId: 4, kind: "click", selector: "javascript:alert(1)" }), null);
});

test("a pending action is not a capture, and the notice names the requester, kind, and selector", () => {
  const rows = [
    { id: "cap", requesterEmail: "a@b.c", status: "pending" },
    { id: "act", requesterEmail: "ada@kernal.one", status: "pending", kind: "click", selector: "#go" },
  ];
  assert.deepEqual(pendingActions(rows), [{ id: "act", requesterEmail: "ada@kernal.one", kind: "click", selector: "#go" }]);
  const notice = actionNotice({ requesterEmail: "ada@kernal.one", kind: "type", selector: "#q" });
  assert.match(notice.message, /ada@kernal\.one/);
  assert.match(notice.message, /type into/);
  assert.match(notice.message, /#q/);
  assert.deepEqual(notice.buttons, ["Allow", "Deny"]);
});

test("the injected click and type functions do not eval", () => {
  const src = readFileSync(new URL("../extension/action.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\beval\s*\(|new Function|chrome\.debugger/);
});
