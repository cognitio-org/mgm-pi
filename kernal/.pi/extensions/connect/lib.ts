/**
 * Pure, dependency-free logic for the connect extension: env parsing, backend definitions,
 * LiteLLM /model/info parsing, spend-header parsing, and budget panel rendering.
 * Everything here is unit-tested in ../../../tests without pi or network.
 */

// ---------- env ----------
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Keys as users actually paste them: surrounded by quotes, prefixed with "Bearer " / "Token "
 * (copied from a curl example), or with stray whitespace. OpenRouter answers all of those with
 * a bare `401 Missing Authentication header`, so normalise before the key ever reaches a header.
 */
export function cleanKey(raw: string | undefined): string {
  let k = (raw ?? "").trim();
  k = k.replace(/^["'`]+|["'`]+$/g, "").trim();
  k = k.replace(/^(bearer|token)\s+/i, "").trim();
  k = k.replace(/^["'`]+|["'`]+$/g, "").trim();
  return k;
}

/** Cheap authenticated endpoint per backend: a 401/403 there means the key itself is wrong. */
export function keyCheckUrl(b: { id: BackendId; baseUrl: string }): string | undefined {
  if (b.id === "openrouter") return `${b.baseUrl}/auth/key`;
  if (b.id === "litellm") return `${b.baseUrl}/models`;
  return undefined;
}

/** Human-readable reason from a provider's 401/403 body (OpenRouter, LiteLLM and Deepgram shapes). */
export function authFailureText(status: number, body: string): string {
  try {
    const j = JSON.parse(body);
    const msg = j?.error?.message ?? j?.message ?? j?.err_msg ?? j?.detail?.error ?? j?.detail;
    if (typeof msg === "string" && msg.trim()) return `${status}: ${msg.trim().slice(0, 160)}`;
  } catch {}
  const t = body.trim().slice(0, 160);
  return t ? `${status}: ${t}` : `HTTP ${status}`;
}

// ---------- LiteLLM /model/info ----------
export type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type ModelMeta = { cost: Cost; contextWindow?: number; maxTokens?: number; vision?: boolean; reasoning?: boolean };

/** Per-token prices become per-million; non-chat deployments (embeddings, rerank, ...) are dropped. */
export function parseModelInfo(json: any): { ids: string[]; meta: Map<string, ModelMeta> } {
  const perM = (v: unknown) => (typeof v === "number" ? v * 1e6 : 0);
  const meta = new Map<string, ModelMeta>();
  for (const m of json?.data ?? []) {
    const i = m.model_info ?? {};
    if (!m.model_name || (i.mode && i.mode !== "chat")) continue;
    if (meta.has(m.model_name)) continue;   // several deployments can share a model_name; keep the first
    meta.set(m.model_name, {
      cost: { input: perM(i.input_cost_per_token), output: perM(i.output_cost_per_token), cacheRead: perM(i.cache_read_input_token_cost), cacheWrite: perM(i.cache_creation_input_token_cost) },
      contextWindow: i.max_input_tokens ?? undefined, maxTokens: i.max_output_tokens ?? undefined,
      vision: i.supports_vision ?? undefined, reasoning: i.supports_reasoning ?? undefined,
    });
  }
  return { ids: [...meta.keys()].sort(), meta };
}

// ---------- LM Studio native /api/v0/models: the served context window ----------
export type LmStudioMeta = { contextWindow: number; loaded: boolean; vision?: boolean; toolUse?: boolean };

/** `loaded_context_length` is what the server will actually accept; `max_context_length` is the model's ceiling. */
export function parseLmStudioModels(json: any): Map<string, LmStudioMeta> {
  const out = new Map<string, LmStudioMeta>();
  for (const m of json?.data ?? []) {
    if (!m?.id || (m.type && !["llm", "vlm"].includes(m.type))) continue;
    const loaded = m.state === "loaded";
    const ctx = (loaded && m.loaded_context_length) || m.max_context_length;
    if (typeof ctx !== "number" || ctx <= 0) continue;
    out.set(m.id, { contextWindow: ctx, loaded, vision: m.type === "vlm", toolUse: Array.isArray(m.capabilities) ? m.capabilities.includes("tool_use") : undefined });
  }
  return out;
}

// ---------- backend definitions ----------
export type BackendId = "lmstudio" | "litellm" | "openrouter";
export type ModelConfig = {
  id: string; name: string; input: ("text" | "image")[]; cost: Cost; contextWindow: number; maxTokens: number;
  reasoning: boolean; thinkingLevelMap?: Record<string, string | null>; compat?: Record<string, unknown>;
};
export type Backend = {
  id: BackendId;
  label: string;
  baseUrl: string;
  apiKey: string;
  keyVar: string;                    // env var the user must set when apiKey is empty
  discover: boolean;                 // fetch model ids from GET {baseUrl}/models
  filter?: (id: string) => boolean;  // drop non-chat models from discovery
  fallback: string[];                // used when discovery fails or is off
  model: (id: string) => ModelConfig;
};

export const FREE: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const DEFAULT_PAID: Cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/** True when every price field is 0 -- LiteLLM's /model/info shape for an auto-router group
 * (claude-auto-llm, gemini-auto-llm, *-agentic, *-affinity): its underlying model is only picked
 * per call, so there's no single deployment to price and every field reads 0. */
export function isZeroCost(cost: Cost | undefined): boolean {
  return !cost || (cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0);
}

/** Qwen 3.6 reasoning knobs: pi's `off` must reach the server as reasoning_effort "none". */
export const QWEN_THINKING_MAP = { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };
const GENERIC_THINKING_MAP = { minimal: "low", xhigh: "high", max: "high" };
/** Proxies forward OpenAI-only `store` and the developer role to backends that reject them. */
const PROXY_COMPAT = { supportsDeveloperRole: false, supportsReasoningEffort: true, thinkingFormat: "openai", supportsUsageInStreaming: true, supportsStore: false };

export const DEFAULT_OPENROUTER_MODELS = [
  "anthropic/claude-sonnet-5", "anthropic/claude-opus-5", "openai/gpt-5.5", "google/gemini-3.8-flash",
  "qwen/qwen3.6-35b-a3b", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash", "moonshotai/kimi-k3",
  "z-ai/glm-5.1",
];

/**
 * The curated OpenRouter ids that OpenRouter still lists, and the ones it doesn't. A retired or
 * mistyped id would otherwise show up in /model and only fail on the first prompt ("... is not a
 * valid model ID"). Keeps everything when the catalogue could not be read.
 */
export function keepListed(curated: string[], catalogue: any): { kept: string[]; dropped: string[] } {
  const live = new Set(((catalogue?.data ?? []) as any[]).map((m) => String(m?.id)));
  if (!live.size) return { kept: curated, dropped: [] };
  // Routing variants (":nitro", ":floor", ":online", ...) work on any model but aren't listed.
  const listed = (id: string) => live.has(id) || live.has(id.replace(/:[^/:]+$/, ""));
  return { kept: curated.filter(listed), dropped: curated.filter((id) => !listed(id)) };
}

/** #440: the curated OpenRouter list's central settings, one add and one remove key per level. */
export const CURATION_KEYS = {
  fleetAdd: "openrouter.models.fleetAdd", fleetRemove: "openrouter.models.fleetRemove",
  add: "openrouter.models.add", remove: "openrouter.models.remove",
  localAdd: "openrouter.models.localAdd", localRemove: "openrouter.models.localRemove",
} as const;
export type CurationLists = Record<keyof typeof CURATION_KEYS, string[]>;
export const NO_CURATION: CurationLists = { fleetAdd: [], fleetRemove: [], add: [], remove: [], localAdd: [], localRemove: [] };

/** "a/b, c/d,,a/b" → ["a/b", "c/d"]: trimmed, empties and repeats dropped. */
export function parseIdList(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];
}

/**
 * The OpenRouter models to offer: the base list (Kernal's defaults), plus every level's adds, minus
 * every level's removes. A fleet removal always wins, so "hidden from everyone" holds. When
 * OPENROUTER_MODELS replaced the base (`replaced`), only the fleet's removals still apply.
 */
export function curateOpenRouter(base: string[], lists: CurationLists, replaced = false): string[] {
  const out = new Set(base);
  if (!replaced) {
    for (const id of [...lists.fleetAdd, ...lists.add, ...lists.localAdd]) out.add(id);
    for (const id of [...lists.remove, ...lists.localRemove]) out.delete(id);
  }
  for (const id of lists.fleetRemove) out.delete(id);
  return [...out];
}

export function backends(env: Record<string, string>, litellmMeta: Map<string, ModelMeta>, lmstudioMeta: Map<string, LmStudioMeta> = new Map()): Backend[] {
  // LMSTUDIO_CONTEXT caps the window pi budgets against; the served window comes from /api/v0/models
  const lmCap = Number(env.LMSTUDIO_CONTEXT) || Infinity;
  return [
    {
      id: "lmstudio",
      label: "LM Studio  (local MLX, port 1234)",
      baseUrl: normalizeBaseUrl(env.LMSTUDIO_BASE_URL, "http://localhost:1234/v1"),
      apiKey: "lm-studio",
      keyVar: "LMSTUDIO_BASE_URL",
      discover: true,
      filter: (id) => !/embed/i.test(id),
      fallback: [env.LMSTUDIO_MODEL || "qwen/qwen3.6-35b-a3b"],
      model: (id) => {
        const m = lmstudioMeta.get(id);
        return { id, name: id, input: m?.vision === false ? ["text"] : ["text", "image"], cost: FREE, contextWindow: Math.min(m?.contextWindow ?? 32768, lmCap), maxTokens: 8192, reasoning: true, thinkingLevelMap: QWEN_THINKING_MAP, compat: PROXY_COMPAT };
      },
    },
    {
      id: "litellm",
      label: "LiteLLM router  (router.kernal.one)",
      baseUrl: normalizeBaseUrl(env.LITELLM_BASE_URL, "https://router.kernal.one/v1"),
      apiKey: cleanKey(env.LITELLM_AGENT_KEY || env.LITELLM_API_KEY),  // agent-specific key first
      keyVar: "LITELLM_AGENT_KEY",
      discover: true,
      fallback: ["local-qwen-mlx", "gpt-5.4-nano", "claude-auto-llm", "claude-auto-agentic", "gemini-auto-llm", "claude-sonnet-5", "claude-opus-5-high"],
      model: (id) => {
        const local = id.startsWith("local-");
        const claude = /claude/.test(id);
        const meta = litellmMeta.get(id);
        // An auto-router group's own /model/info entry prices every field at 0 (its underlying
        // model is only picked per call -- see isZeroCost); showing that as $0/token in /budget
        // would tell the user an auto-routed model is free, which it isn't. Treat it as
        // unknown-paid (DEFAULT_PAID) instead. A real per-response price from LiteLLM's
        // x-litellm-model-name header would need per-call state this static model-registry cost
        // field doesn't have room for, so this is the DEFAULT_PAID fallback the interactive
        // /budget panel already uses for any other unpriced model.
        const cost = local ? FREE : isZeroCost(meta?.cost) && id.includes("auto") ? DEFAULT_PAID : meta?.cost ?? DEFAULT_PAID;
        return {
          id, name: id, input: meta?.vision === false ? ["text"] : ["text", "image"],
          cost,
          contextWindow: meta?.contextWindow ?? (local ? 32768 : claude ? 200000 : 1000000),
          maxTokens: Math.min(meta?.maxTokens ?? (local ? 8192 : 32000), 64000),
          reasoning: meta?.reasoning ?? true,
          thinkingLevelMap: local ? QWEN_THINKING_MAP : GENERIC_THINKING_MAP,
          compat: PROXY_COMPAT,
        };
      },
    },
    {
      id: "openrouter",
      label: "OpenRouter  (openrouter.ai)",
      baseUrl: normalizeBaseUrl(env.OPENROUTER_BASE_URL, "https://openrouter.ai/api/v1"),
      apiKey: cleanKey(env.OPENROUTER_API_KEY),
      keyVar: "OPENROUTER_API_KEY",
      discover: false,                 // curated: discovery only drops ids OpenRouter no longer lists
      fallback: (env.OPENROUTER_MODELS || DEFAULT_OPENROUTER_MODELS.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
      model: (id) => ({
        id, name: id, input: ["text", "image"], reasoning: true, cost: DEFAULT_PAID, contextWindow: 200000, maxTokens: 32000,
        thinkingLevelMap: GENERIC_THINKING_MAP,
        compat: { thinkingFormat: "openrouter", supportsUsageInStreaming: true, supportsStore: false },
      }),
    },
  ];
}

/**
 * Normalise an OpenAI-compatible base URL as users type it: add the scheme, drop a trailing slash,
 * and append /v1 when no version path is present ("localhost:1234" → "http://localhost:1234/v1").
 */
export function normalizeBaseUrl(input: string, fallback: string): string {
  let u = (input || "").trim();
  if (!u) return fallback;
  if (!/^https?:\/\//i.test(u)) u = (/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[::1\])/.test(u) ? "http://" : "https://") + u;
  u = u.replace(/\/+$/, "");
  if (!/\/v\d+$/i.test(u)) u += "/v1";
  return u;
}

/** Strip a trailing /v1 so management endpoints (/model/info, /key/info) can be appended. */
export const rootUrl = (baseUrl: string) => baseUrl.replace(/\/v1\/?$/, "");

// ---------- spend ----------
export type SpendHeaders = { litellm: boolean; keySpend?: number; keyMax?: number; modelGroup?: string };

/** Only x-litellm-key-spend / -max-budget are trustworthy on streamed responses; per-call cost reads 0. */
export function parseSpendHeaders(headers: Record<string, string> | undefined): SpendHeaders {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) h[k.toLowerCase()] = v;
  if (!("x-litellm-call-id" in h)) return { litellm: false };
  const num = (k: string) => { const n = Number(h[k]); return Number.isFinite(n) && h[k] !== undefined && h[k] !== "" ? n : undefined; };
  return { litellm: true, keySpend: num("x-litellm-key-spend"), keyMax: num("x-litellm-key-max-budget"), modelGroup: h["x-litellm-model-group"] };
}

/** Sum pi's own cost accounting for assistant turns served by the given provider. */
export function sessionEstimate(entries: any[], provider = "litellm"): number {
  let total = 0;
  for (const e of entries) {
    if (e?.type === "message" && e.message?.role === "assistant" && e.message.provider === provider) total += e.message.usage?.cost?.total ?? 0;
  }
  return total;
}

// ---------- formatting ----------
export const money = (v: number | undefined | null) => (v == null ? "—" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
export const pctText = (p: number) => (p * 100 < 1 && p > 0 ? (p * 100).toFixed(1) : Math.round(p * 100)) + "%";
export const price = (v: number) => "$" + (Math.round(v * 1000) / 1000).toString();
export const fit = (t: string, w = 18) => (t.length > w ? t.slice(0, w - 1) + "…" : t).padEnd(w) + "  ";

export type Seg = [string, string | null];   // [text, themeColor | plain]
export const plainLen = (segs: Seg[]) => segs.reduce((n, [t]) => n + t.length, 0);

/** Fill bar with a colour that turns amber at 50% and red at 80%; any non-zero usage shows at least one cell. */
export function bar(used: number, max: number, width = 14): { segs: Seg[]; pct: number; color: string } {
  const pct = max > 0 ? Math.min(1, used / max) : 0;
  const filled = pct > 0 ? Math.max(1, Math.round(pct * width)) : 0;
  const color = pct < 0.5 ? "success" : pct < 0.8 ? "warning" : "error";
  return { pct, color, segs: [["▰".repeat(filled), color], ["▱".repeat(width - filled), "dim"]] };
}

export type BudgetData = {
  estimate: number; actual?: number; calls: number;
  key?: { key_alias?: string; spend?: number; max_budget?: number | null };
  keySpend?: number; keyMax?: number | null;
  team?: { team_alias?: string; spend?: number; max_budget?: number | null; budget_duration?: string };
  model?: { provider: string; id: string }; meta?: ModelMeta;
};

export function budgetRows(d: BudgetData): Seg[][] {
  const rows: Seg[][] = [];
  rows.push([["session ", "muted"], [money(d.estimate), "accent"], [" est", "dim"], ["  ·  billed ", "muted"], [d.actual === undefined ? "—" : "+" + money(d.actual), d.actual ? "text" : "dim"], ["  ·  ", "dim"], [`${d.calls} call${d.calls === 1 ? "" : "s"}`, "muted"]]);
  const keySpent = d.key?.spend ?? d.keySpend, keyCap = d.key?.max_budget ?? d.keyMax;
  if (keySpent != null) {
    const label: Seg[] = [["key  ", "muted"], [fit(d.key?.key_alias ?? "agent"), "text"]];
    if (keyCap) { const b = bar(keySpent, keyCap); rows.push([...label, ...b.segs, ["  " + money(keySpent) + " / " + money(keyCap), "text"], [`  ${pctText(b.pct)}`, "dim"]]); }
    else rows.push([...label, [money(keySpent), "text"], ["  no cap", "dim"]]);
  }
  const t = d.team;
  if (t?.spend != null) {
    const label: Seg[] = [["team ", "muted"], [fit(String(t.team_alias ?? "team")), "text"]];
    if (t.max_budget) { const b = bar(t.spend, t.max_budget); rows.push([...label, ...b.segs, ["  " + money(t.spend) + " / " + money(t.max_budget), "text"], [t.budget_duration ? `  resets ${t.budget_duration}` : "", "dim"]]); }
    else rows.push([...label, [money(t.spend), "text"], ["  no cap", "dim"]]);
  }
  if (d.model) rows.push([["model ", "muted"], [`${d.model.provider}/${d.model.id}`, "accent"], d.meta ? ["   " + price(d.meta.cost.input) + "/M in · " + price(d.meta.cost.output) + "/M out · " + price(d.meta.cost.cacheRead) + "/M cached", "dim"] : ["   no router pricing", "dim"]]);
  if (!d.key && !d.team) rows.push([["key/team info unavailable: allow info_routes on this key (see README)", "dim"]]);
  return rows;
}

export type Painter = (color: string, text: string) => string;

/** Box the rows. `paint` applies theme colours (identity in tests); every line is plain-width ≤ width. */
export function renderPanel(rows: Seg[][], width: number, paint: Painter, title = " LiteLLM budget "): string[] {
  const inner = Math.max(24, Math.min(width - 2, 96));
  const cell = (segs: Seg[]) => segs.map(([t, c]) => (c ? paint(c, t) : t)).join("") + " ".repeat(Math.max(0, inner - 2 - plainLen(segs)));
  const top = paint("borderAccent", "╭─") + paint("accent", title) + paint("borderAccent", "─".repeat(Math.max(0, inner - 2 - title.length)) + "╮");
  const bottom = paint("borderAccent", "╰" + "─".repeat(inner - 1) + "╯");
  const side = paint("borderAccent", "│");
  return [top, ...rows.map((r) => side + " " + cell(r) + side), bottom];
}

export function footerStatus(estimate: number, keySpend: number | undefined, keyMax: number | null | undefined): string {
  const pct = keySpend != null && keyMax ? pctText(keySpend / keyMax) : undefined;
  const key = keySpend == null ? "" : ` · key ${money(keySpend)}${keyMax ? `/${money(keyMax)}` : ""}${pct !== undefined ? ` (${pct})` : ""}`;
  return `◆ ${money(estimate)}${key}`;
}

// ---------- asking another extension for something ----------
/**
 * pi gives every extension the same event bus (`pi.events`), and that is the only channel between
 * them: each extension's state lives in its own closure. These two helpers make a request/reply out
 * of it, so /admin can ask `connect` to re-register its providers, or `kernal-codebase-index` for the
 * index state, instead of keeping a second copy of either.
 */
export type Bus = { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void };
type Envelope = { request: any; claim: () => void; reply: (r: { ok: boolean; value?: unknown; error?: string }) => void };

export function busServe(bus: Bus | undefined, channel: string, handler: (request: any) => unknown): () => void {
  if (!bus?.on) return () => {};
  return bus.on(channel, async (data) => {
    const msg = data as Envelope;
    if (!msg || typeof msg.reply !== "function") return;
    msg.claim();   // synchronously, before any await, so the caller knows someone is answering
    try { msg.reply({ ok: true, value: await handler(msg.request) }); }
    catch (e: any) { msg.reply({ ok: false, error: String(e?.message ?? e) }); }
  });
}

/** Resolves with the answer, or undefined when nobody serves the channel. Rejects with the handler's error. */
export function busRequest<T = any>(bus: Bus | undefined, channel: string, request: unknown, timeoutMs = 60_000): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (!bus?.emit) return resolve(undefined);
    let claimed = false, done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error(`${channel} did not answer in ${Math.round(timeoutMs / 1000)}s`)); } }, timeoutMs);
    const envelope: Envelope = {
      request,
      claim: () => { claimed = true; },
      reply: (r) => { if (done) return; done = true; clearTimeout(timer); if (r.ok) resolve(r.value as T); else reject(new Error(r.error)); },
    };
    bus.emit(channel, envelope);
    if (!claimed && !done) { done = true; clearTimeout(timer); resolve(undefined); }
  });
}
