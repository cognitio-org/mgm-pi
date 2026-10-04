/**
 * Sentry (error reporting, tracing, and since #424 logs, metrics, AI agent spans and profiles) for
 * the agentd daemon runtime, switched by the fleet settings an operator sets in the web app: the
 * API sends them in run.spec's `telemetry` (protocol.ts RunSpecTelemetry) only while Sentry is on,
 * so a Drive needs no Sentry env of its own. Until then, and for a run.spec without `telemetry`,
 * initSentry() is never called and every export here is a harmless no-op, so call sites never need
 * their own "is Sentry on" branch.
 *
 * RunController calls initSentry() as the run.spec arrives, before begin(), so withSentrySpan can
 * wrap a run's start-up (RunController.begin: clone, restore, pi ready) in a trace at the fleet's
 * sample rate. Anything that throws before run.spec (a misconfigured deployment's missing
 * OUTFITTER_API/RUN_ID) is only in the logs: there is nowhere to send it yet.
 *
 * #424's signals, each off unless run.spec says on (and run.spec says nothing while Sentry is off):
 *   - logs: every INFO/WARNING/ERROR line of logger.ts, already redacted there, redacted again for
 *     secret-shaped strings (redact.ts) and clipped, as a Sentry log.
 *   - metrics: tool calls, tokens and cost (agentMetrics, fed by agent-trace.ts).
 *   - agentTraces / agentContent: agent-trace.ts's gen_ai spans. Every agent run is kept (sampled
 *     at 1, not at the trace rate): the operator turned them on to see them, and a sample would
 *     make a run's cost and token totals a guess.
 *   - profilesSampleRate: @sentry/profiling-node, profiling while a sampled span is open.
 */
import * as Sentry from "@sentry/node";
import type { RunSpecTelemetry } from "./protocol.js";
import { setLogSink, type LogFields } from "./logger.js";
import { redact } from "./redact.js";

export interface SentrySignals {
  logs: boolean;
  metrics: boolean;
  agentTraces: boolean;
  agentContent: boolean;
  profilesSampleRate: number;
}

const OFF: SentrySignals = { logs: false, metrics: false, agentTraces: false, agentContent: false, profilesSampleRate: 0 };

type ProfilerFactory = () => ReturnType<typeof Sentry.consoleIntegration>;

export interface SentryTestOptions {
  /** Stands in for loading @sentry/profiling-node (a native add-on). */
  loadProfiler?: () => Promise<ProfilerFactory>;
}

/** The attribute agent-trace.ts puts on a pi agent run's root span, which tracesSampler keeps. */
export const AGENT_ROOT_ATTRIBUTE = "gen_ai.operation.name";
export const AGENT_ROOT_VALUE = "invoke_agent";

let initialized = false;
let runId: string | undefined;
let signals: SentrySignals = OFF;
let profiler: Promise<boolean> | undefined;

/** run.spec's switches as booleans and a rate; agentContent needs agentTraces. */
export function signalsFrom(settings: RunSpecTelemetry["sentry"] | undefined): SentrySignals {
  if (!settings?.dsn) return OFF;
  const rate = settings.profilesSampleRate;
  return {
    logs: settings.logs === true,
    metrics: settings.metrics === true,
    agentTraces: settings.agentTraces === true,
    agentContent: settings.agentTraces === true && settings.agentContent === true,
    profilesSampleRate: typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : 0,
  };
}

/** Starts the Sentry Node SDK for this process. Absent settings do nothing; only the first call
 * takes effect (agentd is one process per run, and run.spec's telemetry never changes mid-run).
 * `transport` is for tests. */
export function initSentry(settings: RunSpecTelemetry["sentry"] | undefined, transport?: Sentry.NodeOptions["transport"], test: SentryTestOptions = {}): void {
  if (!settings?.dsn || initialized) return;
  signals = signalsFrom(settings);
  const traceRate = settings.tracesSampleRate;
  Sentry.init({
    dsn: settings.dsn,
    // A pi agent run's root span is kept whenever agent traces are on (see the module comment);
    // everything else at the fleet's rate, children with their parent.
    tracesSampler: (ctx) => {
      if (signals.agentTraces && ctx.attributes?.[AGENT_ROOT_ATTRIBUTE] === AGENT_ROOT_VALUE) return 1;
      if (typeof ctx.parentSampled === "boolean") return ctx.parentSampled ? 1 : 0;
      return traceRate;
    },
    // No sentry-trace/baggage headers on outbound calls (GitHub, LiteLLM, the API): the SDK's
    // default is every host.
    tracePropagationTargets: [],
    // Spans leave as whole transactions; SDK 11's default ("stream") sends them one by one.
    traceLifecycle: "static",
    // Defaults minus OnUnhandledRejection: its listener would turn Node's crash on an unhandled
    // rejection into a warning.
    integrations: (defaults) => defaults.filter((i) => i.name !== "OnUnhandledRejection"),
    environment: settings.environment,
    ...(settings.release ? { release: settings.release } : {}),
    ...(transport ? { transport } : {}),
    // SDK 11 sends a log or metric whenever Sentry.logger / Sentry.metrics is called (there is no
    // enableLogs switch); only this module calls them, and these hooks gate them again.
    beforeSendLog: (log) => (signals.logs ? log : null),
    beforeSendMetric: (metric) => (signals.metrics ? metric : null),
    // Read by the profiling integration when startProfiler adds it. Whether this run is profiled
    // is drawn once, at this rate.
    ...(signals.profilesSampleRate > 0 ? { profileSessionSampleRate: signals.profilesSampleRate, profileLifecycle: "trace" as const } : {}),
  });
  if (runId) Sentry.setTag("runId", runId);
  initialized = true;
  if (signals.logs) setLogSink(forwardLog);
  if (signals.profilesSampleRate > 0) profiler = startProfiler(test);
}

/** Loads @sentry/profiling-node (a native add-on; Node 24's linux x64/arm64 glibc binaries ship in
 * the package) and adds it to the running SDK. Not loadable: a warning, and no profiles. */
async function startProfiler(test: SentryTestOptions): Promise<boolean> {
  let factory: ProfilerFactory;
  try {
    factory = test.loadProfiler ? await test.loadProfiler() : ((await import("@sentry/profiling-node")).nodeProfilingIntegration as unknown as ProfilerFactory);
  } catch (err) {
    console.warn(`[agentd] sentry: profiling is on but @sentry/profiling-node did not load, so this run sends no profiles: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (!initialized) return false;
  Sentry.addIntegration(factory());
  return true;
}

const LOG_MESSAGE_MAX = 4096;
const LOG_ATTRIBUTE_MAX = 1024;
const LOG_LEVEL = { INFO: "info", WARNING: "warn", ERROR: "error" } as const;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** logger.ts's sink: one line as a Sentry log. Fields arrive redacted for the run's own secrets;
 * strings are redacted again for secret-shaped ones, objects go as clipped JSON. Exported for
 * tests. */
export function toSentryLog(message: string, fields: LogFields): { message: string; attributes: Record<string, string | number | boolean> } {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") attributes[key] = clip(redact(value), LOG_ATTRIBUTE_MAX);
    else if (typeof value === "number" || typeof value === "boolean") attributes[key] = value;
    else {
      try {
        attributes[key] = clip(redact(JSON.stringify(value)), LOG_ATTRIBUTE_MAX);
      } catch {
        // unserialisable: left out
      }
    }
  }
  return { message: clip(redact(message), LOG_MESSAGE_MAX), attributes };
}

function forwardLog(severity: keyof typeof LOG_LEVEL, message: string, fields: LogFields): void {
  if (!initialized || !signals.logs) return;
  const log = toSentryLog(message, fields);
  Sentry.logger[LOG_LEVEL[severity]](log.message, log.attributes);
}

/** Which agent-span signals are on: agent-trace.ts records nothing without `traces`, and no
 * prompt, response or tool input/output without `content`. */
export function agentTraceSignals(): { traces: boolean; content: boolean } {
  return { traces: initialized && signals.agentTraces, content: initialized && signals.agentContent };
}

export type MetricAttributes = Record<string, string | number | boolean>;

/** Sentry.metrics while metrics are on; a no-op otherwise. Attributes are fixed, short values (a
 * tool name, a model, an outcome), never content. */
export const agentMetrics = {
  count(name: string, attributes?: MetricAttributes, value = 1): void {
    if (initialized && signals.metrics) Sentry.metrics.count(name, value, attributes ? { attributes } : undefined);
  },
  distribution(name: string, value: number, unit?: string, attributes?: MetricAttributes): void {
    if (!initialized || !signals.metrics || !Number.isFinite(value)) return;
    Sentry.metrics.distribution(name, value, { ...(unit ? { unit } : {}), ...(attributes ? { attributes } : {}) });
  },
};

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

/** Test-only: whether the profiler started (undefined: never asked for). */
export function profilerStartedForTests(): Promise<boolean> | undefined {
  return profiler;
}

/** Test-only: forgets the SDK state so each test gets a clean slate. */
export async function resetSentryForTests(): Promise<void> {
  await Sentry.getClient()?.close(0);
  initialized = false;
  runId = undefined;
  signals = OFF;
  profiler = undefined;
  setLogSink(undefined);
}

export { Sentry };
