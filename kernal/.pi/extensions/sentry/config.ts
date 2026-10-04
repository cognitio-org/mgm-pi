/**
 * Whether this laptop sends to Sentry, and with what: pure functions over the fleet settings
 * (_shared/fleet-settings.ts) and the person's own `kernal.sentry` setting, so the test suite checks
 * every combination without the network or @sentry/node.
 *
 * Two inputs, and both must say yes:
 *   - Outfitter's fleet settings, which an operator sets once for every machine. They carry the DSN
 *     and the trace sample rate; nothing about Sentry is configured on the laptop. No Dongle, or no
 *     answer from Outfitter yet, means off.
 *   - `kernal.sentry` in the agent settings.json, the person's own override, changed with
 *     `/sentry off|on`. It can only turn sending off: `false` stops it whatever the fleet says;
 *     unset follows the fleet.
 */
import { parseFleetSettings, type FleetSettings } from "../_shared/fleet-settings.ts";
import type { ConfigValue } from "../_shared/central-config.ts";
import { kernalSection } from "../connect/settings.ts";

export type SentryDecision =
  | { on: true; dsn: string; tracesSampleRate: number }
  | { on: false; why: "laptop" | "fleet" | "no-dongle" };

/** True when the person turned Sentry off on this laptop (`kernal.sentry: false`). */
export function optedOut(settings: Record<string, unknown>): boolean {
  return kernalSection(settings).sentry === false;
}

/** Signed in (CA-8): the same three settings from the central resolution (_shared/central-config.ts),
 * checked as strictly as GET /api/fleet-settings' answer. */
export function fleetFromConfig(values: Record<string, ConfigValue>): FleetSettings {
  return parseFleetSettings({
    telemetry: {
      sentry: {
        enabled: values["telemetry.sentry.enabled"]?.value,
        dsn: values["telemetry.sentry.dsn"]?.value,
        tracesSampleRate: values["telemetry.sentry.tracesSampleRate"]?.value,
      },
    },
  });
}

export function decide(fleet: FleetSettings, opts: { optedOut: boolean; hasDongle: boolean }): SentryDecision {
  if (opts.optedOut) return { on: false, why: "laptop" };
  if (!opts.hasDongle) return { on: false, why: "no-dongle" };
  const s = fleet.telemetry.sentry;
  if (!s.enabled) return { on: false, why: "fleet" };
  return { on: true, dsn: s.dsn, tracesSampleRate: s.tracesSampleRate };
}

/** "production" for a release bundle, "development" for a source checkout (installedVersion() in
 * kernal-update tells them apart), so a maintainer's own errors are easy to filter out. */
export function defaultEnvironment(isPackagedBundle: boolean): string {
  return isPackagedBundle ? "production" : "development";
}

/** One line for `/sentry` and `/sentry status`. `live` is what the process is actually doing
 * (client.ts liveStatus), which can lag the decision: the SDK may still be loading, may have failed
 * to start, or may be bound to a DSN Outfitter has since replaced. */
export function describe(decision: SentryDecision, live: "sending" | "starting" | "failed" | "restart-needed" | "idle" = "sending"): string {
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
