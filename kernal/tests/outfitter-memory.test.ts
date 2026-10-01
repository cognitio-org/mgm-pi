// E9 §3.3: the outfitter-agentengine extension's `memory` tool -- registered only in a Drive whose
// tape has memory, the action -> op mapping, and the token budget for its definition.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import register from "../.pi/extensions/outfitter-agentengine/index.ts";
import { MEMORY_TOOL, memoryOp, runMemory } from "../.pi/extensions/outfitter-agentengine/memory.ts";
import type { AdminTransport } from "../.pi/extensions/outfitter-admin/transport.ts";

function fakePi() {
  const tools: any[] = [];
  return { pi: { registerTool: (t: any) => tools.push(t), registerCommand() {}, on() {} } as any, tools };
}

function recorder(replies: Array<Record<string, unknown>>, kind: "laptop" | "drive" = "drive") {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const transport: AdminTransport = {
    kind,
    async call(op, args) {
      calls.push({ op, args });
      return (replies.shift() ?? { ok: true, text: "" }) as any;
    },
  };
  return { transport, calls };
}

describe("registration", () => {
  test("a Drive with the memory capability: the memory tool", () => {
    const { pi, tools } = fakePi();
    register(pi, { env: { OUTFITTER_ADMIN_CAPS: "memory" }, transport: recorder([]).transport });
    assert.deepEqual(tools.map((t) => t.name), ["memory"]);
  });

  test("without the capability, on a laptop, or with no socket: nothing", () => {
    for (const [env, kind] of [
      [{ OUTFITTER_ADMIN_CAPS: "admin,agentEngine" }, "drive"],
      [{}, "drive"],
      [{ OUTFITTER_ADMIN_CAPS: "memory" }, "laptop"],
    ] as const) {
      const { pi, tools } = fakePi();
      register(pi, { env, transport: recorder([], kind).transport });
      assert.equal(tools.length, 0, JSON.stringify(env));
    }
    const { pi, tools } = fakePi();
    register(pi, { env: { OUTFITTER_ADMIN_CAPS: "memory" }, transport: undefined });
    assert.equal(tools.length, 0);
  });

  test("from the environment: the Drive's socket, never a Dongle", () => {
    const drive = fakePi();
    register(drive.pi, { env: { OUTFITTER_ADMIN_SOCKET: "/run/outfitter/admin.sock", OUTFITTER_ADMIN_CAPS: "memory" } });
    assert.deepEqual(drive.tools.map((t) => t.name), ["memory"]);
    const laptop = fakePi();
    register(laptop.pi, { env: { OUTFITTER_API: "https://x", OUTFITTER_TOKEN: "t", OUTFITTER_ADMIN_CAPS: "memory" } });
    assert.equal(laptop.tools.length, 0);
  });

  test("token budget: the definition stays under ~250 tokens, one-line description", () => {
    const { pi, tools } = fakePi();
    register(pi, { env: { OUTFITTER_ADMIN_CAPS: "memory" }, transport: recorder([]).transport });
    const t = tools[0];
    const chars = JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters, promptSnippet: t.promptSnippet, promptGuidelines: t.promptGuidelines }).length;
    assert.ok(chars / 4 <= 250, `memory is ~${Math.round(chars / 4)} tokens`);
    assert.ok(t.description.length <= 160, `description is ${t.description.length} chars`);
  });
});

describe("memory tool", () => {
  test("search -> memory.search with query, type and limit only", () => {
    assert.deepEqual(memoryOp({ action: "search", query: "tests", type: "semantic", limit: 5, text: "ignored", shared: true }), { op: "memory.search", args: { query: "tests", type: "semantic", limit: 5 } });
    assert.deepEqual(memoryOp({ action: "search" }), { error: "search needs query" });
  });

  test("save -> memory.save with type, text, label, shared; no user, repo or namespace from the model", () => {
    assert.deepEqual(memoryOp({ action: "save", type: "semantic", text: "npm test", label: "tests", shared: false, repo: "evil/x", userId: "u" }), {
      op: "memory.save",
      args: { type: "semantic", text: "npm test", label: "tests", shared: false },
    });
    assert.match((memoryOp({ action: "save", text: "x" }) as any).error, /save needs type/);
    assert.deepEqual(memoryOp({ action: "save", type: "semantic", text: " " }), { error: "save needs text" });
    assert.match((memoryOp({ action: "forget" }) as any).error, /action must be one of: search, save/);
  });

  test("results pass through; errors are marked", async () => {
    const { transport, calls } = recorder([{ ok: true, text: "Notes from earlier sessions...\n- x" }, { ok: false, error: "memory is off for this tape" }]);
    assert.deepEqual(await runMemory({ action: "search", query: "x" }, transport), { content: [{ type: "text", text: "Notes from earlier sessions...\n- x" }], details: undefined });
    assert.deepEqual(await runMemory({ action: "save", type: "semantic", text: "y" }, transport), { content: [{ type: "text", text: "memory: memory is off for this tape" }], isError: true, details: undefined });
    assert.deepEqual(calls.map((c) => c.op), ["memory.search", "memory.save"]);
    const bad = await runMemory({ action: "nope" }, transport);
    assert.equal(bad.isError, true);
    assert.equal(calls.length, 2, "a bad call never reaches the socket");
  });

  test("the schema offers exactly the two actions and four types", () => {
    assert.deepEqual(MEMORY_TOOL.parameters.properties.action.enum, ["search", "save"]);
    assert.deepEqual(MEMORY_TOOL.parameters.properties.type.enum, ["semantic", "episodic", "procedural", "taxonomic"]);
  });
});
