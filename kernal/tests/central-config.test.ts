/**
 * Central settings on Kernal (_shared/central-config.ts, #397 CA-8): the cache (keyed by api,
 * account and profile, 30-day expiry, no secrets), the layering central → device key → this
 * machine's overrides → .env → shell within each key's override rule, the background refresh,
 * provider keys in memory only, the router key re-mint, and connect's loadEnv layering. The session
 * (outfitter-session.ts), the network and the environment are fakes; nothing leaves the process.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_SETTINGS, _resetCentralConfig, _setCentralConfigDeps, activeProfile, combine, configCachePath, describeSource,
  displayValue, getValue, isCentralSource, layerCentralEnv, localOverridesPath, parseConfigResponse, providerKey,
  refreshConfig, refreshProviderKeys, reloadConfig, remintRouterKeyIfDue, resolve, setLocalOverride, startBackgroundRefresh,
  webOrigin, MAX_CACHE_AGE_MS, type ConfigResponse,
} from "../.pi/extensions/_shared/central-config.ts";
import { fleetFromConfig } from "../.pi/extensions/sentry/config.ts";

const API = "https://link.outfitter.test";
const EMAIL = "a@example.com";
const ACCOUNT = { api: API, email: EMAIL, userId: "u_1", deviceId: "dev_aaaaaaaaaaaaaaaa", deviceName: "mbp" };
const decl = (key: string) => KNOWN_SETTINGS.find((d) => d.key === key)!;

type RouterKey = { key: string; baseUrl: string; alias: string; expiresAt?: string };

function response(values: ConfigResponse["values"], extra: Partial<ConfigResponse> = {}): ConfigResponse {
  return {
    schemaVersion: 1,
    account: { email: EMAIL, userId: "u_1" },
    profile: null,
    profiles: [],
    deviceId: ACCOUNT.deviceId,
    values,
    resolvedAt: "2026-10-04T10:00:00.000Z",
    ...extra,
  };
}

/** A fetch that answers by path, recording each call. */
function fakeFetch(routes: Record<string, (init?: RequestInit) => { status?: number; body: unknown }>) {
  const calls: { url: string; method: string; auth?: string }[] = [];
  const fn = (async (url: URL | string, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), method: init?.method ?? "GET", auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    const route = routes[u.pathname];
    if (!route) return new Response("{}", { status: 404 });
    const { status = 200, body } = route(init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

let home: string;
let warnings: string[];
let routerKey: RouterKey | undefined;
let savedKeys: RouterKey[];
let signedIn: boolean;
let shell: NodeJS.ProcessEnv;
let dotenv: Record<string, string>;
let settings: Record<string, unknown>;
let now: number;

function setup(f?: typeof fetch) {
  _resetCentralConfig();
  _setCentralConfigDeps({
    session: {
      loginState: () => (signedIn ? { signedIn: true, account: ACCOUNT } : { signedIn: false }),
      getAccessToken: async () => (signedIn ? "kda_test" : undefined),
      getRouterKey: () => routerKey,
      setRouterKey: (k: RouterKey) => { savedKeys.push(k); routerKey = k; },
    },
    env: () => shell,
    dotenv: () => dotenv,
    settings: () => settings,
    now: () => now,
    warn: (line) => warnings.push(line),
    ...(f ? { fetch: f } : { fetch: (async () => { throw new Error("no network in this test"); }) as typeof fetch }),
  });
}

function writeCacheFile(resp: ConfigResponse, opts: { profile?: string; email?: string; fetchedAt?: string; api?: string } = {}) {
  const file = configCachePath(API, EMAIL, opts.profile);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ api: opts.api ?? API, email: opts.email ?? EMAIL, profile: opts.profile ?? null, fetchedAt: opts.fetchedAt ?? new Date(now).toISOString(), response: resp }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kernal-central-"));
  process.env.KERNAL_HOME_DIR = home;
  delete process.env.KERNAL_CONFIG_CACHE_DIR;
  warnings = [];
  routerKey = undefined;
  savedKeys = [];
  signedIn = true;
  shell = { OUTFITTER_API: API };
  dotenv = {};
  settings = {};
  now = Date.parse("2026-10-04T12:00:00.000Z");
  setup();
});

describe("profile", () => {
  test("KERNAL_PROFILE, trimmed; empty is none", () => {
    assert.equal(activeProfile({ KERNAL_PROFILE: " work " }), "work");
    assert.equal(activeProfile({ KERNAL_PROFILE: "  " }), undefined);
    assert.equal(activeProfile({}), undefined);
  });
});

describe("signed out", () => {
  beforeEach(() => { signedIn = false; setup(); });

  test("no central layer: defaults and the local layers, no account", () => {
    const r = resolve();
    assert.equal(r.api, null);
    assert.equal(r.account, null);
    assert.equal(r.fromCache, false);
    assert.deepEqual(r.values["router.baseUrl"], { value: "https://router.kernal.one/v1", source: "default", override: "none", locked: false });
    assert.equal(r.values["model.default"], undefined);
  });

  test("shell beats .env beats this machine's overrides; .env is not deprecated while signed out", () => {
    writeFileSync(localOverridesPath(), JSON.stringify({ version: 1, values: { "compaction.summaryModel": "from-file" } }));
    setup();
    assert.equal(resolve().values["compaction.summaryModel"].source, "local");
    dotenv = { KERNAL_SUMMARY_MODEL: "from-dotenv" };
    setup();
    assert.deepEqual(resolve().values["compaction.summaryModel"], { value: "from-dotenv", source: "dotenv", sourceName: "KERNAL_SUMMARY_MODEL", override: "any", locked: false });
    // bin/kernal exports .env into the process: the same value in the shell is still .env's.
    shell = { KERNAL_SUMMARY_MODEL: "from-dotenv" };
    setup();
    assert.equal(resolve().values["compaction.summaryModel"].source, "dotenv");
    shell = { KERNAL_SUMMARY_MODEL: "from-shell" };
    setup();
    assert.deepEqual(resolve().values["compaction.summaryModel"], { value: "from-shell", source: "env", sourceName: "KERNAL_SUMMARY_MODEL", override: "any", locked: false });
    assert.deepEqual(warnings, []);
  });

  test("the first env var set wins (LITELLM_AGENT_KEY before LITELLM_API_KEY)", () => {
    shell = { LITELLM_API_KEY: "sk-api", LITELLM_AGENT_KEY: "sk-agent" };
    setup();
    assert.equal(getValue("router.key"), "sk-agent");
  });

  test("refresh does nothing", async () => {
    assert.equal(await refreshConfig(), undefined);
    await startBackgroundRefresh();
    assert.deepEqual(readdirSync(home), []);
  });
});

describe("cache", () => {
  test("start-up reads the cache without the network", () => {
    writeCacheFile(response({ "model.default": { value: "claude-auto-llm", source: "user" } }, { profiles: ["work"] }));
    const r = resolve();
    assert.equal(r.fromCache, true);
    assert.equal(r.account, EMAIL);
    assert.deepEqual(r.profiles, ["work"]);
    assert.deepEqual(r.values["model.default"], { value: "claude-auto-llm", source: "user", override: "any", locked: false });
  });

  test("keyed by api, account and profile", () => {
    assert.notEqual(configCachePath(API, EMAIL, undefined), configCachePath(API, EMAIL, "work"));
    assert.notEqual(configCachePath(API, EMAIL, undefined), configCachePath(API, "b@example.com", undefined));
    assert.notEqual(configCachePath(API, EMAIL, undefined), configCachePath("https://other.test", EMAIL, undefined));
    assert.match(configCachePath(API, EMAIL, undefined), /config-cache\/[0-9a-f]{16}\.json$/);
  });

  test("a file written for another profile, account or api is ignored", () => {
    const resp = response({ "model.default": { value: "x", source: "user" } });
    writeCacheFile(resp, { profile: undefined, email: "b@example.com" });
    assert.equal(resolve().fromCache, false);
    writeCacheFile(resp, { api: "https://other.test" });
    setup();
    assert.equal(resolve().fromCache, false);
    // Written for the default profile, read for "work": another file, so nothing.
    writeCacheFile(resp);
    setup();
    assert.equal(resolve("work").fromCache, false);
    assert.equal(resolve().fromCache, true);
  });

  test("older than 30 days is ignored", () => {
    writeCacheFile(response({ "model.default": { value: "x", source: "user" } }), { fetchedAt: new Date(now - MAX_CACHE_AGE_MS - 1000).toISOString() });
    assert.equal(resolve().fromCache, false);
    assert.equal(getValue("model.default"), undefined);
  });

  test("resolved once per process and kept", () => {
    assert.equal(resolve().fromCache, false);
    writeCacheFile(response({ "model.default": { value: "x", source: "user" } }));
    assert.equal(resolve().fromCache, false);
  });
});

describe("refreshConfig", () => {
  test("fetches GET /api/config?profile= with the session's token and writes the cache 0600", async () => {
    const { fn, calls } = fakeFetch({ "/api/config": () => ({ body: response({ "model.default": { value: "work-model", source: "profile", sourceName: "work" } }, { profile: "work", profiles: ["personal", "work"] }) }) });
    setup(fn);
    const r = await refreshConfig({ profile: "work" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${API}/api/config?profile=work`);
    assert.equal(calls[0].auth, "Bearer kda_test");
    assert.equal(r?.profile, "work");
    assert.equal(r?.fromCache, false);
    assert.deepEqual(r?.values["model.default"], { value: "work-model", source: "profile", sourceName: "work", override: "any", locked: false });
    const file = configCachePath(API, EMAIL, "work");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const cached = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(cached.api, API);
    assert.equal(cached.email, EMAIL);
    assert.equal(cached.profile, "work");
    // A new process starts from it.
    setup();
    assert.equal(resolve("work").values["model.default"].value, "work-model");
    assert.equal(resolve("work").fromCache, true);
  });

  test("no profile: no query, and the server's default profile is reported", async () => {
    const { fn, calls } = fakeFetch({ "/api/config": () => ({ body: response({}, { profile: "personal", profiles: ["personal"] }) }) });
    setup(fn);
    const r = await refreshConfig();
    assert.equal(calls[0].url, `${API}/api/config`);
    assert.equal(r?.profile, "personal");
  });

  test("the process keeps its resolution until reloadConfig", async () => {
    const { fn } = fakeFetch({ "/api/config": () => ({ body: response({ "model.default": { value: "new", source: "user" } }) }) });
    setup(fn);
    assert.equal(getValue("model.default"), undefined);
    await refreshConfig();
    assert.equal(getValue("model.default"), undefined);
    const r = await reloadConfig();
    assert.equal(r.values["model.default"].value, "new");
    assert.equal(getValue("model.default"), "new");
  });

  test("concurrent calls share one request", async () => {
    const { fn, calls } = fakeFetch({ "/api/config": () => ({ body: response({}) }) });
    setup(fn);
    await Promise.all([refreshConfig(), refreshConfig(), refreshConfig()]);
    assert.equal(calls.length, 1);
  });

  test("offline, a 5xx or a malformed answer: undefined, and the cache is kept", async () => {
    writeCacheFile(response({ "model.default": { value: "kept", source: "user" } }));
    for (const route of [() => ({ status: 503, body: {} }), () => ({ body: { nope: true } })]) {
      const { fn } = fakeFetch({ "/api/config": route });
      setup(fn);
      assert.equal(await refreshConfig(), undefined);
      assert.equal(resolve().values["model.default"].value, "kept");
    }
    setup((async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    assert.equal(await refreshConfig(), undefined);
    assert.equal((await reloadConfig()).fromCache, true);
  });

  test("an unknown profile warns once and caches nothing", async () => {
    const { fn } = fakeFetch({ "/api/config": () => ({ status: 404, body: { error: "unknown_profile", profiles: ["personal"] } }) });
    setup(fn);
    assert.equal(await refreshConfig({ profile: "nope" }), undefined);
    assert.equal(await refreshConfig({ profile: "nope" }), undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Profile "nope" does not exist for a@example\.com \(profiles: personal\)/);
  });

  test("no access token (refresh refused): nothing fetched", async () => {
    const { fn, calls } = fakeFetch({ "/api/config": () => ({ body: response({}) }) });
    setup(fn);
    _setCentralConfigDeps({ session: { loginState: () => ({ signedIn: true, account: ACCOUNT }), getAccessToken: async () => undefined, getRouterKey: () => undefined, setRouterKey: () => {} } });
    assert.equal(await refreshConfig(), undefined);
    assert.equal(calls.length, 0);
  });
});

describe("a 401 on an authenticated call", () => {
  // Another Kernal rotated the pair after this one read it: the keychain now holds kda_new.
  function rotated() {
    let reads = 0;
    const tokens: string[] = [];
    _setCentralConfigDeps({
      session: {
        loginState: () => ({ signedIn: true, account: ACCOUNT }),
        getAccessToken: async () => { const t = reads++ === 0 ? "kda_old" : "kda_new"; tokens.push(t); return t; },
        getRouterKey: () => routerKey,
        setRouterKey: (k: RouterKey) => { savedKeys.push(k); routerKey = k; },
      },
    });
    return tokens;
  }
  const only = (body: unknown) => (init?: RequestInit) =>
    (init?.headers as Record<string, string>).authorization === "Bearer kda_new" ? { body } : { status: 401, body: { error: "invalid_token" } };

  test("re-reads the keychain once and retries once: settings, provider keys and the re-mint", async () => {
    routerKey = { key: "sk-old", baseUrl: "u", alias: "a" };
    const { fn, calls } = fakeFetch({
      "/api/config": only(response({ "model.default": { value: "m1", source: "user" } })),
      "/api/device/provider-keys": only({ keys: { openrouter: "sk-or-v1-acct" } }),
      "/api/device/router-key": only({ routerKey: { key: "sk-new", baseUrl: "u", alias: "a" } }),
    });
    setup(fn);
    rotated();
    assert.equal((await refreshConfig())?.values["model.default"].value, "m1");
    rotated();
    await refreshProviderKeys();
    assert.equal(providerKey("openrouter"), "sk-or-v1-acct");
    rotated();
    assert.equal(await remintRouterKeyIfDue({ force: true }), true);
    assert.deepEqual(calls.map((c) => c.auth), ["Bearer kda_old", "Bearer kda_new", "Bearer kda_old", "Bearer kda_new", "Bearer kda_old", "Bearer kda_new"]);
  });

  test("the same token again: no second request", async () => {
    const { fn, calls } = fakeFetch({ "/api/config": () => ({ status: 401, body: {} }) });
    setup(fn);
    assert.equal(await refreshConfig(), undefined);
    assert.equal(calls.length, 1);
  });
});

describe("the answer", () => {
  test("secret, unknown and mistyped keys are dropped, so none reaches the cache", async () => {
    const { fn } = fakeFetch({ "/api/config": () => ({ body: response({
      "router.key": { value: "sk-leak", source: "device" },
      "future.key": { value: 1, source: "fleet" },
      "voice.enabled": { value: "yes", source: "user" },
      "model.thinking": { value: "ultra", source: "user" },
      "telemetry.sentry.tracesSampleRate": { value: 2, source: "fleet" },
      "voice.language": { value: "de", source: "user" },
    }) }) });
    setup(fn);
    const r = await refreshConfig();
    assert.equal(r?.values["router.key"], undefined);
    assert.equal(r?.values["future.key"], undefined);
    assert.equal(r?.values["voice.enabled"].source, "default");
    assert.equal(r?.values["model.thinking"], undefined);
    assert.equal(r?.values["telemetry.sentry.tracesSampleRate"].value, 0.05);
    assert.equal(r?.values["voice.language"].value, "de");
    const text = readFileSync(configCachePath(API, EMAIL, undefined), "utf8");
    assert.doesNotMatch(text, /sk-leak|future\.key/);
  });

  test("parseConfigResponse refuses what isn't one", () => {
    assert.equal(parseConfigResponse(null), undefined);
    assert.equal(parseConfigResponse({ schemaVersion: 1 }), undefined);
    assert.equal(parseConfigResponse({ schemaVersion: 1, values: {} }), undefined);
    assert.ok(parseConfigResponse(response({})));
  });

  test("localAllowed: false from the server drops the local layers for that key", () => {
    writeCacheFile(response({ "model.default": { value: "central", source: "user", localAllowed: false } }));
    shell = { OUTFITTER_API: API };
    writeFileSync(localOverridesPath(), JSON.stringify({ version: 1, values: { "model.default": "mine" } }));
    setup();
    assert.equal(getValue("model.default"), "central");
  });
});

describe("override rules", () => {
  const L = (value: string | number | boolean, source: any, sourceName?: string) => ({ value, source, ...(sourceName ? { sourceName } : {}) });

  test("any: the lowest level that sets it wins", () => {
    assert.deepEqual(combine(decl("model.default"), L("central", "user"), undefined, [L("mine", "local")]), { value: "mine", source: "local", override: "any", locked: false });
    assert.equal(combine(decl("model.default"), L("central", "user"), undefined, [])?.value, "central");
    // A server default is no level: the local value wins, and with nothing local the default stays.
    assert.equal(combine(decl("voice.language"), L("en", "default"), undefined, [L("de", "env", "X")])?.value, "de");
    assert.equal(combine(decl("voice.language"), L("en", "default"), undefined, [])?.source, "default");
  });

  test("none: the fleet's router.baseUrl beats the shell and is locked; a default does not", () => {
    const fleet = combine(decl("router.baseUrl"), L("https://fleet.test/v1", "fleet"), undefined, [L("https://mine.test/v1", "env", "LITELLM_BASE_URL")]);
    assert.deepEqual(fleet, { value: "https://fleet.test/v1", source: "fleet", override: "none", locked: true });
    const mine = combine(decl("router.baseUrl"), L("https://router.kernal.one/v1", "default"), undefined, [L("https://mine.test/v1", "env", "LITELLM_BASE_URL")]);
    assert.equal(mine?.value, "https://mine.test/v1");
    assert.equal(mine?.locked, false);
  });

  test("opt-out: any level turns it off; a machine can't turn it on alone", () => {
    const d = decl("telemetry.sentry.enabled");
    assert.deepEqual(combine(d, L(true, "fleet"), undefined, [L(false, "local", "settings.json")]), { value: false, source: "local", sourceName: "settings.json", override: "opt-out", locked: true });
    assert.deepEqual(combine(d, L(false, "fleet"), undefined, []), { value: false, source: "fleet", override: "opt-out", locked: true });
    assert.deepEqual(combine(d, L(true, "fleet"), undefined, []), { value: true, source: "fleet", override: "opt-out", locked: false });
    assert.equal(combine(d, undefined, undefined, [L(true, "local")])?.value, false);
  });

  test("a key with no local level ignores the local layers", () => {
    assert.equal(combine(decl("telemetry.sentry.dsn"), undefined, undefined, [L("https://k@x.test/1", "local")]), undefined);
  });

  test("the legacy kernal.sentry: false in settings.json is still a local opt-out", () => {
    writeCacheFile(response({ "telemetry.sentry.enabled": { value: true, source: "fleet" } }));
    settings = { kernal: { sentry: false } };
    setup();
    assert.equal(getValue("telemetry.sentry.enabled"), false);
  });

  test("#424: the legacy kernal.sentryAgentTraces: false (and so on) still opt those signals out; a local true can't turn one on", () => {
    writeCacheFile(response({ "telemetry.sentry.agentTraces": { value: true, source: "fleet" }, "telemetry.sentry.metrics": { value: true, source: "fleet" } }));
    settings = { kernal: { sentryAgentTraces: false, sentryAgentContent: true } };
    setup();
    assert.equal(getValue("telemetry.sentry.agentTraces"), false);
    assert.equal(getValue("telemetry.sentry.metrics"), true);
    assert.equal(getValue("telemetry.sentry.agentContent"), false, "the default, whatever settings.json says");
  });
});

describe("router key", () => {
  test("from the keychain at level device; a local key still wins", () => {
    routerKey = { key: "sk-device-1234", baseUrl: "https://router.kernal.one/v1", alias: "kernal-device-x" };
    setup();
    assert.deepEqual(resolve().values["router.key"], { value: "sk-device-1234", source: "device", override: "any", locked: false });
    shell = { OUTFITTER_API: API, LITELLM_AGENT_KEY: "sk-mine" };
    setup();
    assert.equal(resolve().values["router.key"].source, "env");
  });

  test("re-minted when under 7 days remain", async () => {
    routerKey = { key: "sk-old", baseUrl: "https://router.kernal.one/v1", alias: "kernal-device-x", expiresAt: new Date(now + 3 * 86400_000).toISOString() };
    const { fn, calls } = fakeFetch({ "/api/device/router-key": () => ({ body: { routerKey: { key: "sk-new", baseUrl: "https://router.kernal.one/v1", alias: "kernal-device-x", expiresAt: "2027-01-01T00:00:00.000Z" } } }) });
    setup(fn);
    assert.equal(await remintRouterKeyIfDue(), true);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].auth, "Bearer kda_test");
    assert.deepEqual(savedKeys, [{ key: "sk-new", baseUrl: "https://router.kernal.one/v1", alias: "kernal-device-x", expiresAt: "2027-01-01T00:00:00.000Z" }]);
  });

  test("a re-mint replaces the deleted key in this process's resolution, and nothing else", async () => {
    routerKey = { key: "sk-old", baseUrl: "u", alias: "a" };
    writeCacheFile(response({ "model.default": { value: "m1", source: "user" } }));
    const { fn } = fakeFetch({ "/api/device/router-key": () => ({ body: { routerKey: { key: "sk-new", baseUrl: "u", alias: "a" } } }) });
    setup(fn);
    assert.equal(layerCentralEnv({}).LITELLM_AGENT_KEY, "sk-old");
    writeCacheFile(response({ "model.default": { value: "m2", source: "user" } }));   // a refresh landed meanwhile
    assert.equal(await remintRouterKeyIfDue({ force: true }), true);
    assert.equal(layerCentralEnv({}).LITELLM_AGENT_KEY, "sk-new");
    assert.equal(getValue("model.default"), "m1", "the rest waits for the next start or /config reload");
  });

  test("not re-minted with time left, without a key, or signed out", async () => {
    const { fn, calls } = fakeFetch({ "/api/device/router-key": () => ({ body: {} }) });
    routerKey = { key: "sk-old", baseUrl: "u", alias: "a", expiresAt: new Date(now + 30 * 86400_000).toISOString() };
    setup(fn);
    assert.equal(await remintRouterKeyIfDue(), false);
    routerKey = undefined;
    assert.equal(await remintRouterKeyIfDue(), false);
    signedIn = false;
    assert.equal(await remintRouterKeyIfDue({ force: true }), false);
    assert.equal(calls.length, 0);
  });
});

describe("provider keys", () => {
  test("delivered into memory only, never into the cache or process.env", async () => {
    const { fn, calls } = fakeFetch({
      "/api/device/provider-keys": () => ({ body: { keys: { openrouter: "sk-or-v1-secret", bogus: "x", deepgram: 3 } } }),
      "/api/config": () => ({ body: response({}) }),
      "/api/device/router-key": () => ({ body: {} }),
    });
    setup(fn);
    await startBackgroundRefresh();
    assert.equal(providerKey("openrouter"), "sk-or-v1-secret");
    assert.equal(providerKey("bogus"), undefined);
    assert.equal(providerKey("deepgram"), undefined);
    assert.equal(calls.find((c) => c.url.endsWith("/api/device/provider-keys"))?.method, "POST");
    assert.notEqual(process.env.OPENROUTER_API_KEY, "sk-or-v1-secret");
    for (const f of readdirSync(join(home, "config-cache"))) assert.doesNotMatch(readFileSync(join(home, "config-cache", f), "utf8"), /sk-or-v1-secret/);
  });

  test("a refused request leaves them as they were", async () => {
    const { fn } = fakeFetch({ "/api/device/provider-keys": () => ({ status: 403, body: {} }) });
    setup(fn);
    await refreshProviderKeys();
    assert.equal(providerKey("openrouter"), undefined);
  });
});

describe(".env deprecation", () => {
  test("one warning per variable per process, signed in", () => {
    dotenv = { LITELLM_AGENT_KEY: "sk-dotenv", LITELLM_BASE_URL: "https://router.kernal.one/v1" };
    setup();
    resolve();
    resolve("work");
    assert.deepEqual(warnings.sort(), [
      "LITELLM_AGENT_KEY in .env is deprecated: /admin can save it to your account or this machine",
      "LITELLM_BASE_URL in .env is deprecated: /admin can save it to your account or this machine",
    ]);
  });
});

describe("connect's loadEnv layering", () => {
  test("fleet base URL replaces, the device key fills only an empty slot, provider keys likewise", async () => {
    writeCacheFile(response({ "router.baseUrl": { value: "https://fleet.test/v1", source: "fleet", locked: true } }));
    routerKey = { key: "sk-device", baseUrl: "https://fleet.test/v1", alias: "a" };
    const { fn } = fakeFetch({ "/api/device/provider-keys": () => ({ body: { keys: { openrouter: "sk-or-v1-acct" } } }) });
    setup(fn);
    await refreshProviderKeys();
    const out = layerCentralEnv({ LITELLM_BASE_URL: "https://mine.test/v1" });
    assert.equal(out.LITELLM_BASE_URL, "https://fleet.test/v1");
    assert.equal(out.LITELLM_AGENT_KEY, "sk-device");
    assert.equal(out.OPENROUTER_API_KEY, "sk-or-v1-acct");
    const mine = layerCentralEnv({ LITELLM_API_KEY: "sk-mine", OPENROUTER_API_KEY: "sk-or-mine" });
    assert.equal(mine.LITELLM_AGENT_KEY, undefined);
    assert.equal(mine.OPENROUTER_API_KEY, "sk-or-mine");
  });

  test("signed out: unchanged", () => {
    signedIn = false;
    setup();
    assert.deepEqual(layerCentralEnv({ LITELLM_BASE_URL: "https://mine.test/v1" }), { LITELLM_BASE_URL: "https://mine.test/v1" });
  });
});

describe("setLocalOverride", () => {
  test("writes config.local.json (0600) and takes effect at once; undefined removes", () => {
    setLocalOverride("model.default", "local-qwen-mlx");
    assert.deepEqual(JSON.parse(readFileSync(localOverridesPath(), "utf8")), { version: 1, values: { "model.default": "local-qwen-mlx" } });
    assert.equal(statSync(localOverridesPath()).mode & 0o777, 0o600);
    assert.deepEqual(resolve().values["model.default"], { value: "local-qwen-mlx", source: "local", override: "any", locked: false });
    setLocalOverride("model.default", undefined);
    assert.equal(getValue("model.default"), undefined);
  });

  test("refuses unknown keys, secrets, keys without a local level and mistyped values", () => {
    assert.throws(() => setLocalOverride("nope", 1), /unknown setting/);
    assert.throws(() => setLocalOverride("router.key", "sk-x"), /secret/);
    assert.throws(() => setLocalOverride("telemetry.sentry.dsn", "https://k@x.test/1"), /can't be set on this machine/);
    assert.throws(() => setLocalOverride("voice.enabled", "yes"), /invalid value/);
  });
});

describe("display", () => {
  test("sources in /admin's words, secrets masked", () => {
    assert.equal(describeSource({ source: "user" }), "your account");
    assert.equal(describeSource({ source: "profile", sourceName: "work" }), "profile work");
    assert.equal(describeSource({ source: "local" }), "this machine");
    assert.equal(describeSource({ source: "dotenv", sourceName: "X" }), ".env (X)");
    assert.equal(describeSource({ source: "env", sourceName: "X" }), "shell (X)");
    assert.equal(displayValue("router.key", "sk-abcdefgh1234"), "…1234");
    assert.equal(displayValue("router.key", "short"), "…");
    assert.equal(displayValue("voice.enabled", true), "true");
    assert.ok(isCentralSource("fleet") && !isCentralSource("default") && !isCentralSource("env"));
  });

  test("web origin: app.kernal.one for the released API, else the API itself", () => {
    assert.equal(webOrigin("https://link.kernal.one"), "https://app.kernal.one");
    assert.equal(webOrigin("http://localhost:8080"), "http://localhost:8080");
  });
});

describe("sentry from central settings", () => {
  test("the three keys become fleet settings, checked as strictly", () => {
    const on = fleetFromConfig({
      "telemetry.sentry.enabled": { value: true, source: "fleet", override: "opt-out", locked: false },
      "telemetry.sentry.dsn": { value: "https://k@o0.ingest.sentry.io/1", source: "fleet", override: "none", locked: true },
      "telemetry.sentry.tracesSampleRate": { value: 0.1, source: "fleet", override: "none", locked: true },
    });
    assert.deepEqual(on, { telemetry: { sentry: { enabled: true, dsn: "https://k@o0.ingest.sentry.io/1", tracesSampleRate: 0.1 } } });
    assert.deepEqual(fleetFromConfig({ "telemetry.sentry.enabled": { value: true, source: "fleet", override: "opt-out", locked: false } }), { telemetry: { sentry: { enabled: false } } });
    assert.deepEqual(fleetFromConfig({}), { telemetry: { sentry: { enabled: false } } });
  });
});
