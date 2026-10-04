/**
 * Thin wrapper around `@sentry/node`'s module-level state (`init`/`captureException`/
 * `startInactiveSpan` are free functions sharing one hidden client). index.ts calls only these,
 * so a test can swap in a `SentryLike` fake and check call sequencing and arguments without a real
 * Sentry client or network: `@sentry/node`'s own `init()` starts OpenTelemetry instrumentation that
 * doesn't tear down cleanly between test cases.
 *
 * Process-wide state, on globalThis: pi loads each extension through its own jiti with
 * `moduleCache: false` and builds a fresh instance on every /new, /resume, /fork and /reload, so a
 * module-level "already started" flag would be a new `false` each time and start the SDK again. The
 * SDK itself can start only once per process; after that, `applySentry` only moves the live gate
 * (`sending`, `tracesSampleRate`) that beforeSend and the sampler read on every event. That is how
 * `/sentry off`, or Outfitter turning Sentry off mid-session, stops sending at once.
 *
 * `startInactiveSpan` (not `startSpan`) because pi's lifecycle hands this extension a start event
 * and, later, a separate end event for the same operation (agent_start/agent_end,
 * tool_execution_start/tool_execution_end): the span has to live across that gap, which
 * `startSpan`'s single callback does not allow.
 */
import type * as SentryNode from "@sentry/node";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NO_SIGNALS, signalsOf, type SentryDecision, type Signals } from "./config.ts";
import { scrubEvent, type CrashRecord } from "./lib.ts";

/** A started-but-not-yet-ended span: the handle index.ts holds between a start and end event. */
export interface SentrySpan {
  setStatus(outcome: "ok" | "error"): void;
  /** Attributes learned after the start (a model call's usage, a tool's result). */
  setAttributes(attributes: Record<string, string | number | boolean>): void;
  end(): void;
  /** False when the sampler dropped it (then so are its children): no point building content. */
  sampled?: boolean;
  /** The SDK's own span, for parenting another span to this one. */
  raw?: unknown;
}

export interface SentryInit {
  dsn: string;
  environment: string;
  release?: string;
  /** Read on every event, trace and metric; the live gate. */
  gate: () => { sending: boolean; tracesSampleRate: number; signals: Signals };
}

/** The subset of the `@sentry/node` module surface this extension uses, as an interface so tests
 * can substitute a fake. The real module satisfies this structurally. */
export interface SentryLike {
  /** May load the SDK first, so it may be async; applySentry waits for it. */
  init(options: SentryInit): void | Promise<void>;
  captureException(error: unknown, context?: { tags?: Record<string, string>; fingerprint?: string[] }): string;
  /** `parent`: the span this one belongs to (pi's events give no active-span context, so it is
   * passed explicitly); with `onlyIfParent`, no span at all without one. A child of an unsampled
   * span is unsampled too, so a run and its tool calls are kept or dropped together. */
  startInactiveSpan(options: { name: string; op: string; attributes?: Record<string, string | number | boolean>; parent?: SentrySpan; onlyIfParent?: boolean }): SentrySpan;
  /** A crash pi recorded in an earlier run (lib.ts CrashRecord), as a fatal event. */
  captureCrash(crash: CrashRecord): void;
  /** A counter (`Sentry.metrics.count`); sent only while the metrics signal is on (#424). */
  count(name: string, value: number, attributes?: Record<string, string>): void;
  /** Waits (at most `timeoutMs`) until what is queued has been sent. */
  flush(timeoutMs: number): Promise<boolean>;
}

/** `@sentry/node`'s span status is a numeric code (1 = ok, 2 = error); this hides that encoding
 * from index.ts, which only ever sets one of two outcomes. */
function toSpanStatus(outcome: "ok" | "error"): { code: 1 | 2 } {
  return { code: outcome === "ok" ? 1 : 2 };
}

/**
 * Default integrations minus two:
 *   - Console: every console line any extension writes would ride along as a breadcrumb on the next
 *     error, and on a coding agent those lines can quote the person's code or prompts.
 *   - OnUnhandledRejection: any `unhandledRejection` listener stops Node from crashing on an
 *     unhandled rejection, and pi registers none. Without it, the rejection is raised as an
 *     uncaught exception as before, which OnUncaughtException still reports. (In interactive mode
 *     pi's own handler exits first, so a crash there is in pi's crash report, not Sentry.)
 */
const DROPPED_INTEGRATIONS = new Set([
  "Console",
  "OnUnhandledRejection",
  // The AI SDK auto-instrumentations (#424): Kernal makes its own gen_ai spans from pi's events
  // (agent.ts), behind the fleet's agentTraces and agentContent settings. These would add a second,
  // ungated span per model call if they ever hooked pi's provider SDKs.
  "OpenAI", "Anthropic_AI", "Google_GenAI", "Mistral", "Groq", "TogetherAI", "LangChain", "LangGraph", "Mastra", "VercelAI",
]);

/** A metric as it leaves: without `server.address` (@sentry/node adds the hostname to every metric,
 * and it is usually the person's name) and with the home directory as `~` in its attributes. */
export function scrubMetric<M extends { attributes?: Record<string, unknown> }>(metric: M, home: string): M {
  const { "server.address": _host, ...attributes } = metric.attributes ?? {};
  for (const [k, v] of Object.entries(attributes)) {
    if (typeof v === "string" && home && home !== "/") attributes[k] = v.split(home).join("~");
  }
  return { ...metric, attributes };
}

/**
 * `@sentry/node` ships with the other extension packages in the agent dir's npm/ (kernal/.pi/npm,
 * which scripts/package.sh installs exactly as locked into every bundle). This extension sits outside
 * that tree, so a bare import would not find it in a bundle. It is imported by absolute path to its
 * ESM entry: pi's compiled (Bun) binary resolves the SDK's own imports of its sibling packages that
 * way, but not through createRequire, whose CommonJS lookups fail inside the binary. Loaded on first
 * use only: while Sentry is off (the default) its OpenTelemetry instrumentation never loads at all.
 */
export function sentryNodeEntry(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): string {
  return join(agentDir, "npm", "node_modules", "@sentry", "node", "build", "esm", "index.js");
}
/** The SDK module, kept in the process state (not a module variable): a reload re-evaluates this
 * file, and a fresh `undefined` here would leave a running SDK with no handle to call. */
async function loadSentryNode(): Promise<typeof SentryNode> {
  const s = state();
  return (s.sdk ??= (await import(pathToFileURL(sentryNodeEntry()).href)) as typeof SentryNode);
}

export const realSentry: SentryLike = {
  async init(options) {
    const home = homedir();
    const Sentry = await loadSentryNode();
    const sending = () => options.gate().sending;
    Sentry.init({
      dsn: options.dsn,
      environment: options.environment,
      ...(options.release ? { release: options.release } : {}),
      // The function form: an array is added to the defaults, so filtering a copy drops nothing.
      integrations: (defaults) => defaults.filter((i) => !DROPPED_INTEGRATIONS.has(i.name)),
      // A run's spans leave together as one transaction once it ends, where beforeSendTransaction
      // can gate and scrub them. The SDK's default ("stream") sends spans one by one through a hook
      // that can edit but never drop one, and it ignores beforeSendTransaction, with a warning.
      traceLifecycle: "static",
      // No sentry-trace/baggage headers on outbound requests (the SDK's default is every host):
      // they would tell each LLM provider the Kernal version, the Sentry org and one id that is the
      // same across all of them, and would keep doing so while Sentry is off.
      tracePropagationTargets: [],
      tracesSampler: ({ parentSampled }) => (sending() ? (parentSampled ?? options.gate().tracesSampleRate) : 0),
      beforeSend: (event) => (sending() ? scrubEvent(event, home) : null),
      beforeSendTransaction: (event) => (sending() ? scrubEvent(event, home) : null),
      // Metrics only with their own fleet setting on too (#424). The SDK collects them whenever it
      // runs; index.ts counts nothing while off, and this drops anything that slips past.
      beforeSendMetric: (metric) => (sending() && options.gate().signals.metrics ? scrubMetric(metric, home) : null),
      // The gate again, at the wire: besides events, the SDK sends client reports (counts of what
      // the gates above dropped) and a session at exit. While off, nothing at all leaves.
      transport: (transportOptions) => {
        const wire = Sentry.makeNodeTransport(transportOptions);
        return { send: (envelope) => (sending() ? wire.send(envelope) : Promise.resolve({})), flush: (timeout) => wire.flush(timeout) };
      },
    });
  },
  // Both run only while sending(), which applySentry sets only once init has loaded the SDK.
  captureException(error, context) {
    return state().sdk!.captureException(error, context);
  },
  captureCrash(crash) {
    const error = new Error(crash.message || "(crash without message)");
    error.name = crash.kind === "uncaught_exception" ? "UncaughtException" : "Crash";
    if (crash.stack) error.stack = crash.stack; // the SDK parses frames from it
    // Grouped by the top stack frames only: the message's paths and ids would split one bug into
    // many issues. When it happened goes in extra, not a tag (tags are for low-cardinality values).
    const frames = (crash.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l)).slice(0, 3).map((l) => l.trim());
    state().sdk!.captureException(error, {
      level: "fatal",
      tags: { source: "crash", ...(crash.kind ? { kind: crash.kind } : {}), ...(crash.version ? { pi_version: crash.version } : {}) },
      extra: { crashedAt: crash.timestamp },
      fingerprint: ["crash", error.name, ...(frames.length ? frames : [error.message])],
    });
  },
  count(name, value, attributes) {
    state().sdk!.metrics.count(name, value, attributes ? { attributes } : undefined);
  },
  async flush(timeoutMs) {
    return (await state().sdk?.flush(timeoutMs)) ?? true;
  },
  startInactiveSpan({ parent, onlyIfParent, ...options }) {
    const span = state().sdk!.startInactiveSpan({
      ...options,
      ...(parent ? { parentSpan: parent.raw as SentryNode.Span } : {}),
      ...(onlyIfParent ? { onlyIfParent: true } : {}),
    });
    return {
      setStatus: (outcome) => { span.setStatus(toSpanStatus(outcome)); },
      setAttributes: (attributes) => { span.setAttributes(attributes); },
      end: () => { span.end(); },
      sampled: span.isRecording(),
      raw: span,
    };
  },
};

interface ProcessState {
  /** The DSN the SDK started (or is starting) with; unset until the first "on". */
  dsn?: string;
  /** Settles once the SDK has started, or failed to. */
  starting?: Promise<void>;
  started: boolean;
  /** The SDK failed to start once; stay off for the rest of the process. */
  failed: boolean;
  sending: boolean;
  tracesSampleRate: number;
  /** The #424 signals in force (config.ts Signals); all off unless sending. */
  signals: Signals;
  /** The latest decision, which wins when a start that began earlier finishes. */
  want?: SentryDecision;
  /** The loaded SDK module (realSentry only). */
  sdk?: typeof SentryNode;
  /** Bumped by every extension instance (newInstance); an older instance's late apply is ignored. */
  instance: number;
  /** Earlier runs' crashes were reported (or claimed) by this process (claimCrashReport). */
  crashesClaimed?: boolean;
}

const SLOT = Symbol.for("kernal.sentry");
type Slot = { [SLOT]?: ProcessState };

function state(): ProcessState {
  const g = globalThis as Slot;
  return (g[SLOT] ??= { started: false, failed: false, sending: false, tracesSampleRate: 0, signals: { ...NO_SIGNALS }, instance: 0 });
}

/** A new extension instance (pi re-instantiates on /new, /resume, /fork, /reload): returns its
 * number. Only the newest instance's decisions count from then on (isCurrent). */
export function newInstance(): number {
  return ++state().instance;
}

export function isCurrent(instance: number): boolean {
  return state().instance === instance;
}

/** True the first time it is called in a process: earlier runs' crashes are reported once, not by
 * every extension instance a /new or /reload creates. */
export function claimCrashReport(): boolean {
  const s = state();
  if (s.crashesClaimed) return false;
  s.crashesClaimed = true;
  return true;
}

/** For `/sentry`: what this process is actually doing, beside what was decided. */
export function liveStatus(): "sending" | "starting" | "failed" | "restart-needed" | "idle" {
  const s = state();
  if (s.sending) return "sending";
  if (s.failed) return "failed";
  if (s.dsn !== undefined && !s.started) return "starting";
  if (s.started && s.want?.on && s.want.dsn !== s.dsn) return "restart-needed";
  return "idle";
}

/** Whether events leave this process right now. index.ts checks it before starting a span. */
export function sending(): boolean {
  return state().sending;
}

/** The #424 signals in force right now: all off while nothing is sent. */
export function liveSignals(): Signals {
  const s = state();
  return s.sending ? s.signals : { ...NO_SIGNALS };
}

/**
 * Puts a decision into force for the whole process. Off: stop sending at once. On: start the SDK the
 * first time (resolving when it has), then send. A different DSN than the one the SDK started with
 * cannot take effect until Kernal restarts, so until then nothing is sent rather than sending to the
 * old project. Never rejects: telemetry must never stop Kernal starting (an extension that throws
 * fails pi's whole start-up), so a failed start is said once on stderr and leaves Sentry off.
 */
export async function applySentry(decision: SentryDecision, runtime: { environment: string; release?: string }, sentry: SentryLike = realSentry): Promise<void> {
  const s = state();
  s.want = decision;
  if (!decision.on) {
    s.sending = false;
    s.signals = { ...NO_SIGNALS };
    return;
  }
  s.tracesSampleRate = decision.tracesSampleRate;
  s.signals = signalsOf(decision);
  if (s.failed) return;
  if (s.dsn === undefined) {
    s.dsn = decision.dsn;
    const init: SentryInit = { dsn: decision.dsn, environment: runtime.environment, ...(runtime.release ? { release: runtime.release } : {}), gate: () => state() };
    s.starting = (async () => sentry.init(init))().then(
      () => { s.started = true; },
      (err) => {
        s.failed = true;
        console.error(`kernal: Sentry did not start (${err instanceof Error ? err.message : String(err)}); continuing without it.`);
      },
    );
  }
  await s.starting;
  const want = s.want;
  s.sending = s.started && want?.on === true && want.dsn === s.dsn;
}

/** Test-only: forget the process state, so a fresh fake client can be started again. */
export function _resetSentryState(): void {
  delete (globalThis as Slot)[SLOT];
}
