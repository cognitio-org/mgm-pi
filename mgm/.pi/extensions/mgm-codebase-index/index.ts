/**
 * Semantic codebase search: loads open-codebase-index in-process, including inside release bundles
 * where pi's own package loader cannot (see lib.ts for why), and seeds its embedding defaults so a
 * fresh install indexes with the local model instead of asking for a cloud key.
 *
 * Tools it brings: codebase_context, codebase_peek, codebase_search, implementation_lookup,
 * find_similar, call_graph, call_graph_path, pr_impact, plus /index, /search and friends.
 *
 *   MGM_NO_CODEBASE_INDEX=1  do not load it
 *   MGM_INDEX_CONFIG         config path to seed (tests)
 *   MGM_EMBEDDING_MODEL, MGM_EMBEDDING_DIMENSIONS
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PACKAGE, defaultConfig, loadPlan, shouldSeed } from "./lib.ts";

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const distDir = () => join(agentDir(), "npm", "node_modules", PACKAGE, "dist");
export const configPath = () => process.env.MGM_INDEX_CONFIG || join(homedir(), ".config", "codebase-index", "config.json");

/** Returns the path when it wrote one, else undefined. */
export function seedConfig(): string | undefined {
  const file = configPath();
  let existing: string | undefined;
  try { existing = existsSync(file) ? readFileSync(file, "utf8") : undefined; } catch { return undefined; }
  if (!shouldSeed(existing)) return undefined;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(defaultConfig(process.env), null, 2)}\n`);
    return file;
  } catch { return undefined; }
}

export default async function (pi: ExtensionAPI) {
  if (process.env.MGM_NO_CODEBASE_INDEX) return;
  const prebundledPath = join(distDir(), "pi-extension.mgm.cjs");
  const sourcePath = join(distDir(), "pi-extension.js");
  const plan = loadPlan({ prebundled: existsSync(prebundledPath), source: existsSync(sourcePath), isBun: !!process.versions.bun, prebundledPath, sourcePath });
  if (plan.kind === "none") return;
  const seeded = seedConfig();
  try {
    const mod = plan.kind === "prebundled"
      ? createRequire(plan.entry)(plan.entry)          // require base = the package, for its native addon
      : await import(plan.entry);
    await (mod.default ?? mod)(pi);
  } catch (e: any) {
    process.stderr.write(`mgm: codebase index unavailable (${e?.message ?? e})\n`);
    return;
  }
  pi.on("session_start", async (_e, ctx) => {
    if (seeded && ctx.hasUI) ctx.ui.notify(`Codebase search ready; embeddings come from your local model server (${seeded}). Run /index to index this repo.`, "info");
  });
}
