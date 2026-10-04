/**
 * Child process for tests/sentry.test.ts's real-SDK checks: @sentry/node's init starts process-wide
 * instrumentation that never tears down, so it runs here, once, and reports what it saw as one JSON
 * line on stdout. A local HTTP server stands in for Sentry and records every envelope item type.
 */
import { createServer } from "node:http";
import { join } from "node:path";

const items: string[] = [];
const transactions: Array<{ transaction?: string; spans?: Array<{ description?: string }> }> = [];
const events: any[] = [];
const spanItems: any[] = [];
const metricItems: any[] = [];
let traceHeaders: { sentryTrace: string | null; baggage: string | null } | undefined;
const server = createServer((req, res) => {
  if (req.url === "/outbound") {
    // Stands in for an LLM provider: what headers did Kernal's fetch carry?
    traceHeaders = { sentryTrace: (req.headers["sentry-trace"] as string) ?? null, baggage: (req.headers.baggage as string) ?? null };
    res.end("ok");
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    for (let i = 1; i < lines.length; i += 2) {
      try {
        const type = JSON.parse(lines[i]).type;
        items.push(type);
        if (type === "transaction") transactions.push(JSON.parse(lines[i + 1]));
        if (type === "event") events.push(JSON.parse(lines[i + 1]));
        if (type === "span") spanItems.push(...(JSON.parse(lines[i + 1]).items ?? []));
        if (type === "trace_metric") metricItems.push(...(JSON.parse(lines[i + 1]).items ?? []));
      } catch {}
    }
    res.end("{}");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const dsn = `http://publicKey@127.0.0.1:${port}/1`;

process.env.PI_CODING_AGENT_DIR = join(import.meta.dirname, "..", "..", ".pi");
const first = await import("../../.pi/extensions/sentry/client.ts?instance=1");
const runtime = { environment: "test", release: "0.0.0-test" };

await first.applySentry({ on: true, dsn, tracesSampleRate: 1 }, runtime);
const Sentry = (globalThis as any)[Symbol.for("kernal.sentry")].sdk;
const integrations = (Sentry.getClient().getOptions().integrations as Array<{ name: string }>).map((i) => i.name);
const unhandledRejectionListeners = process.listenerCount("unhandledRejection");

// A reload: pi re-evaluates the module (a fresh copy, fresh module state); the SDK keeps running.
const second = await import("../../.pi/extensions/sentry/client.ts?instance=2");
await second.applySentry({ on: true, dsn, tracesSampleRate: 1 }, runtime);
let reloadError: string | undefined;
try {
  second.realSentry.captureException(new Error("after reload"));
  second.realSentry.captureCrash({ timestamp: "2026-10-03T11:00:00.000Z", kind: "uncaught_exception", message: "boom", stack: "Error: boom\n    at crash (/tmp/x.js:1:1)\n    at main (/tmp/y.js:2:2)" });
  const run = second.realSentry.startInactiveSpan({ name: "agent.run", op: "agent.run" });
  const tool = second.realSentry.startInactiveSpan({ name: "tool.read", op: "tool.execute", parent: run, onlyIfParent: true });
  await fetch(`http://127.0.0.1:${port}/outbound`);
  tool.setStatus("ok");
  tool.end();
  run.setStatus("ok");
  run.end();
} catch (err) {
  reloadError = String(err);
}
// #424, metrics off: a counter never leaves.
second.realSentry.count("kernal.test.dropped", 1, { tool: "read" });

// #424, agent monitoring and metrics on: gen_ai spans (the SDK moves the run's gen_ai children into a
// span item of their own) and a counter, without the hostname.
const signals = { agentTraces: true, agentContent: false, metrics: true };
await second.applySentry({ on: true, dsn, tracesSampleRate: 1, signals }, runtime);
let genAiError: string | undefined;
try {
  const agent = second.realSentry.startInactiveSpan({ name: "invoke_agent kernal", op: "gen_ai.invoke_agent", attributes: { "gen_ai.agent.name": "kernal" } });
  const chat = second.realSentry.startInactiveSpan({ name: "chat claude-x", op: "gen_ai.chat", attributes: { "gen_ai.request.model": "claude-x" }, parent: agent, onlyIfParent: true });
  chat.setAttributes({ "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 5 });
  chat.setStatus("ok");
  chat.end();
  agent.setStatus("ok");
  agent.end();
  second.realSentry.count("kernal.tool.calls", 1, { tool: "read", outcome: "ok" });
} catch (err) {
  genAiError = String(err);
}

// The SDK hands a finished transaction to its exporter on a short timer, not at once.
await new Promise((r) => setTimeout(r, 1500));
await Sentry.flush(2000);
const whileOn = [...items];

// Off: nothing at all may leave, client reports and sessions included.
items.length = 0;
await second.applySentry({ on: false, why: "laptop" }, runtime);
Sentry.captureException(new Error("while off"));
for (let i = 0; i < 3; i++) Sentry.startInactiveSpan({ name: "dropped", op: "x" }).end();
await Sentry.flush(2000);
await Sentry.close(2000);
const whileOff = [...items];

server.close();
const runChildren = (transactions.find((t) => t.transaction === "agent.run")?.spans ?? []).map((sp) => sp.description);
const fatal = events.find((e) => e.level === "fatal");
const crash = fatal && { level: fatal.level, type: fatal.exception.values[0].type, value: fatal.exception.values[0].value, hasFrames: (fatal.exception.values[0].stacktrace?.frames?.length ?? 0) >= 2, source: fatal.tags?.source, crashedAtTag: "crashed_at" in (fatal.tags ?? {}) };
const chatSpan = spanItems.find((sp) => sp.name === "chat claude-x");
const genAi = {
  error: genAiError,
  agentTransaction: transactions.some((t) => t.transaction === "invoke_agent kernal"),
  chatInputTokens: chatSpan?.attributes?.["gen_ai.usage.input_tokens"]?.value,
  chatOp: chatSpan?.attributes?.["sentry.op"]?.value,
  metrics: metricItems.map((m) => m.name),
  metricHasHost: metricItems.some((m) => "server.address" in (m.attributes ?? {})),
  metricTool: metricItems[0]?.attributes?.tool?.value,
};
console.log(JSON.stringify({ crash, integrations, unhandledRejectionListeners, reloadError, whileOn, whileOff, runChildren, traceHeaders, genAi }));
process.exit(0);
