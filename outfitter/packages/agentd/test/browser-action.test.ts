import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ActionListener } from "../src/browser-action.js";
import outfitterBrowser from "../pi-extension/outfitter-browser.js";

test("the action listener binds loopback and does not ask Chrome to run JavaScript", async () => {
  let asked: { kind?: string; selector?: string; text?: string } | undefined;
  const listener = new ActionListener({
    waitMs: 300,
    sendRequest: (action) => {
      asked = action;
      listener.deliver({ t: "browser.action.result", requestId: action.requestId });
    },
  });
  await listener.start();
  try {
    const address = listener.port;
    assert.ok(address);
    const refused = await fetch(`http://127.0.0.1:${address}/browser/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "click", selector: "#go" }),
    });
    assert.equal(refused.status, 403);

    const bad = await fetch(`http://127.0.0.1:${address}/browser/action`, {
      method: "POST",
      headers: { "x-outfitter-browser-token": listener.token, "content-type": "application/json" },
      body: JSON.stringify({ kind: "click", selector: "javascript:alert(1)" }),
    });
    assert.equal(bad.status, 200);
    assert.deepEqual(await bad.json(), { error: "rejected" });
    assert.equal(asked === undefined, true);

    const tools: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }[] = [];
    outfitterBrowser(
      { registerTool: (tool) => tools.push(tool as (typeof tools)[number]) },
      {
        OUTFITTER_BROWSER_ACTION_PORT: String(address),
        OUTFITTER_BROWSER_ACTION_TOKEN: listener.token,
        OUTFITTER_TOKEN: "outf_should-not-be-sent",
      },
    );
    const tool = tools.find((item) => item.name === "browser_action");
    assert.ok(tool);
    assert.equal(tools.some((item) => item.name === "browser_capture"), true);
    const clicked = await tool.execute("call", { kind: "click", selector: "#go" });
    assert.equal(clicked.content[0].text, "Clicked #go");
    assert.equal(asked?.kind, "click");
    assert.equal(asked?.selector, "#go");
    assert.equal(asked?.text, undefined);

    const typed = await tool.execute("call-2", { kind: "type", selector: "#q", text: "hello" });
    assert.equal(typed.content[0].text, "Typed into #q");
    assert.equal(asked?.text, "hello");
    const rejected = await tool.execute("call-3", { kind: "click", selector: "javascript:alert(1)" });
    assert.equal(rejected.content[0].text, "rejected");
  } finally {
    await listener.stop();
  }
});

test("a denied action is text and browser_action does not read OUTFITTER_TOKEN", async () => {
  const listener = new ActionListener({
    waitMs: 300,
    sendRequest: (action) => {
      listener.deliver({ t: "browser.action.result", requestId: action.requestId, error: "denied" });
    },
  });
  await listener.start();
  try {
    const tools: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }[] = [];
    outfitterBrowser(
      { registerTool: (tool) => tools.push(tool as (typeof tools)[number]) },
      {
        OUTFITTER_BROWSER_ACTION_PORT: String(listener.port),
        OUTFITTER_BROWSER_ACTION_TOKEN: listener.token,
        OUTFITTER_TOKEN: "outf_should-not-be-sent",
      },
    );
    const tool = tools.find((item) => item.name === "browser_action");
    assert.ok(tool);
    const denied = await tool.execute("call", { kind: "click", selector: "#go" });
    assert.equal(denied.content.length, 1);
    assert.equal(denied.content[0].text, "denied");
  } finally {
    await listener.stop();
  }

  const src = readFileSync(new URL("../pi-extension/outfitter-browser.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /env\.OUTFITTER_TOKEN|process\.env\.OUTFITTER_TOKEN/);
  assert.match(src, /browser_action/);
  assert.doesNotMatch(src, /chrome\.debugger/);
});
