/**
 * Child process for tests/sentry.test.ts's real-SDK checks: @sentry/node's init starts process-wide
 * instrumentation that never tears down, so it runs here, once, and reports what it saw as one JSON
 * line on stdout. A local HTTP server stands in for Sentry and records every envelope item type.
 */
import { createServer } from "node:http";
import { join } from "node:path";

const items: string[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    for (let i = 1; i < lines.length; i += 2) {
      try { items.push(JSON.parse(lines[i]).type); } catch {}
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
  const span = second.realSentry.startInactiveSpan({ name: "agent.run", op: "agent.run" });
  span.setStatus("ok");
  span.end();
} catch (err) {
  reloadError = String(err);
}
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
console.log(JSON.stringify({ integrations, unhandledRejectionListeners, reloadError, whileOn, whileOff }));
process.exit(0);
