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
  type Backend, type ModelMeta, backends, parseEnvText, parseModelInfo, parseSpendHeaders, rootUrl,
  sessionEstimate, money, footerStatus, budgetRows, renderPanel,
} from "./lib.ts";

function loadEnv(cwd: string): Record<string, string> {
  let out: Record<string, string> = {};
  for (const f of [join(homedir(), "localllm", ".env"), join(cwd, "..", ".env"), join(cwd, ".env")]) {
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

async function discover(b: Backend, litellmMeta: Map<string, ModelMeta>): Promise<string[]> {
  if (!b.discover) return b.fallback;
  if (b.id === "litellm") {
    const info = await getJson(`${rootUrl(b.baseUrl)}/model/info`, b.apiKey);
    if (info) { const { ids, meta } = parseModelInfo(info); for (const [k, v] of meta) litellmMeta.set(k, v); if (ids.length) return ids; }
  }
  const list = await getJson(`${b.baseUrl}/models`, b.apiKey);
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
  const env = loadEnv(process.cwd());
  const litellmMeta = new Map<string, ModelMeta>();
  const defs = backends(env, litellmMeta);
  const models = new Map<string, string[]>();

  await Promise.all(defs.map(async (b) => {
    const ids = await discover(b, litellmMeta);
    models.set(b.id, ids);
    pi.registerProvider(b.id, { name: b.label, baseUrl: b.baseUrl, apiKey: b.apiKey, api: "openai-completions", models: ids.map(b.model) as any });
  }));
  const byId = (id: string) => defs.find((d) => d.id === id);

  // ---------- /connect ----------
  async function connect(ctx: ExtensionCommandContext, backendId?: string, modelId?: string) {
    let b = backendId ? byId(backendId) : undefined;
    if (!b) {
      if (backendId) { ctx.ui.notify(`Unknown backend "${backendId}". Use lmstudio, litellm or openrouter.`, "error"); return; }
      const pick = await ctx.ui.select("Connect to", defs.map((d) => d.label));
      if (!pick) return;
      b = defs[defs.map((d) => d.label).indexOf(pick)];
    }
    if (!b.apiKey) { ctx.ui.notify(`No API key for ${b.id}: set ${b.keyVar} in ~/localllm/.env`, "error"); return; }
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
