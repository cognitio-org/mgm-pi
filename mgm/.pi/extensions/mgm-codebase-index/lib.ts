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
    customProvider: { baseUrl: embeddingBaseUrl(env), model: env.MGM_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL, dimensions: Number(env.MGM_EMBEDDING_DIMENSIONS) || DEFAULT_DIMENSIONS },
    indexing: { autoIndex: false, watchFiles: true, requireProjectMarker: true },
    search: { maxResults: 20, minScore: 0.1, fusionStrategy: "rrf" },
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
  raw: string;
};

/** index_status prints human-readable lines; read the few facts a panel needs, keep the rest as raw. */
export function parseStatus(text: string): IndexStatus {
  const line = (re: RegExp) => text.match(re)?.[1]?.trim();
  const chunks = line(/Indexed chunks[^:]*:\s*(\d+)/);
  return {
    indexed: !/is not indexed/i.test(text) && Number(chunks ?? 0) > 0,
    chunks: chunks === undefined ? undefined : Number(chunks),
    branch: line(/Current branch:\s*(.+)/),
    location: line(/Location:\s*(.+)/),
    autoIndex: line(/Auto-index:\s*(.+)/),
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
export type ConfigView = { file?: string; scope: "project" | "user" | "defaults"; provider: string; baseUrl?: string; model?: string; dimensions?: number; autoIndex?: unknown; watchFiles?: unknown; maxResults?: unknown; minScore?: unknown; fusion?: unknown };

/** The nearest config wins: a project's own file, else the user's, else the built-in defaults. */
export function configView(candidates: { file: string; scope: "project" | "user"; text?: string }[], env: Record<string, string | undefined>): ConfigView {
  for (const c of candidates) {
    if (c.text === undefined) continue;
    let parsed: any;
    try { parsed = JSON.parse(c.text); } catch { continue; }
    if (!parsed || typeof parsed !== "object") continue;
    return {
      file: c.file, scope: c.scope,
      provider: String(parsed.embeddingProvider ?? "auto"),
      baseUrl: parsed.customProvider?.baseUrl, model: parsed.customProvider?.model, dimensions: parsed.customProvider?.dimensions,
      autoIndex: parsed.indexing?.autoIndex, watchFiles: parsed.indexing?.watchFiles,
      maxResults: parsed.search?.maxResults, minScore: parsed.search?.minScore, fusion: parsed.search?.fusionStrategy,
    };
  }
  const d = defaultConfig(env);
  return { scope: "defaults", provider: d.embeddingProvider, baseUrl: d.customProvider!.baseUrl, model: d.customProvider!.model, dimensions: d.customProvider!.dimensions, autoIndex: d.indexing!.autoIndex, watchFiles: d.indexing!.watchFiles, maxResults: d.search!.maxResults, minScore: d.search!.minScore, fusion: d.search!.fusionStrategy };
}

// ---------- panel ----------
export type Seg = [string, string | null];
export type Embeddings = { reachable: boolean; loaded?: boolean; note?: string };
export type PanelData = { status: IndexStatus; config: ConfigView; embeddings?: Embeddings; knowledgeBases?: string[]; toolCount?: number; project: string };

const yesNo = (v: unknown) => (v === true ? "on" : v === false ? "off" : v === undefined ? "—" : String(v));
const label = (text: string): Seg => [text.padEnd(9), "muted"];   // one column, so values line up

export function panelRows(d: PanelData): Seg[][] {
  const s = d.status;
  const rows: Seg[][] = [];
  rows.push(s.indexed
    ? [label("index"), [`${s.chunks} chunks`, "success"], [`  branch ${s.branch ?? "—"}`, "dim"]]
    : [label("index"), ["not indexed", "warning"], ["  ask the agent to index this repo", "dim"]]);
  rows.push([label("project"), [d.project, "text"]]);
  if (s.location) rows.push([label("store"), [s.location, "dim"]]);
  const e = d.embeddings;
  const embedState: Seg = e === undefined ? ["—", "dim"] : e.reachable ? (e.loaded === false ? ["server up, model not loaded yet", "warning"] : ["ready", "success"]) : ["server unreachable", "error"];
  rows.push([label("embed"), [`${d.config.model ?? "?"} `, "accent"], [`${d.config.dimensions ?? "?"}d  `, "dim"], embedState]);
  rows.push([label(""), [`${d.config.provider} · ${d.config.baseUrl ?? "—"}`, "dim"]]);
  rows.push([label("search"), [`${yesNo(d.config.maxResults)} results · min score ${yesNo(d.config.minScore)} · ${yesNo(d.config.fusion)}`, "text"]]);
  rows.push([label("indexing"), [`auto ${yesNo(d.config.autoIndex)} · watch ${yesNo(d.config.watchFiles)}`, "text"], [s.autoIndex ? `  (${s.autoIndex})` : "", "dim"]]);
  rows.push([label("config"), [d.config.file ?? "built-in defaults", "dim"], [`  (${d.config.scope})`, "dim"]]);
  if (d.knowledgeBases !== undefined) rows.push([label("extra"), [d.knowledgeBases.length ? d.knowledgeBases.join(", ") : "no knowledge bases", d.knowledgeBases.length ? "text" : "dim"]]);
  if (d.toolCount) rows.push([label("tools"), [`${d.toolCount} available`, "dim"]]);
  return rows;
}

/** One-line status-bar entry. */
export function indexStatusLine(s: IndexStatus): string {
  return s.indexed ? `⌕ ${s.chunks} chunks` : "⌕ no index";
}

// ---------- actions ----------
export type Action = { label: string; tool?: string; params?: Record<string, unknown>; kind?: "refresh" | "close" | "kb-add" | "kb-remove" };
export function actions(s: IndexStatus): Action[] {
  return [
    { label: s.indexed ? "Update the index (changed files only)" : "Index this codebase now", tool: "index_codebase", params: {} },
    { label: "Rebuild from scratch", tool: "index_codebase", params: { force: true } },
    { label: "Estimate first (no writes)", tool: "index_codebase", params: { estimateOnly: true } },
    { label: "Health check", tool: "index_health_check", params: {} },
    { label: "Metrics", tool: "index_metrics", params: {} },
    { label: "Recent log", tool: "index_logs", params: { limit: 20 } },
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
