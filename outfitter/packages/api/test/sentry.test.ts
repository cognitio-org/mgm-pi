// sentry.ts: SENTRY_DSN gates everything (dev/test default to unset, so every export becomes a
// no-op); when it's set, errors from a Fastify route reach Sentry via the onError hook
// installSentryErrorHandler wires up in server.ts. Sentry processes captured events off an
// internal queue, not synchronously, so assertions on a beforeSend spy await Sentry.flush() first.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  initSentry,
  sentryEnabled,
  installSentryErrorHandler,
  captureException,
  withSentrySpan,
  resetSentryForTests,
  Sentry,
} from "../src/sentry.ts";

afterEach(() => {
  resetSentryForTests();
});

describe("initSentry", () => {
  test("does nothing without a DSN -- sentryEnabled() stays false", () => {
    initSentry({ sentryDsn: "", release: "" });
    assert.equal(sentryEnabled(), false);
  });

  test("turns on with a DSN", () => {
    initSentry({ sentryDsn: "https://examplePublicKey@o0.ingest.sentry.io/0", release: "" });
    assert.equal(sentryEnabled(), true);
  });

  test("only the first call takes effect -- a later call with no DSN doesn't turn it back off", () => {
    initSentry({ sentryDsn: "https://examplePublicKey@o0.ingest.sentry.io/0", release: "" });
    initSentry({ sentryDsn: "", release: "" });
    assert.equal(sentryEnabled(), true);
  });
});

describe("captureException", () => {
  test("is a no-op when Sentry is off", () => {
    // No init() call this test -- resetSentryForTests() in afterEach left it off from the
    // previous test too. Nothing to assert beyond "this doesn't throw".
    assert.doesNotThrow(() => captureException(new Error("ignored")));
  });

  test("reports the error when Sentry is on", async () => {
    const captured: Array<{ exception?: { values?: Array<{ value?: string }> } }> = [];
    // initSentry() first, so captureException's own "am I on" check (sentry.ts's module-level
    // `initialized`) matches the SDK's state; the direct Sentry.init() below layers beforeSend on
    // top without resetting that flag.
    initSentry({ sentryDsn: "https://examplePublicKey@o0.ingest.sentry.io/0", release: "" });
    Sentry.init({
      dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      tracesSampleRate: 0.05,
      beforeSend(event) {
        captured.push(event);
        return null; // swallow -- no network call
      },
    });
    captureException(new Error("boom"), { runId: "r1" });
    await Sentry.flush(1000);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.exception?.values?.[0]?.value, "boom");
  });
});

describe("withSentrySpan", () => {
  test("runs the task untraced when Sentry is off", async () => {
    const result = await withSentrySpan("job", "task", async () => 42);
    assert.equal(result, 42);
  });

  test("runs the task inside a span when Sentry is on", async () => {
    initSentry({ sentryDsn: "https://examplePublicKey@o0.ingest.sentry.io/0", release: "" });
    let sawActiveSpan = false;
    const result = await withSentrySpan("job", "task", async () => {
      sawActiveSpan = Sentry.getActiveSpan() !== undefined;
      return "done";
    });
    assert.equal(result, "done");
    assert.equal(sawActiveSpan, true);
  });
});

describe("installSentryErrorHandler", () => {
  test("is a no-op when Sentry is off -- a route error gets the app's own handling, not Sentry's", async () => {
    const fastify = Fastify();
    installSentryErrorHandler(fastify);
    fastify.get("/boom", async () => {
      throw new Error("kaboom");
    });
    const res = await fastify.inject({ method: "GET", url: "/boom" });
    assert.equal(res.statusCode, 500);
  });

  test("reports an unhandled route error to Sentry (5% trace sampling config, capture always-on)", async () => {
    const captured: Array<{ exception?: { values?: Array<{ value?: string }> } }> = [];
    initSentry({ sentryDsn: "https://examplePublicKey@o0.ingest.sentry.io/0", release: "" });
    Sentry.init({
      dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      tracesSampleRate: 0.05,
      integrations: [Sentry.fastifyIntegration()],
      beforeSend(event) {
        captured.push(event);
        return null;
      },
    });
    const fastify = Fastify();
    installSentryErrorHandler(fastify);
    fastify.get("/boom", async () => {
      throw new Error("kaboom");
    });
    const res = await fastify.inject({ method: "GET", url: "/boom" });
    assert.equal(res.statusCode, 500);
    await Sentry.flush(1000);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.exception?.values?.[0]?.value, "kaboom");
  });
});
