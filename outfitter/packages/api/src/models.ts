// E3.7 (EPIC.md "Gurus page"): GET /api/models feeds the Gurus page's model/fallback-model pickers
// with the LiteLLM router's chat models -- the browser never talks to LiteLLM directly (it has no
// key), so this is the API's own thin service in front of it.
//
// Reuses providers-status.ts's fetchJson/parseModelInfo (EPIC.md: "reuse the fetch/parse code in
// providers-status.ts; do not copy") rather than a second implementation of the same LiteLLM
// `/model/info` call the E2.10 provider status service already makes.

import { fetchJson, parseModelInfo, DEFAULT_TIMEOUT_MS, type ModelMeta } from "./providers-status.ts";
import { parseRouterModelName } from "./local-hosts/naming.ts";

export interface ModelRow {
  /** "litellm/<model_name>" for anything from the router; a bare LOCAL_MODELS id (already in that
   * `litellm/...` form in practice, but not assumed here) for a laptop-only model with no LiteLLM
   * `/model/info` entry of its own. */
  id: string;
  contextWindow?: number;
  maxOutput?: number;
  inputPerM?: number;
  outputPerM?: number;
  /** True for an auto-router model group (its price is $0 because the underlying model is picked
   * per call -- see E2.11b) -- the Gurus page shows these distinctly since a fixed context-window
   * or price display would be misleading for one. */
  auto: boolean;
  /** True for config.localModels (the `local-qwen-mlx` alias) or a `local/<user>-<host>/<id>`
   * router name: only reachable when the laptop preflight (E2.8) is online. */
  local?: boolean;
}

// EPIC.md E2.11b: the auto-router groups already known to this codebase (outfitter-spend.ts,
// connect/lib.ts's DEFAULT_PAID fix). Matched only when /model/info also prices the group at $0 --
// a model that happens to share this naming but has a real price is not an auto-router group.
const AUTO_ROUTER_PATTERNS = [/^claude-auto-/i, /^gemini-auto-/i, /-agentic$/i, /-affinity$/i];

export function isAutoRouterGroupName(name: string): boolean {
  return AUTO_ROUTER_PATTERNS.some((re) => re.test(name));
}

/** Pure mapping from parseModelInfo's `meta` map to the wire rows GET /api/models returns; kept
 * separate from the network call so it's directly unit-testable. `mode !== "chat"` groups are
 * already filtered out by parseModelInfo itself. */
export function rowsFromModelInfoMeta(meta: Map<string, ModelMeta>): ModelRow[] {
  const rows: ModelRow[] = [];
  for (const [name, m] of meta) {
    const zeroPriced = m.cost.input === 0 && m.cost.output === 0;
    rows.push({
      id: `litellm/${name}`,
      contextWindow: m.contextWindow,
      maxOutput: m.maxTokens,
      inputPerM: m.cost.input || undefined,
      outputPerM: m.cost.output || undefined,
      auto: zeroPriced && isAutoRouterGroupName(name),
    });
  }
  return rows;
}

/** Merges config.localModels into the LiteLLM rows: marks a matching row `local: true`, or adds a
 * bare row (no price/context-window info -- LOCAL_MODELS ids don't come from LiteLLM's own
 * /model/info) for one that isn't already there. Pure, exported for tests. */
export function mergeLocalModels(rows: ModelRow[], localModels: string[]): ModelRow[] {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  for (const id of localModels) {
    const existing = byId.get(id);
    if (existing) existing.local = true;
    else byId.set(id, { id, auto: false, local: true });
  }
  for (const row of byId.values()) if (parseRouterModelName(row.id)) row.local = true;
  return [...byId.values()];
}

export interface ModelsServiceDeps {
  litellmBaseUrl: string;
  /** Resolves the LiteLLM key to call /model/info with -- same resolver server.ts already builds
   * for the E2.10 provider status service (config.litellmAdminKey, falling back to
   * SecretsBroker.defaultLitellmKey()), passed in rather than re-resolved here so both services
   * agree on which key probes the router. */
  litellmKey: () => Promise<string>;
  localModels: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** How long a successful fetch is served from cache before the next GET /api/models re-fetches.
   * Default 5 minutes (EPIC.md E3.7). */
  cacheMs?: number;
}

const DEFAULT_CACHE_MS = 5 * 60_000;
/** A fetch that got no router models (no key, down, refused) is retried sooner (#458). */
const FAILED_CACHE_MS = 30_000;

/** GET /api/models' backing service: fetches LiteLLM's chat models once, caches the result in
 * memory for cacheMs, and merges in config.localModels. Single-flight like
 * ProviderStatusService.pollOnce so concurrent readers share one outbound call. A LiteLLM fetch
 * failure (no key configured, network error, non-2xx) resolves to an empty LiteLLM list rather
 * than throwing -- GET /api/models still returns local models (if any) and the guru form still
 * accepts free text either way. */
export class ModelsService {
  private readonly deps: ModelsServiceDeps;
  private cache: { at: number; rows: ModelRow[]; routerOk: boolean } | undefined;
  private inFlight: Promise<ModelRow[]> | undefined;

  constructor(deps: ModelsServiceDeps) {
    this.deps = deps;
  }

  async list(): Promise<ModelRow[]> {
    const full = this.deps.cacheMs ?? DEFAULT_CACHE_MS;
    const cacheMs = this.cache?.routerOk ? full : Math.min(full, FAILED_CACHE_MS);
    if (this.cache && Date.now() - this.cache.at < cacheMs) return this.cache.rows;
    this.inFlight ??= this.fetchAndMerge().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchAndMerge(): Promise<ModelRow[]> {
    const litellmRows = await this.fetchLitellmRows();
    const rows = mergeLocalModels(litellmRows, this.deps.localModels);
    this.cache = { at: Date.now(), rows, routerOk: litellmRows.length > 0 };
    return rows;
  }

  /** Whether the last fetch got any models from the router itself (not just config.localModels). */
  routerAnswered(): boolean {
    return this.cache?.routerOk ?? false;
  }

  private async fetchLitellmRows(): Promise<ModelRow[]> {
    let key: string;
    try {
      key = await this.deps.litellmKey();
    } catch {
      key = "";
    }
    if (!key) return [];

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const root = this.deps.litellmBaseUrl.replace(/\/v1\/?$/, "");
    try {
      const res = await fetchJson(`${root}/model/info`, { Authorization: `Bearer ${key}` }, timeoutMs, fetchImpl);
      if (!res.ok) return [];
      const { meta } = parseModelInfo(res.json);
      return rowsFromModelInfoMeta(meta);
    } catch {
      return [];
    }
  }
}
