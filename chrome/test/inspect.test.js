import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePageMessage } from "../extension/protocol.js";
import { pendingRequests } from "../extension/share.js";
import {
  ELEMENT_DESCRIPTION,
  SELECTED_ELEMENT_EXPRESSION,
  describeElement,
  elementFromDescribedNode,
  gateInspect,
  lineFromConsoleEvent,
  lineFromRuntimeEvent,
  pageAsksForDebugger,
  parseHostInspect,
  pendingInspects,
  redactHeaderText,
  redactInspectResult,
  redactSecrets,
} from "../extension/inspect.js";

const SECRET = "super-secret-value";

test("a denied confirm does not attach", () => {
  let attached = false;
  const result = gateInspect({
    tabId: 4,
    recordedTabIds: [4],
    confirm: "deny",
    attached: false,
    perform() {
      attached = true;
    },
  });
  assert.equal(attached, false);
  assert.equal(result.attach, false);
  assert.equal(result.read, false);
  assert.equal(result.error, "denied");
});

test("an unknown tab id does not attach", () => {
  let attached = false;
  const result = gateInspect({
    tabId: 9,
    recordedTabIds: [4],
    confirm: "allow",
    attached: false,
    perform() {
      attached = true;
    },
  });
  assert.equal(attached, false);
  assert.equal(result.attach, false);
  assert.equal(result.error, "not_shared");
  assert.equal(gateInspect({ tabId: -1, recordedTabIds: [-1], confirm: "allow", perform() { attached = true; } }).error, "not_shared");
  assert.equal(attached, false);
});

test("a result that contained an Authorization header does not contain the header value", () => {
  const result = redactInspectResult({
    messages: [
      `log: Authorization: Bearer ${SECRET}`,
      { name: "Authorization", value: SECRET },
      `Cookie: session=${SECRET}`,
      { headers: { Authorization: SECRET, Cookie: `a=${SECRET}` } },
    ],
    element: { tag: "BUTTON", id: "go", classes: ["primary", "extra"] },
    headers: { Authorization: SECRET },
  });
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes(SECRET), false);
  assert.match(result.messages[0], /authorization: \[redacted\]/i);
  assert.equal(result.element, "button#go.primary.extra");
  assert.equal(Object.hasOwn(result, "headers"), false);
  assert.equal(redactHeaderText(`Authorization: Bearer ${SECRET}`).includes(SECRET), false);
  assert.equal(redactHeaderText(JSON.stringify({ Authorization: `Bearer ${SECRET}` })).includes(SECRET), false);
  assert.equal(JSON.stringify(redactSecrets({ name: "Cookie", value: SECRET })).includes(SECRET), false);
});

test("the selected element is a short description, not the DOM", () => {
  const described = elementFromDescribedNode({
    nodeName: "BUTTON",
    nodeType: 1,
    attributes: ["id", "go", "class", "primary extra", "href", "javascript:alert(1)"],
    children: [{ nodeName: "SPAN" }],
    outerHTML: `<button>${SECRET}</button>`,
  });
  assert.equal(described, "button#go.primary.extra");
  assert.equal(described.includes(SECRET), false);
  assert.equal(described.includes("javascript"), false);
  assert.equal(describeElement({ tag: "div", id: "x y", classes: ["ok", "<bad>"] }), "div.ok");
  assert.equal(ELEMENT_DESCRIPTION.test(described), true);
  assert.doesNotMatch(SELECTED_ELEMENT_EXPRESSION, /innerHTML|outerHTML|querySelectorAll/);
});

test("console lines come from Runtime or Console and drop header values", () => {
  const runtime = lineFromRuntimeEvent({
    type: "log",
    args: [{ type: "string", value: `Authorization: Bearer ${SECRET}` }],
  });
  assert.match(runtime, /^log: /);
  assert.equal(runtime.includes(SECRET), false);
  const consoleLine = lineFromConsoleEvent({ message: { level: "error", text: `Cookie: ${SECRET}`, url: "https://secret.example" } });
  assert.match(consoleLine, /^error: /);
  assert.equal(consoleLine.includes(SECRET), false);
  assert.equal(consoleLine.includes("secret.example"), false);
});

test("the page channel cannot request a debugger attach, and an inspect is not a capture", () => {
  for (const message of [{ t: "inspect" }, { t: "debugger" }, { t: "browser_inspect" }, { t: "ping", devtools: true }]) {
    assert.equal(pageAsksForDebugger(message), true);
    assert.deepEqual(parsePageMessage(message), { ok: false, error: "rejected" });
  }
  assert.equal(pageAsksForDebugger({ t: "ping" }), false);
  assert.equal(parseHostInspect({ t: "inspect", tabId: 4 }).tabId, 4);
  assert.equal(parseHostInspect({ t: "inspect", tabId: 4, code: "alert(1)" }), null);
  const rows = [
    { id: "cap", requesterEmail: "a@b.c", status: "pending" },
    { id: "ins", requesterEmail: "a@b.c", status: "pending", kind: "inspect" },
    { id: "act", requesterEmail: "a@b.c", status: "pending", kind: "click", selector: "#go" },
  ];
  assert.deepEqual(pendingRequests(rows), [{ id: "cap", requesterEmail: "a@b.c" }]);
  assert.deepEqual(pendingInspects(rows), [{ id: "ins", requesterEmail: "a@b.c" }]);
});

test("finishInspect attaches only after the gate allows it", () => {
  const src = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const start = src.indexOf("async function finishInspect");
  const end = src.indexOf("async function cancelHostInspect");
  const fn = src.slice(start, end);
  assert.ok(start !== -1 && end > start);
  assert.match(fn, /gateInspect\(/);
  assert.doesNotMatch(fn, /chrome\.debugger\.attach/);
  const denied = fn.indexOf("gated.error");
  const attachCall = fn.indexOf("attachAndEnable");
  assert.ok(denied !== -1 && attachCall > denied);
  assert.match(src, /chrome\.debugger\.attach/);
  assert.doesNotMatch(src, /Network\.enable|Network\.getRequestHeaders/);
});
