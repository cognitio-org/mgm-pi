/**
 * Semantic codebase search: loads open-codebase-index in-process (including inside release bundles,
 * where pi's own package loader cannot — see lib.ts), seeds its embedding defaults so a fresh
 * install indexes with the local model instead of a cloud key, and adds the TUI the package has no
 * slash commands for.
 *
 *   /index            panel (index state, embeddings, search settings, config) plus an action picker
 *   /index status | update | reindex | estimate | health | metrics | logs | bases | off
 *
 *   MGM_NO_CODEBASE_INDEX=1  do not load it
 *   MGM_INDEX_CONFIG         config path to seed (tests)
 *   MGM_EMBEDDING_MODEL, MGM_EMBEDDING_DIMENSIONS
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderPanel } from "../connect/lib.ts";
import {
  PACKAGE, SUBCOMMANDS, actions, configView, defaultConfig, indexStatusLine, loadPlan, panelRows, parseStatus, resultText, shouldSeed,
  type Embeddings, type IndexStatus, type LoadPlan, type PanelData,
} from "./lib.ts";

/** Injection seam: tests supply the package instead of loading 2 MB of bundled indexer. */
export type Deps = { plan?: LoadPlan; load?: (entry: string, kind: LoadPlan["kind"]) => Promise<any> };

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const distDir = () => join(agentDir(), "npm", "node_modules", PACKAGE, "dist");
export const configPath = () => process.env.MGM_INDEX_CONFIG || join(homedir(), ".config", "codebase-index", "config.json");
const read = (f: string) => { try { return existsSync(f) ? readFileSync(f, "utf8") : undefined; } catch { return undefined; } };

/** Returns the path when it wrote one, else undefined. */
export function seedConfig(): string | undefined {
  const file = configPath();
  if (!shouldSeed(read(file))) return undefined;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(defaultConfig(process.env), null, 2)}\n`);
    return file;
  } catch { return undefined; }
}

/** Does the embedding server answer, and does it list the configured model? */
async function probeEmbeddings(baseUrl: string | undefined, model: string | undefined): Promise<Embeddings | undefined> {
  if (!baseUrl) return undefined;
  const root = baseUrl.replace(/\/v1\/?$/, "");
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
    // LM Studio's native endpoint also reports whether a model is resident; fall back to /v1/models.
    const native = await fetch(`${root}/api/v0/models`, { signal: ctl.signal }).catch(() => undefined);
    const res = native?.ok ? native : await fetch(`${baseUrl}/models`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return { reachable: false };
    const data = (await res.json())?.data ?? [];
    const entry = data.find((m: any) => String(m.id) === model);
    return { reachable: true, loaded: entry?.state === undefined ? undefined : entry.state === "loaded" };
  } catch { return { reachable: false }; }
}

export default async function (pi: ExtensionAPI, deps: Deps = {}) {
  if (process.env.MGM_NO_CODEBASE_INDEX) return;
  const prebundledPath = join(distDir(), "pi-extension.mgm.cjs");
  const sourcePath = join(distDir(), "pi-extension.js");
  const plan = deps.plan ?? loadPlan({ prebundled: existsSync(prebundledPath), source: existsSync(sourcePath), isBun: !!process.versions.bun, prebundledPath, sourcePath });
  if (plan.kind === "none") return;
  const seeded = seedConfig();

  // The package registers tools and no commands. Keep a handle on each tool as it is registered so
  // /index can drive the same code the model does, instead of reimplementing any of it.
  const tools = new Map<string, any>();
  const withCapture = new Proxy(pi, {
    get(target, prop, recv) {
      if (prop === "registerTool") return (tool: any) => { tools.set(tool.name, tool); return (target as any).registerTool(tool); };
      const value = Reflect.get(target, prop, recv);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExtensionAPI;

  try {
    const mod = deps.load
      ? await deps.load(plan.entry, plan.kind)
      : plan.kind === "prebundled"
        ? createRequire(plan.entry)(plan.entry)        // require base = the package, for its native addon
        : await import(plan.entry);
    await (mod.default ?? mod)(withCapture);
  } catch (e: any) {
    process.stderr.write(`mgm: codebase index unavailable (${e?.message ?? e})\n`);
    return;
  }

  const run = async (name: string, params: Record<string, unknown>, ctx: ExtensionCommandContext): Promise<string> => {
    const tool = tools.get(name);
    if (!tool) return `${name} is not available`;
    try { return resultText(await tool.execute(`mgm-index-${Date.now()}`, params, ctx.signal, undefined, ctx)); }
    catch (e: any) { return `${name} failed: ${e?.message ?? e}`; }
  };
  const status = async (ctx: ExtensionCommandContext): Promise<IndexStatus> => parseStatus(await run("index_status", {}, ctx));
  const setStatusLine = (ctx: ExtensionCommandContext, s: IndexStatus) => ctx.ui.setStatus("index", indexStatusLine(s));

  async function collect(ctx: ExtensionCommandContext): Promise<PanelData> {
    const s = await status(ctx);
    const view = configView([
      { file: join(ctx.cwd, ".codebase-index", "config.json"), scope: "project", text: read(join(ctx.cwd, ".codebase-index", "config.json")) },
      { file: configPath(), scope: "user", text: read(configPath()) },
    ], process.env);
    const [embeddings, basesText] = await Promise.all([probeEmbeddings(view.baseUrl, view.model), run("knowledge_base_list", {}, ctx)]);
    const knowledgeBases = basesText.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/") || l.startsWith("~"));
    return { status: s, config: view, embeddings, knowledgeBases, toolCount: tools.size, project: ctx.cwd };
  }

  function showPanel(ctx: ExtensionCommandContext, data: PanelData) {
    const rows = panelRows(data);
    ctx.ui.setWidget("codebase-index", (_tui, theme) => ({
      render: (width: number) => renderPanel(rows, width, (c, t) => theme.fg(c as any, t), " codebase index ").map((l) => truncateToWidth(l, width)),
      invalidate() {},
    }), { placement: "aboveEditor" });
    setStatusLine(ctx, data.status);
  }

  pi.registerCommand("index", {
    description: "Codebase index panel: state, embeddings, settings; reindex and knowledge bases (/index off hides it)",
    getArgumentCompletions: (prefix) => Object.keys(SUBCOMMANDS).filter((k) => k && k.startsWith(prefix.trim())).map((k) => ({ value: k, label: k })),
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      const known = SUBCOMMANDS[sub];
      if (!known) { ctx.ui.notify(`Unknown /index option "${sub}". Try: ${Object.keys(SUBCOMMANDS).filter(Boolean).join(", ")}`, "error"); return; }
      if (known.kind === "off") { ctx.ui.setWidget("codebase-index", undefined); ctx.ui.setStatus("index", undefined); return; }
      if (known.tool) {
        ctx.ui.setStatus("index", `⌕ ${sub}…`);
        const text = await run(known.tool, known.params ?? {}, ctx);
        ctx.ui.notify(text.slice(0, 4000) || `${sub}: no output`, "info");
        setStatusLine(ctx, await status(ctx));
        return;
      }
      if (!ctx.hasUI) { const s = await status(ctx); ctx.ui.notify(s.raw, "info"); return; }

      ctx.ui.setStatus("index", "⌕ reading…");
      let data = await collect(ctx);
      showPanel(ctx, data);
      for (;;) {
        const list = actions(data.status);
        const pick = await ctx.ui.select("Codebase index", list.map((a) => a.label));
        if (pick === undefined) return;                       // Escape leaves the panel up
        const action = list[list.map((a) => a.label).indexOf(pick)];
        if (action.kind === "close") { ctx.ui.setWidget("codebase-index", undefined); return; }
        if (action.kind === "kb-add" || action.kind === "kb-remove") {
          const path = await ctx.ui.input(action.kind === "kb-add" ? "Directory to index as a knowledge base" : "Knowledge base directory to remove", "");
          if (path === undefined || !path.trim()) continue;
          ctx.ui.notify(await run(action.kind === "kb-add" ? "knowledge_base_add" : "knowledge_base_remove", { path: path.trim() }, ctx), "info");
        } else if (action.tool) {
          ctx.ui.setStatus("index", "⌕ working…");
          const text = await run(action.tool, action.params ?? {}, ctx);
          if (text.trim()) ctx.ui.notify(text.slice(0, 4000), "info");
        }
        data = await collect(ctx);
        showPanel(ctx, data);
      }
    },
  });

  pi.on("session_start", async (_e, ctx) => {
    if (!ctx.hasUI) return;
    if (seeded) ctx.ui.notify(`Codebase search ready; embeddings come from your local model server (${seeded}). /index shows the panel.`, "info");
    // Cheap enough to do once, and it makes the state visible without being asked.
    try { setStatusLine(ctx as any, await status(ctx as any)); } catch {}
  });
}
