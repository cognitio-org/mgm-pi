/**
 * Thin wrapper around `@sentry/node`'s module-level state (`init`/`captureException`/
 * `startInactiveSpan` are all free functions sharing one hidden client). index.ts calls only these,
 * so a test can swap in a `SentryLike` fake and check call sequencing and arguments without a real
 * Sentry client or network: `@sentry/node`'s own `init()` starts OpenTelemetry instrumentation that
 * doesn't tear down cleanly between test cases.
 *
 * `startInactiveSpan` (not `startSpan`) because pi's lifecycle hands this extension a start event
 * and, later, a separate end event for the same operation (agent_start/agent_end,
 * tool_execution_start/tool_execution_end): the span has to live across that gap, which
 * `startSpan`'s single callback does not allow.
 */
import * as Sentry from "@sentry/node";
import type { SentryConfig } from "./config.ts";

/** A started-but-not-yet-ended span: the handle index.ts holds between a start and end event. */
export interface SentrySpan {
  setStatus(outcome: "ok" | "error"): void;
  end(): void;
}

/** The subset of the `@sentry/node` module surface this extension uses, as an interface so tests
 * can substitute a fake. The real module satisfies this structurally. */
export interface SentryLike {
  init(options: { dsn: string; environment: string; tracesSampleRate: number; release?: string }): void;
  captureException(error: unknown, context?: { tags?: Record<string, string> }): string;
  startInactiveSpan(options: { name: string; op: string; attributes?: Record<string, string | number | boolean> }): SentrySpan;
  isInitialized(): boolean;
  close(timeoutMs?: number): Promise<boolean>;
}

/** `@sentry/node`'s span status is a numeric code (1 = ok, 2 = error); this hides that encoding
 * from index.ts, which only ever sets one of two outcomes. */
function toSpanStatus(outcome: "ok" | "error"): { code: 1 | 2 } {
  return { code: outcome === "ok" ? 1 : 2 };
}

export const realSentry: SentryLike = {
  init(options) {
    Sentry.init({ ...options, integrations: Sentry.getDefaultIntegrations({}) });
  },
  captureException(error, context) {
    return Sentry.captureException(error, context);
  },
  startInactiveSpan(options) {
    const span = Sentry.startInactiveSpan(options);
    return {
      setStatus: (outcome) => { span.setStatus(toSpanStatus(outcome)); },
      end: () => { span.end(); },
    };
  },
  isInitialized() {
    return Sentry.isInitialized();
  },
  close(timeoutMs) {
    return Sentry.close(timeoutMs);
  },
};

let initialized = false;

/** Calls `sentry.init` at most once per process; a second `initSentryOnce` with a different config
 * (there is no such caller today) is silently ignored rather than re-initializing mid-session. */
export function initSentryOnce(config: SentryConfig, release: string | undefined, sentry: SentryLike = realSentry): boolean {
  if (!config.enabled || !config.dsn) return false;
  if (initialized) return true;
  sentry.init({ dsn: config.dsn, environment: config.environment, tracesSampleRate: config.tracesSampleRate, ...(release ? { release } : {}) });
  initialized = true;
  return true;
}

/** Test-only: forget that `init` ran, so a fresh fake client can be initialized again. */
export function _resetSentryInitState(): void {
  initialized = false;
}
