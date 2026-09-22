/** Pure logic for loading open-codebase-index and seeding its defaults; tested without pi. */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";
export const DEFAULT_DIMENSIONS = 768;
export const PACKAGE = "open-codebase-index";

/** How to load the indexer in this runtime. */
export type LoadPlan = { kind: "prebundled"; entry: string } | { kind: "source"; entry: string } | { kind: "none"; reason: string };

/**
 * pi cannot load this package as a normal `packages` entry: it loads package extensions through
 * jiti, which hands the runtime a data: URL of the transpiled 1 MB entry, and pi's Bun-compiled
 * binary rejects a specifier that long (NameTooLong). Release bundles therefore ship a pre-bundled
 * CommonJS build (scripts/package.sh) that require() loads from disk. Under Node (a source install)
 * the original ESM entry still imports fine, so that is the fallback.
 */
export function loadPlan(opts: { prebundled: boolean; source: boolean; isBun: boolean; prebundledPath: string; sourcePath: string }): LoadPlan {
  if (opts.prebundled) return { kind: "prebundled", entry: opts.prebundledPath };
  if (opts.source && !opts.isBun) return { kind: "source", entry: opts.sourcePath };
  if (opts.source) return { kind: "none", reason: "needs the pre-bundled build (run scripts/package.sh or npm run build:index)" };
  return { kind: "none", reason: `${PACKAGE} is not installed` };
}

export type IndexConfig = {
  embeddingProvider: string;
  customProvider?: { baseUrl: string; model: string; dimensions: number };
  indexing?: Record<string, unknown>;
  search?: Record<string, unknown>;
};

/** LM Studio's OpenAI-compatible embeddings endpoint, from LMSTUDIO_BASE_URL. */
export function embeddingBaseUrl(env: Record<string, string | undefined>): string {
  const raw = (env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1").trim().replace(/\/+$/, "");
  return /\/v1$/.test(raw) ? raw : `${raw}/v1`;
}

/**
 * Machine-wide defaults for projects that carry no config of their own: embeddings from the local
 * model server (free, private, no API key), no automatic indexing (it stays an explicit request)
 * and a result budget that suits an agent's context.
 */
export function defaultConfig(env: Record<string, string | undefined>): IndexConfig {
  return {
    embeddingProvider: "custom",
    customProvider: { baseUrl: embeddingBaseUrl(env), model: env.KERNAL_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL, dimensions: Number(env.KERNAL_EMBEDDING_DIMENSIONS) || DEFAULT_DIMENSIONS },
    indexing: { autoIndex: false, watchFiles: true, requireProjectMarker: true },
    // rerankTopN 100 (the package defaults to 20, equal to maxResults, so a reranker could only
    // reorder what fusion already returned). Measured on this repo: MRR 0.556 → 0.597, top-1 5 → 6
    // of 12. See docs/index-retrieval.md.
    search: { maxResults: 20, minScore: 0.1, fusionStrategy: "rrf", rerankTopN: 100 },
  };
}

/** Seed only when the user has no usable config; never overwrite one they own. */
export function shouldSeed(existing: string | undefined): boolean {
  if (existing === undefined) return true;
  try { const p = JSON.parse(existing); return !p || typeof p !== "object" || Object.keys(p).length === 0; } catch { return false; }
}

// ---------- status parsing ----------
export type IndexStatus = {
  indexed: boolean;
  chunks?: number;
  branch?: string;
  location?: string;
  autoIndex?: string;      // e.g. "disabled (state: idle)"
  mode?: string;           // hybrid | semantic
  model?: string;          // what the stored vectors were built with
  incompatible?: string;   // set when the store no longer matches the configured provider/model
  running: boolean;        // a run is in progress right now
  progress?: Progress;
  raw: string;
};

/** What the indexer reports while it works: "Auto-index progress: embedding 83% (128/478 files, 352/394 chunks)". */
export type Progress = { phase: string; percent: number; files?: { done: number; total: number }; chunks?: { done: number; total: number } };

export function parseProgress(text: string): Progress | undefined {
  const m = text.match(/Auto-index progress:\s*(\w[\w -]*?)\s+(\d+)%\s*(?:\(([^)]*)\))?/);
  if (!m) return undefined;
  const counts = (label: string) => {
    const c = (m[3] ?? "").match(new RegExp(`(\\d+)\\s*\\/\\s*(\\d+)\\s+${label}`));
    return c ? { done: Number(c[1]), total: Number(c[2]) } : undefined;
  };
  return { phase: m[1].trim(), percent: Number(m[2]), files: counts("files"), chunks: counts("chunks") };
}

/** index_status prints human-readable lines; read the few facts a panel needs, keep the rest as raw. */
export function parseStatus(text: string): IndexStatus {
  const line = (re: RegExp) => text.match(re)?.[1]?.trim();
  // The count is printed with thousands separators once an index is any size at all.
  const chunks = line(/Indexed chunks[^:]*:\s*([\d,]+)/)?.replace(/,/g, "");
  const compatibility = line(/Compatibility:\s*(.+)/);
  const autoIndex = line(/Auto-index:\s*(.+)/);
  return {
    running: /state:\s*(indexing|embedding|scanning|parsing)/i.test(autoIndex ?? "") || /state:\s*(indexing|embedding)/i.test(text),
    progress: parseProgress(text),
    indexed: !/is not indexed/i.test(text) && Number(chunks ?? 0) > 0,
    chunks: chunks === undefined || chunks === "" ? undefined : Number(chunks),
    branch: line(/Current branch:\s*(.+)/),
    location: line(/Location:\s*(.+)/),
    autoIndex,
    mode: line(/Indexing mode:\s*(.+)/),
    model: line(/^Model:\s*(.+)$/m),
    incompatible: compatibility && !/is compatible/i.test(compatibility) ? compatibility : undefined,
    raw: text.trim(),
  };
}

/** A tool result can be a string, {content: string} or {content: [{type:"text",text}]}; flatten it. */
export function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as any;
  const c = r?.content ?? r?.output ?? r?.text;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).filter(Boolean).join("\n");
  return typeof r?.error === "string" ? r.error : "";
}

// ---------- config in effect ----------
export type ConfigView = { files: string[]; scope: "project" | "user" | "project+user" | "defaults"; provider: string; baseUrl?: string; model?: string; dimensions?: number; autoIndex?: unknown; watchFiles?: unknown; maxResults?: unknown; minScore?: unknown; fusion?: unknown; knowledgeBases: string[]; reranker?: Record<string, any> };

/**
 * The package merges its two layers rather than letting the nearer one win: the user's config is the
 * base, a project config replaces whole top-level keys it declares (PROJECT_OVERRIDE_KEYS in the
 * package: embeddingProvider, customProvider, reranker, indexing, search, include, exclude, scope…)
 * and `knowledgeBases` is unioned across both. This mirrors that, so the panel reports what the
 * indexer will actually do.
 */
const OVERRIDE_KEYS = ["embeddingProvider", "customProvider", "embeddingModel", "reranker", "include", "exclude", "indexing", "search", "scope"];

export function configView(layers: { file: string; scope: "project" | "user"; text?: string }[], env: Record<string, string | undefined>): ConfigView {
  const parsed: { file: string; scope: "project" | "user"; data: Record<string, any> }[] = [];
  for (const l of layers) {
    if (l.text === undefined) continue;
    try { const data = JSON.parse(l.text); if (data && typeof data === "object") parsed.push({ ...l, data }); } catch {}
  }
  const user = parsed.find((l) => l.scope === "user");
  const project = parsed.find((l) => l.scope === "project");
  const merged: Record<string, any> = { ...(user?.data ?? {}) };
  for (const key of OVERRIDE_KEYS) if (project?.data && key in project.data) merged[key] = project.data[key];
  merged.knowledgeBases = [...new Set([...(user?.data?.knowledgeBases ?? []), ...(project?.data?.knowledgeBases ?? [])].map(String))];

  const d = defaultConfig(env);
  const scope = project && user ? "project+user" : project ? "project" : user ? "user" : "defaults";
  const source = parsed.length ? merged : { ...d, knowledgeBases: [] };
  return {
    files: parsed.map((l) => l.file), scope,
    provider: String(source.embeddingProvider ?? "auto"),
    baseUrl: source.customProvider?.baseUrl, model: source.customProvider?.model, dimensions: source.customProvider?.dimensions,
    autoIndex: source.indexing?.autoIndex, watchFiles: source.indexing?.watchFiles,
    maxResults: source.search?.maxResults, minScore: source.search?.minScore, fusion: source.search?.fusionStrategy,
    knowledgeBases: source.knowledgeBases ?? [], reranker: source.reranker,
  };
}

// ---------- directories the indexer cannot see ----------
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|cs|c|h|cpp|swift|php|sh|bash|zsh|sql|md|json|ya?ml|toml)$/i;

/**
 * The package's directory walk skips any path segment starting with a dot before it consults include
 * or exclude rules, so no setting can bring `.pi/extensions` or `.github/workflows` into the index.
 * A knowledge base is the only supported route. This finds tracked source under dot-directories that
 * no knowledge base already covers, so the panel can say so and offer to add it.
 */
export function hiddenSourceDirs(trackedPaths: string[], knowledgeBases: string[] = []): { dir: string; files: number }[] {
  const covered = knowledgeBases.map((k) => k.replace(/^\.\//, "").replace(/\/+$/, ""));
  const counts = new Map<string, number>();
  for (const raw of trackedPaths) {
    const path = raw.trim();
    if (!path || !CODE.test(path)) continue;
    const parts = path.split("/");
    const index = parts.findIndex((p, i) => i < parts.length - 1 && p.startsWith("."));
    if (index === -1) continue;
    const dir = parts.slice(0, index + 1).join("/");
    if (/(^|\/)(\.git|\.codebase-index|\.opencode)$/.test(dir)) continue;   // tooling state, not source
    if (covered.some((c) => c === dir || dir.startsWith(`${c}/`) || c.startsWith(`${dir}/`))) continue;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()].map(([dir, files]) => ({ dir, files })).sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir));
}

// ---------- panel ----------
export type Seg = [string, string | null];
export type Embeddings = { reachable: boolean; loaded?: boolean; note?: string };
export type PanelData = { status: IndexStatus; config: ConfigView; embeddings?: Embeddings; knowledgeBases?: string[]; staleBases?: string[]; toolCount?: number; project: string; hidden?: { dir: string; files: number }[]; docs?: { path?: string; indexed: boolean } };

const yesNo = (v: unknown) => (v === true ? "on" : v === false ? "off" : v === undefined ? "—" : String(v));
const label = (text: string): Seg => [text.padEnd(9), "muted"];   // one column, so values line up

export function panelRows(d: PanelData): Seg[][] {
  const s = d.status;
  const rows: Seg[][] = [];
  if (s.running) {
    const p = s.progress;
    const percent = progressPercent(p);
    rows.push([label("indexing"), [`${miniBar(percent)} `, "accent"], [`${percent}% `, "text"], [p?.phase ?? "working", "muted"]]);
    if (p?.files) rows.push([label(""), [`${p.files.done}/${p.files.total} files`, "dim"], [p.chunks ? `  ${p.chunks.done}/${p.chunks.total} chunks` : "", "dim"]]);
  } else {
    rows.push(s.indexed
      ? [label("index"), [`${s.chunks?.toLocaleString("en-US")} chunks`, "success"], [`  branch ${s.branch ?? "—"}${s.mode ? ` · ${s.mode}` : ""}`, "dim"]]
      : [label("index"), ["not indexed", "warning"], ["  ask the agent to index this repo", "dim"]]);
  }
  rows.push([label("project"), [d.project, "text"]]);
  if (s.location) rows.push([label("store"), [s.location, "dim"]]);
  const e = d.embeddings;
  const embedState: Seg = e === undefined ? ["—", "dim"] : e.reachable ? (e.loaded === false ? ["server up, model not loaded yet", "warning"] : ["ready", "success"]) : ["server unreachable", "error"];
  rows.push([label("embed"), [`${d.config.model ?? "?"} `, "accent"], [`${d.config.dimensions ?? "?"}d  `, "dim"], embedState]);
  rows.push([label(""), [`${d.config.provider} · ${d.config.baseUrl ?? "—"}`, d.config.provider === "custom" ? "dim" : "error"]]);
  const problem = embeddingProblem(d.config);
  if (problem) rows.push([label("problem"), [problem, "error"]]);
  rows.push([label("search"), [`${yesNo(d.config.maxResults)} results · min score ${yesNo(d.config.minScore)} · ${yesNo(d.config.fusion)}`, "text"]]);
  rows.push([label("indexing"), [`auto ${yesNo(d.config.autoIndex)} · watch ${yesNo(d.config.watchFiles)}`, "text"], [s.autoIndex ? `  (${s.autoIndex})` : "", "dim"]]);
  rows.push([label("config"), [d.config.files.join(" + ") || "built-in defaults", "dim"], [`  (${d.config.scope})`, "dim"]]);
  if (d.knowledgeBases !== undefined) rows.push([label("extra"), [d.knowledgeBases.length ? d.knowledgeBases.join(", ") : "no knowledge bases", d.knowledgeBases.length ? "text" : "dim"]]);
  for (const stale of d.staleBases ?? []) rows.push([label("stale kb"), [stale, "warning"], ["  gone from disk (an upgrade moved it)", "dim"]]);
  if (d.docs && !d.docs.indexed && d.docs.path) rows.push([label("pi docs"), ["not indexed", "dim"], ["  hooks, settings and the extension API are grep-only until they are", "dim"]]);
  if (s.incompatible) rows.push([label("stale"), [s.incompatible, "error"], ["  rebuild to match the current model", "dim"]]);
  if (d.config.reranker?.enabled) rows.push([label("rerank"), [String(d.config.reranker.model ?? "?"), "accent"], ["  on the router", "dim"]]);
  for (const h of d.hidden ?? []) {
    rows.push([label("skipped"), [`${h.dir} (${h.files} tracked files)`, "warning"], ["  dot-directories are invisible to the index", "dim"]]);
  }
  if (d.toolCount) rows.push([label("tools"), [`${d.toolCount} available`, "dim"]]);
  return rows;
}

/** One-line status-bar entry: progress while a run is going, the size of the index otherwise. */
export function indexStatusLine(s: IndexStatus): string {
  if (s.running) {
    const p = s.progress;
    if (!p) return "⌕ indexing…";
    const files = p.files ? ` · ${p.files.done}/${p.files.total} files` : "";
    return `⌕ ${p.phase} ${progressPercent(p)}%${files}`;
  }
  return s.indexed ? `⌕ ${s.chunks} chunks` : "⌕ no index";
}

/**
 * The indexer's own percentage is per batch, so it jumps backwards (83% then 72%). The file count is
 * monotonic, so use it when it is there and keep the reported number only as a fallback.
 */
export function progressPercent(p: Progress | undefined): number {
  if (!p) return 0;
  if (p.files && p.files.total > 0) return Math.min(100, Math.round((p.files.done / p.files.total) * 100));
  return Math.max(0, Math.min(100, p.percent));
}

/** A short inline bar, for the panel's progress row. */
export const miniBar = (percent: number, width = 24) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
};

// ---------- actions ----------
export type Action = { label: string; tool?: string; params?: Record<string, unknown>; kind?: "refresh" | "close" | "kb-add" | "kb-remove" | "settings" | "kb-hidden" | "kb-docs" };
export function actions(s: IndexStatus, hidden: { dir: string; files: number }[] = [], docs?: { path?: string; indexed: boolean }): Action[] {
  return [
    ...(docs?.path && !docs.indexed ? [{ label: "Index the agent's own documentation (pi docs)", kind: "kb-docs" as const }] : []),
    ...(docs?.path && docs.indexed ? [{ label: "Re-point the agent's documentation at this version", kind: "kb-docs" as const }] : []),
    ...(hidden.length ? [{ label: `Index the skipped ${hidden[0].dir} as a knowledge base`, kind: "kb-hidden" as const }] : []),
    { label: s.indexed ? "Update the index (changed files only)" : "Index this codebase now", tool: "index_codebase", params: {} },
    { label: "Rebuild from scratch", tool: "index_codebase", params: { force: true } },
    { label: "Estimate first (no writes)", tool: "index_codebase", params: { estimateOnly: true } },
    { label: "Health check", tool: "index_health_check", params: {} },
    { label: "Metrics", tool: "index_metrics", params: {} },
    { label: "Recent log", tool: "index_logs", params: { limit: 20 } },
    { label: "Settings (embedding server, model, dimensions, search)", kind: "settings" },
    { label: "Add a knowledge base directory", kind: "kb-add" },
    { label: "Remove a knowledge base directory", kind: "kb-remove" },
    { label: "Refresh", kind: "refresh" },
    { label: "Close panel", kind: "close" },
  ];
}

/** Names the model-facing subcommands map to, for `/index <sub>` outside the picker. */
export const SUBCOMMANDS: Record<string, { tool?: string; params?: Record<string, unknown>; kind?: "panel" | "off" }> = {
  "": { kind: "panel" },
  status: { tool: "index_status", params: {} },
  update: { tool: "index_codebase", params: {} },
  reindex: { tool: "index_codebase", params: { force: true } },
  estimate: { tool: "index_codebase", params: { estimateOnly: true } },
  health: { tool: "index_health_check", params: {} },
  metrics: { tool: "index_metrics", params: {} },
  logs: { tool: "index_logs", params: { limit: 20 } },
  bases: { tool: "knowledge_base_list", params: {} },
  off: { kind: "off" },
};

// ---------- where embeddings come from ----------
export type EmbeddingChoice = { source: "local" | "router"; id: string; dimensions?: number };

export const embeddingChoiceLabel = (c: EmbeddingChoice) => `${c.source.padEnd(6)} ${c.id}${c.dimensions ? `  (${c.dimensions}d)` : ""}`;

export function parseEmbeddingChoice(label: string, choices: EmbeddingChoice[]): EmbeddingChoice | undefined {
  return choices.find((c) => embeddingChoiceLabel(c) === label);
}

/**
 * `embeddingProvider` decides where embeddings come from. "custom" uses `customProvider`; anything
 * else makes the package hunt for ollama, openai or google credentials and ignore the endpoint
 * entirely, which fails at index time with "No embedding-capable provider found" even though the
 * panel shows a reachable server. Worth saying out loud, because the contradiction is invisible.
 */
export function embeddingProblem(config: { provider: string; baseUrl?: string; model?: string; dimensions?: number }): string | undefined {
  const configured = !!config.baseUrl && !!config.model;
  if (config.provider !== "custom") {
    return configured
      ? `provider is "${config.provider}", so the endpoint below is ignored: indexing will look for ollama, openai or google credentials instead`
      : `provider is "${config.provider}": indexing needs ollama, openai or google credentials, or an endpoint of your own`;
  }
  if (!configured) return "no embedding endpoint or model is set";
  if (!config.dimensions) return "no dimension count is set; the indexer needs one that matches the model";
  return undefined;
}

/** What to write when an embedding model is picked: the endpoint, the key when it needs one. */
export function embeddingBlock(choice: EmbeddingChoice, sources: { localUrl: string; router?: { baseUrl?: string; apiKey?: string } }) {
  const fromRouter = choice.source === "router";
  return {
    embeddingProvider: "custom",
    customProvider: {
      baseUrl: fromRouter ? sources.router?.baseUrl : sources.localUrl,
      model: choice.id,
      dimensions: choice.dimensions,
      ...(fromRouter && sources.router?.apiKey ? { apiKey: sources.router.apiKey } : {}),
    },
  };
}

// ---------- the agent's own documentation as a knowledge base ----------
/**
 * pi ships its documentation on disk in both layouts: `pi/docs` inside a release bundle, and
 * `node_modules/@earendil-works/pi-coding-agent/docs` in a checkout. Indexing it answers questions
 * about hooks, settings and the extension API from the index instead of from grep.
 */
export const piDocsCandidates = (root: string): string[] => [
  `${root}/pi/docs`,
  `${root}/node_modules/@earendil-works/pi-coding-agent/docs`,
];

/** A knowledge base that points at some version's pi docs, ours or an older install's. */
export const isPiDocsPath = (path: string) => /(^|\/)(pi\/docs|pi-coding-agent\/docs)\/?$/.test(path);

/**
 * A bundle's path carries its version, so a stored knowledge base goes stale on every upgrade.
 * Given what is stored and where the docs are now, say what to add and what to drop.
 */
export function docsKnowledgeBaseUpdate(existing: string[], current: string | undefined): { add?: string; remove: string[] } {
  const normalise = (p: string) => p.replace(/\/+$/, "");
  const stored = existing.map(normalise);
  const now = current ? normalise(current) : undefined;
  return {
    add: now && !stored.includes(now) ? now : undefined,
    remove: stored.filter((p) => isPiDocsPath(p) && p !== now),
  };
}

// ---------- editable settings ----------
export type FieldKind = "url" | "model" | "dimensions" | "number" | "bool" | "choice" | "rerank-model";
export type Field = { path: string[]; label: string; kind: FieldKind; choices?: string[]; min?: number; max?: number; help: string };

/**
 * The settings /index can edit. Only keys the shipped package actually reads (verified against its
 * bundle) are here; `scope`, `ignore` and the external `reranker` are left to hand-editing because
 * they need judgement the dialog cannot supply.
 */
export const FIELDS: Field[] = [
  { path: ["customProvider", "baseUrl"], label: "Embedding server", kind: "url", help: "OpenAI-compatible endpoint; LM Studio serves one on http://localhost:1234/v1" },
  { path: ["customProvider", "model"], label: "Embedding model", kind: "model", help: "picked from the models the server reports" },
  { path: ["customProvider", "dimensions"], label: "Dimensions", kind: "dimensions", min: 8, max: 8192, help: "must match the model; wrong values corrupt search silently" },
  { path: ["embeddingProvider"], label: "Provider", kind: "choice", choices: ["custom", "auto", "ollama", "openai", "google", "cohere"], help: "custom = the server above; the others need their own credentials" },
  { path: ["indexing", "autoIndex"], label: "Index automatically", kind: "bool", help: "off keeps indexing an explicit request" },
  { path: ["indexing", "watchFiles"], label: "Watch files", kind: "bool", help: "keeps the index current as files change" },
  { path: ["indexing", "semanticOnly"], label: "Semantic only", kind: "bool", help: "off blends keyword (BM25) with embeddings" },
  { path: ["search", "maxResults"], label: "Max results", kind: "number", min: 1, max: 200, help: "how many chunks a search may return" },
  { path: ["search", "minScore"], label: "Min score", kind: "number", min: 0, max: 1, help: "drops weak matches; raise it when results are noisy" },
  { path: ["search", "fusionStrategy"], label: "Fusion", kind: "choice", choices: ["rrf", "weighted"], help: "how semantic and keyword candidates are combined" },
  { path: ["search", "rerankTopN"], label: "Rerank top N", kind: "number", min: 0, max: 200, help: "candidates reranked before the cut" },
  { path: ["reranker", "enabled"], label: "Reranking", kind: "bool", help: "a second pass that reorders results; runs on the LiteLLM router and is billed to its key" },
  { path: ["reranker", "model"], label: "Rerank model", kind: "rerank-model", help: "the router's rerank deployments, e.g. voyage/rerank-3-lite" },
];

/**
 * Reranking is wired to the LiteLLM router only: the endpoint and key come from the environment the
 * agent already has, so the dialog asks for nothing but the model. Cohere and Jina are supported by
 * the package and can still be set by hand in the config file; they are not offered here.
 */
export type Router = { baseUrl?: string; apiKey?: string };
export const routerFromEnv = (env: Record<string, string | undefined>): Router => ({
  baseUrl: env.LITELLM_BASE_URL?.replace(/\/+$/, ""),
  apiKey: env.LITELLM_AGENT_KEY || env.LITELLM_API_KEY,
});

/** The reranker block for a chosen model, complete and ready for the package to read. */
export const rerankerBlock = (router: Router, model: string) => ({ enabled: true, provider: "custom", baseUrl: router.baseUrl, model, apiKey: router.apiKey });

/** What is missing, in the package's terms, so a search does not fail silently later. */
export function rerankerProblem(config: Record<string, any>, router: Router = { baseUrl: "set", apiKey: "set" }): string | undefined {
  const r = (config as any).reranker;
  if (!r?.enabled) return undefined;
  if ((r.provider ?? "custom") !== "custom") return undefined;      // hand-configured hosted provider
  if (!router.baseUrl || !router.apiKey) return "reranking needs the LiteLLM router; run /setup to add its URL and key";
  if (!r.model) return "reranking is on but no rerank model is chosen";
  if (!r.baseUrl || !r.apiKey) return "the rerank endpoint or key is missing from the config";
  return undefined;
}

/**
 * Turn reranking on (with a model from the router) or off (keeping the model for next time). One
 * place for the rule, so the /index dialog and the web admin cannot disagree about it.
 */
export function setReranking(config: Record<string, any>, enabled: boolean, router: Router, model?: string): { config?: Record<string, any>; error?: string } {
  if (!enabled) return { config: setAt(config, ["reranker", "enabled"], false) };
  if (!router.baseUrl || !router.apiKey) return { error: "Reranking runs on the LiteLLM router; run /setup to add its URL and key first." };
  const chosen = (model ?? (config as any).reranker?.model ?? "").trim();
  if (!chosen) return { error: "Pick a rerank model to turn reranking on." };
  return { config: { ...config, reranker: rerankerBlock(router, chosen) } };
}

/** Apply a picked embedding model once its dimension count is known: endpoint, model, size, key. */
export function applyEmbeddingChoice(config: Record<string, any>, choice: EmbeddingChoice, sources: { localUrl: string; router?: Router }, dimensions: number | undefined): { config?: Record<string, any>; error?: string } {
  const block = embeddingBlock(choice, sources);
  if (!block.customProvider.baseUrl) return { error: choice.source === "router" ? "The router URL is not set; add it under connections first." : "No local server URL is set." };
  const size = block.customProvider.dimensions ?? dimensions;
  if (!size || !Number.isInteger(size) || size < 8) return { error: `${choice.id} did not answer an embeddings call, so its dimension count is unknown. Set it by hand if you know it.` };
  return { config: { ...config, ...block, customProvider: { ...block.customProvider, dimensions: size } } };
}

/** Keep a stored block in step with the environment, so rotating the router key just works. */
export function refreshRouterKey(config: Record<string, any>, router: Router): Record<string, any> | undefined {
  const r = (config as any).reranker;
  if (!r?.enabled || (r.provider ?? "custom") !== "custom" || !router.baseUrl || !router.apiKey) return undefined;
  if (r.baseUrl === router.baseUrl && r.apiKey === router.apiKey) return undefined;
  return { ...config, reranker: { ...r, baseUrl: router.baseUrl, apiKey: router.apiKey } };
}

export const getAt = (obj: any, path: string[]): unknown => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
/** Returns a copy; unknown keys elsewhere in the file are preserved by the caller's spread. */
export function setAt<T extends Record<string, any>>(obj: T, path: string[], value: unknown): T {
  const out: any = { ...obj };
  let node = out;
  for (const key of path.slice(0, -1)) { node[key] = { ...(node[key] ?? {}) }; node = node[key]; }
  node[path.at(-1)!] = value;
  return out;
}

const show = (v: unknown) => (v === undefined ? "—" : typeof v === "boolean" ? (v ? "on" : "off") : String(v));
/** A key is never shown in full, only that one is set and its last four characters. */
export const maskSecret = (v: unknown) => (typeof v === "string" && v.trim() ? `set (…${v.trim().slice(-4)})` : "—");
/** Picker row: label and current value. */
export function fieldRow(f: Field, config: Record<string, any>): string {
  const value = getAt(config, f.path);
  return `${f.label.padEnd(18)} ${show(value)}`;
}

/** Validate and coerce one edit. Returns the new config, or a message saying why not. */
export function applyEdit(config: Record<string, any>, f: Field, raw: string | boolean | number): { config?: Record<string, any>; error?: string } {
  if (f.kind === "bool") return { config: setAt(config, f.path, typeof raw === "boolean" ? raw : String(raw) === "on") };
  const text = String(raw).trim();
  if (!text) return { error: `${f.label} cannot be empty` };
  if (f.kind === "choice") {
    if (!f.choices?.includes(text)) return { error: `${f.label} must be one of ${f.choices?.join(", ")}` };
    return { config: setAt(config, f.path, text) };
  }
  if (f.kind === "url") {
    if (!/^https?:\/\//.test(text)) return { error: "the server must be an http(s) URL" };
    return { config: setAt(config, f.path, text.replace(/\/+$/, "")) };
  }
  if (f.kind === "number" || f.kind === "dimensions") {
    const n = Number(text);
    if (!Number.isFinite(n)) return { error: `${f.label} must be a number` };
    if (f.min !== undefined && n < f.min) return { error: `${f.label} must be at least ${f.min}` };
    if (f.max !== undefined && n > f.max) return { error: `${f.label} must be at most ${f.max}` };
    if (f.kind === "dimensions" && !Number.isInteger(n)) return { error: "dimensions must be a whole number" };
    return { config: setAt(config, f.path, n) };
  }
  return { config: setAt(config, f.path, text) };   // model id
}

/**
 * Changing how text is embedded invalidates the vectors already stored. Reranking is a query-time
 * pass over results, so nothing there touches the index.
 */
export const invalidatesIndex = (f: Field) =>
  f.path[0] === "embeddingProvider" || (f.path[0] === "customProvider" && ["model", "dimensions", "baseUrl"].includes(f.path[1]));

/** A config object holding only what the dialog manages, for writing a fresh file. */
export function configFromView(view: ConfigView): Record<string, any> {
  return {
    embeddingProvider: view.provider,
    customProvider: { baseUrl: view.baseUrl, model: view.model, dimensions: view.dimensions },
    indexing: { autoIndex: view.autoIndex, watchFiles: view.watchFiles },
    search: { maxResults: view.maxResults, minScore: view.minScore, fusionStrategy: view.fusion },
  };
}
