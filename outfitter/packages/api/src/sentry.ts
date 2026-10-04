// Sentry (error reporting, tracing, and since #424 logs, metrics and profiles) for the API process,
// switched by the fleet settings an operator sets in the web app (fleet-settings.ts), not by this
// process's env. Off until those settings say on, and every export here is a harmless no-op while
// off, so call sites never need their own "is Sentry on" branch.
//
// buildApp (server.ts) owns the FleetSettingsCache and calls applySentrySettings with every copy it
// reads, so an operator's change reaches each instance within the cache's refresh window:
//   - off → on: the SDK starts then (Sentry.init runs at most once per process).
//   - on → off, or a new sample rate: applied at once; beforeSend/tracesSampler read the live state.
//   - a new DSN: the SDK's DSN is fixed once it starts, so this instance sends nothing until it
//     restarts (the next deploy, or Cloud Run replacing it) rather than keep sending to the old one.
//   - #424's signals (logs, metrics, profilesSampleRate) are read live too, at the call sites and
//     again at the wire (the transport drops a signal's envelope items while it is off). Profiling
//     is decided once per process: the profiler starts the first time Sentry is on with a rate above
//     0, and whether this process is profiled is drawn then, at that rate (Sentry's
//     profileSessionSampleRate). A later rate change applies on the next instance start; a rate of 0
//     stops sending at once.

import * as Sentry from "@sentry/node";
import type { FastifyInstance } from "fastify";
import { sentryOn, sentrySignals, type SentryFleetSettings, type SentrySignals } from "./fleet-settings.ts";
import { redact as redactShared } from "./search/redact.ts";

/** Secret-shaped strings out of a log line: search/redact.ts's patterns (kept byte-identical to
 * Kernal's _shared/redact.ts, which a Kernal test checks), plus Kernal's device tokens and a bare
 * bearer token, which those don't list yet. agentd's redact.ts has all of them. */
const EXTRA_PATTERNS: RegExp[] = [
  /\bkd[acr]_[A-Za-z0-9_-]{16,}/g, // Kernal device access/refresh tokens and device codes (#389)
  /(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of EXTRA_PATTERNS) out = out.replace(re, (match, prefix?: string) => (typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}[redacted]` : "[redacted]"));
  return redactShared(out);
}

export interface SentryRuntime {
  /** The outfitter-v* tag (OUTFITTER_RELEASE); empty in dev. */
  release: string;
  environment: string;
  /** Tests only: where events go instead of the network. */
  transport?: Sentry.NodeOptions["transport"];
  /** Tests only: stands in for loading @sentry/profiling-node (a native add-on). */
  loadProfiler?: () => Promise<ProfilerFactory>;
}

type ProfilerFactory = () => ReturnType<typeof Sentry.consoleIntegration>;

const OFF: SentrySignals = { logs: false, metrics: false, agentTraces: false, agentContent: false, profilesSampleRate: 0 };

let initialized = false;
let initDsn: string | undefined;
let sending = false;
let tracesSampleRate = 0;
let signals: SentrySignals = OFF;
/** The profiler's start, once asked for (startProfiler); resolves to whether it runs. */
let profiler: Promise<boolean> | undefined;

/** Applies the fleet settings' Sentry section to this process (see the module comment). */
export function applySentrySettings(settings: SentryFleetSettings, runtime: SentryRuntime): void {
  if (!sentryOn(settings)) {
    sending = false;
    signals = OFF;
    return;
  }
  tracesSampleRate = settings.tracesSampleRate;
  signals = sentrySignals(settings);
  if (!initialized) {
    const makeTransport = runtime.transport ?? Sentry.makeNodeTransport;
    Sentry.init({
      dsn: settings.dsn,
      environment: runtime.environment,
      ...(runtime.release ? { release: runtime.release } : {}),
      // Defaults minus OnUnhandledRejection: its listener would turn Node's crash on an unhandled
      // rejection into a warning, for the rest of the process even after Sentry is turned off.
      // Fastify's integration keeps its tracing but leaves errors to our onError hook
      // (installSentryErrorHandler), so each route error is one event without relying on Dedupe.
      integrations: (defaults) => [
        ...defaults.filter((i) => i.name !== "OnUnhandledRejection" && i.name !== "Fastify"),
        Sentry.fastifyIntegration({ shouldHandleError: () => false }),
      ],
      // No sentry-trace/baggage headers on outbound calls (GitHub, LiteLLM, GCP, ngrok): the SDK's
      // default is every host, and it keeps adding them while Sentry is off.
      tracePropagationTargets: [],
      // A request's spans leave together as one transaction, which beforeSendTransaction gates.
      // SDK 11's default ("stream") sends spans one by one and skips that hook.
      traceLifecycle: "static",
      // Live gates: the SDK keeps running once started, so turning Sentry off (or changing the
      // rate) must be read per event, not baked into init.
      tracesSampler: () => (sending ? tracesSampleRate : 0),
      // Never the request itself: its headers carry Dongles and IAP assertions, and an operator
      // route's body can be a secret's value. (The SDK starts after Fastify and http are loaded, so
      // its request instrumentation is not hooked in today; this holds if that ever changes.)
      beforeSend: (event) => {
        if (!sending) return null;
        if (event.request) event.request = { method: event.request.method, url: event.request.url?.split("?")[0] };
        return event;
      },
      beforeSendTransaction: (event) => (sending ? event : null),
      // #424: SDK 11 sends a log or a metric whenever Sentry.logger / Sentry.metrics is called (it
      // has no enableLogs switch); only this module calls them, and these hooks gate them again.
      beforeSendLog: (log) => (sending && signals.logs ? log : null),
      beforeSendMetric: (metric) => (sending && signals.metrics ? metric : null),
      // And at the wire: client reports (counts of what the gates dropped) and sessions bypass the
      // hooks above, and profile chunks have none. While off, nothing at all leaves this process;
      // while a signal is off, none of its items do.
      transport: (options) => {
        const wire = makeTransport(options);
        return { send: (envelope) => (sending ? sendAllowed(wire, envelope) : Promise.resolve({})), flush: (timeout) => wire.flush(timeout) };
      },
    });
    initialized = true;
    initDsn = settings.dsn;
  }
  sending = settings.dsn === initDsn;
  if (sending && signals.profilesSampleRate > 0 && !profiler) profiler = startProfiler(signals.profilesSampleRate, runtime);
}

type Transport = ReturnType<NonNullable<Sentry.NodeOptions["transport"]>>;
type Envelope = Parameters<Transport["send"]>[0];

/** The envelope without the items of a signal that is off; nothing at all when none is left. */
function sendAllowed(wire: Transport, envelope: Envelope): ReturnType<Transport["send"]> {
  const [headers, items] = envelope as unknown as [unknown, Array<[{ type?: string }, unknown]>];
  const kept = items.filter(([item]) => itemAllowed(item.type));
  if (kept.length === 0) return Promise.resolve({});
  return wire.send((kept.length === items.length ? envelope : [headers, kept]) as Envelope);
}

/** Whether an envelope item of `type` may leave now (Sentry is on: the caller checked). */
export function itemAllowed(type: string | undefined): boolean {
  switch (type) {
    case "log":
      return signals.logs;
    case "trace_metric":
      return signals.metrics;
    case "profile":
    case "profile_chunk":
      return signals.profilesSampleRate > 0;
    default:
      return true;
  }
}

/** Loads @sentry/profiling-node (a native add-on: Node 24's prebuilt binary for linux x64/arm64
 * glibc ships in the package, so the api image needs no build tools) and adds it to the running
 * SDK, profiling while a sampled trace is open (profileLifecycle "trace"). A missing or unloadable
 * add-on is a warning, never a failed start. */
async function startProfiler(rate: number, runtime: SentryRuntime): Promise<boolean> {
  let factory: ProfilerFactory;
  try {
    factory = runtime.loadProfiler
      ? await runtime.loadProfiler()
      : ((await import("@sentry/profiling-node")).nodeProfilingIntegration as unknown as ProfilerFactory);
  } catch (err) {
    console.warn(`[sentry] profiling is on but @sentry/profiling-node did not load, so this instance sends no profiles: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const client = Sentry.getClient();
  if (!client) return false;
  // The integration reads these from the client when it is added (SDK 11 has no per-transaction
  // profilesSampleRate). Set on the live options: the SDK started before profiling was asked for.
  Object.assign(client.getOptions(), { profileSessionSampleRate: rate, profileLifecycle: "trace" });
  Sentry.addIntegration(factory());
  return true;
}

/** Whether events are being sent right now. */
export function sentryEnabled(): boolean {
  return sending;
}

/** Whether the web app's pages should allow profiling (routes/static.ts's Document-Policy header). */
export function profilingWanted(settings: SentryFleetSettings | undefined): boolean {
  return !!settings && sentrySignals(settings).profilesSampleRate > 0;
}

/** Reports a route error that ends in a 5xx, from Fastify's own onError hook (alongside, not
 * instead of, the app's error handling). The only reporter of route errors: the SDK's Fastify
 * integration is told not to (applySentrySettings). The status is the error's own (`statusCode`,
 * else `status`, as Fastify reads it), else the reply's, else 500. */
export function installSentryErrorHandler(fastify: FastifyInstance): void {
  fastify.addHook("onError", async (_req, reply, error) => {
    if (!sending) return;
    const own = (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status;
    const status = typeof own === "number" && own >= 400 ? own : reply.statusCode >= 400 ? reply.statusCode : 500;
    if (status >= 500) Sentry.captureException(error);
  });
}

// ---------- logs (#424) ----------

/** One string attribute's cap, after redaction. */
const LOG_ATTRIBUTE_MAX = 1024;
const LOG_MESSAGE_MAX = 4096;

/** Fields never forwarded, whatever they hold: a request's body or headers, and anything named
 * like a credential. */
const DROPPED_FIELDS = /^(body|payload|headers?|authorization|cookies?|password|passwd|secret|token|value|key|apiKey|dsn)$/i;

/** Fastify's own per-request lines: one pair for every request, already a trace span each. Not
 * forwarded, so logs stay about what the app itself says. */
const REQUEST_LINES = new Set(["incoming request", "request completed"]);

type LogLevel = "info" | "warn" | "error" | "fatal";

function levelName(level: number): LogLevel | undefined {
  if (level >= 60) return "fatal";
  if (level >= 50) return "error";
  if (level >= 40) return "warn";
  if (level >= 30) return "info";
  return undefined; // debug and trace stay local
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A log field as Sentry log attributes: primitives as they are (strings redacted and clipped), an
 * error as its name and message, Fastify's req/res as method, path (never the query) and status,
 * anything else as clipped, redacted JSON. */
function addAttribute(out: Record<string, string | number | boolean>, key: string, value: unknown): void {
  if (value === undefined || value === null || DROPPED_FIELDS.test(key)) return;
  if (typeof value === "string") out[key] = clip(redact(value), LOG_ATTRIBUTE_MAX);
  else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  else if (value instanceof Error) {
    out[`${key}.type`] = value.name;
    out[`${key}.message`] = clip(redact(value.message), LOG_ATTRIBUTE_MAX);
  } else if (key === "req" && typeof value === "object") {
    const req = value as { method?: unknown; url?: unknown };
    if (typeof req.method === "string") out["http.request.method"] = req.method;
    if (typeof req.url === "string") out["url.path"] = clip(redact(req.url.split("?")[0]!), LOG_ATTRIBUTE_MAX);
  } else if (key === "res" && typeof value === "object") {
    const status = (value as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") out["http.response.status_code"] = status;
  } else if (typeof value === "object") {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      return; // circular or otherwise unserialisable: left out
    }
    if (json !== undefined) out[key] = clip(redact(json), LOG_ATTRIBUTE_MAX);
  }
}

/** One pino call's arguments (`(obj?, msg?, ...)` or `(msg, ...)`) and the logger's bindings
 * (reqId and the like) as a Sentry log, or undefined when it isn't forwarded. Exported for tests. */
export function toSentryLog(
  args: readonly unknown[],
  level: number,
  bindings: Record<string, unknown> = {},
): { level: LogLevel; message: string; attributes: Record<string, string | number | boolean> } | undefined {
  const name = levelName(level);
  if (!name) return undefined;
  const [first, second] = args;
  let fields: Record<string, unknown> = {};
  let message = "";
  if (typeof first === "string") message = first;
  else if (first instanceof Error) {
    fields = { err: first };
    message = typeof second === "string" ? second : first.message;
  } else if (first && typeof first === "object") {
    fields = first as Record<string, unknown>;
    if (typeof second === "string") message = second;
    else if (typeof fields.msg === "string") message = fields.msg;
  }
  if (REQUEST_LINES.has(message)) return undefined;
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(bindings)) addAttribute(attributes, key, value);
  for (const [key, value] of Object.entries(fields)) if (key !== "msg") addAttribute(attributes, key, value);
  return { level: name, message: clip(redact(message), LOG_MESSAGE_MAX), attributes };
}

/** pino's `hooks.logMethod` (server.ts passes it as Fastify's logger option): every line is still
 * logged as before, and an info, warn or error line is also sent as a Sentry log while Sentry and
 * its logs signal are on. Child loggers (req.log) inherit it. */
export function sentryLogMethod(this: { bindings?: () => Record<string, unknown> }, args: unknown[], method: (...a: unknown[]) => void, level: number): void {
  method.apply(this, args);
  if (!sending || !signals.logs) return;
  try {
    const log = toSentryLog(args, level, this.bindings?.() ?? {});
    if (log) Sentry.logger[log.level](log.message, log.attributes);
  } catch {
    // A log line must never fail because Sentry couldn't take it.
  }
}

// ---------- metrics (#424) ----------

export type MetricAttributes = Record<string, string | number | boolean>;

/** Sentry.metrics while Sentry and its metrics signal are on; a no-op otherwise. Names are dotted
 * (`device.login.started`); attributes are short, fixed values (an outcome, a kind), never an id,
 * an email or anything a person typed. */
export const metrics = {
  count(name: string, attributes?: MetricAttributes, value = 1): void {
    if (sending && signals.metrics) Sentry.metrics.count(name, value, attributes ? { attributes } : undefined);
  },
  distribution(name: string, value: number, unit?: string, attributes?: MetricAttributes): void {
    if (!sending || !signals.metrics || !Number.isFinite(value)) return;
    Sentry.metrics.distribution(name, value, { ...(unit ? { unit } : {}), ...(attributes ? { attributes } : {}) });
  },
};

/** Sends what is queued before the process exits (Cloud Run's SIGTERM). Returns at once while
 * Sentry was never started. */
export async function closeSentry(timeoutMs = 2000): Promise<void> {
  if (initialized) await Sentry.close(timeoutMs).catch(() => undefined);
}

/** Test-only: whether the profiler started (undefined: never asked for). */
export function profilerStartedForTests(): Promise<boolean> | undefined {
  return profiler;
}

/** Test-only: forgets the SDK state so the next applySentrySettings starts a fresh client. */
export async function resetSentryForTests(): Promise<void> {
  await Sentry.getClient()?.close(0);
  initialized = false;
  initDsn = undefined;
  sending = false;
  tracesSampleRate = 0;
  signals = OFF;
  profiler = undefined;
}

export { Sentry };
