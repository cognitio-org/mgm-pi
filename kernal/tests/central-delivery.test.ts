/**
 * What the account delivers reaching the providers of the process that fetched it (#397 CA-8,
 * spec §4, §5.5): connect loads first and registers before kernal-config's background refresh
 * lands, so kernal-config asks connect to register again when provider keys or a re-minted router
 * key arrive, and re-mints a device router key the router refuses (once per process). Both
 * extensions run through their entry points with a fake pi; the session and the network are fakes.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePi, tmpAgentDir, stubFetch } from "./harness.ts";
import { _resetCentralConfig, _setCentralConfigDeps } from "../.pi/extensions/_shared/central-config.ts";
import configExtension from "../.pi/extensions/kernal-config/index.ts";

const API = "https://link.outfitter.test";
const ACCOUNT = { api: API, email: "a@example.com", userId: "u_1", deviceId: "dev_aaaaaaaaaaaaaaaa", deviceName: "mbp" };
const DAY = 86400_000;

type RouterKey = { key: string; baseUrl: string; alias: string; expiresAt?: string };

const tmp = mkdtempSync(join(tmpdir(), "kernal-delivery-"));
process.env.HOME = tmp; process.chdir(tmp);   // no real ~/localllm/.env in reach
const connect = await import("../.pi/extensions/connect/index.ts");

let routerKey: RouterKey | undefined;
let calls: string[];
let providerKeys: Record<string, string>;

/** Outfitter's three device endpoints; the router-key one mints sk-new. */
function outfitter(): typeof fetch {
  return (async (url: URL | string) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (path === "/api/config") return json({ schemaVersion: 1, account: { email: ACCOUNT.email, userId: "u_1" }, profile: null, profiles: [], values: {}, resolvedAt: "2026-10-04T10:00:00.000Z" });
    if (path === "/api/device/provider-keys") return json({ keys: providerKeys });
    if (path === "/api/device/router-key") return json({ routerKey: { key: "sk-new", baseUrl: "https://router.kernal.one/v1", alias: "kernal-device-x" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

function setup() {
  _resetCentralConfig();
  _setCentralConfigDeps({
    session: {
      loginState: () => ({ signedIn: true, account: ACCOUNT }),
      getAccessToken: async () => "kda_test",
      getRouterKey: () => routerKey,
      setRouterKey: (k: RouterKey) => { routerKey = k; },
    },
    env: () => ({ OUTFITTER_API: API }),
    dotenv: () => ({}),
    settings: () => ({}),
    fetch: outfitter(),
    warn: () => {},
  });
}

/** connect first, then kernal-config, as pi loads them; resolves once the start-up work is done. */
async function start() {
  const pi = makePi();
  await connect.default(pi as any);
  let done!: Promise<void>;
  let rekey: Promise<void> | undefined;
  configExtension(pi as any, { onRefresh: (p) => { done = p; }, onRekey: (p) => { rekey = p; } });
  await done;
  const key = (name: string) => pi.providers.filter((p) => p.name === name).at(-1)?.config.apiKey;
  const refused = async () => {
    await pi.emit("after_provider_response", { type: "after_provider_response", status: 401, headers: {} }, { model: { provider: "litellm", id: "m" } });
    await rekey;
  };
  return { pi, key, refused };
}

beforeEach(() => {
  tmpAgentDir();
  process.env.KERNAL_NO_DISCOVERY = "1";
  for (const v of ["LITELLM_AGENT_KEY", "LITELLM_API_KEY", "LITELLM_BASE_URL", "OPENROUTER_API_KEY", "LMSTUDIO_BASE_URL", "KERNAL_SANDBOX"]) delete process.env[v];
  routerKey = { key: "sk-old", baseUrl: "https://router.kernal.one/v1", alias: "kernal-device-x", expiresAt: new Date(Date.now() + 30 * DAY).toISOString() };
  calls = [];
  providerKeys = {};
  setup();
});
afterEach(() => { delete process.env.OPENROUTER_API_KEY; });

describe("provider keys at start-up", () => {
  test("connect registers before they land; once they do, openrouter is registered with the account's key", async () => {
    providerKeys = { openrouter: "sk-or-v1-acct" };
    const { pi, key } = await start();
    assert.equal(key("openrouter"), "sk-or-v1-acct");
    assert.equal(key("litellm"), "sk-old");
    assert.ok(pi.unregistered.includes("openrouter"), "not registered on the first pass");
  });

  test("kernal-config's refresh lands while connect is still starting (2026-10-04): openrouter still gets the key", async () => {
    // pi doesn't wait for connect's first registration before kernal-config runs, so the refresh's
    // "reload" can be emitted before connect serves the bus, and busRequest drops it silently.
    providerKeys = { openrouter: "sk-or-v1-acct" };
    const pi = makePi();
    // connect's first registration is still in flight (here: held on a slow router answer) when
    // kernal-config's refresh lands, so its reload finds nobody serving the bus yet.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const restore = stubFetch({ "/models": () => ({ data: [] }) });
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: any, i?: any) => { await gate; return real(u, i); }) as any;
    process.env.KERNAL_NO_DISCOVERY = "";
    const starting = connect.default(pi as any);
    let done!: Promise<void>;
    configExtension(pi as any, { onRefresh: (p) => { done = p; } });
    await done;                                   // delivered; its reload found nobody listening
    release();
    await starting;
    globalThis.fetch = real; restore();
    process.env.KERNAL_NO_DISCOVERY = "1";
    await new Promise((r) => setTimeout(r, 50));  // connect's follow-up registration
    assert.equal(pi.providers.filter((p) => p.name === "openrouter").at(-1)?.config.apiKey, "sk-or-v1-acct");
  });

  test("nothing new delivered: no second registration", async () => {
    const { pi } = await start();
    assert.equal(pi.providers.filter((p) => p.name === "litellm").length, 1);
  });
});

describe("router key re-mint", () => {
  test("due at start-up: the live session moves to the new key", async () => {
    routerKey!.expiresAt = new Date(Date.now() + 3 * DAY).toISOString();
    const { key } = await start();
    assert.equal(calls.filter((c) => c === "/api/device/router-key").length, 1);
    assert.equal(key("litellm"), "sk-new");
  });

  test("a 401 from the router re-mints once per process and registers the new key", async () => {
    const { key, refused } = await start();
    assert.equal(key("litellm"), "sk-old");
    await refused();
    assert.equal(key("litellm"), "sk-new");
    await refused();
    assert.equal(calls.filter((c) => c === "/api/device/router-key").length, 1);
  });

  test("a 401 with a local key in use (not the device's) re-mints nothing", async () => {
    process.env.LITELLM_AGENT_KEY = "sk-mine";
    _setCentralConfigDeps({ env: () => ({ OUTFITTER_API: API, LITELLM_AGENT_KEY: "sk-mine" }) });
    const { key, refused } = await start();
    await refused();
    assert.equal(key("litellm"), "sk-mine");
    assert.ok(!calls.includes("/api/device/router-key"));
  });

  test("refused at connect's start-up key check: re-minted and registered", async () => {
    delete process.env.KERNAL_NO_DISCOVERY;
    const restore = stubFetch({
      "localhost:1234": () => ({ data: [] }),
      "/model/info": () => ({ data: [{ model_name: "claude-sonnet-5", model_info: { mode: "chat" } }] }),
      "router.kernal.one/v1/models": (init: any) => (init?.headers?.authorization === "Bearer sk-old" ? { __status: 401, body: { error: { message: "invalid key" } } } : { data: [{ id: "claude-sonnet-5" }] }),
    });
    try {
      const { pi, key } = await start();
      assert.ok(pi.unregistered.includes("litellm"), "the refused key hid litellm");
      assert.equal(key("litellm"), "sk-new");
    } finally { restore(); }
  });
});
