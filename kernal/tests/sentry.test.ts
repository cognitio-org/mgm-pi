/**
 * Sentry extension: config defaults/overrides (config.ts), init-once guarding (client.ts), error
 * capture and agent/tool trace sampling driven through the real entry point with a fake pi
 * (harness.ts) and a fake Sentry client (no network, no real @sentry/node init).
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DSN, DEFAULT_TRACES_SAMPLE_RATE, ERROR_SAMPLE_RATE, parseSampleRate, defaultEnvironment, sentryConfig } from "../.pi/extensions/sentry/config.ts";
import { initSentryOnce, _resetSentryInitState, type SentryLike, type SentrySpan } from "../.pi/extensions/sentry/client.ts";
import { agentRunError, toolSpanAttributes } from "../.pi/extensions/sentry/lib.ts";
import sentryExtension, { _resetProcessErrorCaptureState } from "../.pi/extensions/sentry/index.ts";
import { makePi } from "./harness.ts";

describe("sentry config", () => {
  test("defaults: this project's DSN, development environment, 5% traces", () => {
    const c = sentryConfig({}, false);
    assert.equal(c.dsn, DEFAULT_DSN);
    assert.equal(c.environment, "development");
    assert.equal(c.tracesSampleRate, DEFAULT_TRACES_SAMPLE_RATE);
    assert.equal(c.tracesSampleRate, 0.05);
    assert.equal(c.enabled, true);
  });

  test("a packaged bundle defaults to the production environment", () => {
    assert.equal(defaultEnvironment(true), "production");
    assert.equal(defaultEnvironment(false), "development");
    assert.equal(sentryConfig({}, true).environment, "production");
  });

  test("SENTRY_DSN set to the empty string disables Sentry entirely", () => {
    const c = sentryConfig({ SENTRY_DSN: "" }, false);
    assert.equal(c.dsn, undefined);
    assert.equal(c.enabled, false);
  });

  test("SENTRY_DSN, SENTRY_ENVIRONMENT and SENTRY_TRACES_SAMPLE_RATE override the defaults", () => {
    const c = sentryConfig({ SENTRY_DSN: "https://key@o0.ingest.sentry.io/1", SENTRY_ENVIRONMENT: "staging", SENTRY_TRACES_SAMPLE_RATE: "0.25" }, false);
    assert.equal(c.dsn, "https://key@o0.ingest.sentry.io/1");
    assert.equal(c.environment, "staging");
    assert.equal(c.tracesSampleRate, 0.25);
  });

  test("parseSampleRate clamps to [0,1] and falls back on unset/unparsable", () => {
    assert.equal(parseSampleRate(undefined, 0.05), 0.05);
    assert.equal(parseSampleRate("", 0.05), 0.05);
    assert.equal(parseSampleRate("not-a-number", 0.05), 0.05);
    assert.equal(parseSampleRate("2", 0.05), 1);
    assert.equal(parseSampleRate("-1", 0.05), 0);
    assert.equal(parseSampleRate("0.3", 0.05), 0.3);
  });

  test("errors are always sampled at 100%, independent of the traces rate", () => {
    assert.equal(ERROR_SAMPLE_RATE, 1);
  });
});

function fakeSentry() {
  const initCalls: any[] = [];
  const captured: { error: unknown; context?: any }[] = [];
  const spans: { name: string; op: string; attributes?: any; status?: "ok" | "error"; ended: boolean }[] = [];
  const sentry: SentryLike = {
    init(options) { initCalls.push(options); },
    captureException(error, context) { captured.push({ error, context }); return "event-id"; },
    startInactiveSpan(options) {
      const rec = { name: options.name, op: options.op, attributes: options.attributes, status: undefined as "ok" | "error" | undefined, ended: false };
      spans.push(rec);
      const span: SentrySpan = { setStatus: (o) => { rec.status = o; }, end: () => { rec.ended = true; } };
      return span;
    },
    isInitialized() { return initCalls.length > 0; },
    async close() { return true; },
  };
  return { sentry, initCalls, captured, spans };
}

describe("initSentryOnce", () => {
  beforeEach(() => _resetSentryInitState());

  test("initializes once with dsn/environment/tracesSampleRate, and a release when given one", () => {
    const { sentry, initCalls } = fakeSentry();
    const config = sentryConfig({}, false);
    assert.equal(initSentryOnce(config, "0.2.0", sentry), true);
    assert.deepEqual(initCalls, [{ dsn: config.dsn, environment: "development", tracesSampleRate: 0.05, release: "0.2.0" }]);
  });

  test("a second call does not re-init", () => {
    const { sentry, initCalls } = fakeSentry();
    const config = sentryConfig({}, false);
    initSentryOnce(config, undefined, sentry);
    initSentryOnce(config, undefined, sentry);
    assert.equal(initCalls.length, 1);
  });

  test("disabled config (SENTRY_DSN=) never calls init", () => {
    const { sentry, initCalls } = fakeSentry();
    const config = sentryConfig({ SENTRY_DSN: "" }, false);
    assert.equal(initSentryOnce(config, undefined, sentry), false);
    assert.equal(initCalls.length, 0);
  });
});

describe("sentry lib", () => {
  test("agentRunError finds the last failed assistant turn", () => {
    const messages = [
      { role: "user" },
      { role: "assistant", content: [] },
      { role: "assistant", stopReason: "error", errorMessage: "503: overloaded" },
    ];
    assert.equal(agentRunError(messages as any), "503: overloaded");
    assert.equal(agentRunError([{ role: "assistant", stopReason: "stop" }] as any), undefined);
    assert.equal(agentRunError([]), undefined);
  });

  test("agentRunError falls back to a placeholder when the error carries no message", () => {
    assert.equal(agentRunError([{ role: "assistant", stopReason: "error" }] as any), "(error without message)");
  });

  test("toolSpanAttributes carries only the tool name (no args/results: those can hold secrets)", () => {
    assert.deepEqual(toolSpanAttributes("bash"), { "kernal.tool": "bash" });
  });
});

describe("sentry extension wired to pi", () => {
  beforeEach(() => { _resetSentryInitState(); _resetProcessErrorCaptureState(); });

  test("an agent run that ends cleanly produces an ok trace span and no captured error", async () => {
    const { sentry, spans, captured } = fakeSentry();
    const pi = makePi();
    sentryExtension(pi as any, { sentry, env: {} });
    await pi.emit("agent_start", {}, {});
    await pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, {});
    assert.equal(captured.length, 0);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, "agent.run");
    assert.equal(spans[0].status, "ok");
    assert.equal(spans[0].ended, true);
  });

  test("an agent run that ends in an assistant error is captured and its span marked error", async () => {
    const { sentry, spans, captured } = fakeSentry();
    const pi = makePi();
    sentryExtension(pi as any, { sentry, env: {} });
    await pi.emit("agent_start", {}, {});
    await pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "401: nope" }] }, {});
    assert.equal(captured.length, 1);
    assert.equal((captured[0].error as Error).message, "401: nope");
    assert.equal(captured[0].context.tags.source, "agent_end");
    assert.equal(spans[0].status, "error");
    assert.equal(spans[0].ended, true);
  });

  test("a tool call gets its own span, started and ended across the two tool_execution events", async () => {
    const { sentry, spans } = fakeSentry();
    const pi = makePi();
    sentryExtension(pi as any, { sentry, env: {} });
    await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} }, {});
    assert.equal(spans.length, 1);
    assert.equal(spans[0].ended, false, "the span stays open between the two events");
    await pi.emit("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: {}, isError: false }, {});
    assert.equal(spans[0].name, "tool.bash");
    assert.equal(spans[0].op, "tool.execute");
    assert.deepEqual(spans[0].attributes, { "kernal.tool": "bash" });
    assert.equal(spans[0].status, "ok");
    assert.equal(spans[0].ended, true);
  });

  test("a failed tool call's span is marked error", async () => {
    const { sentry, spans } = fakeSentry();
    const pi = makePi();
    sentryExtension(pi as any, { sentry, env: {} });
    await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "write" }, {});
    await pi.emit("tool_execution_end", { toolCallId: "c1", toolName: "write", isError: true }, {});
    assert.equal(spans[0].status, "error");
  });

  test("concurrent tool calls get independent spans keyed by toolCallId", async () => {
    const { sentry, spans } = fakeSentry();
    const pi = makePi();
    sentryExtension(pi as any, { sentry, env: {} });
    await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "read" }, {});
    await pi.emit("tool_execution_start", { toolCallId: "c2", toolName: "grep" }, {});
    await pi.emit("tool_execution_end", { toolCallId: "c2", toolName: "grep", isError: false }, {});
    await pi.emit("tool_execution_end", { toolCallId: "c1", toolName: "read", isError: false }, {});
    assert.equal(spans.length, 2);
    assert.ok(spans.every((s) => s.ended));
  });

  test("SENTRY_DSN='' disables the extension: no init, no handlers registered", async () => {
    const { sentry, initCalls, spans } = fakeSentry();
    const pi = makePi();
    sentryExtension(pi as any, { sentry, env: { SENTRY_DSN: "" } });
    assert.equal(initCalls.length, 0);
    assert.equal(pi.handlers.size, 0, "a disabled extension subscribes to nothing");
    await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "read" }, {});
    assert.equal(spans.length, 0);
  });

  test("uncaughtException and unhandledRejection are captured with a distinguishing tag", async () => {
    const { sentry, captured } = fakeSentry();
    const pi = makePi();
    sentryExtension(pi as any, { sentry, env: {} });
    const uncaught = process.listeners("uncaughtException").slice(-1)[0] as (e: Error) => void;
    const unhandled = process.listeners("unhandledRejection").slice(-1)[0] as (r: unknown) => void;
    try {
      uncaught(new Error("boom"));
      unhandled("rejected-value");
      assert.equal(captured.length, 2);
      assert.equal(captured[0].context.tags.source, "uncaughtException");
      assert.equal(captured[1].context.tags.source, "unhandledRejection");
    } finally {
      process.removeListener("uncaughtException", uncaught);
      process.removeListener("unhandledRejection", unhandled);
    }
  });
});
