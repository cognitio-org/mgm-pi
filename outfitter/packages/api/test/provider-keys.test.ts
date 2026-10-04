// #393 CA-4 (docs/specs/central-auth.md §4): personal provider keys. Write-only towards people
// (GET lists last4 only), stored in Secret Manager (MemorySecretAdmin here) under the hashed user
// id, delivered only to a device token. Device-token routes are exercised on a bare Fastify with
// the identity CA-1's preHandler will set, since device tokens land with CA-1.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { buildTestApp, laptopApp } from "./helpers.ts";
import { userIdFor } from "../src/central/user-id.ts";
import {
  PROVIDER_KEY_ENV,
  deliverProviderKeys,
  isValidProviderKeyValue,
  providerKeySecretName,
  setProviderKey,
} from "../src/central/provider-keys.ts";
import { registerKeyRoutes } from "../src/routes/keys.ts";
import type { RouteContext } from "../src/routes/context.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { MemorySecretAdmin, type SecretAdmin } from "../src/secrets.ts";
import type { Identity } from "../src/auth.ts";

const DEV_EMAIL = "dev@localhost";
const VALUE = "sk-or-v1-abcdefghijklmnop1234";

/** registerKeyRoutes on its own, behind a preHandler that sets `identity` (CA-1's job in server.ts). */
async function bareApp(opts: { role: "link" | "web" | "all"; identity: Identity; store?: MemoryStore; secrets?: SecretAdmin }) {
  const store = opts.store ?? new MemoryStore();
  const secrets = opts.secrets ?? new MemorySecretAdmin();
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.identity = opts.identity;
  });
  const ctx = { config: { role: opts.role, litellmBaseUrl: "https://router.test/v1" }, store, secretAdmin: secrets } as unknown as RouteContext;
  await registerKeyRoutes(app, ctx);
  await app.ready();
  return { app, store, secrets };
}

describe("provider key values and names", () => {
  test("8-512 printable ASCII, no whitespace", () => {
    assert.ok(isValidProviderKeyValue("12345678"));
    assert.ok(isValidProviderKeyValue("x".repeat(512)));
    for (const bad of ["1234567", "x".repeat(513), "sk-abc def12", "sk-abcdefgh\n", "sk-ключключ", 12345678, undefined]) {
      assert.ok(!isValidProviderKeyValue(bad), String(bad));
    }
  });

  test("the secret is named by the hashed user id, never the email", () => {
    const name = providerKeySecretName(userIdFor("A@Example.com"), "openrouter");
    assert.equal(name, `outfitter-user-${userIdFor("a@example.com")}-openrouter`);
    assert.ok(!name.includes("example"));
    assert.match(name, /^[A-Za-z0-9_-]+$/, "a valid Secret Manager id");
  });

  test("v1 providers and their Kernal env names", () => {
    assert.deepEqual(PROVIDER_KEY_ENV, {
      openrouter: "OPENROUTER_API_KEY",
      deepgram: "DEEPGRAM_API_KEY",
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      gemini: "GEMINI_API_KEY",
    });
  });
});

describe("/api/me/provider-keys (a person on web)", () => {
  test("PUT stores a Secret Manager version and answers last4 only; GET never shows the value", async () => {
    const app = await buildTestApp();
    const put = await app.fastify.inject({ method: "PUT", url: "/api/me/provider-keys/openrouter", payload: { value: VALUE } });
    assert.equal(put.statusCode, 200, put.body);
    const view = put.json();
    assert.deepEqual(Object.keys(view).sort(), ["last4", "provider", "setAt"]);
    assert.equal(view.provider, "openrouter");
    assert.equal(view.last4, "1234");
    assert.ok(!put.body.includes(VALUE));

    const secretName = providerKeySecretName(userIdFor(DEV_EMAIL), "openrouter");
    assert.equal(await app.secretAdmin.accessLatest(secretName), VALUE);

    const list = await app.fastify.inject({ method: "GET", url: "/api/me/provider-keys" });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), [view]);
    assert.ok(!list.body.includes(VALUE));

    const [meta] = await app.store.providerKeys.listForUser(userIdFor(DEV_EMAIL));
    assert.equal(meta.secretName, secretName);
    assert.equal(meta.setBy, DEV_EMAIL);
    assert.ok(!JSON.stringify(meta).includes(VALUE));
    await app.fastify.close();
  });

  test("replacing a key adds a version; the newest is what's delivered", async () => {
    const app = await buildTestApp();
    await app.fastify.inject({ method: "PUT", url: "/api/me/provider-keys/openai", payload: { value: "sk-first-value-0001" } });
    const again = await app.fastify.inject({ method: "PUT", url: "/api/me/provider-keys/openai", payload: { value: "sk-second-value-0002" } });
    assert.equal(again.json().last4, "0002");
    assert.equal(await app.secretAdmin.accessLatest(providerKeySecretName(userIdFor(DEV_EMAIL), "openai")), "sk-second-value-0002");
    assert.equal((await app.fastify.inject({ method: "GET", url: "/api/me/provider-keys" })).json().length, 1);
    await app.fastify.close();
  });

  test("DELETE disables the secret and drops the listing (204, idempotent)", async () => {
    const app = await buildTestApp();
    await app.fastify.inject({ method: "PUT", url: "/api/me/provider-keys/gemini", payload: { value: VALUE } });
    const del = await app.fastify.inject({ method: "DELETE", url: "/api/me/provider-keys/gemini" });
    assert.equal(del.statusCode, 204);
    assert.equal(await app.secretAdmin.accessLatest(providerKeySecretName(userIdFor(DEV_EMAIL), "gemini")), undefined);
    assert.deepEqual((await app.fastify.inject({ method: "GET", url: "/api/me/provider-keys" })).json(), []);
    assert.equal((await app.fastify.inject({ method: "DELETE", url: "/api/me/provider-keys/gemini" })).statusCode, 204);
    await app.fastify.close();
  });

  test("unknown provider and invalid values are 400 with the spec's codes", async () => {
    const app = await buildTestApp();
    const unknown = await app.fastify.inject({ method: "PUT", url: "/api/me/provider-keys/mistral", payload: { value: VALUE } });
    assert.equal(unknown.statusCode, 400);
    assert.deepEqual(unknown.json(), { error: "unknown_provider" });
    assert.deepEqual((await app.fastify.inject({ method: "DELETE", url: "/api/me/provider-keys/__proto__" })).json(), { error: "unknown_provider" });
    for (const payload of [{ value: "short" }, { value: "has space inside" }, {}, { value: 123456789 }]) {
      const res = await app.fastify.inject({ method: "PUT", url: "/api/me/provider-keys/openrouter", payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.deepEqual(res.json(), { error: "invalid_value" });
    }
    assert.deepEqual(await app.store.providerKeys.listForUser(userIdFor(DEV_EMAIL)), []);
    await app.fastify.close();
  });

  test("a Dongle on link is refused: only a person or a signed-in Kernal manages keys", async () => {
    const token = "outf_" + "d".repeat(43);
    const { app } = await laptopApp({ tokens: [["a@example.com", token]] });
    for (const [method, url] of [["GET", "/api/me/provider-keys"], ["PUT", "/api/me/provider-keys/openrouter"], ["DELETE", "/api/me/provider-keys/openrouter"]] as const) {
      const res = await app.fastify.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: method === "PUT" ? { value: VALUE } : undefined });
      assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`);
      assert.deepEqual(res.json(), { error: "device_login_required" });
    }
    const delivery = await app.fastify.inject({ method: "POST", url: "/api/device/provider-keys", headers: { authorization: `Bearer ${token}` } });
    assert.equal(delivery.statusCode, 403);
    assert.deepEqual(delivery.json(), { error: "device_token_required" });
    await app.fastify.close();
  });
});

describe("POST /api/device/provider-keys (delivery)", () => {
  test("a person (no device) is refused, and the route is not on web", async () => {
    const all = await buildTestApp();
    const res = await all.fastify.inject({ method: "POST", url: "/api/device/provider-keys" });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "device_token_required" });
    await all.fastify.close();

    const web = await bareApp({ role: "web", identity: { email: "a@example.com", operator: false, viaToken: true, deviceId: "dev_x" } });
    assert.equal((await web.app.inject({ method: "POST", url: "/api/device/provider-keys" })).statusCode, 404);
    await web.app.close();
  });

  test("a device token gets its owner's keys, no-store, and nobody else's", async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretAdmin();
    const deps = { providerKeys: store.providerKeys, secrets };
    await setProviderKey(deps, { userId: userIdFor("a@example.com"), provider: "openrouter", value: VALUE, setBy: "a@example.com" });
    await setProviderKey(deps, { userId: userIdFor("a@example.com"), provider: "deepgram", value: "dg-key-abcdefgh", setBy: "a@example.com" });
    await setProviderKey(deps, { userId: userIdFor("b@example.com"), provider: "openai", value: "sk-b-not-yours-123", setBy: "b@example.com" });

    const { app } = await bareApp({ role: "link", identity: { email: "a@example.com", operator: false, viaToken: true, deviceId: "dev_a" }, store, secrets });
    const res = await app.inject({ method: "POST", url: "/api/device/provider-keys" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.json(), { keys: { deepgram: "dg-key-abcdefgh", openrouter: VALUE } });

    // A device token may also write (Kernal's /admin, §11).
    const put = await app.inject({ method: "PUT", url: "/api/me/provider-keys/anthropic", payload: { value: "sk-ant-abcdefgh" } });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().last4, "efgh");
    await app.close();
  });

  test("a key that can't be read is left out; the rest are delivered", async () => {
    const store = new MemoryStore();
    const inner = new MemorySecretAdmin();
    const userId = userIdFor("a@example.com");
    const deps = { providerKeys: store.providerKeys, secrets: inner };
    await setProviderKey(deps, { userId, provider: "openrouter", value: VALUE, setBy: "a" });
    await setProviderKey(deps, { userId, provider: "openai", value: "sk-openai-12345678", setBy: "a" });
    const flaky: SecretAdmin = Object.assign(Object.create(inner), {
      accessLatest: async (name: string) => {
        if (name.endsWith("-openai")) throw new Error("PERMISSION_DENIED");
        return inner.accessLatest(name);
      },
    });
    const logged: string[] = [];
    const keys = await deliverProviderKeys({ providerKeys: store.providerKeys, secrets: flaky, log: (msg) => logged.push(msg) }, userId);
    assert.deepEqual(keys, { openrouter: VALUE });
    assert.equal(logged.length, 1);
    assert.ok(!logged[0].includes(VALUE));
  });
});
