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
 * What is sent while on:
 *   - errors: an agent run that ends with an assistant stopReason of "error", plus an uncaught
 *     exception (@sentry/node's own handler), always sent in full.
 *   - traces: one span per agent run (agent_start → agent_end) and one child span per tool call
 *     (tool_execution_start → tool_execution_end), kept at the fleet's sample rate by the SDK's
 *     sampler. A span carries only the tool name, never its arguments or output.
 *   - with the fleet's agentTraces on (#424), those spans are Sentry's AI agent spans instead
 *     (agent.ts): `gen_ai.invoke_agent` for the run, a `gen_ai.chat` per model call (model,
 *     provider, tokens, cost, finish reason, time to first chunk) and `gen_ai.execute_tool` per tool
 *     call. With agentContent on too, they carry the prompt, the model's messages and outputs, and
 *     tool arguments and results, redacted and truncated; never the system prompt.
 *   - with the fleet's metrics on (#424): counters for runs, tool calls, model calls, tokens, spend
 *     and errors (agent.ts METRICS).
 * Never logs or profiles from a laptop, whatever the fleet says (config.ts says why).
 * Every event leaves without the hostname and with the home directory written as `~` (lib.ts), and
 * no request (an LLM call included) carries trace headers (client.ts).
 *
 * Not in a Drive: outfitter/image/Dockerfile removes this extension, and agentd reports for the
 * whole run there (agentd/src/sentry.ts, from run.spec's telemetry).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inSandbox } from "../_shared/env.ts";
import { outfitterCredentials, type OutfitterCredentials } from "../_shared/outfitter-env.ts";
import { cachedFleetSettings, fleetSettingsCachePath, refreshFleetSettings, type FleetSettings } from "../_shared/fleet-settings.ts";
import { refreshConfig, resolve, setLocalOptOut, type ResolvedConfig } from "../_shared/central-config.ts";
import { loginState } from "../_shared/outfitter-session.ts";
import { readSettings } from "../connect/settings.ts";
import { installedVersion } from "../kernal-update/index.ts";
import {
  SIGNAL_WORDS, decide, defaultEnvironment, describe, fleetFromConfig, optedOut, releaseName, signalKey, signalOptOuts,
  type SentryDecision, type Signal, type Signals,
} from "./config.ts";
import { applySentry, claimCrashReport, isCurrent, liveSignals, liveStatus, newInstance, realSentry, sending, type SentryLike, type SentrySpan } from "./client.ts";
import { agentRunError, agentRunReport, crashesToReport, toolSpanAttributes, type AgentEndMessage } from "./lib.ts";
import {
  ContentBudget, METRICS, agentInputContent, agentOutputContent, agentSpanStart, chatInputContent, chatOutputContent, chatSpanEnd,
  chatSpanStart, finishReason, toolArgsContent, toolOutcome, toolResultContent, toolSpanStart,
} from "./agent.ts";

export type Deps = {
  sentry?: SentryLike;
  credentials?: OutfitterCredentials;
  /** Signed in with `kernal login` (default: loginState()). Then the Sentry keys come from the
   * central settings instead of GET /api/fleet-settings. */
  signedIn?: boolean;
  /** The central resolution and its refresh (default: central-config's resolve / refreshConfig). */
  central?: { resolve: () => ResolvedConfig; refresh: () => Promise<ResolvedConfig | undefined> };
  /** The agent settings.json, for the legacy opt-out flags (default: readSettings()). */
  settings?: Record<string, unknown>;
  /** Saves (`false`) or clears this machine's telemetry.sentry.enabled opt-out (default:
   * central-config's setLocalOptOut: config.local.json, where /admin saves too; clearing also
   * removes the legacy `kernal.sentry` flag). */
  saveOptOut?: (value: false | undefined) => void;
  /** The same for a signal's telemetry.sentry.agentTraces (and so on). */
  saveSignalOptOut?: (signal: Signal, value: false | undefined) => void;
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

const USAGE = "usage: /sentry [status] | off | on | agent off|on | content off|on | metrics off|on";
const SUBCOMMANDS = ["status", "off", "on", "agent off", "agent on", "content off", "content on", "metrics off", "metrics on"];

export default function (pi: ExtensionAPI, deps: Deps = {}) {
  if (inSandbox()) return;
  const sentry = deps.sentry ?? realSentry;
  const creds = deps.credentials ?? outfitterCredentials();
  const signedIn = deps.signedIn ?? loginState().signedIn;
  const central = deps.central ?? { resolve: () => resolve(), refresh: () => refreshConfig({ fetch: deps.fetch }) };
  // Connected to Outfitter: a login (CA-8) or, on a laptop not signed in yet, a Dongle.
  const hasDongle = signedIn || !!(creds.api && creds.token);
  const version = installedVersion();
  const runtime = { environment: defaultEnvironment(version !== undefined), ...(version ? { release: releaseName(version) } : {}) };
  const saveOptOut = deps.saveOptOut ?? ((value: false | undefined) => setLocalOptOut("telemetry.sentry.enabled", value === false));
  const saveSignalOptOut = deps.saveSignalOptOut ?? ((signal: Signal, value: false | undefined) => setLocalOptOut(signalKey(signal), value === false));

  const settings = deps.settings ?? readSettings();
  // The opt-outs live in this machine's config layer (config.local.json, which /sentry and /admin
  // both write), read through the central resolution signed in or not, plus the legacy settings.json
  // flags. (A test that injects `settings` but no `central` reads no config layer: it must not see
  // the developer's own ~/.kernal files.)
  const localValues = (): ResolvedConfig["values"] => {
    if (deps.settings && !deps.central) return {};
    try { return central.resolve().values; } catch { return {}; }
  };
  let laptopOff = optedOut(settings, localValues());
  let signalsOff: Signals = signalOptOuts(settings, localValues());
  let fleet: FleetSettings = signedIn ? fleetFromConfig(central.resolve().values) : cachedFleetSettings(creds, deps.cacheFile);
  const decision = (): SentryDecision => decide(fleet, { optedOut: laptopOff, hasDongle, signalsOff });
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
  const reportCrashes = async () => {
    if (!sending() || !claimCrashReport()) return;
    try {
      const sent = readJson(crashesSentFile);
      const already = Array.isArray(sent) ? sent.filter((x): x is string => typeof x === "string") : [];
      const crashes = crashesToReport(readJson(crashFile), already, (deps.now ?? Date.now)());
      if (!crashes.length) return;
      for (const crash of crashes) sentry.captureCrash(crash);
      // Marked sent only once they have left: a `kernal -p` that exits right after start must not
      // lose them. (A send that times out is retried next start; a duplicate groups with the first.)
      if (!(await sentry.flush(5000))) return;
      const tmp = `${crashesSentFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify([...already, ...crashes.map((c) => c.timestamp)].slice(-50)) + "\n");
      renameSync(tmp, crashesSentFile);
    } catch {
      // A crash report is never worth a failed start.
    }
  };

  const apply = async () => {
    if (!isCurrent(instance)) return;
    await applySentry(decision(), runtime, sentry);
    await reportCrashes();
  };
  void apply().catch(() => undefined);

  // Opted out: no request to Outfitter either. Otherwise refresh in the background.
  // Never rejects: an unhandled rejection would crash pi (client.ts says why nothing catches them).
  const fetchFleet = (): Promise<FleetSettings | undefined> => signedIn
    ? central.refresh().then((r) => (r ? fleetFromConfig(r.values) : undefined))
    : refreshFleetSettings(creds, { fetch: deps.fetch, file: deps.cacheFile });
  const refresh = (): Promise<void> =>
    fetchFleet()
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

  // ---------- spans and counters ----------

  /** A counter, only while the metrics signal is on. Never throws: telemetry never breaks a run. */
  const count = (name: string, value: number, attributes?: Record<string, string>) => {
    if (!liveSignals().metrics || !(value > 0)) return;
    try { sentry.count(name, value, attributes); } catch { /* ignore */ }
  };

  /** One agent run's spans. `agent`: gen_ai spans (agentTraces), else #374's plain ones. */
  type Run = { span: SentrySpan; agent: boolean; content: ContentBudget | undefined; chat?: { span: SentrySpan; startedAt: number; firstChunk: boolean } };
  let run: Run | undefined;
  /** A run's content budget, only while agentContent is still on: an opt-out (`/sentry content off`,
   * or a fleet refresh) mid-run stops recording at the next step, not at the next run. */
  const contentOf = (r: Run | undefined): ContentBudget | undefined => (r?.content && liveSignals().agentContent ? r.content : undefined);
  let prompt: string | undefined;
  const toolSpans = new Map<string, SentrySpan>();

  const endChat = (outcome: "ok" | "error") => {
    if (!run?.chat) return;
    run.chat.span.setStatus(outcome);
    run.chat.span.end();
    run.chat = undefined;
  };

  pi.on("before_agent_start", async (event: { prompt?: string }) => {
    prompt = typeof event?.prompt === "string" ? event.prompt : undefined;
  });

  pi.on("agent_start", async (_event: unknown, ctx: any) => {
    const text = prompt;
    prompt = undefined;
    if (!sending()) { run = undefined; return; }
    const signals = liveSignals();
    if (!signals.agentTraces) {
      run = { span: sentry.startInactiveSpan({ name: "agent.run", op: "agent.run" }), agent: false, content: undefined };
      return;
    }
    const span = sentry.startInactiveSpan(agentSpanStart({ model: ctx?.model, conversationId: safe(() => ctx?.sessionManager?.getSessionId?.()) }));
    // Content only for a run the sampler kept: an unsampled run's spans are never sent.
    const content = signals.agentContent && span.sampled !== false ? new ContentBudget() : undefined;
    if (content && text) span.setAttributes(content.take(agentInputContent(text)));
    run = { span, agent: true, content };
  });

  // A model call begins when pi builds its request (the `context` event, which leaves the system
  // prompt out) and ends with the assistant message (message_end). Nothing here changes the request.
  pi.on("context", async (event: { messages?: unknown[] }, ctx: any) => {
    if (!run?.agent || !sending()) return undefined;
    endChat("ok"); // a request that never produced a message (should not happen; never leave one open)
    const start = chatSpanStart(ctx?.model);
    const input = contentOf(run)?.take(chatInputContent(event?.messages ?? [])) ?? {};
    run.chat = {
      span: sentry.startInactiveSpan({ ...start, attributes: { ...start.attributes, ...input }, parent: run.span, onlyIfParent: true }),
      startedAt: Date.now(),
      firstChunk: false,
    };
    return undefined;
  });

  pi.on("message_update", async (event: { message?: { role?: string } }) => {
    const chat = run?.chat;
    if (!chat || chat.firstChunk || event?.message?.role !== "assistant") return;
    chat.firstChunk = true;
    chat.span.setAttributes({ "gen_ai.response.time_to_first_chunk": (Date.now() - chat.startedAt) / 1000 });
  });

  pi.on("message_end", async (event: { message?: any }) => {
    const m = event?.message;
    if (m?.role !== "assistant") return;
    const model = String(m.responseModel ?? m.model ?? "unknown");
    const provider = String(m.provider ?? "unknown");
    const failed = m.stopReason === "error";
    // Counters: one per model call, whether or not the call is traced.
    count(METRICS.modelCalls, 1, { model, provider, finish_reason: finishReason(m.stopReason) });
    const usage = chatSpanEnd(m);
    count(METRICS.inputTokens, Number(usage["gen_ai.usage.input_tokens"]) || 0, { model, provider });
    count(METRICS.outputTokens, Number(usage["gen_ai.usage.output_tokens"]) || 0, { model, provider });
    count(METRICS.costUsd, Number(usage["gen_ai.cost.total_tokens"] ?? 0) || 0, { model, provider });
    if (failed) count(METRICS.errors, 1, { kind: "model_call", model, provider });
    const chat = run?.chat;
    if (!chat) return;
    chat.span.setAttributes({ ...usage, ...(contentOf(run)?.take(chatOutputContent(m)) ?? {}) });
    endChat(failed ? "error" : "ok");
  });

  pi.on("agent_end", async (event: { messages: AgentEndMessage[] }) => {
    const messages = event.messages ?? [];
    const error = agentRunError(messages);
    if (error && sending()) {
      const report = agentRunReport(error);
      sentry.captureException(new Error(report.message), { tags: { source: "agent_end" }, fingerprint: report.fingerprint });
    }
    count(METRICS.agentRuns, 1, { outcome: error ? "error" : "ok" });
    if (error) count(METRICS.errors, 1, { kind: "agent_run" });
    const r = run;
    run = undefined;
    if (!r) return;
    if (r.chat) { r.chat.span.setStatus("error"); r.chat.span.end(); } // the run ended mid-call
    const content = r.agent ? contentOf(r) : undefined;
    if (content) r.span.setAttributes(content.take(agentOutputContent(messages)));
    r.span.setStatus(error ? "error" : "ok");
    r.span.end();
  });

  pi.on("tool_execution_start", async (event: { toolCallId: string; toolName: string; args?: unknown }) => {
    if (!sending()) return;
    // A child of the run's span, and only inside a run: kept or dropped with it by the sampler.
    if (!run) return;
    const start = run.agent ? toolSpanStart(event.toolName) : { name: `tool.${event.toolName}`, op: "tool.execute", attributes: toolSpanAttributes(event.toolName) };
    const args = (run.agent ? contentOf(run)?.take(toolArgsContent(event.args)) : undefined) ?? {};
    toolSpans.set(event.toolCallId, sentry.startInactiveSpan({
      ...start,
      attributes: { ...start.attributes, ...args },
      parent: run.span,
      onlyIfParent: true,
    }));
  });

  pi.on("tool_execution_end", async (event: { toolCallId: string; toolName: string; isError: boolean; result?: unknown }) => {
    count(METRICS.toolCalls, 1, { tool: event.toolName, outcome: event.isError ? "error" : "ok" });
    if (event.isError) count(METRICS.errors, 1, { kind: "tool", tool: event.toolName });
    const span = toolSpans.get(event.toolCallId);
    toolSpans.delete(event.toolCallId);
    if (!span) return;
    if (run?.agent) span.setAttributes({ ...toolOutcome(event.isError), ...(contentOf(run)?.take(toolResultContent(event.result)) ?? {}) });
    span.setStatus(event.isError ? "error" : "ok");
    span.end();
  });

  // What is queued (a `kernal -p` run's transaction and counters) leaves before pi exits, within a
  // bound: a slow network must not hold up quitting.
  pi.on("session_shutdown", async () => {
    if (!sending()) return;
    try { await sentry.flush(2000); } catch { /* ignore */ }
  });

  // ---------- /sentry ----------

  pi.registerCommand("sentry", {
    description: "sentry [status] | off | on | agent|content|metrics off|on -- reports to Sentry, as Outfitter set them for everyone; off stops them on this laptop",
    getArgumentCompletions: (prefix: string) =>
      SUBCOMMANDS.filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args: string, ctx: any) => {
      const notify = (m: string, level = "info") => ctx?.ui?.notify?.(m, level);
      const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = words[0] ?? "status";
      const status = () => describe(decision(), liveStatus(), { fleet, signalsOff });
      if (sub === "status" && words.length <= 1) return notify(status());
      if (sub === "off" && words.length === 1) {
        // Stop first: a config.local.json that cannot be written must not keep Sentry sending.
        laptopOff = true;
        await apply();
        try {
          saveOptOut(false);
        } catch (err) {
          return notify(`Sentry is off for now, but saving that failed (${errText(err)}); it comes back on the next /new, /resume, /reload or start.`, "warning");
        }
        return notify(status());
      }
      if (sub === "on" && words.length === 1) {
        try {
          saveOptOut(undefined);
        } catch (err) {
          return notify(`Could not save that (${errText(err)}); Sentry stays off on this laptop.`, "warning");
        }
        // Both places are cleared now; re-read through the same path as at start.
        laptopOff = optedOut({}, localValues());
        await apply();
        // The cached copy may be old after an opt-out (no refresh ran); fetch now.
        if (hasDongle) await refresh();
        return notify(status());
      }
      const signal = SIGNAL_WORDS[sub];
      const onOff = words[1];
      if (signal && words.length === 2 && (onOff === "off" || onOff === "on")) {
        if (onOff === "off") {
          signalsOff = { ...signalsOff, [signal]: true };
          await apply();
          try {
            saveSignalOptOut(signal, false);
          } catch (err) {
            return notify(`That is off for now, but saving it failed (${errText(err)}); it comes back on the next /new, /resume, /reload or start.`, "warning");
          }
          return notify(status());
        }
        try {
          saveSignalOptOut(signal, undefined);
        } catch (err) {
          return notify(`Could not save that (${errText(err)}); it stays off on this laptop.`, "warning");
        }
        // Both places are cleared now; re-read through the same path as at start.
        signalsOff = { ...signalsOff, [signal]: signalOptOuts({}, localValues())[signal] };
        await apply();
        // Signed in, the cached resolution still has the opt-out folded in; fetch it again.
        if (hasDongle) await refresh();
        return notify(status());
      }
      return notify(USAGE, "warning");
    },
  });
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function safe<T>(f: () => T): T | undefined {
  try { return f(); } catch { return undefined; }
}

export { decide, describe, optedOut, type SentryDecision } from "./config.ts";
export { applySentry, type SentryLike } from "./client.ts";
