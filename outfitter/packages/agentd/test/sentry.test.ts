// sentry.ts: run.spec's `telemetry` (the fleet settings, sent only while Sentry is on) gates
// everything -- absent, every export is a no-op; present, captureException/withSentrySpan report to
// Sentry. A fake transport stands in for the network: Sentry processes captured events off an
// internal queue, so assertions await Sentry.flush() first.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initSentry, sentryEnabled, captureException, withSentrySpan, tagRun, resetSentryForTests, Sentry } from "../src/sentry.js";

const SETTINGS = { dsn: "https://examplePublicKey@o0.ingest.sentry.io/0", tracesSampleRate: 0.05, environment: "test" };

type Event = { tags?: Record<string, unknown>; exception?: { values?: Array<{ value?: string }> } };

function fakeTransport() {
  const events: Event[] = [];
  const transport: NonNullable<Parameters<typeof initSentry>[1]> = () => ({
    send: async (envelope) => {
      for (const [header, payload] of envelope[1] as Array<[{ type: string }, Event]>) {
        if (header.type === "event") events.push(payload);
      }
      return {};
    },
    flush: async () => true,
  });
  return { transport, events };
}

afterEach(async () => {
  await resetSentryForTests();
});

describe("initSentry", () => {
  test("does nothing without telemetry -- sentryEnabled() stays false", () => {
    initSentry(undefined);
    assert.equal(sentryEnabled(), false);
  });

  test("turns on with the run.spec's telemetry", () => {
    initSentry(SETTINGS, fakeTransport().transport);
    assert.equal(sentryEnabled(), true);
  });

  test("only the first call takes effect", () => {
    initSentry(SETTINGS, fakeTransport().transport);
    initSentry(undefined);
    assert.equal(sentryEnabled(), true);
  });
});

describe("tagRun", () => {
  test("is a no-op when Sentry is off", () => {
    assert.doesNotThrow(() => tagRun("run1"));
  });

  test("a run id tagged before Sentry starts still lands on its events", async () => {
    const { transport, events } = fakeTransport();
    tagRun("run-abc");
    initSentry(SETTINGS, transport);
    captureException(new Error("boom"));
    await Sentry.flush(1000);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.tags?.runId, "run-abc");
  });
});

describe("captureException", () => {
  test("is a no-op when Sentry is off", () => {
    assert.doesNotThrow(() => captureException(new Error("ignored")));
  });

  test("reports the error when Sentry is on", async () => {
    const { transport, events } = fakeTransport();
    initSentry(SETTINGS, transport);
    captureException(new Error("clone failed"), { runId: "r1" });
    await Sentry.flush(1000);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.exception?.values?.[0]?.value, "clone failed");
  });
});

describe("withSentrySpan", () => {
  test("runs the task untraced when Sentry is off", async () => {
    const result = await withSentrySpan("run", "agentd.run", async () => 42);
    assert.equal(result, 42);
  });

  test("runs the task inside a span when Sentry is on", async () => {
    initSentry(SETTINGS, fakeTransport().transport);
    let sawActiveSpan = false;
    const result = await withSentrySpan("run", "agentd.run", async () => {
      sawActiveSpan = Sentry.getActiveSpan() !== undefined;
      return "done";
    });
    assert.equal(result, "done");
    assert.equal(sawActiveSpan, true);
  });

  test("re-throws a thrown error without reporting it itself (the caller's fail() does, once)", async () => {
    const { transport, events } = fakeTransport();
    initSentry({ ...SETTINGS, tracesSampleRate: 1 }, transport);
    await assert.rejects(
      withSentrySpan("run", "agentd.run", async () => {
        throw new Error("clone failed");
      }),
      /clone failed/,
    );
    await Sentry.flush(1000);
    assert.equal(events.length, 0);
  });
});
