// #394 CA-5 (docs/specs/central-auth.md §5.5, §8): spend per user and for operators, read from a
// fake LiteLLM, and a device's router key re-mint (POST /api/device/router-key). Device-token
// routes run on a bare Fastify with the identity CA-1's preHandler will set.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { buildTestApp } from "./helpers.ts";
import { FakeLitellm } from "./fake-litellm.ts";
import { createLitellmKeys, currentSpendMonth, type LitellmKeys } from "../src/central/litellm-keys.ts";
import { registerKeyRoutes } from "../src/routes/keys.ts";
import type { RouteContext } from "../src/routes/context.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Device } from "../src/store/devices.ts";
import type { Identity } from "../src/auth.ts";
import { userIdFor } from "../src/central/user-id.ts";

const CONFIG = { litellmBaseUrl: "https://router.test/v1", litellmKeyAdminKey: "sk-admin-test" };
const DEV_USER = userIdFor("dev@localhost");

/** The dev user with one device key and one run key in the fake, and a month of logs. */
function seeded(now: () => Date = () => new Date("2026-10-04T10:00:00.000Z")): { fake: FakeLitellm; store: MemoryStore; keys: LitellmKeys } {
  const fake = new FakeLitellm();
  const store = new MemoryStore();
  fake.users.set(DEV_USER, { user_id: DEV_USER, user_email: "dev@localhost" });
  fake.keys.set("tok-dev", { key: "sk-x", token: "tok-dev", key_alias: "kernal-device-dev_aaaa", user_id: DEV_USER, metadata: { outfitter: "device", deviceId: "dev_aaaa", deviceName: "mbp" }, request: {} });
  fake.spendLogs = [
    { api_key: "tok-dev", spend: 0.5, model: "claude-auto-llm", metadata: { user_api_key_alias: "kernal-device-dev_aaaa" } },
    { api_key: "tok-dev", spend: 0.25, model: "gpt-5", metadata: {} },
    { api_key: "tok-run", spend: 1, model: "claude-auto-llm", model_group: "claude-auto-llm", metadata: { user_api_key_alias: "outfitter-run-r1" } },
  ];
  return { fake, store, keys: createLitellmKeys(CONFIG, store, { fetch: fake.fetch, now })! };
}

describe("LitellmKeys.userSpend", () => {
  test("totals by device (with its name) and by model, for the month's date range", async () => {
    const { fake, keys } = seeded();
    const spend = await keys.userSpend(DEV_USER, "2026-10");
    assert.equal(spend.month, "2026-10");
    assert.equal(spend.currency, "USD");
    assert.equal(spend.total, 1.75);
    assert.deepEqual(spend.byDevice, [
      { alias: "outfitter-run-r1", kind: "run", spend: 1 },
      { alias: "kernal-device-dev_aaaa", kind: "device", deviceId: "dev_aaaa", deviceName: "mbp", spend: 0.75 },
    ]);
    assert.deepEqual(spend.byModel, [
      { model: "claude-auto-llm", spend: 1.5 },
      { model: "gpt-5", spend: 0.25 },
    ]);
    const [logs] = fake.callsTo("/spend/logs");
    assert.deepEqual(logs.query, { user_id: DEV_USER, start_date: "2026-10-01", end_date: "2026-11-01", summarize: "false" });
  });

  test("is cached per user and month for 5 minutes", async () => {
    let now = new Date("2026-10-04T10:00:00.000Z");
    const { fake, keys } = seeded(() => now);
    await keys.userSpend(DEV_USER, "2026-10");
    await keys.userSpend(DEV_USER, "2026-10");
    assert.equal(fake.callsTo("/spend/logs").length, 1);
    await keys.userSpend(DEV_USER, "2026-09");
    assert.equal(fake.callsTo("/spend/logs").length, 2);
    now = new Date(now.getTime() + 5 * 60_000 + 1);
    await keys.userSpend(DEV_USER, "2026-10");
    assert.equal(fake.callsTo("/spend/logs").length, 3);
  });

  test("a user LiteLLM has never seen has zero spend (404 now, user_info null on older LiteLLMs)", async () => {
    for (const unknownUser of ["404", "null"] as const) {
      const { fake, keys } = seeded();
      fake.unknownUser = unknownUser;
      fake.spendLogs = [];
      const spend = await keys.userSpend("u_never_logged_in", "2026-10");
      assert.equal(spend.total, 0, unknownUser);
      assert.deepEqual(spend.byDevice, []);
      assert.deepEqual(spend.byModel, []);
      assert.equal(fake.callsTo("/spend/logs").length, 1, "the logs are still read");
    }
  });

  test("any other /user/info failure still throws", async () => {
    const { fake, keys } = seeded();
    fake.failNext("/user/info", 500);
    await assert.rejects(keys.userSpend(DEV_USER, "2026-10"), /\/user\/info answered 500/);
  });

  test("an older LiteLLM's summarized day rows still give the total and models", async () => {
    const { fake, keys } = seeded();
    fake.spendLogs = [{ startTime: "2026-10-01", spend: 2, models: { a: 1.5, b: 0.5 }, users: { [DEV_USER]: 2 } }];
    const spend = await keys.userSpend(DEV_USER, "2026-10");
    assert.equal(spend.total, 2);
    assert.deepEqual(spend.byModel, [{ model: "a", spend: 1.5 }, { model: "b", spend: 0.5 }]);
    assert.deepEqual(spend.byDevice, []);
  });
});

describe("LitellmKeys.allUsersSpend", () => {
  test("every user's month total with the email LiteLLM knows, largest first", async () => {
    const { fake, keys } = seeded();
    fake.users.set("u_other", { user_id: "u_other", user_email: "b@example.com" });
    fake.spendLogs = [
      { startTime: "2026-10-01", spend: 3, users: { [DEV_USER]: 1, u_other: 2 } },
      { startTime: "2026-10-02", spend: 1.5, users: { [DEV_USER]: 1.5 } },
    ];
    assert.deepEqual(await keys.allUsersSpend("2026-10"), [
      { userId: DEV_USER, email: "dev@localhost", total: 2.5 },
      { userId: "u_other", email: "b@example.com", total: 2 },
    ]);
  });

  test("without /user/list the totals still come back", async () => {
    const { fake, keys } = seeded();
    fake.failNext("/user/list", 500);
    fake.spendLogs = [{ user: "u_x", spend: 1 }];
    assert.deepEqual(await keys.allUsersSpend("2026-10"), [{ userId: "u_x", total: 1 }]);
  });
});

describe("GET /api/me/spend and /api/operator/spend", () => {
  test("503 spend_unavailable without the admin key", async () => {
    const app = await buildTestApp();
    for (const url of ["/api/me/spend", "/api/operator/spend"]) {
      const res = await app.fastify.inject({ method: "GET", url });
      assert.equal(res.statusCode, 503, url);
      assert.deepEqual(res.json(), { error: "spend_unavailable" });
    }
    await app.fastify.close();
  });

  test("the caller's spend for the current month by default; a bad month is 400", async () => {
    const { fake, store, keys } = seeded(() => new Date());
    const app = await buildTestApp({}, { store, litellmKeys: keys });
    const res = await app.fastify.inject({ method: "GET", url: "/api/me/spend" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().month, currentSpendMonth());
    assert.equal(res.json().total, 1.75);
    assert.equal(fake.callsTo("/spend/logs")[0].query.user_id, DEV_USER);
    for (const month of ["2026-13", "2026-1", "oct", "2026-10-01"]) {
      const bad = await app.fastify.inject({ method: "GET", url: `/api/me/spend?month=${month}` });
      assert.equal(bad.statusCode, 400, month);
      assert.deepEqual(bad.json(), { error: "invalid_month" });
    }
    await app.fastify.close();
  });

  test("someone who never signed in to Kernal gets zero spend, not an error", async () => {
    const { fake, store, keys } = seeded();
    fake.users.clear();
    fake.spendLogs = [];
    const app = await buildTestApp({}, { store, litellmKeys: keys });
    const res = await app.fastify.inject({ method: "GET", url: "/api/me/spend?month=2026-10" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().total, 0);
    await app.fastify.close();
  });

  test("LiteLLM failing is a 502 that leaks nothing", async () => {
    const { fake, store, keys } = seeded();
    fake.down = true;
    const app = await buildTestApp({}, { store, litellmKeys: keys });
    const res = await app.fastify.inject({ method: "GET", url: "/api/me/spend?month=2026-10" });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json(), { error: "spend_upstream" });
    await app.fastify.close();
  });

  test("operators see every user's total", async () => {
    const { fake, store, keys } = seeded();
    fake.spendLogs = [{ startTime: "2026-10-01", spend: 3, users: { u_a: 1, u_b: 2 } }];
    const app = await buildTestApp({}, { store, litellmKeys: keys });
    const res = await app.fastify.inject({ method: "GET", url: "/api/operator/spend?month=2026-10" });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { month: "2026-10", total: 3, users: [{ userId: "u_b", total: 2 }, { userId: "u_a", total: 1 }] });
    await app.fastify.close();
  });

  test("a non-operator is refused the operator view; neither route is on link", async () => {
    const { store, keys } = seeded();
    const person = await bareRouterApp({ role: "web", identity: { email: "a@example.com", operator: false }, store, keys });
    assert.equal((await person.inject({ method: "GET", url: "/api/operator/spend" })).statusCode, 403);
    await person.close();
    const link = await bareRouterApp({ role: "link", identity: { email: "a@example.com", operator: false, viaToken: true, deviceId: "dev_a" }, store, keys });
    assert.equal((await link.inject({ method: "GET", url: "/api/me/spend" })).statusCode, 404);
    await link.close();
  });
});

const DEVICE: Device = {
  id: "dev_aaaabbbbccccdddd",
  userId: userIdFor("a@example.com"),
  ownerEmail: "a@example.com",
  name: "mbp-a",
  kind: "laptop",
  createdAt: "2026-10-01T00:00:00.000Z",
  approvedBy: "a@example.com",
  accessHash: "h",
  accessExpiresAt: "2026-10-04T11:00:00.000Z",
} as Device;

/** registerKeyRoutes behind a preHandler setting `identity`, with a devices collection that knows `devices`. */
async function bareRouterApp(opts: { role: "link" | "web" | "all"; identity: Identity; store: MemoryStore; keys?: LitellmKeys; devices?: Device[] }) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.identity = opts.identity;
  });
  const devices = { findById: async (id: string) => opts.devices?.find((d) => d.id === id) ?? null };
  const store = Object.assign(Object.create(opts.store), { devices });
  const ctx = { config: { role: opts.role, litellmBaseUrl: CONFIG.litellmBaseUrl }, store, secretAdmin: undefined, litellmKeys: opts.keys } as unknown as RouteContext;
  await registerKeyRoutes(app, ctx);
  await app.ready();
  return app;
}

describe("POST /api/device/router-key", () => {
  const identity: Identity = { email: DEVICE.ownerEmail, operator: false, viaToken: true, deviceId: DEVICE.id };

  test("deletes the device's key and mints a new one", async () => {
    const fake = new FakeLitellm();
    const store = new MemoryStore();
    const keys = createLitellmKeys(CONFIG, store, { fetch: fake.fetch })!;
    const first = await keys.mintDeviceKey({ userId: DEVICE.userId, email: DEVICE.ownerEmail, deviceId: DEVICE.id, deviceName: DEVICE.name });
    const app = await bareRouterApp({ role: "link", identity, store, keys, devices: [DEVICE] });
    const res = await app.inject({ method: "POST", url: "/api/device/router-key" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["cache-control"], "no-store");
    const { routerKey } = res.json();
    assert.equal(routerKey.alias, `kernal-device-${DEVICE.id}`);
    assert.equal(routerKey.baseUrl, CONFIG.litellmBaseUrl);
    assert.notEqual(routerKey.key, first.key);
    assert.ok(!fake.keys.has(first.tokenId!), "the old key is gone");
    assert.equal(fake.keys.size, 1);
    assert.ok(fake.users.has(DEVICE.userId));
    await app.close();
  });

  test("refuses anything but an active laptop device token", async () => {
    const fake = new FakeLitellm();
    const store = new MemoryStore();
    const keys = createLitellmKeys(CONFIG, store, { fetch: fake.fetch })!;
    const cases: Array<[Identity, Device[], number, string]> = [
      [{ email: "a@example.com", operator: false, viaToken: true }, [DEVICE], 403, "device_token_required"],
      [{ email: "a@example.com", operator: true }, [DEVICE], 403, "device_token_required"],
      [identity, [], 404, "device not found"],
      [identity, [{ ...DEVICE, revokedAt: "2026-10-02T00:00:00.000Z" }], 404, "device not found"],
      [identity, [{ ...DEVICE, kind: "machine" }], 403, "machine_token"],
    ];
    for (const [who, devices, status, error] of cases) {
      const app = await bareRouterApp({ role: "all", identity: who, store, keys, devices });
      const res = await app.inject({ method: "POST", url: "/api/device/router-key" });
      assert.equal(res.statusCode, status, `${error}: ${res.body}`);
      assert.equal(res.json().error, error);
      await app.close();
    }
    assert.equal(fake.callsTo("/key/generate").length, 0);
  });

  test("a revoke that lands while minting: the new key is deleted, not handed out", async () => {
    const fake = new FakeLitellm();
    const store = new MemoryStore();
    const devices: Device[] = [DEVICE];
    // The revoke marks the device while /key/generate is in flight.
    const racing: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/key/generate") devices[0] = { ...DEVICE, revokedAt: "2026-10-04T10:00:00.000Z" };
      return fake.fetch(input, init);
    };
    const keys = createLitellmKeys(CONFIG, store, { fetch: racing })!;
    const app = await bareRouterApp({ role: "link", identity, store, keys, devices });
    const res = await app.inject({ method: "POST", url: "/api/device/router-key" });
    assert.equal(res.statusCode, 404, res.body);
    assert.deepEqual(res.json(), { error: "device not found" });
    assert.ok(!res.body.includes("sk-fake"));
    assert.equal(fake.keys.size, 0, "the fresh key is gone from LiteLLM");
    assert.ok((await store.routerKeys.findByAlias(`kernal-device-${DEVICE.id}`))?.deletedAt);
    await app.close();
  });

  test("503 without minting; 502 when LiteLLM fails", async () => {
    const store = new MemoryStore();
    const off = await bareRouterApp({ role: "link", identity, store, devices: [DEVICE] });
    const res = await off.inject({ method: "POST", url: "/api/device/router-key" });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: "router_keys_unavailable" });
    await off.close();

    const fake = new FakeLitellm();
    fake.down = true;
    const keys = createLitellmKeys(CONFIG, store, { fetch: fake.fetch })!;
    const down = await bareRouterApp({ role: "link", identity, store, keys, devices: [DEVICE] });
    const failed = await down.inject({ method: "POST", url: "/api/device/router-key" });
    assert.equal(failed.statusCode, 502);
    assert.deepEqual(failed.json(), { error: "router_key_failed", detail: "LiteLLM did not answer" });
    await down.close();
  });
});
