// #394 CA-5 (docs/specs/central-auth.md §5): per-user and per-device LiteLLM keys, against a fake
// LiteLLM (test/fake-litellm.ts). Users, device keys, run keys, deletes and the sweep, teams, and
// the device lifecycle hooks.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createLitellmKeys,
  deviceKeyAlias,
  monthRange,
  parseModelList,
  registerLitellmDeviceHooks,
  routerKeyLimits,
  sweepRouterKeys,
  DEVICE_KEY_BUDGET_PERIOD_DAYS,
  DEVICE_KEY_DURATION_DAYS,
  DEVICE_KEY_MAX_BUDGET_USD,
  DEVICE_KEY_RPM_LIMIT,
  RUN_KEY_MAX_BUDGET_USD,
  type LitellmKeys,
} from "../src/central/litellm-keys.ts";
import { defaultFleetSettings, type FleetSettings } from "../src/fleet-settings.ts";
import { settingDecl, type SettingValue } from "../src/central/settings-schema.ts";
import { DeviceLifecycle, type LifecycleDevice } from "../src/central/device-lifecycle.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { RouterKey, RouterKeysCollection } from "../src/store/keys.ts";
import { buildTestApp } from "./helpers.ts";
import { FakeLitellm } from "./fake-litellm.ts";

const ADMIN = "sk-admin-test-key";
const CONFIG = { litellmBaseUrl: "https://router.test/v1", litellmAdminKey: ADMIN };
/** The fleet settings with `values` at the fleet level. */
function fleetWith(values: Record<string, SettingValue>): FleetSettings {
  return { ...defaultFleetSettings(), values };
}
const DEFAULT_LIMITS = async () => routerKeyLimits(defaultFleetSettings());
const device: LifecycleDevice = { id: "dev_aaaabbbbccccdddd", userId: "u_0123456789abcdef01234567", ownerEmail: "a@example.com", name: "mbp-a" };

function setup(opts: { now?: () => Date; store?: MemoryStore } = {}): { fake: FakeLitellm; store: MemoryStore; keys: LitellmKeys } {
  const fake = new FakeLitellm();
  const store = opts.store ?? new MemoryStore();
  const keys = createLitellmKeys(CONFIG, store, { fetch: fake.fetch, now: opts.now })!;
  return { fake, store, keys };
}

describe("createLitellmKeys", () => {
  test("is undefined without LITELLM_ADMIN_KEY", () => {
    assert.equal(createLitellmKeys({ litellmBaseUrl: "https://router.test/v1", litellmAdminKey: "" }, new MemoryStore()), undefined);
  });

  test("calls the management root (no /v1) with the admin key as bearer", async () => {
    const { fake, keys } = setup();
    await keys.ensureLitellmUser({ userId: device.userId, email: device.ownerEmail });
    assert.ok(fake.calls.length > 0);
    for (const call of fake.calls) {
      assert.equal(call.authorization, `Bearer ${ADMIN}`);
      assert.ok(!call.path.startsWith("/v1"), call.path);
    }
  });
});

describe("ensureLitellmUser", () => {
  test("creates the user once, without an auto-created key, and is idempotent", async () => {
    const { fake, keys } = setup();
    await keys.ensureLitellmUser({ userId: device.userId, email: device.ownerEmail });
    await keys.ensureLitellmUser({ userId: device.userId, email: device.ownerEmail });
    const created = fake.callsTo("/user/new");
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].body, { user_id: device.userId, user_role: "internal_user", auto_create_key: false, metadata: { email: device.ownerEmail, source: "outfitter" } });
    assert.equal(fake.callsTo("/user/info").length, 1, "the second call is answered from memory");
  });

  test("an existing user is not created again (older LiteLLM: 200 with user_info null for unknown)", async () => {
    const { fake, keys } = setup();
    fake.unknownUser = "null";
    fake.users.set(device.userId, { user_id: device.userId, user_email: device.ownerEmail });
    await keys.ensureLitellmUser({ userId: device.userId, email: device.ownerEmail });
    assert.equal(fake.callsTo("/user/new").length, 0);
    await keys.ensureLitellmUser({ userId: "u_other", email: "b@example.com" });
    assert.equal(fake.callsTo("/user/new").length, 1);
  });

  test("a race with another instance (the id now exists) is fine; any other failure throws", async () => {
    const { fake, keys } = setup();
    // The first look misses, another instance creates the user, our /user/new loses the race.
    fake.failNext("/user/info", 404, { detail: { error: "User not found" } });
    fake.users.set(device.userId, { user_id: device.userId });
    await keys.ensureLitellmUser({ userId: device.userId, email: device.ownerEmail });
    assert.equal(fake.callsTo("/user/info").length, 2, "re-checked by id after the failed create");
    fake.failNext("/user/new", 500, { error: { message: "database down" } });
    await assert.rejects(keys.ensureLitellmUser({ userId: "u_other", email: "b@example.com" }), /\/user\/new answered 500: database down/);
  });

  test("an 'already exists' about another field is not a race: it throws", async () => {
    const { fake, keys } = setup();
    fake.failNext("/user/new", 409, { detail: { error: "User with email a@example.com already exists" } });
    await assert.rejects(keys.ensureLitellmUser({ userId: device.userId, email: device.ownerEmail }), /\/user\/new answered 409/);
  });

  test("a person who already has a LiteLLM login (same email, proxy_admin) still gets an internal_user (2026-10-04)", async () => {
    const { fake, keys } = setup();
    fake.users.set("0adf-human", { user_id: "0adf-human", user_email: device.ownerEmail, user_role: "proxy_admin" });
    await keys.ensureLitellmUser({ userId: device.userId, email: device.ownerEmail });
    const created = fake.users.get(device.userId);
    assert.equal(created?.user_role, "internal_user", "never inherits the human login's admin role");
    assert.equal(created?.user_email ?? null, null, "no email: it would collide with the existing login");
    assert.deepEqual(created?.metadata, { email: device.ownerEmail, source: "outfitter" });
    assert.equal(fake.users.get("0adf-human")?.user_role, "proxy_admin", "the human login is untouched");
  });
});

describe("mintDeviceKey", () => {
  test("generates with the §5.2 alias, limits and metadata, and records no key value", async () => {
    const { fake, store, keys } = setup();
    const minted = await keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name });
    assert.equal(minted.alias, `kernal-device-${device.id}`);
    assert.match(minted.key, /^sk-fake-/);
    assert.equal(minted.expiresAt, "2027-01-02T03:04:05.000Z");
    const [gen] = fake.callsTo("/key/generate");
    assert.deepEqual(gen.body, {
      key_alias: `kernal-device-${device.id}`,
      user_id: device.userId,
      duration: "90d",
      max_budget: 50,
      budget_duration: "30d",
      rpm_limit: 120,
      metadata: { outfitter: "device", deviceId: device.id, deviceName: device.name },
    });
    assert.ok(!("models" in gen.body), "v1 leaves models unset");

    const record = await store.routerKeys.findActiveForDevice(device.id);
    assert.ok(record);
    assert.equal(record.kind, "device");
    assert.equal(record.userId, device.userId);
    assert.equal(record.litellmTokenId, minted.tokenId);
    assert.ok(!JSON.stringify(record).includes(minted.key), "the key itself is never stored");
  });

  test("passes models and limits through when given", async () => {
    const { fake, keys } = setup();
    await keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name, models: ["claude-auto-llm"], maxBudget: 5, rpmLimit: 10 });
    const [gen] = fake.callsTo("/key/generate");
    assert.deepEqual(gen.body.models, ["claude-auto-llm"]);
    assert.equal(gen.body.max_budget, 5);
    assert.equal(gen.body.rpm_limit, 10);
  });

  test("deletes the device's previous key first", async () => {
    const { fake, store, keys } = setup();
    const first = await keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name });
    const second = await keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name });
    assert.notEqual(first.key, second.key);
    const deletes = fake.callsTo("/key/delete");
    assert.equal(deletes.length, 1);
    assert.deepEqual(deletes[0].body, { keys: [first.tokenId] });
    assert.ok(!fake.keys.has(first.tokenId!));
    const record = await store.routerKeys.findActiveForDevice(device.id);
    assert.equal(record?.litellmTokenId, second.tokenId);
    assert.equal(record?.deletedAt, undefined);
  });

  test("a re-mint whose previous delete fails throws and leaves the live key off the sweep", async () => {
    const { fake, store, keys } = setup();
    const first = await keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name });
    fake.failNext("/key/delete", 500);
    await assert.rejects(keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name }));
    assert.equal(fake.callsTo("/key/generate").length, 1, "no second key");
    const record = await store.routerKeys.findActiveForDevice(device.id);
    assert.equal(record?.litellmTokenId, first.tokenId);
    assert.equal(record?.deleteFailedAt, undefined);
    assert.deepEqual(await store.routerKeys.listPendingDelete(50), []);
    assert.deepEqual(await sweepRouterKeys(keys, store), { deleted: 0, failed: 0 });
    assert.ok(fake.keys.has(first.tokenId!), "the device keeps its key");
  });

  test("a key that can't be recorded is deleted again", async () => {
    const store = new MemoryStore();
    const failing: RouterKeysCollection = Object.assign(Object.create(store.routerKeys), {
      insert: async (_key: RouterKey) => {
        throw new Error("mongo down");
      },
    });
    const fake = new FakeLitellm();
    const keys = createLitellmKeys(CONFIG, { routerKeys: failing }, { fetch: fake.fetch })!;
    await assert.rejects(keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name }), /could not record/);
    assert.equal(fake.keys.size, 0);
  });

  test("an error message never carries a key LiteLLM echoed back", async () => {
    const { fake, keys } = setup();
    fake.failNext("/key/generate", 400, { error: { message: "Bad request for key sk-leaky-1234567890 limits" } });
    await assert.rejects(keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name }), (err: Error) => {
      assert.ok(!err.message.includes("sk-leaky"), err.message);
      assert.match(err.message, /\/key\/generate answered 400/);
      return true;
    });
    fake.failNext("/key/generate", 401, { error: { message: `Invalid proxy server token passed. Received API Key = ${ADMIN}` } });
    await assert.rejects(keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name }), (err: Error) => {
      assert.ok(!err.message.includes(ADMIN), err.message);
      assert.match(err.message, /refused the admin key/);
      return true;
    });
  });
});

describe("mintRunKey", () => {
  test("a run key has a duration in seconds, the run budget and run metadata", async () => {
    const now = new Date("2026-10-04T10:00:00.000Z");
    const { fake, store, keys } = setup({ now: () => now });
    const minted = await keys.mintRunKey({ userId: device.userId, email: device.ownerEmail, runId: "run-1", sessionId: "s-1", durationSeconds: 3600.4 });
    assert.equal(minted.alias, "outfitter-run-run-1");
    const [gen] = fake.callsTo("/key/generate");
    assert.equal(gen.body.duration, "3601s");
    assert.equal(gen.body.max_budget, 20);
    assert.deepEqual(gen.body.metadata, { outfitter: "run", runId: "run-1", sessionId: "s-1" });
    const record = await store.routerKeys.findByAlias("outfitter-run-run-1");
    assert.equal(record?.kind, "run");
    assert.equal(record?.runId, "run-1");
  });
});

describe("deleteKey and the sweep", () => {
  test("deletes by token id and marks the record deleted", async () => {
    const { fake, store, keys } = setup();
    const minted = await keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name });
    await keys.deleteKey({ alias: minted.alias });
    assert.deepEqual(fake.callsTo("/key/delete")[0].body, { keys: [minted.tokenId] });
    assert.ok((await store.routerKeys.findByAlias(minted.alias))?.deletedAt);
    assert.equal(await store.routerKeys.findActiveForDevice(device.id), null);
    // Already deleted: no second call.
    await keys.deleteKey({ alias: minted.alias });
    assert.equal(fake.callsTo("/key/delete").length, 1);
  });

  test("a key LiteLLM no longer has counts as deleted; an unknown alias is tried by alias", async () => {
    const { fake, store, keys } = setup();
    const minted = await keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name });
    fake.keys.clear();
    await keys.deleteKey({ alias: minted.alias });
    assert.ok((await store.routerKeys.findByAlias(minted.alias))?.deletedAt);
    await keys.deleteKey({ alias: "kernal-device-dev_neverminted0000" });
    assert.deepEqual(fake.callsTo("/key/delete").at(-1)!.body, { key_aliases: ["kernal-device-dev_neverminted0000"] });
  });

  test("a failed delete records deleteFailedAt and throws; the sweep retries it", async () => {
    const { fake, store, keys } = setup();
    const minted = await keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name });
    fake.failNext("/key/delete", 500);
    await assert.rejects(keys.deleteKey({ alias: minted.alias }), /\/key\/delete answered 500/);
    const failed = await store.routerKeys.findByAlias(minted.alias);
    assert.ok(failed?.deleteFailedAt);
    assert.equal(failed?.deletedAt, undefined);
    assert.deepEqual((await store.routerKeys.listPendingDelete(50)).map((k) => k.alias), [minted.alias]);

    // Still failing: counted, kept.
    fake.failNext("/key/delete", 500);
    assert.deepEqual(await sweepRouterKeys(keys, store), { deleted: 0, failed: 1 });
    // Then it works.
    assert.deepEqual(await sweepRouterKeys(keys, store), { deleted: 1, failed: 0 });
    const done = await store.routerKeys.findByAlias(minted.alias);
    assert.ok(done?.deletedAt);
    assert.equal(done?.deleteFailedAt, undefined);
    assert.deepEqual(await store.routerKeys.listPendingDelete(50), []);
  });

  test("LiteLLM down: the delete fails (recorded), never hangs", async () => {
    const { fake, store, keys } = setup();
    const minted = await keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name });
    fake.down = true;
    await assert.rejects(keys.deleteKey({ alias: minted.alias }), /LiteLLM did not answer/);
    assert.ok((await store.routerKeys.findByAlias(minted.alias))?.deleteFailedAt);
  });

  test("run keys past their expiry are owed a delete", async () => {
    const store = new MemoryStore();
    await store.routerKeys.insert({ alias: "outfitter-run-old", kind: "run", runId: "old", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z" });
    await store.routerKeys.insert({ alias: "outfitter-run-live", kind: "run", runId: "live", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" });
    await store.routerKeys.insert({ alias: "kernal-device-dev_x", kind: "device", deviceId: "dev_x", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" });
    assert.deepEqual((await store.routerKeys.listPendingDelete(50)).map((k) => k.alias), ["outfitter-run-old"]);
  });

  test("without minting the sweep does nothing", async () => {
    assert.equal(await sweepRouterKeys(undefined, new MemoryStore()), undefined);
  });

  test("POST /api/hooks/tick runs the sweep", async () => {
    const fake = new FakeLitellm();
    const store = new MemoryStore();
    const keys = createLitellmKeys(CONFIG, store, { fetch: fake.fetch })!;
    await store.routerKeys.insert({ alias: "outfitter-run-old", kind: "run", runId: "old", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z" });
    const app = await buildTestApp({}, { store, litellmKeys: keys });
    const res = await app.fastify.inject({ method: "POST", url: "/api/hooks/tick", headers: { authorization: "Bearer test-agent-token" }, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().routerKeys, { deleted: 1, failed: 0 });
    assert.ok((await store.routerKeys.findByAlias("outfitter-run-old"))?.deletedAt);
    await app.fastify.close();
  });
});

describe("ensureTeam", () => {
  test("finds a team by alias, else creates it, then remembers it", async () => {
    const { fake, keys } = setup();
    fake.teams.push({ team_id: "team-existing", team_alias: "other" });
    const id = await keys.ensureTeam("outfitter-system");
    assert.equal(fake.callsTo("/team/new").length, 1);
    assert.equal(await keys.ensureTeam("outfitter-system"), id);
    assert.equal(fake.callsTo("/team/list").length, 1);
    assert.equal(await keys.ensureTeam("other"), "team-existing");
  });
});

describe("registerLitellmDeviceHooks", () => {
  test("login delivers this device's router key with the router base URL; revoke deletes it", async () => {
    const { fake, store, keys } = setup();
    const lifecycle = new DeviceLifecycle();
    registerLitellmDeviceHooks(lifecycle, keys, CONFIG, DEFAULT_LIMITS);
    const result = await lifecycle.login({ device });
    assert.deepEqual(result.problems, []);
    const routerKey = result.delivery.routerKey!;
    assert.equal(routerKey.alias, deviceKeyAlias(device.id));
    assert.equal(routerKey.baseUrl, "https://router.test/v1");
    assert.match(routerKey.key, /^sk-fake-/);
    assert.ok(fake.users.has(device.userId), "the LiteLLM user exists");
    assert.equal(fake.keys.size, 1);

    await lifecycle.revoked({ device, reason: "logout" });
    assert.equal(fake.keys.size, 0);
    assert.ok((await store.routerKeys.findByAlias(routerKey.alias))?.deletedAt);
  });

  test("LiteLLM down: the login still succeeds, without a router key, and says why (no secret)", async () => {
    const { fake, keys } = setup();
    fake.down = true;
    const lifecycle = new DeviceLifecycle();
    registerLitellmDeviceHooks(lifecycle, keys, CONFIG, DEFAULT_LIMITS);
    const result = await lifecycle.login({ device });
    assert.deepEqual(result.delivery, {});
    assert.deepEqual(result.problems, ["router key: LiteLLM did not answer"]);
  });

  test("login mints with the fleet's limits of that moment, read at each login", async () => {
    const { fake, keys } = setup();
    let fleet = defaultFleetSettings();
    const lifecycle = new DeviceLifecycle();
    registerLitellmDeviceHooks(lifecycle, keys, CONFIG, async () => routerKeyLimits(fleet));
    await lifecycle.login({ device });
    fleet = fleetWith({
      "router.deviceKey.durationDays": 7,
      "router.deviceKey.maxBudgetUsd": 12.5,
      "router.deviceKey.budgetPeriodDays": 1,
      "router.deviceKey.rpmLimit": 30,
      "router.keys.models": "claude-auto-llm, gpt-auto-llm",
    });
    await lifecycle.login({ device });
    const [first, second] = fake.callsTo("/key/generate");
    assert.equal(first!.body.duration, "90d");
    assert.equal(first!.body.max_budget, 50);
    assert.ok(!("models" in first!.body));
    assert.equal(second!.body.duration, "7d");
    assert.equal(second!.body.max_budget, 12.5);
    assert.equal(second!.body.budget_duration, "1d");
    assert.equal(second!.body.rpm_limit, 30);
    assert.deepEqual(second!.body.models, ["claude-auto-llm", "gpt-auto-llm"]);
  });

  test("without minting nothing is registered", async () => {
    const lifecycle = new DeviceLifecycle();
    registerLitellmDeviceHooks(lifecycle, undefined, CONFIG, DEFAULT_LIMITS);
    assert.deepEqual(await lifecycle.login({ device }), { delivery: {}, problems: [] });
  });
});

describe("monthRange", () => {
  test("first of the month to the first of the next, across a year end", () => {
    assert.deepEqual(monthRange("2026-10"), { start: "2026-10-01", end: "2026-11-01" });
    assert.deepEqual(monthRange("2026-12"), { start: "2026-12-01", end: "2027-01-01" });
  });
});

describe("routerKeyLimits (fleet settings router.*)", () => {
  test("defaults: 90d, 50 USD per 30d, 120 rpm, every model; run keys 20 USD", () => {
    assert.deepEqual(routerKeyLimits(defaultFleetSettings()), {
      device: { duration: "90d", maxBudget: 50, budgetDuration: "30d", rpmLimit: 120 },
      run: { maxBudget: 20 },
    });
  });

  test("the schema defaults are the module's constants", () => {
    assert.equal(settingDecl("router.deviceKey.durationDays")?.default, DEVICE_KEY_DURATION_DAYS);
    assert.equal(settingDecl("router.deviceKey.maxBudgetUsd")?.default, DEVICE_KEY_MAX_BUDGET_USD);
    assert.equal(settingDecl("router.deviceKey.budgetPeriodDays")?.default, DEVICE_KEY_BUDGET_PERIOD_DAYS);
    assert.equal(settingDecl("router.deviceKey.rpmLimit")?.default, DEVICE_KEY_RPM_LIMIT);
    assert.equal(settingDecl("router.runKey.maxBudgetUsd")?.default, RUN_KEY_MAX_BUDGET_USD);
    assert.equal(settingDecl("router.keys.models")?.default, undefined);
    for (const key of ["router.deviceKey.durationDays", "router.deviceKey.maxBudgetUsd", "router.deviceKey.budgetPeriodDays", "router.deviceKey.rpmLimit", "router.keys.models", "router.runKey.maxBudgetUsd"]) {
      const decl = settingDecl(key)!;
      assert.deepEqual(decl.levels, ["fleet"], key);
      assert.equal(decl.override, "none", key);
      assert.equal(decl.secret, false, key);
    }
  });

  test("fleet overrides apply to device and run keys", () => {
    const limits = routerKeyLimits(fleetWith({
      "router.deviceKey.durationDays": 14,
      "router.deviceKey.maxBudgetUsd": 0,
      "router.deviceKey.budgetPeriodDays": 7,
      "router.deviceKey.rpmLimit": 60,
      "router.keys.models": "a b,,a",
      "router.runKey.maxBudgetUsd": 3,
    }));
    assert.deepEqual(limits, {
      device: { duration: "14d", maxBudget: 0, budgetDuration: "7d", rpmLimit: 60, models: ["a", "b"] },
      run: { maxBudget: 3, models: ["a", "b"] },
    });
  });

  test("a stored value that doesn't fit (fractional days, out of range, wrong type) falls back to the default", () => {
    const limits = routerKeyLimits(fleetWith({
      "router.deviceKey.durationDays": 1.5,
      "router.deviceKey.maxBudgetUsd": -1,
      "router.deviceKey.budgetPeriodDays": 400,
      "router.deviceKey.rpmLimit": "120" as unknown as number,
      "router.keys.models": "   ",
    }));
    assert.deepEqual(limits.device, { duration: "90d", maxBudget: 50, budgetDuration: "30d", rpmLimit: 120 });
  });

  test("parseModelList", () => {
    assert.equal(parseModelList(undefined), undefined);
    assert.equal(parseModelList(""), undefined);
    assert.deepEqual(parseModelList(" x,y  z ,x"), ["x", "y", "z"]);
  });
});
