import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAppendSystemPrompt, renderGuru } from "../src/guru.js";
// Kernal's kernal/.pi/extensions/_shared/tape-args.ts, copied in at build time (prebuild).
import * as shared from "../src/tape-args.js";
import type { RunSpecGuru } from "../src/protocol.js";

const TAPES: RunSpecGuru[] = [
  { model: "litellm/local-qwen-mlx" },
  { model: "litellm/claude-sonnet-5", thinking: "off" },
  { model: "litellm/claude-sonnet-5:high", thinking: "low", systemPrompt: "S", appendSystemPrompt: "A" },
  { model: "litellm/x", tools: ["read", "bash"], excludeTools: ["write", "memory_read"], memory: "auto" },
  { model: "litellm/x", memory: "tool", env: { FOO: "1", PATH: "/evil", GIT_DIR: "/x", BAR: "2" }, allowExternalHtmlResources: true },
];

test("tape-args: the shared translation renders every tape exactly as renderGuru does after agentd's own prefix (#354)", () => {
  for (const tape of TAPES) {
    for (const appendSystemPromptFile of [undefined, "/w/.pi/APPEND_SYSTEM.md"]) {
      const { args, env } = renderGuru(tape, { piBin: "pi", sessionFile: "/s.jsonl", appendSystemPromptFile });
      // agentd's frame is `--mode rpc -a --session <file>` (no extension paths given here).
      const tail = shared.tapePiArgs(tape, { appendSystemPromptFile, appendSystemPrompt: renderAppendSystemPrompt(tape) });
      assert.deepEqual(args.slice(5), tail, JSON.stringify(tape));
      const { OUTFITTER_GURU_PACKAGES: _p, ...rest } = env;
      assert.deepEqual(rest, shared.tapeEnv(tape.env));
    }
  }
});

test("tape-args: no append text means no --append-system-prompt and no file (a laptop lets pi find APPEND_SYSTEM.md)", () => {
  assert.deepEqual(shared.tapePiArgs({ model: "m/x" }, { appendSystemPromptFile: "/f" }), ["--model", "m/x"]);
});

test("tape-args: tapeEnv drops the denylist and reports each key", () => {
  const dropped: string[] = [];
  assert.deepEqual(shared.tapeEnv({ A: "1", NODE_OPTIONS: "x", GIT_SSH: "y", OUTFITTER_TOKEN: "t" }, (k) => dropped.push(k)), { A: "1" });
  assert.deepEqual(dropped, ["NODE_OPTIONS", "GIT_SSH", "OUTFITTER_TOKEN"]);
});
