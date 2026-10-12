/**
 * Semantic codebase search: loads open-codebase-index in-process (including inside release bundles,
 * where pi's own package loader cannot — see lib.ts), seeds its embedding defaults so a fresh
 * install indexes with the local model instead of a cloud key, and adds the TUI the package has no
 * slash commands for.
 *
 *   /index            panel (index state, embeddings, search settings, config) plus an action picker
 *   /index status | update | reindex | estimate | health | metrics | logs | bases | off
 *
 *   KERNAL_NO_CODEBASE_INDEX=1  do not load it
 *   KERNAL_INDEX_CONFIG         config path to seed (tests)
 *   KERNAL_EMBEDDING_MODEL, KERNAL_EMBEDDING_DIMENSIONS
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { busServe, renderPanel } from "../connect/lib.ts";
import { env } from "../_shared/env.ts";
import {
  FIELDS, PACKAGE, SUBCOMMANDS, actions, applyEdit, configFromView, configView, defaultConfig, fieldRow, getAt, indexStatusLine,
  applyEmbeddingChoice, docsKnowledgeBaseUpdate, embeddingChoiceLabel, embeddingProblem, hiddenSourceDirs, invalidatesIndex, loadPlan, maskSecret, panelRows, parseEmbeddingChoice, parseStatus, piDocsCandidates, refreshRouterKey, rerankerBlock, rerankerProblem, resultText, routerFromEnv, shouldSeed,
  setReranking,
  type ConfigView, type EmbeddingChoice, type Embeddings, type Field, type IndexStatus, type LoadPlan, type PanelData,
} from "./lib.ts";

/** Injection seam: tests supply the package instead of loading 2 MB of bundled indexer. */
export type Deps = { plan?: LoadPlan; load?: (entry: string, kind: LoadPlan["kind"]) => Promise<any> };

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const distDir = () => join(agentDir(), "npm", "node_modules", PACKAGE, "dist");
/** Where this install keeps pi's documentation: a bundle's pi/docs, or the checkout's node_modules. */
export const piDocsDir = () => piDocsCandidates(dirname(agentDir())).find((p) => existsSync(p));
export const configPath = () => env("INDEX_CONFIG") || join(homedir(), ".config", "codebase-index", "config.json");
export const read = (f: string) => { try { return existsSync(f) ? readFileSync(f, "utf8") : undefined; } catch { return undefined; } };

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

/** The project's own config file, which overrides the user's for the keys it declares. */
export const projectConfigPath = (cwd: string) => join(cwd, ".codebase-index", "config.json");

/** The two layers the package merges, as configView reads them. */
export function currentView(cwd: string): ConfigView {
  const project = projectConfigPath(cwd);
  return configView([
    { file: project, scope: "project", text: read(project) },
    { file: configPath(), scope: "user", text: read(configPath()) },
  ], process.env);
}

/**
 * Where edits go: always the user's file. A project file replaces whole top-level blocks (all of
 * `search`, all of `customProvider`), so writing one field there would silently drop the user's
 * other settings in that block. A project file is created only on purpose ("Copy these settings into
 * this project"), and projectOverrides says which edited fields it shadows.
 */
export function settingsFile(_cwd: string): string {
  return configPath();
}

/** Top-level blocks the project's own config declares, which win over the user's for this repo. */
export function projectOverrides(cwd: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(read(projectConfigPath(cwd)) ?? "{}");
    return parsed && typeof parsed === "object" ? Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== "knowledgeBases")) : {};
  } catch { return {}; }
}

/** Written 0600 when it holds a key: the package reads reranker.apiKey from this file, in plaintext. */
export function writeConfig(file: string, config: Record<string, any>) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  if (config?.reranker?.apiKey || config?.customProvider?.apiKey) { try { chmodSync(file, 0o600); } catch {} }
}

/** The file's object, or (no file yet) what is in effect, so a first write starts from it. */
export function readConfigObject(file: string, view: ConfigView): Record<string, any> {
  const text = read(file);
  if (text) { try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object") return parsed; } catch {} }
  return configFromView(view);
}

/** Does the embedding server answer, and does it list the configured model? */
export async function probeEmbeddings(baseUrl: string | undefined, model: string | undefined): Promise<Embeddings | undefined> {
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

/** Embedding-capable models the server reports; LM Studio types them, plain OpenAI servers do not. */
export async function embeddingModels(baseUrl: string): Promise<string[]> {
  const root = baseUrl.replace(/\/v1\/?$/, "");
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000);
    const native = await fetch(`${root}/api/v0/models`, { signal: ctl.signal }).catch(() => undefined);
    if (native?.ok) {
      clearTimeout(t);
      return [...new Set(((await native.json())?.data ?? []).filter((m: any) => m.type === "embeddings").map((m: any) => String(m.id)))].sort() as string[];
    }
    const res = await fetch(`${baseUrl}/models`, { signal: ctl.signal });
    clearTimeout(t);
    return res.ok ? [...new Set(((await res.json())?.data ?? []).map((m: any) => String(m.id)))].sort() as string[] : [];
  } catch { return []; }
}

/** Embedding deployments the router advertises, with the vector size it declares when it does. */
export async function routerEmbeddingModels(baseUrl: string, apiKey: string): Promise<EmbeddingChoice[]> {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, "")}/model/info`, { headers: { authorization: `Bearer ${apiKey}` }, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    const seen = new Map<string, EmbeddingChoice>();
    for (const m of (await res.json())?.data ?? []) {
      if (m?.model_info?.mode !== "embedding") continue;
      const id = String(m.model_name);
      const dimensions = typeof m.model_info.output_vector_size === "number" ? m.model_info.output_vector_size : undefined;
      if (!seen.has(id) || (dimensions && !seen.get(id)!.dimensions)) seen.set(id, { source: "router", id, dimensions });
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch { return []; }
}

/** Ask the server for one embedding and count it: the only reliable source for the dimension. */
export async function detectDimensions(baseUrl: string, model: string, apiKey = "lm-studio"): Promise<number | undefined> {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20_000);
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: "dimension probe" }),
    });
    clearTimeout(t);
    if (!res.ok) return undefined;
    const vector = (await res.json())?.data?.[0]?.embedding;
    return Array.isArray(vector) && vector.length ? vector.length : undefined;
  } catch { return undefined; }
}

/** Rerank models a LiteLLM-style router advertises (mode "rerank"); empty for anything else. */
export async function rerankModels(baseUrl: string, apiKey: string): Promise<string[]> {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, "")}/model/info`, { headers: { authorization: `Bearer ${apiKey}` }, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    // A router can carry several deployments behind one alias, so the same name comes back twice.
    return [...new Set(((await res.json())?.data ?? [])
      .filter((m: any) => m?.model_info?.mode === "rerank")
      .map((m: any) => String(m.model_name)))].sort() as string[];
  } catch { return []; }
}

/** Tracked paths, so the panel can tell real source from build output; empty outside a git repo. */
function trackedFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("git", ["ls-files"], { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 5000, encoding: "utf8" }, (err, out) => resolve(err ? [] : out.split("\n")));
  });
}

export default async function (pi: ExtensionAPI, deps: Deps = {}) {
  if (env("NO_CODEBASE_INDEX")) return;
  const prebundledPath = join(distDir(), "pi-extension.kernal.cjs");
  const sourcePath = join(distDir(), "pi-extension.js");
  const plan = deps.plan ?? loadPlan({ prebundled: existsSync(prebundledPath), source: existsSync(sourcePath), isBun: !!process.versions.bun, prebundledPath, sourcePath });
  if (plan.kind === "none") return;
  const seeded = seedConfig();

  // The package registers tools and no commands. Keep a handle on each tool as it is registered so
  // /index can drive the same code the model does, instead of reimplementing any of it.
  const tools = new Map<string, any>();
  /** Set while an index run is in flight, so the status line and panel can show progress. */
  let watching: { stop: () => void } | undefined;

  /**
   * Indexing a large repository takes minutes and the package reports progress only when asked, so a
   * run the model started looked like nothing happening at all. Wrap the tool: while it runs, poll
   * index_status and push progress into the status line and the panel, whoever called it.
   */
  function watchProgress(ctx: any) {
    if (watching || !ctx?.ui?.setStatus) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const status = parseStatus(resultText(await tools.get("index_status")?.execute("kernal-progress", {}, undefined, undefined, ctx)));
        if (!stopped) { ctx.ui.setStatus("index", indexStatusLine(status)); if (panelOpen) showPanelStatus(ctx, status); }
      } catch {}
      if (!stopped) timer = setTimeout(tick, 2000);
    };
    let timer = setTimeout(tick, 400);
    watching = { stop: () => { stopped = true; clearTimeout(timer); watching = undefined; } };
  }

  let panelOpen = false;
  /** Re-render just the progress line of an open panel, without re-reading everything else. */
  function showPanelStatus(ctx: any, status: IndexStatus) {
    if (!lastPanel) return;
    lastPanel = { ...lastPanel, status };
    const data = lastPanel;
    ctx.ui.setWidget("codebase-index", (_tui: any, theme: any) => ({
      render: (width: number) => renderPanel(panelRows(data), width, (c: string, t: string) => theme.fg(c as any, t), " codebase index ").map((l: string) => truncateToWidth(l, width)),
      invalidate() {},
    }), { placement: "aboveEditor" });
  }
  let lastPanel: PanelData | undefined;

  const withCapture = new Proxy(pi, {
    get(target, prop, recv) {
      if (prop === "registerTool") return (tool: any) => {
        const wrapped = tool.name === "index_codebase"
          ? { ...tool, execute: async (id: string, params: any, signal: any, update: any, ctx: any) => {
              watchProgress(ctx);
              try { return await tool.execute(id, params, signal, update, ctx); }
              finally {
                watching?.stop();
                try {
                  const status = parseStatus(resultText(await tools.get("index_status")?.execute("kernal-done", {}, undefined, undefined, ctx)));
                  ctx?.ui?.setStatus?.("index", indexStatusLine(status));
                  if (panelOpen) showPanelStatus(ctx, status);
                } catch {}
              }
            } }
          : tool;
        tools.set(tool.name, wrapped);
        return (target as any).registerTool(wrapped);
      };
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
    process.stderr.write(`kernal: codebase index unavailable (${e?.message ?? e})\n`);
    return;
  }

  const run = async (name: string, params: Record<string, unknown>, ctx: ExtensionCommandContext): Promise<string> => {
    const tool = tools.get(name);
    if (!tool) return `${name} is not available`;
    try { return resultText(await tool.execute(`kernal-index-${Date.now()}`, params, ctx.signal, undefined, ctx)); }
    catch (e: any) { return `${name} failed: ${e?.message ?? e}`; }
  };
  const status = async (ctx: ExtensionCommandContext): Promise<IndexStatus> => parseStatus(await run("index_status", {}, ctx));
  const setStatusLine = (ctx: ExtensionCommandContext, s: IndexStatus) => ctx.ui.setStatus("index", indexStatusLine(s));

  async function collect(ctx: ExtensionCommandContext): Promise<PanelData> {
    const s = await status(ctx);
    const view = currentView(ctx.cwd);
    const [embeddings, basesText, tracked] = await Promise.all([probeEmbeddings(view.baseUrl, view.model), run("knowledge_base_list", {}, ctx), trackedFiles(ctx.cwd)]);
    const listed = basesText.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/") || l.startsWith("~"));
    const knowledgeBases = listed.length ? listed : view.knowledgeBases;
    const docsPath = piDocsDir();
    const staleBases = knowledgeBases.filter((k) => !existsSync(k));
    return {
      status: s, config: view, embeddings, knowledgeBases, staleBases, toolCount: tools.size, project: ctx.cwd,
      hidden: hiddenSourceDirs(tracked, knowledgeBases),
      docs: { path: docsPath, indexed: !!docsPath && knowledgeBases.some((k) => k.replace(/\/+$/, "") === docsPath) },
    };
  }

  function showPanel(ctx: ExtensionCommandContext, data: PanelData) {
    panelOpen = true;
    lastPanel = data;
    const rows = panelRows(data);
    ctx.ui.setWidget("codebase-index", (_tui, theme) => ({
      render: (width: number) => renderPanel(rows, width, (c, t) => theme.fg(c as any, t), " codebase index ").map((l) => truncateToWidth(l, width)),
      invalidate() {},
    }), { placement: "aboveEditor" });
    setStatusLine(ctx, data.status);
  }

  /** The router's rerank deployments, live; typing an id stays possible if the list is empty. */
  async function pickRerankModel(ctx: ExtensionCommandContext, router: { baseUrl?: string; apiKey?: string }, current: string): Promise<string | undefined> {
    const listed = await rerankModels(router.baseUrl!, router.apiKey!);
    const answer = await ctx.ui.select(listed.length ? "Rerank model on the router" : "The router lists no rerank models; type an id", [...listed, "type another id"]);
    if (answer === undefined) return undefined;
    if (answer !== "type another id") return answer;
    const typed = await ctx.ui.input("Rerank model id", current);
    return typed?.trim() || undefined;
  }


  /** Field picker → edit → write → offer the rebuild that a changed embedding needs. */
  async function editSettings(ctx: ExtensionCommandContext, data: PanelData): Promise<boolean> {
    let view = data.config;
    let file = settingsFile(ctx.cwd);
    let config = readConfigObject(file, view);
    let touched = false;
    for (;;) {
      const rows = FIELDS.map((f) => fieldRow(f, config));
      const projectFile = join(ctx.cwd, ".codebase-index", "config.json");
      const extra = file === projectFile ? [] : ["Copy these settings into this project"];
      const pick = await ctx.ui.select(`Codebase index settings  (${file})`, [...rows, ...extra, "Back"]);
      if (pick === undefined || pick === "Back") return touched;
      if (pick === "Copy these settings into this project") {
        writeConfig(projectFile, config);
        ctx.ui.notify(`Wrote ${projectFile}. This project now overrides your user settings.`, "info");
        file = projectFile; touched = true; continue;
      }
      const field = FIELDS[rows.indexOf(pick)];
      if (!field) continue;
      const current = getAt(config, field.path);
      let raw: string | boolean | undefined;
      if (field.path[0] === "reranker" && field.kind === "bool") {
        const answer = await ctx.ui.select(`${field.label} — ${field.help}`, ["on", "off"]);
        if (answer === undefined) continue;
        const router = routerFromEnv(process.env);
        if (answer === "off") { config = setReranking(config, false, router).config!; writeConfig(file, config); touched = true; ctx.ui.notify("Reranking off", "info"); continue; }
        if (!router.baseUrl || !router.apiKey) { ctx.ui.notify(setReranking(config, true, router).error!, "error"); continue; }
        const model = await pickRerankModel(ctx, router, String(getAt(config, ["reranker", "model"]) ?? ""));
        if (!model) continue;
        const on = setReranking(config, true, router, model);
        if (on.error) { ctx.ui.notify(on.error, "error"); continue; }
        config = on.config!;
        writeConfig(file, config);
        touched = true;
        ctx.ui.notify(`Reranking on with ${model}. Result snippets go to the router and its upstream provider, billed to the router key (${maskSecret(router.apiKey)}), which is stored in ${file} (owner-only).`, "warning");
        continue;
      }
      if (field.kind === "bool") {
        const answer = await ctx.ui.select(`${field.label} — ${field.help}`, ["on", "off"]);
        if (answer === undefined) continue;
        raw = answer === "on";
      } else if (field.kind === "choice") {
        const answer = await ctx.ui.select(`${field.label} — ${field.help}`, field.choices!);
        if (answer === undefined) continue;
        raw = answer;
      } else if (field.kind === "model") {
        // Two sources: the local server, and the LiteLLM router's embedding deployments. Picking one
        // writes the endpoint, the dimensions and (for the router) the key, because a model from the
        // wrong endpoint or with the wrong dimension count fails in ways that are hard to read.
        const localUrl = String(getAt(config, ["customProvider", "baseUrl"]) ?? "") || "http://localhost:1234/v1";
        const router = routerFromEnv(process.env);
        const [local, hosted] = await Promise.all([
          embeddingModels(localUrl).then((ids) => ids.map((id) => ({ source: "local" as const, id }))),
          router.baseUrl && router.apiKey ? routerEmbeddingModels(router.baseUrl, router.apiKey) : Promise.resolve([]),
        ]);
        const choices: EmbeddingChoice[] = [...local, ...hosted];
        if (!choices.length) {
          const typed = await ctx.ui.input(`${field.label} id (no server reachable)`, String(current ?? ""));
          if (typed === undefined || !typed.trim()) continue;
          raw = typed.trim();
        } else {
          const labels = choices.map(embeddingChoiceLabel);
          const answer = await ctx.ui.select(`${field.label} — local server and router deployments`, [...labels, "type another id"]);
          if (answer === undefined) continue;
          if (answer === "type another id") {
            const typed = await ctx.ui.input(`${field.label} id`, String(current ?? ""));
            if (typed === undefined || !typed.trim()) continue;
            raw = typed.trim();
          } else {
            const choice = parseEmbeddingChoice(answer, choices)!;
            let dimensions = choice.dimensions;
            if (!dimensions) {
              ctx.ui.setStatus("index", "⌕ measuring embedding…");
              dimensions = await detectDimensions(choice.source === "router" ? router.baseUrl! : localUrl, choice.id, choice.source === "router" ? router.apiKey : undefined);
            }
            const picked = applyEmbeddingChoice(config, choice, { localUrl, router }, dimensions);
            if (picked.error) { ctx.ui.notify(picked.error, "error"); continue; }
            config = picked.config!;
            dimensions = config.customProvider.dimensions;
            writeConfig(file, config);
            touched = true;
            ctx.ui.notify(`Embeddings → ${choice.source === "router" ? "router" : "local server"} ${choice.id} at ${dimensions} dimensions  (saved to ${file})`, "info");
            if (data.status.indexed) {
              const rebuild = await ctx.ui.select("A different embedding model means the stored vectors no longer match. Rebuild the index now?", ["Rebuild now", "Later"]);
              if (rebuild === "Rebuild now") { ctx.ui.setStatus("index", "⌕ rebuilding…"); ctx.ui.notify(await run("index_codebase", { force: true }, ctx), "info"); }
              else ctx.ui.notify("Search will stay stale until the index is rebuilt (/index reindex).", "warning");
            }
            continue;
          }
        }
      } else if (field.kind === "dimensions") {
        const answer = await ctx.ui.select(`${field.label} — ${field.help}`, ["Detect from the server", "Type a number"]);
        if (answer === undefined) continue;
        if (answer.startsWith("Detect")) {
          ctx.ui.setStatus("index", "⌕ measuring embedding…");
          const detected = await detectDimensions(String(getAt(config, ["customProvider", "baseUrl"]) ?? ""), String(getAt(config, ["customProvider", "model"]) ?? ""));
          if (detected === undefined) { ctx.ui.notify("Could not measure the embedding: is the server up and the model available?", "error"); continue; }
          raw = String(detected);
          ctx.ui.notify(`${getAt(config, ["customProvider", "model"])} returns ${detected} dimensions`, "info");
        } else {
          const typed = await ctx.ui.input(`${field.label}`, String(current ?? ""));
          if (typed === undefined) continue;
          raw = typed;
        }
      } else if (field.kind === "rerank-model") {
        const router = routerFromEnv(process.env);
        if (!router.baseUrl || !router.apiKey) { ctx.ui.notify("Reranking runs on the LiteLLM router; run /setup to add its URL and key first.", "error"); continue; }
        const model = await pickRerankModel(ctx, router, String(current ?? ""));
        if (!model) continue;
        config = setReranking(config, true, router, model).config!;   // endpoint and key come from the environment
        writeConfig(file, config);
        touched = true;
        ctx.ui.notify(`Rerank model → ${model}  (saved to ${file})`, "info");
        continue;
      } else {
        const typed = await ctx.ui.input(`${field.label} — ${field.help}`, String(current ?? ""));
        if (typed === undefined) continue;
        raw = typed;
      }
      const edit = applyEdit(config, field, raw as any);
      if (edit.error) { ctx.ui.notify(edit.error, "error"); continue; }
      if (String(getAt(edit.config!, field.path)) === String(current)) continue;   // nothing changed
      config = edit.config!;
      writeConfig(file, config);
      touched = true;
      const shown = field.kind === "secret" ? maskSecret(getAt(config, field.path)) : String(getAt(config, field.path));
      ctx.ui.notify(`${field.label} → ${shown}  (saved to ${file})`, "info");
      const problem = rerankerProblem(config);
      if (problem) ctx.ui.notify(`${problem}; reranking stays off until that is set`, "warning");
      const embedding = embeddingProblem({ provider: String(getAt(config, ["embeddingProvider"]) ?? "auto"), baseUrl: getAt(config, ["customProvider", "baseUrl"]) as string, model: getAt(config, ["customProvider", "model"]) as string, dimensions: getAt(config, ["customProvider", "dimensions"]) as number });
      if (embedding) ctx.ui.notify(`Embeddings: ${embedding}`, "warning");
      if (invalidatesIndex(field) && data.status.indexed) {
        const rebuild = await ctx.ui.select("That changes how text is embedded, so the stored vectors no longer match. Rebuild the index now?", ["Rebuild now", "Later"]);
        if (rebuild === "Rebuild now") {
          ctx.ui.setStatus("index", "⌕ rebuilding…");
          ctx.ui.notify(await run("index_codebase", { force: true }, ctx), "info");
        } else ctx.ui.notify("Search will stay stale until the index is rebuilt (/index reindex).", "warning");
      }
    }
  }

  pi.registerCommand("index", {
    description: "Codebase index panel: state, embeddings, settings; reindex and knowledge bases (/index off hides it)",
    getArgumentCompletions: (prefix) => Object.keys(SUBCOMMANDS).filter((k) => k && k.startsWith(prefix.trim())).map((k) => ({ value: k, label: k })),
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      const known = SUBCOMMANDS[sub];
      if (!known) { ctx.ui.notify(`Unknown /index option "${sub}". Try: ${Object.keys(SUBCOMMANDS).filter(Boolean).join(", ")}`, "error"); return; }
      if (known.kind === "off") { panelOpen = false; ctx.ui.setWidget("codebase-index", undefined); ctx.ui.setStatus("index", undefined); return; }
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
        const list = actions(data.status, data.hidden, data.docs);
        const pick = await ctx.ui.select("Codebase index", list.map((a) => a.label));
        if (pick === undefined) return;                       // Escape leaves the panel up
        const action = list[list.map((a) => a.label).indexOf(pick)];
        if (action.kind === "close") { panelOpen = false; ctx.ui.setWidget("codebase-index", undefined); return; }
        if (action.kind === "settings") await editSettings(ctx, data);
        if (action.kind === "kb-docs") {
          // A bundle path carries its version, so an upgrade leaves the old entry pointing at nothing:
          // drop any pi-docs entry that is not this install's before adding the current one.
          const plan = docsKnowledgeBaseUpdate(data.knowledgeBases ?? [], data.docs?.path);
          for (const gone of plan.remove) ctx.ui.notify(await run("knowledge_base_remove", { path: gone }, ctx), "info");
          if (plan.add) ctx.ui.notify(await run("knowledge_base_add", { path: plan.add }, ctx), "info");
          else if (!plan.remove.length) ctx.ui.notify("The agent's documentation is already indexed for this version.", "info");
          if (plan.add || plan.remove.length) {
            const go = await ctx.ui.select("pi's documentation is about 2.7 MB of Markdown; indexing it takes a minute on the local embedder. Index now?", ["Index now", "Later"]);
            if (go === "Index now") { ctx.ui.setStatus("index", "⌕ indexing docs…"); ctx.ui.notify(await run("index_codebase", {}, ctx), "info"); }
          }
        } else if (action.kind === "kb-hidden") {
          const choice = await ctx.ui.select("Directories the index skips (dot-directories are never walked, whatever include rules say)", (data.hidden ?? []).map((h) => `${h.dir}  (${h.files} files)`));
          if (choice === undefined) continue;
          const dir = choice.split("  (")[0];
          ctx.ui.notify(await run("knowledge_base_add", { path: join(ctx.cwd, dir) }, ctx), "info");
          const rebuild = await ctx.ui.select(`${dir} is added. Index it now?`, ["Index now", "Later"]);
          if (rebuild === "Index now") { ctx.ui.setStatus("index", "⌕ indexing…"); ctx.ui.notify(await run("index_codebase", {}, ctx), "info"); }
        } else if (action.kind === "kb-add" || action.kind === "kb-remove") {
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

  // /admin asks here for what only this closure knows: the index state and the tools that change it.
  let rebuilding: Promise<unknown> | undefined;
  busServe((pi as any).events, "kernal:index", async (req: { op: string; ctx?: any }) => {
    const ctx = req?.ctx;
    if (!ctx) throw new Error("no session yet");
    if (req.op === "status") {
      const [s, basesText] = await Promise.all([status(ctx), run("knowledge_base_list", {}, ctx)]);
      const bases = basesText.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/") || l.startsWith("~"));
      return { status: s, knowledgeBases: bases, toolCount: tools.size, rebuilding: !!rebuilding };
    }
    if (req.op === "rebuild" || req.op === "update") {
      if (rebuilding) return { started: false, already: true };
      // Minutes on a large repo: start it and answer now; progress shows through status.
      rebuilding = run("index_codebase", req.op === "rebuild" ? { force: true } : {}, ctx).finally(() => { rebuilding = undefined; });
      return { started: true };
    }
    throw new Error(`unknown op ${req.op}`);
  });

  // Rotating the router key should not require a visit to the dialog.
  try {
    const file = configPath();
    const text = read(file);
    if (text) {
      const refreshed = refreshRouterKey(JSON.parse(text), routerFromEnv(process.env));
      if (refreshed) { writeFileSync(file, `${JSON.stringify(refreshed, null, 2)}\n`); chmodSync(file, 0o600); }
    }
  } catch {}

  // The progress watcher polls with the session's ctx: it ends with that session.
  pi.on("session_shutdown", async () => { watching?.stop(); });
  pi.on("session_start", async (_e, ctx) => {
    if (!ctx.hasUI) return;
    if (seeded) ctx.ui.notify(`Codebase search ready; embeddings come from your local model server (${seeded}). /index shows the panel.`, "info");
    // Cheap enough to do once, and it makes the state visible without being asked.
    try { setStatusLine(ctx as any, await status(ctx as any)); } catch {}
  });
}
