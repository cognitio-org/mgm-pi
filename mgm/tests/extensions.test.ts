/** Drives the real extension entry points through a fake pi/ctx (see harness.ts). */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { makePi, makeCtx, tmpAgentDir, userMsg, asstCall, toolResult, type FakeModel } from "./harness.ts";

const qwen: FakeModel = { provider: "lmstudio", id: "qwen/qwen3.6-35b-a3b", contextWindow: 32_768, maxTokens: 8_192, cost: { input: 0, output: 0 } };
const nano: FakeModel = { provider: "litellm", id: "gpt-5.4-nano", contextWindow: 272_000, maxTokens: 64_000, cost: { input: 0.2, output: 1.25 } };
const haiku: FakeModel = { provider: "litellm", id: "claude-haiku-4-5", contextWindow: 200_000, maxTokens: 64_000, cost: { input: 1, output: 5 } };
const big = "x".repeat(20_000);   // ≈5k tokens per tool result
const branch = () => [userMsg("Refactor the auth module"), asstCall("read"), toolResult(big), asstCall("read"), toolResult(big), userMsg("now the tests"), asstCall("bash"), toolResult(big, "bash"), asstCall("edit"), toolResult("done", "edit")];
const prep = (entries: any[]) => ({ preparation: { tokensBefore: 20_000, firstKeptEntryId: entries.at(-1).id, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, fileOps: {}, settings: {} }, branchEntries: entries, reason: "threshold", willRetry: false, signal: new AbortController().signal });

describe("compaction extension", async () => {
  const mod = await import("../.pi/extensions/compaction/index.ts");
  let pi: ReturnType<typeof makePi>; let store: ReturnType<typeof tmpAgentDir>;
  beforeEach(() => { delete process.env.MGM_SUMMARY_MODEL; store = tmpAgentDir(); pi = makePi(); mod.default(pi as any); });

  test("registers the hooks and commands", () => {
    for (const ev of ["context", "session_before_compact", "session_compact", "session_compact_failed", "agent_end", "turn_end", "model_select", "session_start"]) assert.ok(pi.handlers.has(ev), ev);
    assert.deepEqual([...pi.commands.keys()].sort(), ["compaction", "pin"]);
  });

  test("context hook masks old tool results per the detected profile, and honours masking=off", async () => {
    const ctx = makeCtx({ model: qwen, entries: branch() });
    const messages = branch().map((e) => e.message);
    const r = await pi.emit("context", { messages: structuredClone(messages) }, ctx);
    const masked = r.messages.filter((m: any) => m.role === "toolResult" && m.content[0].text.includes("elided"));
    assert.equal(masked.length, 2, "32k + code profile keeps the newest 2 results (bash, edit) and masks the two older reads");
    store = tmpAgentDir({ mgm: { compaction: { masking: false } } });
    const off = await pi.emit("context", { messages: structuredClone(messages) }, ctx);
    assert.equal(off, undefined, "masking off: hook returns nothing, pi keeps the messages as they are");
  });

  test("session_before_compact folds history with the configured summarizer and pins the original request", async () => {
    const entries = branch();
    const ctx = makeCtx({ model: qwen, models: [qwen, nano, haiku], entries });
    const r = await pi.emit("session_before_compact", prep(entries), ctx);
    assert.ok(r?.compaction, "returned a compaction");
    assert.ok(r.compaction.summary.startsWith("<pinned-context>\n[original request]\nRefactor the auth module"));
    assert.ok(r.compaction.summary.endsWith("## Goal\nsummary"));
    assert.equal(r.compaction.details.summarizer, "litellm/gpt-5.4-nano", "default summarizer");
    assert.equal(r.compaction.details.profile, "code");
    assert.ok(r.compaction.details.chunks >= 1);
    assert.equal(ctx.completes[0].model.id, "gpt-5.4-nano");
    assert.ok(ctx.completes[0].c.messages[0].content[0].text.includes("This is software work"), "profile focus reaches the prompt");
    assert.ok(r.compaction.usage.cost.total > 0, "usage aggregated");
    assert.ok(entries.some((e) => e.id === r.compaction.firstKeptEntryId));
  });

  test("falls back to the working model when the summarizer has no credentials, and to pi on errors", async () => {
    const entries = branch();
    const noAuth = makeCtx({ model: qwen, models: [qwen, nano], entries, auth: (m) => m.provider !== "litellm" });
    assert.equal((await pi.emit("session_before_compact", prep(entries), noAuth)).compaction.details.summarizer, "lmstudio/qwen/qwen3.6-35b-a3b");
    const failing = makeCtx({ model: qwen, models: [qwen, nano], entries, complete: async () => ({ stopReason: "error", errorMessage: "boom", content: [] }) });
    assert.equal(await pi.emit("session_before_compact", prep(entries), failing), undefined, "undefined lets pi run its default compaction");
    assert.ok(failing.notices.some((n) => n.type === "warning" && n.msg.includes("boom")));
  });

  test("retries once with a shorten prompt when the summary is cut off", async () => {
    const entries = branch(); let calls = 0;
    const ctx = makeCtx({ model: qwen, models: [qwen, nano], entries, complete: async () => (++calls === 1 ? { stopReason: "length", content: [{ type: "text", text: "## Goal\npartial" }] } : { stopReason: "stop", content: [{ type: "text", text: "## Goal\nshort" }] }) });
    const r = await pi.emit("session_before_compact", prep(entries), ctx);
    assert.equal(ctx.completes.length, 2);
    assert.ok(ctx.completes[1].c.messages[0].content[0].text.includes("cut off"));
    assert.ok(r.compaction.summary.endsWith("## Goal\nshort"));
  });

  test("proactive trigger fires at the profile threshold and backs off after 'nothing to compact'", async () => {
    const at = (percent: number) => makeCtx({ model: qwen, entries: branch(), usage: { tokens: 1, contextWindow: 32_768, percent } });
    let ctx = at(50); await pi.emit("agent_end", {}, ctx); assert.equal(ctx.compactCalls.length, 0);
    ctx = at(65); await pi.emit("agent_end", {}, ctx); assert.equal(ctx.compactCalls.length, 1, "60% threshold on a 32k window");
    ctx.compactCalls[0].onError(new Error("Compaction failed: Nothing to compact (session too small)"));
    ctx = at(70); await pi.emit("agent_end", {}, ctx); assert.equal(ctx.compactCalls.length, 0, "backed off until +10 points");
    ctx = at(76); await pi.emit("agent_end", {}, ctx); assert.equal(ctx.compactCalls.length, 1);
    await pi.emit("session_compact", { compactionEntry: { summary: "s", tokensBefore: 1, details: {} }, fromExtension: true }, ctx);
    ctx = at(65); await pi.emit("agent_end", {}, ctx); assert.equal(ctx.compactCalls.length, 1, "back-off cleared by a compaction");
  });

  test("/compaction model persists, validates, resets and respects the env override", async () => {
    const ctx = makeCtx({ model: qwen, models: [qwen, nano, haiku], auth: (m) => m.id !== "claude-haiku-4-5" });
    const cmd = pi.commands.get("compaction")!;
    await cmd.handler("model litellm/gpt-5.4-nano", ctx);
    assert.equal(store.read().mgm.compaction.summaryModel, "litellm/gpt-5.4-nano");
    await cmd.handler("model litellm/claude-haiku-4-5", ctx);
    assert.ok(ctx.notices.some((n) => n.type === "warning" && n.msg.includes("no credentials")));
    await cmd.handler("model nope/x", ctx);
    assert.ok(ctx.notices.some((n) => n.type === "error" && n.msg.includes("Unknown model")));
    await cmd.handler("model default", ctx);
    assert.equal(store.read().mgm.compaction.summaryModel, undefined);
    process.env.MGM_SUMMARY_MODEL = "litellm/claude-haiku-4-5";
    await cmd.handler("model", ctx);
    assert.ok(ctx.notices.at(-1)!.msg.includes("from MGM_SUMMARY_MODEL"));
    await pi.emit("session_start", {}, ctx);
    assert.deepEqual(cmd.getArgumentCompletions!("model litellm/g").map((c: any) => c.label), ["litellm/gpt-5.4-nano"]);
  });

  test("dialog: pick a summarizer, pin a profile, toggle masking, set the trigger, reset, compact", async () => {
    const ctx = makeCtx({ model: qwen, models: [qwen, nano, haiku] });
    const cmd = pi.commands.get("compaction")!;
    ctx.answers.push("Summarizer", "litellm/gpt-5.4-nano", "Close");
    await cmd.handler("", ctx);
    assert.equal(store.read().mgm.compaction.summaryModel, "litellm/gpt-5.4-nano");
    ctx.answers.push("Profile", "research", "Masking", "Trigger", "45", "Close");
    await cmd.handler("", ctx);
    assert.deepEqual(store.read().mgm.compaction, { summaryModel: "litellm/gpt-5.4-nano", profile: "research", masking: false, triggerPercent: 45 });
    ctx.answers.push("Reset to defaults", "Close");
    await cmd.handler("", ctx);
    assert.deepEqual(store.read().mgm.compaction, {});
    ctx.answers.push("Compact now");
    await cmd.handler("", ctx);
    assert.equal(ctx.compactCalls.length, 1);
  });

  test("dialog shows the effective values and the detected profile", async () => {
    const ctx = makeCtx({ model: qwen, models: [qwen, nano], entries: branch(), usage: { tokens: 10_000, contextWindow: 32_768, percent: 30.5 } });
    let seen: string[] = [];
    ctx.ui.select = async (_t: string, options: string[]) => { seen = options; return "Close"; };
    await pi.commands.get("compaction")!.handler("", ctx);
    assert.ok(seen.some((o) => o.startsWith("Profile: auto → code (4 code / 0 research calls)")), seen.join("\n"));
    assert.ok(seen.some((o) => o.includes("keep newest 2 tool results, mask > 1500 chars")));
    assert.ok(seen.some((o) => o.includes("compact at 60% of 33k") && o.includes("now 31%")));
  });

  test("/pin appends the last user message or the given text", async () => {
    const ctx = makeCtx({ model: qwen, entries: branch() });
    await pi.commands.get("pin")!.handler("", ctx);
    assert.deepEqual(pi.entries.at(-1), { type: "custom", customType: "mgm-pin", data: { text: "now the tests" } });
    await pi.commands.get("pin")!.handler("API base is https://x", ctx);
    assert.equal(pi.entries.at(-1).data.text, "API base is https://x");
  });

  test("non-UI /compaction prints a one-line status", async () => {
    const ctx = makeCtx({ model: qwen, hasUI: false });
    await pi.commands.get("compaction")!.handler("", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /summarizer litellm\/gpt-5\.4-nano; profile chat; keep 1 results; trigger 60%/);
  });
});

describe("connect extension", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mgm-home-"));
  process.env.HOME = tmp; process.chdir(tmp);           // no real ~/localllm/.env in reach
  process.env.MGM_NO_DISCOVERY = "1"; process.env.LITELLM_AGENT_KEY = "sk-test"; delete process.env.OPENROUTER_API_KEY; delete process.env.LITELLM_API_KEY;
  const mod = await import("../.pi/extensions/connect/index.ts");
  let pi: ReturnType<typeof makePi>; let store: ReturnType<typeof tmpAgentDir>;
  beforeEach(async () => { store = tmpAgentDir(); pi = makePi(); await mod.default(pi as any); });
  const modelsOf = (name: string) => pi.providers.find((p) => p.name === name)!.config.models;
  const ctxWith = (extra: any = {}) => makeCtx({ models: pi.providers.flatMap((p) => p.config.models.map((m: any) => ({ ...m, provider: p.name }))), ...extra });

  test("registers three providers with fallback models and the agent key", () => {
    assert.deepEqual(pi.providers.map((p) => p.name).sort(), ["litellm", "lmstudio", "openrouter"]);
    assert.equal(pi.providers.find((p) => p.name === "litellm")!.config.apiKey, "sk-test");
    assert.equal(pi.providers.find((p) => p.name === "openrouter")!.config.apiKey, "", "no OpenRouter key set");
    assert.equal(modelsOf("lmstudio")[0].thinkingLevelMap.off, "none");
    assert.equal(modelsOf("litellm").find((m: any) => m.id === "local-qwen-mlx").thinkingLevelMap.off, "none");
    assert.equal(modelsOf("litellm").find((m: any) => m.id === "claude-sonnet-5").thinkingLevelMap.off, undefined);
  });

  test("/connect switches the model and saves it as the default; validates backend and key", async () => {
    const ctx = ctxWith();
    const cmd = pi.commands.get("connect")!;
    await cmd.handler("litellm claude-sonnet-5", ctx);
    assert.equal(pi.setModelCalls.at(-1).id, "claude-sonnet-5");
    assert.deepEqual([store.read().defaultProvider, store.read().defaultModel], ["litellm", "claude-sonnet-5"]);
    await cmd.handler("nope", ctx);
    assert.ok(ctx.notices.at(-1)!.msg.startsWith('Unknown backend "nope"'));
    await cmd.handler("openrouter anthropic/claude-sonnet-5", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /set OPENROUTER_API_KEY/);
    ctx.answers.push("LM Studio");
    await cmd.handler("", ctx);
    assert.equal(pi.setModelCalls.at(-1).provider, "lmstudio", "interactive pick; single model needs no second prompt");
    assert.deepEqual(cmd.getArgumentCompletions!("lite").map((c: any) => c.value), ["litellm"]);
  });

  test("LiteLLM response headers drive the budget status; /budget without UI prints numbers", async () => {
    const litellmModel = { provider: "litellm", id: "claude-sonnet-5", contextWindow: 1_000_000, maxTokens: 64_000 };
    const ctx = ctxWith({ model: litellmModel, entries: [{ type: "message", message: { role: "assistant", provider: "litellm", usage: { cost: { total: 0.076 } } } }], hasUI: false });
    await pi.emit("after_provider_response", { status: 200, headers: { "x-litellm-call-id": "1", "X-LiteLLM-Key-Spend": "0.84", "x-litellm-key-max-budget": "1000" } }, ctx);
    assert.equal(ctx.statuses.get("budget"), "◆ $0.08 · key $0.84/$1000.00 (0.1%)");
    await pi.emit("after_provider_response", { status: 200, headers: { "content-type": "text/plain" } }, ctx);
    assert.equal(ctx.statuses.get("budget"), "◆ $0.08 · key $0.84/$1000.00 (0.1%)", "non-LiteLLM responses ignored");
    await pi.commands.get("budget")!.handler("", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /session est \$0\.08; key \$0\.84\/\$1000\.00/);
    const local = ctxWith({ model: { provider: "lmstudio", id: "qwen/qwen3.6-35b-a3b", contextWindow: 131_072, maxTokens: 8_192 } });
    await pi.emit("model_select", { model: local.model }, local);
    assert.equal(local.statuses.get("budget"), undefined, "no budget status off LiteLLM");
    assert.equal(local.statuses.get("connect"), "⇄ lmstudio/qwen/qwen3.6-35b-a3b");
  });

  test("/setup writes .env next to the agent dir and re-registers providers with the new keys", async () => {
    const ctx = ctxWith();
    // name, local server yes, unreachable URL (→ typed model id), litellm url, litellm key, openrouter key
    ctx.answers.push("Matej", "Yes, configure it", "http://127.0.0.1:9/v1", "my-local-model", "https://litellm.augment-code.support/v1", "sk-new-key", "sk-or-new");
    await pi.commands.get("setup")!.handler("", ctx);
    const env = store.env();
    for (const line of ["MGM_USER=Matej", "LMSTUDIO_BASE_URL=http://127.0.0.1:9/v1", "LMSTUDIO_MODEL=my-local-model", "LITELLM_AGENT_KEY=sk-new-key", "OPENROUTER_API_KEY=sk-or-new"]) assert.ok(env.includes(line + "\n"), line);
    assert.ok(ctx.notices.some((n) => n.type === "warning" && n.msg.includes("Could not reach")));
    assert.match(ctx.notices.at(-1)!.msg, /Connections ready: lmstudio, litellm, openrouter/);
    const litellm = pi.providers.filter((p) => p.name === "litellm").at(-1)!;
    assert.equal(litellm.config.apiKey, "sk-new-key", "providers re-registered live");
    assert.equal(pi.providers.filter((p) => p.name === "lmstudio").at(-1)!.config.models[0].id, "my-local-model");
    // second run keeps existing keys when left blank and updates only the name
    ctx.answers.push("Matej Monteleone", "No local model on this machine", "https://litellm.augment-code.support/v1", "", "");
    await pi.commands.get("setup")!.handler("", ctx);
    const env2 = store.env();
    assert.ok(env2.includes("MGM_USER=Matej Monteleone\n") && env2.includes("LITELLM_AGENT_KEY=sk-new-key\n") && env2.includes("OPENROUTER_API_KEY=sk-or-new\n"));
    assert.equal((env2.match(/^MGM_USER=/gm) ?? []).length, 1, "keys are updated in place, not duplicated");
    process.env.LITELLM_AGENT_KEY = "sk-test"; delete process.env.OPENROUTER_API_KEY; delete process.env.MGM_USER; delete process.env.LMSTUDIO_MODEL; delete process.env.LMSTUDIO_BASE_URL;
  });

  test("non-UI /setup points at the env file", async () => {
    const ctx = ctxWith({ hasUI: false });
    await pi.commands.get("setup")!.handler("", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /Edit .*\.env/);
  });
});

describe("mgm banner extension", async () => {
  const mod = await import("../.pi/extensions/mgm-banner/index.ts");
  test("detects the user, installs an animated width-safe header, and can restore the built-in one", async () => {
    process.env.MGM_USER = "matej";
    assert.deepEqual([mod.detectIdentity().letters, mod.detectIdentity().known], ["MATEK", true]);
    const pi = makePi(); mod.default(pi as any);
    const ctx = makeCtx({ model: { provider: "litellm", id: "claude-sonnet-5", contextWindow: 1, maxTokens: 1 } });
    await pi.emit("session_start", {}, ctx);
    assert.ok(ctx.header, "header factory installed");
    const ESC = String.fromCharCode(27);
    const theme = { fg: (_c: string, t: string) => `${ESC}[1m${t}${ESC}[0m` };
    let renders = 0; const tui = { requestRender: () => { renders++; } };
    const comp = ctx.header(tui, theme);
    const first = comp.render(120);
    assert.ok(!first.join("").includes("█"), "frame 0 of the entrance animation shows no letters yet");
    await new Promise((r) => setTimeout(r, 45 * 30));
    assert.ok(renders >= 25, `animation requested re-renders (${renders})`);
    const done = comp.render(120);
    assert.ok(done.some((l: string) => l.includes("welcome back, Matej")) && done.join("").includes("█"));
    for (const width of [40, 47, 80, 140]) for (const l of comp.render(width)) assert.ok(visibleWidth(l) <= width, `width ${width}`);
    comp.dispose?.();
    await pi.commands.get("builtin-header")!.handler("", ctx);
    assert.equal(ctx.header, undefined);
  });
  test("MGM_NO_ANIMATION renders the finished banner immediately", async () => {
    process.env.MGM_NO_ANIMATION = "1"; process.env.MGM_USER = "mgm";
    const pi = makePi(); mod.default(pi as any);
    const ctx = makeCtx({}); await pi.emit("session_start", {}, ctx);
    assert.ok(ctx.header({ requestRender() {} }, { fg: (_c: string, t: string) => t }).render(120).join("").includes("█"));
    delete process.env.MGM_NO_ANIMATION;
  });
});
