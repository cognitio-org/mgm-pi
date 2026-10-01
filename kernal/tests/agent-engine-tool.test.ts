// E9 PR4 (outfitter/docs/specs/atlas-agent-engine-and-a2a.md §4): the agent_engine tool -- when it
// registers, the action -> op mapping, how a declined resume reads, and its token budget.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import register from "../.pi/extensions/outfitter-agentengine/index.ts";
import { AGENT_ENGINE_TOOL, PROMPT_GUIDELINES, registerAgentEngineTool, runAgentEngineTool, toAgentEngineOp } from "../.pi/extensions/outfitter-agentengine/agents.ts";
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
  test("a Drive whose tape has Agent Engine gets agent_engine; without the capability, a laptop, or no socket, nothing", () => {
    const cases: Array<[Record<string, string>, "drive" | "laptop" | undefined, number]> = [
      [{ OUTFITTER_ADMIN_CAPS: "agentEngine" }, "drive", 1],
      [{ OUTFITTER_ADMIN_CAPS: "memory,agentEngine" }, "drive", 1],
      [{ OUTFITTER_ADMIN_CAPS: "admin,memory" }, "drive", 0],
      [{}, "drive", 0],
      [{ OUTFITTER_ADMIN_CAPS: "agentEngine" }, "laptop", 0],
      [{ OUTFITTER_ADMIN_CAPS: "agentEngine" }, undefined, 0],
    ];
    for (const [env, kind, want] of cases) {
      const { pi, tools } = fakePi();
      register(pi, { env, transport: kind ? recorder([], kind).transport : undefined });
      // Count only agent_engine: the extension also registers `memory` (E9 PR3) for its own capability.
      assert.equal(tools.filter((t) => t.name === "agent_engine").length, want, JSON.stringify([env, kind]));
    }
  });

  test("a Drive whose tape has both capabilities gets both tools", () => {
    const { pi, tools } = fakePi();
    register(pi, { env: { OUTFITTER_ADMIN_CAPS: "memory,agentEngine" }, transport: recorder([], "drive").transport });
    assert.deepEqual(tools.map((t) => t.name).sort(), ["agent_engine", "memory"]);
  });

  test("registerAgentEngineTool takes the caller's transport", () => {
    const { pi, tools } = fakePi();
    registerAgentEngineTool(pi, recorder([]).transport);
    assert.deepEqual(tools.map((t) => t.name), ["agent_engine"]);
    assert.deepEqual(tools[0].promptGuidelines, PROMPT_GUIDELINES);
  });

  test("token budget: the definition stays under ~300 tokens (4 chars per token)", () => {
    const { pi, tools } = fakePi();
    registerAgentEngineTool(pi, recorder([]).transport);
    const t = tools[0];
    const chars = JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters, promptSnippet: t.promptSnippet, promptGuidelines: t.promptGuidelines }).length;
    assert.ok(chars / 4 <= 300, `~${Math.round(chars / 4)} tokens`);
    assert.ok(AGENT_ENGINE_TOOL.description.length <= 160);
  });
});

describe("toAgentEngineOp", () => {
  test("maps each action to its op with only the args it reads", () => {
    assert.deepEqual(toAgentEngineOp({ action: "list", agent: "x" }), { op: "ae.list", args: {} });
    assert.deepEqual(toAgentEngineOp({ action: "invoke", agent: " researcher ", message: "find papers", wait: "30", executionId: "e" }), {
      op: "ae.invoke",
      args: { agent: "researcher", message: "find papers", wait: 30 },
    });
    assert.deepEqual(toAgentEngineOp({ action: "get", executionId: "e1" }), { op: "ae.get", args: { executionId: "e1" } });
    assert.deepEqual(toAgentEngineOp({ action: "resume", executionId: "e1", decision: "approve", notes: "ok", agent: "x" }), {
      op: "ae.resume",
      args: { executionId: "e1", decision: "approve", notes: "ok" },
    });
  });

  test("says what is missing", () => {
    assert.match((toAgentEngineOp({ action: "nope" }) as any).error, /action must be one of: list, invoke, get, resume/);
    assert.match((toAgentEngineOp({ action: "invoke", agent: "a" }) as any).error, /needs agent and message/);
    assert.match((toAgentEngineOp({ action: "invoke", agent: "a", message: "m", wait: "soon" }) as any).error, /wait must be a number/);
    assert.match((toAgentEngineOp({ action: "get" }) as any).error, /needs executionId/);
    assert.match((toAgentEngineOp({ action: "resume", executionId: "e1" }) as any).error, /needs executionId and decision/);
  });
});

describe("runAgentEngineTool", () => {
  test("passes the API's text through; a declined resume says so; bad params never reach the API", async () => {
    const { transport, calls } = recorder([
      { ok: true, text: "status: completed\n[from Agent Engine agent a]\nhi\n[end of Agent Engine agent a]" },
      { ok: false, error: "the owner declined", needsApproval: true },
    ]);
    const ok = await runAgentEngineTool({ action: "invoke", agent: "a", message: "m" }, transport);
    assert.equal(ok.isError, undefined);
    assert.match(ok.content[0].text, /\[from Agent Engine agent a\]/);
    const declined = await runAgentEngineTool({ action: "resume", executionId: "e1", decision: "approve" }, transport);
    assert.deepEqual(declined, { content: [{ type: "text", text: "not approved: the owner declined" }], isError: true });
    const bad = await runAgentEngineTool({ action: "get" }, transport);
    assert.equal(bad.isError, true);
    assert.deepEqual(calls.map((c) => c.op), ["ae.invoke", "ae.resume"]);
  });
});
