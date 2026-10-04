// Central settings routes, CA-3 (#392, docs/specs/central-auth.md §3.4-§3.5): GET /api/config,
// the schema, the user/profile/device levels with If-Match versioned writes, profile CRUD, the
// operator fleet write, and that GET /api/fleet-settings stays what older Kernals read.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { buildTestApp, type TestApp } from "./helpers.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { FleetSettingsCache } from "../src/fleet-settings.ts";
import { registerConfigRoutes, parseIfMatch } from "../src/routes/config.ts";
import type { RouteContext } from "../src/routes/context.ts";
import type { Identity } from "../src/auth.ts";
import type { Device } from "../src/store/devices.ts";
import { userIdFor } from "../src/central/user-id.ts";
import { SETTINGS_SCHEMA_VERSION } from "../src/central/settings-schema.ts";

const DEV = "dev@localhost";
const DSN = "http://publicKey@127.0.0.1:9/1";

function device(id: string, ownerEmail: string): Device {
  return { id, userId: userIdFor(ownerEmail), ownerEmail, name: id, kind: "laptop", createdAt: "2026-10-04T00:00:00.000Z", approvedBy: ownerEmail, accessHash: `h-${id}`, accessExpiresAt: "2026-10-04T01:00:00.000Z" };
}

/** CA-1's devices collection is a stub until it lands: give `store` these active devices. */
function withDevices(store: MemoryStore, devices: Device[]): void {
  store.devices.listActiveForOwner = async (email: string) => devices.filter((d) => d.ownerEmail === email && !d.revokedAt);
}

async function devApp(): Promise<TestApp> {
  return buildTestApp();
}

async function close(app: TestApp): Promise<void> {
  app.stopBackgroundTasks();
  await app.fastify.close();
}

/** A bare app with only the config routes, the caller's identity from the `x-test-identity`
 * header (JSON), so device-token and Dongle callers can be tested before CA-1's auth lands. */
async function bareApp(store: MemoryStore, role: "link" | "web"): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    const raw = req.headers["x-test-identity"];
    req.identity = JSON.parse(typeof raw === "string" ? raw : "{}") as Identity;
  });
  const ctx = { store, config: { role, devMode: false }, fleetSettings: new FleetSettingsCache(store) } as unknown as RouteContext;
  await registerConfigRoutes(app, ctx);
  return app;
}

const as = (identity: Identity) => ({ "x-test-identity": JSON.stringify(identity) });
const kernal = (email: string, deviceId: string) => as({ email, operator: false, viaToken: true, deviceId });
const dongle = (email: string) => as({ email, operator: false, viaToken: true });

describe("parseIfMatch", () => {
  test("weak or strong quoted versions only", () => {
    assert.equal(parseIfMatch('W/"5"'), 5);
    assert.equal(parseIfMatch('"0"'), 0);
    assert.equal(parseIfMatch("5"), undefined);
    assert.equal(parseIfMatch('W/"x"'), undefined);
    assert.equal(parseIfMatch(undefined), undefined);
  });
});

describe("GET /api/config and the schema", () => {
  test("a new user gets schema defaults, no profile, version 0 everywhere", async () => {
    const app = await devApp();
    try {
      const schema = await app.fastify.inject({ method: "GET", url: "/api/config/schema" });
      assert.equal(schema.statusCode, 200);
      assert.equal(schema.json().schemaVersion, SETTINGS_SCHEMA_VERSION);
      const res = await app.fastify.inject({ method: "GET", url: "/api/config" });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.account, { email: DEV, userId: userIdFor(DEV) });
      assert.equal(body.profile, null);
      assert.deepEqual(body.profiles, []);
      assert.equal(body.values["model.provider"].source, "default");
      assert.deepEqual(body.versions, { fleet: 0, user: 0 });
      assert.equal(res.headers["cache-control"], "no-store");
    } finally {
      await close(app);
    }
  });

  test("an unknown profile is 404 with the profiles the user has", async () => {
    const app = await devApp();
    try {
      await app.fastify.inject({ method: "POST", url: "/api/config/profiles", payload: { name: "work" } });
      const res = await app.fastify.inject({ method: "GET", url: "/api/config?profile=home" });
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.json(), { error: "unknown_profile", profiles: ["work"] });
    } finally {
      await close(app);
    }
  });

  test("on web, ?device= may name only the caller's own active devices", async () => {
    const store = new MemoryStore();
    withDevices(store, [device("dev_mine", DEV), device("dev_theirs", "b@example.com")]);
    const app = await buildTestApp({}, { store });
    try {
      assert.equal((await app.fastify.inject({ method: "GET", url: "/api/config?device=dev_mine" })).json().deviceId, "dev_mine");
      assert.equal((await app.fastify.inject({ method: "GET", url: "/api/config?device=dev_theirs" })).statusCode, 404);
    } finally {
      await close(app);
    }
  });
});

describe("versioned writes on the user level", () => {
  test("ETag, If-Match required, 409 with the current document on a stale write", async () => {
    const app = await devApp();
    try {
      const get = await app.fastify.inject({ method: "GET", url: "/api/config/user" });
      assert.equal(get.headers.etag, 'W/"0"');
      assert.deepEqual(get.json().values, {});

      const noMatch = await app.fastify.inject({ method: "PUT", url: "/api/config/user", payload: { values: { "model.default": "a" } } });
      assert.equal(noMatch.statusCode, 428);
      assert.deepEqual(noMatch.json(), { error: "if_match_required" });

      const put = await app.fastify.inject({ method: "PUT", url: "/api/config/user", headers: { "if-match": 'W/"0"' }, payload: { values: { "model.default": "a", "voice.enabled": true } } });
      assert.equal(put.statusCode, 200);
      assert.equal(put.headers.etag, 'W/"1"');
      assert.deepEqual(put.json().values, { "model.default": "a", "voice.enabled": true });

      const stale = await app.fastify.inject({ method: "PUT", url: "/api/config/user", headers: { "if-match": 'W/"0"' }, payload: { values: { "model.default": "b" } } });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error, "stale_version");
      assert.equal(stale.json().current.values["model.default"], "a", "the current document, never overwritten");

      const merge = await app.fastify.inject({ method: "PUT", url: "/api/config/user", headers: { "if-match": 'W/"1"' }, payload: { values: { "voice.enabled": null } } });
      assert.deepEqual(merge.json().values, { "model.default": "a" }, "merged; null removes");

      const cfg = (await app.fastify.inject({ method: "GET", url: "/api/config" })).json();
      assert.equal(cfg.values["model.default"].source, "user");
      assert.equal(cfg.versions.user, 2);
    } finally {
      await close(app);
    }
  });

  test("400 for an unknown key, a level the key doesn't allow, a bad value, a secret", async () => {
    const app = await devApp();
    try {
      const put = (values: unknown) => app.fastify.inject({ method: "PUT", url: "/api/config/user", headers: { "if-match": 'W/"0"' }, payload: { values } });
      assert.deepEqual((await put({ "x.y": 1 })).json(), { error: "unknown_key", key: "x.y" });
      assert.deepEqual((await put({ "router.baseUrl": "https://x" })).json(), { error: "level_not_allowed", key: "router.baseUrl" });
      assert.deepEqual((await put({ "model.provider": "ollama" })).json(), { error: "invalid_value", key: "model.provider" });
      assert.deepEqual((await put({ "router.key": "sk-x" })).json(), { error: "unknown_key", key: "router.key" });
      assert.equal((await put({ "x.y": 1 })).statusCode, 400);
      assert.equal((await app.fastify.inject({ method: "GET", url: "/api/config/user" })).json().version, 0, "nothing written");
    } finally {
      await close(app);
    }
  });
});

describe("profiles", () => {
  test("create, copy, edit, make default, rename, delete", async () => {
    const app = await devApp();
    const f = app.fastify;
    try {
      const work = await f.inject({ method: "POST", url: "/api/config/profiles", payload: { name: "work" } });
      assert.equal(work.statusCode, 201);
      assert.equal(work.headers.etag, 'W/"1"');
      assert.deepEqual(work.json(), { id: `profile:${userIdFor(DEV)}:work`, level: "profile", name: "work", isDefault: false, values: {}, version: 1, updatedAt: work.json().updatedAt });

      assert.equal((await f.inject({ method: "POST", url: "/api/config/profiles", payload: { name: "work" } })).statusCode, 409);
      assert.deepEqual((await f.inject({ method: "POST", url: "/api/config/profiles", payload: { name: "Work!" } })).json(), { error: "invalid_name" });

      const edit = await f.inject({ method: "PUT", url: "/api/config/profiles/work", headers: { "if-match": 'W/"1"' }, payload: { values: { "model.default": "work-model" } } });
      assert.equal(edit.statusCode, 200);
      assert.equal(edit.json().version, 2);

      const copy = await f.inject({ method: "POST", url: "/api/config/profiles", payload: { name: "home", copyFrom: "work" } });
      assert.deepEqual(copy.json().values, { "model.default": "work-model" });
      assert.equal((await f.inject({ method: "POST", url: "/api/config/profiles", payload: { name: "x", copyFrom: "nope" } })).statusCode, 404);

      // Not default yet: GET /api/config doesn't apply it.
      assert.equal((await f.inject({ method: "GET", url: "/api/config" })).json().profile, null);

      const def = await f.inject({ method: "PATCH", url: "/api/config/profiles/work", headers: { "if-match": 'W/"2"' }, payload: { isDefault: true } });
      assert.equal(def.statusCode, 200);
      assert.equal(def.json().isDefault, true);
      const cfg = (await f.inject({ method: "GET", url: "/api/config" })).json();
      assert.equal(cfg.profile, "work");
      assert.deepEqual(cfg.profiles, ["home", "work"]);
      assert.equal(cfg.values["model.default"].sourceName, "work");

      const homeDef = await f.inject({ method: "PATCH", url: "/api/config/profiles/home", headers: { "if-match": 'W/"1"' }, payload: { isDefault: true } });
      assert.equal(homeDef.json().isDefault, true);
      const list = (await f.inject({ method: "GET", url: "/api/config/profiles" })).json() as Array<{ name: string; isDefault: boolean; version: number }>;
      assert.deepEqual(list.map((p) => [p.name, p.isDefault]), [["home", true], ["work", false]], "one default per user");
      const workNow = list.find((p) => p.name === "work")!;
      assert.equal(workNow.version, 4, "clearing the old default bumped its version");

      const renamed = await f.inject({ method: "PATCH", url: "/api/config/profiles/home", headers: { "if-match": homeDef.headers.etag as string }, payload: { rename: "personal" } });
      assert.equal(renamed.statusCode, 200);
      assert.equal(renamed.json().name, "personal");
      assert.equal(renamed.json().isDefault, true, "a rename keeps the default");
      assert.equal((await f.inject({ method: "GET", url: "/api/config/profiles/home" })).statusCode, 404);
      assert.equal((await f.inject({ method: "PATCH", url: "/api/config/profiles/personal", headers: { "if-match": renamed.headers.etag as string }, payload: { rename: "work" } })).statusCode, 409, "name taken");

      const staleDelete = await f.inject({ method: "DELETE", url: "/api/config/profiles/work", headers: { "if-match": 'W/"1"' } });
      assert.equal(staleDelete.statusCode, 409);
      assert.equal(staleDelete.json().current.version, 4);
      assert.equal((await f.inject({ method: "DELETE", url: "/api/config/profiles/work" })).statusCode, 428);
      assert.equal((await f.inject({ method: "DELETE", url: "/api/config/profiles/work", headers: { "if-match": 'W/"4"' } })).statusCode, 204);
      assert.equal((await f.inject({ method: "DELETE", url: "/api/config/profiles/work", headers: { "if-match": 'W/"4"' } })).statusCode, 404);
    } finally {
      await close(app);
    }
  });

  test("a profile can only be written after it was created, and only with profile-level keys", async () => {
    const app = await devApp();
    try {
      const missing = await app.fastify.inject({ method: "PUT", url: "/api/config/profiles/work", headers: { "if-match": 'W/"0"' }, payload: { values: { "model.default": "m" } } });
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error, "unknown_profile");
      await app.fastify.inject({ method: "POST", url: "/api/config/profiles", payload: { name: "work" } });
      const sentry = await app.fastify.inject({ method: "PUT", url: "/api/config/profiles/work", headers: { "if-match": 'W/"1"' }, payload: { values: { "telemetry.sentry.enabled": false } } });
      assert.deepEqual(sentry.json(), { error: "level_not_allowed", key: "telemetry.sentry.enabled" });
    } finally {
      await close(app);
    }
  });
});

describe("the device level", () => {
  test("own active devices only; the device's values reach GET /api/config?device=", async () => {
    const store = new MemoryStore();
    withDevices(store, [device("dev_mine", DEV), device("dev_theirs", "b@example.com")]);
    const app = await buildTestApp({}, { store });
    try {
      assert.equal((await app.fastify.inject({ method: "GET", url: "/api/config/devices/dev_theirs" })).statusCode, 404);
      assert.equal((await app.fastify.inject({ method: "PUT", url: "/api/config/devices/dev_theirs", headers: { "if-match": 'W/"0"' }, payload: { values: {} } })).statusCode, 404);
      const get = await app.fastify.inject({ method: "GET", url: "/api/config/devices/dev_mine" });
      assert.equal(get.json().version, 0);
      const put = await app.fastify.inject({ method: "PUT", url: "/api/config/devices/dev_mine", headers: { "if-match": 'W/"0"' }, payload: { values: { "localHost.shareModels": true } } });
      assert.equal(put.statusCode, 200);
      const cfg = (await app.fastify.inject({ method: "GET", url: "/api/config?device=dev_mine" })).json();
      assert.equal(cfg.values["localHost.shareModels"].source, "device");
      assert.equal(cfg.versions.device, 1);
    } finally {
      await close(app);
    }
  });
});

describe("link role: device tokens and Dongles", () => {
  test("a signed-in Kernal reads its own device by default and never another's", async () => {
    const store = new MemoryStore();
    const email = "a@example.com";
    withDevices(store, [device("dev_a", email), device("dev_b", email)]);
    const app = await bareApp(store, "link");
    try {
      await app.inject({ method: "PUT", url: "/api/config/devices/dev_a", headers: { ...kernal(email, "dev_a"), "if-match": 'W/"0"' }, payload: { values: { "voice.language": "fr" } } });
      const own = await app.inject({ method: "GET", url: "/api/config", headers: kernal(email, "dev_a") });
      assert.equal(own.json().deviceId, "dev_a");
      assert.equal(own.json().values["voice.language"].source, "device");
      const other = await app.inject({ method: "GET", url: "/api/config?device=dev_b", headers: kernal(email, "dev_a") });
      assert.equal(other.statusCode, 403);
    } finally {
      await app.close();
    }
  });

  test("a device token writes its user's settings; a Dongle only reads GET /api/config and the schema", async () => {
    const store = new MemoryStore();
    const email = "a@example.com";
    const app = await bareApp(store, "link");
    try {
      const put = await app.inject({ method: "PUT", url: "/api/config/user", headers: { ...kernal(email, "dev_a"), "if-match": 'W/"0"' }, payload: { values: { "model.default": "m" } } });
      assert.equal(put.statusCode, 200);
      assert.equal(put.json().id, `user:${userIdFor(email)}`);

      assert.equal((await app.inject({ method: "GET", url: "/api/config", headers: dongle(email) })).json().values["model.default"].value, "m");
      assert.equal((await app.inject({ method: "GET", url: "/api/config/schema", headers: dongle(email) })).statusCode, 200);
      for (const [method, url] of [["GET", "/api/config/user"], ["PUT", "/api/config/user"], ["GET", "/api/config/profiles"], ["POST", "/api/config/profiles"], ["DELETE", "/api/config/profiles/work"]] as const) {
        const res = await app.inject({ method, url, headers: { ...dongle(email), "if-match": 'W/"1"' }, payload: method === "GET" || method === "DELETE" ? undefined : { values: {}, name: "work" } });
        assert.equal(res.statusCode, 403, `${method} ${url}`);
      }
    } finally {
      await app.close();
    }
  });

  test("the fleet write is not registered on link", async () => {
    const app = await bareApp(new MemoryStore(), "link");
    try {
      const res = await app.inject({ method: "GET", url: "/api/operator/config/fleet", headers: as({ email: "op@x", operator: true }) });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  test("outside dev mode a fleet URL must be https, and a stored http one never reaches a Kernal", async () => {
    const store = new MemoryStore();
    const app = await bareApp(store, "web");
    try {
      const op = as({ email: "op@x", operator: true });
      const put = (url: string) => app.inject({ method: "PUT", url: "/api/operator/config/fleet", headers: { ...op, "if-match": 'W/"0"' }, payload: { values: { "router.baseUrl": url } } });
      const http = await put("http://router.example/v1");
      assert.equal(http.statusCode, 400);
      assert.deepEqual(http.json(), { error: "invalid_value", key: "router.baseUrl" });
      assert.equal((await put("https://router.example/v1")).statusCode, 200);

      // A value stored before this rule (or by hand) falls back to the default on reads.
      const fleet = await store.fleetSettings.get();
      await store.fleetSettings.replaceAtVersion({ ...fleet!, values: { "router.baseUrl": "http://router.example/v1" } }, fleet!.version ?? 0);
      const cfg = (await app.inject({ method: "GET", url: "/api/config", headers: kernal("a@example.com", "dev_a") })).json();
      assert.equal(cfg.values["router.baseUrl"].source, "default");
      assert.match(cfg.values["router.baseUrl"].value, /^https:/);
    } finally {
      await app.close();
    }
  });
});

describe("the fleet level", () => {
  test("operators only, versioned, Sentry keys into telemetry.sentry, GET /api/fleet-settings unchanged", async () => {
    const app = await devApp();
    const f = app.fastify;
    try {
      const get = await f.inject({ method: "GET", url: "/api/operator/config/fleet" });
      assert.equal(get.statusCode, 200);
      assert.equal(get.json().values["telemetry.sentry.enabled"], false);
      const v0 = get.headers.etag as string;
      assert.equal(v0, 'W/"0"');

      const put = await f.inject({
        method: "PUT",
        url: "/api/operator/config/fleet",
        headers: { "if-match": v0 },
        payload: { values: { "model.default": "fleet-model", "router.baseUrl": "https://r.example/v1", "telemetry.sentry.enabled": true, "telemetry.sentry.dsn": DSN, "telemetry.sentry.tracesSampleRate": 0.25 } },
      });
      assert.equal(put.statusCode, 200, put.body);
      assert.equal(put.headers.etag, 'W/"1"');
      const stored = await app.store.fleetSettings.get();
      assert.deepEqual(stored?.values, { "model.default": "fleet-model", "router.baseUrl": "https://r.example/v1" }, "Sentry keys not duplicated in values");
      assert.deepEqual(stored?.telemetry.sentry, { enabled: true, dsn: DSN, tracesSampleRate: 0.25 });
      assert.equal(stored?.version, 1);

      // Older Kernals read exactly what they read before.
      const legacy = (await f.inject({ method: "GET", url: "/api/fleet-settings" })).json();
      assert.deepEqual(legacy.telemetry, { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.25 } });
      assert.equal(legacy.values, undefined);
      assert.equal(legacy.version, undefined);

      const cfg = (await f.inject({ method: "GET", url: "/api/config" })).json();
      assert.equal(cfg.values["router.baseUrl"].locked, true);
      assert.equal(cfg.values["telemetry.sentry.enabled"].value, true);
      assert.equal(cfg.values["telemetry.sentry.dsn"].value, DSN);
      assert.equal(cfg.versions.fleet, 1);

      const stale = await f.inject({ method: "PUT", url: "/api/operator/config/fleet", headers: { "if-match": v0 }, payload: { values: { "model.default": "x" } } });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().current.version, 1);

      const badSentry = await f.inject({ method: "PUT", url: "/api/operator/config/fleet", headers: { "if-match": 'W/"1"' }, payload: { values: { "telemetry.sentry.dsn": null } } });
      assert.equal(badSentry.statusCode, 400);
      assert.equal(badSentry.json().key, "telemetry.sentry.dsn", "Sentry on needs a DSN");
      assert.deepEqual((await f.inject({ method: "PUT", url: "/api/operator/config/fleet", headers: { "if-match": 'W/"1"' }, payload: { values: { "localHost.shareModels": true } } })).json(), { error: "level_not_allowed", key: "localHost.shareModels" });

      // The older operator PUT bumps the version too, so an If-Match from before it is stale.
      const legacyPut = await f.inject({ method: "PUT", url: "/api/operator/fleet-settings", payload: { telemetry: { sentry: { enabled: false, dsn: DSN, tracesSampleRate: 0.1 } } } });
      assert.equal(legacyPut.statusCode, 200);
      assert.equal(legacyPut.json().version, 2);
      assert.deepEqual(legacyPut.json().values, { "model.default": "fleet-model", "router.baseUrl": "https://r.example/v1" }, "the Telemetry panel keeps the other fleet values");
      assert.equal((await f.inject({ method: "PUT", url: "/api/operator/config/fleet", headers: { "if-match": 'W/"1"' }, payload: { values: {} } })).statusCode, 409);
      const cleared = await f.inject({ method: "PUT", url: "/api/operator/config/fleet", headers: { "if-match": 'W/"2"' }, payload: { values: { "model.default": null, "router.baseUrl": null } } });
      assert.equal(cleared.statusCode, 200);
      assert.equal((await app.store.fleetSettings.get())?.values, undefined);
    } finally {
      await close(app);
    }
  });

  test("a non-operator gets 403", async () => {
    const app = await bareApp(new MemoryStore(), "web");
    try {
      const res = await app.inject({ method: "PUT", url: "/api/operator/config/fleet", headers: { ...as({ email: "a@example.com", operator: false }), "if-match": 'W/"0"' }, payload: { values: {} } });
      assert.equal(res.statusCode, 403);
    } finally {
      await app.close();
    }
  });
});
