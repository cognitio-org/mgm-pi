// #389 central sign-in and settings: the spec-owned pieces of the contract
// (docs/specs/central-auth.md): the user id, the device lifecycle hooks, the public device paths,
// and the settings schema's own consistency.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { userIdFor } from "../src/central/user-id.ts";
import { DeviceLifecycle, type LifecycleDevice } from "../src/central/device-lifecycle.ts";
import { isPublicDevicePath } from "../src/central/device-tokens.ts";
import { SETTINGS_SCHEMA, SETTING_LEVELS, SETTINGS_SCHEMA_VERSION } from "../src/central/settings-schema.ts";
import { resolveConfig } from "../src/central/settings-resolver.ts";
import { defaultFleetSettings } from "../src/fleet-settings.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { buildTestApp } from "./helpers.ts";

const device: LifecycleDevice = { id: "dev_abc", userId: "u_1", ownerEmail: "a@example.com", name: "mbp" };

describe("userIdFor", () => {
  test("is stable, case- and space-insensitive, and not the email", () => {
    const id = userIdFor("A@Example.com ");
    assert.equal(id, userIdFor("a@example.com"));
    assert.match(id, /^u_[0-9a-f]{24}$/);
    assert.notEqual(id, userIdFor("b@example.com"));
  });
});

describe("DeviceLifecycle", () => {
  test("merges deliveries in order and reports a failing hook without failing the login", async () => {
    const logged: string[] = [];
    const lifecycle = new DeviceLifecycle((msg) => logged.push(msg));
    lifecycle.register({ name: "first", onLogin: async () => ({ routerKey: { key: "k1", baseUrl: "b", alias: "a1" } }) });
    lifecycle.register({ name: "router key", onLogin: async () => { throw new Error("LiteLLM did not answer\nstack"); } });
    lifecycle.register({ name: "last", onLogin: async () => ({ routerKey: { key: "k2", baseUrl: "b", alias: "a2" } }) });
    const result = await lifecycle.login({ device });
    assert.equal(result.delivery.routerKey?.key, "k2");
    assert.deepEqual(result.problems, ["router key: LiteLLM did not answer"]);
    assert.equal(logged.length, 1);
  });

  test("runs every revoke hook even when one throws", async () => {
    const seen: string[] = [];
    const lifecycle = new DeviceLifecycle();
    lifecycle.register({ name: "a", onRevoked: async () => { throw new Error("boom"); } });
    lifecycle.register({ name: "b", onRevoked: async (e) => { seen.push(`${e.device.id}:${e.reason}`); } });
    await lifecycle.revoked({ device, reason: "logout" });
    assert.deepEqual(seen, ["dev_abc:logout"]);
  });
});

describe("isPublicDevicePath", () => {
  test("only the four device-flow POSTs, query strings ignored", () => {
    for (const p of ["/api/device/code", "/api/device/token", "/api/device/refresh", "/api/device/revoke?x=1"]) assert.ok(isPublicDevicePath("POST", p), p);
    assert.ok(!isPublicDevicePath("GET", "/api/device/code"));
    assert.ok(!isPublicDevicePath("POST", "/api/device/approve"));
    assert.ok(!isPublicDevicePath("POST", "/api/device/provider-keys"));
    assert.ok(!isPublicDevicePath("POST", "/api/device/code/extra"));
  });

  test("the link role still refuses every other /api route without a token", async () => {
    const app = await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_DEV: "0" });
    try {
      const res = await app.fastify.inject({ method: "GET", url: "/api/me" });
      assert.equal(res.statusCode, 401);
    } finally {
      app.stopBackgroundTasks();
      await app.fastify.close();
    }
  });
});

describe("settings schema", () => {
  test("keys are unique, levels valid, rules consistent with types, defaults typed", () => {
    const keys = new Set<string>();
    for (const d of SETTINGS_SCHEMA) {
      assert.ok(!keys.has(d.key), `duplicate ${d.key}`);
      keys.add(d.key);
      assert.match(d.key, /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/, d.key);
      assert.ok(d.levels.length > 0 && d.levels.every((l) => (SETTING_LEVELS as readonly string[]).includes(l)), d.key);
      assert.ok(d.since >= 1 && d.since <= SETTINGS_SCHEMA_VERSION, d.key);
      if (d.override === "opt-out") assert.equal(d.type, "boolean", d.key);
      if (d.type === "enum") assert.ok(d.values && d.values.length > 0, d.key);
      if (d.secret) assert.equal(d.default, undefined, `${d.key}: a secret has no default`);
      if (d.default !== undefined) {
        const want = d.type === "boolean" ? "boolean" : d.type === "number" ? "number" : "string";
        assert.equal(typeof d.default, want, d.key);
        if (d.type === "enum") assert.ok(d.values!.includes(d.default as string), d.key);
      }
    }
  });

  test("the stub resolver returns non-secret defaults with source default", async () => {
    const res = await resolveConfig(new MemoryStore(), defaultFleetSettings(), { email: "a@example.com" });
    assert.equal(res.schemaVersion, SETTINGS_SCHEMA_VERSION);
    assert.equal(res.account.userId, userIdFor("a@example.com"));
    assert.equal(res.values["router.baseUrl"]?.source, "default");
    assert.equal(res.values["router.key"], undefined);
  });
});
