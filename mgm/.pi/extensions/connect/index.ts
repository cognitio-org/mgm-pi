/**
 * /connect — pick which backend pi talks to (lmstudio | litellm | openrouter) and
 * /budget — LiteLLM pricing, spend and budget panel.
 *
 *   /connect                      interactive picker (backend, then model)
 *   /connect litellm              pick a model on that backend
 *   /connect lmstudio <model-id>  switch directly
 *   /budget [off]                 themed panel above the editor
 *
 * Backends are registered as pi providers at startup. LM Studio and LiteLLM models are discovered
 * live (LiteLLM via /model/info for prices and limits, falling back to /v1/models); OpenRouter uses
 * a curated list (OPENROUTER_MODELS overrides). The chosen backend/model is saved to the agent
 * dir's settings.json. Secrets come from ~/localllm/.env, ../.env or ./.env (see README).
 * All pure logic lives in ./lib.ts and is unit-tested.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  type Backend, type ModelMeta, type LmStudioMeta, backends, parseEnvText, parseModelInfo, parseLmStudioModels, parseSpendHeaders, rootUrl, normalizeBaseUrl,
  sessionEstimate, money, footerStatus, budgetRows, renderPanel, cleanKey, keyCheckUrl, authFailureText,
} from "./lib.ts";

/** The .env that /setup writes: next to the agent dir (bundle root or the mgm/ checkout). */
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

function loadEnv(cwd: string): Record<string, string> {
  let out: Record<string, string> = {};
  for (const f of [join(homedir(), "localllm", ".env"), envFilePath(), join(cwd, "..", ".env"), join(cwd, ".env")]) {
    if (existsSync(f)) out = { ...out, ...parseEnvText(readFileSync(f, "utf8")) };
  }
  return { ...out, ...(process.env as Record<string, string>) };
}

async function getJson(url: string, apiKey: string, timeoutMs = 4000): Promise<any | undefined> {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` }, signal: ctl.signal });
    clearTimeout(t);
    return res.ok ? await res.json() : undefined;
  } catch { return undefined; }
}

const reachable = new Set<string>();   // backends whose server answered discovery
const keyRejected = new Map<string, string>();   // backend id → why the provider refused its key (401/403)

/** Verify a key against the backend's cheapest authenticated endpoint; only a definite 401/403 counts. */
async function checkKey(b: Backend, timeoutMs = 5000): Promise<boolean> {
  const url = keyCheckUrl(b);
  if (!url || process.env.MGM_NO_DISCOVERY) return true;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { headers: { authorization: `Bearer ${b.apiKey}` }, signal: ctl.signal });
    clearTimeout(t);
    if (res.status === 401 || res.status === 403) { keyRejected.set(b.id, authFailureText(res.status, await res.text().catch(() => ""))); return false; }
  } catch {}
  return true;   // unreachable / other errors: not the key's fault, register as usual
}
const keyHint = (id: string) => id === "openrouter" ? "OpenRouter keys start with sk-or-v1-; paste just the key, no \"Bearer\" or quotes." : "Ask Matthew to check the key.";
async function discover(b: Backend, litellmMeta: Map<string, ModelMeta>, lmstudioMeta: Map<string, LmStudioMeta>): Promise<string[]> {
  if (!b.discover || process.env.MGM_NO_DISCOVERY) return b.fallback;   // MGM_NO_DISCOVERY: offline / tests
  if (b.id === "lmstudio") {
    const native = await getJson(`${rootUrl(b.baseUrl)}/api/v0/models`, b.apiKey);
    if (native) { reachable.add(b.id); for (const [k, v] of parseLmStudioModels(native)) lmstudioMeta.set(k, v); }
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

// Persist into the agent config dir (PI_CODING_AGENT_DIR when launched via bin/mgm, else
// ~/.pi/agent), never into the repo pi happens to be running in.
function settingsPath() { return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json"); }
function saveDefault(provider: string, model: string) {
  const p = settingsPath();
  let s: any = {};
  try { s = JSON.parse(readFileSync(p, "utf8")); } catch {}
  s.defaultProvider = provider; s.defaultModel = model;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
}

export default async function (pi: ExtensionAPI) {
  const litellmMeta = new Map<string, ModelMeta>();
  const lmstudioMeta = new Map<string, LmStudioMeta>();
  let defs: Backend[] = [];
  const models = new Map<string, string[]>();

  async function registerAll(envOverride?: Record<string, string>) {
    const env = { ...loadEnv(process.cwd()), ...(envOverride ?? {}) };
    litellmMeta.clear(); lmstudioMeta.clear(); reachable.clear(); keyRejected.clear();
    defs = backends(env, litellmMeta, lmstudioMeta);
    await Promise.all(defs.map(async (b) => {
      // A cloud backend without a key is not registered at all: otherwise its models show up in
      // pi's own /model picker and every request fails with a bare 401 from the provider.
      const usable = !!b.apiKey && (await checkKey(b));
      // pi has a built-in "openrouter" provider that reads OPENROUTER_API_KEY itself and comes back
      // whenever ours is unregistered. Keep that variable in step with what we decided: the cleaned
      // key when it works, gone when it is missing or rejected, so no OpenRouter model is offered
      // anywhere unless OpenRouter is actually connected.
      if (b.id === "openrouter") { if (usable) process.env.OPENROUTER_API_KEY = b.apiKey; else delete process.env.OPENROUTER_API_KEY; }
      if (!usable) { models.set(b.id, []); try { pi.unregisterProvider?.(b.id); } catch {} return; }
      const ids = await discover(b, litellmMeta, lmstudioMeta);
      models.set(b.id, ids);
      pi.registerProvider(b.id, { name: b.label, baseUrl: b.baseUrl, apiKey: b.apiKey, api: "openai-completions", models: ids.map(b.model) as any });
    }));
  }
  await registerAll();
  const byId = (id: string) => defs.find((d) => d.id === id);

  // ---------- /setup: first-run wizard, writes .env and re-registers providers live ----------
  pi.registerCommand("setup", {
    description: "Configure your name, local model server, LiteLLM router and OpenRouter (writes .env)",
    handler: async (_args, ctx) => {
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
      const name = await ask("Your name (shown in the banner)", cur.MGM_USER, process.env.USER); if (name === undefined) return; if (name) values.MGM_USER = name;

      const useLocal = await ctx.ui.select("Local model server (LM Studio or any OpenAI-compatible server)", ["Yes, configure it", "No local model on this machine"]);
      if (useLocal === undefined) return;
      if (useLocal.startsWith("Yes")) {
        const typed = await ask("Local server URL", cur.LMSTUDIO_BASE_URL, "http://localhost:1234/v1"); if (typed === undefined) return;
        const url = normalizeBaseUrl(typed, "http://localhost:1234/v1"); values.LMSTUDIO_BASE_URL = url;
        const native = await getJson(`${rootUrl(url)}/api/v0/models`, "lm-studio");
        const listed = native ? [...parseLmStudioModels(native).entries()].map(([id, m]) => `${id}${m.loaded ? "  (loaded)" : ""}`) : ((await getJson(`${url}/models`, "lm-studio"))?.data ?? []).map((m: any) => String(m.id));
        let model: string | undefined;
        if (listed.length) { const pick = await ctx.ui.select("Default local model", [...listed, "type another id"]); if (pick === undefined) return; model = pick === "type another id" ? undefined : pick.split("  ")[0]; }
        if (!model) { model = await ask("Local model id", cur.LMSTUDIO_MODEL); if (model === undefined) return; }
        if (model) values.LMSTUDIO_MODEL = model;
        if (!listed.length) ctx.ui.notify(`Could not reach ${url}; saved anyway. Start the server and run /setup again to pick a model.`, "warning");
      }
      const llUrl = await ask("LiteLLM router URL", cur.LITELLM_BASE_URL, "https://litellm.augment-code.support/v1"); if (llUrl === undefined) return; values.LITELLM_BASE_URL = normalizeBaseUrl(llUrl, "https://litellm.augment-code.support/v1");
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

      const file = envFilePath();
      let text = ""; try { text = readFileSync(file, "utf8"); } catch {}
      writeFileSync(file, upsertEnv(text, values));
      for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
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
  });

  // ---------- /connect ----------
  async function connect(ctx: ExtensionCommandContext, backendId?: string, modelId?: string) {
    let b = backendId ? byId(backendId) : undefined;
    if (!b) {
      if (backendId) { ctx.ui.notify(`Unknown backend "${backendId}". Use lmstudio, litellm or openrouter.`, "error"); return; }
      const pick = await ctx.ui.select("Connect to", defs.map((d) => d.label));
      if (!pick) return;
      b = defs[defs.map((d) => d.label).indexOf(pick)];
    }
    if (!b.apiKey) { ctx.ui.notify(`No API key for ${b.id}: run /setup (or set ${b.keyVar} in the .env next to mgm)`, "error"); return; }
    if (keyRejected.has(b.id)) { ctx.ui.notify(`${b.id} rejected the key (${keyRejected.get(b.id)}). Run /setup and paste it again. ${keyHint(b.id)}`, "error"); return; }
    const ids = models.get(b.id) ?? [];
    if (!modelId) {
      modelId = ids.length === 1 ? ids[0] : await ctx.ui.select(`Model on ${b.id}`, ids);
      if (!modelId) return;
    }
    const model = ctx.modelRegistry.find(b.id, modelId);
    if (!model) { ctx.ui.notify(`Model "${modelId}" not found on ${b.id}. Known: ${ids.join(", ")}`, "error"); return; }
    if (await pi.setModel(model)) {
      saveDefault(b.id, modelId);
      ctx.ui.setStatus("connect", `⇄ ${b.id}/${modelId}`);
      ctx.ui.notify(`Connected to ${b.id} / ${modelId} (saved as default)`, "info");
    } else {
      ctx.ui.notify(`Could not switch to ${b.id}/${modelId}`, "error");
    }
  }

  pi.registerCommand("connect", {
    description: "Connect to lmstudio | litellm | openrouter [model]",
    getArgumentCompletions: (prefix) => {
      const [first, second] = prefix.split(/\s+/);
      if (second !== undefined) return (models.get(first) ?? []).filter((m) => m.startsWith(second)).map((m) => ({ value: `${first} ${m}`, label: m }));
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
  const log = (o: object) => { if (process.env.MGM_SPEND_LOG) appendFileSync(process.env.MGM_SPEND_LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n"); };

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
      panelTimer = setTimeout(() => ctx.ui.setWidget("budget", undefined), 60_000);
      budgetStatus(ctx);
    },
  });

  pi.on("session_start", async (_ev, ctx) => {
    const key = (await litellmGet("/key/info"))?.info;
    if (key) { if (key.max_budget != null) keyMax = key.max_budget; if (key.spend != null) { spend.keySpend = key.spend; spend.keySpendStart ??= key.spend; } }
    budgetStatus(ctx);
    const m = ctx.model;
    if (m && defs.some((d) => d.id === m.provider)) ctx.ui.setStatus("connect", `⇄ ${m.provider}/${m.id}`);
  });
  pi.on("model_select", async (ev: any, ctx) => {
    budgetStatus(ctx);
    const m = ev.model ?? ctx.model;
    if (m && defs.some((d) => d.id === m.provider)) ctx.ui.setStatus("connect", `⇄ ${m.provider}/${m.id}`);
  });
}
