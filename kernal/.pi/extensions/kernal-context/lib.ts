/**
 * Pure analysis and rendering for /context. Tested without pi.
 *
 * The breakdown comes from the real provider payload (pi's `before_provider_request` hook), so the
 * proportions are measured rather than guessed: the system prompt, the tool schemas, and every
 * message as it is actually sent. Token counts are estimates from character counts, then scaled so
 * they sum to the provider's own reported total when one is known — accurate proportions, honest
 * total.
 */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export type Category = "system" | "tools" | "user" | "assistant" | "thinking" | "toolResults" | "images" | "other";
export const CATEGORY_LABELS: Record<Category, string> = {
  system: "system prompt",
  tools: "tool schemas",
  user: "your messages",
  assistant: "replies",
  thinking: "thinking",
  toolResults: "tool output",
  images: "images",
  other: "other",
};
/** Drawing order, largest structural pieces first so the bar reads consistently between runs. */
export const CATEGORY_ORDER: Category[] = ["system", "tools", "user", "assistant", "thinking", "toolResults", "images", "other"];

export type Breakdown = { tokens: Record<Category, number>; toolCount: number; messageCount: number; largestTools: { name: string; tokens: number }[] };

const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
};

/**
 * Measure an OpenAI-shaped request payload. Unknown shapes fall into "other" rather than being
 * dropped, so the parts always add up to the whole.
 */
export function analysePayload(payload: any): Breakdown {
  const tokens: Record<Category, number> = { system: 0, tools: 0, user: 0, assistant: 0, thinking: 0, toolResults: 0, images: 0, other: 0 };
  const largestTools: { name: string; tokens: number }[] = [];
  const messages: any[] = Array.isArray(payload?.messages) ? payload.messages : [];
  const tools: any[] = Array.isArray(payload?.tools) ? payload.tools : [];

  for (const tool of tools) {
    const name = tool?.function?.name ?? tool?.name ?? "unnamed";
    const size = estimateTokens(JSON.stringify(tool ?? {}));
    tokens.tools += size;
    largestTools.push({ name, tokens: size });
  }

  for (const message of messages) {
    const role = String(message?.role ?? "");
    const body = estimateTokens(text(message?.content));
    const calls = estimateTokens(JSON.stringify(message?.tool_calls ?? ""));
    const reasoning = estimateTokens(text(message?.reasoning_content ?? message?.thinking ?? ""));
    const imageParts = Array.isArray(message?.content) ? message.content.filter((p: any) => p?.type === "image_url" || p?.type === "image") : [];
    const images = imageParts.reduce((sum: number, part: any) => sum + estimateTokens(JSON.stringify(part)), 0);

    if (reasoning) tokens.thinking += reasoning;
    if (images) tokens.images += images;
    const rest = Math.max(0, body - images);
    if (role === "system" || role === "developer") tokens.system += rest;
    else if (role === "user") tokens.user += rest;
    else if (role === "assistant") { tokens.assistant += rest; tokens.tools += 0; tokens.other += calls; }
    else if (role === "tool") tokens.toolResults += rest;
    else tokens.other += rest + calls;
  }

  return {
    tokens, toolCount: tools.length, messageCount: messages.length,
    largestTools: largestTools.sort((a, b) => b.tokens - a.tokens).slice(0, 5),
  };
}

/** Scale the estimates so they sum to the provider's reported total, keeping the proportions. */
export function reconcile(breakdown: Breakdown, reportedTotal: number | null | undefined): Record<Category, number> {
  const estimated = Object.values(breakdown.tokens).reduce((a, b) => a + b, 0);
  if (!reportedTotal || !estimated) return { ...breakdown.tokens };
  const factor = reportedTotal / estimated;
  const out = { ...breakdown.tokens };
  for (const key of Object.keys(out) as Category[]) out[key] = Math.round(out[key] * factor);
  return out;
}

export type ContextView = {
  tokens: Record<Category, number>;
  total: number;
  window: number;
  free: number;
  percent: number;
  compactAt?: number;          // token count at which compaction triggers
  reclaimable?: number;        // what a compaction now would free
  toolCount: number;
  messageCount: number;
  largestTools: { name: string; tokens: number }[];
  model?: string;
  estimated: boolean;          // true when no provider total was available
};

export function buildView(opts: { breakdown: Breakdown; reportedTotal?: number | null; window: number; model?: string; compactPercent?: number }): ContextView {
  const tokens = reconcile(opts.breakdown, opts.reportedTotal);
  const total = opts.reportedTotal ?? Object.values(tokens).reduce((a, b) => a + b, 0);
  const window = Math.max(1, opts.window);
  return {
    tokens, total, window, free: Math.max(0, window - total), percent: total / window,
    compactAt: opts.compactPercent ? Math.round(window * opts.compactPercent) : undefined,
    reclaimable: tokens.toolResults + tokens.thinking,
    toolCount: opts.breakdown.toolCount, messageCount: opts.breakdown.messageCount,
    largestTools: opts.breakdown.largestTools, model: opts.model,
    estimated: opts.reportedTotal == null,
  };
}

// ---------- terminal rendering ----------
const BLOCKS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
/** One proportional bar, each category a run of blocks, free space dotted. */
export function bar(view: ContextView, width: number, glyphs: Record<Category, string> = {} as any): { segments: { category: Category | "free"; cells: number }[] } {
  const usable = Math.max(10, width);
  const segments: { category: Category | "free"; cells: number }[] = [];
  let used = 0;
  for (const category of CATEGORY_ORDER) {
    const share = view.tokens[category] / view.window;
    const cells = Math.round(share * usable);
    if (cells > 0) { segments.push({ category, cells }); used += cells; }
  }
  segments.push({ category: "free", cells: Math.max(0, usable - used) });
  void glyphs; void BLOCKS;
  return { segments };
}

export const pct = (value: number) => `${(value * 100).toFixed(value * 100 < 10 ? 1 : 0)}%`;
export const thousands = (value: number) => value.toLocaleString("en-US");

/** The one-line judgement: what the numbers mean for the next few turns. */
export function verdict(view: ContextView): string {
  if (view.percent >= 0.85) return `Full: compaction is due, and ${thousands(view.reclaimable ?? 0)} tokens of tool output and thinking are the first to go.`;
  if (view.percent >= 0.6) return `Filling up: compaction triggers around ${thousands(view.compactAt ?? 0)} tokens, ${thousands(Math.max(0, (view.compactAt ?? 0) - view.total))} away.`;
  const fixed = view.tokens.system + view.tokens.tools;
  if (fixed / view.window > 0.25) return `Comfortable, but ${pct(fixed / view.window)} of the window is spent before you type: system prompt and ${view.toolCount} tool schemas.`;
  return `Comfortable: ${pct(view.percent)} used, ${thousands(view.free)} tokens free.`;
}

/** Mermaid source for the same breakdown, for pasting into a document. */
export function mermaidPie(view: ContextView, title = "Context window"): string {
  const rows = CATEGORY_ORDER.filter((c) => view.tokens[c] > 0).map((c) => `    "${CATEGORY_LABELS[c]}" : ${view.tokens[c]}`);
  rows.push(`    "free" : ${view.free}`);
  return [`pie showData`, `    title ${title} (${thousands(view.window)} tokens)`, ...rows].join("\n");
}
