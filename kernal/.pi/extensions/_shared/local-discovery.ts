/**
 * Local model-server discovery (#379 LH-1), shared by `connect` and the Local Host service (#381)
 * and its heartbeat (#382): which OpenAI-compatible model servers answer on this machine, and every
 * model each one has DOWNLOADED (owner decision: not only the loaded ones), marked loaded or not.
 *
 *   LM Studio   :1234   /api/v0/models (state, max/loaded context, type, tool use) + /v1/models
 *   Ollama      :11434  /api/tags (pulled), /api/ps (loaded, served context), /api/show (capabilities)
 *   llama.cpp   :8080   /v1/models (+ router-mode status, n_ctx_train) + /props (served n_ctx, vision)
 *   mlx-lm      :8080   /v1/models (the Hugging Face cache's MLX models)
 *   vLLM        :8000   /v1/models (max_model_len)
 *   anything else that speaks OpenAI's /v1/models, at a configured URL
 *
 * The ports above are probed on localhost only. Overrides (`env`, the merged .env/shell/central
 * values): LMSTUDIO_BASE_URL and OLLAMA_HOST / OLLAMA_BASE_URL replace their server's default URL;
 * LLAMACPP_BASE_URL, MLX_LM_BASE_URL and VLLM_BASE_URL add a server of that kind; KERNAL_LOCAL_SERVERS
 * adds a comma-separated list (`url` or `kind=url`). Nothing else is ever contacted.
 *
 * Every probe has a short timeout and they all run in parallel; one server failing, timing out or
 * answering nonsense never hides the others. `discoverLocalModels` keeps no state: give it the env
 * and (in tests) a fetch, get back a snapshot that is plain JSON, sorted, without timestamps, plus a
 * `key` that changes only when the set of answering servers or anything about their models changes,
 * so a poller compares one string to know whether to send a heartbeat.
 */
import { createHash } from "node:crypto";

export type ServerKind = "lmstudio" | "ollama" | "llamacpp" | "mlx-lm" | "vllm" | "openai";
/** `auto`: work out the kind from the server's /v1/models answer (the shared 8080/8000 ports). */
export type TargetKind = ServerKind | "auto";

export type LocalModel = {
  id: string;                     // what the server's OpenAI endpoint takes as `model`
  server: string;                 // the server's root URL, ServerSnapshot.id
  kind: ServerKind;
  /** In memory now. Absent when the server doesn't say (mlx-lm, generic servers). */
  loaded?: boolean;
  /** LM Studio only: its /v1/models lists the id, so a request is accepted now (JIT loading off lists loaded models only). */
  listed?: boolean;
  /** The window a request gets: the served one when loaded and known, else the model's maximum. */
  contextLength?: number;
  maxContextLength?: number;      // the model's ceiling (trained / configured maximum)
  loadedContextLength?: number;   // what the loaded instance serves
  type?: string;                  // "llm" | "vlm" | "embeddings" as the server names it
  vision?: boolean;
  toolUse?: boolean;
  quantization?: string;
  sizeBytes?: number;
};

export type ServerSnapshot = {
  id: string;                     // root URL, e.g. http://localhost:1234
  kind: ServerKind;
  baseUrl: string;                // OpenAI-compatible base: id + /v1
  ok: boolean;                    // at least one of its endpoints answered
  error?: string;                 // "timeout" | "refused" | "HTTP 404" | "bad response" | ...
  endpoints: string[];            // the paths that answered, e.g. ["/api/v0/models", "/v1/models"]
  models: number;
};

export type DiscoverySnapshot = { servers: ServerSnapshot[]; models: LocalModel[]; key: string };

export type Target = { kind: TargetKind; url: string; apiKey?: string; configured?: boolean };
type Fetch = typeof fetch;
export type DiscoveryOptions = {
  env?: Record<string, string | undefined>;
  fetch?: Fetch;
  timeoutMs?: number;             // per request; Ollama's /api/show runs after /api/tags, so at most ~2x
  targets?: Target[];             // replaces defaultTargets(env)
};

export const DEFAULT_TIMEOUT_MS = 1500;

// ---------- where to look ----------

/**
 * A root URL as people write it: scheme added (http for a bare host), trailing slashes and a
 * trailing /v1 or /api dropped, and a wildcard bind address (0.0.0.0, ::) turned into loopback.
 */
export function serverRoot(input: string, defaultPort?: number): string | undefined {
  let u = (input || "").trim();
  if (!u) return undefined;
  const bare = !/^https?:\/\//i.test(u);
  if (bare) u = `http://${u}`;
  let url: URL;
  try { url = new URL(u); } catch { return undefined; }
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  if (url.hostname === "[::]") url.hostname = "[::1]";
  if (bare && !url.port && defaultPort) url.port = String(defaultPort);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/(v\d+|api)$/i, "");
  return `${url.protocol}//${url.host}${path}`;
}

const KINDS: readonly string[] = ["lmstudio", "ollama", "llamacpp", "mlx-lm", "vllm", "openai", "auto"];

/** The servers to probe: localhost's usual ports, with the env's overrides and additions. Deduplicated by root URL, a configured entry winning. */
export function defaultTargets(env: Record<string, string | undefined> = {}): Target[] {
  const lm = env.LMSTUDIO_BASE_URL && serverRoot(env.LMSTUDIO_BASE_URL);
  const ol = (env.OLLAMA_BASE_URL && serverRoot(env.OLLAMA_BASE_URL)) || (env.OLLAMA_HOST && serverRoot(env.OLLAMA_HOST, 11434));
  const out: Target[] = [
    lm ? { kind: "lmstudio", url: lm, configured: true } : { kind: "lmstudio", url: "http://localhost:1234" },
    ol ? { kind: "ollama", url: ol, configured: true } : { kind: "ollama", url: "http://localhost:11434" },
  ];
  for (const [name, kind] of [["LLAMACPP_BASE_URL", "llamacpp"], ["MLX_LM_BASE_URL", "mlx-lm"], ["VLLM_BASE_URL", "vllm"]] as const) {
    const url = env[name] && serverRoot(env[name]!);
    if (url) out.push({ kind, url, configured: true });
  }
  for (const item of (env.KERNAL_LOCAL_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = item.match(/^([a-z.-]+)=(.+)$/i);
    const named = !!m && KINDS.includes(m[1].toLowerCase());
    if (m && !named) continue;   // "kind=url" with a kind we don't know: a typo, not a URL
    const kind = (named ? m![1].toLowerCase() : "auto") as TargetKind;
    const url = serverRoot(named ? m![2] : item);
    if (url) out.push({ kind, url, configured: true });
  }
  out.push({ kind: "auto", url: "http://localhost:8080" }, { kind: "auto", url: "http://localhost:8000" });
  const seen = new Map<string, Target>();
  for (const t of out) {
    const prev = seen.get(t.url);
    if (!prev || (t.configured && !prev.configured)) seen.set(t.url, t);
  }
  return [...seen.values()];
}

// ---------- HTTP ----------

type Answer = { ok: true; json: any } | { ok: false; error: string };

function failure(e: any): string {
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "timeout";
  const code = e?.cause?.code ?? e?.code;
  if (code === "ECONNREFUSED") return "refused";
  return code ? String(code).toLowerCase() : "unreachable";
}

async function getJson(f: Fetch, url: string, timeoutMs: number, apiKey?: string, body?: unknown): Promise<Answer> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await f(url, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json().catch(() => undefined);
    return json && typeof json === "object" ? { ok: true, json } : { ok: false, error: "bad response" };
  } catch (e) { return { ok: false, error: failure(e) }; }
  finally { clearTimeout(t); }
}

// ---------- per-server parsing (pure) ----------

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const list = (json: any): any[] => (Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []);
const ctxOf = (loaded: boolean | undefined, served?: number, max?: number) => (loaded && served) || max || served;

/** Drop undefined fields so the snapshot (and its key) has one spelling per state. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** LM Studio's native /api/v0/models: every downloaded model, embeddings included (callers filter on `type`). */
export function parseLmStudioNative(json: any, server = ""): LocalModel[] {
  const out: LocalModel[] = [];
  for (const m of list(json)) {
    if (!m?.id) continue;
    const loaded = m.state === "loaded";
    const type = str(m.type);
    const max = num(m.max_context_length), served = loaded ? num(m.loaded_context_length) : undefined;
    out.push(clean({
      id: String(m.id), server, kind: "lmstudio" as const, loaded, contextLength: ctxOf(loaded, served, max), maxContextLength: max, loadedContextLength: served,
      type, vision: m.type ? m.type === "vlm" : undefined, toolUse: Array.isArray(m.capabilities) ? m.capabilities.includes("tool_use") : undefined,
      quantization: str(m.quantization),
    }));
  }
  return out;
}

/** OpenAI /v1/models as llama.cpp, mlx-lm, vLLM and the rest answer it. */
export function parseOpenAiModels(json: any, server: string, kind: ServerKind, props?: any): LocalModel[] {
  const servedCtx = num(props?.default_generation_settings?.n_ctx) ?? num(props?.n_ctx);
  const propsVision = typeof props?.modalities?.vision === "boolean" ? props.modalities.vision : undefined;
  const rows = list(json).filter((m) => m?.id ?? m?.name ?? m?.model);
  return rows.map((m) => {
    const id = String(m.id ?? m.name ?? m.model);
    const status = str(m.status?.value) ?? str(m.status);   // llama.cpp router mode
    let loaded: boolean | undefined;
    if (status) loaded = status === "loaded";
    else if (kind === "vllm") loaded = true;               // vLLM lists what it serves
    else if (kind === "llamacpp") loaded = rows.length === 1 ? true : undefined;   // a plain llama-server serves its one model
    const max = num(m.meta?.n_ctx_train) ?? num(m.max_model_len) ?? num(m.context_length) ?? num(m.context_window) ?? num(m.max_context_length);
    const served = loaded && kind === "llamacpp" && rows.length === 1 ? servedCtx : undefined;
    return clean({
      id, server, kind, loaded, contextLength: ctxOf(loaded, served, max), maxContextLength: max, loadedContextLength: served,
      vision: rows.length === 1 ? propsVision : undefined,
      sizeBytes: num(m.meta?.size),
    });
  });
}

/** Ollama: /api/tags (pulled) + /api/ps (loaded, served context) + /api/show per model (capabilities, ceiling). */
export function parseOllama(server: string, tags: any, ps?: any, shows: Record<string, any> = {}): LocalModel[] {
  const running = new Map<string, any>();
  for (const r of list(ps)) running.set(String(r?.name ?? r?.model), r);
  return list(tags).filter((m) => m?.name ?? m?.model).map((m) => {
    const id = String(m.name ?? m.model);
    const r = running.get(id) ?? running.get(String(m.model));
    const show = shows[id];
    const caps: string[] | undefined = Array.isArray(show?.capabilities) ? show.capabilities : undefined;
    let max: number | undefined;
    for (const [k, v] of Object.entries(show?.model_info ?? {})) if (k.endsWith(".context_length")) max = num(v) ?? max;
    const loaded = !!r, served = loaded ? num(r.context_length) : undefined;
    const embed = caps?.includes("embedding") && !caps.includes("completion");
    const vision = caps ? caps.includes("vision") : undefined;
    return clean({
      id, server, kind: "ollama" as const, loaded, contextLength: ctxOf(loaded, served, max), maxContextLength: max, loadedContextLength: served,
      type: caps ? (embed ? "embeddings" : vision ? "vlm" : "llm") : undefined,
      vision, toolUse: caps ? caps.includes("tools") : undefined,
      quantization: str(m.details?.quantization_level), sizeBytes: num(m.size),
    });
  });
}

/** Which server answered a /v1/models: by the `owned_by` each one writes. */
export function classify(json: any): ServerKind {
  const owners = new Set(list(json).map((m) => m?.owned_by));
  if (owners.has("llamacpp")) return "llamacpp";
  if (owners.has("vllm")) return "vllm";
  if (owners.has("organization_owner")) return "lmstudio";
  if (owners.has("library") || owners.has("ollama")) return "ollama";
  const rows = list(json);
  if (rows.length && rows.every((m) => m && !("owned_by" in m))) return "mlx-lm";   // mlx_lm.server writes id/object/created only
  return "openai";
}

// ---------- probing ----------

type Probe = { server: ServerSnapshot; models: LocalModel[] };

function result(root: string, kind: ServerKind, answers: [string, Answer][], models: LocalModel[]): Probe {
  const endpoints = answers.filter(([, a]) => a.ok).map(([p]) => p);
  const firstError = answers.find(([, a]) => !a.ok)?.[1] as { error: string } | undefined;
  const ok = endpoints.length > 0;
  return {
    server: clean({ id: root, kind, baseUrl: `${root}/v1`, ok, error: ok ? undefined : firstError?.error ?? "unreachable", endpoints, models: models.length }),
    models: models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

async function probeLmStudio(f: Fetch, root: string, timeoutMs: number, apiKey?: string): Promise<Probe> {
  const [native, openai] = await Promise.all([getJson(f, `${root}/api/v0/models`, timeoutMs, apiKey), getJson(f, `${root}/v1/models`, timeoutMs, apiKey)]);
  const byId = new Map<string, LocalModel>();
  if (native.ok) for (const m of parseLmStudioNative(native.json, root)) byId.set(m.id, m);
  if (openai.ok) {
    for (const m of byId.values()) m.listed = false;
    for (const row of list(openai.json)) {
      if (!row?.id) continue;
      const id = String(row.id);
      byId.set(id, { ...(byId.get(id) ?? { id, server: root, kind: "lmstudio" }), listed: true });
    }
  }
  return result(root, "lmstudio", [["/api/v0/models", native], ["/v1/models", openai]], [...byId.values()]);
}

async function probeOllama(f: Fetch, root: string, timeoutMs: number): Promise<Probe> {
  const [tags, ps] = await Promise.all([getJson(f, `${root}/api/tags`, timeoutMs), getJson(f, `${root}/api/ps`, timeoutMs)]);
  const shows: Record<string, any> = {};
  if (tags.ok) {
    await Promise.all(list(tags.json).map(async (m) => {
      const name = m?.name ?? m?.model; if (!name) return;
      const a = await getJson(f, `${root}/api/show`, timeoutMs, undefined, { model: String(name) });
      if (a.ok) shows[String(name)] = a.json;
    }));
  }
  // /api/ps alone doesn't make a server: without /api/tags there's no list of what is downloaded.
  return result(root, "ollama", [["/api/tags", tags], ...(tags.ok ? [["/api/ps", ps] as [string, Answer]] : [])], tags.ok ? parseOllama(root, tags.json, ps.ok ? ps.json : undefined, shows) : []);
}

async function probeOpenAi(f: Fetch, t: Target, root: string, timeoutMs: number): Promise<Probe> {
  const models = await getJson(f, `${root}/v1/models`, timeoutMs, t.apiKey);
  if (!models.ok) return result(root, t.kind === "auto" ? "openai" : t.kind, [["/v1/models", models]], []);
  const kind = t.kind === "auto" ? classify(models.json) : t.kind;
  if (t.kind === "auto" && kind === "lmstudio") return probeLmStudio(f, root, timeoutMs, t.apiKey);
  if (t.kind === "auto" && kind === "ollama") return probeOllama(f, root, timeoutMs);
  const props = kind === "llamacpp" ? await getJson(f, `${root}/props`, timeoutMs, t.apiKey) : undefined;
  const answers: [string, Answer][] = [["/v1/models", models], ...(props?.ok ? [["/props", props] as [string, Answer]] : [])];
  return result(root, kind, answers, parseOpenAiModels(models.json, root, kind, props?.ok ? props.json : undefined));
}

/** Probe one server. Never throws: a dead server comes back `ok: false` with why. */
export async function probeServer(t: Target, opts: Pick<DiscoveryOptions, "fetch" | "timeoutMs"> = {}): Promise<Probe> {
  const f = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const root = serverRoot(t.url) ?? t.url;
  try {
    if (t.kind === "lmstudio") return await probeLmStudio(f, root, timeoutMs, t.apiKey);
    if (t.kind === "ollama") return await probeOllama(f, root, timeoutMs);
    return await probeOpenAi(f, t, root, timeoutMs);
  } catch (e) {   // a parser meeting a shape it didn't expect
    return result(root, t.kind === "auto" ? "openai" : t.kind, [["", { ok: false, error: `bad response (${failure(e)})` }]], []);
  }
}

/** The change-detection key: answering servers and their models, nothing that flaps (error text, endpoints). */
export function snapshotKey(s: Pick<DiscoverySnapshot, "servers" | "models">): string {
  const canon = JSON.stringify({
    servers: s.servers.filter((x) => x.ok).map((x) => [x.id, x.kind]),
    models: s.models.map((m) => Object.keys(m).sort().map((k) => [k, (m as any)[k]])),
  });
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

/** Every local server and every model it has downloaded, as a stable, JSON-serialisable snapshot. */
export async function discoverLocalModels(opts: DiscoveryOptions = {}): Promise<DiscoverySnapshot> {
  const targets = opts.targets ?? defaultTargets(opts.env ?? (process.env as Record<string, string>));
  const probes = await Promise.all(targets.map((t) => probeServer(t, opts)));
  probes.sort((a, b) => (a.server.id < b.server.id ? -1 : a.server.id > b.server.id ? 1 : 0));
  const servers = probes.map((p) => p.server);
  const models = probes.flatMap((p) => p.models);
  return { servers, models, key: snapshotKey({ servers, models }) };
}
