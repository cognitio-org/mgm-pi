/**
 * Whether this laptop sends to Sentry, and with what: pure functions over the fleet settings
 * (_shared/fleet-settings.ts) and the person's own opt-outs on this machine, so the test suite checks
 * every combination without the network or @sentry/node.
 *
 * Two inputs, and both must say yes:
 *   - Outfitter's fleet settings, which an operator sets once for every machine. They carry the DSN
 *     and the trace sample rate; nothing about Sentry is configured on the laptop. No Dongle, or no
 *     answer from Outfitter yet, means off.
 *   - `telemetry.sentry.enabled` in this machine's config layer (~/.kernal/config.local.json), the
 *     person's own override, changed with `/sentry off|on` or /admin's "Only this machine" (both
 *     through central-config's setLocalOptOut). It can only turn sending off: `false` stops it
 *     whatever the fleet says; unset follows the fleet. The legacy `kernal.sentry: false` in the
 *     agent settings.json (#374) still counts as `false`.
 * The #424 signals (Signals below) follow the same rule, each with its own fleet setting and its own
 * local opt-out, and all of them stay off whenever Sentry itself is off.
 */
import { parseFleetSettings, type FleetSettings } from "../_shared/fleet-settings.ts";
import { SENTRY_LOCAL_FLAGS, isCentralSource, type ConfigValue } from "../_shared/central-config.ts";
import { kernalSection } from "../connect/settings.ts";

/**
 * The signals beside errors and traces (#424) that Kernal sends, each needing its own fleet setting
 * and no local opt-out:
 *   - agentTraces: the run, each model call and each tool call as Sentry's gen_ai spans (agent.ts),
 *     with model, tokens, cost and outcome. Without it, the plain #374 spans.
 *   - agentContent: prompts, outputs and tool arguments/results on those spans, redacted and
 *     truncated. Only with agentTraces.
 *   - metrics: counters (agent.ts METRICS).
 * Never on Kernal, whatever the fleet says: `telemetry.sentry.logs` (no laptop logs: #374's
 * no-console-output rule) and `telemetry.sentry.profilesSampleRate` (pi's Bun-compiled binary cannot
 * load @sentry/profiling-node's native add-on).
 */
export interface Signals {
  agentTraces: boolean;
  agentContent: boolean;
  metrics: boolean;
}
export type Signal = keyof Signals;
export const SIGNALS: readonly Signal[] = ["agentTraces", "agentContent", "metrics"];
export const NO_SIGNALS: Readonly<Signals> = { agentTraces: false, agentContent: false, metrics: false };

/** The `/sentry <word> off|on` words. */
export const SIGNAL_WORDS: Readonly<Record<string, Signal>> = { agent: "agentTraces", content: "agentContent", metrics: "metrics" };
export const signalKey = (s: Signal): string => `telemetry.sentry.${s}`;

export type SentryDecision =
  | { on: true; dsn: string; tracesSampleRate: number; signals?: Signals }
  | { on: false; why: "laptop" | "fleet" | "no-dongle" };

/**
 * True when this machine opts `key` out: a `false` from its own config layer (config.local.json,
 * which `/sentry` and /admin both write) or the key's legacy settings.json flag (SENTRY_LOCAL_FLAGS).
 * The same two places central-config's resolution reads, so `/sentry status` and /admin agree. Only
 * ever off: no local value turns anything on.
 */
export function localOptOut(key: string, settings: Record<string, unknown>, values: Record<string, ConfigValue> = {}): boolean {
  const v = values[key];
  // The legacy flag is read from `settings` itself, never from a resolution made earlier.
  const fromConfig = v?.value === false && v.source !== "default" && !isCentralSource(v.source) && v.sourceName !== "settings.json";
  return kernalSection(settings)[SENTRY_LOCAL_FLAGS[key]] === false || fromConfig;
}

/** True when the person turned Sentry off on this laptop (localOptOut of telemetry.sentry.enabled). */
export function optedOut(settings: Record<string, unknown>, values: Record<string, ConfigValue> = {}): boolean {
  return localOptOut("telemetry.sentry.enabled", settings, values);
}

/** The signals turned off on this laptop (localOptOut of each: what `/sentry agent off` and so on
 * write). Only ever off: no local value turns a signal on. */
export function signalOptOuts(settings: Record<string, unknown>, values: Record<string, ConfigValue> = {}): Signals {
  const out: Signals = { ...NO_SIGNALS };
  for (const s of SIGNALS) out[s] = localOptOut(signalKey(s), settings, values);
  return out;
}

/** Signed in (CA-8): the Sentry settings from the central resolution (_shared/central-config.ts),
 * checked as strictly as GET /api/fleet-settings' answer. A signal counts as the fleet's only when
 * the value came from Outfitter: the resolution's local layers are the laptop's opt-outs
 * (signalOptOuts), never a way to turn one on. */
export function fleetFromConfig(values: Record<string, ConfigValue>): FleetSettings {
  const central = (key: string) => {
    const v = values[`telemetry.sentry.${key}`];
    return v && (isCentralSource(v.source) || v.source === "default") ? v.value : undefined;
  };
  return parseFleetSettings({
    telemetry: {
      sentry: {
        enabled: values["telemetry.sentry.enabled"]?.value,
        dsn: values["telemetry.sentry.dsn"]?.value,
        tracesSampleRate: values["telemetry.sentry.tracesSampleRate"]?.value,
        agentTraces: central("agentTraces"),
        agentContent: central("agentContent"),
        metrics: central("metrics"),
        logs: central("logs"),
        profilesSampleRate: central("profilesSampleRate"),
      },
    },
  });
}

export function decide(fleet: FleetSettings, opts: { optedOut: boolean; hasDongle: boolean; signalsOff?: Signals }): SentryDecision {
  if (opts.optedOut) return { on: false, why: "laptop" };
  if (!opts.hasDongle) return { on: false, why: "no-dongle" };
  const s = fleet.telemetry.sentry;
  if (!s.enabled) return { on: false, why: "fleet" };
  const off = opts.signalsOff ?? NO_SIGNALS;
  const agentTraces = s.agentTraces === true && !off.agentTraces;
  const signals: Signals = {
    agentTraces,
    agentContent: agentTraces && s.agentContent === true && !off.agentContent,
    metrics: s.metrics === true && !off.metrics,
  };
  return { on: true, dsn: s.dsn, tracesSampleRate: s.tracesSampleRate, signals };
}

/** The signals a decision puts in force: none while Sentry is off. */
export function signalsOf(decision: SentryDecision): Signals {
  return decision.on && decision.signals ? decision.signals : { ...NO_SIGNALS };
}

/** "production" for a release bundle, "development" for a source checkout (installedVersion() in
 * kernal-update tells them apart), so a maintainer's own errors are easy to filter out. */
export function defaultEnvironment(isPackagedBundle: boolean): string {
  return isPackagedBundle ? "production" : "development";
}

/** The Sentry release a bundle reports: `kernal@X.Y.Z`, the name release.yml creates the release
 * under (with its commits), and one that can't collide with Outfitter's `outfitter-v…` releases in
 * the same Sentry project. */
export function releaseName(version: string): string {
  return `kernal@${version}`;
}

export type LiveStatus = "sending" | "starting" | "failed" | "restart-needed" | "idle";

/** `/sentry` and `/sentry status`: one line for errors and traces, and with `detail`, one more per
 * #424 signal saying who decided it, then what never runs on a laptop. `live` is what the process is
 * actually doing (client.ts liveStatus), which can lag the decision: the SDK may still be loading,
 * may have failed to start, or may be bound to a DSN Outfitter has since replaced. */
export function describe(decision: SentryDecision, live: LiveStatus = "sending", detail?: { fleet: FleetSettings; signalsOff: Signals }): string {
  const head = headline(decision, live);
  if (!detail || !decision.on) return head;
  const s = detail.fleet.telemetry.sentry;
  // The laptop's opt-out first: signed in, a local `false` hides what the fleet said (the central
  // resolution keeps only the winning value), so it is the one thing known for sure.
  const line = (label: string, sig: Signal, word: string) => {
    if (detail.signalsOff[sig]) return `  ${label}: off on this laptop (/sentry ${word} on to follow Outfitter again).`;
    if (!s.enabled || s[sig] !== true) return `  ${label}: off (Outfitter has it off).`;
    return `  ${label}: on, set by Outfitter. /sentry ${word} off stops it here.`;
  };
  const content = "Prompts and outputs on agent spans, redacted";
  return [
    head,
    line("Agent monitoring (model calls, tokens, cost, tool calls)", "agentTraces", "agent"),
    decision.signals?.agentTraces ? line(content, "agentContent", "content") : `  ${content}: off (needs agent monitoring).`,
    line("Metrics", "metrics", "metrics"),
    "  Never from Kernal, whatever Outfitter sets: logs (a laptop sends none) and profiles (pi's binary can't load the profiler).",
  ].join("\n");
}

function headline(decision: SentryDecision, live: LiveStatus): string {
  if (decision.on) {
    if (live === "failed") return "Sentry: on in Outfitter, but it failed to start in this Kernal, so nothing is sent (restart Kernal to retry).";
    if (live === "restart-needed") return "Sentry: on in Outfitter, but its DSN changed; nothing is sent until Kernal restarts.";
    const pct = Math.round(decision.tracesSampleRate * 1000) / 10;
    const starting = live === "starting" ? " Starting up." : "";
    return `Sentry: on, set by Outfitter (errors, and ${pct}% of agent runs traced).${starting} /sentry off stops it on this laptop.`;
  }
  switch (decision.why) {
    case "laptop":
      return "Sentry: off on this laptop (/sentry on to follow Outfitter's setting again).";
    case "no-dongle":
      return "Sentry: off. This laptop is not connected to Outfitter (no OUTFITTER_TOKEN), and only Outfitter can turn it on.";
    case "fleet":
      return "Sentry: off. Outfitter has it off for everyone (Settings → Telemetry in the web app).";
  }
}
