// sentry.ts: the fleet settings' Sentry section (fleet-settings.ts) gates everything -- off by
// default, so every export is a no-op; on, errors from a Fastify route reach Sentry via the onError
// hook installSentryErrorHandler wires up in server.ts. A fake transport stands in for the network:
// Sentry processes captured events off an internal queue, so assertions await Sentry.flush() first.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createServer } from "node:http";
import {
  applySentrySettings,
  sentryEnabled,
  installSentryErrorHandler,
  resetSentryForTests,
  Sentry,
  type SentryRuntime,
} from "../src/sentry.ts";

const captureException = (e: unknown) => Sentry.captureException(e);
const withSentrySpan = <T,>(name: string, op: string, task: () => Promise<T>) => Sentry.startSpan({ name, op }, task);

const DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";
const ON = { enabled: true, dsn: DSN, tracesSampleRate: 0.05 };
const OFF = { enabled: false, dsn: DSN, tracesSampleRate: 0.05 };

/** Every envelope item type sent, and each error event's message, instead of a network call. */
function fakeTransport() {
  const errors: string[] = [];
  const items: string[] = [];
  const transactions: Array<{ transaction?: string; contexts?: { trace?: { status?: string } } }> = [];
  const events: Array<{ request?: Record<string, unknown> }> = [];
  const transport: SentryRuntime["transport"] = () => ({
    send: async (envelope) => {
      for (const [header, payload] of envelope[1] as Array<[{ type: string }, { exception?: { values?: Array<{ value?: string }> } }]>) {
        items.push(header.type);
        if (header.type === "event") {
          errors.push(payload.exception?.values?.[0]?.value ?? "");
          events.push(payload as never);
        }
        if (header.type === "transaction") transactions.push(payload as never);
      }
      return {};
    },
    flush: async () => true,
  });
  return { transport, errors, items, transactions, events };
}

function runtime(transport: SentryRuntime["transport"]): SentryRuntime {
  return { release: "", environment: "test", transport };
}

afterEach(async () => {
  await resetSentryForTests();
});

describe("applySentrySettings", () => {
  test("off by default: sentryEnabled() is false before any settings arrive", () => {
    assert.equal(sentryEnabled(), false);
  });

  test("turns on with enabled settings and a DSN", () => {
    applySentrySettings(ON, runtime(fakeTransport().transport));
    assert.equal(sentryEnabled(), true);
  });

  test("enabled without a DSN stays off", () => {
    applySentrySettings({ enabled: true, tracesSampleRate: 0.05 }, runtime(fakeTransport().transport));
    assert.equal(sentryEnabled(), false);
  });

  test("turning it off later stops everything at once, client reports included, without a restart", async () => {
    const { transport, items } = fakeTransport();
    applySentrySettings(ON, runtime(transport));
    applySentrySettings(OFF, runtime(transport));
    assert.equal(sentryEnabled(), false);
    captureException(new Error("after off"));
    Sentry.captureException(new Error("direct, still gated"));
    await withSentrySpan("dropped", "task", async () => undefined);
    await Sentry.flush(1000);
    await Sentry.getClient()?.close(1000);
    assert.deepEqual(items, []);
  });

  test("leaves Node's crash on an unhandled rejection alone", () => {
    const before = process.listenerCount("unhandledRejection");
    applySentrySettings(ON, runtime(fakeTransport().transport));
    assert.equal(process.listenerCount("unhandledRejection"), before);
  });

  test("a new DSN on a running instance sends nothing until it restarts", () => {
    applySentrySettings(ON, runtime(fakeTransport().transport));
    applySentrySettings({ ...ON, dsn: "https://otherKey@o0.ingest.sentry.io/1" }, runtime(fakeTransport().transport));
    assert.equal(sentryEnabled(), false);
    applySentrySettings(ON, runtime(fakeTransport().transport));
    assert.equal(sentryEnabled(), true, "back on the DSN it started with");
  });
});

describe("captureException", () => {
  test("reports the error when Sentry is on", async () => {
    const { transport, errors } = fakeTransport();
    applySentrySettings(ON, runtime(transport));
    captureException(new Error("boom"));
    await Sentry.flush(1000);
    assert.deepEqual(errors, ["boom"]);
  });
});

describe("traces", () => {
  test("runs the task inside a span when Sentry is on", async () => {
    applySentrySettings(ON, runtime(fakeTransport().transport));
    let sawActiveSpan = false;
    const result = await withSentrySpan("job", "task", async () => {
      sawActiveSpan = Sentry.getActiveSpan() !== undefined;
      return "done";
    });
    assert.equal(result, "done");
    assert.equal(sawActiveSpan, true);
  });

  test("the fleet's sample rate decides whether a trace is kept", async () => {
    const { transport, items } = fakeTransport();
    applySentrySettings({ ...ON, tracesSampleRate: 1 }, runtime(transport));
    await withSentrySpan("kept", "task", async () => undefined);
    applySentrySettings({ ...ON, tracesSampleRate: 0 }, runtime(transport));
    await withSentrySpan("dropped", "task", async () => undefined);
    await Sentry.flush(1000);
    assert.equal(items.filter((t) => t === "transaction").length, 1);
  });
});

describe("installSentryErrorHandler", () => {
  test("once Sentry is turned off a route error gets the app's own handling and nothing is sent", async () => {
    const { transport, errors } = fakeTransport();
    applySentrySettings(ON, runtime(transport));
    applySentrySettings(OFF, runtime(transport));
    const fastify = Fastify();
    installSentryErrorHandler(fastify);
    fastify.get("/boom", async () => {
      throw new Error("kaboom");
    });
    const res = await fastify.inject({ method: "GET", url: "/boom" });
    assert.equal(res.statusCode, 500);
    await Sentry.flush(1000);
    assert.deepEqual(errors, []);
  });

  test("reports an unhandled route error to Sentry while it is on", async () => {
    const { transport, errors } = fakeTransport();
    applySentrySettings(ON, runtime(transport));
    const fastify = Fastify();
    installSentryErrorHandler(fastify);
    fastify.get("/boom", async () => {
      throw new Error("kaboom");
    });
    fastify.get("/bad-request", async () => {
      throw Object.assign(new Error("not a 5xx"), { statusCode: 400 });
    });
    const res = await fastify.inject({ method: "GET", url: "/boom" });
    assert.equal(res.statusCode, 500);
    assert.equal((await fastify.inject({ method: "GET", url: "/bad-request" })).statusCode, 400);
    await Sentry.flush(1000);
    assert.deepEqual(errors, ["kaboom"], "once (not twice with the SDK's own integration), and never a 4xx");
  });
});

describe("what leaves the API", () => {
  test("no trace headers on outbound requests", async () => {
    let headers: Record<string, unknown> = {};
    const server = createServer((req, res) => { headers = req.headers; res.end("ok"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    applySentrySettings({ ...ON, tracesSampleRate: 1 }, runtime(fakeTransport().transport));
    await withSentrySpan("job", "task", async () => {
      await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    });
    server.close();
    assert.equal(headers["sentry-trace"], undefined);
    assert.equal(headers.baggage, undefined);
  });

  test("an event never carries the request's headers, body or query", async () => {
    const { transport, events } = fakeTransport();
    applySentrySettings(ON, runtime(transport));
    Sentry.captureEvent({
      message: "x",
      request: { method: "PUT", url: "https://outfitter.test/api/operator/secrets/x?token=abc", headers: { authorization: "Bearer outf_secret" }, data: { value: "secret" }, cookies: { a: "b" } },
    });
    await Sentry.flush(1000);
    assert.deepEqual(events[0]?.request, { method: "PUT", url: "https://outfitter.test/api/operator/secrets/x" });
  });
});
