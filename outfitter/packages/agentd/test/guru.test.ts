import { test } from "node:test";
import assert from "node:assert/strict";
import { renderGuru, renderModelArg } from "../src/guru.js";
import type { RunSpecGuru } from "../src/protocol.js";

test("renderModelArg: no thinking level returns the bare model", () => {
  assert.equal(renderModelArg("litellm/local-qwen-mlx"), "litellm/local-qwen-mlx");
});

test("renderModelArg: 'off' thinking level is not appended", () => {
  assert.equal(renderModelArg("litellm/local-qwen-mlx", "off"), "litellm/local-qwen-mlx");
});

test("renderModelArg: appends :<thinking>", () => {
  assert.equal(renderModelArg("litellm/claude-sonnet-5", "high"), "litellm/claude-sonnet-5:high");
});

test("renderModelArg: does not double-suffix an already-scoped model", () => {
  assert.equal(renderModelArg("litellm/claude-sonnet-5:high", "low"), "litellm/claude-sonnet-5:high");
});

test("renderGuru: minimal guru produces the fixed rpc/-a/session prefix plus --model", () => {
  const guru: RunSpecGuru = { model: "litellm/local-qwen-mlx" };
  const { args, env } = renderGuru(guru, { piBin: "/opt/kernal/node_modules/.bin/pi", sessionFile: "/tmp/s.jsonl" });
  assert.deepEqual(args, [
    "--mode",
    "rpc",
    "-a",
    "--session",
    "/tmp/s.jsonl",
    "--model",
    "litellm/local-qwen-mlx",
  ]);
  assert.deepEqual(env, {});
});

test("renderGuru: system prompts, tools, and thinking level all render", () => {
  const guru: RunSpecGuru = {
    model: "litellm/claude-sonnet-5",
    thinking: "high",
    systemPrompt: "You are terse.",
    appendSystemPrompt: "Always cite files.",
    tools: ["read", "grep", "bash"],
    excludeTools: ["write"],
  };
  const { args } = renderGuru(guru, { piBin: "pi", sessionFile: "/tmp/s.jsonl" });
  assert.deepEqual(args, [
    "--mode",
    "rpc",
    "-a",
    "--session",
    "/tmp/s.jsonl",
    "--model",
    "litellm/claude-sonnet-5:high",
    "--system-prompt",
    "You are terse.",
    "--append-system-prompt",
    "Always cite files.",
    "--tools",
    "read,grep,bash",
    "--exclude-tools",
    "write",
  ]);
});

test("renderGuru: env passthrough plus packages -> OUTFITTER_GURU_PACKAGES", () => {
  const guru: RunSpecGuru = {
    model: "litellm/local-qwen-mlx",
    env: { FOO: "bar" },
    packages: ["npm:pi-memory", "npm:pi-lsp"],
  };
  const { env } = renderGuru(guru, { piBin: "pi", sessionFile: "/tmp/s.jsonl" });
  assert.deepEqual(env, { FOO: "bar", OUTFITTER_GURU_PACKAGES: "npm:pi-memory,npm:pi-lsp" });
});

test("renderGuru: drops denylisted guru.env keys (NODE_OPTIONS, LD_PRELOAD, PATH, GIT_*, HOME, LITELLM_*) and logs each", () => {
  const guru: RunSpecGuru = {
    model: "litellm/local-qwen-mlx",
    env: {
      SAFE: "ok",
      NODE_OPTIONS: "--require=evil.js",
      LD_PRELOAD: "/tmp/evil.so",
      LD_LIBRARY_PATH: "/tmp",
      PATH: "/tmp/evil:/usr/bin",
      HOME: "/tmp/fake-home",
      GIT_CONFIG_COUNT: "1",
      GIT_SSH_COMMAND: "evil",
      LITELLM_BASE_URL: "https://attacker.example",
      LITELLM_API_KEY: "sk-attacker",
      LITELLM_AGENT_KEY: "sk-attacker",
    },
  };
  const logged: string[] = [];
  const { env } = renderGuru(guru, { piBin: "pi", sessionFile: "/tmp/s.jsonl", onLog: (l) => logged.push(l) });
  assert.deepEqual(env, { SAFE: "ok" });
  assert.equal(logged.length, 10);
});

test("renderGuru: spendExtensionPath renders --extension right after the fixed rpc/-a/session prefix", () => {
  const guru: RunSpecGuru = { model: "litellm/local-qwen-mlx" };
  const { args } = renderGuru(guru, {
    piBin: "pi",
    sessionFile: "/tmp/s.jsonl",
    spendExtensionPath: "/opt/outfitter/agentd/pi-extension/outfitter-spend.js",
  });
  assert.deepEqual(args, [
    "--mode",
    "rpc",
    "-a",
    "--session",
    "/tmp/s.jsonl",
    "--extension",
    "/opt/outfitter/agentd/pi-extension/outfitter-spend.js",
    "--model",
    "litellm/local-qwen-mlx",
  ]);
});

test("renderGuru: no spendExtensionPath means no --extension flag (interactive/local pi runs unaffected)", () => {
  const guru: RunSpecGuru = { model: "litellm/local-qwen-mlx" };
  const { args } = renderGuru(guru, { piBin: "pi", sessionFile: "/tmp/s.jsonl" });
  assert.ok(!args.includes("--extension"));
});

test("renderGuru: empty tools/excludeTools arrays render no flags", () => {
  const guru: RunSpecGuru = { model: "m", tools: [], excludeTools: [] };
  const { args } = renderGuru(guru, { piBin: "pi", sessionFile: "/tmp/s.jsonl" });
  assert.ok(!args.includes("--tools"));
  assert.ok(!args.includes("--exclude-tools"));
});

test("renderGuru: mailExtensionPath renders its own --extension after the spend one", () => {
  const guru: RunSpecGuru = { model: "m/x" };
  const { args } = renderGuru(guru, {
    piBin: "pi",
    sessionFile: "/tmp/s.jsonl",
    spendExtensionPath: "/x/outfitter-spend.js",
    mailExtensionPath: "/x/outfitter-mail.js",
  });
  assert.deepEqual(args.slice(5, 9), ["--extension", "/x/outfitter-spend.js", "--extension", "/x/outfitter-mail.js"]);
});
