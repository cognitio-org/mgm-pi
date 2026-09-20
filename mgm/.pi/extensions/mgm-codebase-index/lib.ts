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
