/** Fake pi ExtensionAPI and extension context for driving the entry points without pi. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export type Handler = (ev: any, ctx: any) => Promise<any> | any;

export function makePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions?: (p: string) => any }>();
  const providers: any[] = [];
  const tools: string[] = [];
  const unregistered: string[] = [];
  const entries: any[] = [];
  const setModelCalls: any[] = [];
  // pi's shared event bus (core/event-bus.ts): an EventEmitter whose handlers are async-wrapped.
  const emitter = new EventEmitter();
  const events = {
    emit: (channel: string, data: unknown) => { emitter.emit(channel, data); },
    on: (channel: string, handler: (data: unknown) => unknown) => {
      const safe = async (data: unknown) => { try { await handler(data); } catch (e) { console.error(e); } };
      emitter.on(channel, safe);
      return () => { emitter.off(channel, safe); };
    },
  };
  const pi = {
    events,
    getThinkingLevel: () => "off",
    on(ev: string, h: Handler) { handlers.set(ev, [...(handlers.get(ev) ?? []), h]); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    registerProvider(name: string, config: any) { providers.push({ name, config }); },
    registerTool(tool: any) { tools.push(tool.name); },
    unregisterProvider(name: string) { unregistered.push(name); },
    appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
    async setModel(model: any) { setModelCalls.push(model); return true; },
    async emit(ev: string, event: any, ctx: any) { let result: any; for (const h of handlers.get(ev) ?? []) { const r = await h(event, ctx); if (r !== undefined) result = r; } return result; },
    handlers, commands, providers, tools, unregistered, entries, setModelCalls,
  };
  return pi;
}

export function tmpAgentDir(settings: any = {}) {
  const root = mkdtempSync(join(tmpdir(), "mgm-test-"));
  const dir = join(root, ".pi"); mkdirSync(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  process.env.PI_CODING_AGENT_DIR = dir;
  return { dir, root, read: () => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), exists: () => existsSync(join(dir, "settings.json")), env: () => (existsSync(join(root, ".env")) ? readFileSync(join(root, ".env"), "utf8") : "") };
}

export type FakeModel = { provider: string; id: string; contextWindow: number; maxTokens: number; cost?: any; reasoning?: boolean };

export function makeCtx(opts: { model?: FakeModel; models?: FakeModel[]; auth?: (m: FakeModel) => boolean; entries?: any[]; usage?: { tokens: number; contextWindow: number; percent: number }; complete?: (model: FakeModel, ctx: any, o: any) => Promise<any>; hasUI?: boolean } = {}) {
  const models = opts.models ?? (opts.model ? [opts.model] : []);
  const notices: { msg: string; type: string }[] = [];
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, any>();
  const answers: (string | undefined)[] = [];   // scripted select/input answers, FIFO
  const compactCalls: any[] = [];
  const completes: any[] = [];
  let header: any;
  const ctx = {
    model: opts.model,
    hasUI: opts.hasUI ?? true,
    mode: "tui",
    cwd: process.cwd(),
    ui: {
      notify: (msg: string, type = "info") => notices.push({ msg, type }),
      setStatus: (k: string, t: string | undefined) => statuses.set(k, t),
      setWidget: (k: string, w: any) => widgets.set(k, w),
      setHeader: (h: any) => { header = h; },
      setTitle: () => {},
      select: async (_title: string, options: string[]) => { const a = answers.shift(); if (a === undefined) return undefined; const hit = options.find((o) => o === a || o.startsWith(a)); if (!hit) throw new Error(`scripted answer "${a}" not among options: ${options.join(" | ")}`); return hit; },
      input: async (_title: string, _placeholder?: string) => answers.shift(),
      editor: async (_title: string, _prefill?: string) => answers.shift(),
      confirm: async () => true,
    },
    modelRegistry: {
      find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
      getAvailable: () => models,
      getAll: () => models,
      hasConfiguredAuth: (m: FakeModel) => (opts.auth ? opts.auth(m) : true),
      complete: async (model: FakeModel, c: any, o: any) => { completes.push({ model, c, o }); return opts.complete ? opts.complete(model, c, o) : { stopReason: "stop", content: [{ type: "text", text: "## Goal\nsummary" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } } }; },
    },
    sessionManager: { getEntries: () => opts.entries ?? [], getBranch: () => opts.entries ?? [] },
    getContextUsage: () => opts.usage ?? { tokens: 0, contextWindow: opts.model?.contextWindow ?? 128_000, percent: 0 },
    compact: (o: any) => compactCalls.push(o),
    notices, statuses, widgets, answers, compactCalls, completes, get header() { return header; },
  };
  return ctx;
}

export const text = (t: string) => [{ type: "text", text: t }];
export const userMsg = (t: string) => ({ type: "message", id: `u${Math.random()}`, message: { role: "user", content: text(t) } });
export const asstCall = (name: string, t = "") => ({ type: "message", id: `a${Math.random()}`, message: { role: "assistant", content: [...text(t), { type: "toolCall", id: "c", name, arguments: {} }] } });
export const toolResult = (t: string, name = "read") => ({ type: "message", id: `t${Math.random()}`, message: { role: "toolResult", toolName: name, toolCallId: "c", content: text(t) } });

/** Route global fetch to an in-test handler; returns a restore function. Unmatched URLs get a 404. */
export function stubFetch(routes: Record<string, (init?: any) => any>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    for (const [prefix, handler] of Object.entries(routes)) if (u.startsWith(prefix) || u.includes(prefix)) {
      const body = handler(init); if (body instanceof Error) throw body;
      if (body && typeof body === "object" && "__status" in body) return new Response(typeof body.body === "string" ? body.body : JSON.stringify(body.body), { status: body.__status, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as any;
  return () => { globalThis.fetch = real; };
}
