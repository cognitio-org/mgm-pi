/**
 * Sentry's #424 signals on a laptop: AI agent monitoring (gen_ai spans), their content (prompts,
 * outputs, tool arguments and results) and counters. Gating (config.ts), redaction and truncation
 * (agent.ts, _shared/redact.ts), attribute names, and the wiring to pi's events through the real
 * entry point with a fake pi and a fake Sentry client (no network, no real @sentry/node init).
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_SIGNALS, decide, describe as describeDecision, fleetFromConfig, signalOptOuts } from "../.pi/extensions/sentry/config.ts";
import { liveSignals, scrubMetric, stripAgentContent, _resetSentryState, type SentryLike, type SentrySpan } from "../.pi/extensions/sentry/client.ts";
import { ContentBudget, FIELD_LIMIT_BYTES, METRICS, chatSpanEnd, cleanText, cleanValue, messagesJson, toolArgsContent, toolResultContent, truncateUtf8 } from "../.pi/extensions/sentry/agent.ts";
import { redact } from "../.pi/extensions/_shared/redact.ts";
import { parseFleetSettings, type FleetSettings } from "../.pi/extensions/_shared/fleet-settings.ts";
import { KNOWN_SETTINGS } from "../.pi/extensions/_shared/central-config.ts";
import sentryExtension from "../.pi/extensions/sentry/index.ts";
import { makePi } from "./harness.ts";

const DSN = "https://publicKey@o0.ingest.us.sentry.io/1";
const API = "https://link.outfitter.test";
const CREDS = { api: API, token: "outf_dongle" };
const ON: FleetSettings = { telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.05 } } };
const OFF: FleetSettings = { telemetry: { sentry: { enabled: false } } };
const ALL: FleetSettings = { telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 1, agentTraces: true, agentContent: true, metrics: true } } };
const TRACES: FleetSettings = { telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 1, agentTraces: true } } };
const cv = (value: string | number | boolean, source: string, sourceName?: string) => ({ value, source, ...(sourceName ? { sourceName } : {}), override: "opt-out", locked: false }) as any;

function fakeSentry(sampled = true) {
  const spans: { name: string; op: string; attributes: any; parent?: string; status?: "ok" | "error"; ended: boolean }[] = [];
  const counts: { name: string; value: number; attributes?: Record<string, string> }[] = [];
  let flushes = 0;
  const sentry: SentryLike = {
    init() {},
    captureException() { return "event-id"; },
    captureCrash() {},
    count(name, value, attributes) { counts.push({ name, value, ...(attributes ? { attributes } : {}) }); },
    async flush() { flushes++; return true; },
    startInactiveSpan(options) {
      const rec = { name: options.name, op: options.op, attributes: { ...options.attributes }, parent: (options.parent?.raw as any)?.name, status: undefined as "ok" | "error" | undefined, ended: false };
      spans.push(rec);
      const span: SentrySpan = { setStatus: (o) => { rec.status = o; }, setAttributes: (a) => { Object.assign(rec.attributes, a); }, end: () => { rec.ended = true; }, sampled, raw: rec };
      return span;
    },
  };
  return { sentry, spans, counts, flushes: () => flushes };
}

describe("signals: off by default, the fleet turns each on, the laptop turns each off", () => {
  test("every signal is off by default, and all stay off whenever Sentry itself is off", () => {
    assert.deepEqual((decide(ON, { optedOut: false, hasDongle: true }) as any).signals, NO_SIGNALS);
    const offWithSignals = parseFleetSettings({ telemetry: { sentry: { enabled: false, dsn: DSN, agentTraces: true, agentContent: true, metrics: true } } });
    assert.deepEqual(decide(offWithSignals, { optedOut: false, hasDongle: true }), { on: false, why: "fleet" });
    assert.deepEqual(decide(ALL, { optedOut: true, hasDongle: true }), { on: false, why: "laptop" });
    assert.deepEqual(decide(ALL, { optedOut: false, hasDongle: false }), { on: false, why: "no-dongle" });
  });

  test("the fleet turns each on; content needs agent traces", () => {
    assert.deepEqual((decide(ALL, { optedOut: false, hasDongle: true }) as any).signals, { agentTraces: true, agentContent: true, metrics: true });
    const contentOnly = parseFleetSettings({ telemetry: { sentry: { enabled: true, dsn: DSN, agentContent: true } } });
    assert.deepEqual((decide(contentOnly, { optedOut: false, hasDongle: true }) as any).signals, NO_SIGNALS);
  });

  test("a laptop opt-out wins for each signal", () => {
    const sig = (off: Partial<typeof NO_SIGNALS>) => (decide(ALL, { optedOut: false, hasDongle: true, signalsOff: { ...NO_SIGNALS, ...off } }) as any).signals;
    assert.deepEqual(sig({ agentTraces: true }), { agentTraces: false, agentContent: false, metrics: true });
    assert.deepEqual(sig({ agentContent: true }), { agentTraces: true, agentContent: false, metrics: true });
    assert.deepEqual(sig({ metrics: true }), { agentTraces: true, agentContent: true, metrics: false });
  });

  test("parseFleetSettings keeps a signal only for an exact true (and a rate above 0)", () => {
    const s = parseFleetSettings({ telemetry: { sentry: { enabled: true, dsn: DSN, agentTraces: "yes", metrics: 1, logs: true, profilesSampleRate: 0.2 } } }).telemetry.sentry as any;
    assert.equal(s.agentTraces, undefined);
    assert.equal(s.metrics, undefined);
    assert.equal(s.logs, true);
    assert.equal(s.profilesSampleRate, 0.2);
    assert.deepEqual(parseFleetSettings({ telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.05, profilesSampleRate: 0 } } }), ON);
  });

  test("signalOptOuts: settings.json flags and this machine's config layer, never Outfitter's false", () => {
    assert.deepEqual(signalOptOuts({ kernal: { sentryAgentTraces: false, sentryMetrics: true } }), { agentTraces: true, agentContent: false, metrics: false });
    assert.deepEqual(signalOptOuts({}, { "telemetry.sentry.agentContent": cv(false, "local") }), { agentTraces: false, agentContent: true, metrics: false });
    assert.deepEqual(signalOptOuts({}, { "telemetry.sentry.metrics": cv(false, "fleet"), "telemetry.sentry.agentTraces": cv(false, "default") }), NO_SIGNALS);
    assert.deepEqual(signalOptOuts({}, { "telemetry.sentry.metrics": cv(false, "local", "settings.json") }), NO_SIGNALS, "an earlier resolution's copy of a cleared flag");
  });

  test("signed in: only Outfitter's values turn a signal on, never a local true", () => {
    const base = { "telemetry.sentry.enabled": cv(true, "fleet"), "telemetry.sentry.dsn": cv(DSN, "fleet"), "telemetry.sentry.tracesSampleRate": cv(0.1, "fleet") };
    const fleet = fleetFromConfig({ ...base, "telemetry.sentry.agentTraces": cv(true, "fleet"), "telemetry.sentry.metrics": cv(true, "env", "X") });
    assert.equal((fleet.telemetry.sentry as any).agentTraces, true);
    assert.equal((fleet.telemetry.sentry as any).metrics, undefined);
  });

  test("the five keys are known to /config: off by default, opt-out where a laptop may turn one off", () => {
    const decl = (k: string) => KNOWN_SETTINGS.find((d) => d.key === k)!;
    for (const k of ["agentTraces", "agentContent", "metrics", "logs"]) {
      assert.equal(decl(`telemetry.sentry.${k}`).default, false, k);
      assert.equal(decl(`telemetry.sentry.${k}`).override, "opt-out", k);
    }
    assert.equal(decl("telemetry.sentry.profilesSampleRate").default, 0);
    assert.deepEqual(decl("telemetry.sentry.profilesSampleRate").levels, ["fleet"]);
  });

  test("/sentry status says who decided each signal, and that logs and profiles never run here", () => {
    const off = { ...NO_SIGNALS, metrics: true };
    const text = describeDecision(decide(ALL, { optedOut: false, hasDongle: true, signalsOff: off }), "sending", { fleet: ALL, signalsOff: off });
    assert.match(text, /Agent monitoring.*: on, set by Outfitter\. \/sentry agent off/);
    assert.match(text, /Prompts and outputs.*: on, set by Outfitter\. \/sentry content off/);
    assert.match(text, /Metrics: off on this laptop/);
    assert.match(text, /Never from Kernal.*logs.*profiles/);
    const plain = describeDecision(decide(ON, { optedOut: false, hasDongle: true }), "sending", { fleet: ON, signalsOff: NO_SIGNALS });
    assert.match(plain, /Agent monitoring.*off \(Outfitter has it off\)/);
    assert.match(plain, /Prompts and outputs.*off \(needs agent monitoring\)/);
  });
});

describe("content: redacted, truncated, never the system prompt", () => {
  test("redact knows Outfitter's device tokens and more provider keys", () => {
    for (const secret of ["kda_" + "A".repeat(43), "kdr_" + "b-".repeat(20), "kdc_" + "C9".repeat(20), "gsk_" + "x".repeat(40), "xai-" + "y".repeat(40), "pplx-" + "z".repeat(40), "tvly-" + "w".repeat(30), "r8_" + "v".repeat(30)]) {
      assert.equal(redact(`token ${secret} here`), "token [redacted] here", secret);
    }
  });

  test("redact catches a bearer credential of any shape: bare, in a header line, or JSON-quoted", () => {
    const opaque = "abcdefghijklmnopqrstuvwxyz0123";
    assert.equal(redact(`Bearer ${opaque}`), "Bearer [redacted]");
    assert.equal(redact(`authorization: Bearer ${opaque}`), "authorization: Bearer [redacted]");
    assert.equal(redact(JSON.stringify({ Authorization: `Bearer ${opaque}` })), '{"Authorization":"Bearer [redacted]"}');
    assert.equal(redact(JSON.stringify({ Authorization: `Basic ${opaque}` })), '{"Authorization":"Basic [redacted]"}');
    // An escaped quote ends the match without losing its backslash, so the JSON stays well formed.
    assert.equal(redact(JSON.stringify(`authorization: Bearer ${opaque}" x`)), '"authorization: Bearer [redacted]\\" x"');
    assert.equal(redact("the bearer of bad news"), "the bearer of bad news", "an ordinary word after bearer stays");
    // Tool arguments as cleanValue serialises them, with a headers map.
    const args = toolArgsContent({ url: "https://api.example.com", headers: { Authorization: `Bearer ${opaque}`, Accept: "application/json" } })["gen_ai.tool.call.arguments"];
    assert.ok(!args.includes(opaque), args);
    assert.deepEqual(JSON.parse(args).headers, { Authorization: "Bearer [redacted]", Accept: "application/json" });
    assert.ok(!cleanValue({ cmd: `curl -H 'Authorization: Bearer ${opaque}'` }).includes(opaque));
  });

  test("stripAgentContent drops content from every span of a transaction and keeps the rest", () => {
    const event = {
      contexts: { trace: { op: "gen_ai.invoke_agent", data: { "gen_ai.agent.name": "kernal", "gen_ai.input.messages": "p", "gen_ai.output.messages": "o" } } },
      spans: [{ op: "gen_ai.execute_tool", data: { "gen_ai.tool.name": "read", "gen_ai.tool.call.arguments": "a", "gen_ai.tool.call.result": "r" } as Record<string, unknown> }, { op: "x" }],
    };
    const out = stripAgentContent(event);
    assert.deepEqual(out.contexts.trace.data, { "gen_ai.agent.name": "kernal" });
    assert.deepEqual(out.spans[0].data, { "gen_ai.tool.name": "read" });
    assert.equal(out.spans[1].data, undefined);
    assert.equal(event.spans[0].data!["gen_ai.tool.call.result"], "r", "the original is not changed");
  });

  test("truncateUtf8 cuts on a character boundary within the byte limit", () => {
    const out = truncateUtf8("é".repeat(10_000), 100);
    assert.ok(Buffer.byteLength(out, "utf8") <= 100);
    assert.ok(out.endsWith("…[truncated]"));
    assert.ok(!out.includes("�"));
    assert.equal(truncateUtf8("short", 100), "short");
  });

  test("cleanText redacts before it cuts, so a key at the limit never leaves in part", () => {
    const out = cleanText("x".repeat(FIELD_LIMIT_BYTES - 40) + " sk-ant-api03-" + "Q".repeat(60));
    assert.ok(!out.includes("QQQQ"), out.slice(-80));
  });

  test("messagesJson keeps the newest messages within the field limit, redacted", () => {
    const messages: unknown[] = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `message ${i} ` + "w".repeat(500) }] }));
    messages.push({ role: "user", content: [{ type: "text", text: "my key is sk-proj-abcdefghijklmnopqrstuvwxyz123456" }] });
    const json = messagesJson(messages);
    assert.ok(Buffer.byteLength(json, "utf8") <= FIELD_LIMIT_BYTES);
    const parsed = JSON.parse(json);
    assert.ok(parsed.length > 1 && parsed.length < 41);
    assert.equal(parsed.at(-1).parts[0].content, "my key is [redacted]");
    assert.ok(!json.includes("message 0 "), "the oldest went first");
  });

  test("one huge newest message is cut to fit rather than dropped", () => {
    const json = messagesJson([{ role: "user", content: "\"quoted\"\n".repeat(5000) }]);
    assert.ok(Buffer.byteLength(json, "utf8") <= FIELD_LIMIT_BYTES, String(Buffer.byteLength(json, "utf8")));
    assert.equal(JSON.parse(json).length, 1);
  });

  test("a tool result is its text content; the run budget stops recording, not the run", () => {
    assert.deepEqual(toolResultContent({ content: [{ type: "text", text: "ok AKIAABCDEFGHIJKLMNOP" }], details: {} }), { "gen_ai.tool.call.result": "ok [redacted]" });
    const budget = new ContentBudget(10);
    assert.deepEqual(budget.take({ a: "12345" }), { a: "12345" });
    assert.deepEqual(budget.take({ b: "123456" }), { "kernal.content.dropped": "run content budget reached" });
  });

  test("chatSpanEnd: usage in Sentry's terms (input includes cached), cost only when priced", () => {
    const m = { role: "assistant", model: "claude-x", provider: "litellm", responseId: "r1", stopReason: "toolUse", usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, reasoning: 5, totalTokens: 180, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 } } };
    const out = chatSpanEnd(m);
    assert.deepEqual({ ...out, "gen_ai.cost.input_tokens": Math.round(Number(out["gen_ai.cost.input_tokens"]) * 1000) / 1000 }, {
      "gen_ai.response.model": "claude-x",
      "gen_ai.provider.name": "litellm",
      "gen_ai.response.id": "r1",
      "gen_ai.response.finish_reasons": "[\"tool_call\"]",
      "gen_ai.usage.input_tokens": 160,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.usage.total_tokens": 180,
      "gen_ai.usage.cache_read.input_tokens": 50,
      "gen_ai.usage.cache_creation.input_tokens": 10,
      "gen_ai.usage.reasoning.output_tokens": 5,
      "gen_ai.cost.total_tokens": 0.33,
      "gen_ai.cost.input_tokens": 0.13,
      "gen_ai.cost.output_tokens": 0.2,
    });
    const unpriced = chatSpanEnd({ ...m, usage: { ...m.usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    assert.equal(unpriced["gen_ai.cost.total_tokens"], undefined);
  });

  test("scrubMetric drops the hostname @sentry/node adds and writes home as ~", () => {
    const m = scrubMetric({ name: "x", attributes: { "server.address": "Someones-MacBook.local", tool: "/Users/someone/bin/x" } }, "/Users/someone");
    assert.deepEqual(m.attributes, { tool: "~/bin/x" });
  });
});

describe("agent monitoring wired to pi", () => {
  beforeEach(() => _resetSentryState());

  async function start(fleet: FleetSettings, settings: Record<string, unknown> = {}, sampled = true) {
    const fake = fakeSentry(sampled);
    const pi = makePi();
    const file = join(mkdtempSync(join(tmpdir(), "kernal-fleet-")), "fleet-settings.json");
    writeFileSync(file, JSON.stringify({ api: API, fetchedAt: new Date().toISOString(), settings: fleet }));
    const fetch = (async () => new Response(JSON.stringify(fleet), { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
    const saved: Array<[string, false | undefined]> = [];
    let refreshed: Promise<void> = Promise.resolve();
    sentryExtension(pi as any, {
      signedIn: false, sentry: fake.sentry, credentials: CREDS, settings, cacheFile: file, fetch,
      onRefresh: (p) => { refreshed = p; }, saveOptOut: () => {}, saveSignalOptOut: (s, v) => { saved.push([s, v]); },
    });
    await refreshed;
    await new Promise((r) => setImmediate(r));
    const notes: string[] = [];
    const command = (args: string) => pi.commands.get("sentry")!.handler(args, { ui: { notify: (m: string) => notes.push(m) } });
    return { ...fake, pi, saved, notes, command };
  }

  const ctx = { model: { id: "claude-x", provider: "litellm" }, sessionManager: { getSessionId: () => "sess-1" } };
  const SYSTEM = "SYSTEM PROMPT with OUTFITTER_LITELLM_KEY=sk-secretsecretsecret";
  const assistant = {
    role: "assistant", model: "claude-x", provider: "litellm", stopReason: "toolUse",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
    content: [{ type: "text", text: "let me look" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "/etc/x", token: "ghp_" + "a".repeat(36) } }],
  };

  async function oneRun(pi: ReturnType<typeof makePi>) {
    await pi.emit("before_agent_start", { prompt: "fix it, key sk-ant-api03-" + "k".repeat(40), systemPrompt: SYSTEM }, ctx);
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("context", { messages: [{ role: "user", content: [{ type: "text", text: "fix it" }] }] }, ctx);
    await pi.emit("message_update", { message: { role: "assistant" } }, ctx);
    await pi.emit("message_end", { message: assistant }, ctx);
    await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "read", args: { path: "/etc/x" } }, ctx);
    await pi.emit("tool_execution_end", { toolCallId: "c1", toolName: "read", isError: false, result: { content: [{ type: "text", text: "file body" }] } }, ctx);
    await pi.emit("agent_end", { messages: [{ role: "user", content: "fix it" }, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }] }, ctx);
  }

  test("agentTraces off (the default): the plain #374 spans, no gen_ai spans, no content, no counters", async () => {
    const { pi, spans, counts } = await start(ON);
    await oneRun(pi);
    assert.deepEqual(spans.map((s) => [s.name, s.op]), [["agent.run", "agent.run"], ["tool.read", "tool.execute"]]);
    assert.deepEqual(spans[1].attributes, { "kernal.tool": "read" });
    assert.equal(counts.length, 0);
  });

  test("agentTraces on: invoke_agent, chat and execute_tool spans with Sentry's attribute names, and no content", async () => {
    const { pi, spans } = await start(TRACES);
    await oneRun(pi);
    assert.deepEqual(spans.map((s) => [s.name, s.op, s.parent ?? null, s.status, s.ended]), [
      ["invoke_agent kernal", "gen_ai.invoke_agent", null, "ok", true],
      ["chat claude-x", "gen_ai.chat", "invoke_agent kernal", "ok", true],
      ["execute_tool read", "gen_ai.execute_tool", "invoke_agent kernal", "ok", true],
    ]);
    const [run, chat, tool] = spans;
    assert.equal(run.attributes["gen_ai.agent.name"], "kernal");
    assert.equal(run.attributes["gen_ai.operation.name"], "invoke_agent");
    assert.equal(run.attributes["gen_ai.conversation.id"], "sess-1");
    assert.equal(chat.attributes["gen_ai.operation.name"], "chat");
    assert.equal(chat.attributes["gen_ai.request.model"], "claude-x");
    assert.equal(chat.attributes["gen_ai.provider.name"], "litellm");
    assert.equal(chat.attributes["gen_ai.usage.input_tokens"], 10);
    assert.equal(chat.attributes["gen_ai.usage.output_tokens"], 5);
    assert.equal(chat.attributes["gen_ai.cost.total_tokens"], 0.003);
    assert.equal(chat.attributes["gen_ai.response.finish_reasons"], "[\"tool_call\"]");
    assert.equal(typeof chat.attributes["gen_ai.response.time_to_first_chunk"], "number");
    assert.equal(tool.attributes["gen_ai.operation.name"], "execute_tool");
    assert.equal(tool.attributes["gen_ai.tool.name"], "read");
    assert.equal(tool.attributes["kernal.tool.outcome"], "ok");
    for (const s of spans) {
      for (const k of ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]) assert.equal(s.attributes[k], undefined, `${s.name} ${k}`);
    }
  });

  test("agentContent on: prompts, outputs, tool arguments and results, redacted; never the system prompt", async () => {
    const { pi, spans } = await start(ALL);
    await oneRun(pi);
    const [run, chat, tool] = spans;
    assert.match(run.attributes["gen_ai.input.messages"], /fix it, key \[redacted\]/);
    assert.match(run.attributes["gen_ai.output.messages"], /"done"/);
    assert.match(chat.attributes["gen_ai.input.messages"], /"fix it"/);
    assert.match(chat.attributes["gen_ai.output.messages"], /let me look/);
    assert.match(chat.attributes["gen_ai.output.messages"], /tool_call/);
    assert.ok(!chat.attributes["gen_ai.output.messages"].includes("ghp_aaaa"), "tool-call arguments in the output are redacted too");
    assert.equal(tool.attributes["gen_ai.tool.call.arguments"], "{\"path\":\"/etc/x\"}");
    assert.equal(tool.attributes["gen_ai.tool.call.result"], "file body");
    const all = JSON.stringify(spans);
    assert.ok(!all.includes("SYSTEM PROMPT") && !all.includes("sk-secretsecret"), "nothing from the system prompt");
  });

  test("content off mid-run stops recording at the next step, not the next run", async () => {
    const { pi, spans, command } = await start(ALL);
    await pi.emit("before_agent_start", { prompt: "fix it" }, ctx);
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "read", args: { path: "/etc/x" } }, ctx);
    await command("content off");
    await pi.emit("tool_execution_end", { toolCallId: "c1", toolName: "read", isError: false, result: { content: [{ type: "text", text: "file body" }] } }, ctx);
    await pi.emit("context", { messages: [{ role: "user", content: [{ type: "text", text: "fix it" }] }] }, ctx);
    await pi.emit("message_end", { message: assistant }, ctx);
    await pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }] }, ctx);
    const [run, tool, chat] = spans;
    assert.equal(tool.op, "gen_ai.execute_tool");
    assert.equal(tool.attributes["gen_ai.tool.call.arguments"], "{\"path\":\"/etc/x\"}", "recorded while content was on");
    assert.equal(tool.attributes["gen_ai.tool.call.result"], undefined);
    assert.equal(tool.attributes["kernal.tool.outcome"], "ok", "the span itself still completes");
    assert.equal(chat.attributes["gen_ai.input.messages"], undefined);
    assert.equal(chat.attributes["gen_ai.output.messages"], undefined);
    assert.equal(run.attributes["gen_ai.output.messages"], undefined);
  });

  test("a run the sampler dropped builds no content", async () => {
    const { pi, spans } = await start(ALL, {}, false);
    await oneRun(pi);
    assert.equal(spans[0].op, "gen_ai.invoke_agent");
    assert.ok(!JSON.stringify(spans).includes("gen_ai.input.messages"));
  });

  test("a run that ends mid-call closes the chat span as an error", async () => {
    const { pi, spans } = await start(ALL);
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("context", { messages: [] }, ctx);
    await pi.emit("agent_end", { messages: [] }, ctx);
    assert.deepEqual(spans.map((s) => [s.op, s.status, s.ended]), [["gen_ai.invoke_agent", "ok", true], ["gen_ai.chat", "error", true]]);
  });

  test("metrics on: runs, model calls, tokens, spend, tool calls and errors are counted", async () => {
    const { pi, counts } = await start({ telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0, metrics: true } } });
    await oneRun(pi);
    await pi.emit("tool_execution_end", { toolCallId: "c9", toolName: "bash", isError: true }, ctx);
    assert.deepEqual(counts.map((c) => c.name), [METRICS.modelCalls, METRICS.inputTokens, METRICS.outputTokens, METRICS.costUsd, METRICS.toolCalls, METRICS.agentRuns, METRICS.toolCalls, METRICS.errors]);
    assert.deepEqual(counts[0].attributes, { model: "claude-x", provider: "litellm", finish_reason: "tool_call" });
    assert.equal(counts[1].value, 10);
    assert.equal(counts[2].value, 5);
    assert.equal(counts[3].value, 0.003);
    assert.deepEqual(counts[4].attributes, { tool: "read", outcome: "ok" });
    assert.deepEqual(counts[5].attributes, { outcome: "ok" });
    assert.deepEqual(counts.at(-1)!.attributes, { kind: "tool", tool: "bash" });
  });

  test("metrics off (the default): nothing is counted, even with agent traces on", async () => {
    const { pi, counts } = await start(TRACES);
    await oneRun(pi);
    assert.equal(counts.length, 0);
  });

  test("a settings.json opt-out wins over the fleet", async () => {
    const { pi, spans, counts } = await start(ALL, { kernal: { sentryAgentTraces: false, sentryMetrics: false } });
    await oneRun(pi);
    assert.equal(spans[0].op, "agent.run");
    assert.equal(counts.length, 0);
  });

  test("/sentry agent|content|metrics off stop at once and save the opt-out; on clears it", async () => {
    const { pi, spans, saved, notes, command } = await start(ALL);
    await command("content off");
    assert.equal(liveSignals().agentContent, false);
    await command("metrics off");
    await command("agent off");
    assert.deepEqual(liveSignals(), NO_SIGNALS);
    assert.deepEqual(saved, [["agentContent", false], ["metrics", false], ["agentTraces", false]]);
    assert.match(notes.at(-1)!, /Agent monitoring.*off on this laptop/);
    await oneRun(pi);
    assert.equal(spans[0].op, "agent.run");
    await command("agent on");
    assert.equal(liveSignals().agentTraces, true);
    assert.equal(liveSignals().agentContent, false, "content stays off until it is turned back on");
    assert.deepEqual(saved.at(-1), ["agentTraces", undefined]);
    await command("agent maybe");
    assert.match(notes.at(-1)!, /usage: \/sentry/);
  });

  test("Sentry off: no spans and no counters, whatever the signals say", async () => {
    const { pi, spans, counts, command } = await start(ALL);
    await command("off");
    await oneRun(pi);
    assert.equal(spans.length, 0);
    assert.equal(counts.length, 0);
    assert.deepEqual(liveSignals(), NO_SIGNALS);
  });

  test("session_shutdown flushes what is queued, only while sending", async () => {
    const on = await start(ALL);
    await on.pi.emit("session_shutdown", { reason: "quit" }, ctx);
    assert.equal(on.flushes(), 1);
    _resetSentryState();
    const off = await start(OFF);
    await off.pi.emit("session_shutdown", { reason: "quit" }, ctx);
    assert.equal(off.flushes(), 0);
  });
});
