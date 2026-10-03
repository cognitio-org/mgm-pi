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
import type { SentryDecision } from "./config.ts";
import { scrubEvent } from "./lib.ts";

/** A started-but-not-yet-ended span: the handle index.ts holds between a start and end event. */
export interface SentrySpan {
  setStatus(outcome: "ok" | "error"): void;
  end(): void;
}

export interface SentryInit {
  dsn: string;
  environment: string;
  release?: string;
  /** Read on every event and trace; the live gate. */
  gate: () => { sending: boolean; tracesSampleRate: number };
}

/** The subset of the `@sentry/node` module surface this extension uses, as an interface so tests
 * can substitute a fake. The real module satisfies this structurally. */
export interface SentryLike {
  /** May load the SDK first, so it may be async; applySentry waits for it. */
  init(options: SentryInit): void | Promise<void>;
  captureException(error: unknown, context?: { tags?: Record<string, string> }): string;
  startInactiveSpan(options: { name: string; op: string; attributes?: Record<string, string | number | boolean> }): SentrySpan;
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
const DROPPED_INTEGRATIONS = new Set(["Console", "OnUnhandledRejection"]);

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
      tracesSampler: ({ parentSampled }) => (sending() ? (parentSampled ?? options.gate().tracesSampleRate) : 0),
      beforeSend: (event) => (sending() ? scrubEvent(event, home) : null),
      beforeSendTransaction: (event) => (sending() ? scrubEvent(event, home) : null),
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
  startInactiveSpan(options) {
    const span = state().sdk!.startInactiveSpan(options);
    return {
      setStatus: (outcome) => { span.setStatus(toSpanStatus(outcome)); },
      end: () => { span.end(); },
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
  /** The latest decision, which wins when a start that began earlier finishes. */
  want?: SentryDecision;
  /** The loaded SDK module (realSentry only). */
  sdk?: typeof SentryNode;
  /** Bumped by every extension instance (newInstance); an older instance's late apply is ignored. */
  instance: number;
}

const SLOT = Symbol.for("kernal.sentry");
type Slot = { [SLOT]?: ProcessState };

function state(): ProcessState {
  const g = globalThis as Slot;
  return (g[SLOT] ??= { started: false, failed: false, sending: false, tracesSampleRate: 0, instance: 0 });
}

/** A new extension instance (pi re-instantiates on /new, /resume, /fork, /reload): returns its
 * number. Only the newest instance's decisions count from then on (isCurrent). */
export function newInstance(): number {
  return ++state().instance;
}

export function isCurrent(instance: number): boolean {
  return state().instance === instance;
}

/** Whether events leave this process right now. index.ts checks it before starting a span. */
export function sending(): boolean {
  return state().sending;
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
    return;
  }
  s.tracesSampleRate = decision.tracesSampleRate;
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
