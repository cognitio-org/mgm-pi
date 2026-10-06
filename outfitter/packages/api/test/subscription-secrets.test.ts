// Subscription secrets (docs/specs/subscriptions.md §3): write-only towards people (GET lists last4,
// setAt and the Secret Manager version, never the value), stored under the hashed user id, delivered
// only to a device token. Device-token routes use a bare Fastify with the identity CA-1's preHandler
// sets, the same way provider-keys.test.ts does.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { buildTestApp, laptopApp } from "./helpers.ts";
import { userIdFor } from "../src/central/user-id.ts";
import {
  deliverSubscriptionSecrets,
  isValidSubscriptionValue,
  setSubscriptionSecret,
  subscriptionLast4,
  subscriptionSecretName,
} from "../src/central/subscription-secrets.ts";
import { registerKeyRoutes } from "../src/routes/keys.ts";
import type { RouteContext } from "../src/routes/context.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { SubscriptionSecretMeta } from "../src/store/keys.ts";
import { MemorySecretAdmin, type SecretAdmin } from "../src/secrets.ts";
import type { Identity } from "../src/auth.ts";
import type { Device } from "../src/store/devices.ts";

const DEV_EMAIL = "dev@localhost";
const CLAUDE = "sk-ant-oat01-" + "a".repeat(24);
const CLAUDE_B = "sk-ant-oat01-" + "b".repeat(24);
const CLAUDE_C = "sk-ant-oat01-" + "c".repeat(24);
const GROK_JSON = '{\n  "access_token": "grok-file-secret",\n  "token_type": "Bearer"\n}\n';

function shaLast4(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(-4);
}

/** registerKeyRoutes on its own, behind a preHandler that sets `identity`. */
async function bareApp(opts: { role: "link" | "web" | "all"; identity: Identity; store?: MemoryStore; secrets?: SecretAdmin; devices?: Device[]; logs?: string[] }) {
  const memory = opts.store ?? new MemoryStore();
  const secrets = opts.secrets ?? new MemorySecretAdmin();
  const logs = opts.logs;
  const app = Fastify(logs ? { logger: { level: "info", stream: { write: (line: string) => void logs.push(line) } } } : {});
  app.addHook("preHandler", async (req) => {
    req.identity = opts.identity;
  });
  const known = opts.devices ?? (opts.identity.deviceId ? [laptop(opts.identity.deviceId, opts.identity.email)] : []);
  const devices = { findById: async (id: string) => known.find((d) => d.id === id) ?? null };
  const store = Object.assign(Object.create(memory), { devices }) as MemoryStore;
  const ctx = { config: { role: opts.role, litellmBaseUrl: "https://router.test/v1" }, store, secretAdmin: secrets } as unknown as RouteContext;
  await registerKeyRoutes(app, ctx);
  await app.ready();
  return { app, store: memory, secrets };
}

function laptop(id: string, ownerEmail: string): Device {
  return {
    id,
    userId: userIdFor(ownerEmail),
    ownerEmail,
    name: "mbp",
    kind: "laptop",
    createdAt: "2026-10-01T00:00:00.000Z",
    approvedBy: ownerEmail,
    accessHash: "h",
    accessExpiresAt: "2026-10-04T11:00:00.000Z",
  } as Device;
}

describe("subscription secret values", () => {
  test("claude is one line of printable ASCII; a file secret is UTF-8 without NUL", () => {
    assert.equal(isValidSubscriptionValue("claude", CLAUDE), true);
    assert.equal(isValidSubscriptionValue("claude", "x".repeat(20)), true);
    assert.equal(isValidSubscriptionValue("claude", "x".repeat(4096)), true);
    for (const bad of ["x".repeat(19), "x".repeat(4097), "has space " + "x".repeat(20), "x".repeat(20) + "\n", "é".repeat(20), 123]) {
      assert.equal(isValidSubscriptionValue("claude", bad), false, String(bad));
    }
    assert.equal(isValidSubscriptionValue("grok", GROK_JSON), true);
    assert.equal(isValidSubscriptionValue("codex", "x"), true);
    assert.equal(isValidSubscriptionValue("gemini", "a\0b"), false);
    assert.equal(isValidSubscriptionValue("grok", ""), false);
    assert.equal(isValidSubscriptionValue("grok", "x".repeat(262144)), true);
    assert.equal(isValidSubscriptionValue("grok", "x".repeat(262145)), false);
  });

  test("the secret is named by the hashed user id, never the email", () => {
    const name = subscriptionSecretName(userIdFor("A@Example.com"), "claude");
    assert.equal(name, `outfitter-user-${userIdFor("a@example.com")}-subscription-claude`);
    assert.ok(!name.includes("example"));
    assert.match(name, /^[A-Za-z0-9_-]+$/);
  });

  test("last4 is the sha256 tail, not the value's tail", () => {
    assert.equal(subscriptionLast4(CLAUDE), shaLast4(CLAUDE));
    assert.notEqual(subscriptionLast4(CLAUDE), CLAUDE.slice(-4));
    assert.equal(subscriptionLast4(GROK_JSON), shaLast4(GROK_JSON));
  });
});

describe("/api/me/subscription-secrets (a person on web)", () => {
  test("GET lists last4, setAt and version, never the value", async () => {
    const app = await buildTestApp();
    const put = await app.fastify.inject({ method: "PUT", url: "/api/me/subscription-secrets/claude", payload: { value: CLAUDE } });
    assert.equal(put.statusCode, 200, put.body);
    const view = put.json();
    assert.deepEqual(Object.keys(view).sort(), ["last4", "setAt", "vendor", "version"]);
    assert.equal(view.vendor, "claude");
    assert.equal(view.version, 1);
    assert.equal(view.last4, shaLast4(CLAUDE));
    assert.ok(!put.body.includes(CLAUDE));

    const secretName = subscriptionSecretName(userIdFor(DEV_EMAIL), "claude");
    assert.equal(await app.secretAdmin.accessLatest(secretName), CLAUDE);

    const list = await app.fastify.inject({ method: "GET", url: "/api/me/subscription-secrets" });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), [view]);
    assert.ok(!list.body.includes(CLAUDE));

    const [meta] = await app.store.subscriptionSecrets.listForUser(userIdFor(DEV_EMAIL));
    assert.equal(meta.secretName, secretName);
    assert.equal(meta.id, `${userIdFor(DEV_EMAIL)}:subscription:claude`);
    assert.equal(meta.version, 1);
    assert.equal(meta.setBy, DEV_EMAIL);
    assert.ok(!JSON.stringify(meta).includes(CLAUDE));
    await app.fastify.close();
  });

  test("claude whitespace is rejected", async () => {
    const app = await buildTestApp();
    for (const value of ["has space " + "x".repeat(20), "x".repeat(20) + "\n", "x".repeat(19), "short"]) {
      const res = await app.fastify.inject({ method: "PUT", url: "/api/me/subscription-secrets/claude", payload: { value } });
      assert.equal(res.statusCode, 400, JSON.stringify(value));
      assert.deepEqual(res.json(), { error: "invalid_value" });
      assert.ok(!res.body.includes(value));
    }
    assert.deepEqual(await app.store.subscriptionSecrets.listForUser(userIdFor(DEV_EMAIL)), []);
    assert.equal(await app.secretAdmin.accessLatest(subscriptionSecretName(userIdFor(DEV_EMAIL), "claude")), undefined);
    await app.fastify.close();
  });

  test("a JSON-looking grok body is accepted and not echoed", async () => {
    const app = await buildTestApp();
    const put = await app.fastify.inject({ method: "PUT", url: "/api/me/subscription-secrets/grok", payload: { value: GROK_JSON } });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().vendor, "grok");
    assert.equal(put.json().last4, shaLast4(GROK_JSON));
    assert.ok(!put.body.includes("grok-file-secret"));
    assert.equal(await app.secretAdmin.accessLatest(subscriptionSecretName(userIdFor(DEV_EMAIL), "grok")), GROK_JSON);
    const list = await app.fastify.inject({ method: "GET", url: "/api/me/subscription-secrets" });
    assert.equal(list.statusCode, 200);
    assert.ok(!list.body.includes("grok-file-secret"));
    assert.ok(!list.body.includes(GROK_JSON));
    const nul = await app.fastify.inject({ method: "PUT", url: "/api/me/subscription-secrets/codex", payload: { value: "a\0b" } });
    assert.equal(nul.statusCode, 400);
    assert.deepEqual(nul.json(), { error: "invalid_value" });
    await app.fastify.close();
  });

  test("version conflict does not write", async () => {
    const inner = new MemorySecretAdmin();
    let adds = 0;
    const counting: SecretAdmin = {
      info: (name) => inner.info(name),
      addVersion: async (name, value) => {
        adds += 1;
        return inner.addVersion(name, value);
      },
      disableAllEnabled: (name) => inner.disableAllEnabled(name),
      disableVersion: (name, version) => inner.disableVersion(name, version),
      accessLatest: (name) => inner.accessLatest(name),
      accessVersion: (name, version) => inner.accessVersion(name, version),
    };
    const app = await buildTestApp({}, { secretAdmin: counting });
    const name = subscriptionSecretName(userIdFor(DEV_EMAIL), "claude");
    const early = await app.fastify.inject({ method: "PUT", url: "/api/me/subscription-secrets/claude", payload: { value: CLAUDE, ifVersion: 1 } });
    assert.equal(early.statusCode, 409, early.body);
    assert.deepEqual(early.json(), { error: "version_conflict", version: null });
    assert.equal(await app.secretAdmin.accessLatest(name), undefined);
    assert.equal(adds, 0);

    const first = await app.fastify.inject({ method: "PUT", url: "/api/me/subscription-secrets/claude", payload: { value: CLAUDE } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().version, 1);

    const second = await app.fastify.inject({ method: "PUT", url: "/api/me/subscription-secrets/claude", payload: { value: CLAUDE_B, ifVersion: 1 } });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().version, 2);
    assert.equal(second.json().last4, shaLast4(CLAUDE_B));

    const conflict = await app.fastify.inject({ method: "PUT", url: "/api/me/subscription-secrets/claude", payload: { value: CLAUDE_C, ifVersion: 1 } });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.deepEqual(conflict.json(), { error: "version_conflict", version: 2 });
    assert.ok(!conflict.body.includes(CLAUDE_C));
    assert.equal(adds, 2);
    assert.equal(await app.secretAdmin.accessVersion(name, 3), undefined);
    assert.equal(await app.secretAdmin.accessLatest(name), CLAUDE_B);
    const [meta] = await app.store.subscriptionSecrets.listForUser(userIdFor(DEV_EMAIL));
    assert.equal(meta.version, 2);
    assert.equal(meta.last4, shaLast4(CLAUDE_B));
    await app.fastify.close();
  });

  test("DELETE removes the secret (204, idempotent)", async () => {
    const app = await buildTestApp();
    await app.fastify.inject({ method: "PUT", url: "/api/me/subscription-secrets/codex", payload: { value: '{"token":"codex-file"}' } });
    const del = await app.fastify.inject({ method: "DELETE", url: "/api/me/subscription-secrets/codex" });
    assert.equal(del.statusCode, 204);
    assert.equal(del.body, "");
    assert.equal(await app.secretAdmin.accessLatest(subscriptionSecretName(userIdFor(DEV_EMAIL), "codex")), undefined);
    assert.deepEqual((await app.fastify.inject({ method: "GET", url: "/api/me/subscription-secrets" })).json(), []);
    assert.equal((await app.fastify.inject({ method: "DELETE", url: "/api/me/subscription-secrets/codex" })).statusCode, 204);
    await app.fastify.close();
  });

  test("unknown vendor is 400", async () => {
    const app = await buildTestApp();
    const unknown = await app.fastify.inject({ method: "PUT", url: "/api/me/subscription-secrets/atlas", payload: { value: CLAUDE } });
    assert.equal(unknown.statusCode, 400);
    assert.deepEqual(unknown.json(), { error: "unknown_vendor" });
    assert.deepEqual((await app.fastify.inject({ method: "DELETE", url: "/api/me/subscription-secrets/__proto__" })).json(), { error: "unknown_vendor" });
    await app.fastify.close();
  });

  test("a failed Secret Manager write is a 502 whose log and answer never carry the value", async () => {
    const inner = new MemorySecretAdmin();
    const failing: SecretAdmin = Object.assign(Object.create(inner), {
      addVersion: async (_name: string, value: string) => {
        const err = Object.assign(new Error("Request failed with status code 503"), {
          config: { data: { payload: { data: Buffer.from(value, "utf8").toString("base64") } }, body: value },
          response: { status: 503, data: { error: { message: "unavailable" } } },
        });
        throw err;
      },
    });
    const logs: string[] = [];
    const { app } = await bareApp({ role: "web", identity: { email: DEV_EMAIL, operator: false }, secrets: failing, logs });
    const res = await app.inject({ method: "PUT", url: "/api/me/subscription-secrets/claude", payload: { value: CLAUDE } });
    assert.equal(res.statusCode, 502, res.body);
    assert.deepEqual(res.json(), { error: "secret_write_failed" });
    const all = logs.join("\n");
    assert.ok(all.includes("subscription secret write failed"), all);
    for (const secret of [CLAUDE, Buffer.from(CLAUDE, "utf8").toString("base64")]) {
      assert.ok(!all.includes(secret), "the value is not logged");
      assert.ok(!res.body.includes(secret));
    }
    await app.close();
  });
});

describe("POST /api/device/subscription-secrets (delivery)", () => {
  test("a device token gets its owner's secrets, no-store, and nobody else's", async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretAdmin();
    const deps = { subscriptionSecrets: store.subscriptionSecrets, secrets };
    await setSubscriptionSecret(deps, { userId: userIdFor("a@example.com"), vendor: "claude", value: CLAUDE, setBy: "a@example.com" });
    await setSubscriptionSecret(deps, { userId: userIdFor("a@example.com"), vendor: "grok", value: GROK_JSON, setBy: "a@example.com" });
    await setSubscriptionSecret(deps, { userId: userIdFor("b@example.com"), vendor: "codex", value: '{"token":"not-yours"}', setBy: "b@example.com" });

    const { app } = await bareApp({ role: "link", identity: { email: "a@example.com", operator: false, viaToken: true, deviceId: "dev_a" }, store, secrets });
    const res = await app.inject({ method: "POST", url: "/api/device/subscription-secrets" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.json(), {
      secrets: {
        claude: { value: CLAUDE, version: 1 },
        grok: { value: GROK_JSON, version: 1 },
      },
    });
    assert.ok(!res.body.includes("not-yours"));
    await app.close();
  });

  test("a person is refused, the route is not on web, and a Dongle cannot read or write", async () => {
    const all = await buildTestApp();
    const res = await all.fastify.inject({ method: "POST", url: "/api/device/subscription-secrets" });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "device_token_required" });
    await all.fastify.close();

    const web = await bareApp({ role: "web", identity: { email: "a@example.com", operator: false, viaToken: true, deviceId: "dev_x" } });
    assert.equal((await web.app.inject({ method: "POST", url: "/api/device/subscription-secrets" })).statusCode, 404);
    await web.app.close();

    const token = "outf_" + "d".repeat(43);
    const { app } = await laptopApp({ tokens: [["a@example.com", token]] });
    for (const [method, url] of [
      ["GET", "/api/me/subscription-secrets"],
      ["PUT", "/api/me/subscription-secrets/claude"],
      ["DELETE", "/api/me/subscription-secrets/claude"],
    ] as const) {
      const refused = await app.fastify.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: method === "PUT" ? { value: CLAUDE } : undefined });
      assert.equal(refused.statusCode, 403, `${method} ${url}: ${refused.body}`);
      assert.deepEqual(refused.json(), { error: "device_login_required" });
    }
    const delivery = await app.fastify.inject({ method: "POST", url: "/api/device/subscription-secrets", headers: { authorization: `Bearer ${token}` } });
    assert.equal(delivery.statusCode, 403);
    assert.deepEqual(delivery.json(), { error: "device_token_required" });
    await app.fastify.close();
  });

  test("a secret that can't be read is left out; the log has no value", async () => {
    const store = new MemoryStore();
    const inner = new MemorySecretAdmin();
    const userId = userIdFor("a@example.com");
    const deps = { subscriptionSecrets: store.subscriptionSecrets, secrets: inner };
    await setSubscriptionSecret(deps, { userId, vendor: "claude", value: CLAUDE, setBy: "a" });
    await setSubscriptionSecret(deps, { userId, vendor: "grok", value: GROK_JSON, setBy: "a" });
    const flaky: SecretAdmin = Object.assign(Object.create(inner), {
      accessVersion: async (name: string, version: number) => {
        if (name.endsWith("-subscription-grok")) throw new Error("PERMISSION_DENIED");
        return inner.accessVersion(name, version);
      },
    });
    const logged: string[] = [];
    const secrets = await deliverSubscriptionSecrets(
      { subscriptionSecrets: store.subscriptionSecrets, secrets: flaky, log: (msg) => logged.push(msg) },
      userId,
    );
    assert.deepEqual(secrets, { claude: { value: CLAUDE, version: 1 } });
    assert.equal(logged.length, 1);
    assert.ok(!logged[0]!.includes(GROK_JSON));
    assert.ok(!logged[0]!.includes(CLAUDE));
  });

  test("delivery returns the metadata version even when a newer one is enabled", async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretAdmin();
    const userId = userIdFor("a@example.com");
    const deps = { subscriptionSecrets: store.subscriptionSecrets, secrets };
    await setSubscriptionSecret(deps, { userId, vendor: "claude", value: CLAUDE, setBy: "a" });
    const name = subscriptionSecretName(userId, "claude");
    assert.equal(await secrets.addVersion(name, CLAUDE_B), 2);
    const delivered = await deliverSubscriptionSecrets(deps, userId);
    assert.deepEqual(delivered, { claude: { value: CLAUDE, version: 1 } });
    assert.equal(await secrets.accessLatest(name), CLAUDE_B);
  });
});

describe("subscription secret compare-and-swap", () => {
  test("two overlapping puts with the same ifVersion keep only the winner", async () => {
    const store = new MemoryStore();
    const inner = new MemorySecretAdmin();
    const userId = userIdFor(DEV_EMAIL);
    await setSubscriptionSecret(
      { subscriptionSecrets: store.subscriptionSecrets, secrets: inner },
      { userId, vendor: "claude", value: CLAUDE, setBy: DEV_EMAIL },
    );
    let entered = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const secrets: SecretAdmin = Object.assign(Object.create(inner), {
      addVersion: async (name: string, value: string) => {
        entered += 1;
        if (entered === 2) openGate();
        await gate;
        return inner.addVersion(name, value);
      },
    });
    const deps = { subscriptionSecrets: store.subscriptionSecrets, secrets };
    const first = setSubscriptionSecret(deps, { userId, vendor: "claude", value: CLAUDE_B, setBy: "a", ifVersion: 1 });
    const second = setSubscriptionSecret(deps, { userId, vendor: "claude", value: CLAUDE_C, setBy: "b", ifVersion: 1 });
    await gate;
    const [winner, loser] = await Promise.all([first, second]);
    assert.equal(winner.ok, true);
    assert.equal(loser.ok, false);
    if (!winner.ok || loser.ok) return;
    assert.equal(winner.view.version, 2);
    assert.equal(winner.view.last4, shaLast4(CLAUDE_B));
    assert.deepEqual(loser, { ok: false, error: "version_conflict", version: 2 });
    const name = subscriptionSecretName(userId, "claude");
    assert.equal(await secrets.accessVersion(name, 1), CLAUDE);
    assert.equal(await secrets.accessVersion(name, 2), CLAUDE_B);
    assert.equal(await secrets.accessVersion(name, 3), undefined);
    const delivered = await deliverSubscriptionSecrets(deps, userId);
    assert.deepEqual(delivered, { claude: { value: CLAUDE_B, version: 2 } });
    assert.ok(!JSON.stringify(loser).includes(CLAUDE_C));
  });

  test("a metadata failure disables only the version just added", async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretAdmin();
    const userId = userIdFor(DEV_EMAIL);
    let fail = false;
    const real = store.subscriptionSecrets;
    const subscriptionSecrets = Object.assign(Object.create(real), {
      compareAndSwap: async (meta: SubscriptionSecretMeta, expected: number | null) => {
        if (fail) {
          fail = false;
          throw Object.assign(new Error("mongo unavailable"), {
            config: { data: { payload: { data: Buffer.from(CLAUDE_B, "utf8").toString("base64") } }, body: CLAUDE_B },
          });
        }
        return real.compareAndSwap(meta, expected);
      },
    });
    Object.assign(store, { subscriptionSecrets });
    const logs: string[] = [];
    const { app } = await bareApp({ role: "web", identity: { email: DEV_EMAIL, operator: false }, store, secrets, logs });
    const seeded = await app.inject({ method: "PUT", url: "/api/me/subscription-secrets/claude", payload: { value: CLAUDE } });
    assert.equal(seeded.statusCode, 200, seeded.body);
    const [before] = await store.subscriptionSecrets.listForUser(userId);
    fail = true;
    const failed = await app.inject({ method: "PUT", url: "/api/me/subscription-secrets/claude", payload: { value: CLAUDE_B, ifVersion: 1 } });
    assert.equal(failed.statusCode, 502, failed.body);
    assert.deepEqual(failed.json(), { error: "secret_write_failed" });
    const name = subscriptionSecretName(userId, "claude");
    assert.equal(await secrets.accessVersion(name, 2), undefined);
    assert.equal(await secrets.accessLatest(name), CLAUDE);
    const [after] = await store.subscriptionSecrets.listForUser(userId);
    assert.deepEqual(after, before);
    const delivered = await deliverSubscriptionSecrets({ subscriptionSecrets: store.subscriptionSecrets, secrets }, userId);
    assert.deepEqual(delivered, { claude: { value: CLAUDE, version: 1 } });
    const logged = logs.join("\n");
    assert.ok(logged.includes("subscription secret write failed"), logged);
    for (const secret of [CLAUDE_B, Buffer.from(CLAUDE_B, "utf8").toString("base64")]) {
      assert.ok(!logged.includes(secret), "the value is not logged");
      assert.ok(!failed.body.includes(secret));
    }

    const retry = await app.inject({ method: "PUT", url: "/api/me/subscription-secrets/claude", payload: { value: CLAUDE_B, ifVersion: 1 } });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().version, 3);
    assert.equal(retry.json().last4, shaLast4(CLAUDE_B));
    assert.equal(await secrets.accessVersion(name, 3), CLAUDE_B);
    const again = await deliverSubscriptionSecrets({ subscriptionSecrets: store.subscriptionSecrets, secrets }, userId);
    assert.deepEqual(again, { claude: { value: CLAUDE_B, version: 3 } });
    await app.close();
  });

  test("two unconditional writes keep the higher version and disable the lower one", async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretAdmin();
    const userId = userIdFor(DEV_EMAIL);
    let releaseLow!: () => void;
    const lowWaiting = new Promise<void>((resolve) => {
      releaseLow = resolve;
    });
    let lowEntered!: () => void;
    const lowIsWaiting = new Promise<void>((resolve) => {
      lowEntered = resolve;
    });
    const real = store.subscriptionSecrets;
    const subscriptionSecrets = Object.assign(Object.create(real), {
      compareAndSwap: async (meta: SubscriptionSecretMeta, expected: number | null) => {
        if (meta.version === 1) {
          lowEntered();
          await lowWaiting;
        }
        return real.compareAndSwap(meta, expected);
      },
    });
    const deps = { subscriptionSecrets, secrets };
    const low = setSubscriptionSecret(deps, { userId, vendor: "claude", value: CLAUDE_B, setBy: "low" });
    const high = setSubscriptionSecret(deps, { userId, vendor: "claude", value: CLAUDE_C, setBy: "high" });
    await lowIsWaiting;
    const highResult = await high;
    releaseLow();
    const lowResult = await low;
    assert.equal(highResult.ok, true);
    assert.equal(lowResult.ok, false);
    if (!highResult.ok || lowResult.ok) return;
    assert.equal(highResult.view.version, 2);
    assert.equal(highResult.view.last4, shaLast4(CLAUDE_C));
    assert.deepEqual(lowResult, { ok: false, error: "version_conflict", version: 2 });
    const name = subscriptionSecretName(userId, "claude");
    assert.equal(await secrets.accessVersion(name, 2), CLAUDE_C);
    assert.equal(await secrets.accessVersion(name, 1), undefined);
    const delivered = await deliverSubscriptionSecrets(deps, userId);
    assert.deepEqual(delivered, { claude: { value: CLAUDE_C, version: 2 } });
    const [meta] = await real.listForUser(userId);
    assert.equal(meta.version, 2);
    assert.equal(meta.last4, shaLast4(CLAUDE_C));
  });

  test("compareAndSwap does not insert twice or move the version backward", async () => {
    const col = new MemoryStore().subscriptionSecrets;
    const meta = (version: number) => ({
      id: "u:subscription:claude",
      userId: "u",
      vendor: "claude",
      secretName: "s",
      version,
      last4: "abcd",
      setAt: "t",
      setBy: "a",
    });
    assert.equal(await col.compareAndSwap(meta(1), null), true);
    assert.equal(await col.compareAndSwap(meta(1), null), false);
    assert.equal(await col.compareAndSwap(meta(2), 1), true);
    assert.equal(await col.compareAndSwap(meta(2), 2), false);
    assert.equal(await col.compareAndSwap(meta(1), 2), false);
    assert.equal((await col.get("u:subscription:claude"))?.version, 2);
  });
});
