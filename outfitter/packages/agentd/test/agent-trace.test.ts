// #424: AI agent monitoring (agent-trace.ts) and sentry.ts's other new signals for a Drive: pi's
// RPC events become gen_ai.invoke_agent / chat / execute_tool spans with models, tokens, cost and
// tool outcomes; content (prompts, responses, tool input and output) only when the fleet says so,
// redacted and cut to 8 KB a field; logs, metrics and profiles only when on.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { AgentTracer, CONTENT_FIELD_MAX, scrubContent, sentryStartSpan, truncateBytes, type SpanLike, type SpanStart } from "../src/agent-trace.js";
import { agentTraceSignals, initSentry, profilerStartedForTests, resetSentryForTests, Sentry, signalsFrom, toSentryLog } from "../src/sentry.js";
import { createLogger } from "../src/logger.js";
import type { PiRpcEvent } from "../src/protocol.js";

const DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";
const BASE = { dsn: DSN, tracesSampleRate: 0, environment: "test" };

afterEach(async () => {
  await resetSentryForTests();
});

interface Recorded {
  name: string;
  op: string;
  parent?: Recorded;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  ended: boolean;
}

/** A StartSpan that records instead of sending. */
function recorder() {
  const spans: Recorded[] = [];
  const byHandle = new Map<SpanLike, Recorded>();
  const startSpan = (opts: SpanStart): SpanLike => {
    const rec: Recorded = { name: opts.name, op: opts.op, attributes: { ...opts.attributes }, ended: false, ...(opts.parent ? { parent: byHandle.get(opts.parent) } : {}) };
    const handle: SpanLike = {
      setAttribute: (k, v) => void (v === undefined ? delete rec.attributes[k] : (rec.attributes[k] = v)),
      setStatus: (s) => void (rec.status = s),
      updateName: (n) => void (rec.name = n),
      end: () => void (rec.ended = true),
    };
    byHandle.set(handle, rec);
    spans.push(rec);
    return handle;
  };
  return { spans, startSpan };
}

const SECRET_KEY = "sk-live-0123456789abcdefghij";
const usage = (input: number, output: number, cost: number) => ({ input, output, cacheRead: 10, cacheWrite: 5, totalTokens: input + output + 15, cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } });

/** One agent run: a prompt, a model call that asks for a tool, the tool, and a final answer. */
const RUN: PiRpcEvent[] = [
  { type: "agent_start" },
  { type: "message_end", message: { role: "user", content: `deploy with key ${SECRET_KEY}` } },
  { type: "message_start", message: { role: "assistant", model: "claude-auto-llm", provider: "litellm", content: [] } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } },
  {
    type: "message_end",
    message: {
      role: "assistant",
      model: "claude-auto-llm",
      responseModel: "claude-sonnet",
      provider: "litellm",
      usage: usage(100, 20, 0.002),
      stopReason: "toolUse",
      content: [{ type: "thinking", thinking: "secret plans" }, { type: "text", text: "Running it" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo $TOKEN" } }],
    },
  },
  { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x" } },
  { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "kda_ABCDEFGHIJKLMNOPQRSTUVWX printed" }] }, isError: true },
  { type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "failed" }] } },
  { type: "message_start", message: { role: "assistant", model: "claude-auto-llm", provider: "litellm", content: [] } },
  { type: "message_end", message: { role: "assistant", model: "claude-auto-llm", provider: "litellm", usage: usage(200, 30, 0.003), stopReason: "stop", content: [{ type: "text", text: "Done." }] } },
  { type: "agent_end", messages: [], willRetry: false },
];

function play(tracer: AgentTracer, events: PiRpcEvent[] = RUN): void {
  for (const e of events) tracer.observe(e);
}

describe("scrubContent", () => {
  test("the run's own secrets and secret-shaped strings are redacted", () => {
    const out = scrubContent(`a ${"ghp_" + "x".repeat(30)} b outf_abcdefghij c kdr_abcdefghijklmnopqrstu d kdc_ABCDEFGHIJKLMNOPQRSTUV e sk-ant-abcdefghijklmnopqr f Bearer zzzzzzzzzzzzzz g my-own-run-secret`, ["my-own-run-secret"]);
    assert.equal(out, "a [redacted] b [redacted] c [redacted] d [redacted] e [redacted] f Bearer [redacted] g [redacted]");
  });

  test("objects go as JSON, then redacted", () => {
    assert.equal(scrubContent({ note: "kda_0123456789abcdefghijkl" }), '{"note":"[redacted]"}');
    assert.ok(!scrubContent({ apiKey: "plainvalue123456" }).includes("plainvalue"), "a key-named field's value too");
  });

  test("a large payload is cut to 8 KB, marked, and never mid-character", () => {
    const big = "é".repeat(20_000); // 2 bytes each
    const out = scrubContent(big);
    assert.ok(Buffer.byteLength(out) <= CONTENT_FIELD_MAX, String(Buffer.byteLength(out)));
    assert.match(out, /…\[truncated \d+ bytes\]$/);
    assert.ok(!out.includes("�"));
    assert.equal(truncateBytes("short"), "short");
  });
});

describe("AgentTracer", () => {
  test("one invoke_agent root, a chat per model call and an execute_tool per tool, with the metadata", () => {
    const { spans, startSpan } = recorder();
    play(new AgentTracer({ agentName: "kernal-drive", conversationId: "sess-1", content: false, startSpan }));
    assert.deepEqual(
      spans.map((s) => [s.op, s.name, s.parent?.op ?? null, s.ended]),
      [
        ["gen_ai.invoke_agent", "invoke_agent kernal-drive", null, true],
        ["gen_ai.chat", "chat claude-auto-llm", "gen_ai.invoke_agent", true],
        ["gen_ai.execute_tool", "execute_tool bash", "gen_ai.invoke_agent", true],
        ["gen_ai.chat", "chat claude-auto-llm", "gen_ai.invoke_agent", true],
      ],
    );
    const [agent, chat, tool, last] = spans;
    assert.equal(agent!.attributes["gen_ai.agent.name"], "kernal-drive");
    assert.equal(agent!.attributes["gen_ai.conversation.id"], "sess-1");
    assert.equal(agent!.attributes["gen_ai.usage.input_tokens"], 100 + 200 + 2 * 15);
    assert.equal(agent!.attributes["gen_ai.usage.output_tokens"], 50);
    assert.ok(Math.abs((agent!.attributes["gen_ai.cost.total_tokens"] as number) - 0.005) < 1e-12);
    assert.equal(agent!.attributes["outfitter.agent.tool_calls"], 1);
    assert.deepEqual(agent!.status, { code: 1 });

    assert.equal(chat!.attributes["gen_ai.request.model"], "claude-auto-llm");
    assert.equal(chat!.attributes["gen_ai.response.model"], "claude-sonnet");
    assert.equal(chat!.attributes["gen_ai.provider.name"], "litellm");
    assert.equal(chat!.attributes["gen_ai.usage.input_tokens"], 115, "cached tokens included");
    assert.equal(chat!.attributes["gen_ai.usage.cache_read.input_tokens"], 10);
    assert.equal(chat!.attributes["gen_ai.usage.output_tokens"], 20);
    assert.equal(chat!.attributes["gen_ai.cost.total_tokens"], 0.002);
    assert.equal(chat!.attributes["gen_ai.response.finish_reasons"], "toolUse");
    assert.equal(typeof chat!.attributes["gen_ai.response.time_to_first_chunk"], "number");
    assert.equal(last!.attributes["gen_ai.response.time_to_first_chunk"], undefined, "no update, no first chunk");

    assert.equal(tool!.attributes["gen_ai.tool.name"], "bash");
    assert.equal(tool!.attributes["outfitter.tool.outcome"], "error");
    assert.deepEqual(tool!.status, { code: 2, message: "tool_error" });

    for (const s of spans) {
      for (const key of ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]) {
        assert.equal(s.attributes[key], undefined, `${s.op} has no ${key} while content is off`);
      }
    }
  });

  test("content on: prompts, outputs and tool input/output, redacted, thinking left out", () => {
    const { spans, startSpan } = recorder();
    play(new AgentTracer({ agentName: "kernal-drive", content: true, startSpan, secrets: () => [] }));
    const [agent, chat, tool, last] = spans;
    const all = JSON.stringify(spans.map((s) => s.attributes));
    assert.ok(!all.includes(SECRET_KEY), "sk- key redacted");
    assert.ok(!all.includes("abcdefghijklmnop"), "bearer token redacted");
    assert.ok(!all.includes("kda_ABCDEFGH"), "kda_ token redacted");
    assert.ok(!all.includes("secret plans"), "thinking never recorded");
    assert.match(agent!.attributes["gen_ai.input.messages"] as string, /deploy with key \[redacted\]/);
    assert.match(agent!.attributes["gen_ai.output.messages"] as string, /Done\./);
    assert.match(chat!.attributes["gen_ai.input.messages"] as string, /"role":"user"/);
    assert.match(chat!.attributes["gen_ai.output.messages"] as string, /"type":"tool_call".*"name":"bash"/);
    assert.match(tool!.attributes["gen_ai.tool.call.arguments"] as string, /Bearer \[redacted\]/);
    assert.match(tool!.attributes["gen_ai.tool.call.result"] as string, /\[redacted\] printed/);
    assert.match(last!.attributes["gen_ai.input.messages"] as string, /tool_call_response.*failed/, "the next call's input is the tool result");
  });

  test("the run's own secrets are matched exactly, as they are at each use", () => {
    const { spans, startSpan } = recorder();
    let secret = "first-plain-secret";
    const tracer = new AgentTracer({ agentName: "a", content: true, startSpan, secrets: () => [secret] });
    tracer.observe({ type: "agent_start" });
    secret = "rotated-plain-secret";
    tracer.observe({ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: { path: "rotated-plain-secret" } });
    assert.equal(spans[1]!.attributes["gen_ai.tool.call.arguments"], '{"path":"[redacted]"}');
  });

  test("a large tool result is cut to 8 KB", () => {
    const { spans, startSpan } = recorder();
    const tracer = new AgentTracer({ agentName: "a", content: true, startSpan });
    tracer.observe({ type: "agent_start" });
    tracer.observe({ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: {} });
    tracer.observe({ type: "tool_execution_end", toolCallId: "t", toolName: "read", result: { content: [{ type: "text", text: "x".repeat(200_000) }] }, isError: false });
    const result = spans[1]!.attributes["gen_ai.tool.call.result"] as string;
    assert.ok(Buffer.byteLength(result) <= CONTENT_FIELD_MAX);
    assert.equal(spans[1]!.attributes["outfitter.tool.outcome"], "ok");
  });

  test("close() ends whatever is open, marked cancelled; events without an agent run are ignored", () => {
    const { spans, startSpan } = recorder();
    const tracer = new AgentTracer({ agentName: "a", content: false, startSpan });
    tracer.observe({ type: "message_start", message: { role: "assistant" } });
    tracer.observe({ type: "tool_execution_start", toolCallId: "x", toolName: "bash" });
    assert.equal(spans.length, 0);
    tracer.observe({ type: "agent_start" });
    tracer.observe({ type: "message_start", message: { role: "assistant", model: "m" } });
    tracer.observe({ type: "tool_execution_start", toolCallId: "x", toolName: "bash" });
    tracer.close("stopped");
    assert.ok(spans.every((s) => s.ended));
    assert.deepEqual(spans[0]!.status, { code: 2, message: "stopped" });
    assert.deepEqual(spans[1]!.status, { code: 2, message: "cancelled" });
  });

  test("a span API that throws never reaches the run", () => {
    const tracer = new AgentTracer({ agentName: "a", content: false, startSpan: () => { throw new Error("boom"); } });
    assert.doesNotThrow(() => play(tracer));
    assert.doesNotThrow(() => tracer.close());
  });
});

type Item = { type: string; payload: unknown };

function fakeTransport() {
  const items: Item[] = [];
  const transport: NonNullable<Parameters<typeof initSentry>[1]> = () => ({
    send: async (envelope) => {
      for (const [header, payload] of envelope[1] as Array<[{ type: string }, unknown]>) items.push({ type: header.type, payload });
      return {};
    },
    flush: async () => true,
  });
  return { transport, items };
}

describe("with the real SDK", () => {
  test("off: no signals, whatever run.spec would have said", () => {
    assert.deepEqual(agentTraceSignals(), { traces: false, content: false });
    assert.deepEqual(signalsFrom(undefined), { logs: false, metrics: false, agentTraces: false, agentContent: false, profilesSampleRate: 0 });
    assert.equal(signalsFrom({ ...BASE, agentContent: true }).agentContent, false, "content needs agent traces");
    initSentry({ ...BASE });
    assert.deepEqual(agentTraceSignals(), { traces: false, content: false });
  });

  test("agent runs are kept even at a trace rate of 0, and reach the transport", async () => {
    const { transport, items } = fakeTransport();
    initSentry({ ...BASE, agentTraces: true }, transport);
    assert.deepEqual(agentTraceSignals(), { traces: true, content: false });
    play(new AgentTracer({ agentName: "kernal-drive", content: false, startSpan: sentryStartSpan }));
    // Not an agent run: the fleet's rate (0) applies.
    Sentry.startInactiveSpan({ name: "other", op: "task", forceTransaction: true, parentSpan: null }).end();
    await Sentry.flush(1000);
    const sent = JSON.stringify(items);
    assert.ok(sent.includes("gen_ai.invoke_agent"), sent.slice(0, 500));
    assert.ok(sent.includes("gen_ai.execute_tool"));
    assert.ok(!sent.includes('"other"'), "a plain trace still follows the rate");
  });

  test("logs: logger lines at INFO and up go, redacted again for secret-shaped strings; DEBUG stays local; nothing while off", async () => {
    const sink = new Writable({ write: (_c, _e, cb) => cb() });
    const { transport, items } = fakeTransport();
    initSentry({ ...BASE }, transport);
    createLogger({}, { stream: sink, isTTY: false }).warn("not sent");
    await Sentry.flush(1000);
    assert.equal(items.filter((i) => i.type === "log").length, 0);
    await resetSentryForTests();

    const on = fakeTransport();
    initSentry({ ...BASE, logs: true }, on.transport);
    const logger = createLogger({ runId: "r1" }, { stream: sink, isTTY: false });
    logger.addSecret("exact-run-secret");
    logger.debug("pi stderr line");
    logger.info("clone took 3s", { repo: "o/r", token: "outf_abcdefghijklmn" });
    logger.error("push failed: exact-run-secret");
    await Sentry.flush(1000);
    const logs = on.items.filter((i) => i.type === "log").flatMap((i) => (i.payload as { items: Array<{ body: string; level: string; attributes: Record<string, { value: unknown }> }> }).items);
    assert.deepEqual(logs.map((l) => [l.level, l.body]), [["info", "clone took 3s"], ["error", "push failed: [redacted]"]]);
    assert.equal(logs[0]!.attributes.token?.value, "[redacted]");
    assert.equal(logs[0]!.attributes.runId?.value, "r1");
  });

  test("toSentryLog clips long lines and fields", () => {
    const log = toSentryLog("m".repeat(10_000), { big: "b".repeat(5000), obj: { a: 1 }, n: 3 });
    assert.ok(log.message.length <= 4097);
    assert.ok((log.attributes.big as string).length <= 1025);
    assert.equal(log.attributes.obj, '{"a":1}');
    assert.equal(log.attributes.n, 3);
  });

  test("profiles: the profiler joins with the run's rate; a missing add-on is a warning", async () => {
    let seen: Record<string, unknown> | undefined;
    const factory = () => ({ name: "FakeProfiling", setup: (client: { getOptions(): Record<string, unknown> }) => void (seen = { ...client.getOptions() }) });
    initSentry({ ...BASE, profilesSampleRate: 0.4 }, fakeTransport().transport, { loadProfiler: async () => factory as never });
    assert.equal(await profilerStartedForTests(), true);
    assert.equal(seen?.profileSessionSampleRate, 0.4);
    assert.equal(seen?.profileLifecycle, "trace");
    await resetSentryForTests();

    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => void warnings.push(m);
    try {
      initSentry({ ...BASE, profilesSampleRate: 1 }, fakeTransport().transport, { loadProfiler: async () => Promise.reject(new Error("ELF mismatch")) });
      assert.equal(await profilerStartedForTests(), false);
    } finally {
      console.warn = warn;
    }
    assert.match(warnings.join(""), /did not load.*ELF mismatch/);
    await resetSentryForTests();

    initSentry({ ...BASE }, fakeTransport().transport, { loadProfiler: async () => assert.fail("loaded at rate 0") });
    assert.equal(profilerStartedForTests(), undefined);
  });
});
