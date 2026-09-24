import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { InspectListener } from "../src/browser-inspect.js";
import outfitterBrowser from "../pi-extension/outfitter-browser.js";

const SECRET = "super-secret-value";

test("browser_inspect redacts an Authorization header and does not read OUTFITTER_TOKEN", async () => {
  let asked = "";
  const listener = new InspectListener({
    waitMs: 300,
    sendRequest: (requestId) => {
      asked = requestId;
      listener.deliver({
        t: "browser.inspect.result",
        requestId,
        messages: [
          `log: Authorization: Bearer ${SECRET}`,
          `Cookie: session=${SECRET}`,
          JSON.stringify({ Authorization: `Bearer ${SECRET}` }),
        ],
        element: "button#go.primary",
      });
    },
  });
  await listener.start();
  try {
    const refused = await fetch(`http://127.0.0.1:${listener.port}/browser/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(refused.status, 403);

    const tools: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }[] = [];
    outfitterBrowser(
      { registerTool: (tool) => tools.push(tool as (typeof tools)[number]) },
      {
        OUTFITTER_BROWSER_INSPECT_PORT: String(listener.port),
        OUTFITTER_BROWSER_INSPECT_TOKEN: listener.token,
        OUTFITTER_TOKEN: "outf_should-not-be-sent",
      },
    );
    const tool = tools.find((item) => item.name === "browser_inspect");
    assert.ok(tool);
    assert.equal(tools.some((item) => item.name === "browser_capture"), true);
    assert.equal(tools.some((item) => item.name === "browser_action"), true);
    const read = await tool.execute("call", {});
    const text = read.content[0].text;
    assert.equal(text.includes(SECRET), false);
    assert.match(text, /authorization: \[redacted\]/i);
    assert.match(text, /button#go\.primary/);
    assert.equal(asked.length > 0, true);

    const extra = await fetch(`http://127.0.0.1:${listener.port}/browser/inspect`, {
      method: "POST",
      headers: { "x-outfitter-browser-token": listener.token, "content-type": "application/json" },
      body: JSON.stringify({ tabId: 4 }),
    });
    assert.equal(extra.status, 200);
    assert.deepEqual(await extra.json(), { error: "rejected" });
  } finally {
    await listener.stop();
  }

  const denied = new InspectListener({
    waitMs: 300,
    sendRequest: (requestId) => {
      denied.deliver({ t: "browser.inspect.result", requestId, error: "denied" });
    },
  });
  await denied.start();
  try {
    const tools: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }[] = [];
    outfitterBrowser(
      { registerTool: (tool) => tools.push(tool as (typeof tools)[number]) },
      {
        OUTFITTER_BROWSER_INSPECT_PORT: String(denied.port),
        OUTFITTER_BROWSER_INSPECT_TOKEN: denied.token,
        OUTFITTER_TOKEN: "outf_should-not-be-sent",
      },
    );
    const tool = tools.find((item) => item.name === "browser_inspect");
    assert.ok(tool);
    const result = await tool.execute("call", {});
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].text, "denied");
  } finally {
    await denied.stop();
  }

  const src = readFileSync(new URL("../pi-extension/outfitter-browser.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /env\.OUTFITTER_TOKEN|process\.env\.OUTFITTER_TOKEN/);
  assert.match(src, /browser_inspect/);
  assert.doesNotMatch(src, /chrome\.debugger/);
});
