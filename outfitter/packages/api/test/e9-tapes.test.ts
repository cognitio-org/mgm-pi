// E9 PR8 (#314, docs/specs/atlas-agent-engine-and-a2a.md §7-§8): the `foreman` and `a2a-coder` tape
// definitions in the outfitter-admin skill's reference are the exact `outfitter_tapes create` calls a
// Sysop session makes. Run each one through the real op, as an agent would, then the owner's editor
// step, and check the result against the spec.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryStore } from "../src/store/memory.ts";
import { runAdminOp, type AdminCaller } from "../src/admin/ops.ts";
import { hasAdminTools, tapeCapabilities, updateGuru } from "../src/gurus-service.ts";
import { a2aTapeProblem } from "../src/a2a/keys.ts";

const reference = readFileSync(new URL("../../../../kernal/skills/outfitter-admin/references/e9-tapes.md", import.meta.url), "utf8");
const calls = [...reference.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]) as { action: string; id: string; fields: Record<string, unknown> });
const caller: AdminCaller = { email: "ada@example.com", via: "token", operator: false };
const models = { list: async () => [] };
const human = { kind: "human", operator: false } as const;

/** The kernal tool's mapping (outfitter-admin/tools.ts toOp): `fields` spread, then the top-level id. */
async function create(store: MemoryStore, id: string) {
  const call = calls.find((c) => c.id === id);
  assert.ok(call, `the reference has a create call for ${id}`);
  assert.equal(call.action, "create");
  const res = await runAdminOp({ store, models }, caller, "tapes.create", { ...call.fields, id: call.id });
  assert.equal(res.ok, true, JSON.stringify(res));
  const tape = await store.gurus.findById(id);
  assert.ok(tape);
  return tape;
}

describe("E9 tape definitions (outfitter-admin references/e9-tapes.md)", () => {
  test("the reference holds exactly the two create calls", () => {
    assert.deepEqual(calls.map((c) => c.id).sort(), ["a2a-coder", "foreman"]);
  });

  test("foreman: the spec's model, thinking and tools; no edit, write, bash or subagents_enable", async () => {
    const store = new MemoryStore();
    const tape = await create(store, "foreman");
    assert.equal(tape.model, "litellm/claude-auto-llm");
    assert.equal(tape.thinking, "high");
    assert.deepEqual(tape.tools, ["read", "grep", "find", "ls", "subagent", "bg_wait", "subagent_supervisor", "git", "github_issue", "github_pr", "memory", "agent_engine"]);
    assert.match(tape.appendSystemPrompt ?? "", /never push, pull or fetch/);
    // Web-only fields: the agent's call can't set them; the owner does, in the editor.
    assert.deepEqual(tapeCapabilities(tape), []);
    const edited = await updateGuru(store, "foreman", { memory: "auto", agentEngine: true }, human);
    assert.equal(edited.ok, true);
    assert.deepEqual(edited.ok && tapeCapabilities(edited.guru), ["memory", "agentEngine"]);
  });

  test("a2a-coder: no subagent tools, nothing an A2A key refuses, memory tool only after the owner's edit", async () => {
    const store = new MemoryStore();
    const tape = await create(store, "a2a-coder");
    // PR5's A2A key rule as it stands (A2A_TAPE_TOOLS allowlist, no env or packages).
    assert.equal(a2aTapeProblem(tape), undefined, "an A2A key may list a2a-coder as created");
    for (const t of ["subagent", "bg_wait", "subagent_supervisor", "subagents_enable", "agent_engine"]) assert.ok(!tape.tools?.includes(t), t);
    assert.ok(tape.tools?.includes("memory") && tape.tools.includes("edit") && tape.tools.includes("bash"));
    const edited = await updateGuru(store, "a2a-coder", { memory: "tool" }, human);
    assert.equal(edited.ok, true);
    const g = edited.ok ? edited.guru : tape;
    // PR5's A2A key rule (#325): no admin tools, agentEngine, memory auto or mergeFromCloud.
    assert.equal(hasAdminTools(g), false);
    assert.notEqual(g.agentEngine, true);
    assert.equal(g.memory, "tool");
    assert.notEqual(g.mergeFromCloud, true);
    assert.deepEqual(tapeCapabilities(g), ["memory"]);
    assert.equal(a2aTapeProblem(g), undefined, "an A2A key may list a2a-coder after the owner's edit");
  });
});
