/**
 * Score codebase_search configurations against docs/index-questions.json.
 *
 *   node --import ./tests/resolve-pi.mjs scripts/index-eval.mjs [config-name ...]
 *
 * Each question names the file that actually answers it; a configuration is scored by how often that
 * file comes back first (top1) and within the first three results (top3), plus the mean rank of the
 * first hit (misses count as one past the result limit). Embeddings are local and free; reranking
 * costs a few dozen tokens per query on the router.
 *
 * The user config is edited in place between configurations, because the package reads it from
 * ~/.config/codebase-index/config.json itself, and restored on exit — including on Ctrl-C.
 *
 * Each configuration runs in a child process on purpose. The indexer loads its config once when the
 * package initialises and keeps it; reusing one process made every configuration score identically,
 * which is how the first version of this script quietly measured nothing.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const questionsFile = join(root, "docs", "index-questions.json");
const { project, questions } = JSON.parse(readFileSync(questionsFile, "utf8"));
const userConfig = join(homedir(), ".config", "codebase-index", "config.json");
const backup = `${userConfig}.eval-backup`;

/** name → the search/reranker settings that configuration uses; undefined means the package default. */
const CONFIGS = {
  "baseline (defaults, no rerank)": { search: {}, rerank: false },
  "rerank on": { search: {}, rerank: true },
  "rerank 50→10": { search: { maxResults: 10, rerankTopN: 50 }, rerank: true },
  "rerank 100→10": { search: { maxResults: 10, rerankTopN: 100 }, rerank: true },
  "rerank 100→10, keyword-light": { search: { maxResults: 10, rerankTopN: 100, hybridWeight: 0.7 }, rerank: true },
  "rerank 100→10, keyword-heavy": { search: { maxResults: 10, rerankTopN: 100, hybridWeight: 0.3 }, rerank: true },
  "rerank 100→10, weighted fusion": { search: { maxResults: 10, rerankTopN: 100, fusionStrategy: "weighted" }, rerank: true },
  "no rerank, keyword-light": { search: { maxResults: 10, hybridWeight: 0.7 }, rerank: false },
  // The persistent misses are shell scripts. Two hypotheses: their chunks score below the 0.1 floor
  // and are cut before the reranker ever sees them, and the lite rerank model is the weaker one.
  "rerank on, no score floor": { search: { minScore: 0 }, rerank: true },
  "rerank-3 (full model)": { search: {}, rerank: true, model: "voyage/rerank-3" },
  "rerank-3, no score floor": { search: { minScore: 0 }, rerank: true, model: "voyage/rerank-3" },
  "rerank-3, no floor, 100 candidates": { search: { minScore: 0, rerankTopN: 100 }, rerank: true, model: "voyage/rerank-3" },
  "rerank-3, 100 candidates": { search: { rerankTopN: 100 }, rerank: true, model: "voyage/rerank-3" },
};

const base = JSON.parse(readFileSync(userConfig, "utf8"));
copyFileSync(userConfig, backup);
const restore = () => { if (existsSync(backup)) { copyFileSync(backup, userConfig); } };
process.on("SIGINT", () => { restore(); process.exit(130); });

function apply({ search, rerank, model }) {
  const next = structuredClone(base);
  next.search = { ...(base.search ?? {}), ...search };
  next.reranker = { ...(base.reranker ?? {}), enabled: rerank, ...(model ? { model } : {}) };
  writeFileSync(userConfig, `${JSON.stringify(next, null, 2)}\n`);
  return next.search.maxResults ?? 20;
}

/** Load the extension and hand back its search tool. Runs in the child, after the config is written. */
async function searchTool() {
  const { makePi, makeCtx } = await import(join(root, "tests", "harness.ts"));
  const tools = new Map();
  const pi = makePi();
  pi.registerTool = (t) => tools.set(t.name, t);
  const mod = await import(`${join(root, ".pi", "extensions", "kernal-codebase-index", "index.ts")}?eval=${Date.now()}`);
  await mod.default(pi, {});
  const ctx = makeCtx({ hasUI: false });
  ctx.cwd = project;
  return async (query, limit) => {
    const result = await tools.get("codebase_search").execute("eval", { query, limit }, undefined, undefined, ctx);
    const text = (result?.content ?? []).map((c) => c.text ?? "").join("\n");
    return text.split("\n").filter((l) => /^\[\d+\]/.test(l)).map((l) => l.match(/ in (\S+?):\d/)?.[1] ?? l);
  };
}

// ---------- child: measure one configuration against the current config file ----------
if (process.argv.includes("--child")) {
  const search = await searchTool();
  const limit = Number(process.argv[process.argv.indexOf("--limit") + 1]) || 20;
  const ranks = [];
  for (const { q, file } of questions) {
    const paths = await search(q, limit);
    ranks.push({ file, rank: paths.findIndex((p) => p.endsWith(file)) + 1 });
  }
  process.stdout.write(`\n__RESULT__${JSON.stringify(ranks)}`);
  process.exit(0);
}

// ---------- parent: write each configuration, run a child, collect ----------
const { spawnSync } = await import("node:child_process");
const MISS_PENALTY = 25;          // fixed, so configurations with different limits stay comparable

function runChild(limit) {
  const res = spawnSync(process.execPath, ["--import", join(root, "tests", "resolve-pi.mjs"), fileURLToPath(import.meta.url), "--child", "--limit", String(limit)], {
    cwd: root, encoding: "utf8", timeout: 600_000,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(root, ".pi") },
  });
  const marker = (res.stdout ?? "").lastIndexOf("__RESULT__");
  if (marker === -1) throw new Error(`child produced no result: ${(res.stderr || res.stdout || "").slice(-300)}`);
  return JSON.parse(res.stdout.slice(marker + "__RESULT__".length));
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const names = wanted.length ? Object.keys(CONFIGS).filter((n) => wanted.some((w) => n.includes(w))) : Object.keys(CONFIGS);
const rows = [];
try {
  for (const name of names) {
    const limit = apply(CONFIGS[name]);
    const ranks = runChild(limit);
    const top1 = ranks.filter((r) => r.rank === 1).length;
    const top3 = ranks.filter((r) => r.rank >= 1 && r.rank <= 3).length;
    const mrr = ranks.reduce((sum, r) => sum + (r.rank >= 1 ? 1 / r.rank : 0), 0) / ranks.length;
    const meanRank = ranks.reduce((sum, r) => sum + (r.rank >= 1 ? r.rank : MISS_PENALTY), 0) / ranks.length;
    const misses = ranks.filter((r) => r.rank < 1 || r.rank > 3).map((r) => `${r.file.split("/").pop()}${r.rank >= 1 ? `@${r.rank}` : "✗"}`);
    rows.push({ name, top1, top3, mrr, meanRank });
    console.log(`${name.padEnd(30)} top1 ${String(top1).padStart(2)}/${questions.length}  top3 ${String(top3).padStart(2)}/${questions.length}  MRR ${mrr.toFixed(3)}  mean rank ${meanRank.toFixed(1)}`);
    if (misses.length) console.log(`${" ".repeat(30)} misses: ${misses.join(" ")}`);
  }
} finally {
  restore();
  console.log(`\nrestored ${userConfig}`);
}
const best = [...rows].sort((a, b) => b.mrr - a.mrr || b.top3 - a.top3)[0];
if (best) console.log(`best: ${best.name} (top1 ${best.top1}/${questions.length}, top3 ${best.top3}/${questions.length}, MRR ${best.mrr.toFixed(3)})`);
