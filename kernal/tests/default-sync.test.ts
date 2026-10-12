/**
 * A default set inside Kernal goes to the account (#437, owner decision 2026-10-04;
 * _shared/default-sync.ts): pi's Ctrl+S in the model picker and the default thinking level write
 * settings.json, and Kernal saves that to the account (profile or user level) with the versioned
 * PUT. A per-session change never does, nor does Kernal's own /connect write; signed out and inside
 * a Drive nothing leaves the machine; a stale version is retried once; this machine's own pin of the
 * same key is removed. The session, Outfitter and the environment are fakes.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx, makePi, tmpAgentDir } from "./harness.ts";
import { _resetCentralConfig, _setCentralConfigDeps, configCachePath, localOverridesPath, type ConfigResponse } from "../.pi/extensions/_shared/central-config.ts";
import { _setAdminCentralDeps } from "../.pi/extensions/kernal-admin/central.ts";
import { pendingDefaults, recordPath, registerDefaultSync, syncDefaults, type SyncResult } from "../.pi/extensions/_shared/default-sync.ts";
import configExtension from "../.pi/extensions/kernal-config/index.ts";

const API = "https://link.outfitter.test";
const EMAIL = "a@example.com";
const ACCOUNT = { api: API, email: EMAIL, userId: "u_1", deviceId: "dev_aaaaaaaaaaaaaaaa", deviceName: "mbp" };

const tmp = mkdtempSync(join(tmpdir(), "kernal-defsync-"));
process.env.HOME = tmp; process.chdir(tmp);   // no real ~/localllm/.env in reach
const connect = await import("../.pi/extensions/connect/index.ts");

let home: string;
let signedIn: boolean;
let fetchImpl: typeof fetch;
const now = Date.parse("2026-10-04T12:00:00.000Z");
const session = {
  loginState: () => (signedIn ? { signedIn: true as const, account: ACCOUNT } : { signedIn: false as const }),
  getAccessToken: async () => (signedIn ? "kda_test" : undefined),
  getRouterKey: () => undefined,
  setRouterKey: () => {},
  outfitterApi: () => API,
};

function setup() {
  _resetCentralConfig();
  _setCentralConfigDeps({
    session, env: () => ({ OUTFITTER_API: API }), dotenv: () => ({}), settings: () => ({}), shippedSettings: () => ({}), voiceSettings: () => ({}),
    now: () => now, warn: () => {}, fetch: (...a: Parameters<typeof fetch>) => fetchImpl(...a),
  });
  _setAdminCentralDeps({});
  _setAdminCentralDeps({ session, fetch: (...a: Parameters<typeof fetch>) => fetchImpl(...a) });
}

function response(values: ConfigResponse["values"], extra: Partial<ConfigResponse> = {}): ConfigResponse {
  return { schemaVersion: 2, account: { email: EMAIL, userId: "u_1" }, profile: null, profiles: [], values, resolvedAt: "2026-10-04T10:00:00.000Z", ...extra };
}

function writeCache(resp: ConfigResponse) {
  const file = configCachePath(API, EMAIL, undefined);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ api: API, email: EMAIL, profile: null, fetchedAt: new Date(now).toISOString(), response: resp }));
}

type Call = { method: string; path: string; ifMatch?: string; body?: any };

/** Outfitter with profile "work" at version 5; `puts` answers each PUT in turn (default 200). */
function outfitter(puts: number[] = []) {
  const calls: Call[] = [];
  let version = 5;
  fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const u = new URL(String(url));
    const h = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? "GET";
    calls.push({ method, path: u.pathname, ifMatch: h["if-match"], body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (body: unknown, status = 200, etag?: string) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(etag ? { etag } : {}) } });
    if (u.pathname === "/api/config") return json(response({}, { profile: "work", profiles: ["work"] }));
    if (u.pathname === "/api/config/profiles/work" && method === "GET") return json({ values: {}, version }, 200, `W/"${version}"`);
    if (u.pathname === "/api/config/profiles/work" && method === "PUT") {
      const status = puts.shift() ?? 200;
      if (status === 409) { version++; return json({ error: "stale" }, 409); }
      version++;
      return json({ version }, status, `W/"${version}"`);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return calls;
}

let agent: ReturnType<typeof tmpAgentDir>;
/** pi writing its own defaults, as SettingsManager does on Ctrl+S (the rest of the file kept). */
function piWrites(patch: Record<string, string>) {
  const file = join(agent.dir, "settings.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }, null, 2));
}

/** registerDefaultSync on a fake pi; resolves each run's result in order. */
function start() {
  const pi = makePi();
  const results: SyncResult[] = [];
  const waiters: ((r: SyncResult) => void)[] = [];
  registerDefaultSync(pi as any, { settleMs: 5, onSynced: (r) => { results.push(r); waiters.shift()?.(r); } });
  const next = () => new Promise<SyncResult>((res) => waiters.push(res));
  return { pi, ctx: makeCtx(), results, next };
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kernal-defsync-home-"));
  process.env.KERNAL_HOME_DIR = home;
  process.env.KERNAL_VOICE_SETTINGS = join(home, "pi-listen", "settings.json");
  delete process.env.KERNAL_CONFIG_CACHE_DIR;
  delete process.env.KERNAL_SANDBOX;
  signedIn = true;
  fetchImpl = (async () => { throw new Error("no network in this test"); }) as typeof fetch;
  agent = tmpAgentDir({ defaultProvider: "litellm", defaultModel: "old-model", defaultThinkingLevel: "medium", theme: "dark" });
  writeCache(response({}, { profile: "work", profiles: ["work"] }));
  setup();
});
afterEach(() => { _setAdminCentralDeps({}); _resetCentralConfig(); });

describe("Ctrl+S saves the default to the account", () => {
  test("the record starts from settings.json: what is there already is not sent", async () => {
    const calls = outfitter();
    const { pi, ctx, results } = start();
    assert.ok(existsSync(recordPath(join(agent.dir, "settings.json"))));
    await pi.emit("agent_start", {}, ctx);
    assert.equal(pendingDefaults(), undefined);
    assert.equal(results.length, 0);
    assert.equal(calls.length, 0);
  });

  test("Ctrl+S (settings.json changed, then model_select): the versioned PUT to the profile", async () => {
    const calls = outfitter();
    const { pi, ctx, next } = start();
    piWrites({ defaultProvider: "litellm", defaultModel: "claude-sonnet-5" });
    const done = next();
    await pi.emit("model_select", { model: { provider: "litellm", id: "claude-sonnet-5" }, source: "set" }, ctx);
    const r = await done;
    assert.deepEqual(r.saved, ["model.provider", "model.default"]);
    const [put] = puts(calls);
    assert.equal(put.path, "/api/config/profiles/work");
    assert.equal(put.ifMatch, 'W/"5"');
    assert.deepEqual(put.body, { values: { "model.provider": "litellm", "model.default": "claude-sonnet-5" } });
    assert.match(ctx.notices.at(-1)!.msg, /^Saved litellm\/claude-sonnet-5 as your account's default model \(profile work\): new sessions on every machine/);
    // Synced once: the next turn sends nothing again.
    await pi.emit("agent_start", {}, ctx);
    assert.equal(puts(calls).length, 1);
  });

  test("a session-only change (Enter, cycling) leaves settings.json alone: nothing is sent", async () => {
    const calls = outfitter();
    const { pi, ctx, results } = start();
    await pi.emit("model_select", { model: { provider: "litellm", id: "claude-sonnet-5" }, source: "set" }, ctx);
    await pi.emit("model_select", { model: { provider: "litellm", id: "other" }, source: "cycle" }, ctx);
    await pi.emit("thinking_level_select", { level: "high", previousLevel: "medium" }, ctx);
    await new Promise((r) => setTimeout(r, 30));
    await pi.emit("agent_start", {}, ctx);
    assert.ok(results.every((r) => !r.saved));
    assert.equal(calls.length, 0);
    assert.equal(ctx.notices.length, 0);
  });

  test("the default thinking level, also when pi emits nothing (agent_start catches it)", async () => {
    const calls = outfitter();
    const { pi, ctx, next } = start();
    piWrites({ defaultThinkingLevel: "high" });
    let done = next();
    await pi.emit("thinking_level_select", { level: "high", previousLevel: "medium" }, ctx);
    assert.deepEqual((await done).saved, ["model.thinking"]);
    assert.deepEqual(puts(calls)[0].body, { values: { "model.thinking": "high" } });
    assert.match(ctx.notices.at(-1)!.msg, /Saved thinking high as your account's default thinking level/);
    // A persisted level equal to the session's emits no event: the next turn's start finds it.
    piWrites({ defaultThinkingLevel: "low" });
    done = next();
    await pi.emit("agent_start", {}, ctx);
    await done;
    assert.equal(puts(calls)[1].ifMatch, 'W/"6"');
    assert.deepEqual(puts(calls)[1].body, { values: { "model.thinking": "low" } });
  });

  test("Kernal's own /connect write is not echoed to the account", async () => {
    const calls = outfitter();
    const { pi, ctx } = start();
    connect.saveDefault("litellm", "picked-in-connect");
    await pi.emit("model_select", { model: { provider: "litellm", id: "picked-in-connect" }, source: "set" }, ctx);
    await new Promise((r) => setTimeout(r, 30));
    await pi.emit("agent_start", {}, ctx);
    assert.equal(calls.length, 0);
    assert.equal(JSON.parse(readFileSync(join(agent.dir, "settings.json"), "utf8")).defaultModel, "picked-in-connect");
  });

  test("signed out: settings.json only, nothing sent, and nothing left pending for a later sign-in", async () => {
    signedIn = false;
    setup();
    const calls = outfitter();
    const { pi, ctx, next } = start();
    piWrites({ defaultModel: "signed-out-choice" });
    const done = next();
    await pi.emit("model_select", {}, ctx);
    assert.match((await done).skipped!, /signed out/);
    assert.equal(calls.length, 0);
    assert.equal(pendingDefaults(), undefined);
    signedIn = true;
    setup();
    await pi.emit("agent_start", {}, ctx);
    assert.equal(calls.length, 0);
  });

  test("in a Drive: kernal-config registers no sync, and syncDefaults does nothing", async () => {
    process.env.KERNAL_SANDBOX = "1";
    const calls = outfitter();
    const pi = makePi();
    configExtension(pi as any, {});
    // The local-model thinking hook listens here. It does not write settings or the account.
    assert.ok(pi.handlers.get("model_select")?.length);
    assert.equal(pi.handlers.get("agent_start"), undefined);
    piWrites({ defaultModel: "in-drive" });
    await pi.emit("model_select", { model: { provider: "litellm", id: "local/ada-mbp/qwen" } });
    assert.equal(JSON.parse(readFileSync(join(agent.dir, "settings.json"), "utf8")).defaultModel, "in-drive");
    assert.match((await syncDefaults()).skipped!, /Drive/);
    assert.equal(calls.length, 0);
  });

  test("without Kernal's agent dir (a bare pi's ~/.pi/agent): nothing is registered or written", () => {
    const saved = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      const pi = makePi();
      assert.equal(registerDefaultSync(pi as any), undefined);
      assert.equal(pi.handlers.get("model_select"), undefined);
    } finally {
      process.env.PI_CODING_AGENT_DIR = saved;
    }
  });

  test("409 (changed elsewhere): the version is fetched again and the PUT retried once", async () => {
    const calls = outfitter([409]);
    const { pi, ctx, next } = start();
    piWrites({ defaultModel: "after-conflict" });
    const done = next();
    await pi.emit("model_select", {}, ctx);
    assert.deepEqual((await done).saved, ["model.provider", "model.default"]);
    assert.deepEqual(puts(calls).map((c) => c.ifMatch), ['W/"5"', 'W/"6"']);
    assert.equal(calls.filter((c) => c.method === "GET" && c.path === "/api/config/profiles/work").length, 2);
  });

  test("409 twice, offline, or an expired sign-in: one warning, the default stays on this machine, the session goes on", async () => {
    let calls = outfitter([409, 409]);
    let { pi, ctx, next } = start();
    piWrites({ defaultModel: "conflicted" });
    let done = next();
    await pi.emit("model_select", {}, ctx);
    assert.ok((await done).problem);
    assert.equal(puts(calls).length, 2);
    assert.equal(ctx.notices.length, 1);
    assert.equal(ctx.notices[0].type, "warning");
    assert.match(ctx.notices[0].msg, /^Couldn't save litellm\/conflicted to your account: changed elsewhere, reload\. Kept on this machine \(settings\.json\)/);
    assert.equal(JSON.parse(readFileSync(join(agent.dir, "settings.json"), "utf8")).defaultModel, "conflicted");

    fetchImpl = (async () => { throw new Error("offline"); }) as typeof fetch;
    piWrites({ defaultModel: "offline-choice" });
    done = next();
    await pi.emit("model_select", {}, ctx);
    assert.ok((await done).problem);
    assert.match(ctx.notices.at(-1)!.msg, /Couldn't save litellm\/offline-choice to your account: .*Kept on this machine/);

    fetchImpl = (async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as typeof fetch;
    piWrites({ defaultModel: "expired-choice" });
    done = next();
    await pi.emit("model_select", {}, ctx);
    assert.match((await done).problem!, /401/);
    assert.match(ctx.notices.at(-1)!.msg, /Couldn't save litellm\/expired-choice to your account: Outfitter answered 401.*Kept on this machine/);
    assert.equal(ctx.notices.length, 3, "one notice per failed save");
  });

  test("this machine's pin of the same key (config.local.json) is removed so the new default applies here", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(localOverridesPath(), JSON.stringify({ version: 1, values: { "model.default": "pinned-here", "model.thinking": "low", "voice.language": "de" } }));
    setup();
    outfitter();
    const { pi, ctx, next } = start();
    piWrites({ defaultModel: "new-default" });
    const done = next();
    await pi.emit("model_select", {}, ctx);
    await done;
    // Only the keys saved: the thinking pin and the rest stay.
    assert.deepEqual(JSON.parse(readFileSync(localOverridesPath(), "utf8")).values, { "model.thinking": "low", "voice.language": "de" });
    assert.match(ctx.notices.at(-1)!.msg, /This machine's own pin \(model\.default in config\.local\.json\) was removed so it applies here too\./);
  });

  test("a backend outside model.provider's choices goes into model.default as provider/id", async () => {
    const calls = outfitter();
    const { pi, ctx, next } = start();
    piWrites({ defaultProvider: "anthropic", defaultModel: "claude-x" });
    const done = next();
    await pi.emit("model_select", {}, ctx);
    await done;
    assert.deepEqual(puts(calls)[0].body, { values: { "model.default": "anthropic/claude-x" } });
  });

  test("a default set just before the last quit is saved at the next session_start, before the start-up model", async () => {
    const calls = outfitter();
    start();   // the earlier process: its record is on disk
    piWrites({ defaultModel: "set-then-quit" });
    const pi = makePi();
    const synced: SyncResult[] = [];
    configExtension(pi as any, { fetch: fetchImpl, onRefresh: () => {}, onDefaultsSynced: (r) => synced.push(r), argv: [] });
    await pi.emit("session_start", { reason: "startup" }, makeCtx());
    assert.deepEqual(synced[0]?.saved, ["model.provider", "model.default"]);
    assert.equal(puts(calls)[0].body.values["model.default"], "set-then-quit");
  });
});
