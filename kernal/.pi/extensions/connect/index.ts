/**
 * /connect — pick which backend pi talks to (lmstudio | litellm | openrouter) and
 * /budget — LiteLLM pricing, spend and budget panel.
 *
 *   /connect                      interactive picker (backend, then model)
 *   /connect litellm              pick a model on that backend
 *   /connect lmstudio <model-id>  switch directly
 *   /connect openrouter           ends with "Browse all OpenRouter models…" to add one to the list
 *   /budget [off]                 themed panel above the editor
 *
 * Backends are registered as pi providers at startup. LM Studio and LiteLLM models are discovered
 * live (LiteLLM via /model/info for prices and limits, falling back to /v1/models); OpenRouter uses
 * a curated list (OPENROUTER_MODELS overrides; central settings add and remove models, curation.ts).
 * The chosen backend/model is saved to the agent dir's settings.json; signed in, /connect also asks
 * whether it goes to the account (profile X) or only this machine (#437: model.provider/model.default
 * are central settings, which the next session starts on). Secrets come from ~/localllm/.env, ../.env
 * or ./.env (see README).
 * All pure logic lives in ./lib.ts and is unit-tested.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { env, inSandbox } from "../_shared/env.ts";
import { applyLaptopMcpGate } from "../_shared/mcp-gate.ts";
import { getRouterKey } from "../_shared/outfitter-session.ts";
import {
  type Backend, type ModelMeta, type LmStudioMeta, type LocalModelFact, backends, parseEnvText, parseModelInfo, lmStudioMeta, parseSpendHeaders, rootUrl, normalizeBaseUrl,
  sessionEstimate, money, footerStatus, budgetRows, renderPanel, cleanKey, keyCheckUrl, authFailureText, busServe, keepListed, curateOpenRouter,
  localHostFooter, localModelIdFromLabel, localModelLabel, localModelsFromHosts, mergeLitellmModels,
} from "./lib.ts";
import { canSaveToAccount, changeCuration, curationLists, type CurationTarget } from "./curation.ts";
import { settingsPath, updateSettings } from "./settings.ts";
import { noteOwnDefaultsWrite } from "../_shared/default-sync.ts";
import { clearLocalOverrides, describeSource, layerCentralEnv, reresolve, webOrigin, type ConfigValue } from "../_shared/central-config.ts";
import { loginState, outfitterApi } from "../_shared/outfitter-session.ts";
import { outfitterBearer, sendWithBearer } from "../_shared/outfitter-env.ts";
import { probeServer } from "../_shared/local-discovery.ts";
import { kernalHome, pidAlive, readLockPid, readState } from "../kernal-local/state.ts";

/** The .env that /setup writes: next to the agent dir (bundle root or the kernal/ checkout). */
export function envFilePath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  return agentDir ? join(agentDir, "..", ".env") : join(homedir(), "localllm", ".env");
}
export function upsertEnv(text: string, values: Record<string, string | undefined>): string {
  const lines = text ? text.split("\n") : [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/);
    if (m && m[1] in values) { seen.add(m[1]); return values[m[1]] === undefined ? line : `${m[1]}=${values[m[1]]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(values)) if (!seen.has(k) && v !== undefined) out.push(`${k}=${v}`);
  return out.join("\n").replace(/\n*$/, "\n");
}

/** Write values into the .env and the running process, as /setup does. Returns the file written. */
export function writeEnvValues(values: Record<string, string | undefined>): string {
  const file = envFilePath();
  let text = ""; try { text = readFileSync(file, "utf8"); } catch {}
  writeFileSync(file, upsertEnv(text, values));
  for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
  return file;
}

/** The env entries a registration depends on, as one comparable string (held in memory only). */
export function backendInputs(env: Record<string, string>): string {
  const names = ["LMSTUDIO_BASE_URL", "LMSTUDIO_MODEL", "LITELLM_BASE_URL", "LITELLM_AGENT_KEY", "LITELLM_API_KEY", "OPENROUTER_BASE_URL", "OPENROUTER_API_KEY", "OPENROUTER_MODELS"];
  return JSON.stringify(names.map((n) => env[n] ?? ""));
}

/** Every .env the agent reads, nearest last, with the process environment on top. */
export function loadEnv(cwd: string): Record<string, string> {
  let out: Record<string, string> = {};
  for (const f of [join(homedir(), "localllm", ".env"), envFilePath(), join(cwd, "..", ".env"), join(cwd, ".env")]) {
    if (existsSync(f)) out = { ...out, ...parseEnvText(readFileSync(f, "utf8")) };
  }
  // Signed in: the router's base URL, this device's router key and the account's provider keys
  // from the central settings (_shared/central-config.ts has the rules; a key set here still wins).
  return layerCentralEnv({ ...out, ...(process.env as Record<string, string>) });
}

export async function getJson(url: string, apiKey: string, timeoutMs = 4000): Promise<any | undefined> {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` }, signal: ctl.signal });
    clearTimeout(t);
    return res.ok ? await res.json() : undefined;
  } catch { return undefined; }
}

const reachable = new Set<string>();   // backends whose server answered discovery
const keyRejected = new Map<string, string>();   // backend id → why the provider refused its key (401/403)
const notListed = new Map<string, string[]>();   // backend id → curated model ids the provider no longer lists
let openrouterCatalogue: string[] = [];   // every id OpenRouter lists, for "Browse all" (#440)

/** Verify a key against the backend's cheapest authenticated endpoint; only a definite 401/403 counts. */
async function checkKey(b: Backend, timeoutMs = 5000): Promise<boolean> {
  const url = keyCheckUrl(b);
  // In a cloud sandbox the key was minted by the control plane for this run seconds ago; a bad one
  // still shows up as a 401 on the first prompt, so the extra round trip only delays start-up.
  if (!url || env("NO_DISCOVERY") || inSandbox()) return true;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { headers: { authorization: `Bearer ${b.apiKey}` }, signal: ctl.signal });
    clearTimeout(t);
    if (res.status === 401 || res.status === 403) { keyRejected.set(b.id, authFailureText(res.status, await res.text().catch(() => ""))); return false; }
  } catch {}
  return true;   // unreachable / other errors: not the key's fault, register as usual
}
export type ConnectionTest = { state: "reachable" | "unreachable" | "rejected" | "not-configured"; detail: string; models?: number };

/**
 * Does this backend answer, and does it accept the key? The same endpoints start-up uses
 * (keyCheckUrl), with the provider's own words when it refuses. Never echoes the key.
 */
export async function testConnection(b: Pick<Backend, "id" | "baseUrl" | "apiKey">, timeoutMs = 6000): Promise<ConnectionTest> {
  if (b.id !== "lmstudio" && !b.apiKey) return { state: "not-configured", detail: "no key saved" };
  const call = async (url: string, auth = true) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fetch(url, { headers: auth ? { authorization: `Bearer ${b.apiKey}` } : {}, signal: ctl.signal }); }
    finally { clearTimeout(t); }
  };
  try {
    if (b.id === "lmstudio") {
      const native = await call(`${rootUrl(b.baseUrl)}/api/v0/models`, false).catch(() => undefined);
      const res = native?.ok ? native : await call(`${b.baseUrl}/models`, false);
      if (!res.ok) return { state: "unreachable", detail: `HTTP ${res.status} from ${b.baseUrl}` };
      const data = ((await res.json().catch(() => ({})))?.data ?? []) as any[];
      return { state: "reachable", detail: `${data.length} model${data.length === 1 ? "" : "s"} on the server`, models: data.length };
    }
    const res = await call(keyCheckUrl(b as Backend)!);
    if (res.status === 401 || res.status === 403) return { state: "rejected", detail: authFailureText(res.status, await res.text().catch(() => "")) };
    if (!res.ok) return { state: "unreachable", detail: authFailureText(res.status, await res.text().catch(() => "")) };
    const body = await res.json().catch(() => ({}));
    const count = Array.isArray(body?.data) ? body.data.length : undefined;
    return { state: "reachable", detail: count !== undefined ? `key accepted, ${count} models` : "key accepted", models: count };
  } catch (e: any) {
    return { state: "unreachable", detail: e?.name === "AbortError" ? `no answer from ${b.baseUrl} in ${Math.round(timeoutMs / 1000)}s` : `cannot reach ${b.baseUrl} (${e?.cause?.code ?? e?.message ?? e})` };
  }
}

const keyHint = (id: string) => id === "openrouter" ? "OpenRouter keys start with sk-or-v1-; paste just the key, no \"Bearer\" or quotes." : "Ask Matthew to check the key.";
async function discover(b: Backend, litellmMeta: Map<string, ModelMeta>, lmstudioMeta: Map<string, LmStudioMeta>): Promise<string[]> {
  if (env("NO_DISCOVERY")) return b.fallback;   // KERNAL_NO_DISCOVERY: offline / tests
  if (b.id === "openrouter") {
    const list = await getJson(`${b.baseUrl}/models`, b.apiKey);
    if (list) { reachable.add(b.id); openrouterCatalogue = ((list.data ?? []) as any[]).map((m) => String(m?.id)).sort(); }
    const { kept, dropped } = keepListed(b.fallback, list);
    if (dropped.length) notListed.set(b.id, dropped);
    return kept;
  }
  if (!b.discover) return b.fallback;
  if (b.id === "lmstudio") {
    // The shared local discovery (#379, _shared/local-discovery.ts) reads both of LM Studio's lists:
    // /api/v0/models for the windows and loaded state, /v1/models for the ids it accepts right now.
    const { server, models: found } = await probeServer({ kind: "lmstudio", url: b.baseUrl, apiKey: b.apiKey }, { timeoutMs: 4000 });
    if (!server.ok) return b.fallback;
    reachable.add(b.id);
    for (const [k, v] of lmStudioMeta(found)) lmstudioMeta.set(k, v);
    const ids = found.filter((m) => m.listed).map((m) => m.id).filter(b.filter ?? (() => true));
    return ids.length ? ids.sort() : b.fallback;
  }
  if (b.id === "litellm") {
    const info = await getJson(`${rootUrl(b.baseUrl)}/model/info`, b.apiKey);
    if (info) { const { ids, meta } = parseModelInfo(info); for (const [k, v] of meta) litellmMeta.set(k, v); if (ids.length) return ids; }
  }
  const list = await getJson(`${b.baseUrl}/models`, b.apiKey);
  if (list) reachable.add(b.id);
  const ids = ((list?.data ?? []) as any[]).map((m) => String(m.id)).filter(b.filter ?? (() => true));
  return ids.length ? ids.sort() : b.fallback;
}

/** Other people's shared models (GET /api/local-hosts). Signed out: nothing, and no request. */
async function fetchLocalHosts(): Promise<unknown> {
  if (!loginState().signedIn) return undefined;
  try {
    const res = await sendWithBearer((rejected) => outfitterBearer(undefined, rejected), async (token) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      try {
        return await fetch(`${outfitterApi()}/api/local-hosts`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ctl.signal });
      } finally { clearTimeout(t); }
    });
    return res.ok ? await res.json() : undefined;
  } catch { return undefined; }
}

/** "sharing N models via ngrok", or nothing when this laptop isn't sharing. */
function sharingNow(): string | undefined {
  const home = kernalHome();
  const pid = readLockPid(home);
  return localHostFooter(readState(home), pid !== undefined && pidAlive(pid));
}

// Persist into the agent config dir (PI_CODING_AGENT_DIR when launched via bin/kernal, else
// ~/.pi/agent), never into the repo pi happens to be running in. An upgrade carries the choice
// forward (settings.ts: the installer merges the user's changes over the new release's defaults).
export { settingsPath };
export function saveDefault(provider: string, model: string) {
  updateSettings((s) => { s.defaultProvider = provider; s.defaultModel = model; });
  // #437: Kernal's own write, whichever target the person then picks (or none): never echoed to the
  // account by the Ctrl+S sync (_shared/default-sync.ts).
  try { noteOwnDefaultsWrite(); } catch {}
}

export default async function (pi: ExtensionAPI) {
  const litellmMeta = new Map<string, ModelMeta>();
  const lmstudioMeta = new Map<string, LmStudioMeta>();
  const localFacts = new Map<string, LocalModelFact>();
  let defs: Backend[] = [];
  const models = new Map<string, string[]>();
  const registered = new Set<string>();   // backends whose provider is registered with pi right now

  // What the account delivered when the last registration began (central-config, held in memory),
  // so a delivery that lands while it runs is noticed. Only the account's part: connect itself edits
  // process.env (OPENROUTER_API_KEY, below), which must not look like a change.
  // The curated OpenRouter list's settings count too (#440): a change re-registers OpenRouter.
  let registeredFrom = "";
  const centralInputs = () => backendInputs(layerCentralEnv({})) + JSON.stringify(curationLists());
  async function registerAll(envOverride?: Record<string, string>) {
    const env = { ...loadEnv(process.cwd()), ...(envOverride ?? {}) };
    registeredFrom = centralInputs();
    litellmMeta.clear(); lmstudioMeta.clear(); localFacts.clear(); reachable.clear(); keyRejected.clear(); notListed.clear(); registered.clear();
    // A cloud sandbox has no local model server: there the lmstudio backend is kept only when
    // LMSTUDIO_BASE_URL was set on purpose (a guru opting in to a tunnelled laptop model), and is
    // never probed on localhost by default.
    defs = backends(env, litellmMeta, lmstudioMeta, localFacts).filter((b) => !(b.id === "lmstudio" && inSandbox() && !env.LMSTUDIO_BASE_URL));
    const or = defs.find((d) => d.id === "openrouter");
    if (or) or.fallback = curateOpenRouter(or.fallback, curationLists(), !!env.OPENROUTER_MODELS);
    await Promise.all(defs.map(async (b) => {
      // A cloud backend without a key is not registered at all: otherwise its models show up in
      // pi's own /model picker and every request fails with a bare 401 from the provider.
      const usable = !!b.apiKey && (await checkKey(b));
      // pi has a built-in "openrouter" provider that reads OPENROUTER_API_KEY itself and comes back
      // whenever ours is unregistered. Keep that variable in step with what we decided: the cleaned
      // key when it works, gone when it is missing or rejected, so no OpenRouter model is offered
      // anywhere unless OpenRouter is actually connected.
      if (b.id === "openrouter") { if (usable) process.env.OPENROUTER_API_KEY = b.apiKey; else delete process.env.OPENROUTER_API_KEY; }
      // The router MCP server (.pi/mcp.json) builds its header from KERNAL_ROUTER_KEY when it connects:
      // the key in use here, from .env or this device's login, and none means it doesn't connect at all
      // instead of sending an empty "Bearer " the router logs as a malformed key (#447). Like
      // OPENROUTER_API_KEY above (and LITELLM_AGENT_KEY for .env users), child processes inherit it.
      if (b.id === "litellm") { if (usable) process.env.KERNAL_ROUTER_KEY = b.apiKey; else delete process.env.KERNAL_ROUTER_KEY; }
      if (!usable) { models.set(b.id, []); try { pi.unregisterProvider?.(b.id); } catch {} return; }
      const ids = await discover(b, litellmMeta, lmstudioMeta);
      let listed = ids;
      if (b.id === "litellm") {
        const shared = localModelsFromHosts(await fetchLocalHosts());
        for (const [id, fact] of shared) localFacts.set(id, fact);
        listed = mergeLitellmModels(ids, shared.keys());
      }
      models.set(b.id, listed);
      pi.registerProvider(b.id, { name: b.label, baseUrl: b.baseUrl, apiKey: b.apiKey, api: "openai-completions", models: listed.map(b.model) as any });
      registered.add(b.id);
    }));
  }
  await registerAll();
  // GA-3 (#493): gcloud ships disabled; switch it on for a device whose router key lists it.
  if (!inSandbox()) {
    let admitted: string[] | undefined;
    try { admitted = getRouterKey()?.mcpServers; } catch {}
    applyLaptopMcpGate(process.env.PI_CODING_AGENT_DIR, admitted);
  }
  const byId = (id: string) => defs.find((d) => d.id === id);

  // ---------- /setup: first-run wizard, writes .env and re-registers providers live ----------
  pi.registerCommand("setup", {
    description: "Run kernal login, then manage settings in the web app; this wizard writes only this machine's .env",
    handler: async (_args, ctx) => {
      // CA-8: settings live in the account now; the wizard stays for this machine's own .env.
      ctx.ui.notify(loginState().signedIn
        ? `Your settings are managed at ${webOrigin()}/account (/config shows what is in force). This wizard only writes this machine's .env.`
        : `Run kernal login, then manage settings at ${webOrigin()}/account. This wizard only writes this machine's .env.`, "info");
      if (!ctx.hasUI) { ctx.ui.notify(`Edit ${envFilePath()} (see .env.example); /setup needs the interactive UI`, "warning"); return; }
      const cur = loadEnv(process.cwd());
      // Enter on an empty field keeps what is shown (current value or default); Escape cancels the wizard.
      const ask = async (title: string, current: string | undefined, fallback?: string) => {
        const shown = current || fallback || "";
        const v = await ctx.ui.input(shown ? `${title}  (Enter keeps: ${shown})` : title, shown);
        if (v === undefined) return undefined;
        return v.trim() === "" ? shown : v.trim();
      };
      const values: Record<string, string | undefined> = {};
      const name = await ask("Your name (shown in the banner)", cur.KERNAL_USER, process.env.USER); if (name === undefined) return; if (name) values.KERNAL_USER = name;

      const llUrl = await ask("LiteLLM router URL", cur.LITELLM_BASE_URL, "https://router.kernal.one/v1"); if (llUrl === undefined) return; values.LITELLM_BASE_URL = normalizeBaseUrl(llUrl, "https://router.kernal.one/v1");
      // keys: the prompt shows a masked hint; Enter keeps the existing key, a new value replaces it
      const keyPrompt = async (title: string, current: string | undefined, maskPrefix: string) => {
        const hint = current ? `${maskPrefix}…${current.slice(-4)}` : "";
        const v = await ctx.ui.input(hint ? `${title}  (Enter keeps ${hint})` : `${title}  (blank to skip)`, "");
        if (v === undefined) return undefined;
        return cleanKey(v);   // "" = keep current / skip
      };
      const llKey = await keyPrompt("LiteLLM key for this agent (ask Matthew for one)", cur.LITELLM_AGENT_KEY, "sk"); if (llKey === undefined) return; if (llKey) values.LITELLM_AGENT_KEY = llKey;
      const orKey = await keyPrompt("OpenRouter API key (openrouter.ai/keys)", cur.OPENROUTER_API_KEY, "sk-or"); if (orKey === undefined) return; if (orKey) values.OPENROUTER_API_KEY = orKey;
      if (orKey && !orKey.startsWith("sk-or-")) ctx.ui.notify(`That does not look like an OpenRouter key (they start with sk-or-v1-). Saved anyway; run /setup again if OpenRouter rejects it.`, "warning");

      // Local server last: the router is the default backend, the local model is an extra.
      const useLocal = await ctx.ui.select("Optional: local model server (LM Studio or any OpenAI-compatible server)", ["Yes, configure it", "No local model on this machine"]);
      if (useLocal === undefined) return;
      if (useLocal.startsWith("Yes")) {
        const typed = await ask("Local server URL", cur.LMSTUDIO_BASE_URL, "http://localhost:1234/v1"); if (typed === undefined) return;
        const url = normalizeBaseUrl(typed, "http://localhost:1234/v1"); values.LMSTUDIO_BASE_URL = url;
        const { server, models: found } = await probeServer({ kind: "lmstudio", url, apiKey: "lm-studio" }, { timeoutMs: 4000 });
        const listed = server.endpoints.includes("/api/v0/models") ? [...lmStudioMeta(found).entries()].map(([id, m]) => `${id}${m.loaded ? "  (loaded)" : ""}`) : found.filter((m) => m.listed).map((m) => m.id);
        let model: string | undefined;
        if (listed.length) { const pick = await ctx.ui.select("Default local model", [...listed, "type another id"]); if (pick === undefined) return; model = pick === "type another id" ? undefined : pick.split("  ")[0]; }
        if (!model) { model = await ask("Local model id", cur.LMSTUDIO_MODEL); if (model === undefined) return; }
        if (model) values.LMSTUDIO_MODEL = model;
        if (!listed.length) ctx.ui.notify(`Could not reach ${url}; saved anyway. Start the server and run /setup again to pick a model.`, "warning");
      }

      const file = writeEnvValues(values);
      await registerAll();
      const ok = defs.filter((d) => d.apiKey && !keyRejected.has(d.id)).map((d) => d.id);
      ctx.ui.notify(`Saved ${file}. Connections ready: ${ok.join(", ") || "none"}. Use /connect to pick a model.`, "info");
      for (const [id, why] of keyRejected) ctx.ui.notify(`${id} rejected the key (${why}). ${keyHint(id)}`, "warning");
    },
  });
  pi.on("session_start", async (_ev, ctx) => {
    const anyKey = defs.some((d) => d.id !== "lmstudio" && d.apiKey);
    if (ctx.hasUI && !anyKey && !reachable.has("lmstudio")) ctx.ui.notify("No model connections yet: no API keys and no local model server answering. Run /setup.", "warning");
    if (ctx.hasUI) for (const [id, why] of keyRejected) ctx.ui.notify(`${id} rejected the key (${why}); its models are hidden until /setup saves a working one. ${keyHint(id)}`, "warning");
    if (ctx.hasUI) for (const [id, ids] of notListed) ctx.ui.notify(`${id} doesn't list ${ids.join(", ")}; left out of /model and /connect. Fix OPENROUTER_MODELS if you set it.`, "warning");
  });

  // ---------- /connect ----------
  async function connect(ctx: ExtensionCommandContext, backendId?: string, modelId?: string) {
    let b = backendId ? byId(backendId) : undefined;
    if (!b) {
      if (backendId) { ctx.ui.notify(`Unknown backend "${backendId}". Use lmstudio, litellm or openrouter.`, "error"); return; }
      const sharing = sharingNow();
      const pick = await ctx.ui.select(sharing ? `Connect to — ${sharing}` : "Connect to", defs.map((d) => d.label));
      if (!pick) return;
      b = defs[defs.map((d) => d.label).indexOf(pick)];
    }
    if (!b.apiKey) { ctx.ui.notify(`No API key for ${b.id}: run /setup (or set ${b.keyVar} in the .env next to kernal)`, "error"); return; }
    if (keyRejected.has(b.id)) { ctx.ui.notify(`${b.id} rejected the key (${keyRejected.get(b.id)}). Run /setup and paste it again. ${keyHint(b.id)}`, "error"); return; }
    const ids = models.get(b.id) ?? [];
    if (!modelId) {
      const sharing = sharingNow();
      const marked = (id: string) => { const fact = b!.id === "litellm" ? localFacts.get(id) : undefined; return fact ? localModelLabel(id, fact.online) : id; };
      const options = (b.id === "openrouter" ? [...ids, BROWSE] : ids).map((id) => id === BROWSE ? id : marked(id));
      const picked = options.length === 1 ? options[0] : await ctx.ui.select(sharing ? `Model on ${b.id} — ${sharing}` : `Model on ${b.id}`, options);
      if (!picked) return;
      if (picked === BROWSE) { modelId = await browseOpenRouter(ctx); if (!modelId) return; }
      else modelId = localModelIdFromLabel(picked);
    }
    // Not on the list but OpenRouter has it: offer to add it first, so pi can switch to it.
    if (b.id === "openrouter" && !ids.includes(modelId) && (await loadCatalogue()).includes(modelId) && !(await offerToAdd(ctx, modelId))) return;
    const problem = await selectModel(ctx, b.id, modelId);
    if (problem) { ctx.ui.notify(problem, "error"); return; }
    const saved = await saveTarget(ctx, b.id, modelId);
    ctx.ui.notify(`Connected to ${b.id} / ${modelId} (${saved.message})`, saved.ok ? "info" : "warning");
  }

  /**
   * #437: signed in with a UI, where the new default goes: the account (profile X) or only this
   * machine (kernal-admin/central.ts saves both, as the Settings page does). settings.json has it
   * already (selectModel), so signed out, without a UI or on Escape nothing else changes.
   */
  async function saveTarget(ctx: Pick<ExtensionCommandContext, "ui" | "hasUI">, provider: string, model: string): Promise<{ ok: boolean; message: string }> {
    const legacy = { ok: true, message: "saved as default" };
    // Loaded only here: the Drive image ships without kernal-admin (outfitter/image/Dockerfile), and
    // a Drive never asks (no UI, no login).
    const admin = ctx.hasUI ? await import("../kernal-admin/central.ts").catch(() => undefined) : undefined;
    const targets = admin?.modelSaveTargets();
    if (!admin || !targets) {
      // Signed out or non-interactive: settings.json only, as before; say when something else
      // still wins at the next session.
      const wins = otherDefault(provider, model);
      return wins ? { ok: true, message: `saved in settings.json; ${wins}: /connect in the TUI, signed in, saves to your account or this machine` } : legacy;
    }
    const pick = await ctx.ui.select(`Save ${provider}/${model} as the default`, [targets.account, targets.machine]);
    if (pick === undefined) {
      const wins = otherDefault(provider, model);
      return { ok: true, message: `saved in this machine's settings.json only${wins ? `; ${wins}` : ""}` };
    }
    return admin.saveModelDefault(pick === targets.account ? "account" : "machine", provider, model);
  }

  /** What the next session starts on instead of `provider`/`model`, when a central value (or this
   * machine's own) still names another backend or model; undefined when settings.json decides. */
  function otherDefault(provider: string, model: string): string | undefined {
    const r = (() => { try { return reresolve(); } catch { return undefined; } })();
    if (!r) return undefined;
    const decides = (v: ConfigValue | undefined) => !!v && v.source !== "legacy" && v.source !== "default";
    const m = r.values["model.default"], p = r.values["model.provider"];
    if (decides(m) && m!.value !== model && m!.value !== `${provider}/${model}`) return `${describeSource(m!)} sets ${String(m!.value)}, which the next session starts on`;
    if (decides(p) && p!.value !== provider) return `${describeSource(p!)} sets the backend ${String(p!.value)}, which the next session starts on`;
    return undefined;
  }

  const BROWSE = "Browse all OpenRouter models…";

  /** OpenRouter's catalogue, fetched now when start-up didn't get it (offline, KERNAL_NO_DISCOVERY). */
  async function loadCatalogue(): Promise<string[]> {
    if (!openrouterCatalogue.length && !env("NO_DISCOVERY")) {   // offline: no catalogue, so no id check either
      const b = byId("openrouter");
      const list = b?.apiKey ? await getJson(`${b.baseUrl}/models`, b.apiKey, 8000) : undefined;
      openrouterCatalogue = ((list?.data ?? []) as any[]).map((m) => String(m?.id)).sort();
    }
    return openrouterCatalogue;
  }

  /** Search OpenRouter's whole catalogue, then pick one of the matches. */
  async function browseOpenRouter(ctx: ExtensionCommandContext): Promise<string | undefined> {
    if (!(await loadCatalogue()).length) { ctx.ui.notify("OpenRouter's model list could not be read; try again later", "error"); return undefined; }
    const query = await ctx.ui.input(`Search ${openrouterCatalogue.length} OpenRouter models (part of an id, e.g. deepseek)`, "");
    if (query === undefined) return undefined;
    const q = query.trim().toLowerCase();
    const matches = openrouterCatalogue.filter((id) => id.toLowerCase().includes(q));
    if (!matches.length) { ctx.ui.notify(`No OpenRouter model matches "${query.trim()}"`, "warning"); return undefined; }
    return ctx.ui.select(`OpenRouter models matching "${query.trim()}" (${matches.length})`, matches);
  }

  /** Ask where to add a model to the curated list, add it and re-register. False when not added. */
  async function offerToAdd(ctx: ExtensionCommandContext, id: string): Promise<boolean> {
    if (loadEnv(process.cwd()).OPENROUTER_MODELS) { ctx.ui.notify(`OPENROUTER_MODELS in .env sets the whole OpenRouter list: add ${id} there, or remove it to curate the list here`, "error"); return false; }
    const ACCOUNT = "Add to my account's list (every Kernal I sign in to)", MACHINE = "Add to this machine's list only";
    const pick = await ctx.ui.select(`${id} is not on your OpenRouter list`, canSaveToAccount() ? [ACCOUNT, MACHINE] : [MACHINE]);
    if (!pick) return false;
    try {
      ctx.ui.notify(await changeCuration("add", id, pick === ACCOUNT ? "account" : "machine", { catalogue: await loadCatalogue() }), "info");
    } catch (e: any) { ctx.ui.notify(`Not added: ${e?.message ?? e}`, "error"); return false; }
    await registerAll();
    // Saved, but this process still resolves the old list (Outfitter didn't answer the reload).
    if (!(models.get("openrouter") ?? []).includes(id)) { ctx.ui.notify(`${id} is saved, but this session couldn't pick up the change; it is offered from the next start`, "warning"); return false; }
    return true;
  }

  /** Switch to a model and save it as the default. Returns why not, or undefined on success. */
  async function selectModel(ctx: Pick<ExtensionCommandContext, "modelRegistry" | "ui">, backendId: string, modelId: string): Promise<string | undefined> {
    const model = ctx.modelRegistry.find(backendId, modelId);
    if (!model) return `Model "${modelId}" not found on ${backendId}. Known: ${(models.get(backendId) ?? []).join(", ")}`;
    if (!(await pi.setModel(model))) return `Could not switch to ${backendId}/${modelId}`;
    saveDefault(backendId, modelId);
    // #437: an explicit choice replaces this machine's earlier one (config.local.json), which would
    // otherwise win over settings.json at the next session; "Only this machine" writes it again.
    try { clearLocalOverrides(["model.provider", "model.default"]); } catch {}
    ctx.ui.setStatus("connect", `⇄ ${backendId}/${modelId}`);
    return undefined;
  }

  /** What the providers look like right now; keys stay here, only whether one is set leaves. */
  const connectionState = () => defs.map((d) => ({
    id: d.id, label: d.label, baseUrl: d.baseUrl, keyVar: d.keyVar,
    hasKey: d.id === "lmstudio" || !!d.apiKey, registered: registered.has(d.id), answered: reachable.has(d.id),
    rejected: keyRejected.get(d.id), models: models.get(d.id) ?? [],
  }));

  /** The curated OpenRouter list's parts, for /admin's Model page (#440). */
  const curationState = () => ({
    lists: curationLists(), catalogue: openrouterCatalogue, canAccount: canSaveToAccount(),
    replacedByEnv: !!loadEnv(process.cwd()).OPENROUTER_MODELS,
    unavailable: notListed.get("openrouter") ?? [],   // on a list, but OpenRouter doesn't list them
  });

  // /admin (and anything else) asks through the shared event bus rather than duplicating this state.
  busServe((pi as any).events, "kernal:connect", async (req: { op: string; ctx?: any; provider?: string; model?: string; action?: string; target?: string }) => {
    if (req?.op === "state") return connectionState();
    if (req?.op === "curation") return curationState();
    if (req?.op === "curate") {
      if (req.action !== "add" && req.action !== "remove") throw new Error("action is add or remove");
      if (req.target !== "account" && req.target !== "machine") throw new Error("target is account or machine");
      if (curationState().replacedByEnv) throw new Error("OPENROUTER_MODELS in .env sets the whole OpenRouter list: edit it there, or remove it to curate the list here");
      const message = await changeCuration(req.action, String(req.model ?? ""), req.target as CurationTarget, { catalogue: req.action === "add" ? await loadCatalogue() : undefined });
      await registerAll();
      return { message, ...curationState(), models: models.get("openrouter") ?? [] };
    }
    if (req?.op === "reload") { await registerAll(); return connectionState(); }
    if (req?.op === "select") {
      if (!req.ctx) throw new Error("no session to switch the model in yet");
      const problem = await selectModel(req.ctx, String(req.provider), String(req.model));
      if (problem) throw new Error(problem);
      return { provider: req.provider, model: req.model };
    }
    throw new Error(`unknown op ${req?.op}`);
  });

  // The account's keys (central-config) arrive in the background, often while the first
  // registration above is still probing the servers. kernal-config then asks for a reload over the
  // bus, but nobody served it yet and busRequest drops the request silently (2026-10-04: OpenRouter
  // stayed "No API key" for the whole session). So check once now that we serve the bus: anything
  // that lands later reaches the handler above.
  if (centralInputs() !== registeredFrom) void registerAll().catch(() => {});

  pi.registerCommand("connect", {
    description: "Connect to lmstudio | litellm | openrouter [model]",
    getArgumentCompletions: (prefix) => {
      const [first, second] = prefix.split(/\s+/);
      if (second !== undefined) return (models.get(first) ?? []).filter((m) => m.startsWith(second)).map((m) => {
        const fact = first === "litellm" ? localFacts.get(m) : undefined;
        return { value: `${first} ${m}`, label: m, ...(fact ? { description: fact.online ? "online" : "offline" } : {}) };
      });
      return defs.filter((d) => d.id.startsWith(first ?? "")).map((d) => ({ value: d.id, label: d.id, description: d.label }));
    },
    handler: async (args, ctx) => {
      const [backendId, modelId] = args.trim().split(/\s+/).filter(Boolean);
      await connect(ctx, backendId, modelId);
    },
  });

  // ---------- LiteLLM spend / budget ----------
  // Streamed responses carry cost headers before LiteLLM has computed the cost (they read 0), so:
  //   estimate = pi's own per-message usage x prices from /model/info (accurate, immediate)
  //   actual   = x-litellm-key-spend delta since the session started (authoritative, lags a little)
  const spend = { calls: 0, keySpendStart: undefined as number | undefined, keySpend: undefined as number | undefined };
  let keyMax: number | null | undefined;
  const estimate = (ctx: any) => sessionEstimate(ctx.sessionManager.getEntries());
  const actual = () => (spend.keySpend != null && spend.keySpendStart != null ? Math.max(0, spend.keySpend - spend.keySpendStart) : undefined);
  const budgetStatus = (ctx: any) => {
    if (ctx.model?.provider !== "litellm") { ctx.ui.setStatus("budget", undefined); return; }
    ctx.ui.setStatus("budget", footerStatus(estimate(ctx), spend.keySpend, keyMax));
  };
  const log = (o: object) => { const f = env("SPEND_LOG"); if (f) appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n"); };

  pi.on("after_provider_response", async (ev, ctx) => {
    const h = parseSpendHeaders(ev.headers);
    if (!h.litellm) return;
    spend.calls++;
    if (h.keySpend !== undefined) { spend.keySpend = h.keySpend; spend.keySpendStart ??= h.keySpend; }
    if (h.keyMax !== undefined) keyMax = h.keyMax;
    log({ model: h.modelGroup ?? ctx.model?.id, calls: spend.calls, keySpend: spend.keySpend, keyMax });
    budgetStatus(ctx);
  });
  pi.on("agent_end", async (_ev, ctx) => { log({ event: "agent_end", estimate: estimate(ctx), actual: actual() }); budgetStatus(ctx); });

  const litellmGet = (path: string) => { const b = byId("litellm")!; return b.apiKey ? getJson(`${rootUrl(b.baseUrl)}${path}`, b.apiKey, 8000) : Promise.resolve(undefined); };
  let panelTimer: ReturnType<typeof setTimeout> | undefined;

  pi.registerCommand("budget", {
    description: "LiteLLM budget panel: session estimate, key and team budgets, model prices (/budget off hides it)",
    handler: async (args, ctx) => {
      if (args.trim() === "off") { ctx.ui.setWidget("budget", undefined); return; }
      const key = (await litellmGet("/key/info"))?.info;
      const teamRes = key?.team_id ? await litellmGet(`/team/info?team_id=${key.team_id}`) : undefined;
      const team = teamRes?.team_info ?? teamRes;
      if (key?.max_budget != null) keyMax = key.max_budget;
      if (key?.spend != null) { spend.keySpend = key.spend; spend.keySpendStart ??= key.spend; }
      const m = ctx.model;
      const data = { estimate: estimate(ctx), actual: actual(), calls: spend.calls, key, keySpend: spend.keySpend, keyMax, team, model: m ? { provider: m.provider, id: m.id } : undefined, meta: m?.provider === "litellm" ? litellmMeta.get(m.id) : undefined };
      if (!ctx.hasUI) { ctx.ui.notify(`session est ${money(data.estimate)}; key ${money(key?.spend ?? spend.keySpend)}/${money(keyMax)}; team ${money(team?.spend)}/${money(team?.max_budget)}`, "info"); return; }
      const rows = budgetRows(data);
      ctx.ui.setWidget("budget", (_tui, theme) => ({
        render: (width: number) => renderPanel(rows, width, (c, t) => theme.fg(c as any, t)).map((l) => truncateToWidth(l, width)),
        invalidate() {},
      }), { placement: "aboveEditor" });
      if (panelTimer) clearTimeout(panelTimer);
      panelTimer = setTimeout(() => { try { ctx.ui.setWidget("budget", undefined); } catch { /* session replaced */ } }, 60_000);
      budgetStatus(ctx);
    },
  });

  const seedKeySpend = async (ctx: any) => {
    const key = (await litellmGet("/key/info"))?.info;
    if (key) { if (key.max_budget != null) keyMax = key.max_budget; if (key.spend != null) { spend.keySpend = key.spend; spend.keySpendStart ??= key.spend; } }
    budgetStatus(ctx);
  };
  let hostCtx: { ui: { setStatus(key: string, text: string | undefined): void } } | undefined;
  let hostWatch: ReturnType<typeof setInterval> | undefined;
  // A footer refresh must never take pi down: after /new, /resume, /fork or /reload the old ctx is
  // stale and every ui call throws. session_shutdown below stops the timers first; this is the net.
  const refreshLocalHost = () => {
    try { hostCtx?.ui.setStatus("local-host", sharingNow()); } catch { hostCtx = undefined; }
  };
  pi.on("session_start", async (_ev, ctx) => {
    // pi answers no RPC command until every session_start handler has returned, and this lookup only
    // feeds the footer, so a sandbox fills it in behind the first prompt instead of ahead of it.
    if (inSandbox()) void seedKeySpend(ctx).catch(() => {});
    else await seedKeySpend(ctx);
    const m = ctx.model;
    if (m && defs.some((d) => d.id === m.provider)) ctx.ui.setStatus("connect", `⇄ ${m.provider}/${m.id}`);
    // Quiet when this laptop isn't sharing. The file is the service's own state; the UI does not start a tunnel.
    hostCtx = ctx;
    refreshLocalHost();
    if (!hostWatch) {
      hostWatch = setInterval(refreshLocalHost, 15_000);
      hostWatch.unref?.();
    }
  });
  // Timers that hold a session's ctx end with that session: pi fires session_shutdown before /new,
  // /resume, /fork, /reload and quit, and a captured ctx throws once the session is replaced.
  pi.on("session_shutdown", async () => {
    if (hostWatch) { clearInterval(hostWatch); hostWatch = undefined; }
    hostCtx = undefined;
    if (panelTimer) { clearTimeout(panelTimer); panelTimer = undefined; }
  });
  pi.on("model_select", async (ev: any, ctx) => {
    budgetStatus(ctx);
    const m = ev.model ?? ctx.model;
    if (m && defs.some((d) => d.id === m.provider)) ctx.ui.setStatus("connect", `⇄ ${m.provider}/${m.id}`);
  });
}
