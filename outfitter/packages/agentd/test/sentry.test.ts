// sentry.ts: SENTRY_DSN gates everything (unset by default -- every export becomes a no-op);
// when it's set, captureException/withSentrySpan report to Sentry. Sentry processes captured
// events off an internal queue, not synchronously, so assertions on a beforeSend spy await
// Sentry.flush() first.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initSentry, sentryEnabled, captureException, withSentrySpan, tagRun, resetSentryForTests, Sentry } from "../src/sentry.js";

afterEach(() => {
  resetSentryForTests();
});

describe("initSentry", () => {
  test("does nothing without a DSN -- sentryEnabled() stays false", () => {
    initSentry("");
    assert.equal(sentryEnabled(), false);
  });

  test("turns on with a DSN", () => {
    initSentry("https://examplePublicKey@o0.ingest.sentry.io/0");
    assert.equal(sentryEnabled(), true);
  });

  test("only the first call takes effect -- a later call with no DSN doesn't turn it back off", () => {
    initSentry("https://examplePublicKey@o0.ingest.sentry.io/0");
    initSentry("");
    assert.equal(sentryEnabled(), true);
  });
});

describe("tagRun", () => {
  test("is a no-op when Sentry is off", () => {
    assert.doesNotThrow(() => tagRun("run1"));
  });

  test("tags events with the run id once Sentry is on", async () => {
    const captured: Array<{ tags?: Record<string, unknown> }> = [];
    initSentry("https://examplePublicKey@o0.ingest.sentry.io/0");
    Sentry.init({
      dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      tracesSampleRate: 0.05,
      beforeSend(event) {
        captured.push(event);
        return null;
      },
    });
    tagRun("run-abc");
    captureException(new Error("boom"));
    await Sentry.flush(1000);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.tags?.runId, "run-abc");
  });
});

describe("captureException", () => {
  test("is a no-op when Sentry is off", () => {
    assert.doesNotThrow(() => captureException(new Error("ignored")));
  });

  test("reports the error when Sentry is on", async () => {
    const captured: Array<{ exception?: { values?: Array<{ value?: string }> } }> = [];
    initSentry("https://examplePublicKey@o0.ingest.sentry.io/0");
    Sentry.init({
      dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      tracesSampleRate: 0.05,
      beforeSend(event) {
        captured.push(event);
        return null;
      },
    });
    captureException(new Error("clone failed"), { runId: "r1" });
    await Sentry.flush(1000);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.exception?.values?.[0]?.value, "clone failed");
  });
});

describe("withSentrySpan", () => {
  test("runs the task untraced when Sentry is off", async () => {
    const result = await withSentrySpan("run", "agentd.run", async () => 42);
    assert.equal(result, 42);
  });

  test("runs the task inside a span when Sentry is on", async () => {
    initSentry("https://examplePublicKey@o0.ingest.sentry.io/0");
    let sawActiveSpan = false;
    const result = await withSentrySpan("run", "agentd.run", async () => {
      sawActiveSpan = Sentry.getActiveSpan() !== undefined;
      return "done";
    });
    assert.equal(result, "done");
    assert.equal(sawActiveSpan, true);
  });

  test("reports a thrown error and re-throws it, so the caller's own error handling still runs", async () => {
    const captured: Array<{ exception?: { values?: Array<{ value?: string }> } }> = [];
    initSentry("https://examplePublicKey@o0.ingest.sentry.io/0");
    Sentry.init({
      dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      tracesSampleRate: 1,
      beforeSend(event) {
        captured.push(event);
        return null;
      },
    });
    await assert.rejects(
      withSentrySpan("run", "agentd.run", async () => {
        throw new Error("clone failed");
      }),
      /clone failed/,
    );
    await Sentry.flush(1000);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.exception?.values?.[0]?.value, "clone failed");
  });
});
