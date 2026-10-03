// server.ts's request-span hooks, against the real SDK. Its own file (so its own process): the SDK's
// span pipeline stays bound to the first client a process starts, so these need the first one.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { applySentrySettings, resetSentryForTests, Sentry, type SentryRuntime } from "../src/sentry.ts";
import { buildTestApp } from "./helpers.ts";

const ON = { enabled: true, dsn: "https://examplePublicKey@o0.ingest.sentry.io/0", tracesSampleRate: 1 };
const OFF = { enabled: false, dsn: ON.dsn, tracesSampleRate: 1 };
const runtime = (transport: SentryRuntime["transport"]): SentryRuntime => ({ release: "", environment: "test", transport });

const transactions: Array<{ transaction?: string; contexts?: { trace?: { status?: string } } }> = [];
const transport: SentryRuntime["transport"] = () => ({
  send: async (envelope) => {
    for (const [header, payload] of envelope[1] as Array<[{ type: string }, (typeof transactions)[number]]>) {
      if (header.type === "transaction") transactions.push(payload);
    }
    return {};
  },
  flush: async () => true,
});

afterEach(() => {
  transactions.length = 0;
});

/** The SDK exports a finished transaction on its own timer: wait for `n`, at most 5 s. */
async function waitFor(n: number): Promise<void> {
  for (let i = 0; i < 50 && transactions.length < n; i++) {
    await Sentry.flush(100);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("request spans (server.ts)", () => {
  async function appWithSentry() {
    const app = await buildTestApp();
    // The app's own apply ran with Sentry off; start it here with the recording transport.
    applySentrySettings(ON, runtime(transport));
    return { app, transactions };
  }

  test("named after the route pattern, with the reply's status", async () => {
    const { app, transactions } = await appWithSentry();
    await app.fastify.inject({ method: "GET", url: "/api/sessions/s-123?x=1" });
    await app.fastify.inject({ method: "GET", url: "/api/no-such-route/abc" });
    await waitFor(2);
    const names = transactions.map((t) => t.transaction);
    assert.ok(names.includes("GET /api/sessions/:id"), names.join(", "));
    assert.ok(names.includes("GET (unmatched route)"), names.join(", "));
    assert.ok(!names.some((n) => n?.includes("s-123") || n?.includes("abc")), "never the raw URL");
    assert.equal(transactions.find((t) => t.transaction === "GET (unmatched route)")?.contexts?.trace?.status, "not_found");
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("no span for a websocket upgrade, and none while off", async () => {
    const { app, transactions } = await appWithSentry();
    await app.fastify.inject({ method: "GET", url: "/api/me", headers: { upgrade: "websocket" } });
    applySentrySettings(OFF, runtime(transport));
    await app.fastify.inject({ method: "GET", url: "/api/me" });
    await waitFor(1);
    assert.deepEqual(transactions, []);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});

test("after all: close the SDK", async () => {
  await resetSentryForTests();
});
