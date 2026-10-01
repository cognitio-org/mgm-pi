/**
 * Sentry (error reporting + tracing) for the agentd daemon runtime. SENTRY_DSN unset (the default
 * on every non-configured deployment, local dev included) means initSentry() is a no-op and every
 * other export here degrades to a harmless no-op too, so call sites never need their own "is
 * Sentry on" branch.
 *
 * Call initSentry() once, as early as possible in main() (before resolveAssignment/getPiVersion can
 * throw), with the run id once it's known so every event and span this process reports is tagged
 * with it. withSentrySpan wraps a single run's task execution (RunController.begin through its
 * terminal state) in a trace, at the same 5% sample rate as the api (sentry.ts there).
 */
import * as Sentry from "@sentry/node";

/** 5% of task executions get a trace (owner-specified default; see task). Errors are always
 * reported regardless of sampling -- tracesSampleRate only governs performance spans. */
const TRACES_SAMPLE_RATE = 0.05;

let initialized = false;

/** Starts the Sentry Node SDK for this process. Safe to call with an empty DSN (does nothing) and
 * safe to call more than once (only the first call takes effect). `runId` tags every event/span
 * this process reports from here on -- agentd is one process per run, so it never changes. Pass it
 * now if it's already known (the common case); otherwise call tagRun() once it resolves (main.ts's
 * GKE warm-pod wait defers it past this call). */
export function initSentry(dsn: string, runId?: string): void {
  if (!dsn || initialized) return;
  Sentry.init({ dsn, tracesSampleRate: TRACES_SAMPLE_RATE });
  if (runId) Sentry.setTag("runId", runId);
  initialized = true;
}

/** Tags every event/span from here on with the run id, once it's known. A no-op when Sentry is
 * off. */
export function tagRun(runId: string): void {
  if (!initialized) return;
  Sentry.setTag("runId", runId);
}

export function sentryEnabled(): boolean {
  return initialized;
}

/** Reports an error from the daemon runtime (a failed clone, a pi crash, a checkpoint that threw)
 * that isn't already going through withSentrySpan's task. A no-op when Sentry is off. */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

/** Wraps a run's task execution (or a single phase of it, e.g. a checkpoint) in a Sentry span, at
 * the 5% sample rate initSentry() configured. Runs the task directly, untraced, when Sentry is off
 * -- callers don't need to branch on sentryEnabled(). A thrown error is both recorded on the span
 * and reported as an exception (startSpan alone only records it on the span) before it re-throws,
 * so run.ts's existing try/catch and `onExit` paths are unaffected. */
export async function withSentrySpan<T>(name: string, op: string, task: () => Promise<T>): Promise<T> {
  if (!initialized) return task();
  return Sentry.startSpan({ name, op }, async (span) => {
    try {
      return await task();
    } catch (error) {
      span.setStatus({ code: 2, message: "internal_error" });
      Sentry.captureException(error);
      throw error;
    }
  });
}

/** Test-only: resets the module's "already initialized" guard so each test gets a clean slate. */
export function resetSentryForTests(): void {
  initialized = false;
}

export { Sentry };
