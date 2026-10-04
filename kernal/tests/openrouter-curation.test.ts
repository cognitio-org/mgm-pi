/**
 * #440: the curated OpenRouter list as central settings. changeCuration's writes (this machine's
 * config.local.json, the account's document with If-Match), the fleet's removals winning, and
 * /connect's "Browse all OpenRouter models…" adding a model and switching to it. The session,
 * Outfitter and OpenRouter are fakes; nothing leaves the process.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx, makePi, stubFetch, tmpAgentDir } from "./harness.ts";
import { _resetCentralConfig, _setCentralConfigDeps, configCachePath, localOverridesPath, resolve, type ConfigResponse } from "../.pi/extensions/_shared/central-config.ts";
import { _setAdminCentralDeps } from "../.pi/extensions/kernal-admin/central.ts";
import { changeCuration, curationLists } from "../.pi/extensions/connect/curation.ts";
import { DEFAULT_OPENROUTER_MODELS, busRequest, curateOpenRouter } from "../.pi/extensions/connect/lib.ts";

const API = "https://link.outfitter.test";
const EMAIL = "a@example.com";
const ACCOUNT = { api: API, email: EMAIL, userId: "u_1", deviceId: "dev_aaaaaaaaaaaaaaaa", deviceName: "mbp" };
const now = Date.parse("2026-10-04T12:00:00.000Z");

type Call = { method: string; path: string; ifMatch?: string; body?: any };
type Doc = { version: number; values: Record<string, unknown> };
let calls: Call[];
let accountDoc: Doc;   // the user document
let profileDoc: Doc;   // profile "work"
let putAnswer: { status: number; body: unknown } | undefined;   // a v2 server, say
let signedIn: boolean;

/** Outfitter's account documents: GET with an etag, PUT with If-Match bumps the version. */
const outfitter = (async (url: URL | string, init?: RequestInit) => {
  const u = new URL(String(url));
  const h = (init?.headers ?? {}) as Record<string, string>;
  const call: Call = { method: init?.method ?? "GET", path: u.pathname, ifMatch: h["if-match"], body: init?.body ? JSON.parse(String(init.body)) : undefined };
  calls.push(call);
  const doc = u.pathname === "/api/config/user" ? accountDoc : u.pathname === "/api/config/profiles/work" ? profileDoc : undefined;
  if (!doc) return new Response("{}", { status: 404 });
  if (call.method === "PUT") {
    if (putAnswer) return new Response(JSON.stringify(putAnswer.body), { status: putAnswer.status });
    if (call.ifMatch !== `W/"${doc.version}"`) return new Response("{}", { status: 409 });
    for (const [k, v] of Object.entries(call.body.values)) { if (v === null) delete doc.values[k]; else doc.values[k] = v; }
    doc.version++;
  }
  return new Response(JSON.stringify({ values: doc.values, version: doc.version }), { status: 200, headers: { "content-type": "application/json", etag: `W/"${doc.version}"` } });
}) as typeof fetch;

let profile: string | undefined;   // the active profile, as KERNAL_PROFILE would set it

function writeCache(values: ConfigResponse["values"]) {
  const response: ConfigResponse = { schemaVersion: 3, account: { email: EMAIL, userId: "u_1" }, profile: profile ?? null, profiles: profile ? [profile] : [], deviceId: ACCOUNT.deviceId, values, resolvedAt: "2026-10-04T10:00:00.000Z" } as ConfigResponse;
  const file = configCachePath(API, EMAIL, profile);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ api: API, email: EMAIL, profile: profile ?? null, fetchedAt: new Date(now).toISOString(), response }));
}
/** What GET /api/config would resolve from the documents (user, then the profile's own keys). */
function resolvedFromDocs(): ConfigResponse["values"] {
  const out: ConfigResponse["values"] = {};
  for (const [k, v] of Object.entries(accountDoc.values)) out[k] = { value: v as string, source: "user" };
  if (profile) for (const [k, v] of Object.entries(profileDoc.values)) out[k] = { value: v as string, source: "profile", sourceName: profile };
  return out;
}

function setup() {
  const session = {
    loginState: () => (signedIn ? { signedIn: true as const, account: ACCOUNT } : { signedIn: false as const }),
    getAccessToken: async () => (signedIn ? "kda_token" : undefined),
    getRouterKey: () => undefined,
    setRouterKey: () => {},
    outfitterApi: () => API,
  };
  _resetCentralConfig();
  _setCentralConfigDeps({ session, env: () => ({ OUTFITTER_API: API, ...(profile ? { KERNAL_PROFILE: profile } : {}) }), dotenv: () => ({}), settings: () => ({}), now: () => now, warn: () => {}, fetch: outfitter });
  _setAdminCentralDeps({});
  // As /config reload: the account's new values become the resolution (the cache stands in for GET /api/config).
  _setAdminCentralDeps({ session, fetch: outfitter, reload: async () => { writeCache(resolvedFromDocs()); _resetCentralConfig(); setupDepsOnly(session); return resolve(); } });
}
function setupDepsOnly(session: any) {
  _setCentralConfigDeps({ session, env: () => ({ OUTFITTER_API: API, ...(profile ? { KERNAL_PROFILE: profile } : {}) }), dotenv: () => ({}), settings: () => ({}), now: () => now, warn: () => {}, fetch: outfitter });
}

beforeEach(() => {
  process.env.KERNAL_HOME_DIR = mkdtempSync(join(tmpdir(), "kernal-curation-"));
  delete process.env.KERNAL_CONFIG_CACHE_DIR;
  calls = [];
  accountDoc = { version: 3, values: {} };
  profileDoc = { version: 7, values: {} };
  putAnswer = undefined;
  profile = undefined;
  signedIn = false;
  setup();
});
afterEach(() => { _setAdminCentralDeps({}); _resetCentralConfig(); });

const machineFile = () => JSON.parse(readFileSync(localOverridesPath(), "utf8")).values;

describe("changeCuration on this machine", () => {
  test("adds to localAdd, then says it's already there; removing it drops it again", async () => {
    assert.match(await changeCuration("add", "x/new", "machine"), /Added x\/new .* this machine/);
    assert.equal(machineFile()["openrouter.models.localAdd"], "x/new");
    assert.deepEqual(curationLists().localAdd, ["x/new"]);
    assert.match(await changeCuration("add", "x/new", "machine"), /already on your list/);
    await changeCuration("remove", "x/new", "machine");
    assert.equal(machineFile()["openrouter.models.localAdd"], undefined);
    assert.deepEqual(curationLists().localRemove, [], "a model only this machine added needs no removal entry");
  });

  test("removing a default records it in localRemove; adding it back clears that", async () => {
    const id = DEFAULT_OPENROUTER_MODELS[0];
    await changeCuration("remove", id, "machine");
    assert.deepEqual(curationLists().localRemove, [id]);
    await changeCuration("add", id, "machine");
    assert.deepEqual(curationLists(), { ...curationLists(), localAdd: [], localRemove: [] });
  });

  test("refuses what isn't an id, and a model the fleet hid", async () => {
    await assert.rejects(changeCuration("add", "a/b, c/d", "machine"), /not an OpenRouter model id/);
    await assert.rejects(changeCuration("add", "x/\u0007bell", "machine"), /not an OpenRouter model id/);
    await assert.rejects(changeCuration("add", "x/typo", "machine", { catalogue: ["x/real"] }), /OpenRouter doesn't list x\/typo/);
    assert.match(await changeCuration("add", "x/real:nitro", "machine", { catalogue: ["x/real"] }), /Added/, "a routing variant of a listed model");
    signedIn = true;
    writeCache({ "openrouter.models.fleetRemove": { value: "x/pricey", source: "fleet", locked: true } });
    setup();
    await assert.rejects(changeCuration("add", "x/pricey", "machine"), /hidden by your Sysop/);
  });
});

describe("precedence: a change never saves without effect", () => {
  test("adding on this machine what the account removed: the machine wins, and it's offered", async () => {
    signedIn = true;
    accountDoc.values["openrouter.models.remove"] = "z-ai/glm-5.1";
    writeCache(resolvedFromDocs());
    setup();
    await changeCuration("add", "z-ai/glm-5.1", "machine");
    assert.ok(curateOpenRouter(DEFAULT_OPENROUTER_MODELS, curationLists()).includes("z-ai/glm-5.1"));
  });

  test("adding on the account what this machine removed clears this machine's removal too", async () => {
    signedIn = true;
    writeCache({});
    setup();
    await changeCuration("remove", "z-ai/glm-5.1", "machine");
    await changeCuration("add", "z-ai/glm-5.1", "account");
    assert.equal(machineFile()["openrouter.models.localRemove"], undefined);
    assert.ok(curateOpenRouter(DEFAULT_OPENROUTER_MODELS, curationLists()).includes("z-ai/glm-5.1"));
  });

  test("removing on the account what only this machine added drops it here, with no account-wide removal", async () => {
    signedIn = true;
    writeCache({});
    setup();
    await changeCuration("add", "x/mine", "machine");
    assert.match(await changeCuration("remove", "x/mine", "account"), /Removed/);
    assert.equal(machineFile()["openrouter.models.localAdd"], undefined);
    assert.equal(accountDoc.values["openrouter.models.remove"], undefined);
  });

  test("with a profile active, an account add clears the profile's own removal", async () => {
    signedIn = true; profile = "work";
    profileDoc.values["openrouter.models.profileRemove"] = "x/p";
    writeCache(resolvedFromDocs());
    setup();
    assert.match(await changeCuration("add", "x/p", "account"), /your profile/);
    assert.equal(profileDoc.values["openrouter.models.profileRemove"], undefined);
  });
});

describe("changeCuration on the account", () => {
  test("starts from the account document as it is now, not this process's older resolution", async () => {
    signedIn = true;
    writeCache({ "openrouter.models.add": { value: "u/one", source: "user" } });   // what this process resolved
    accountDoc = { version: 5, values: { "openrouter.models.add": "u/one,u/other-machine" } };   // another laptop added one since
    setup();
    await changeCuration("add", "u/two", "account");
    const put = calls.find((c) => c.method === "PUT")!;
    assert.equal(put.ifMatch, 'W/"5"');
    assert.deepEqual(put.body.values, { "openrouter.models.add": "u/one,u/other-machine,u/two" });
  });

  test("with a profile active, writes the profile's own pair and leaves the user's list alone", async () => {
    signedIn = true; profile = "work";
    accountDoc.values["openrouter.models.add"] = "u/one";
    writeCache(resolvedFromDocs());
    setup();
    assert.match(await changeCuration("add", "p/two", "account"), /on your profile/);
    const put = calls.find((c) => c.method === "PUT")!;
    assert.equal(put.path, "/api/config/profiles/work");
    assert.deepEqual(put.body.values, { "openrouter.models.profileAdd": "p/two" });
    // removing the user's model from the profile records a profile removal; the user document is untouched
    await changeCuration("remove", "u/one", "account");
    assert.equal(profileDoc.values["openrouter.models.profileRemove"], "u/one");
    assert.equal(accountDoc.values["openrouter.models.add"], "u/one");
    assert.ok(!curateOpenRouter(DEFAULT_OPENROUTER_MODELS, curationLists()).includes("u/one"));
  });

  test("an Outfitter without the keys (v2) and a full list say so plainly", async () => {
    signedIn = true;
    writeCache({});
    setup();
    putAnswer = { status: 400, body: { error: "unknown_key", key: "openrouter.models.add" } };
    await assert.rejects(changeCuration("add", "u/two", "account"), /doesn't support a curated OpenRouter list yet/);
    putAnswer = undefined;
    accountDoc.values["openrouter.models.add"] = Array.from({ length: 60 }, (_, i) => `vendor/model-number-${i}`).join(",");
    await assert.rejects(changeCuration("add", "u/two", "account"), /is full \(1024 characters\)/);
  });

  test("appends to the account's list with If-Match on the version it read", async () => {
    signedIn = true;
    accountDoc.values["openrouter.models.add"] = "u/one";
    writeCache({ "openrouter.models.add": { value: "u/one", source: "user" } });
    setup();
    assert.match(await changeCuration("add", "u/two", "account"), /Added u\/two .* your account/);
    const put = calls.find((c) => c.method === "PUT")!;
    assert.equal(put.ifMatch, 'W/"3"');
    assert.deepEqual(put.body, { values: { "openrouter.models.add": "u/one,u/two" } });
    assert.deepEqual(curationLists().add, ["u/one", "u/two"], "the saved list is this process's resolution right away");
  });

  test("signed out: no account target", async () => {
    await assert.rejects(changeCuration("add", "u/two", "account"), /kernal login/);
  });
});

describe("/connect openrouter: browse the catalogue, add a model, switch to it", async () => {
  test("Browse all → search → pick → add to this machine → registered and selected", async () => {
    const saved = { HOME: process.env.HOME, NO: process.env.KERNAL_NO_DISCOVERY, OR: process.env.OPENROUTER_API_KEY, AGENT: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd() };
    const home = mkdtempSync(join(tmpdir(), "kernal-curation-e2e-"));
    process.env.HOME = home; process.chdir(home);
    delete process.env.KERNAL_NO_DISCOVERY;   // start-up reads the (stubbed) catalogue
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test-test-test";
    delete process.env.OPENROUTER_MODELS; delete process.env.LITELLM_AGENT_KEY; delete process.env.LITELLM_API_KEY;
    const store = tmpAgentDir({});
    const restore = stubFetch({ "https://openrouter.ai/api/v1/models": () => ({ data: [{ id: "openai/gpt-5.5" }, { id: "deepseek/deepseek-v4-pro" }, { id: "deepseek/deepseek-r9" }] }) });
    try {
      const connect = await import("../.pi/extensions/connect/index.ts");
      const pi = makePi();
      await connect.default(pi as any);
      const models = () => pi.providers.flatMap((p: any) => p.config.models.map((m: any) => ({ ...m, provider: p.name })));
      const ctx = makeCtx({});
      ctx.modelRegistry.find = (p: string, id: string) => models().find((m: any) => m.provider === p && m.id === id);
      ctx.answers.push("Browse all OpenRouter models…", "deepseek", "deepseek/deepseek-r9", "Add to this machine's list only");
      await pi.commands.get("connect")!.handler("openrouter", ctx as any);
      assert.equal(pi.setModelCalls.at(-1)?.id, "deepseek/deepseek-r9", JSON.stringify(ctx.notices));
      assert.equal(machineFile()["openrouter.models.localAdd"], "deepseek/deepseek-r9");
      assert.deepEqual([store.read().defaultProvider, store.read().defaultModel], ["openrouter", "deepseek/deepseek-r9"]);
      // /admin's bus: the list's parts, and a removal through the same path re-registers without it
      const state: any = await busRequest((pi as any).events, "kernal:connect", { op: "curation" }, 1000);
      assert.deepEqual(state.lists.localAdd, ["deepseek/deepseek-r9"]);
      assert.equal(state.canAccount, false);
      const after: any = await busRequest((pi as any).events, "kernal:connect", { op: "curate", action: "remove", model: "deepseek/deepseek-r9", target: "machine" }, 5000);
      assert.ok(!after.models.includes("deepseek/deepseek-r9"));
    } finally {
      restore();
      process.chdir(saved.cwd);
      for (const [k, v] of [["HOME", saved.HOME], ["KERNAL_NO_DISCOVERY", saved.NO], ["OPENROUTER_API_KEY", saved.OR], ["PI_CODING_AGENT_DIR", saved.AGENT]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
