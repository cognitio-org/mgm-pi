/**
 * mgm compaction — makes pi's compaction work inside small context windows (32k local models)
 * and cheaper everywhere:
 *
 *  1. Observation masking (`context` hook): all but the most recent N large tool results are
 *     replaced by a short head + marker on every request. No LLM call; the session file keeps
 *     the full output. This alone removes most of the pressure that triggers compaction.
 *  2. Chunked summarization (`session_before_compact`): history is folded into the summary in
 *     chunks no larger than 40% of the summarizer's window, with a hard cap on summary length and
 *     a "shorten" retry instead of pi's discard-on-length. Budgets derive from ctx.model.contextWindow.
 *  3. Configurable summarizer: `/compaction model <provider/id>` (persisted in settings.json as
 *     mgm.summaryModel; MGM_SUMMARY_MODEL overrides; default litellm/gpt-5.4-nano; "self" =
 *     the working model). Falls back to the working model when the choice has no credentials.
 *  4. Proactive trigger (`agent_end`): compact at 70% (small windows) / 85% instead of waiting for
 *     pi's reserve threshold or an overflow error, because LM Studio silently truncates the prompt
 *     on overflow and pi never sees an error to recover from.
 *
 *  Pinned content — the first user message, extension-injected custom messages and /pin text — is
 *  carried verbatim in a <pinned-context> block ahead of the model-written summary; the model never
 *  sees or rewrites it. The system prompt and tool schemas live outside the message list entirely.
 *
 *  /pin [text]          keep text verbatim across compactions
 *  /compaction          show budgets, summarizer, pruning stats
 *  /compaction now      compact immediately
 *  MGM_COMPACTION=off   disable everything; MGM_COMPACTION_LOG=<file> appends a JSON line per event
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation, estimateTokens, findCutPoint } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
  type Msg, budgets, estimateText, maskOldToolResults, chunkMessages, summaryPrompt, shortenPrompt,
  wordBudget, pickSummarizer, statusText, SUMMARY_SYSTEM_PROMPT, collectPins, composeSummary, stripPinned,
} from "./lib.ts";

const OFF = process.env.MGM_COMPACTION === "off";
const DEFAULT_SUMMARIZER = "litellm/gpt-5.4-nano";   // see docs/summarizer-benchmark.md
// Summarizer resolution: MGM_SUMMARY_MODEL env > settings.json "mgm": {"summaryModel"} > default.
// "self" means: always summarize with the working model.
const settingsPath = () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");
const readSettings = (): any => { try { return JSON.parse(readFileSync(settingsPath(), "utf8")); } catch { return {}; } };
function summarizerSetting(): { value: string; source: string } {
  if (process.env.MGM_SUMMARY_MODEL) return { value: process.env.MGM_SUMMARY_MODEL, source: "MGM_SUMMARY_MODEL" };
  const v = readSettings().mgm?.summaryModel;
  return v ? { value: String(v), source: "settings.json mgm.summaryModel" } : { value: DEFAULT_SUMMARIZER, source: "default" };
}
function saveSummarizer(value: string | undefined) {
  const s = readSettings(); s.mgm = { ...(s.mgm ?? {}) };
  if (value) s.mgm.summaryModel = value; else delete s.mgm.summaryModel;
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + "\n");
}
const log = (o: object) => { if (process.env.MGM_COMPACTION_LOG) appendFileSync(process.env.MGM_COMPACTION_LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n"); };

let ctx0Models: () => string[] = () => [];
export default function (pi: ExtensionAPI) {
  if (OFF) return;
  pi.on("session_start", async (_ev, ctx) => { ctx0Models = () => ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`); });
  let lastMasked = 0, lastSaved = 0;
  let compacting = false;
  let backoffUntilPercent = 0;   // after "nothing to compact", wait until usage grows before retrying
  const b = (ctx: any) => budgets(ctx.model?.contextWindow ?? 128_000);
  const refreshStatus = (ctx: any) => {
    const u = ctx.getContextUsage?.();
    ctx.ui.setStatus("compaction", statusText(u?.percent, lastMasked, b(ctx).small));
  };

  // 1. observation masking on every request
  pi.on("context", async (ev, ctx) => {
    const bud = b(ctx);
    if (process.env.MGM_COMPACTION_DEBUG) log({ event: "context", n: ev.messages.length, roles: ev.messages.map((m: any) => m.role + (m.role === "toolResult" ? `(${Array.isArray(m.content) ? m.content.map((c: any) => c.type === "text" ? c.text?.length : c.type).join("+") : typeof m.content})` : "")) });
    const r = maskOldToolResults(ev.messages as unknown as Msg[], { keepResults: bud.keepResults, minChars: bud.maskMinChars });
    lastMasked = r.masked; lastSaved = r.savedChars;
    if (r.masked) log({ event: "mask", masked: r.masked, savedChars: r.savedChars, window: bud.contextWindow });
    return { messages: r.messages as any };
  });

  // 2 + 3. chunked summarization, preferably with a cloud model
  pi.on("session_before_compact", async (ev, ctx) => {
    const { preparation, branchEntries, customInstructions, reason, signal } = ev;
    const bud = b(ctx);
    const current = ctx.model;
    if (!current) return;

    // Our own cut point sized to this model's window; pi's came from the global keepRecentTokens.
    let boundaryStart = 0;
    for (let i = branchEntries.length - 1; i >= 0; i--) {
      const e: any = branchEntries[i];
      if (e.type === "compaction") { const k = branchEntries.findIndex((x: any) => x.id === e.firstKeptEntryId); boundaryStart = k >= 0 ? k : i + 1; break; }
    }
    const cut = findCutPoint(branchEntries as any, boundaryStart, branchEntries.length, bud.keepRecentTokens);
    const firstKept: any = branchEntries[cut.firstKeptEntryIndex];
    const toSummarize = (branchEntries.slice(boundaryStart, cut.firstKeptEntryIndex) as any[]).filter((e) => e.type === "message").map((e) => e.message);
    if (!firstKept?.id || toSummarize.length === 0) return;   // let pi's default handle it

    const pref = summarizerSetting().value;
    const pick = pickSummarizer(
      { provider: current.provider, id: current.id, contextWindow: current.contextWindow },
      pref === "self" ? undefined : pref,
      (p, id) => { const m = ctx.modelRegistry.find(p, id); return m ? { provider: m.provider, id: m.id, contextWindow: m.contextWindow } : undefined; },
      (m) => { const full = ctx.modelRegistry.find(m.provider, m.id); return !!full && ctx.modelRegistry.hasConfiguredAuth(full); },
    );
    const summarizer = ctx.modelRegistry.find(pick.model.provider, pick.model.id)!;
    const chunkTokens = Math.min(bud.chunkTokens, budgets(summarizer.contextWindow).chunkTokens);
    const maxTokens = Math.min(bud.summaryMaxTokens, summarizer.maxTokens > 0 ? summarizer.maxTokens : Infinity);
    const words = wordBudget(maxTokens);
    const chunks = chunkMessages(toSummarize, chunkTokens, (m) => estimateTokens(m), (m: any) => m.role === "toolResult");

    ctx.ui.notify(`Compacting (${reason}): ${toSummarize.length} messages in ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} via ${summarizer.provider}/${summarizer.id}, keeping ~${bud.keepRecentTokens} recent tokens`, "info");
    log({ event: "compact_start", reason, messages: toSummarize.length, chunks: chunks.length, summarizer: `${summarizer.provider}/${summarizer.id}`, why: pick.reason, keepRecent: bud.keepRecentTokens, chunkTokens, maxTokens });

    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const addUsage = (u: any) => { if (!u) return; for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) (usage as any)[k] += u[k] ?? 0; for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[k] += u.cost?.[k] ?? 0; };
    const ask = async (text: string) => {
      const res = await ctx.modelRegistry.complete(summarizer, { systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] } as any, { maxTokens, signal, cacheRetention: "none", sessionId: uuidv7() } as any);
      addUsage(res.usage);
      const out = res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      if (res.stopReason === "error") throw new Error(res.errorMessage ?? "summarizer error");
      return { text: out, cut: res.stopReason === "length" };
    };

    const pins = collectPins(branchEntries as any[], cut.firstKeptEntryIndex);
    try {
      let running = stripPinned(preparation.previousSummary);
      for (let i = 0; i < chunks.length; i++) {
        if (signal.aborted) return;
        const text = serializeConversation(convertToLlm(chunks[i] as any));
        let r = await ask(summaryPrompt(text, running, customInstructions, words));
        if (r.cut) r = await ask(shortenPrompt(r.text, Math.floor(words * 0.7)));
        if (!r.text) throw new Error(`empty summary for chunk ${i + 1}`);
        running = r.text;
        log({ event: "chunk_done", chunk: i + 1, of: chunks.length, inputTokens: estimateText(text), summaryTokens: estimateText(r.text), cut: r.cut });
      }
      compacting = false;
      return { compaction: { summary: composeSummary(pins, running!), firstKeptEntryId: firstKept.id, tokensBefore: preparation.tokensBefore, usage, details: { summarizer: `${summarizer.provider}/${summarizer.id}`, chunks: chunks.length, keepRecentTokens: bud.keepRecentTokens, masked: lastMasked, pins: pins.map((p) => p.label) } } };
    } catch (e: any) {
      if (signal.aborted) return;
      log({ event: "compact_error", error: String(e?.message ?? e) });
      ctx.ui.notify(`mgm compaction failed (${e?.message ?? e}); falling back to pi's default`, "warning");
      return;   // undefined → pi runs its built-in summarization
    }
  });

  pi.on("session_compact", async (ev, ctx) => {
    compacting = false;
    const d: any = ev.compactionEntry.details ?? {};
    log({ event: "compacted", fromExtension: ev.fromExtension, summaryTokens: estimateText(ev.compactionEntry.summary), tokensBefore: ev.compactionEntry.tokensBefore, details: d });
    ctx.ui.notify(`Compacted: ${ev.compactionEntry.tokensBefore.toLocaleString()} → summary of ~${estimateText(ev.compactionEntry.summary)} tokens${d.summarizer ? ` (${d.summarizer}, ${d.chunks} chunk${d.chunks === 1 ? "" : "s"})` : ""}`, "info");
    refreshStatus(ctx);
  });
  pi.on("session_compact_failed", async (ev, ctx) => { compacting = false; log({ event: "compact_failed", reason: ev.reason, error: ev.errorMessage }); refreshStatus(ctx); });
  pi.on("session_compact", async () => { backoffUntilPercent = 0; });

  // 4. proactive trigger while the agent is idle
  pi.on("agent_end", async (_ev, ctx) => {
    refreshStatus(ctx);
    const u = ctx.getContextUsage?.();
    const bud = b(ctx);
    if (!compacting && u?.percent != null && u.percent >= bud.triggerPercent && u.percent >= backoffUntilPercent) {
      compacting = true;
      log({ event: "proactive_trigger", percent: u.percent, tokens: u.tokens, window: bud.contextWindow, threshold: bud.triggerPercent });
      ctx.compact({ onError: (e) => { compacting = false; if (/nothing to compact/i.test(e.message)) backoffUntilPercent = (u.percent ?? 0) + 10; } });
    }
  });
  pi.on("turn_end", async (_ev, ctx) => refreshStatus(ctx));
  pi.on("agent_end", async (_ev, ctx) => { if (process.env.MGM_COMPACTION_DEBUG) { const u = ctx.getContextUsage?.(); log({ event: "overhead", tokens: u?.tokens, percent: u?.percent, window: b(ctx).contextWindow }); } });
  pi.on("session_start", async (_ev, ctx) => refreshStatus(ctx));
  pi.on("model_select", async (_ev, ctx) => refreshStatus(ctx));

  pi.registerCommand("pin", {
    description: "Keep text verbatim across compactions: /pin <text>, or /pin alone to pin your last message",
    handler: async (args, ctx) => {
      let text = args.trim();
      if (!text) {
        const last = [...ctx.sessionManager.getEntries()].reverse().find((e: any) => e.type === "message" && e.message?.role === "user") as any;
        const c = last?.message?.content;
        text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
      }
      if (!text) { ctx.ui.notify("Nothing to pin", "warning"); return; }
      pi.appendEntry("mgm-pin", { text });
      ctx.ui.notify(`Pinned (${text.length} chars); it will be carried verbatim through every compaction`, "info");
    },
  });

  pi.registerCommand("compaction", {
    description: "Compaction: status | now | model <provider/id|self|default>",
    getArgumentCompletions: (prefix) => {
      const [first, second] = prefix.split(/\s+/);
      if (first === "model") {
        const ids = ["self", "default", ...ctx0Models()].filter((m) => m.startsWith(second ?? ""));
        return ids.map((m) => ({ value: `model ${m}`, label: m }));
      }
      return ["now", "model"].filter((c) => c.startsWith(first ?? "")).map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === "model") {
        const v = rest[0];
        if (!v) { const p = summarizerSetting(); ctx.ui.notify(`summarizer: ${p.value} (from ${p.source}). Usage: /compaction model <provider/id> | self | default`, "info"); return; }
        if (process.env.MGM_SUMMARY_MODEL) { ctx.ui.notify(`MGM_SUMMARY_MODEL=${process.env.MGM_SUMMARY_MODEL} is set in the environment and overrides settings; unset it to use this`, "warning"); }
        if (v === "default") { saveSummarizer(undefined); ctx.ui.notify(`summarizer reset to ${DEFAULT_SUMMARIZER}`, "info"); return; }
        if (v !== "self") {
          const slash = v.indexOf("/");
          const m = slash > 0 ? ctx.modelRegistry.find(v.slice(0, slash), v.slice(slash + 1)) : undefined;
          if (!m) { ctx.ui.notify(`Unknown model "${v}". Use provider/id as shown by /model, or self`, "error"); return; }
          if (!ctx.modelRegistry.hasConfiguredAuth(m)) ctx.ui.notify(`${v} has no credentials yet; compaction will fall back to the working model until it does`, "warning");
        }
        saveSummarizer(v); ctx.ui.notify(`summarizer set to ${v} (saved in settings.json)`, "info"); return;
      }
      if (sub === "now") { compacting = true; ctx.compact({ onError: (e) => { compacting = false; ctx.ui.notify(`Compaction failed: ${e.message}`, "error"); } }); return; }
      const bud = b(ctx); const u = ctx.getContextUsage?.();
      const cur = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, contextWindow: ctx.model.contextWindow } : undefined;
      const pref = summarizerSetting();
      const pick = cur ? pickSummarizer(cur, pref.value === "self" ? undefined : pref.value, (p, id) => { const m = ctx.modelRegistry.find(p, id); return m ? { provider: m.provider, id: m.id, contextWindow: m.contextWindow } : undefined; }, (m) => { const f = ctx.modelRegistry.find(m.provider, m.id); return !!f && ctx.modelRegistry.hasConfiguredAuth(f); }) : undefined;
      ctx.ui.notify([
        `context ${u?.tokens?.toLocaleString() ?? "?"} / ${bud.contextWindow.toLocaleString()} tokens (${u?.percent == null ? "?" : Math.round(u.percent) + "%"}) — proactive compaction at ${bud.triggerPercent}%`,
        `after compaction keep ~${bud.keepRecentTokens.toLocaleString()} recent tokens; summary ≤ ${bud.summaryMaxTokens} tokens; ≤ ${bud.chunkTokens.toLocaleString()} tokens per summarizer request`,
        `pruning: tool results > ${bud.maskMinChars} chars except the newest ${bud.keepResults} — currently ${lastMasked} pruned, ~${Math.round(lastSaved / 4).toLocaleString()} tokens saved`,
        pick ? `summarizer: ${pick.model.provider}/${pick.model.id} (${pick.reason}; setting "${pref.value}" from ${pref.source})` : "",
        `change with /compaction model <provider/id> | self | default`,
      ].filter(Boolean).join("\n"), "info");
    },
  });
}
