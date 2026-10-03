/**
 * Sentry (error reporting + tracing) for the agentd daemon runtime, switched by the fleet settings an
 * operator sets in the web app: the API sends them in run.spec's `telemetry` (protocol.ts
 * RunSpecTelemetry) only while Sentry is on, so a Drive needs no Sentry env of its own. Until then,
 * and for a run.spec without `telemetry`, initSentry() is never called and every export here is a
 * harmless no-op, so call sites never need their own "is Sentry on" branch.
 *
 * RunController calls initSentry() as the run.spec arrives, before begin(), so withSentrySpan can
 * wrap a run's start-up (RunController.begin: clone, restore, pi ready) in a trace at the fleet's
 * sample rate. Anything that throws before run.spec (a misconfigured deployment's missing
 * OUTFITTER_API/RUN_ID) is only in the logs: there is nowhere to send it yet.
 */
import * as Sentry from "@sentry/node";
import type { RunSpecTelemetry } from "./protocol.js";

let initialized = false;
let runId: string | undefined;

/** Starts the Sentry Node SDK for this process. Absent settings do nothing; only the first call
 * takes effect (agentd is one process per run, and run.spec's telemetry never changes mid-run).
 * `transport` is for tests. */
export function initSentry(settings: RunSpecTelemetry["sentry"] | undefined, transport?: Sentry.NodeOptions["transport"]): void {
  if (!settings?.dsn || initialized) return;
  Sentry.init({
    dsn: settings.dsn,
    tracesSampleRate: settings.tracesSampleRate,
    // No sentry-trace/baggage headers on outbound calls (GitHub, LiteLLM, the API): the SDK's
    // default is every host.
    tracePropagationTargets: [],
    // Defaults minus OnUnhandledRejection: its listener would turn Node's crash on an unhandled
    // rejection into a warning.
    integrations: (defaults) => defaults.filter((i) => i.name !== "OnUnhandledRejection"),
    environment: settings.environment,
    ...(settings.release ? { release: settings.release } : {}),
    ...(transport ? { transport } : {}),
  });
  if (runId) Sentry.setTag("runId", runId);
  initialized = true;
}

/** Tags every event/span from here on with the run id. Remembered when Sentry is not on yet, so a
 * run id known at boot (main.ts) still lands on events once run.spec starts Sentry. */
export function tagRun(id: string): void {
  runId = id;
  if (initialized) Sentry.setTag("runId", id);
}

export function sentryEnabled(): boolean {
  return initialized;
}

/** Reports an error from the daemon runtime (a failed clone, a pi crash, a checkpoint that threw).
 * A no-op when Sentry is off. */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

/** Wraps a run's task execution (or a single phase of it, e.g. a checkpoint) in a Sentry span, at
 * the fleet's sample rate. Runs the task directly, untraced, when Sentry is off -- callers don't
 * need to branch on sentryEnabled(). A thrown error marks the span and re-throws; reporting it is
 * the caller's job (RunController.fail), so one failure is one event. */
export async function withSentrySpan<T>(name: string, op: string, task: () => Promise<T>): Promise<T> {
  if (!initialized) return task();
  return Sentry.startSpan({ name, op }, async (span) => {
    try {
      return await task();
    } catch (error) {
      span.setStatus({ code: 2, message: "internal_error" });
      throw error;
    }
  });
}

/** Sends what is queued, at most `timeoutMs`: before agentd's process.exit, which would otherwise
 * kill the in-flight request carrying the run's one error. Returns at once while Sentry is off. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (initialized) await Sentry.flush(timeoutMs).catch(() => undefined);
}

/** Test-only: forgets the SDK state so each test gets a clean slate. */
export async function resetSentryForTests(): Promise<void> {
  await Sentry.getClient()?.close(0);
  initialized = false;
  runId = undefined;
}

export { Sentry };
