import { test } from "node:test";
import assert from "node:assert/strict";
import outfitterMail from "../pi-extension/outfitter-mail.js";

function load(env: Record<string, string> = { OUTFITTER_SESSION_ID: "me" }) {
  const entries: Array<{ customType: string; data: unknown }> = [];
  let tool: any;
  outfitterMail(
    {
      registerTool: (t) => {
        tool = t;
      },
      appendEntry: (customType, data) => entries.push({ customType, data }),
    },
    env,
  );
  return { tool, entries };
}

test("outfitter_send appends an outfitter.mail custom entry and tells the model the send is queued", async () => {
  const { tool, entries } = load();
  assert.equal(tool.name, "outfitter_send");
  assert.match(tool.description, /Your own session id is "me"/);
  assert.deepEqual(tool.parameters.required, ["to", "text"]);

  const result = await tool.execute("call-1", { to: " peer ", text: "hi" });
  assert.deepEqual(entries, [{ customType: "outfitter.mail", data: { to: "peer", text: "hi", urgent: false } }]);
  assert.match(result.content[0].text, /Queued for session "peer"/);

  await tool.execute("call-2", { to: "peer", text: "stop", urgent: true });
  assert.deepEqual(entries[1].data, { to: "peer", text: "stop", urgent: true });
});

test("outfitter_send refuses to message its own session", async () => {
  const { tool, entries } = load();
  const result = await tool.execute("call-1", { to: "me", text: "hi" });
  assert.equal(entries.length, 0);
  assert.match(result.content[0].text, /own id/);
});
