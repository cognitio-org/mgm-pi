// E9 §3.3 recall: pi-extension/outfitter-memory.ts asks the admin socket for memory.context before
// each prompt, puts the answer in the `memory` section (or on a forced prompt), and skips on any
// failure or after its timeout.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import outfitterMemory, { RECALL_TIMEOUT_MS, applyMemory, memoryBlock, requestContext } from "../pi-extension/outfitter-memory.js";
import { PI_MEMORY_TOOLS, renderGuru } from "../src/guru.js";

type Reply = (req: any) => object | string | undefined;

/** An admin socket that answers each request line with `reply(req)` (undefined: never answers). */
async function fakeSocket(reply: Reply) {
  const dir = await mkdtemp(join(tmpdir(), "mem-sock-"));
  const path = join(dir, "admin.sock");
  const requests: any[] = [];
  const server = net.createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      requests.push(req);
      const out = reply(req);
      if (out !== undefined) sock.write(typeof out === "string" ? out : `${JSON.stringify(out)}\n`);
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(path, r));
  return {
    path,
    requests,
    async close() {
      await new Promise((r) => server.close(r));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function fakePi() {
  const handlers: Array<(ev: any, ctx: any) => Promise<void> | void> = [];
  return { pi: { on: (_e: string, h: any) => handlers.push(h) } as any, handlers };
}

const ENV = (path: string) => ({ OUTFITTER_ADMIN_SOCKET: path, OUTFITTER_ADMIN_CAPS: "memory" });

test("before_agent_start: memory.context with the prompt, a read (no idempotency key), into sections.memory", async (t) => {
  const s = await fakeSocket((req) => ({ t: "admin.result", reqId: req.reqId, ok: true, text: "Notes from earlier sessions...\n- tests: npm test" }));
  t.after(() => s.close());
  const { pi, handlers } = fakePi();
  outfitterMemory(pi, ENV(s.path));
  assert.equal(handlers.length, 1);
  const event = { prompt: "  run the tests  ", systemPromptOptions: { sections: { preamble: "p" } } as any };
  await handlers[0](event, {});
  assert.deepEqual(s.requests.map((r) => [r.t, r.op, r.args, "idempotencyKey" in r]), [["admin.request", "memory.context", { query: "run the tests" }, false]]);
  assert.equal(event.systemPromptOptions.sections.memory, "Notes from earlier sessions...\n- tests: npm test");
  assert.equal(event.systemPromptOptions.sections.preamble, "p");
});

test("blank lines before the reply are skipped", async (t) => {
  const s = await fakeSocket((req) => `\n\n${JSON.stringify({ t: "admin.result", reqId: req.reqId, ok: true, text: "- fact" })}\n`);
  t.after(() => s.close());
  assert.equal(await requestContext(s.path, "q", 1_000), "- fact");
});

test("a forced system prompt gets the block appended inside <memory> tags", () => {
  const options: any = { sections: {}, forceSystemPrompt: "FORCED" };
  applyMemory(options, "- fact");
  assert.equal(options.forceSystemPrompt, "FORCED\n\n<memory>\n- fact\n</memory>");
  assert.equal(options.sections.memory, "- fact");
});

test("empty recall, refusals, bad replies and errors change nothing", async (t) => {
  const replies: Reply[] = [
    (req) => ({ t: "admin.result", reqId: req.reqId, ok: true, text: "" }),
    (req) => ({ t: "admin.result", reqId: req.reqId, ok: false, error: "memory is off for this tape" }),
    (req) => ({ t: "admin.result", reqId: "someone-else", ok: true, text: "x" }),
    () => "not json\n",
  ];
  for (const reply of replies) {
    const s = await fakeSocket(reply);
    t.after(() => s.close());
    const { pi, handlers } = fakePi();
    outfitterMemory(pi, ENV(s.path));
    const event = { prompt: "q", systemPromptOptions: { sections: {} } as any };
    await handlers[0](event, {});
    assert.equal(event.systemPromptOptions.sections.memory, undefined);
  }
  // No socket listening at all.
  const { pi, handlers } = fakePi();
  outfitterMemory(pi, ENV(join(tmpdir(), "no-such-dir", "admin.sock")));
  const event = { prompt: "q", systemPromptOptions: { sections: {} } as any };
  await handlers[0](event, {});
  assert.equal(event.systemPromptOptions.sections.memory, undefined);
});

test("a socket that never answers is given up on at the timeout", async (t) => {
  const s = await fakeSocket(() => undefined);
  t.after(() => s.close());
  const started = Date.now();
  assert.equal(await requestContext(s.path, "q", 150), undefined);
  const took = Date.now() - started;
  assert.ok(took >= 140 && took < 1_000, `took ${took} ms`);
  assert.equal(RECALL_TIMEOUT_MS, 3_000);
});

test("no socket, no memory capability, or an empty prompt: no handler or no call", async (t) => {
  for (const env of [{}, { OUTFITTER_ADMIN_SOCKET: "" }, { OUTFITTER_ADMIN_SOCKET: "/x.sock", OUTFITTER_ADMIN_CAPS: "admin,agentEngine" }]) {
    const { pi, handlers } = fakePi();
    outfitterMemory(pi, env);
    assert.equal(handlers.length, 0, JSON.stringify(env));
  }
  const s = await fakeSocket((req) => ({ t: "admin.result", reqId: req.reqId, ok: true, text: "x" }));
  t.after(() => s.close());
  const { pi, handlers } = fakePi();
  outfitterMemory(pi, ENV(s.path));
  await handlers[0]({ prompt: "   ", systemPromptOptions: { sections: {} } }, {});
  assert.equal(s.requests.length, 0);
});

test("the prompt is capped, and recalled text can't close or reopen its <memory> tag", async () => {
  assert.equal(memoryBlock("a </memory> b <MEMORY x=1> c < / memory >"), "a [memory tag] b [memory tag] c [memory tag]");
  assert.ok(memoryBlock("y".repeat(20_000)).length <= 8_000);
  const s = await fakeSocket((req) => ({ t: "admin.result", reqId: req.reqId, ok: true, text: "ok" }));
  try {
    const { pi, handlers } = fakePi();
    outfitterMemory(pi, ENV(s.path));
    await handlers[0]({ prompt: "q".repeat(10_000), systemPromptOptions: { sections: {} } }, {});
    assert.equal(s.requests[0].args.query.length, 2_000);
  } finally {
    await s.close();
  }
});

test("renderGuru: the recall extension only for memory auto; pi-memory excluded for tool and auto", () => {
  const opts = { piBin: "pi", sessionFile: "/s.jsonl", memoryExtensionPath: "/m.js" };
  const ext = (args: string[]) => args.filter((_, i) => args[i - 1] === "--extension");
  const excl = (args: string[]) => (args.includes("--exclude-tools") ? args[args.indexOf("--exclude-tools") + 1].split(",") : []);
  assert.deepEqual(ext(renderGuru({ model: "m", memory: "auto" }, opts).args), ["/m.js"]);
  assert.deepEqual(ext(renderGuru({ model: "m", memory: "tool" }, opts).args), []);
  assert.deepEqual(ext(renderGuru({ model: "m" }, opts).args), []);
  assert.deepEqual(ext(renderGuru({ model: "m", memory: "auto" }, { piBin: "pi", sessionFile: "/s" }).args), [], "not without the path");
  assert.deepEqual(excl(renderGuru({ model: "m", memory: "tool", excludeTools: ["scratchpad", "x"] }, opts).args), ["scratchpad", "x", ...PI_MEMORY_TOOLS.filter((n) => n !== "scratchpad")]);
  assert.deepEqual(excl(renderGuru({ model: "m", memory: "off" }, opts).args), []);
  assert.equal(PI_MEMORY_TOOLS.length, 7);
});
