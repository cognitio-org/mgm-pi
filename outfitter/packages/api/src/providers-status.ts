// E2.10 provider status service (EPIC.md "Provider status service" / "E2.10"). One place that
// knows whether every model and tool provider is usable right now, feeding both the E2.8 laptop
// preflight (indirectly -- this service and the preflight share the same LaptopProbe instance, so
// probing it here never causes an extra network round trip beyond LaptopProbe's own 60s cache) and
// the E3.6 providers dashboard.
//
// Not `src/providers/`: that directory is the SandboxProvider abstraction (inprocess/docker/
// cloudrun launch a run's sandbox). This is a different "provider" -- a model/tool backend (ngrok,
// the laptop's LM Studio, LiteLLM, Cloud Run job capacity) -- hence the different file name.
//
// Every probe function below is written to never throw: a missing credential or an inapplicable
// probe (e.g. the cloudrun probe when SANDBOX_PROVIDER isn't cloudrun) resolves to a single
// "unknown" row with a `detail` saying why, and every network call is bounded by a 3s
// AbortController timeout. ProviderStatusService.pollOnce also wraps each probe in
// Promise.allSettled as a last-resort backstop, so a probe with a bug in it can never wedge the
// poller or take the whole service down.

import type { Store, ProviderRow, ProviderRecord, ProviderKind, ProviderHealth, ProviderTransition } from "./store/types.ts";
import type { SseHub } from "./sse.ts";
import type { LaptopProbe } from "./laptop.ts";
import type { SandboxProviderName } from "./config.ts";
import { isCloudProvider } from "./config.ts";
import type { SandboxCapacity } from "@outfitter/provider-local";

/** Exported so other services that need a bounded, non-throwing GET against a management API (e.g.
 * models.ts's LiteLLM /model/info fetch for GET /api/models) can reuse the same timeout/JSON
 * handling instead of re-implementing it. */
export const DEFAULT_TIMEOUT_MS = 3_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SSE_CHANNEL = "providers";

function nowIso(): string {
  return new Date().toISOString();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unknownRow(id: string, kind: ProviderRow["kind"], name: string, detail: string): ProviderRow {
  return { id, kind, name, status: "unknown", detail, checkedAt: nowIso() };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Exported for reuse by routes/operator.ts's secret test endpoint, per operators.md's "reuse
 * fetchJson-style code ... rather than copy" instruction. */
export interface JsonResponse {
  ok: boolean;
  status: number;
  json: unknown;
  /** Set only when the request never produced a response (network error or timeout). */
  error?: string;
}

/** A request that never got a response: say why, instead of reporting a meaningless HTTP 0. */
export function failedResponse(err: unknown, timeoutMs: number): JsonResponse {
  const aborted = err instanceof Error && err.name === "AbortError";
  return { ok: false, status: 0, json: undefined, error: aborted ? `timed out after ${timeoutMs} ms` : errMessage(err) };
}

/** GET with a bearer token, bounded by an AbortController timeout; never throws on a non-2xx or a
 * non-JSON body -- callers read `.ok`/`.status` instead. Only a network failure or the timeout
 * itself rejects, which every probe below catches. Exported for models.ts (GET /api/models) and operator.ts (secret tests) to
 * reuse rather than re-implement (EPIC.md E3.7: "reuse the fetch/parse code in providers-status.ts"). */
export async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined; // empty or non-JSON body (e.g. LiteLLM's /health/liveliness plaintext)
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- ngrok ----------

interface NgrokEndpoint {
  id?: string;
  public_url?: string;
  hostname?: string;
  proto?: string;
  region?: string;
}

/** ngrok's /endpoints (current API) and /tunnels (legacy) responses both key their array
 * differently; accept either shape. */
export function parseNgrokEndpoints(json: unknown): NgrokEndpoint[] {
  const body = json as { endpoints?: NgrokEndpoint[]; tunnels?: NgrokEndpoint[] } | undefined;
  return body?.endpoints ?? body?.tunnels ?? [];
}

function ngrokRowFromEndpoint(ep: NgrokEndpoint, checkedAt: string): ProviderRow {
  const id = `ngrok:${ep.id ?? ep.public_url ?? ep.hostname ?? "unknown"}`;
  return {
    id,
    kind: "ngrok",
    name: ep.hostname ?? ep.public_url ?? id,
    status: "up",
    checkedAt,
    meta: { publicUrl: ep.public_url, proto: ep.proto, region: ep.region },
  };
}

/** One row per online ngrok endpoint (EPIC.md E2.10: "reconcile with GET .../endpoints"). An empty
 * (but successful) response is reported as a single "down" row rather than an empty list, so the
 * dashboard always has something to show for the "ngrok" provider. */
export async function probeNgrok(
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderRow[]> {
  if (!apiKey) return [unknownRow("ngrok", "ngrok", "ngrok", "not configured")];
  try {
    const headers = { Authorization: `Bearer ${apiKey}`, "Ngrok-Version": "2" };
    const res = await fetchJson("https://api.ngrok.com/endpoints", headers, timeoutMs, fetchImpl);
    const checkedAt = nowIso();
    if (!res.ok) return [{ id: "ngrok", kind: "ngrok", name: "ngrok", status: "down", detail: `HTTP ${res.status}`, checkedAt }];
    const endpoints = parseNgrokEndpoints(res.json);
    if (endpoints.length === 0) {
      return [{ id: "ngrok", kind: "ngrok", name: "ngrok", status: "down", detail: "no endpoints online", checkedAt }];
    }
    return endpoints.map((ep) => ngrokRowFromEndpoint(ep, checkedAt));
  } catch (err) {
    return [{ id: "ngrok", kind: "ngrok", name: "ngrok", status: "down", detail: errMessage(err), checkedAt: nowIso() }];
  }
}

// ---------- laptop (LM Studio via the ngrok tunnel) ----------

export interface LmStudioModelMeta {
  id: string;
  contextWindow: number;
  loaded: boolean;
}

/** Small pure parser mirroring kernal/.pi/extensions/connect/lib.ts's parseLmStudioModels (copied,
 * not imported -- this package doesn't depend on kernal). `loaded_context_length` is what the server
 * will actually accept; `max_context_length` is the model's ceiling, used when nothing is loaded. */
export function parseLmStudioModels(json: unknown): LmStudioModelMeta[] {
  const data = (json as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
  const out: LmStudioModelMeta[] = [];
  for (const m of data) {
    const id = m.id;
    const type = m.type;
    if (typeof id !== "string" || (typeof type === "string" && !["llm", "vlm"].includes(type))) continue;
    const loaded = m.state === "loaded";
    const ctx = (loaded && (m.loaded_context_length as number)) || (m.max_context_length as number);
    if (typeof ctx !== "number" || ctx <= 0) continue;
    out.push({ id, contextWindow: ctx, loaded });
  }
  return out;
}

/** Reuses the shared LaptopProbe (the same instance the E2.8 preflight consults) for reachability,
 * so this probe never does an extra network round trip beyond LaptopProbe's own 60s cache -- it
 * only adds the `/api/v0/models` call for loaded-model detail, and only when already known online. */
export async function probeLaptop(
  laptopProbe: LaptopProbe,
  tunnelDomain: string,
  token: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderRow[]> {
  if (!tunnelDomain) return [unknownRow("laptop", "laptop", "Laptop (LM Studio)", "not configured")];
  try {
    const online = await laptopProbe.isOnline();
    const checkedAt = nowIso();
    if (!online) return [{ id: "laptop", kind: "laptop", name: "Laptop (LM Studio)", status: "down", checkedAt }];
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const res = await fetchJson(`https://${tunnelDomain}/api/v0/models`, headers, timeoutMs, fetchImpl);
      const models = res.ok ? parseLmStudioModels(res.json) : [];
      return [{ id: "laptop", kind: "laptop", name: "Laptop (LM Studio)", status: "up", checkedAt, meta: { models } }];
    } catch (err) {
      // Reachable per LaptopProbe but the extra model-list call failed; still "up", just no meta.
      const why = failedResponse(err, timeoutMs).error;
      return [{ id: "laptop", kind: "laptop", name: "Laptop (LM Studio)", status: "up", checkedAt, detail: `model list unavailable: ${why}` }];
    }
  } catch (err) {
    return [{ id: "laptop", kind: "laptop", name: "Laptop (LM Studio)", status: "unknown", detail: errMessage(err), checkedAt: nowIso() }];
  }
}

// ---------- LiteLLM ----------

export interface ModelMeta {
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  vision?: boolean;
  reasoning?: boolean;
}

/** Copied (not imported) from kernal/.pi/extensions/connect/lib.ts's parseModelInfo -- a small pure
 * function, per EPIC.md E2.10's "reuse the parsing" note, kept as a standalone copy so this
 * package doesn't depend on kernal. Parses LiteLLM's `GET /model/info` response. */
export function parseModelInfo(json: unknown): { ids: string[]; meta: Map<string, ModelMeta> } {
  const perM = (v: unknown) => (typeof v === "number" ? v * 1e6 : 0);
  const meta = new Map<string, ModelMeta>();
  const data = (json as { data?: Array<Record<string, any>> } | undefined)?.data ?? [];
  for (const m of data) {
    const i = m.model_info ?? {};
    if (!m.model_name || (i.mode && i.mode !== "chat")) continue;
    if (meta.has(m.model_name)) continue; // several deployments can share a model_name; keep the first
    meta.set(m.model_name, {
      cost: {
        input: perM(i.input_cost_per_token),
        output: perM(i.output_cost_per_token),
        cacheRead: perM(i.cache_read_input_token_cost),
        cacheWrite: perM(i.cache_creation_input_token_cost),
      },
      contextWindow: i.max_input_tokens ?? undefined,
      maxTokens: i.max_output_tokens ?? undefined,
      vision: i.supports_vision ?? undefined,
      reasoning: i.supports_reasoning ?? undefined,
    });
  }
  return { ids: [...meta.keys()].sort(), meta };
}

export interface KeyBudget {
  spend?: number;
  maxBudget?: number | null;
}

/** LiteLLM's `GET /key/info` nests the useful fields under `info` in newer releases; older ones (and
 * kernal's own BudgetData) read them off the top level. Accept either. */
export function parseKeyInfo(json: unknown): KeyBudget | undefined {
  const body = json as { info?: Record<string, unknown> } & Record<string, unknown>;
  const info = (body?.info ?? body) as { spend?: number; max_budget?: number | null } | undefined;
  if (!info || typeof info !== "object") return undefined;
  return { spend: info.spend, maxBudget: info.max_budget ?? null };
}

/** `GET /health/liveliness` (or the same info via a plain `/health`) for overall reachability,
 * `/model/info` for the model list with prices, `/key/info` for spend against budget -- run in
 * parallel, each independently allowed to fail without failing the others. */
export async function probeLitellm(
  baseUrl: string,
  keyFn: () => Promise<string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderRow[]> {
  const checkedAt = nowIso();
  let key: string;
  try {
    key = await keyFn();
  } catch {
    key = "";
  }
  if (!key) return [unknownRow("litellm", "litellm", "LiteLLM", "not configured")];

  const root = baseUrl.replace(/\/v1\/?$/, "");
  const headers = { Authorization: `Bearer ${key}` };
  const failed = (err: unknown) => failedResponse(err, timeoutMs);
  try {
    const [health, modelInfo, keyInfo] = await Promise.all([
      fetchJson(`${root}/health/liveliness`, headers, timeoutMs, fetchImpl).catch(failed),
      fetchJson(`${root}/model/info`, headers, timeoutMs, fetchImpl).catch(failed),
      fetchJson(`${root}/key/info`, headers, timeoutMs, fetchImpl).catch(failed),
    ]);

    const status: ProviderHealth = health.ok ? "up" : "down";
    const { ids } = modelInfo.ok ? parseModelInfo(modelInfo.json) : { ids: [] as string[] };
    const key_ = keyInfo.ok ? parseKeyInfo(keyInfo.json) : undefined;

    return [
      {
        id: "litellm",
        kind: "litellm",
        name: "LiteLLM",
        status,
        detail: health.ok ? undefined : health.error ? `health check failed: ${health.error}` : `health check HTTP ${health.status}`,
        checkedAt,
        meta: { models: ids, modelCount: ids.length, key: key_ },
      },
    ];
  } catch (err) {
    return [{ id: "litellm", kind: "litellm", name: "LiteLLM", status: "down", detail: errMessage(err), checkedAt }];
  }
}

// ---------- sandbox capacity (Cloud Run / GKE) ----------

/** Row id/kind/label for the configured sandbox provider's capacity row. Only cloudrun and gke
 * get their own row (dashboard history keeps `id: "cloudrun"` for its 7-day uptime, per
 * gke-sandbox-provider-plan.md §5 item 7); every local dev provider (inprocess, docker) reports
 * under the same "cloudrun" row it always has, since there's nothing else to show. */
function sandboxRow(sandboxProvider: SandboxProviderName): { id: string; kind: ProviderKind; name: string } {
  if (sandboxProvider === "gke") return { id: "gke", kind: "gke", name: "GKE Agent Sandbox" };
  return { id: "cloudrun", kind: "cloudrun", name: "Cloud Run agent job" };
}

/** "unknown" (not a probe failure) when the configured provider has no capacity to report --
 * either it isn't a cloud provider at all, or `capacityFn` wasn't injected (server.ts only
 * injects it when the default SandboxProvider actually implements `capacity()`) -- per EPIC.md
 * E2.10's "otherwise unknown". `capacityFn` is SandboxProvider.capacity(), see server.ts. */
export async function probeSandbox(
  sandboxProvider: SandboxProviderName,
  capacityFn: (() => Promise<SandboxCapacity>) | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProviderRow[]> {
  const checkedAt = nowIso();
  const row = sandboxRow(sandboxProvider);
  if (!isCloudProvider(sandboxProvider) || !capacityFn) {
    return [{ ...row, status: "unknown", detail: `SANDBOX_PROVIDER is not ${row.id}`, checkedAt }];
  }
  try {
    const capacity = await withTimeout(capacityFn(), timeoutMs);
    const meta: Record<string, unknown> = { active: capacity.active, runningExecutions: capacity.active };
    if (capacity.warmReady !== undefined) meta.warmReady = capacity.warmReady;
    if (capacity.warmDesired !== undefined) meta.warmDesired = capacity.warmDesired;
    if (capacity.limit !== undefined) meta.limit = capacity.limit;
    return [{ ...row, status: "up", checkedAt, meta }];
  } catch (err) {
    return [{ ...row, status: "down", detail: errMessage(err), checkedAt }];
  }
}

// ---------- the service ----------

/** Only the config fields the service's probes read -- lets tests build it without a full Config. */
export interface ProviderStatusConfig {
  ngrokApiKey: string;
  tunnelDomainLmstudio: string;
  localTunnelToken: string;
  litellmBaseUrl: string;
  sandboxProvider: SandboxProviderName;
}

export interface ProviderStatusServiceDeps {
  store: Store;
  sse: SseHub;
  laptopProbe: LaptopProbe;
  config: ProviderStatusConfig;
  /** Resolves the LiteLLM key to probe management endpoints with (config.litellmAdminKey, falling
   * back to SecretsBroker.defaultLitellmKey() -- see server.ts). */
  litellmKey: () => Promise<string>;
  /** The configured default SandboxProvider's optional capacity(), when it has one (server.ts
   * duck-types this off `provider.capacity` -- gke-sandbox-provider.md §2.4 gap G3). */
  sandboxCapacity?: () => Promise<SandboxCapacity>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function boundHistory(history: ProviderTransition[], nowMs: number): ProviderTransition[] {
  const cutoff = nowMs - SEVEN_DAYS_MS;
  return history.filter((t) => new Date(t.at).getTime() >= cutoff);
}

export class ProviderStatusService {
  private readonly store: Store;
  private readonly sse: SseHub;
  private readonly probes: Array<() => Promise<ProviderRow[]>>;
  /** When this instance last finished a poll (0 = never). Per instance on purpose: a new Cloud Run
   * instance has no trustworthy in-memory view of how fresh the stored rows are, so it re-polls. */
  private lastPollAt = 0;
  private inFlight: Promise<ProviderRow[]> | undefined;

  constructor(deps: ProviderStatusServiceDeps) {
    this.store = deps.store;
    this.sse = deps.sse;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.probes = [
      () => probeNgrok(deps.config.ngrokApiKey, timeoutMs, fetchImpl),
      () => probeLaptop(deps.laptopProbe, deps.config.tunnelDomainLmstudio, deps.config.localTunnelToken, timeoutMs, fetchImpl),
      () => probeLitellm(deps.config.litellmBaseUrl, deps.litellmKey, timeoutMs, fetchImpl),
      () => probeSandbox(deps.config.sandboxProvider, deps.sandboxCapacity, timeoutMs),
    ];
  }

  /** Current state, current rows only (no history) -- GET /api/providers and the SSE stream's
   * initial snapshot both use this. */
  async getCurrent(): Promise<ProviderRow[]> {
    const records = await this.store.providers.list();
    return records.map(({ history: _history, ...row }) => row);
  }

  /** Runs every probe, reconciles each row against stored state (bounding history to 7 days),
   * and publishes to the "providers" SSE channel iff at least one row's status changed. Never
   * throws: Promise.allSettled is a backstop on top of every probe's own internal try/catch. */
  async pollOnce(): Promise<ProviderRow[]> {
    // Single flight: concurrent readers (the page, its SSE snapshot, a manual refresh) share one poll.
    this.inFlight ??= this.runPoll().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Polls only when this instance hasn't finished a poll within `maxAgeMs`, then returns current
   * rows. This is how the web role keeps provider status fresh: inside a request, where Cloud Run
   * allocates CPU. A background timer does not work there -- with request-based CPU allocation and
   * scale-to-zero, a poll started between requests stalls until its 3 s timeouts fire and every
   * probe reports a false "down" (observed 2026-09-22 on outfitter-api-00007). */
  async refreshIfStale(maxAgeMs: number): Promise<ProviderRow[]> {
    if (Date.now() - this.lastPollAt < maxAgeMs) return this.getCurrent();
    try {
      return await this.pollOnce();
    } catch (err) {
      // Probes never throw; this is the store failing mid-poll (e.g. an Atlas failover). Serve the
      // last stored rows rather than failing the page. lastPollAt is untouched, so the next read
      // retries the poll.
      console.error("[providers] poll failed; serving stored rows", err);
      return this.getCurrent();
    }
  }

  private async runPoll(): Promise<ProviderRow[]> {
    const nowMs = Date.now();
    const settled = await Promise.allSettled(this.probes.map((probe) => probe()));
    const rows = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    const changedFlags = await Promise.all(rows.map((row) => this.reconcileRow(row, nowMs)));
    const current = await this.getCurrent();
    if (changedFlags.some(Boolean)) {
      this.sse.publish(SSE_CHANNEL, { type: "status", data: { providers: current } });
    }
    this.lastPollAt = Date.now();
    return current;
  }

  /** Feeds an immediate laptop-state update from the ngrok webhook (routes/hooks.ts), without
   * waiting for the next poll or re-probing the other providers. */
  async noteLaptopTransition(online: boolean): Promise<void> {
    const row: ProviderRow = {
      id: "laptop",
      kind: "laptop",
      name: "Laptop (LM Studio)",
      status: online ? "up" : "down",
      checkedAt: nowIso(),
    };
    const changed = await this.reconcileRow(row, Date.now());
    if (changed) {
      const current = await this.getCurrent();
      this.sse.publish(SSE_CHANNEL, { type: "status", data: { providers: current } });
    }
  }


  private async reconcileRow(row: ProviderRow, nowMs: number): Promise<boolean> {
    const prior = await this.store.providers.findById(row.id);
    const changed = !prior || prior.status !== row.status;
    let history = prior?.history ?? [];
    if (changed) history = [...history, { status: row.status, at: row.checkedAt }];
    history = boundHistory(history, nowMs);
    const record: ProviderRecord = { ...row, history };
    await this.store.providers.upsert(record);
    return changed;
  }
}
