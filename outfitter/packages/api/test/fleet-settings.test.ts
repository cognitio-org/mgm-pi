// Fleet settings (fleet-settings.ts): the stored document's defaults and validation, the instance
// cache, GET /api/fleet-settings (any signed-in caller, a Dongle on the link role included), the
// operator-only PUT, and run.spec's `telemetry` for agentd.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp } from "./helpers.ts";
import { openAgentSocket, makeRunningSession, sendHello } from "./agent-socket.ts";
import { MemoryStore } from "../src/store/memory.ts";
import {
  FleetSettingsCache,
  clientFleetSettings,
  DEFAULT_SENTRY_DSN,
  defaultFleetSettings,
  ensureFleetSettings,
  isSentryDsn,
  parseSentryUpdate,
  withDefaults,
  type FleetSettings,
} from "../src/fleet-settings.ts";
import { resetSentryForTests } from "../src/sentry.ts";

// Nothing listens on port 9: a test that turns Sentry on never reaches a real Sentry project.
const DSN = "http://publicKey@127.0.0.1:9/1";
const OPERATOR_ENV = { OUTFITTER_DEV: "0", OUTFITTER_OPERATORS: "operator@mgms.eu" };

afterEach(async () => {
  await resetSentryForTests();
});

function on(dsn = DSN, tracesSampleRate = 0.05): FleetSettings {
  return { telemetry: { sentry: { enabled: true, dsn, tracesSampleRate } } };
}

/** A Dongle for `ownerEmail`, minted through a throwaway dev-mode app on the same store. */
async function bearerFor(store: MemoryStore, ownerEmail: string): Promise<{ authorization: string }> {
  const dev = await buildTestApp({}, { store });
  const created = await dev.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: { name: "t" } });
  await store.tokens.update(created.json().record.id, { ownerEmail });
  await dev.fastify.close();
  return { authorization: `Bearer ${created.json().token}` };
}

describe("fleet settings document", () => {
  test("no document means Sentry off at a 5% trace rate, with the project DSN kept for later", () => {
    assert.deepEqual(withDefaults(null), defaultFleetSettings());
    assert.deepEqual(defaultFleetSettings().telemetry.sentry, { enabled: false, dsn: DEFAULT_SENTRY_DSN, tracesSampleRate: 0.05 });
    assert.equal(isSentryDsn(DEFAULT_SENTRY_DSN), true);
    assert.deepEqual(clientFleetSettings(defaultFleetSettings()).telemetry.sentry, { enabled: false }, "never sent to clients while off");
  });

  test("ensureFleetSettings stores the defaults once and never overwrites an operator's document", async () => {
    const store = new MemoryStore();
    assert.equal(await ensureFleetSettings(store), true);
    assert.equal((await store.fleetSettings.get())?.telemetry.sentry.dsn, DEFAULT_SENTRY_DSN);
    assert.equal((await store.fleetSettings.get())?.telemetry.sentry.enabled, false);
    const cleared = { telemetry: { sentry: { enabled: false, tracesSampleRate: 0.05 } }, updatedBy: "operator@mgms.eu" };
    await store.fleetSettings.put(cleared);
    assert.equal(await ensureFleetSettings(store), false);
    assert.deepEqual(await store.fleetSettings.get(), cleared, "a DSN the operator removed stays removed");
  });

  test("malformed stored fields read as their defaults", () => {
    const s = withDefaults({ telemetry: { sentry: { enabled: "yes", dsn: 7, tracesSampleRate: 3 } } } as never);
    assert.deepEqual(s.telemetry.sentry, { enabled: false, tracesSampleRate: 0.05 });
  });

  test("clients get the DSN only while Sentry is on", () => {
    assert.deepEqual(clientFleetSettings(on()).telemetry.sentry, { enabled: true, dsn: DSN, tracesSampleRate: 0.05 });
    const off = { telemetry: { sentry: { enabled: false, dsn: DSN, tracesSampleRate: 0.05 } } };
    assert.deepEqual(clientFleetSettings(off).telemetry.sentry, { enabled: false });
  });

  test("enabled without a DSN is off for clients", () => {
    const s = { telemetry: { sentry: { enabled: true, tracesSampleRate: 0.05 } } };
    assert.deepEqual(clientFleetSettings(s).telemetry.sentry, { enabled: false });
  });

  test("isSentryDsn accepts a project DSN and rejects lookalikes", () => {
    assert.equal(isSentryDsn("https://abc123@o4512181408432128.ingest.us.sentry.io/4512181422260224"), true);
    assert.equal(isSentryDsn("https://o0.ingest.sentry.io/1"), false, "no public key");
    assert.equal(isSentryDsn("https://abc@o0.ingest.sentry.io/"), false, "no project id");
    assert.equal(isSentryDsn("https://abc:secret@o0.ingest.sentry.io/1"), false, "a secret key has no place here");
    assert.equal(isSentryDsn("ftp://abc@o0.ingest.sentry.io/1"), false);
    assert.equal(isSentryDsn("http://abc@o0.ingest.sentry.io/1"), false, "clear text, outside dev");
    assert.equal(isSentryDsn("http://abc@127.0.0.1:9/1", true), true);
    assert.equal(isSentryDsn("not a url"), false);
  });

  test("parseSentryUpdate: on needs a DSN, the rate is 0..1, an empty DSN is removed", () => {
    assert.ok("error" in parseSentryUpdate({}));
    assert.ok("error" in parseSentryUpdate({ telemetry: { sentry: { enabled: true } } }));
    assert.ok("error" in parseSentryUpdate({ telemetry: { sentry: { enabled: true, dsn: "nope" } } }));
    assert.ok("error" in parseSentryUpdate({ telemetry: { sentry: { enabled: false, tracesSampleRate: 1.5 } } }));
    assert.deepEqual(parseSentryUpdate({ telemetry: { sentry: { enabled: false, dsn: "  " } } }), { value: { enabled: false, tracesSampleRate: 0.05 } });
    assert.deepEqual(parseSentryUpdate({ telemetry: { sentry: { enabled: true, dsn: ` ${DSN} `, tracesSampleRate: 0.2 } } }, { allowHttp: true }), {
      value: { enabled: true, dsn: DSN, tracesSampleRate: 0.2 },
    });
    assert.ok("error" in parseSentryUpdate({ telemetry: { sentry: { enabled: true, dsn: DSN } } }), "http:// only in dev");
  });
});

describe("FleetSettingsCache", () => {
  test("re-reads the store only once the copy is older than maxAgeMs", async () => {
    const store = new MemoryStore();
    let now = 0;
    const cache = new FleetSettingsCache(store, 1000, () => now);
    assert.equal((await cache.get()).telemetry.sentry.enabled, false);
    await store.fleetSettings.put(on());
    now = 999;
    assert.equal((await cache.get()).telemetry.sentry.enabled, false, "still the cached copy");
    now = 1000;
    assert.equal((await cache.get()).telemetry.sentry.enabled, true);
  });

  test("a failed read keeps the last good copy", async () => {
    const store = new MemoryStore();
    await store.fleetSettings.put(on());
    let now = 0;
    const cache = new FleetSettingsCache(store, 10, () => now);
    await cache.get();
    store.fleetSettings.get = async () => {
      throw new Error("mongo down");
    };
    now = 100;
    assert.equal((await cache.get()).telemetry.sentry.enabled, true);
  });

  test("a read that started before an operator's change cannot undo it", async () => {
    const store = new MemoryStore();
    await store.fleetSettings.put(on());
    let release!: () => void;
    const realGet = store.fleetSettings.get.bind(store.fleetSettings);
    store.fleetSettings.get = async () => {
      const doc = await realGet(); // the old document: on
      await new Promise<void>((r) => { release = r; });
      return doc;
    };
    const cache = new FleetSettingsCache(store);
    const stale = cache.get();
    await new Promise((r) => setImmediate(r));
    cache.set(defaultFleetSettings()); // the operator's PUT: off
    release();
    assert.equal((await stale).telemetry.sentry.enabled, false);
    assert.equal((await cache.get()).telemetry.sentry.enabled, false);
  });

  test("onChange listeners see every new copy, set() included", async () => {
    const cache = new FleetSettingsCache(new MemoryStore());
    const seen: boolean[] = [];
    cache.onChange((s) => seen.push(s.telemetry.sentry.enabled));
    await cache.get();
    cache.set(on());
    assert.deepEqual(seen, [false, true]);
  });
});

describe("GET /api/fleet-settings", () => {
  test("off before an operator saved anything", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "GET", url: "/api/fleet-settings" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { telemetry: { sentry: { enabled: false } } });
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a laptop's Dongle reads it on the link role", async () => {
    const store = new MemoryStore();
    await store.fleetSettings.put({ ...on(), updatedAt: "2026-10-03T00:00:00.000Z", updatedBy: "operator@mgms.eu" });
    const auth = await bearerFor(store, "someone@mgms.eu");
    const app = await buildTestApp({ OUTFITTER_DEV: "0", OUTFITTER_ROLE: "link" }, { store });
    const res = await app.fastify.inject({ method: "GET", url: "/api/fleet-settings", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.05 } },
      updatedAt: "2026-10-03T00:00:00.000Z",
    });
    assert.equal(res.json().updatedBy, undefined, "who changed it is for operators only");
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("needs a signed-in caller", async () => {
    const app = await buildTestApp({ OUTFITTER_DEV: "0", OUTFITTER_ROLE: "link" });
    const res = await app.fastify.inject({ method: "GET", url: "/api/fleet-settings" });
    assert.equal(res.statusCode, 401);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});

describe("PUT /api/operator/fleet-settings", () => {
  const body = { telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.1 } } };

  test("an operator turns Sentry on; clients and the operator view see it", async () => {
    const app = await buildTestApp();
    const put = await app.fastify.inject({ method: "PUT", url: "/api/operator/fleet-settings", payload: body });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().updatedBy, "dev@localhost");
    const client = await app.fastify.inject({ method: "GET", url: "/api/fleet-settings" });
    assert.deepEqual(client.json().telemetry.sentry, { enabled: true, dsn: DSN, tracesSampleRate: 0.1 });
    const operator = await app.fastify.inject({ method: "GET", url: "/api/operator/settings" });
    assert.equal(operator.json().fleetSettings.telemetry.sentry.dsn, DSN);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("turning it off keeps the DSN for the operator but not for clients", async () => {
    const app = await buildTestApp();
    await app.fastify.inject({ method: "PUT", url: "/api/operator/fleet-settings", payload: body });
    await app.fastify.inject({
      method: "PUT",
      url: "/api/operator/fleet-settings",
      payload: { telemetry: { sentry: { enabled: false, dsn: DSN, tracesSampleRate: 0.1 } } },
    });
    const client = await app.fastify.inject({ method: "GET", url: "/api/fleet-settings" });
    assert.deepEqual(client.json().telemetry.sentry, { enabled: false });
    const operator = await app.fastify.inject({ method: "GET", url: "/api/operator/settings" });
    assert.deepEqual(operator.json().fleetSettings.telemetry.sentry, { enabled: false, dsn: DSN, tracesSampleRate: 0.1 });
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("400 on an invalid body, and nothing is stored", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/api/operator/fleet-settings",
      payload: { telemetry: { sentry: { enabled: true, dsn: "https://nokey.example/1" } } },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(await app.store.fleetSettings.get(), null);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("403 for a non-operator", async () => {
    const store = new MemoryStore();
    const auth = await bearerFor(store, "someone@mgms.eu");
    const app = await buildTestApp(OPERATOR_ENV, { store });
    const res = await app.fastify.inject({ method: "PUT", url: "/api/operator/fleet-settings", payload: body, headers: auth });
    assert.equal(res.statusCode, 403);
    assert.equal(await store.fleetSettings.get(), null);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("not registered on the link role: a Dongle can read the settings, never change them", async () => {
    const store = new MemoryStore();
    const auth = await bearerFor(store, "operator@mgms.eu");
    const app = await buildTestApp({ ...OPERATOR_ENV, OUTFITTER_ROLE: "link" }, { store });
    const res = await app.fastify.inject({ method: "PUT", url: "/api/operator/fleet-settings", payload: body, headers: auth });
    assert.equal(res.statusCode, 404);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});

describe("run.spec telemetry", () => {
  test("absent while Sentry is off", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(spec.telemetry, undefined);
    agent.close();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("carries the DSN, rate and environment while it is on", async () => {
    const app = await buildTestApp();
    await app.fastify.inject({
      method: "PUT",
      url: "/api/operator/fleet-settings",
      payload: { telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.25 } } },
    });
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.deepEqual(spec.telemetry, { sentry: { dsn: DSN, tracesSampleRate: 0.25, environment: "development" } });
    agent.close();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});
