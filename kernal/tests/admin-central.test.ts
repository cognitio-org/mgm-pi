/**
 * /admin and the central settings (kernal-admin/central.ts, #398 CA-9): each value's source, the two
 * save targets (the account's profile or user document, versioned with If-Match; this machine's
 * config.local.json), locked values read-only, provider keys typed while signed in going to the
 * account and not .env, and signed-out behaviour unchanged. The session, Outfitter and the
 * environment are fakes; nothing leaves the process.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePi, tmpAgentDir } from "./harness.ts";
import {
  _resetCentralConfig, _setCentralConfigDeps, configCachePath, localOverridesPath, reloadConfig, resolve, setLocalOverride, type ConfigResponse,
} from "../.pi/extensions/_shared/central-config.ts";
import {
  _setAdminCentralDeps, accountTarget, parseEtag, saveSettings, settingsRows, settingsView, validateSettingValues, writeProviderKey, listProviderKeys,
} from "../.pi/extensions/kernal-admin/central.ts";
import { createApi } from "../.pi/extensions/kernal-admin/index.ts";

const API = "https://link.outfitter.test";
const EMAIL = "a@example.com";
const ACCOUNT = { api: API, email: EMAIL, userId: "u_1", deviceId: "dev_aaaaaaaaaaaaaaaa", deviceName: "mbp" };
const OR_KEY = "sk-or-v1-ACCOUNT-SECRET-5678";

type Call = { method: string; path: string; auth?: string; ifMatch?: string; body?: any };
type Route = (call: Call) => { status?: number; body?: unknown; etag?: string };

/** Outfitter, by method and path; every call recorded. */
function fakeOutfitter(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fn = (async (url: URL | string, init?: RequestInit) => {
    const u = new URL(String(url));
    const h = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init?.method ?? "GET", path: u.pathname, auth: h.authorization, ifMatch: h["if-match"], body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const { status = 200, body, etag } = route(call);
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json", ...(etag ? { etag } : {}) } });
  }) as typeof fetch;
  return { fn, calls };
}

function response(values: ConfigResponse["values"], extra: Partial<ConfigResponse> = {}): ConfigResponse {
  return { schemaVersion: 1, account: { email: EMAIL, userId: "u_1" }, profile: null, profiles: [], deviceId: ACCOUNT.deviceId, values, resolvedAt: "2026-10-04T10:00:00.000Z", ...extra };
}

let home: string;
let signedIn: boolean;
let tokens: string[];
let reloads: number;
let shell: NodeJS.ProcessEnv;
let dotenv: Record<string, string>;
const now = Date.parse("2026-10-04T12:00:00.000Z");

function writeCache(resp: ConfigResponse, profile?: string) {
  const file = configCachePath(API, EMAIL, profile);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ api: API, email: EMAIL, profile: profile ?? null, fetchedAt: new Date(now).toISOString(), response: resp }));
}

function setup(f: typeof fetch = (async () => { throw new Error("no network in this test"); }) as typeof fetch) {
  const session = {
    loginState: () => (signedIn ? { signedIn: true as const, account: ACCOUNT } : { signedIn: false as const }),
    // Each call hands out the next token: the second one is what another Kernal rotated to.
    getAccessToken: async () => (signedIn ? tokens[Math.min(tokenCalls++, tokens.length - 1)] : undefined),
    getRouterKey: () => undefined,
    setRouterKey: () => {},
    outfitterApi: () => API,
  };
  let tokenCalls = 0;
  _resetCentralConfig();
  _setCentralConfigDeps({ session, env: () => shell, dotenv: () => dotenv, settings: () => ({}), now: () => now, warn: () => {}, fetch: f });
  _setAdminCentralDeps({});
  _setAdminCentralDeps({ session, fetch: f, reload: async () => { reloads++; return resolve(); } });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kernal-admin-central-"));
  process.env.KERNAL_HOME_DIR = home;
  delete process.env.KERNAL_CONFIG_CACHE_DIR;
  signedIn = true;
  tokens = ["kda_one"];
  reloads = 0;
  shell = { OUTFITTER_API: API };
  dotenv = {};
  setup();
});
afterEach(() => { _setAdminCentralDeps({}); _resetCentralConfig(); });

describe("rows: each value's source and whether it can be edited", () => {
  test("sources in /admin's words, locked values read-only with \"set by your Sysop\"", () => {
    writeCache(response({
      "router.baseUrl": { value: "https://router.fleet.test/v1", source: "fleet", locked: true },
      "model.default": { value: "claude-auto-llm", source: "profile", sourceName: "work" },
      "voice.language": { value: "de", source: "user" },
      "telemetry.sentry.enabled": { value: false, source: "default", locked: true },
    }, { profile: "work", profiles: ["work"] }), "work");
    shell = { OUTFITTER_API: API, KERNAL_PROFILE: "work", KERNAL_SUMMARY_MODEL: "from-shell" };
    dotenv = {};
    setup();
    const r = resolve();
    const rows = settingsRows(r, accountTarget(r), {}, {});
    const row = (k: string) => rows.find((x) => x.key === k)!;
    assert.equal(row("model.default").sourceLabel, "profile work");
    assert.equal(row("voice.language").sourceLabel, "your account");
    assert.equal(row("compaction.summaryModel").sourceLabel, "shell (KERNAL_SUMMARY_MODEL)");
    assert.equal(row("router.baseUrl").sourceLabel, "fleet");
    assert.equal(row("router.baseUrl").locked, true);
    assert.equal(row("router.baseUrl").readOnly, "set by your Sysop");
    assert.equal(row("router.baseUrl").canAccount, false);
    assert.equal(row("router.baseUrl").canMachine, false);
    // Off by default is not the Sysop's doing: it only can't be turned on here.
    assert.equal(row("telemetry.sentry.enabled").locked, true);
    assert.equal(row("telemetry.sentry.enabled").readOnly, "off unless your Sysop turns it on");
    assert.equal(row("telemetry.sentry.enabled").canMachine, false);
    assert.equal(row("model.default").canAccount, true);
    assert.equal(row("model.default").canMachine, true);
  });

  test("a secret is never editable here and never shown in full; fleet-only keys say who sets them", () => {
    const rows = settingsRows(resolve(), { level: "user" }, {}, {});
    const key = rows.find((x) => x.key === "router.key")!;
    assert.match(key.readOnly!, /kernal login/);
    assert.equal(key.canMachine, false);
    const dsn = rows.find((x) => x.key === "telemetry.sentry.dsn")!;
    assert.equal(dsn.readOnly, "only your Sysop sets this");
  });

  test("the account target is the resolved profile, else the account-wide level; each row carries what the target holds", () => {
    assert.deepEqual(accountTarget({ ...resolve(), profile: "work" }), { level: "profile", name: "work" });
    assert.deepEqual(accountTarget({ ...resolve(), profile: null }), { level: "user" });
    const rows = settingsRows(resolve(), { level: "user" }, { "model.default": "gpt-x", "voice.enabled": "not a boolean" }, { "voice.enabled": true });
    const row = (k: string) => rows.find((x) => x.key === k)!;
    assert.equal(row("model.default").account, "gpt-x");
    assert.equal(row("voice.enabled").account, undefined, "a value of the wrong type is ignored");
    assert.equal(row("voice.enabled").machine, true);
    assert.equal(row("localHost.shareModels").canAccount, true);
    assert.equal(row("router.baseUrl").canAccount, false, "router.baseUrl has no user level");
    assert.equal(row("router.baseUrl").canMachine, true);
  });

  test("an opt-out this machine set stays this machine's to undo, never \"set by your Sysop\"", async () => {
    writeCache(response({ "telemetry.sentry.enabled": { value: true, source: "fleet" } }));
    setup();
    setLocalOverride("telemetry.sentry.enabled", false);
    const r = resolve();
    assert.deepEqual(r.values["telemetry.sentry.enabled"], { value: false, source: "local", override: "opt-out", locked: true });
    const row = settingsRows(r, { level: "user" }, {}, { "telemetry.sentry.enabled": false }).find((x) => x.key === "telemetry.sentry.enabled")!;
    assert.equal(row.readOnly, undefined);
    assert.equal(row.canMachine, true);
    const undo = await saveSettings({ target: "machine", values: { "telemetry.sentry.enabled": null } });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.deepEqual(resolve().values["telemetry.sentry.enabled"], { value: true, source: "fleet", override: "opt-out", locked: false });
  });

  test("an opt-out key off by default: this machine may turn it off, not on", async () => {
    signedIn = false;
    setup();
    const on = await saveSettings({ target: "machine", values: { "telemetry.sentry.enabled": true } });
    assert.equal(on.status, 422);
    assert.match((on.body.errors as any)["telemetry.sentry.enabled"], /Sysop turns it on/);
    assert.equal((await saveSettings({ target: "machine", values: { "telemetry.sentry.enabled": false } })).status, 200);
  });

  test("a machine save that .env or the shell still overrides says so", async () => {
    signedIn = false;
    dotenv = { LITELLM_BASE_URL: "https://dot.test/v1" };
    shell = { OUTFITTER_API: API, KERNAL_SUMMARY_MODEL: "from-shell" };
    setup();
    const r = await saveSettings({ target: "machine", values: { "router.baseUrl": "https://mine.test/v1", "compaction.summaryModel": "mine", "model.default": "fine" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = r.body.warnings as string[];
    assert.equal(w.length, 2);
    assert.match(w[0], /LITELLM_BASE_URL in \.env still wins/);
    assert.match(w[1], /KERNAL_SUMMARY_MODEL in the shell still wins/);
  });

  test("form values are checked against the schema; strings from a form are parsed; empty removes", () => {
    const ok = () => undefined;
    const { patch, errors } = validateSettingValues({ "voice.enabled": "true", "telemetry.sentry.tracesSampleRate": "2", "model.thinking": "loud", "model.default": "", "nope": 1 }, ok);
    assert.deepEqual(patch, { "voice.enabled": true, "model.default": null });
    assert.match(errors["telemetry.sentry.tracesSampleRate"], /from 0 to 1/);
    assert.match(errors["model.thinking"], /one of off/);
    assert.match(errors.nope, /not a setting/);
    assert.equal(parseEtag('W/"7"'), 7);
    assert.equal(parseEtag(undefined), undefined);
  });
});

describe("signed out: the machine only, no network", () => {
  beforeEach(() => { signedIn = false; setup(); });

  test("the view has no account target and makes no request", async () => {
    const v = await settingsView();
    assert.equal(v.signedIn, false);
    assert.equal(v.target, undefined);
    assert.ok(v.rows.every((r) => !r.canAccount));
    assert.ok(v.rows.find((r) => r.key === "model.default")!.canMachine);
  });

  test("an account save is refused; a machine save writes config.local.json", async () => {
    const refused = await saveSettings({ target: "account", values: { "model.default": "x" }, version: 0 });
    assert.equal(refused.status, 409);
    assert.match(String(refused.body.error), /kernal login/);
    const saved = await saveSettings({ target: "machine", values: { "model.default": "local-model", "voice.enabled": "false" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(JSON.parse(readFileSync(localOverridesPath(), "utf8")), { version: 1, values: { "model.default": "local-model", "voice.enabled": false } });
    assert.deepEqual(resolve().values["model.default"], { value: "local-model", source: "local", override: "any", locked: false });
    const removed = await saveSettings({ target: "machine", values: { "model.default": null } });
    assert.equal(removed.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(localOverridesPath(), "utf8")).values, { "voice.enabled": false });
  });

  test("a bad value or a key with no local level saves nothing", async () => {
    const r = await saveSettings({ target: "machine", values: { "model.default": "fine", "telemetry.sentry.dsn": "https://x.test/1" } });
    assert.equal(r.status, 422);
    assert.match((r.body.errors as any)["telemetry.sentry.dsn"], /this machine/);
    assert.ok(!existsSync(localOverridesPath()), "nothing written");
    assert.equal((await saveSettings({ target: "elsewhere", values: {} })).status, 400);
  });
});

describe("signed in: saving to the account", () => {
  // A central answer is cached unless a test says otherwise (see "no cached answer" below).
  beforeEach(() => { writeCache(response({})); });

  test("GET the profile document with the session token; its ETag is the version a save names", async () => {
    writeCache(response({}, { profile: "work", profiles: ["work", "home"] }), "work");
    shell = { OUTFITTER_API: API, KERNAL_PROFILE: "work" };
    const o = fakeOutfitter({
      "GET /api/config/profiles/work": () => ({ body: { id: "profile:u_1:work", level: "profile", name: "work", values: { "model.default": "gpt-p" }, version: 4 }, etag: 'W/"4"' }),
    });
    setup(o.fn);
    const v = await settingsView();
    assert.equal(v.signedIn, true);
    assert.deepEqual(v.target, { level: "profile", name: "work", label: "Save to my account (profile work)", version: 4 });
    assert.deepEqual(v.profiles, ["work", "home"]);
    assert.equal(v.rows.find((r) => r.key === "model.default")!.account, "gpt-p");
    assert.equal(o.calls[0].auth, "Bearer kda_one");
  });

  test("no profile: the account-wide document; a missing one is version 0", async () => {
    const o = fakeOutfitter({ "GET /api/config/user": () => ({ body: { id: "user:u_1", level: "user", values: {}, version: 0 } }) });
    setup(o.fn);
    const v = await settingsView();
    assert.deepEqual(v.target, { level: "user", label: "Save to my account", version: 0 });
  });

  test("Outfitter unreachable: rows from the cache, account saves off with the reason", async () => {
    setup((async () => { throw new Error("offline"); }) as typeof fetch);
    const v = await settingsView();
    assert.equal(v.target, undefined);
    assert.match(v.targetProblem!, /could not be reached/);
    assert.ok(v.rows.every((r) => !r.canAccount));
  });

  test("a save is a PUT with If-Match, only the changed keys, then a reload so the page shows the new source", async () => {
    const o = fakeOutfitter({
      "PUT /api/config/user": () => ({ body: { id: "user:u_1", level: "user", values: { "model.default": "gpt-new" }, version: 3 }, etag: 'W/"3"' }),
    });
    setup(o.fn);
    const r = await saveSettings({ target: "account", values: { "model.default": "gpt-new", "voice.language": "" }, version: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.version, 3);
    assert.match(String(r.body.message), /to your account/);
    const put = o.calls.find((c) => c.method === "PUT")!;
    assert.equal(put.ifMatch, 'W/"2"');
    assert.deepEqual(put.body, { values: { "model.default": "gpt-new", "voice.language": null } });
    assert.equal(reloads, 1);
    assert.ok(!existsSync(localOverridesPath()), "nothing on this machine");
  });

  test("to a profile: PUT /api/config/profiles/:name", async () => {
    writeCache(response({}, { profile: "work", profiles: ["work"] }), "work");
    shell = { OUTFITTER_API: API, KERNAL_PROFILE: "work" };
    const o = fakeOutfitter({ "PUT /api/config/profiles/work": () => ({ body: { version: 1 }, etag: 'W/"1"' }) });
    setup(o.fn);
    const r = await saveSettings({ target: "account", values: { "memory.mode": "tool" }, version: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(String(r.body.message), /profile work/);
    assert.equal(o.calls[0].path, "/api/config/profiles/work");
  });

  test("409 from Outfitter: \"changed elsewhere, reload\", never retried or overwritten", async () => {
    const o = fakeOutfitter({ "PUT /api/config/user": () => ({ status: 409, body: { error: "stale_version", current: { version: 9, values: {} } } }) });
    setup(o.fn);
    const r = await saveSettings({ target: "account", values: { "model.default": "x" }, version: 2 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "changed elsewhere, reload");
    assert.equal(r.body.stale, true);
    assert.equal(o.calls.filter((c) => c.method === "PUT").length, 1);
    assert.equal(reloads, 0);
  });

  test("the server's per-key refusal lands on the field", async () => {
    const o = fakeOutfitter({ "PUT /api/config/user": () => ({ status: 400, body: { error: "level_not_allowed", key: "model.default" } }) });
    setup(o.fn);
    const r = await saveSettings({ target: "account", values: { "model.default": "x" }, version: 0 });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.errors, { "model.default": "level_not_allowed" });
  });

  test("locked and secret keys are refused before any request; a version is required", async () => {
    writeCache(response({ "router.baseUrl": { value: "https://r.fleet.test/v1", source: "fleet", locked: true } }));
    const o = fakeOutfitter({});
    setup(o.fn);
    const r = await saveSettings({ target: "account", values: { "router.baseUrl": "https://mine.test/v1", "router.key": "sk-x" }, version: 0 });
    assert.equal(r.status, 422);
    assert.equal((r.body.errors as any)["router.baseUrl"], "set by your Sysop");
    assert.match((r.body.errors as any)["router.key"], /secret/);
    const m = await saveSettings({ target: "machine", values: { "router.baseUrl": "https://mine.test/v1" } });
    assert.equal((m.body.errors as any)["router.baseUrl"], "set by your Sysop", "locked on this machine too");
    assert.equal((await saveSettings({ target: "account", values: { "model.default": "x" } })).status, 400, "no version");
    assert.equal(o.calls.length, 0);
  });

  test("no cached answer: the account's default profile is asked for before choosing the target", async () => {
    rmSync(configCachePath(API, EMAIL, undefined));
    const o = fakeOutfitter({
      "GET /api/config": () => ({ body: response({}, { profile: "work", profiles: ["work"] }) }),
      "GET /api/config/profiles/work": () => ({ body: { values: {}, version: 2 }, etag: 'W/"2"' }),
      "PUT /api/config/profiles/work": () => ({ body: { version: 3 }, etag: 'W/"3"' }),
    });
    setup(o.fn);
    _setAdminCentralDeps({ reload: () => reloadConfig() });
    const v = await settingsView();
    assert.deepEqual(v.target, { level: "profile", name: "work", label: "Save to my account (profile work)", version: 2 });
    const r = await saveSettings({ target: "account", values: { "model.default": "x" }, version: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(o.calls.find((c) => c.method === "PUT")!.path, "/api/config/profiles/work");
    assert.ok(!o.calls.some((c) => c.path === "/api/config/user"), "never the account-wide level");
  });

  test("no cached answer and Outfitter unreachable: account saves are off, nothing is sent", async () => {
    rmSync(configCachePath(API, EMAIL, undefined));
    const o = fakeOutfitter({});
    setup(o.fn);
    const v = await settingsView();
    assert.equal(v.target, undefined);
    assert.match(v.targetProblem!, /learn your account's profile/);
    const r = await saveSettings({ target: "account", values: { "model.default": "x" }, version: 0 });
    assert.equal(r.status, 502);
    assert.ok(!o.calls.some((c) => c.method === "PUT"));
  });

  test("after a 401 the token is read again and the request retried once", async () => {
    tokens = ["kda_old", "kda_new"];
    const o = fakeOutfitter({ "PUT /api/config/user": (c) => (c.auth === "Bearer kda_new" ? { body: { version: 1 } } : { status: 401, body: { error: "unauthorized" } }) });
    setup(o.fn);
    const r = await saveSettings({ target: "account", values: { "model.default": "x" }, version: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(o.calls.map((c) => c.auth), ["Bearer kda_old", "Bearer kda_new"]);
  });
});

describe("signed in: provider keys go to the account", () => {
  test("PUT and DELETE /api/me/provider-keys/:provider; the list carries last four only", async () => {
    const o = fakeOutfitter({
      "PUT /api/me/provider-keys/openrouter": () => ({ body: { provider: "openrouter", last4: "5678", setAt: "2026-10-04T12:00:00.000Z" } }),
      "DELETE /api/me/provider-keys/openrouter": () => ({ status: 204 }),
      "GET /api/me/provider-keys": () => ({ body: [{ provider: "openrouter", last4: "5678", setAt: "2026-10-04T12:00:00.000Z", value: "never" }, { provider: "bogus", last4: "x" }] }),
      "PUT /api/me/provider-keys/deepgram": () => ({ status: 400, body: { error: "invalid_value" } }),
    });
    setup(o.fn);
    assert.equal(await writeProviderKey(ACCOUNT, "openrouter", OR_KEY), undefined);
    assert.deepEqual(o.calls[0].body, { value: OR_KEY });
    assert.equal(await writeProviderKey(ACCOUNT, "openrouter", null), undefined);
    assert.match((await writeProviderKey(ACCOUNT, "deepgram", "short"))!, /8 to 512/);
    assert.match((await writeProviderKey(ACCOUNT, "nope", "x"))!, /not a provider/);
    assert.deepEqual(await listProviderKeys(ACCOUNT), [{ provider: "openrouter", last4: "5678", setAt: "2026-10-04T12:00:00.000Z" }]);
  });
});

describe("/admin routes", () => {
  // Never the person's own ~/localllm/.env or index config: a temporary home for these.
  const fakeHome = mkdtempSync(join(tmpdir(), "kernal-admin-central-home-"));
  process.env.HOME = fakeHome; process.chdir(fakeHome);
  process.env.KERNAL_INDEX_CONFIG = join(fakeHome, "cbi", "config.json");
  process.env.KERNAL_NO_DISCOVERY = "1";
  const store = tmpAgentDir({});
  let envFile: string;
  beforeEach(() => {
    envFile = join(store.root, ".env");
    writeFileSync(envFile, "LMSTUDIO_MODEL=qwen\nOPENROUTER_API_KEY=sk-or-v1-OLD-LOCAL-KEY-0000\n");
    delete process.env.OPENROUTER_API_KEY;
  });
  const routes = () => {
    const pi = makePi();
    return createApi({ pi: pi as any, ctx: () => undefined, server: () => undefined, stop: () => {} });
  };

  test("signed in, an OpenRouter key typed on Connections goes to the account, and the .env copy is removed", async () => {
    let stored: string | undefined;
    const o = fakeOutfitter({
      "PUT /api/me/provider-keys/openrouter": (c) => { stored = c.body.value; return { body: { provider: "openrouter", last4: "5678", setAt: "t" } }; },
      "POST /api/device/provider-keys": () => ({ body: { keys: stored ? { openrouter: stored } : {} } }),
    });
    setup(o.fn);
    const r = await routes()({ method: "POST", path: "/connections", query: new URLSearchParams(), body: { OPENROUTER_API_KEY: OR_KEY, LMSTUDIO_MODEL: "qwen-2" } });
    assert.equal(r.status ?? 200, 200, JSON.stringify(r.body));
    assert.equal(stored, OR_KEY);
    const text = readFileSync(envFile, "utf8");
    assert.ok(!text.includes(OR_KEY), "the key is not in .env");
    assert.match(text, /^OPENROUTER_API_KEY=$/m, "the old local copy is gone");
    assert.match(text, /^LMSTUDIO_MODEL=qwen-2$/m, "other values still go to .env");
    assert.deepEqual((r.body as any).savedToAccount, ["OPENROUTER_API_KEY"]);
    assert.match((r.body as any).message, /1 key to your account \(a@example.com\) and 1 setting to/);
    assert.ok(!JSON.stringify(r.body).includes(OR_KEY));
  });

  test("signed in, Remove on Connections takes away a local key only, never the account's", async () => {
    const o = fakeOutfitter({ "DELETE /api/me/provider-keys/openrouter": () => ({ status: 204 }), "POST /api/device/provider-keys": () => ({ body: { keys: { openrouter: OR_KEY } } }) });
    setup(o.fn);
    const r = await routes()({ method: "POST", path: "/connections", query: new URLSearchParams(), body: { clear: ["OPENROUTER_API_KEY"] } });
    assert.equal(r.status ?? 200, 200, JSON.stringify(r.body));
    assert.equal(o.calls.filter((c) => c.method === "DELETE").length, 0, "the account's key is kept");
    assert.match(readFileSync(envFile, "utf8"), /^OPENROUTER_API_KEY=$/m, "the .env copy is gone");
    // No local copy left: now Remove is the account's key in use, and goes to Outfitter.
    const again = await routes()({ method: "POST", path: "/connections", query: new URLSearchParams(), body: { clear: ["OPENROUTER_API_KEY"] } });
    assert.equal(again.status ?? 200, 200, JSON.stringify(again.body));
    assert.equal(o.calls.filter((c) => c.method === "DELETE").length, 1);
  });

  test("signed in, a key moved to the account names another .env that still overrides it", async () => {
    const other = join(fakeHome, ".env");
    writeFileSync(other, "OPENROUTER_API_KEY=sk-or-v1-PROJECT-KEY-1111\n");
    try {
      const o = fakeOutfitter({
        "PUT /api/me/provider-keys/openrouter": () => ({ body: { provider: "openrouter", last4: "5678", setAt: "t" } }),
        "POST /api/device/provider-keys": () => ({ body: { keys: { openrouter: OR_KEY } } }),
      });
      setup(o.fn);
      const r = await routes()({ method: "POST", path: "/connections", query: new URLSearchParams(), body: { OPENROUTER_API_KEY: OR_KEY } });
      assert.equal(r.status ?? 200, 200, JSON.stringify(r.body));
      // process.cwd() is the real path (/private/var/... on macOS), so match the file by its tail.
      assert.match((r.body as any).warnings.OPENROUTER_API_KEY, /kernal-admin-central-home-[^/]+\/\.env still wins over your account's key: remove it there/);
    } finally {
      rmSync(other, { force: true });
    }
  });

  test("signed in, a refused key saves nothing anywhere", async () => {
    const o = fakeOutfitter({ "PUT /api/me/provider-keys/openrouter": () => ({ status: 502, body: { error: "secret_write_failed" } }) });
    setup(o.fn);
    const r = await routes()({ method: "POST", path: "/connections", query: new URLSearchParams(), body: { OPENROUTER_API_KEY: OR_KEY, LMSTUDIO_MODEL: "qwen-3" } });
    assert.equal(r.status, 422);
    assert.match((r.body as any).errors.OPENROUTER_API_KEY, /secret_write_failed/);
    assert.match(readFileSync(envFile, "utf8"), /^LMSTUDIO_MODEL=qwen$/m, ".env untouched");
  });

  test("signed out, Connections writes .env exactly as before and asks Outfitter nothing", async () => {
    signedIn = false;
    const o = fakeOutfitter({});
    setup(o.fn);
    const r = await routes()({ method: "POST", path: "/connections", query: new URLSearchParams(), body: { OPENROUTER_API_KEY: OR_KEY } });
    assert.equal(r.status ?? 200, 200, JSON.stringify(r.body));
    assert.match(readFileSync(envFile, "utf8"), new RegExp(`^OPENROUTER_API_KEY=${OR_KEY}$`, "m"));
    assert.equal(o.calls.length, 0);
    const c = await routes()({ method: "GET", path: "/connections", query: new URLSearchParams(), body: {} });
    assert.equal((c.body as any).account, undefined);
    delete process.env.OPENROUTER_API_KEY;
  });

  test("GET /settings lists the account's keys; POST /settings/provider-key writes one and never echoes it", async () => {
    const o = fakeOutfitter({
      "GET /api/config/user": () => ({ body: { values: {}, version: 0 } }),
      "GET /api/me/provider-keys": () => ({ body: [{ provider: "deepgram", last4: "9999", setAt: "t" }] }),
      "PUT /api/me/provider-keys/deepgram": () => ({ body: { provider: "deepgram", last4: "1234", setAt: "t" } }),
      "POST /api/device/provider-keys": () => ({ body: { keys: {} } }),
    });
    setup(o.fn);
    const api = routes();
    const g = await api({ method: "GET", path: "/settings", query: new URLSearchParams(), body: {} });
    assert.deepEqual((g.body as any).providerKeys.keys, [{ provider: "deepgram", last4: "9999", setAt: "t" }]);
    assert.ok((g.body as any).providerKeys.providers.includes("openrouter"));
    const p = await api({ method: "POST", path: "/settings/provider-key", query: new URLSearchParams(), body: { provider: "deepgram", value: "  dg-SECRET-VALUE-1234 " } });
    assert.equal(p.status ?? 200, 200, JSON.stringify(p.body));
    assert.deepEqual(o.calls.find((c) => c.method === "PUT")!.body, { value: "dg-SECRET-VALUE-1234" });
    assert.ok(!JSON.stringify(p.body).includes("dg-SECRET-VALUE-1234"));
    const bad = await api({ method: "POST", path: "/settings/provider-key", query: new URLSearchParams(), body: { provider: "deepgram", value: "two words" } });
    assert.equal(bad.status, 422);
    assert.equal((await api({ method: "POST", path: "/settings/provider-key", query: new URLSearchParams(), body: { provider: "x", value: "abcdefgh" } })).status, 400);
  });

  test("signed out, the provider-key route refuses and GET /settings has no keys card", async () => {
    signedIn = false;
    setup();
    const api = routes();
    assert.equal((await api({ method: "POST", path: "/settings/provider-key", query: new URLSearchParams(), body: { provider: "openrouter", value: OR_KEY } })).status, 409);
    const g = await api({ method: "GET", path: "/settings", query: new URLSearchParams(), body: {} });
    assert.equal((g.body as any).signedIn, false);
    assert.equal((g.body as any).providerKeys, undefined);
  });
});

describe("the Settings page", () => {
  test("is in the nav, parses, offers both save targets and says when a value changed elsewhere", async () => {
    const { APP_JS } = await import("../.pi/extensions/kernal-admin/app.ts");
    assert.doesNotThrow(() => new Function(APP_JS));
    assert.match(APP_JS, /\{ id: "settings", label: "Settings"/);
    assert.match(APP_JS, /"Only this machine"/);
    assert.match(APP_JS, /Changed elsewhere, reload/);
    assert.match(APP_JS, /"\/settings\/provider-key"/);
    assert.equal((APP_JS.match(/innerHTML\s*=/g) ?? []).length, 1, "still only the static icon set as markup");
  });
});
