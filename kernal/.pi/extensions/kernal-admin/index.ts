/**
 * /admin — a local web admin for kernal: status, connections, model, codebase index, subagents,
 * GitHub, and tapes (kernal-tape/admin.ts: review, pin and play cloud tapes; memory settings).
 *
 *   /admin          start the server (if it is not running) and open the page in the browser
 *   /admin index    ...opened at one page (overview, connections, model, index, subagents)
 *   /admin status   where it is and when it stops
 *   /admin stop     stop it now
 *
 *   KERNAL_ADMIN_IDLE_MINUTES   stop after this long without use (default 15)
 *   KERNAL_NO_BROWSER=1         print the link instead of opening it
 *
 * One source of truth: every read and write goes through the code the TUI already uses. Keys and
 * URLs through connect (writeEnvValues, normalizeBaseUrl, cleanKey, testConnection), and providers are
 * re-registered by asking connect over pi's event bus, as /setup does. Index settings through
 * kernal-codebase-index (FIELDS, applyEdit, setReranking, applyEmbeddingChoice, writeConfig), and the
 * index state by asking that extension over the bus. Security notes are in server.ts.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { backends, busRequest, cleanKey, normalizeBaseUrl, parseLmStudioModels, rootUrl, type Bus } from "../connect/lib.ts";
import { envFilePath, getJson, loadEnv, settingsPath, testConnection, writeEnvValues } from "../connect/index.ts";
import {
  applyEdit, applyEmbeddingChoice, embeddingBaseUrl, embeddingProblem, getAt, invalidatesIndex, refreshRouterKey, rerankerProblem, routerFromEnv, setReranking,
  type EmbeddingChoice, type IndexStatus,
} from "../kernal-codebase-index/lib.ts";
import {
  configPath, currentView, detectDimensions, embeddingModels, probeEmbeddings, projectConfigPath, projectOverrides, read, readConfigObject, rerankModels, routerEmbeddingModels, settingsFile, writeConfig,
} from "../kernal-codebase-index/index.ts";
import { openInBrowser } from "../kernal-context/index.ts";
import { markdownToHtml } from "../kernal-context/report.ts";
import {
  AgentError, MAX_PROMPT, PI_TOOLS, THINKING_LEVELS, customiseAgent, deleteAgent, modelSettings, readAgent, resolvedView, saveAgent, saveModelSettings, snapshot, validateEdit, validateModelSettings,
  type AgentEdit, type Snapshot,
} from "./subagents.ts";
import { authState, findGh, installGh, kernalBin, loginCommand, missingScopes, setupGitCommand } from "../kernal-github/gh.ts";
import { attributionFrom, repoStatus } from "../kernal-github/lib.ts";
import { readSettings, updateSettings } from "../connect/settings.ts";
import { APP_CSS, APP_JS, FAVICON, INDEX_HTML } from "./app.ts";
import { backendPill, connectionsView, fieldById, idleMs, indexFields, leaksSecret, redactSecrets, secretValues, validateConnections, type ConnectionEdit } from "./lib.ts";
import { startAdminServer, type AdminServer, type Api, type ApiResult } from "./server.ts";
import { env } from "../_shared/env.ts";
import { createTapeApi, type TapeAdminDeps } from "../kernal-tape/admin.ts";
import { npmRunner, tapeDir } from "../kernal-tape/lib.ts";
import { adminTransport } from "../outfitter-admin/transport.ts";

export const ASSETS = {
  "/index.html": { type: "text/html; charset=utf-8", body: INDEX_HTML },
  "/app.css": { type: "text/css; charset=utf-8", body: APP_CSS },
  "/app.js": { type: "text/javascript; charset=utf-8", body: APP_JS },
  "/favicon.svg": { type: "image/svg+xml", body: FAVICON },
};

/** Pages `/admin <page>` can open directly. */
const PAGES = ["overview", "connections", "model", "index", "subagents", "github", "tapes"];

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(process.env.HOME ?? "", ".pi", "agent");
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
const safe = <T>(f: () => T): T | undefined => { try { return f(); } catch { return undefined; } };
const fail = (status: number, body: Record<string, unknown>): ApiResult => ({ status, body });

type ConnState = { id: string; label: string; baseUrl: string; hasKey: boolean; registered: boolean; answered: boolean; rejected?: string; models: string[] };
type IndexState = { status: IndexStatus; knowledgeBases: string[]; toolCount: number; rebuilding: boolean };

export type ApiDeps = { pi: ExtensionAPI; ctx: () => ExtensionContext | undefined; server: () => AdminServer | undefined; stop: () => void; tapes?: TapeAdminDeps };

/** The Tapes page's deps for this process: the laptop's Dongle (never a Drive's socket). */
function tapeDeps(cwd: () => string): TapeAdminDeps {
  const t = adminTransport();
  return { dir: tapeDir(), transport: t?.kind === "laptop" ? t : undefined, run: npmRunner, cwd };
}

/** The routes. Separate from the server so tests can drive them with a fake pi. */
export function createApi(d: ApiDeps): Api {
  const bus = (d.pi as any).events as Bus | undefined;
  const cwd = () => d.ctx()?.cwd ?? process.cwd();
  const env = () => loadEnv(process.cwd());
  const connections = async () => ((await busRequest<ConnState[]>(bus, "kernal:connect", { op: "state" }, 10_000).catch(() => undefined)) ?? []);
  const withPill = (b: ConnState) => ({ ...b, ...backendPill(b) });
  const indexState = async (): Promise<IndexState | undefined> => {
    const ctx = d.ctx();
    if (!ctx) return undefined;
    return busRequest<IndexState>(bus, "kernal:index", { op: "status", ctx }, 20_000).catch(() => undefined);
  };
  const secrets = () => secretValues({ ...loadEnv(process.cwd()), ...process.env });
  /** provider/id of every model the connected providers list now. */
  const liveModels = async () => new Set((await connections()).filter((b) => b.registered).flatMap((b) => b.models.map((m) => `${b.id}/${m}`)));
  const modelWarnings = (asked: unknown[], live: Set<string>) => live.size ? asked.filter((m): m is string => typeof m === "string" && !!m && !live.has(m)).map((m) => `${m} is not listed by any connected provider right now; saved anyway`) : [];
  /** Agent writes need the session's model registry (the package warns about unknown models with it). */
  const agentWrite = async (f: (ctx: ExtensionContext) => Promise<any>): Promise<ApiResult> => {
    const ctx = d.ctx();
    if (!ctx) return fail(409, { error: "no session yet" });
    try { return { body: await f(ctx) }; }
    catch (e: any) { return e instanceof AgentError ? fail(e.status, { error: e.message, errors: e.errors }) : fail(500, { error: String(e?.message ?? e).slice(0, 300) }); }
  };
  const shortName = (id: string) => ({ lmstudio: "Local server", litellm: "Router", openrouter: "OpenRouter" } as Record<string, string>)[id] ?? id;

  const routes: Record<string, (body: any, query: URLSearchParams) => Promise<ApiResult>> = {
    "GET /ping": async () => {
      const s = d.server();
      return { body: { idleRemaining: s?.idleRemaining() ?? 0, idleMs: s?.idleMs ?? 0, startedAt: s?.startedAt } };
    },

    "GET /overview": async () => {
      const ctx = d.ctx();
      const m = ctx?.model;
      const [conns, ix] = await Promise.all([connections(), indexState()]);
      const versionFile = join(dirname(agentDir()), "VERSION");
      return { body: {
        model: m ? { provider: m.provider, id: m.id, contextWindow: (m as any).contextWindow } : undefined,
        thinking: safe(() => d.pi.getThinkingLevel()),
        usage: safe(() => ctx?.getContextUsage()),
        cwd: cwd(), agentDir: agentDir(), envFile: envFilePath(),
        versions: {
          kernal: existsSync(versionFile) ? readFileSync(versionFile, "utf8").split("\n")[0].trim() : "source checkout",
          pi: PI_VERSION,
          runtime: process.versions.bun ? `bun ${process.versions.bun} (pi's compiled binary)` : `node ${process.versions.node}`,
        },
        connections: conns.map((b) => ({ id: b.id, name: shortName(b.id), ...backendPill(b) })),
        index: ix ? { loaded: true, indexed: ix.status.indexed, chunks: ix.status.chunks, branch: ix.status.branch, running: ix.status.running || ix.rebuilding } : { loaded: false },
      } };
    },

    // ---------- connections ----------
    "GET /connections": async () => ({ body: { values: connectionsView(env()), backends: (await connections()).map(withPill), envFile: envFilePath() } }),

    "POST /connections": async (body: ConnectionEdit) => {
      const { values, errors, warnings } = validateConnections(body);
      if (Object.keys(errors).length) return fail(422, { error: "some fields need fixing", errors, warnings });
      if (!Object.keys(values).length) return { body: { message: "Nothing to save", warnings } };
      const before = env();
      const file = writeEnvValues(values);
      for (const k of Object.keys(values)) if (values[k] === "") delete process.env[k];
      // As /setup does: re-register every provider from the new values, live.
      const state = (await busRequest<ConnState[]>(bus, "kernal:connect", { op: "reload" }, 30_000).catch(() => undefined)) ?? [];
      // The reranker keeps its own copy of the router URL and key; bring it along, as start-up does.
      try {
        const text = read(configPath());
        const refreshed = text ? refreshRouterKey(JSON.parse(text), routerFromEnv(process.env)) : undefined;
        if (refreshed) writeConfig(configPath(), refreshed);
      } catch {}
      const notes: string[] = [];
      if ("KERNAL_USER" in values && values.KERNAL_USER !== (before.KERNAL_USER ?? "")) notes.push("Your name shows in the banner from the next start.");
      for (const b of state) if (b.rejected) notes.push(`${shortName(b.id)} rejected the key (${b.rejected}).`);
      const ready = state.filter((b) => b.registered).map((b) => shortName(b.id));
      return { body: {
        message: `Saved ${Object.keys(values).length} setting${Object.keys(values).length === 1 ? "" : "s"} to ${file}. ${state.length ? `Connected: ${ready.join(", ") || "none"}.` : "Restart kernal to reconnect."}`,
        saved: Object.keys(values), warnings, notes, backends: state.map(withPill),
      } };
    },

    "POST /connections/test": async (body: { backend?: string; baseUrl?: string; apiKey?: string }) => {
      const b = backends(env(), new Map()).find((x) => x.id === body.backend);
      if (!b) return fail(400, { error: "unknown backend" });
      const url = typeof body.baseUrl === "string" && body.baseUrl.trim() ? normalizeBaseUrl(body.baseUrl, b.baseUrl) : b.baseUrl;
      const key = typeof body.apiKey === "string" && body.apiKey.trim() ? cleanKey(body.apiKey) : b.apiKey;
      return { body: await testConnection({ id: b.id, baseUrl: url, apiKey: key }) };
    },

    "GET /connections/local-models": async (_b, q) => {
      const url = normalizeBaseUrl(q.get("url") ?? "", backends(env(), new Map())[0].baseUrl);
      const native = await getJson(`${rootUrl(url)}/api/v0/models`, "lm-studio", 3000);
      const ids = native ? [...parseLmStudioModels(native).keys()] : ((await getJson(`${url}/models`, "lm-studio", 3000))?.data ?? []).map((m: any) => String(m.id));
      return { body: { models: ids.filter((id: string) => !/embed/i.test(id)).sort() } };
    },

    // ---------- model ----------
    "GET /models": async () => {
      const ctx = d.ctx();
      const settings = readJson(settingsPath()) ?? {};
      const m = ctx?.model;
      return { body: {
        current: m ? { provider: m.provider, id: m.id } : undefined,
        default: settings.defaultProvider ? { provider: settings.defaultProvider, model: settings.defaultModel } : undefined,
        thinking: safe(() => d.pi.getThinkingLevel()),
        providers: (await connections()).map((b) => ({ ...withPill(b), models: b.registered ? b.models : [] })),
      } };
    },

    "POST /model": async (body: { provider?: string; id?: string }) => {
      if (typeof body.provider !== "string" || typeof body.id !== "string") return fail(400, { error: "provider and id are required" });
      const ctx = d.ctx();
      if (!ctx) return fail(409, { error: "no session yet" });
      try {
        const r = await busRequest(bus, "kernal:connect", { op: "select", ctx, provider: body.provider, model: body.id }, 20_000);
        if (r === undefined) return fail(503, { error: "the connect extension is not loaded" });
        return { body: { provider: body.provider, id: body.id, savedAsDefault: true } };
      } catch (e: any) { return fail(422, { error: e.message }); }
    },

    // ---------- codebase index ----------
    "GET /index": async () => {
      const view = currentView(cwd());
      const file = settingsFile(cwd());
      const config = readConfigObject(file, view);
      const overrides = projectOverrides(cwd());
      const router = routerFromEnv(process.env);
      const provider = { provider: String(getAt(config, ["embeddingProvider"]) ?? "auto"), baseUrl: getAt(config, ["customProvider", "baseUrl"]) as string | undefined, model: getAt(config, ["customProvider", "model"]) as string | undefined, dimensions: getAt(config, ["customProvider", "dimensions"]) as number | undefined };
      const onRouter = !!provider.baseUrl && !!router.baseUrl && provider.baseUrl.replace(/\/+$/, "") === normalizeBaseUrl(router.baseUrl, "");
      const [ix, embeddings] = await Promise.all([indexState(), onRouter ? Promise.resolve({ reachable: true, onRouter: true }) : probeEmbeddings(provider.baseUrl, provider.model)]);
      const problems = [embeddingProblem(provider), rerankerProblem(config, router)].filter(Boolean);
      return { body: {
        cwd: cwd(), file, scope: view.scope, files: view.files, problems, embeddings,
        // A project config replaces whole blocks, so a field it declares is shadowed for this repo.
        fields: indexFields(config).map((f) => (f.path[0] in overrides ? { ...f, project: { value: redactSecrets(getAt(overrides, f.path)) } } : f)),
        projectFile: Object.keys(overrides).length ? projectConfigPath(cwd()) : undefined, projectBlocks: Object.keys(overrides),
        loaded: !!ix, status: ix?.status, running: !!(ix?.status.running || ix?.rebuilding), knowledgeBases: ix?.knowledgeBases ?? view.knowledgeBases,
        routerConfigured: !!(router.baseUrl && router.apiKey),
      } };
    },

    "GET /index/status": async () => {
      const ix = await indexState();
      const view = currentView(cwd());
      return { body: { loaded: !!ix, status: ix?.status, running: !!(ix?.status.running || ix?.rebuilding), file: settingsFile(cwd()), scope: view.scope, knowledgeBases: ix?.knowledgeBases ?? view.knowledgeBases, problems: [] } };
    },

    "GET /index/choices": async () => {
      const router = routerFromEnv(process.env);
      const localUrl = embeddingBaseUrl(process.env);
      const routed = !!(router.baseUrl && router.apiKey);
      const [local, hosted, rerank] = await Promise.all([
        embeddingModels(localUrl).then((ids) => ids.map((id) => ({ source: "local" as const, id }))),
        routed ? routerEmbeddingModels(router.baseUrl!, router.apiKey!) : Promise.resolve([]),
        routed ? rerankModels(router.baseUrl!, router.apiKey!) : Promise.resolve([]),
      ]);
      return { body: { embedding: [...local, ...hosted], rerank, localUrl, routerConfigured: routed } };
    },

    "POST /index/detect": async (body: { baseUrl?: string; model?: string }) => {
      const view = currentView(cwd());
      const config = readConfigObject(settingsFile(cwd()), view);
      const baseUrl = String(body.baseUrl || getAt(config, ["customProvider", "baseUrl"]) || "");
      const model = String(body.model || getAt(config, ["customProvider", "model"]) || "");
      if (!/^https?:\/\//.test(baseUrl) || !model) return fail(422, { error: "set the embedding server and model first" });
      const router = routerFromEnv(process.env);
      const key = router.baseUrl && baseUrl.replace(/\/+$/, "") === router.baseUrl ? router.apiKey : undefined;
      const dimensions = await detectDimensions(baseUrl.replace(/\/+$/, ""), model, key);
      return dimensions ? { body: { dimensions } } : fail(422, { error: "Could not measure the embedding: is the server up and the model available?" });
    },

    "POST /index": async (body: { edits?: { id: string; value: unknown }[]; embedding?: { source: string; id: string; dimensions?: number }; reranking?: { enabled: boolean; model?: string } }) => {
      const c = cwd();
      const view = currentView(c);
      const file = settingsFile(c);
      let config = readConfigObject(file, view);
      const errors: Record<string, string> = {};
      const router = routerFromEnv(process.env);
      let reembed = false;

      if (body.embedding) {
        const e = body.embedding;
        if ((e.source !== "local" && e.source !== "router") || typeof e.id !== "string" || !e.id.trim()) errors["customProvider.model"] = "pick a model from the list";
        else {
          const choice: EmbeddingChoice = { source: e.source, id: e.id.trim(), dimensions: Number.isInteger(e.dimensions) ? e.dimensions : undefined };
          const localUrl = embeddingBaseUrl(process.env);
          const dims = choice.dimensions ?? await detectDimensions(choice.source === "router" ? (router.baseUrl ?? "") : localUrl, choice.id, choice.source === "router" ? router.apiKey : undefined);
          const picked = applyEmbeddingChoice(config, choice, { localUrl, router }, dims);
          if (picked.error) errors["customProvider.model"] = picked.error; else { config = picked.config!; reembed = true; }
        }
      }
      for (const edit of body.edits ?? []) {
        const field = fieldById(String(edit?.id));
        if (!field || field.path[0] === "reranker") { errors[String(edit?.id)] = "not a setting this page edits"; continue; }
        const before = getAt(config, field.path);
        const r = applyEdit(config, field, edit.value as any);
        if (r.error) { errors[field.path.join(".")] = r.error; continue; }
        config = r.config!;
        if (invalidatesIndex(field) && String(getAt(config, field.path)) !== String(before)) reembed = true;
      }
      if (body.reranking) {
        const r = setReranking(config, !!body.reranking.enabled, router, typeof body.reranking.model === "string" ? body.reranking.model : undefined);
        if (r.error) errors[body.reranking.enabled && !router.apiKey ? "reranker.enabled" : "reranker.model"] = r.error; else config = r.config!;
      }
      if (Object.keys(errors).length) return fail(422, { error: "nothing was saved", errors });

      writeConfig(file, config);
      const ix = await indexState();
      const notes: { kind: string; text: string }[] = [];
      if (reembed && ix?.status.indexed) notes.push({ kind: "warn", text: "The embedding changed, so the stored vectors no longer match. Search stays stale until you rebuild the index (Status, Rebuild from scratch)." });
      notes.push({ kind: "info", text: "Saved to your user settings. The indexer reads them when kernal starts, so restart kernal for search to use them." });
      const touched = new Set([...(body.edits ?? []).map((e) => String(e?.id).split(".")[0]), ...(body.embedding ? ["customProvider", "embeddingProvider"] : []), ...(body.reranking ? ["reranker"] : [])]);
      const shadowed = Object.keys(projectOverrides(c)).filter((k) => touched.has(k));
      if (shadowed.length) notes.push({ kind: "warn", text: `This repository's own ${projectConfigPath(c)} sets ${shadowed.join(", ")}, which wins here; your change applies to your other projects.` });
      const embedding = embeddingProblem({ provider: String(getAt(config, ["embeddingProvider"]) ?? "auto"), baseUrl: getAt(config, ["customProvider", "baseUrl"]) as string, model: getAt(config, ["customProvider", "model"]) as string, dimensions: getAt(config, ["customProvider", "dimensions"]) as number });
      if (embedding) notes.push({ kind: "error", text: `Embeddings: ${embedding}` });
      if (config?.reranker?.enabled) notes.push({ kind: "info", text: "The router key is stored in the settings file (owner-only), because the indexer reads it from there." });
      return { body: { saved: true, file, notes, fields: indexFields(config) } };
    },

    "POST /index/run": async (body: { op?: string }) => {
      if (body.op !== "update" && body.op !== "rebuild") return fail(400, { error: "op is update or rebuild" });
      const ctx = d.ctx();
      if (!ctx) return fail(409, { error: "no session yet" });
      const r = await busRequest(bus, "kernal:index", { op: body.op, ctx }, 10_000).catch((e) => ({ error: e.message }));
      if (r === undefined) return fail(503, { error: "the indexer is not loaded" });
      if ((r as any).error) return fail(500, { error: (r as any).error });
      return { body: r };
    },

    // ---------- subagents: models (settings) and agent definitions (pi-subagents' own code) ----------
    "GET /subagents": async () => {
      const ctx = d.ctx();
      let snap: Snapshot;
      try { snap = await snapshot(cwd(), ctx?.model?.provider, secrets()); }
      catch (e: any) { return { body: { settings: modelSettings(), unavailable: String(e?.message ?? e) } }; }
      // Tool names for the editor: pi's own, the running agent's (extensions included), and any an agent already names.
      const tools = new Map<string, string>();
      for (const t of PI_TOOLS) tools.set(t, "pi");
      for (const t of safe(() => d.pi.getAllTools()) ?? []) if (!tools.has(t.name)) tools.set(t.name, "loaded");
      for (const r of snap.rows) for (const t of r.tools ?? []) if (!tools.has(t)) tools.set(t, "named by an agent");
      const userDir = snap.dirs.user;
      const linked = safe(() => lstatSync(userDir).isSymbolicLink()) ?? false;
      return { body: {
        settings: modelSettings(), agents: snap.rows, diagnostics: snap.diagnostics, thinkingLevels: THINKING_LEVELS,
        tools: [...tools].map(([name, from]) => ({ name, from })),
        dirs: { user: userDir, userReal: linked ? safe(() => realpathSync(userDir)) : undefined, project: snap.dirs.project },
        checkout: !existsSync(join(dirname(agentDir()), "VERSION")),
      } };
    },

    "GET /subagents/agent": async (_b, q) => {
      const ctx = d.ctx();
      const snap = await snapshot(cwd(), ctx?.model?.provider, secrets());
      const a = await readAgent(snap, q.get("name") ?? "", q.get("source") ?? "", secrets());
      if (!a) return fail(404, { error: "no such agent" });
      if (a.withheld) return { body: { row: { ...a.row, description: "" }, withheld: true } };
      const override = modelSettings().overrides[a.row.name];
      return { body: { ...a, override: override ? { model: override.model, thinking: override.thinking } : undefined, resolved: resolvedView(snap, a.row.name) } };
    },

    "POST /subagents/agent": async (body: AgentEdit) => {
      const errors = validateEdit(body, secrets());
      if (Object.keys(errors).length) return fail(422, { error: "some fields need fixing", errors });
      return agentWrite(async (ctx) => {
        const r = await saveAgent(ctx, body, secrets());
        return { ...r, warnings: [...r.warnings, ...modelWarnings([body.model], await liveModels())] };
      });
    },

    "POST /subagents/customise": async (body: { name?: string; scope?: string }) =>
      agentWrite((ctx) => customiseAgent(ctx, String(body.name ?? ""), body.scope === "project" ? "project" : "user", secrets())),

    "POST /subagents/delete": async (body: { name?: string; scope?: string }) => {
      if (body.scope !== "user" && body.scope !== "project") return fail(400, { error: "scope is user or project" });
      return agentWrite((ctx) => deleteAgent(ctx, String(body.name ?? ""), body.scope as "user" | "project", secrets()));
    },

    "POST /subagents/settings": async (body: any) => {
      const errors = validateModelSettings(body);
      if (Object.keys(errors).length) return fail(422, { error: "some fields need fixing", errors });
      try {
        const { snap, file } = await saveModelSettings({ cwd: cwd(), model: d.ctx()?.model }, body, secrets());
        const asked = [body.defaultModel, ...Object.values<any>(body.overrides ?? {}).map((o) => o?.model)];
        return { body: { message: `Saved to ${file}. Subagents started from now on use these models.`, file, settings: modelSettings(), agents: snap.rows, warnings: modelWarnings(asked, await liveModels()) } };
      } catch (e: any) { return e instanceof AgentError ? fail(e.status, { error: e.message, errors: e.errors }) : fail(500, { error: String(e?.message ?? e) }); }
    },

    "POST /subagents/preview": async (body: { markdown?: unknown }) => {
      if (typeof body.markdown !== "string" || body.markdown.length > MAX_PROMPT) return fail(400, { error: "markdown is text up to the prompt limit" });
      return { body: { html: markdownToHtml(body.markdown) } };
    },

    // ---------- github: the CLI, the sign-in, and what this repository looks like ----------
    "GET /github": async () => {
      const gh = await findGh();
      const auth = gh ? await authState(gh.path) : undefined;
      const st = await repoStatus(cwd(), gh).catch(() => undefined);
      const name = gh?.managed ? gh.path : "gh";
      return { body: {
        cli: gh ? { path: gh.path, version: gh.version, managed: gh.managed } : undefined,
        binDir: kernalBin(),
        // `detail` is gh's own output: it can name a token, so it never reaches the page.
        auth: auth ? { signedIn: auth.signedIn, login: auth.login, scopes: auth.scopes, fromEnv: auth.fromEnv, gitConfigured: auth.gitConfigured, missingScopes: missingScopes(auth.scopes) } : undefined,
        commands: { login: loginCommand(name), setupGit: setupGitCommand(name) },
        repo: st?.repo ? { ...st.repo, branch: st.git.branch, upstream: st.git.upstream, clean: st.git.clean, ahead: st.git.ahead, behind: st.git.behind } : undefined,
        pr: st?.pr, prUnavailable: st?.prUnavailable,
        notARepo: st ? undefined : cwd(),
        attribution: attributionFrom(readSettings()),
      } };
    },

    "POST /github/install": async () => {
      const already = await findGh();
      if (already && !already.managed) return { body: { message: `gh ${already.version} is already installed at ${already.path}.` } };
      const res = await installGh();
      if (!res.ok) return fail(502, { error: res.detail });
      return { body: { message: `Installed gh ${res.version} in ${kernalBin()}.` } };
    },

    "POST /github/attribution": async (body: { commit?: unknown; pr?: unknown }) => {
      const errors: Record<string, string> = {};
      for (const k of ["commit", "pr"] as const) {
        if (body[k] === undefined) continue;
        if (typeof body[k] !== "string" || String(body[k]).length > 200) errors[k] = "text, up to 200 characters, or empty to turn it off";
        else if (leaksSecret(String(body[k]), secrets())) errors[k] = "that looks like it holds a key";
      }
      if (Object.keys(errors).length) return fail(422, { error: "some fields need fixing", errors });
      updateSettings((s: any) => {
        const g = (s.github && typeof s.github === "object" ? s.github : (s.github = {}));
        const a = (g.attribution && typeof g.attribution === "object" ? g.attribution : (g.attribution = {}));
        for (const k of ["commit", "pr"] as const) if (body[k] !== undefined) a[k] = String(body[k]);
      });
      return { body: { message: "Saved. New commits and pull requests use this.", attribution: attributionFrom(readSettings()) } };
    },

    "POST /stop": async () => { setTimeout(() => d.stop(), 50); return { body: { stopping: true } }; },

    // ---------- tapes: the same pin store and review as kernal --tape and /tape (kernal-tape) ----------
    ...createTapeApi(d.tapes ?? tapeDeps(cwd)),
  };

  return async (req) => {
    const route = routes[`${req.method} ${req.path}`];
    if (!route) return fail(404, { error: "no such endpoint" });
    return route(req.body ?? {}, req.query);
  };
}

export default function (pi: ExtensionAPI) {
  let server: AdminServer | undefined;
  let ctx: ExtensionContext | undefined;
  let lastCtx: ExtensionContext | undefined;   // for the idle notice
  const remember = (c: ExtensionContext | undefined) => { if (c) { ctx = c; lastCtx = c; } };
  pi.on("session_start", async (_e, c) => remember(c));
  pi.on("model_select", async (_e, c) => remember(c));
  pi.on("agent_end", async (_e, c) => remember(c));

  const stop = async (reason: string) => { const s = server; server = undefined; if (s && !s.stopped) await s.stop(reason); };
  pi.on("session_shutdown", async () => { await stop("exit"); });

  const api = createApi({ pi, ctx: () => ctx, server: () => server, stop: () => { void stop("stopped from the page"); } });
  const describe = (s: AdminServer) => `${s.url}  (local only; stops after ${Math.round(s.idleMs / 60000)} min without use, or /admin stop)`;

  pi.registerCommand("admin", {
    description: "Open kernal's web admin in the browser: status, connections, model, codebase index (/admin stop, /admin status)",
    getArgumentCompletions: (prefix) => [...PAGES, "status", "stop"].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
    handler: async (args, c: ExtensionCommandContext) => {
      remember(c);
      const sub = args.trim().toLowerCase();
      if (sub === "stop") {
        if (!server) { c.ui.notify("The admin server is not running.", "info"); return; }
        await stop("stopped");
        c.ui.notify("Admin server stopped.", "info");
        return;
      }
      if (sub === "status") {
        c.ui.notify(server ? `Admin running at ${describe(server)}; ${Math.ceil(server.idleRemaining() / 60000)} min until the idle stop.` : "The admin server is not running; /admin starts it.", "info");
        return;
      }
      if (sub && sub !== "open" && !PAGES.includes(sub)) { c.ui.notify(`Unknown /admin option "${sub}". Try: /admin [${PAGES.join(" | ")}], /admin status, /admin stop`, "error"); return; }

      if (!server || server.stopped) {
        const secrets = () => secretValues({ ...loadEnv(process.cwd()), ...process.env });
        server = await startAdminServer({
          api, assets: ASSETS, idleMs: idleMs(process.env),
          checkResponse: (text) => !leaksSecret(text, secrets()),
          onStop: (reason) => {
            server = undefined;
            try { lastCtx?.ui.setStatus("admin", undefined); } catch {}
            if (reason === "idle") try { lastCtx?.ui.notify("Admin server stopped after a while without use; /admin starts it again.", "info"); } catch {}
          },
        });
      }
      // The token travels in the fragment: the browser keeps it and never sends it to any server.
      const link = `${server.url}#t=${server.token}${PAGES.includes(sub) ? `&p=${sub}` : ""}`;
      const opened = env("NO_BROWSER") === "1" ? false : await openInBrowser(link);
      c.ui.setStatus("admin", `◍ admin :${server.port}`);
      c.ui.notify(`${opened ? "Opened the admin" : "Admin ready"}: ${link}\n${describe(server).replace(server.url, "").trim()}`, "info");
    },
  });
}
