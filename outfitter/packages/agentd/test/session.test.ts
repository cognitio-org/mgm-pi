// Bug 8 (docs/reports/cloud-fixes.md): duplicate model_change/thinking_level_change entries on
// each restore. lastKnownModelState is the pure scan run.ts uses to decide whether to skip
// re-passing --model to pi on a restore (see session.ts's doc comment for the full root cause).
import { test } from "node:test";
import assert from "node:assert/strict";
import { lastKnownModelState } from "../src/session.js";

function jsonl(...lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

test("lastKnownModelState: no entries at all (brand-new/empty session) -> both undefined", () => {
  const header = { type: "session", version: 3, id: "s1", timestamp: "t", cwd: "/workspace" };
  assert.deepEqual(lastKnownModelState(jsonl(header)), {});
});

test("lastKnownModelState: picks up a model_change entry", () => {
  const lines = [
    { type: "session", version: 3, id: "s1" },
    { type: "model_change", id: "e1", provider: "litellm", modelId: "claude-sonnet-5" },
  ];
  assert.deepEqual(lastKnownModelState(jsonl(...lines)), { model: "litellm/claude-sonnet-5" });
});

test("lastKnownModelState: picks up a thinking_level_change entry independently of model_change", () => {
  const lines = [
    { type: "session", version: 3, id: "s1" },
    { type: "thinking_level_change", id: "e1", thinkingLevel: "off" },
  ];
  assert.deepEqual(lastKnownModelState(jsonl(...lines)), { thinking: "off" });
});

test("lastKnownModelState: uses the LAST of each type when there are several", () => {
  const lines = [
    { type: "session", version: 3, id: "s1" },
    { type: "model_change", id: "e1", provider: "litellm", modelId: "gpt-4o" },
    { type: "thinking_level_change", id: "e2", thinkingLevel: "low" },
    { type: "message", id: "e3" },
    { type: "model_change", id: "e4", provider: "litellm", modelId: "claude-sonnet-5" },
    { type: "thinking_level_change", id: "e5", thinkingLevel: "high" },
  ];
  assert.deepEqual(lastKnownModelState(jsonl(...lines)), { model: "litellm/claude-sonnet-5", thinking: "high" });
});

test("lastKnownModelState: malformed lines are skipped, not thrown", () => {
  const text = `${JSON.stringify({ type: "session", version: 3, id: "s1" })}\nnot json at all\n${JSON.stringify({ type: "model_change", id: "e1", provider: "a", modelId: "b" })}\n`;
  assert.deepEqual(lastKnownModelState(text), { model: "a/b" });
});
