/**
 * Pure logic for mgm's compaction extension. Unit-tested in tests/compaction.test.ts.
 *
 * Why this exists: pi's defaults (reserve 16k, keep 20k recent, one summarization request to the
 * same model with no input cap) cannot work inside a 32k window. This module sizes everything from
 * the model's real context window, prunes old tool output before any summary is needed, and folds
 * history into a summary in chunks small enough for the summarizer.
 */

export type Budgets = {
  contextWindow: number;
  keepRecentTokens: number;   // verbatim tail kept after compaction
  summaryMaxTokens: number;   // hard cap on the summary the model may write
  chunkTokens: number;        // max serialized history per summarization request
  triggerPercent: number;     // proactive compaction point (agent idle)
  keepResults: number;        // most recent tool results kept verbatim; older large ones get pruned
  maskMinChars: number;       // ...if larger than this
  small: boolean;             // window ≤ 64k: aggressive settings
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

export function budgets(contextWindow: number): Budgets {
  const w = contextWindow > 0 ? contextWindow : 128_000;
  const small = w <= 65_536;
  return {
    contextWindow: w,
    keepRecentTokens: clamp(w * 0.25, 4_000, 40_000),
    summaryMaxTokens: clamp(w * 0.05, 1_000, 3_000),
    // 30%, not more: pi estimates chars/4 but code and lockfiles tokenize nearer chars/2.5
    chunkTokens: clamp(w * 0.3, 6_000, 40_000),
    triggerPercent: small ? 60 : 85,
    keepResults: small ? 2 : 8,
    maskMinChars: small ? 1_500 : 4_000,
    small,
  };
}

/** Same chars/4 heuristic pi uses for trailing messages. */
export const estimateText = (s: string) => Math.ceil(s.length / 4);

// ---------- observation masking ----------
type Block = { type: string; text?: string; [k: string]: unknown };
export type Msg = { role: string; content?: Block[] | string; toolName?: string; toolCallId?: string; [k: string]: unknown };

export const ELIDED_MARK = "elided by mgm compaction";

export type MaskResult = { messages: Msg[]; masked: number; savedChars: number };

/**
 * Replace the body of large tool results, except the most recent `keepResults`, with a short head
 * plus a marker. Recency is by tool result, not by user turn, so a long read/grep loop inside one
 * turn is pruned too (the pattern that overflows small windows). Tool-call blocks and the result's
 * identity are untouched, so the call/result pairing stays valid.
 */
export function maskOldToolResults(messages: Msg[], opts: { keepResults: number; minChars: number; headChars?: number }): MaskResult {
  const headChars = opts.headChars ?? 400;
  const resultIdx = messages.map((m, i) => (m.role === "toolResult" ? i : -1)).filter((i) => i >= 0);
  const protectedFrom = resultIdx.length > opts.keepResults ? resultIdx[resultIdx.length - opts.keepResults] : (resultIdx[0] ?? messages.length);
  let masked = 0, savedChars = 0;
  const out = messages.map((m, i) => {
    if (i >= protectedFrom || m.role !== "toolResult" || !Array.isArray(m.content)) return m;
    const text = m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    if (text.length <= opts.minChars || text.includes(ELIDED_MARK)) return m;
    const head = text.slice(0, headChars).trimEnd();
    const marker = `${head}\n…[${text.length - head.length} more chars of ${m.toolName ?? "tool"} output ${ELIDED_MARK}; re-run the tool if you need it]`;
    masked++; savedChars += text.length - marker.length;
    return { ...m, content: [{ type: "text", text: marker }, ...m.content.filter((b) => b.type !== "text")] };
  });
  return { messages: out, masked, savedChars };
}

// ---------- chunking ----------
/**
 * Split messages into consecutive chunks whose estimated size stays under `maxTokens`.
 * A chunk never starts with a tool result (it belongs to the assistant call before it), and a
 * single oversized message still gets its own chunk rather than being dropped.
 */
export function chunkMessages<T>(messages: T[], maxTokens: number, estimate: (m: T) => number, isToolResult: (m: T) => boolean): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [], size = 0;
  for (const m of messages) {
    const t = estimate(m);
    if (cur.length && size + t > maxTokens && !isToolResult(m)) { chunks.push(cur); cur = []; size = 0; }
    cur.push(m); size += t;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ---------- prompts (same section layout pi's built-in summary uses, so the model sees one format) ----------
export const SUMMARY_SYSTEM_PROMPT = "You write context checkpoints for a coding agent that will continue the work with a small context window. Be precise and terse. Never invent details. Output markdown only, no preamble.";

const TEMPLATE = `## Goal
[what the user is trying to accomplish]

## Constraints & Preferences
- [requirements or preferences the user stated]

## Progress
### Done
- [x] [completed]
### In Progress
- [ ] [current]
### Blocked
- [issues, or "none"]

## Key Decisions
- **[decision]**: [rationale]

## Next Steps
1. [what should happen next]

## Critical Context
- [exact paths, commands, identifiers, error messages needed to continue]

<read-files>
[one path per line]
</read-files>
<modified-files>
[one path per line]
</modified-files>`;

export function summaryPrompt(conversationText: string, previousSummary: string | undefined, instructions: string | undefined, maxWords: number): string {
  const head = previousSummary
    ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n<new-messages>\n${conversationText}\n</new-messages>\n\nUpdate the previous summary with the new messages. Keep everything still relevant, drop what is superseded, and merge the file lists.`
    : `<conversation>\n${conversationText}\n</conversation>\n\nSummarize the conversation as a context checkpoint.`;
  const focus = instructions ? `\n\nAdditional focus: ${instructions}` : "";
  return `${head}${focus}\n\nUse EXACTLY this format, including both file lists (leave a list empty if nothing applies). You have up to ${maxWords} words: prefer completeness over brevity. Keep every path, command, identifier, API or function name, URL, version and error message verbatim; drop pleasantries and narration.\n\n${TEMPLATE}`;
}

export function shortenPrompt(partialSummary: string, maxWords: number): string {
  return `The following summary was cut off because it was too long. Rewrite it complete and under ${maxWords} words, same sections, keeping the most recent state and every path, command and identifier:\n\n${partialSummary}`;
}

/** ~0.75 words per token, with headroom so a compliant answer never hits the cap. */
export const wordBudget = (maxTokens: number) => Math.max(150, Math.floor(maxTokens * 0.55));

// ---------- summarizer selection ----------
export type ModelRef = { provider: string; id: string; contextWindow: number };

/**
 * Prefer the configured summarizer (e.g. a cheap cloud model via LiteLLM) when it exists and is
 * authenticated; otherwise summarize with the working model itself, chunked to its window.
 */
export function pickSummarizer(current: ModelRef, preferred: string | undefined, find: (provider: string, id: string) => ModelRef | undefined, hasAuth: (m: ModelRef) => boolean): { model: ModelRef; reason: string } {
  if (preferred) {
    const slash = preferred.indexOf("/");
    if (slash > 0) {
      const m = find(preferred.slice(0, slash), preferred.slice(slash + 1));
      if (m && hasAuth(m)) return { model: m, reason: "configured summarizer" };
      return { model: current, reason: m ? `${preferred} has no credentials` : `${preferred} not found` };
    }
  }
  return { model: current, reason: "no summarizer configured" };
}

export function statusText(percent: number | null | undefined, masked: number, small: boolean): string {
  const pct = percent == null ? "?" : `${Math.round(percent)}%`;
  const pruned = masked ? ` · ${masked} pruned` : "";
  return `${small ? "◔" : "◕"} ctx ${pct}${pruned}`;
}

// ---------- pinned content: survives compaction verbatim, outside the model-written summary ----------
export type Pin = { label: string; text: string };
const PIN_OPEN = "<pinned-context>", PIN_CLOSE = "</pinned-context>";

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("\n") : "";

/**
 * What to carry verbatim across a compaction, given the branch entries and the index where kept
 * messages start: the first user message on the branch (the original request), extension-injected
 * custom messages that would otherwise vanish, and anything the user pinned with /pin.
 */
export function collectPins(entries: any[], firstKeptIndex: number, maxChars = 4_000): Pin[] {
  const pins: Pin[] = [];
  const first = entries.find((e) => e?.type === "message" && e.message?.role === "user");
  if (first) pins.push({ label: "original request", text: textOf(first.message.content) });
  for (const e of entries.slice(0, firstKeptIndex)) {
    if (e?.type === "custom_message" && e.customType !== "compaction") pins.push({ label: e.customType, text: textOf(e.content) });
    else if (e?.type === "custom" && e.customType === "mgm-pin" && e.data?.text) pins.push({ label: "pinned", text: String(e.data.text) });
  }
  return pins.filter((p) => p.text.trim()).map((p) => ({ label: p.label, text: p.text.length > maxChars ? p.text.slice(0, maxChars) + "\n…[truncated]" : p.text }));
}

export function pinnedBlock(pins: Pin[]): string {
  if (!pins.length) return "";
  return `${PIN_OPEN}\n${pins.map((p) => `[${p.label}]\n${p.text}`).join("\n\n")}\n${PIN_CLOSE}`;
}

/** Final summary text = pinned block + model summary; the model never sees or rewrites the block. */
export function composeSummary(pins: Pin[], modelSummary: string): string {
  const block = pinnedBlock(pins);
  return block ? `${block}\n\n${modelSummary}` : modelSummary;
}

/** Strip a pinned block from a previous summary before handing it back to the model. */
export function stripPinned(summary: string | undefined): string | undefined {
  if (!summary) return summary;
  const a = summary.indexOf(PIN_OPEN), b = summary.indexOf(PIN_CLOSE);
  if (a < 0 || b < 0) return summary;
  return (summary.slice(0, a) + summary.slice(b + PIN_CLOSE.length)).trim() || undefined;
}

// ---------- profiles and user preferences ----------
export type Profile = "code" | "research" | "chat";
export type Prefs = {
  profile?: Profile | "auto";
  keepResults?: number;        // override: newest tool results kept verbatim
  triggerPercent?: number;     // override: proactive compaction point
  masking?: boolean;           // observation masking on/off
  summaryWords?: number;       // override: summary word budget
};

/** Per-profile tuning applied on top of the window-derived budgets. */
export const PROFILE_TUNING: Record<Profile, { keepResultsDelta: number; maskMinCharsFactor: number; focus: string }> = {
  code: { keepResultsDelta: 0, maskMinCharsFactor: 1, focus: "This is software work. Keep every file path, function or symbol name, command, error message, version and test result verbatim. Record what was changed in each file and what remains unverified." },
  research: { keepResultsDelta: +2, maskMinCharsFactor: 2, focus: "This is research or reading. Keep every source URL, document title, quoted figure and the conclusion drawn from each; preserve open questions and disagreements between sources." },
  chat: { keepResultsDelta: -1, maskMinCharsFactor: 0.5, focus: "This is a conversation. Keep the user's stated preferences, decisions and their reasons, and any commitments made." },
};

const CODE_TOOLS = new Set(["read", "edit", "write", "bash", "grep", "find", "ls", "codebase_search", "lsp_diagnostics", "lsp_definition", "lsp_references", "call_graph"]);
const RESEARCH_TOOLS = new Set(["web_search", "fetch_content", "fetch", "mcp", "search_ce_knowledge_base", "memory_search"]);

/** Infer the profile from tool usage on the branch; no LLM call, deterministic. */
export function detectProfile(entries: any[]): { profile: Profile; code: number; research: number; total: number } {
  let code = 0, research = 0, total = 0;
  for (const e of entries) {
    if (e?.type !== "message" || e.message?.role !== "assistant" || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (b?.type !== "toolCall") continue;
      total++;
      if (CODE_TOOLS.has(b.name)) code++;
      else if (RESEARCH_TOOLS.has(b.name)) research++;
    }
  }
  const profile: Profile = total === 0 ? "chat" : research > code ? "research" : code > 0 ? "code" : "chat";
  return { profile, code, research, total };
}

/** Effective settings = window budgets → profile tuning → explicit user overrides. */
export function effective(b: Budgets, profile: Profile, prefs: Prefs): Budgets & { profile: Profile; focus: string; masking: boolean; summaryWords: number } {
  const t = PROFILE_TUNING[profile];
  return {
    ...b,
    keepResults: prefs.keepResults ?? Math.max(1, b.keepResults + t.keepResultsDelta),
    maskMinChars: Math.round(b.maskMinChars * t.maskMinCharsFactor),
    triggerPercent: prefs.triggerPercent ?? b.triggerPercent,
    masking: prefs.masking ?? true,
    summaryWords: prefs.summaryWords ?? wordBudget(b.summaryMaxTokens),
    profile,
    focus: t.focus,
  };
}

/** Summarizer candidates for the picker: authenticated, big enough window, cheapest first, with a $/fold label. */
export type Candidate = { provider: string; id: string; contextWindow: number; cost?: { input: number; output: number } };
export function rankSummarizers(models: Candidate[], minWindow = 32_000): { key: string; label: string; perFold: number }[] {
  return models
    .filter((m) => m.contextWindow >= minWindow)
    .map((m) => { const perFold = ((m.cost?.input ?? 0) * 10 + (m.cost?.output ?? 0) * 1.5) / 1000; return { key: `${m.provider}/${m.id}`, perFold, label: `${m.provider}/${m.id}  —  ${perFold === 0 ? "free" : "$" + perFold.toFixed(4) + "/fold"}, ${Math.round(m.contextWindow / 1000)}k ctx` }; })
    .sort((a, b) => a.perFold - b.perFold || a.key.localeCompare(b.key));
}
