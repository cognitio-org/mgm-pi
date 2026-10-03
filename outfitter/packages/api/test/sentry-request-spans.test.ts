// server.ts's request-span hooks, against the real SDK. Its own file (so its own process): the SDK's
// span pipeline stays bound to the first client a process starts, so these need the first one.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { applySentrySettings, installSentryErrorHandler, resetSentryForTests, Sentry, type SentryRuntime } from "../src/sentry.ts";
import { buildTestApp } from "./helpers.ts";

const ON = { enabled: true, dsn: "https://examplePublicKey@o0.ingest.sentry.io/0", tracesSampleRate: 1 };
const OFF = { enabled: false, dsn: ON.dsn, tracesSampleRate: 1 };
const runtime = (transport: SentryRuntime["transport"]): SentryRuntime => ({ release: "", environment: "test", transport });

const transactions: Array<{ transaction?: string; contexts?: { trace?: { status?: string } } }> = [];
const errors: string[] = [];
const transport: SentryRuntime["transport"] = () => ({
  send: async (envelope) => {
    for (const [header, payload] of envelope[1] as Array<[{ type: string }, (typeof transactions)[number]]>) {
      if (header.type === "transaction") transactions.push(payload);
      if (header.type === "event") errors.push((payload as { exception?: { values?: Array<{ value?: string }> } }).exception?.values?.[0]?.value ?? "");
    }
    return {};
  },
  flush: async () => true,
});

afterEach(() => {
  transactions.length = 0;
  errors.length = 0;
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

describe("route errors (installSentryErrorHandler)", () => {
  test("a 5xx is reported once; a 4xx, an Octokit-style status, and anything while off never", async () => {
    applySentrySettings(ON, runtime(transport));
    const fastify = Fastify();
    installSentryErrorHandler(fastify);
    fastify.addHook("onRequest", async (req) => {
      if (req.url === "/octokit-404") throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    fastify.get("/boom", async () => {
      throw new Error("kaboom");
    });
    fastify.get("/bad-request", async () => {
      throw Object.assign(new Error("not a 5xx"), { statusCode: 400 });
    });
    assert.equal((await fastify.inject({ method: "GET", url: "/boom" })).statusCode, 500);
    assert.equal((await fastify.inject({ method: "GET", url: "/bad-request" })).statusCode, 400);
    await fastify.inject({ method: "GET", url: "/octokit-404" });
    await Sentry.flush(1000); // before turning off: off stops the queue at the wire too
    applySentrySettings(OFF, runtime(transport));
    await fastify.inject({ method: "GET", url: "/boom" });
    await Sentry.flush(1000);
    assert.deepEqual(errors, ["kaboom"]);
    await fastify.close();
  });
});

test("after all: close the SDK", async () => {
  await resetSentryForTests();
});
