/**
 * Sentry: error reporting and low-volume agent tracing, so a crash or a stuck tool shows up in a
 * dashboard instead of only in a transcript nobody reads. Off unless Outfitter turned it on for the
 * fleet, and never on for a person who ran `/sentry off` (config.ts has the rules).
 *
 * Nothing about Sentry is configured on the laptop: the DSN and the trace sample rate come from
 * Outfitter's fleet settings (Settings → Telemetry in the web app), read with this laptop's Dongle
 * (_shared/fleet-settings.ts). Start-up uses the copy cached by the previous start and never waits
 * for the network; a fresh copy is fetched in the background and applied as soon as it lands, so an
 * operator's change is in force here by the next Kernal start at the latest.
 *
 * Two kinds of events while on:
 *   - errors: an agent run that ends with an assistant stopReason of "error", plus an uncaught
 *     exception (@sentry/node's own handler), always sent in full.
 *   - traces: one span per agent run (agent_start → agent_end) and one child span per tool call
 *     (tool_execution_start → tool_execution_end), kept at the fleet's sample rate by the SDK's
 *     sampler. A span carries only the tool name, never its arguments or output.
 * Every event leaves without the hostname and with the home directory written as `~` (lib.ts).
 *
 * Not in a Drive: outfitter/image/Dockerfile removes this extension, and agentd reports for the
 * whole run there (agentd/src/sentry.ts, from run.spec's telemetry).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inSandbox } from "../_shared/env.ts";
import { outfitterCredentials, type OutfitterCredentials } from "../_shared/outfitter-env.ts";
import { cachedFleetSettings, fleetSettingsCachePath, refreshFleetSettings, type FleetSettings } from "../_shared/fleet-settings.ts";
import { readSettings, updateKernal } from "../connect/settings.ts";
import { installedVersion } from "../kernal-update/index.ts";
import { decide, defaultEnvironment, describe, optedOut, type SentryDecision } from "./config.ts";
import { applySentry, claimCrashReport, isCurrent, liveStatus, newInstance, realSentry, sending, type SentryLike, type SentrySpan } from "./client.ts";
import { agentRunError, agentRunReport, crashesToReport, toolSpanAttributes, type AgentEndMessage } from "./lib.ts";

export type Deps = {
  sentry?: SentryLike;
  credentials?: OutfitterCredentials;
  /** The agent settings.json (default: readSettings()). */
  settings?: Record<string, unknown>;
  /** Where `kernal.sentry` is written (default: updateKernal). */
  saveOptOut?: (value: false | undefined) => void;
  fetch?: typeof fetch;
  cacheFile?: string;
  /** Tests: the background refresh, to await it. */
  onRefresh?: (done: Promise<void>) => void;
  /** pi's crash log (default: the agent dir's crashes.json) and the record of those already sent. */
  crashFile?: string;
  crashesSentFile?: string;
  now?: () => number;
};

const readJson = (file: string): unknown => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
};

const USAGE = "usage: /sentry [status] | off | on";

export default function (pi: ExtensionAPI, deps: Deps = {}) {
  if (inSandbox()) return;
  const sentry = deps.sentry ?? realSentry;
  const creds = deps.credentials ?? outfitterCredentials();
  const hasDongle = !!(creds.api && creds.token);
  const version = installedVersion();
  const runtime = { environment: defaultEnvironment(version !== undefined), ...(version ? { release: version } : {}) };
  const saveOptOut = deps.saveOptOut ?? ((value: false | undefined) => updateKernal({ sentry: value }));

  let laptopOff = optedOut(deps.settings ?? readSettings());
  let fleet: FleetSettings = cachedFleetSettings(creds, deps.cacheFile);
  const decision = (): SentryDecision => decide(fleet, { optedOut: laptopOff, hasDongle });
  // Only the newest instance decides: an older one's refresh landing after a /reload (and maybe a
  // /sentry off in the new one) must not turn sending back on.
  const instance = newInstance();
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const crashFile = deps.crashFile ?? join(agentDir, "crashes.json");
  const crashesSentFile = deps.crashesSentFile ?? join(dirname(fleetSettingsCachePath()), ".sentry-crashes-sent.json");

  /**
   * Crashes from earlier runs. In interactive mode pi's own uncaughtException handler runs first and
   * exits at once (process.exit), so nothing can be sent at crash time; pi does write each crash to
   * crashes.json first, though. So the first time Sentry is on in a later run, the crashes not yet
   * sent go out (once per process, and each crash once, by its timestamp).
   */
  const reportCrashes = () => {
    if (!sending() || !claimCrashReport()) return;
    try {
      const sent = readJson(crashesSentFile);
      const already = Array.isArray(sent) ? sent.filter((x): x is string => typeof x === "string") : [];
      const crashes = crashesToReport(readJson(crashFile), already, (deps.now ?? Date.now)());
      if (!crashes.length) return;
      for (const crash of crashes) sentry.captureCrash(crash);
      writeFileSync(crashesSentFile, JSON.stringify([...already, ...crashes.map((c) => c.timestamp)].slice(-50)) + "\n");
    } catch {
      // A crash report is never worth a failed start.
    }
  };

  const apply = async () => {
    if (!isCurrent(instance)) return;
    await applySentry(decision(), runtime, sentry);
    reportCrashes();
  };
  void apply().catch(() => undefined);

  // Opted out: no request to Outfitter either. Otherwise refresh in the background.
  // Never rejects: an unhandled rejection would crash pi (client.ts says why nothing catches them).
  const refresh = (): Promise<void> =>
    refreshFleetSettings(creds, { fetch: deps.fetch, file: deps.cacheFile })
      .then((fresh) => {
        if (!fresh) return;
        fleet = fresh;
        return apply();
      })
      .catch(() => undefined);
  if (!laptopOff && hasDongle) {
    const done = refresh();
    deps.onRefresh?.(done);
  }

  let runSpan: SentrySpan | undefined;
  const toolSpans = new Map<string, SentrySpan>();

  pi.on("agent_start", async () => {
    runSpan = sending() ? sentry.startInactiveSpan({ name: "agent.run", op: "agent.run" }) : undefined;
  });

  pi.on("agent_end", async (event: { messages: AgentEndMessage[] }) => {
    const error = agentRunError(event.messages ?? []);
    if (error && sending()) {
      const report = agentRunReport(error);
      sentry.captureException(new Error(report.message), { tags: { source: "agent_end" }, fingerprint: report.fingerprint });
    }
    runSpan?.setStatus(error ? "error" : "ok");
    runSpan?.end();
    runSpan = undefined;
  });

  pi.on("tool_execution_start", async (event: { toolCallId: string; toolName: string }) => {
    if (!sending()) return;
    // A child of the run's span, and only inside a run: kept or dropped with it by the sampler.
    if (!runSpan) return;
    toolSpans.set(event.toolCallId, sentry.startInactiveSpan({
      name: `tool.${event.toolName}`,
      op: "tool.execute",
      attributes: toolSpanAttributes(event.toolName),
      parent: runSpan,
      onlyIfParent: true,
    }));
  });

  pi.on("tool_execution_end", async (event: { toolCallId: string; toolName: string; isError: boolean }) => {
    const span = toolSpans.get(event.toolCallId);
    toolSpans.delete(event.toolCallId);
    if (!span) return;
    span.setStatus(event.isError ? "error" : "ok");
    span.end();
  });

  pi.registerCommand("sentry", {
    description: "sentry [status] | off | on -- error reports to Sentry, as Outfitter set them for everyone; off stops them on this laptop",
    getArgumentCompletions: (prefix: string) =>
      ["status", "off", "on"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args: string, ctx: any) => {
      const notify = (m: string, level = "info") => ctx?.ui?.notify?.(m, level);
      const sub = (args ?? "").trim() || "status";
      const status = () => describe(decision(), liveStatus());
      if (sub === "status") return notify(status());
      if (sub === "off") {
        // Stop first: a settings.json that cannot be written must not keep Sentry sending.
        laptopOff = true;
        await apply();
        try {
          saveOptOut(false);
        } catch (err) {
          return notify(`Sentry is off for now, but saving that failed (${err instanceof Error ? err.message : String(err)}); it comes back on the next /new, /resume, /reload or start.`, "warning");
        }
        return notify(status());
      }
      if (sub === "on") {
        try {
          saveOptOut(undefined);
        } catch (err) {
          return notify(`Could not save that (${err instanceof Error ? err.message : String(err)}); Sentry stays off on this laptop.`, "warning");
        }
        laptopOff = false;
        await apply();
        // The cached copy may be old after an opt-out (no refresh ran); fetch now.
        if (hasDongle) await refresh();
        return notify(status());
      }
      return notify(USAGE, "warning");
    },
  });
}

export { decide, describe, optedOut, type SentryDecision } from "./config.ts";
export { applySentry, type SentryLike } from "./client.ts";
