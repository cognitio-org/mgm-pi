/**
 * mgm compaction — makes pi's compaction work inside small context windows and cheaper everywhere.
 *
 *  1. Observation masking (`context` hook): all but the newest N large tool results are replaced by
 *     a short head + marker on every request. No LLM call; the session file keeps the full output.
 *  2. Chunked summarization (`session_before_compact`): history folded into the summary in chunks
 *     ≤ 30% of the summarizer's window, hard cap on summary length, "shorten" retry.
 *  3. Configurable summarizer (default litellm/gpt-5.4-nano, see docs/summarizer-benchmark.md).
 *  4. Proactive trigger (`agent_end`) at 60% (≤64k windows) / 85%.
 *  5. Profiles: code | research | chat, auto-detected from tool usage unless pinned, tune pruning
 *     and the summary focus. Pinned content (first user message, extension messages, /pin) is
 *     carried verbatim outside the model-written summary.
 *
 *  /compaction          settings dialog (summarizer, profile, pruning, trigger, masking, compact now)
 *  /compaction now      compact immediately          /compaction model <provider/id|self|default>
 *  /pin [text]          keep text verbatim across compactions
 *  Settings persist under "mgm": {"compaction": {...}} in the agent settings.json.
 *  MGM_SUMMARY_MODEL overrides the summarizer; MGM_COMPACTION=off disables; MGM_COMPACTION_LOG=<file>.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation, estimateTokens, findCutPoint } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
  type Msg, type Prefs, type Profile, budgets, effective, detectProfile, estimateText, maskOldToolResults, chunkMessages,
  summaryPrompt, shortenPrompt, pickSummarizer, rankSummarizers, statusText, SUMMARY_SYSTEM_PROMPT, collectPins, composeSummary, stripPinned,
} from "./lib.ts";

const OFF = process.env.MGM_COMPACTION === "off";
const DEFAULT_SUMMARIZER = "litellm/gpt-5.4-nano";   // see docs/summarizer-benchmark.md
const log = (o: object) => { if (process.env.MGM_COMPACTION_LOG) appendFileSync(process.env.MGM_COMPACTION_LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n"); };

// ---------- persisted preferences: settings.json → { mgm: { compaction: Prefs & { summaryModel? } } } ----------
const settingsPath = () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");
const readSettings = (): any => { try { return JSON.parse(readFileSync(settingsPath(), "utf8")); } catch { return {}; } };
const readPrefs = (): Prefs & { summaryModel?: string } => ({ ...(readSettings().mgm?.compaction ?? {}), ...(readSettings().mgm?.summaryModel ? { summaryModel: readSettings().mgm.summaryModel } : {}) });
function writePrefs(patch: Partial<Prefs & { summaryModel?: string }>) {
  const s = readSettings(); s.mgm = { ...(s.mgm ?? {}) }; s.mgm.compaction = { ...(s.mgm.compaction ?? {}), ...patch };
  for (const k of Object.keys(s.mgm.compaction)) if (s.mgm.compaction[k] === undefined) delete s.mgm.compaction[k];
  delete s.mgm.summaryModel;   // legacy location
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + "\n");
}
function summarizerSetting(): { value: string; source: string } {
  if (process.env.MGM_SUMMARY_MODEL) return { value: process.env.MGM_SUMMARY_MODEL, source: "MGM_SUMMARY_MODEL" };
  const v = readPrefs().summaryModel;
  return v ? { value: v, source: "settings" } : { value: DEFAULT_SUMMARIZER, source: "default" };
}

export default function (pi: ExtensionAPI) {
  if (OFF) return;
  let lastMasked = 0, lastSaved = 0, compacting = false, backoffUntilPercent = 0;

  // window budgets → profile → user overrides
  const eff = (ctx: any) => {
    const prefs = readPrefs();
    const detected = detectProfile(ctx.sessionManager?.getEntries?.() ?? []);
    const profile: Profile = prefs.profile && prefs.profile !== "auto" ? prefs.profile : detected.profile;
    return { ...effective(budgets(ctx.model?.contextWindow ?? 128_000), profile, prefs), detected, prefs };
  };
  const refreshStatus = (ctx: any) => { const u = ctx.getContextUsage?.(); ctx.ui.setStatus("compaction", statusText(u?.percent, lastMasked, eff(ctx).small)); };
  const findModel = (key: string) => { const i = key.indexOf("/"); return i > 0 ? ctx0.registry?.find(key.slice(0, i), key.slice(i + 1)) : undefined; };
  const ctx0: { registry?: any } = {};
  pi.on("session_start", async (_ev, ctx) => { ctx0.registry = ctx.modelRegistry; refreshStatus(ctx); });

  // 1. observation masking
  pi.on("context", async (ev, ctx) => {
    const e = eff(ctx);
    if (!e.masking) { lastMasked = 0; return; }
    const r = maskOldToolResults(ev.messages as unknown as Msg[], { keepResults: e.keepResults, minChars: e.maskMinChars });
    lastMasked = r.masked; lastSaved = r.savedChars;
    if (r.masked) log({ event: "mask", masked: r.masked, savedChars: r.savedChars, profile: e.profile });
    return { messages: r.messages as any };
  });

  // 2 + 3. chunked summarization with the configured summarizer
  pi.on("session_before_compact", async (ev, ctx) => {
    const { preparation, branchEntries, customInstructions, reason, signal } = ev;
    const current = ctx.model; if (!current) return;
    const e = eff(ctx);
    let boundaryStart = 0;
    for (let i = branchEntries.length - 1; i >= 0; i--) { const x: any = branchEntries[i]; if (x.type === "compaction") { const k = branchEntries.findIndex((y: any) => y.id === x.firstKeptEntryId); boundaryStart = k >= 0 ? k : i + 1; break; } }
    const cut = findCutPoint(branchEntries as any, boundaryStart, branchEntries.length, e.keepRecentTokens);
    const firstKept: any = branchEntries[cut.firstKeptEntryIndex];
    const toSummarize = (branchEntries.slice(boundaryStart, cut.firstKeptEntryIndex) as any[]).filter((x) => x.type === "message").map((x) => x.message);
    if (!firstKept?.id || toSummarize.length === 0) return;

    const pref = summarizerSetting().value;
    const pick = pickSummarizer({ provider: current.provider, id: current.id, contextWindow: current.contextWindow }, pref === "self" ? undefined : pref,
      (p, id) => { const m = ctx.modelRegistry.find(p, id); return m ? { provider: m.provider, id: m.id, contextWindow: m.contextWindow } : undefined; },
      (m) => { const f = ctx.modelRegistry.find(m.provider, m.id); return !!f && ctx.modelRegistry.hasConfiguredAuth(f); });
    const summarizer = ctx.modelRegistry.find(pick.model.provider, pick.model.id)!;
    const chunkTokens = Math.min(e.chunkTokens, budgets(summarizer.contextWindow).chunkTokens);
    const maxTokens = Math.min(e.summaryMaxTokens, summarizer.maxTokens > 0 ? summarizer.maxTokens : Infinity);
    const chunks = chunkMessages(toSummarize, chunkTokens, (m) => estimateTokens(m), (m: any) => m.role === "toolResult");
    const instructions = [e.focus, customInstructions].filter(Boolean).join("\n");
    ctx.ui.notify(`Compacting (${reason}, ${e.profile}): ${toSummarize.length} messages in ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} via ${summarizer.provider}/${summarizer.id}`, "info");
    log({ event: "compact_start", reason, profile: e.profile, messages: toSummarize.length, chunks: chunks.length, summarizer: `${summarizer.provider}/${summarizer.id}`, why: pick.reason, keepRecent: e.keepRecentTokens, chunkTokens, maxTokens });

    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const addUsage = (u: any) => { if (!u) return; for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) (usage as any)[k] += u[k] ?? 0; for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[k] += u.cost?.[k] ?? 0; };
    const ask = async (text: string) => {
      const res = await ctx.modelRegistry.complete(summarizer, { systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] } as any, { maxTokens, signal, cacheRetention: "none", sessionId: uuidv7() } as any);
      addUsage(res.usage);
      if (res.stopReason === "error") throw new Error(res.errorMessage ?? "summarizer error");
      return { text: res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim(), cut: res.stopReason === "length" };
    };
    const pins = collectPins(branchEntries as any[], cut.firstKeptEntryIndex);
    try {
      let running = stripPinned(preparation.previousSummary);
      for (let i = 0; i < chunks.length; i++) {
        if (signal.aborted) return;
        const text = serializeConversation(convertToLlm(chunks[i] as any));
        let r = await ask(summaryPrompt(text, running, instructions, e.summaryWords));
        if (r.cut) r = await ask(shortenPrompt(r.text, Math.floor(e.summaryWords * 0.7)));
        if (!r.text) throw new Error(`empty summary for chunk ${i + 1}`);
        running = r.text;
        log({ event: "chunk_done", chunk: i + 1, of: chunks.length, inputTokens: estimateText(text), summaryTokens: estimateText(r.text), cut: r.cut });
      }
      compacting = false;
      return { compaction: { summary: composeSummary(pins, running!), firstKeptEntryId: firstKept.id, tokensBefore: preparation.tokensBefore, usage, details: { summarizer: `${summarizer.provider}/${summarizer.id}`, profile: e.profile, chunks: chunks.length, keepRecentTokens: e.keepRecentTokens, masked: lastMasked, pins: pins.map((p) => p.label) } } };
    } catch (err: any) {
      if (signal.aborted) return;
      log({ event: "compact_error", error: String(err?.message ?? err) });
      ctx.ui.notify(`mgm compaction failed (${err?.message ?? err}); falling back to pi's default`, "warning");
      return;
    }
  });

  pi.on("session_compact", async (ev, ctx) => {
    compacting = false; backoffUntilPercent = 0;
    const d: any = ev.compactionEntry.details ?? {};
    log({ event: "compacted", fromExtension: ev.fromExtension, summaryTokens: estimateText(ev.compactionEntry.summary), tokensBefore: ev.compactionEntry.tokensBefore, details: d });
    ctx.ui.notify(`Compacted: ${ev.compactionEntry.tokensBefore.toLocaleString()} → ~${estimateText(ev.compactionEntry.summary)} tokens${d.summarizer ? ` (${d.summarizer}, ${d.profile ?? ""})` : ""}`, "info");
    refreshStatus(ctx);
  });
  pi.on("session_compact_failed", async (ev, ctx) => { compacting = false; log({ event: "compact_failed", reason: ev.reason, error: ev.errorMessage }); refreshStatus(ctx); });

  // 4. proactive trigger while idle
  pi.on("agent_end", async (_ev, ctx) => {
    refreshStatus(ctx);
    const u = ctx.getContextUsage?.(); const e = eff(ctx);
    if (process.env.MGM_COMPACTION_DEBUG) log({ event: "overhead", tokens: u?.tokens, percent: u?.percent, window: e.contextWindow, profile: e.profile });
    if (!compacting && u?.percent != null && u.percent >= e.triggerPercent && u.percent >= backoffUntilPercent) {
      compacting = true;
      log({ event: "proactive_trigger", percent: u.percent, tokens: u.tokens, window: e.contextWindow, threshold: e.triggerPercent });
      ctx.compact({ onError: (err) => { compacting = false; if (/nothing to compact/i.test(err.message)) backoffUntilPercent = (u.percent ?? 0) + 10; } });
    }
  });
  pi.on("turn_end", async (_ev, ctx) => refreshStatus(ctx));
  pi.on("model_select", async (_ev, ctx) => refreshStatus(ctx));

  pi.registerCommand("pin", {
    description: "Keep text verbatim across compactions: /pin <text>, or /pin alone to pin your last message",
    handler: async (args, ctx) => {
      let text = args.trim();
      if (!text) { const last = [...ctx.sessionManager.getEntries()].reverse().find((x: any) => x.type === "message" && x.message?.role === "user") as any; const c = last?.message?.content; text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : ""; }
      if (!text) { ctx.ui.notify("Nothing to pin", "warning"); return; }
      pi.appendEntry("mgm-pin", { text });
      ctx.ui.notify(`Pinned (${text.length} chars); carried verbatim through every compaction`, "info");
    },
  });

  // ---------- /compaction dialog ----------
  async function dialog(ctx: any) {
    for (;;) {
      const e = eff(ctx); const u = ctx.getContextUsage?.(); const s = summarizerSetting();
      const profileLabel = e.prefs.profile && e.prefs.profile !== "auto" ? `${e.profile} (pinned)` : `auto → ${e.profile} (${e.detected.code} code / ${e.detected.research} research calls)`;
      const items = [
        `Summarizer: ${s.value}${s.source === "default" ? "  (default)" : s.source === "MGM_SUMMARY_MODEL" ? "  (env override)" : ""}`,
        `Profile: ${profileLabel}`,
        `Pruning: keep newest ${e.keepResults} tool results, mask > ${e.maskMinChars} chars${e.prefs.keepResults != null ? "  (custom)" : ""}`,
        `Masking: ${e.masking ? "on" : "off"}`,
        `Trigger: compact at ${e.triggerPercent}% of ${Math.round(e.contextWindow / 1000)}k${e.prefs.triggerPercent != null ? "  (custom)" : ""}  — now ${u?.percent == null ? "?" : Math.round(u.percent) + "%"}`,
        `Summary length: ≤ ${e.summaryWords} words${e.prefs.summaryWords != null ? "  (custom)" : ""}`,
        "Compact now",
        "Reset to defaults",
        "Close",
      ];
      const pick = await ctx.ui.select("Compaction settings", items);
      if (!pick || pick === "Close") return;
      if (pick.startsWith("Summarizer")) {
        if (process.env.MGM_SUMMARY_MODEL) { ctx.ui.notify("MGM_SUMMARY_MODEL is set in the environment and overrides this setting", "warning"); continue; }
        const ranked = rankSummarizers(ctx.modelRegistry.getAvailable().filter((m: any) => ctx.modelRegistry.hasConfiguredAuth(m)).map((m: any) => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow, cost: m.cost })));
        const opts = [`self  —  the working model (${ctx.model ? ctx.model.provider + "/" + ctx.model.id : "?"})`, `default  —  ${DEFAULT_SUMMARIZER}`, ...ranked.map((r) => r.label)];
        const m = await ctx.ui.select("Summarizer (cheapest first; $/fold = 10k in + 1.5k out)", opts);
        if (!m) continue;
        const key = m.startsWith("self") ? "self" : m.startsWith("default") ? undefined : m.split("  —  ")[0];
        writePrefs({ summaryModel: key }); ctx.ui.notify(`Summarizer: ${key ?? DEFAULT_SUMMARIZER}`, "info");
      } else if (pick.startsWith("Profile")) {
        const m = await ctx.ui.select("Profile", ["auto  —  detect from tool usage each session", "code  —  keep paths, symbols, commands, errors; prune tool output aggressively", "research  —  keep sources, figures, conclusions; keep more tool output", "chat  —  keep preferences and decisions; prune hardest"]);
        if (m) writePrefs({ profile: m.split("  —  ")[0] as any });
      } else if (pick.startsWith("Pruning")) {
        const v = await ctx.ui.input("Newest tool results to keep verbatim (blank = profile default)", String(e.keepResults));
        if (v !== undefined) writePrefs({ keepResults: v.trim() === "" ? undefined : Math.max(1, Number(v) || e.keepResults) });
      } else if (pick.startsWith("Masking")) {
        writePrefs({ masking: !e.masking });
      } else if (pick.startsWith("Trigger")) {
        const v = await ctx.ui.input("Compact when context reaches this % (blank = default)", String(e.triggerPercent));
        if (v !== undefined) writePrefs({ triggerPercent: v.trim() === "" ? undefined : Math.min(95, Math.max(20, Number(v) || e.triggerPercent)) });
      } else if (pick.startsWith("Summary length")) {
        const v = await ctx.ui.input("Summary word budget (blank = default)", String(e.summaryWords));
        if (v !== undefined) writePrefs({ summaryWords: v.trim() === "" ? undefined : Math.min(3000, Math.max(150, Number(v) || e.summaryWords)) });
      } else if (pick === "Compact now") {
        compacting = true; ctx.compact({ onError: (err: Error) => { compacting = false; ctx.ui.notify(`Compaction failed: ${err.message}`, "error"); } }); return;
      } else if (pick === "Reset to defaults") {
        writePrefs({ summaryModel: undefined, profile: undefined, keepResults: undefined, triggerPercent: undefined, masking: undefined, summaryWords: undefined }); ctx.ui.notify("Compaction settings reset", "info");
      }
      refreshStatus(ctx);
    }
  }

  pi.registerCommand("compaction", {
    description: "Compaction settings dialog; `/compaction now`; `/compaction model <provider/id|self|default>`",
    getArgumentCompletions: (prefix) => {
      const [first, second] = prefix.split(/\s+/);
      if (first === "model") return ["self", "default", ...(ctx0.registry?.getAvailable().map((m: any) => `${m.provider}/${m.id}`) ?? [])].filter((m) => m.startsWith(second ?? "")).map((m) => ({ value: `model ${m}`, label: m }));
      return ["now", "model"].filter((c) => c.startsWith(first ?? "")).map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === "now") { compacting = true; ctx.compact({ onError: (err) => { compacting = false; ctx.ui.notify(`Compaction failed: ${err.message}`, "error"); } }); return; }
      if (sub === "model") {
        const v = rest[0];
        if (!v) { const p = summarizerSetting(); ctx.ui.notify(`summarizer: ${p.value} (from ${p.source})`, "info"); return; }
        if (v === "default") { writePrefs({ summaryModel: undefined }); ctx.ui.notify(`summarizer reset to ${DEFAULT_SUMMARIZER}`, "info"); return; }
        if (v !== "self") { const m = findModel(v); if (!m) { ctx.ui.notify(`Unknown model "${v}"`, "error"); return; } if (!ctx.modelRegistry.hasConfiguredAuth(m)) ctx.ui.notify(`${v} has no credentials; compaction will fall back to the working model`, "warning"); }
        writePrefs({ summaryModel: v }); ctx.ui.notify(`summarizer set to ${v}`, "info"); return;
      }
      if (!ctx.hasUI) { const e = eff(ctx); ctx.ui.notify(`summarizer ${summarizerSetting().value}; profile ${e.profile}; keep ${e.keepResults} results; trigger ${e.triggerPercent}%`, "info"); return; }
      await dialog(ctx);
    },
  });
}
