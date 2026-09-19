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
 *  3. Cloud summarizer: MGM_SUMMARY_MODEL (default litellm/claude-haiku-4-5) writes the summary
 *     when reachable; otherwise the working model does, chunked to its own window.
 *  4. Proactive trigger (`agent_end`): compact at 70% (small windows) / 85% instead of waiting for
 *     pi's reserve threshold or an overflow error, because LM Studio silently truncates the prompt
 *     on overflow and pi never sees an error to recover from.
 *
 *  /compaction          show budgets, summarizer, pruning stats
 *  /compaction now      compact immediately
 *  MGM_COMPACTION=off   disable everything; MGM_COMPACTION_LOG=<file> appends a JSON line per event
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation, estimateTokens, findCutPoint } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
  type Msg, budgets, estimateText, maskOldToolResults, chunkMessages, summaryPrompt, shortenPrompt,
  wordBudget, pickSummarizer, statusText, SUMMARY_SYSTEM_PROMPT,
} from "./lib.ts";

const OFF = process.env.MGM_COMPACTION === "off";
const PREFERRED = process.env.MGM_SUMMARY_MODEL ?? "litellm/claude-haiku-4-5";
const log = (o: object) => { if (process.env.MGM_COMPACTION_LOG) appendFileSync(process.env.MGM_COMPACTION_LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n"); };

export default function (pi: ExtensionAPI) {
  if (OFF) return;
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

    const pick = pickSummarizer(
      { provider: current.provider, id: current.id, contextWindow: current.contextWindow },
      PREFERRED,
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

    try {
      let running = preparation.previousSummary;
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
      return { compaction: { summary: running!, firstKeptEntryId: firstKept.id, tokensBefore: preparation.tokensBefore, usage, details: { summarizer: `${summarizer.provider}/${summarizer.id}`, chunks: chunks.length, keepRecentTokens: bud.keepRecentTokens, masked: lastMasked } } };
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

  pi.registerCommand("compaction", {
    description: "Show compaction budgets for the current model, or `/compaction now` to compact",
    handler: async (args, ctx) => {
      if (args.trim() === "now") { compacting = true; ctx.compact({ onError: (e) => { compacting = false; ctx.ui.notify(`Compaction failed: ${e.message}`, "error"); } }); return; }
      const bud = b(ctx); const u = ctx.getContextUsage?.();
      const cur = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, contextWindow: ctx.model.contextWindow } : undefined;
      const pick = cur ? pickSummarizer(cur, PREFERRED, (p, id) => { const m = ctx.modelRegistry.find(p, id); return m ? { provider: m.provider, id: m.id, contextWindow: m.contextWindow } : undefined; }, (m) => { const f = ctx.modelRegistry.find(m.provider, m.id); return !!f && ctx.modelRegistry.hasConfiguredAuth(f); }) : undefined;
      ctx.ui.notify([
        `context ${u?.tokens?.toLocaleString() ?? "?"} / ${bud.contextWindow.toLocaleString()} tokens (${u?.percent == null ? "?" : Math.round(u.percent) + "%"}) — proactive compaction at ${bud.triggerPercent}%`,
        `after compaction keep ~${bud.keepRecentTokens.toLocaleString()} recent tokens; summary ≤ ${bud.summaryMaxTokens} tokens; ≤ ${bud.chunkTokens.toLocaleString()} tokens per summarizer request`,
        `pruning: tool results > ${bud.maskMinChars} chars except the newest ${bud.keepResults} — currently ${lastMasked} pruned, ~${Math.round(lastSaved / 4).toLocaleString()} tokens saved`,
        pick ? `summarizer: ${pick.model.provider}/${pick.model.id} (${pick.reason})` : "",
      ].filter(Boolean).join("\n"), "info");
    },
  });
}
