import { test } from "node:test";
import assert from "node:assert/strict";
import { renderGuru, renderModelArg } from "../src/guru.js";
import { EXTERNAL_HTML_PREVIEW_PROMPT, SEALED_HTML_PREVIEW_PROMPT } from "../src/html-preview-prompt.js";
import type { RunSpecGuru } from "../src/protocol.js";

test("renderModelArg: no thinking level returns the bare model", () => {
  assert.equal(renderModelArg("litellm/local-qwen-mlx"), "litellm/local-qwen-mlx");
});

test("renderModelArg: bug 5a -- 'off' is a real thinking level and is appended like any other, not silently dropped", () => {
  // Dropping it used to leave pi with no explicit level at all, so it fell back to its own startup
  // default (medium) instead of actually turning thinking off -- docs/reports/cloud-fixes.md.
  assert.equal(renderModelArg("litellm/local-qwen-mlx", "off"), "litellm/local-qwen-mlx:off");
});

test("renderModelArg: no thinking argument at all (guru.thinking unset) still renders the bare model", () => {
  assert.equal(renderModelArg("litellm/local-qwen-mlx", undefined), "litellm/local-qwen-mlx");
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
    "--append-system-prompt",
    SEALED_HTML_PREVIEW_PROMPT,
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
    `Always cite files.\n\n${SEALED_HTML_PREVIEW_PROMPT}`,
    "--tools",
    "read,grep,bash",
    "--exclude-tools",
    "write",
  ]);
});

function appendArgs(args: string[]): string[] {
  return args.filter((_, i) => args[i - 1] === "--append-system-prompt");
}

test("renderGuru: #132 -- no allowExternalHtmlResources appends the sealed HTML paragraph, once", () => {
  const { args } = renderGuru({ model: "m" }, { piBin: "pi", sessionFile: "/tmp/s.jsonl" });
  assert.deepEqual(appendArgs(args), [SEALED_HTML_PREVIEW_PROMPT]);
  const off = renderGuru({ model: "m", allowExternalHtmlResources: false }, { piBin: "pi", sessionFile: "/tmp/s.jsonl" });
  assert.deepEqual(appendArgs(off.args), [SEALED_HTML_PREVIEW_PROMPT]);
});

test("renderGuru: #132 -- allowExternalHtmlResources:true appends the external HTML paragraph instead", () => {
  const { args } = renderGuru(
    { model: "m", allowExternalHtmlResources: true },
    { piBin: "pi", sessionFile: "/tmp/s.jsonl" },
  );
  assert.deepEqual(appendArgs(args), [EXTERNAL_HTML_PREVIEW_PROMPT]);
});

test("renderGuru: #132 -- the guru's own append text stays in front of either paragraph, in one argument", () => {
  for (const [allow, paragraph] of [
    [false, SEALED_HTML_PREVIEW_PROMPT],
    [true, EXTERNAL_HTML_PREVIEW_PROMPT],
  ] as const) {
    const { args } = renderGuru(
      { model: "m", appendSystemPrompt: "Always cite files.", allowExternalHtmlResources: allow },
      { piBin: "pi", sessionFile: "/tmp/s.jsonl" },
    );
    assert.deepEqual(appendArgs(args), [`Always cite files.\n\n${paragraph}`]);
  }
});

test("renderGuru: #132 -- the paragraph never replaces --system-prompt", () => {
  const { args } = renderGuru(
    { model: "m", systemPrompt: "You are terse.", allowExternalHtmlResources: true },
    { piBin: "pi", sessionFile: "/tmp/s.jsonl" },
  );
  assert.equal(args[args.indexOf("--system-prompt") + 1], "You are terse.");
});

test("renderGuru: bug 5a -- thinking:'off' reaches pi as an explicit :off suffix", () => {
  const guru: RunSpecGuru = { model: "litellm/claude-sonnet-5", thinking: "off" };
  const { args } = renderGuru(guru, { piBin: "pi", sessionFile: "/tmp/s.jsonl" });
  assert.ok(args.includes("litellm/claude-sonnet-5:off"), args.join(" "));
});

test("renderGuru: bug 8 -- skipModelArg omits --model entirely (restore whose model/thinking already match)", () => {
  const guru: RunSpecGuru = { model: "litellm/claude-sonnet-5", thinking: "high" };
  const { args } = renderGuru(guru, { piBin: "pi", sessionFile: "/tmp/s.jsonl", skipModelArg: true });
  assert.ok(!args.includes("--model"), args.join(" "));
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
      OUTFITTER_TOKEN: "outf_not-a-real-dongle",
    },
  };
  const logged: string[] = [];
  const { env } = renderGuru(guru, { piBin: "pi", sessionFile: "/tmp/s.jsonl", onLog: (l) => logged.push(l) });
  assert.deepEqual(env, { SAFE: "ok" });
  assert.equal(logged.length, 11);
  assert.equal("OUTFITTER_TOKEN" in env, false);
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
    "--append-system-prompt",
    SEALED_HTML_PREVIEW_PROMPT,
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

test("renderGuru: browserExtensionPath renders its own --extension after mail", () => {
  const guru: RunSpecGuru = { model: "m/x" };
  const { args } = renderGuru(guru, {
    piBin: "pi",
    sessionFile: "/tmp/s.jsonl",
    spendExtensionPath: "/x/outfitter-spend.js",
    mailExtensionPath: "/x/outfitter-mail.js",
    browserExtensionPath: "/x/outfitter-browser.js",
  });
  assert.deepEqual(args.slice(5, 11), [
    "--extension",
    "/x/outfitter-spend.js",
    "--extension",
    "/x/outfitter-mail.js",
    "--extension",
    "/x/outfitter-browser.js",
  ]);
});
