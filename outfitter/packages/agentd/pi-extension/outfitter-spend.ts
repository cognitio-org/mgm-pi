/**
 * E2.11 / E2.11b: a pi extension loaded only under agentd (renderGuru adds `-e <this file>` when
 * RunControllerDeps.spendExtensionPath is set -- see ../src/guru.ts and ../src/run.ts), so a run's
 * cost is real even though agentd itself never sees the LiteLLM response headers pi's own HTTP
 * client received. mgm's own `connect` extension (mgm/.pi/extensions/connect) already does this same
 * parsing for the *interactive* TUI's `/budget` panel; this is a separate, minimal instance of the
 * same idea for the cloud run path, self-contained (no import from mgm/) so this package doesn't
 * depend on mgm's own layout inside the sandbox image.
 *
 * On every `after_provider_response` event whose headers are LiteLLM's (`x-litellm-call-id`
 * present), appends one JSON line to `OUTFITTER_SPEND_FILE`:
 *   { keySpend?, keyMax?, modelGroup?, callId?, usage? }
 * `usage` is normally the delta in pi's own cumulative LiteLLM cost estimate (session-total
 * `message.usage.cost.total` since the previous line) -- this response's own contribution.
 *
 * E2.11b: that per-message cost estimate is $0 for the auto-router model groups
 * (`claude-auto-llm`, `gemini-auto-llm`, `*-agentic`, `*-affinity`), because LiteLLM's
 * `GET /model/info` prices every concrete deployment but returns zero prices for a routing group --
 * its underlying model is only picked per call, so there's no single deployment to price. LiteLLM
 * does send `x-litellm-model-name: <resolved concrete model>` on every response (streamed too) and
 * `x-litellm-classifier-cost: <usd>` for the router's own classification call. So: at `session_start`
 * this extension fetches `/model/info` once (best-effort, never throws) and builds a per-token price
 * map; on each response, if the *requested* model group's price is all-zero/unknown but the
 * *resolved* model's price is known, `usage` is computed instead from the newest assistant message's
 * token counts (input/output/cacheRead/cacheWrite) times the resolved model's prices, plus the
 * classifier cost header -- see `buildSpendLogLine`. A network failure degrades to the prior
 * delta-based behaviour and is logged once to stderr, never thrown.
 *
 * E2.11b also fixes the first-call baseline bug: LiteLLM's `x-litellm-key-spend` header carries the
 * key's balance *before* the current call is billed, so pinning `keySpendStart` from the first
 * `after_provider_response` spend frame under-reports every run's first call. At `session_start`,
 * before any provider call, this extension also probes `GET /key/info` (a key may read its own info)
 * and appends a baseline line `{ baseline: true, keySpend: <spend> }` -- agentd's SpendTailer forwards
 * it as a `spend` frame with no `usage`, and the API's spend handler (already pinning `keySpendStart`
 * from the first frame it sees) then pins from the true pre-call balance. If `/key/info` fails, this
 * step is simply skipped (best-effort, never fatal) and the prior first-frame-pins-baseline behaviour
 * applies.
 */
import { appendFileSync } from "node:fs";

// ---------- pure, unit-tested logic ----------

export interface SpendHeaders {
  litellm: boolean;
  keySpend?: number;
  keyMax?: number;
  modelGroup?: string;
  callId?: string;
  /** E2.11b: x-litellm-model-name -- the concrete model LiteLLM actually resolved this call to,
   * present even for an auto-router group whose own /model/info price is 0. */
  resolvedModel?: string;
  /** E2.11b: x-litellm-classifier-cost -- the router's own classification-call cost in USD, only
   * present on a routed (auto-*) call. */
  classifierCost?: number;
}

/** Same contract as mgm/.pi/extensions/connect/lib.ts's parseSpendHeaders: only trust
 * x-litellm-key-spend/-max-budget (per-call cost reads 0 on a streamed response); `litellm` is true
 * only when x-litellm-call-id is present at all, i.e. this response actually went through the
 * LiteLLM router. */
export function parseSpendHeaders(headers: Record<string, string> | undefined): SpendHeaders {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) h[k.toLowerCase()] = v;
  if (!("x-litellm-call-id" in h)) return { litellm: false };
  const num = (key: string) => {
    const n = Number(h[key]);
    return Number.isFinite(n) && h[key] !== undefined && h[key] !== "" ? n : undefined;
  };
  return {
    litellm: true,
    keySpend: num("x-litellm-key-spend"),
    keyMax: num("x-litellm-key-max-budget"),
    modelGroup: h["x-litellm-model-group"],
    callId: h["x-litellm-call-id"],
    resolvedModel: h["x-litellm-model-name"],
    classifierCost: num("x-litellm-classifier-cost"),
  };
}

/** Sums pi's own cost accounting (message.usage.cost.total) across every LiteLLM-served assistant
 * turn recorded so far -- the same field mgm's connect extension's sessionEstimate reads. */
export function sessionCostTotal(entries: readonly unknown[], provider = "litellm"): number {
  let total = 0;
  for (const e of entries as any[]) {
    if (e?.type === "message" && e.message?.role === "assistant" && e.message.provider === provider) {
      total += e.message.usage?.cost?.total ?? 0;
    }
  }
  return total;
}

/** Token counts pi records on an assistant message's `usage` (mgm/.pi/extensions/compaction's
 * `addUsage`/fake-pi.ts's test fixtures use the same shape). */
export interface UsageTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** The newest LiteLLM-served assistant message's raw usage (token counts), or undefined if there
 * isn't one -- used to compute this response's cost directly from the resolved model's prices when
 * the requested group's own price is unknown/zero (see buildSpendLogLine). */
export function newestAssistantUsage(entries: readonly unknown[], provider = "litellm"): UsageTokens | undefined {
  const list = entries as any[];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e?.type === "message" && e.message?.role === "assistant" && e.message.provider === provider) {
      return e.message.usage as UsageTokens | undefined;
    }
  }
  return undefined;
}

/** Per-token (not per-million) prices for one LiteLLM-priced model or model group. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Parses LiteLLM's GET /model/info response into a per-token price map keyed by model_name (which
 * is either a concrete model id or, for an auto-router group, the group's own id -- both show up as
 * `model_name` entries; a routing group's entry just has every price at 0). Several deployments can
 * share a model_name; the first one wins, same as mgm's parseModelInfo. */
export function parseModelInfoPrices(json: any): Map<string, ModelPrice> {
  const map = new Map<string, ModelPrice>();
  for (const m of json?.data ?? []) {
    const name = m?.model_name;
    if (typeof name !== "string" || !name || map.has(name)) continue;
    const i = m.model_info ?? {};
    map.set(name, {
      input: Number(i.input_cost_per_token) || 0,
      output: Number(i.output_cost_per_token) || 0,
      cacheRead: Number(i.cache_read_input_token_cost) || 0,
      cacheWrite: Number(i.cache_creation_input_token_cost) || 0,
    });
  }
  return map;
}

/** True when a price is absent or every field is 0 -- LiteLLM's shape for an unpriced auto-router
 * group's /model/info entry. */
export function isZeroPrice(p: ModelPrice | undefined): boolean {
  return !p || (p.input === 0 && p.output === 0 && p.cacheRead === 0 && p.cacheWrite === 0);
}

/** This call's cost from raw token counts x per-token prices, plus the router's own classification
 * cost (only present on a routed call). Returns undefined when there's nothing to compute from. */
export function computeResolvedCost(usage: UsageTokens | undefined, price: ModelPrice | undefined, classifierCost: number | undefined): number | undefined {
  if (!usage || !price) return undefined;
  const tokenCost =
    (usage.input ?? 0) * price.input +
    (usage.output ?? 0) * price.output +
    (usage.cacheRead ?? 0) * price.cacheRead +
    (usage.cacheWrite ?? 0) * price.cacheWrite;
  return Math.max(0, tokenCost + (classifierCost ?? 0));
}

export interface SpendLogLine {
  keySpend?: number;
  keyMax?: number;
  modelGroup?: string;
  callId?: string;
  usage?: number;
}

/**
 * Builds the JSON line to append. Normally `usage` is the increase in `sessionCostTotal` since
 * `previousTotal` (this call's own contribution), never negative. E2.11b: when the requested model
 * group's price (`headers.modelGroup` looked up in `prices`) is all-zero or unknown, but the
 * *resolved* model's price (`headers.resolvedModel`) is known, `usage` is computed instead from
 * `usage` (this response's raw token counts) x the resolved model's prices, plus the classifier cost
 * header -- the delta-based estimate would otherwise be exactly 0 for every auto-routed call, since
 * pi itself priced the group (not the resolved model) at $0/token. `prices` defaults to an empty map
 * (e.g. the session_start /model/info fetch failed or hasn't completed yet), which makes the
 * override condition false and this degrades to the prior delta-based behaviour automatically.
 */
export function buildSpendLogLine(
  headers: SpendHeaders,
  currentTotal: number,
  previousTotal: number,
  prices: ReadonlyMap<string, ModelPrice> = new Map(),
  usage?: UsageTokens,
): SpendLogLine {
  const delta = Math.max(0, currentTotal - previousTotal);
  const groupPrice = headers.modelGroup ? prices.get(headers.modelGroup) : undefined;
  const resolvedPrice = headers.resolvedModel ? prices.get(headers.resolvedModel) : undefined;
  let usageValue = delta;
  if (isZeroPrice(groupPrice) && resolvedPrice && !isZeroPrice(resolvedPrice)) {
    const resolvedCost = computeResolvedCost(usage, resolvedPrice, headers.classifierCost);
    if (resolvedCost !== undefined) usageValue = resolvedCost;
  }
  return {
    keySpend: headers.keySpend,
    keyMax: headers.keyMax,
    modelGroup: headers.modelGroup,
    callId: headers.callId,
    usage: usageValue,
  };
}

// ---------- extension wiring ----------

/** Loosely typed on purpose: this file ships in packages/agentd (which does not depend on
 * @earendil-works/pi-coding-agent -- it only runs inside the sandbox image, where pi loads it
 * directly via `-e`, same as mgm's own extensions). See ../src/guru.ts's RenderOptions doc. */
type PiExtensionApi = {
  on(event: "after_provider_response", handler: (ev: { headers?: Record<string, string> }, ctx: any) => void | Promise<void>): void;
  on(event: "session_start", handler: (ev: unknown, ctx: any) => void | Promise<void>): void;
};

/** Root LiteLLM URL (management endpoints live at the root, not under /v1) and the agent's key, same
 * env vars and default as mgm/.pi/extensions/connect/lib.ts's `backends()`/`rootUrl`. */
function litellmRootUrl(): string {
  const base = (process.env.LITELLM_BASE_URL || "https://litellm.augment-code.support/v1").trim();
  return base.replace(/\/v1\/?$/, "");
}
function litellmKey(): string {
  return (process.env.LITELLM_AGENT_KEY || process.env.LITELLM_API_KEY || "").trim();
}

let networkWarned = false;
function warnOnce(context: string, err: unknown): void {
  if (networkWarned) return;
  networkWarned = true;
  process.stderr.write(`outfitter-spend: ${context}: ${(err as any)?.message ?? err}\n`);
}

/** Best-effort JSON GET against a LiteLLM management endpoint; never throws. Returns undefined on
 * any failure (no key configured, network error, non-2xx, non-JSON body) so callers degrade to the
 * existing behaviour instead of losing spend accounting entirely. */
async function litellmGet(path: string, timeoutMs = 4000): Promise<any | undefined> {
  const key = litellmKey();
  if (!key) return undefined;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${litellmRootUrl()}${path}`, { headers: { authorization: `Bearer ${key}` }, signal: ctl.signal });
      if (!res.ok) return undefined;
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    warnOnce(`request to ${path} failed`, err);
    return undefined;
  }
}

async function fetchModelPrices(): Promise<Map<string, ModelPrice>> {
  const json = await litellmGet("/model/info");
  return json ? parseModelInfoPrices(json) : new Map();
}

/** GET /key/info's `info.spend` is the key's cumulative balance *before* whatever call happens
 * next -- exactly the baseline the first-call-under-reports-cost bug (E2.11b) needs. */
async function fetchKeySpend(): Promise<number | undefined> {
  const json = await litellmGet("/key/info");
  const spend = json?.info?.spend;
  return typeof spend === "number" ? spend : undefined;
}

export default function outfitterSpend(pi: PiExtensionApi): void {
  const spendFile = process.env.OUTFITTER_SPEND_FILE;
  if (!spendFile) return; // not running under agentd (or agentd didn't wire it up); nothing to do

  let writeWarned = false;
  const append = (line: object) => {
    try {
      appendFileSync(spendFile, `${JSON.stringify(line)}\n`);
    } catch (err: any) {
      // Best-effort: a write failure must not break the agent turn, but it must be visible: the
      // first cloud sessions lost every spend line to a permission error that this swallowed.
      if (!writeWarned) {
        writeWarned = true;
        process.stderr.write(`outfitter-spend: cannot append to ${spendFile}: ${err?.message ?? err}\n`);
      }
    }
  };

  // A resumed session already has assistant turns (with their own cost) in its history. Starting
  // previousTotal at 0 would make the very first after_provider_response's delta equal to the whole
  // session's historical cost, not just this response's. `session_start` fires once, before any new
  // provider call, so its entries are exactly the prior history to baseline against; the
  // after_provider_response handler below also lazily initialises from its own ctx (before computing
  // the delta) as a fallback in case session_start doesn't fire first for some reason.
  let previousTotal: number | undefined;
  // E2.11b: the per-token price map from /model/info, fetched once at session_start. Empty (never
  // undefined) until that fetch resolves or fails -- buildSpendLogLine treats an empty map exactly
  // like "unpriced", so every response before the fetch completes just uses the prior delta-based
  // estimate.
  let prices: Map<string, ModelPrice> = new Map();

  pi.on("session_start", (_ev, ctx) => {
    if (previousTotal === undefined) previousTotal = sessionCostTotal(ctx?.sessionManager?.getEntries?.() ?? []);
    // Both probes are best-effort and never throw (litellmGet swallows every failure); fire them
    // before any provider call so the key-spend baseline lands ahead of the first real spend line.
    void Promise.all([fetchModelPrices(), fetchKeySpend()]).then(([p, keySpend]) => {
      prices = p;
      if (keySpend !== undefined) append({ baseline: true, keySpend });
    });
  });

  pi.on("after_provider_response", (ev, ctx) => {
    const headers = parseSpendHeaders(ev.headers);
    if (!headers.litellm) return;
    const entries = ctx?.sessionManager?.getEntries?.() ?? [];
    if (previousTotal === undefined) previousTotal = sessionCostTotal(entries);
    const currentTotal = sessionCostTotal(entries);
    const usage = newestAssistantUsage(entries);
    const line = buildSpendLogLine(headers, currentTotal, previousTotal, prices, usage);
    previousTotal = currentTotal;
    append(line);
  });
}
