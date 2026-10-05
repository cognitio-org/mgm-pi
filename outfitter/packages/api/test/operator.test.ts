// Operator role and settings (EPIC.md Decisions table / operators.md): GET /api/me's operator
// flag, requireOperator's 403 on every /api/operator/* route for a non-operator, GET /api/operator/
// settings' secret list (masking, appliesAt), PUT/DELETE/test wiring against MemorySecretAdmin
// (see helpers.ts's buildTestApp -- OUTFITTER_DEV=1 by default, so the dev identity is always an
// operator; non-operator behaviour is exercised the same way tokens.test.ts fakes a caller
// identity -- an outf_ token whose owner isn't on OUTFITTER_OPERATORS, with dev mode off).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedDongle, seedGuru } from "./helpers.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { MemorySecretAdmin } from "../src/secrets.ts";
import type { Session, Store } from "../src/store/types.ts";
import { TEST_IAP_AUDIENCE, iapHeaders, useFakeIap } from "./device-iap.ts";

const OPERATOR_ENV = { OUTFITTER_DEV: "0", OUTFITTER_OPERATORS: "operator@mgms.eu" };

/** Mints an outf_ token for `ownerEmail` via a throwaway dev-mode app sharing the same store, then
 * returns the bearer header -- same trick tokens.test.ts uses to get a token for an arbitrary
 * owner without a real IAP assertion. */
async function seedSession(store: Store, overrides: Partial<Session> = {}): Promise<Session> {
  const now = new Date().toISOString();
  const session: Session = {
    id: "s1",
    guruId: "test-guru",
    repo: "o/r",
    status: "open",
    cost: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await store.sessions.insert(session);
  return session;
}

/** An existing Dongle for `ownerEmail` (#399: no longer created through the API, still accepted). */
async function bearerFor(store: MemoryStore, ownerEmail: string): Promise<{ authorization: string }> {
  const { token } = await seedDongle(store, ownerEmail, "t");
  return { authorization: `Bearer ${token}` };
}

describe("GET /api/me: operator flag", () => {
  test("dev identity is always an operator", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "GET", url: "/api/me" });
    assert.equal(res.json().operator, true);
    await app.fastify.close();
  });

  test("a non-operator's own identity reports operator: false", async () => {
    const store = new MemoryStore();
    const auth = await bearerFor(store, "someone@mgms.eu");
    const app = await buildTestApp(OPERATOR_ENV, { store });
    const res = await app.fastify.inject({ method: "GET", url: "/api/me", headers: auth });
    assert.equal(res.json().operator, false);
    await app.fastify.close();
  });

  test("an operator signed in through IAP reports operator: true; the same operator's Dongle does not (#390)", async (t) => {
    useFakeIap(t);
    const store = new MemoryStore();
    const auth = await bearerFor(store, "operator@mgms.eu");
    const app = await buildTestApp({ ...OPERATOR_ENV, IAP_AUDIENCE: TEST_IAP_AUDIENCE }, { store });
    const viaIap = await app.fastify.inject({ method: "GET", url: "/api/me", headers: iapHeaders("operator@mgms.eu") });
    assert.equal(viaIap.json().operator, true);
    const viaDongle = await app.fastify.inject({ method: "GET", url: "/api/me", headers: auth });
    assert.equal(viaDongle.json().operator, false);
    await app.fastify.close();
  });
});

describe("requireOperator: 403 for a non-operator on every /api/operator/* route", () => {
  const routes: Array<{ method: "GET" | "PUT" | "DELETE" | "POST"; url: string; payload?: Record<string, unknown> }> = [
    { method: "GET", url: "/api/operator/settings" },
    { method: "PUT", url: "/api/operator/secrets/outfitter-github-pat", payload: { value: "x".repeat(20) } },
    { method: "DELETE", url: "/api/operator/secrets/outfitter-github-pat" },
    { method: "POST", url: "/api/operator/secrets/outfitter-github-pat/test", payload: {} },
    { method: "POST", url: "/api/operator/tokens/revoke", payload: { domain: "@mgms.eu" } },
    { method: "GET", url: "/api/operator/voice/spend" },
  ];

  for (const route of routes) {
    test(`${route.method} ${route.url} -> 403 with a clear message`, async () => {
      const store = new MemoryStore();
      const auth = await bearerFor(store, "someone@mgms.eu");
      const app = await buildTestApp(OPERATOR_ENV, { store });
      const res = await app.fastify.inject({
        method: route.method,
        url: route.url,
        headers: auth,
        payload: route.payload,
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error, "operator role required");
      await app.fastify.close();
    });
  }

  test("link-role token identities are never operators, even when the owner is on OUTFITTER_OPERATORS -- but the link role doesn't register these routes anyway", async () => {
    const store = new MemoryStore();
    const auth = await bearerFor(store, "operator@mgms.eu");
    const link = await buildTestApp({ ...OPERATOR_ENV, OUTFITTER_ROLE: "link" }, { store });
    assert.equal(link.fastify.hasRoute({ method: "GET", url: "/api/operator/settings" }), false);
    await link.fastify.close();
  });
});

describe("GET /api/operator/settings", () => {
  test("lists deployment values, the operator list, and one row per managed secret", async () => {
    const app = await buildTestApp({ OUTFITTER_OPERATORS: "mgm@mgms.eu;matej@mgms.eu" });
    await seedGuru(app.store, { id: "g1", name: "Guru One" });
    const res = await app.fastify.inject({ method: "GET", url: "/api/operator/settings" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(typeof body.litellmBaseUrl, "string");
    assert.equal(typeof body.sandboxProvider, "string");
    assert.equal(typeof body.cloudRunJob, "string");
    assert.deepEqual(body.operators, ["mgm@mgms.eu", "matej@mgms.eu"]);
    const names = body.secrets.map((s: { secretName: string }) => s.secretName);
    assert.ok(names.includes("outfitter-litellm-key-default"));
    assert.ok(names.includes("outfitter-github-token-default"));
    assert.ok(names.includes("outfitter-github-pat"));
    assert.ok(names.includes("outfitter-github-app-id"));
    assert.ok(names.includes("outfitter-github-app-installation-id"));
    assert.ok(names.includes("outfitter-github-app-slug"));
    assert.equal(names.includes("outfitter-github-app-private-key"), false);
    assert.ok(names.includes("outfitter-litellm-admin"));
    assert.ok(names.includes("outfitter-ngrok-api-key"));
    assert.ok(names.includes("outfitter-local-tunnel-token"));
    assert.ok(names.includes("outfitter-litellm-key-g1"));
    for (const row of body.secrets) {
      assert.equal(row.set, false);
      assert.equal(row.masked, undefined);
      assert.ok(row.appliesAt === "next run" || row.appliesAt === "next deploy");
    }
    await app.fastify.close();
  });

  test("returns the gke fields only once GKE_CLUSTER is set (plan §5 item 8)", async () => {
    const unset = await buildTestApp();
    const unsetBody = (await unset.fastify.inject({ method: "GET", url: "/api/operator/settings" })).json();
    assert.equal(unsetBody.gkeCluster, undefined);
    await unset.fastify.close();

    const app = await buildTestApp({ GKE_CLUSTER: "outfitter", GKE_NAMESPACE: "outfitter-sandboxes" });
    const body = (await app.fastify.inject({ method: "GET", url: "/api/operator/settings" })).json();
    assert.equal(body.gkeCluster, "outfitter");
    assert.equal(body.gkeNamespace, "outfitter-sandboxes");
    assert.equal(typeof body.gkeLaunchMode, "string");
    assert.equal(typeof body.gkeMaxActive, "number");
    await app.fastify.close();
  });

  test("appliesAt matches the mount mechanism: run-time secrets are 'next run', mounted ones are 'next deploy'", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "GET", url: "/api/operator/settings" });
    const bySecret = Object.fromEntries(res.json().secrets.map((s: { secretName: string; appliesAt: string }) => [s.secretName, s.appliesAt]));
    assert.equal(bySecret["outfitter-litellm-key-default"], "next run");
    assert.equal(bySecret["outfitter-github-token-default"], "next run");
    assert.equal(bySecret["outfitter-github-pat"], "next deploy");
    assert.equal(bySecret["outfitter-litellm-admin"], "next deploy");
    assert.equal(bySecret["outfitter-ngrok-api-key"], "next deploy");
    assert.equal(bySecret["outfitter-local-tunnel-token"], "next deploy");
    await app.fastify.close();
  });

  test("masks a set secret's value, showing only the last 4 characters, only past 12 characters", async () => {
    const secretAdmin = new MemorySecretAdmin();
    await secretAdmin.addVersion("outfitter-github-pat", "short-key"); // 9 chars -- not masked, but marked set
    await secretAdmin.addVersion("outfitter-litellm-admin", "a-very-long-litellm-admin-key-1234");
    await secretAdmin.addVersion("outfitter-github-token-default", "ghp_a-shared-token-value-9876");
    const app = await buildTestApp({}, { secretAdmin });
    const res = await app.fastify.inject({ method: "GET", url: "/api/operator/settings" });
    const bySecret = Object.fromEntries(
      res.json().secrets.map((s: { secretName: string; set: boolean; masked?: string }) => [s.secretName, s]),
    );
    assert.equal(bySecret["outfitter-github-pat"].set, true);
    assert.equal(bySecret["outfitter-github-pat"].masked, undefined); // too short to mask
    assert.equal(bySecret["outfitter-litellm-admin"].set, true);
    assert.equal(bySecret["outfitter-litellm-admin"].masked, "…1234");
    assert.equal(bySecret["outfitter-github-token-default"].set, true);
    assert.equal(bySecret["outfitter-github-token-default"].masked, "…9876");
    await app.fastify.close();
  });
});

describe("PUT /api/operator/secrets/:secretName", () => {
  test("rejects a per-session GitHub token name -- only the shared default is operator-managed", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/api/operator/secrets/outfitter-github-token-s1",
      payload: { value: "a-value-thats-long-enough" },
    });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });

  test("rejects a secret name that isn't managed", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/api/operator/secrets/some-random-secret",
      payload: { value: "a-value-thats-long-enough" },
    });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });

  test("rejects a per-guru secret name for a guru that doesn't exist", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/api/operator/secrets/outfitter-litellm-key-nope",
      payload: { value: "a-value-thats-long-enough" },
    });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });

  test("accepts a per-guru secret name for a guru that does exist", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { id: "g1" });
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/api/operator/secrets/outfitter-litellm-key-g1",
      payload: { value: "a-value-thats-long-enough" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().set, true);
    await app.fastify.close();
  });

  test("rejects an empty value", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/api/operator/secrets/outfitter-github-pat",
      payload: { value: "   " },
    });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });

  test("rejects a value containing whitespace", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/api/operator/secrets/outfitter-github-pat",
      payload: { value: "has a space in it" },
    });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });

  test("trims the value before storing, and the row reflects the new state", async () => {
    const secretAdmin = new MemorySecretAdmin();
    const app = await buildTestApp({}, { secretAdmin });
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/api/operator/secrets/outfitter-github-pat",
      payload: { value: "  a-github-pat-value-1234  " },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().set, true);
    assert.equal(await secretAdmin.accessLatest("outfitter-github-pat"), "a-github-pat-value-1234");
    await app.fastify.close();
  });
});

describe("DELETE /api/operator/secrets/:secretName", () => {
  test("rejects a secret name that isn't managed", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "DELETE", url: "/api/operator/secrets/some-random-secret" });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });

  test("refuses to disable the default LiteLLM key when no guru has its own key", async () => {
    const secretAdmin = new MemorySecretAdmin();
    await secretAdmin.addVersion("outfitter-litellm-key-default", "a-default-key-1234");
    const app = await buildTestApp({}, { secretAdmin });
    await seedGuru(app.store, { id: "g1" }); // exists, but has no own key set
    const res = await app.fastify.inject({ method: "DELETE", url: "/api/operator/secrets/outfitter-litellm-key-default" });
    assert.equal(res.statusCode, 409);
    assert.ok(res.json().error.length > 0);
    // still enabled -- the refusal must not have disabled it anyway
    assert.equal((await secretAdmin.info("outfitter-litellm-key-default")).set, true);
    await app.fastify.close();
  });

  test("allows disabling the default key once at least one guru has its own", async () => {
    const secretAdmin = new MemorySecretAdmin();
    await secretAdmin.addVersion("outfitter-litellm-key-default", "a-default-key-1234");
    await secretAdmin.addVersion("outfitter-litellm-key-g1", "a-guru-owned-key-1234");
    const app = await buildTestApp({}, { secretAdmin });
    await seedGuru(app.store, { id: "g1" });
    const res = await app.fastify.inject({ method: "DELETE", url: "/api/operator/secrets/outfitter-litellm-key-default" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().set, false);
    await app.fastify.close();
  });

  test("allows disabling the shared GitHub token when no repo session would lose it", async () => {
    const secretAdmin = new MemorySecretAdmin();
    await secretAdmin.addVersion("outfitter-github-token-default", "ghp_a-shared-token-value-9876");
    const app = await buildTestApp({}, { secretAdmin });
    await seedSession(app.store, { id: "plain", repo: null });
    const res = await app.fastify.inject({
      method: "DELETE",
      url: "/api/operator/secrets/outfitter-github-token-default",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().set, false);
    await app.fastify.close();
  });

  test("refuses to disable the shared GitHub token while a repo session has none of its own", async () => {
    const secretAdmin = new MemorySecretAdmin();
    await secretAdmin.addVersion("outfitter-github-token-default", "ghp_a-shared-token-value-9876");
    await secretAdmin.addVersion("outfitter-github-token-covered", "ghp_a-session-token-value-1111");
    const app = await buildTestApp({}, { secretAdmin });
    await seedSession(app.store, { id: "covered", repo: "o/r" });
    await seedSession(app.store, { id: "bare", repo: "o/other" });
    const res = await app.fastify.inject({
      method: "DELETE",
      url: "/api/operator/secrets/outfitter-github-token-default",
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /repo session/);
    assert.equal((await secretAdmin.info("outfitter-github-token-default")).set, true);
    await app.fastify.close();
  });

  test("allows disabling the shared GitHub token once every repo session has its own", async () => {
    const secretAdmin = new MemorySecretAdmin();
    await secretAdmin.addVersion("outfitter-github-token-default", "ghp_a-shared-token-value-9876");
    await secretAdmin.addVersion("outfitter-github-token-s1", "ghp_a-session-token-value-1111");
    const app = await buildTestApp({}, { secretAdmin });
    await seedSession(app.store, { id: "s1", repo: "o/r" });
    const res = await app.fastify.inject({
      method: "DELETE",
      url: "/api/operator/secrets/outfitter-github-token-default",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().set, false);
    await app.fastify.close();
  });

  test("disables (not destroys) a non-default managed secret", async () => {
    const secretAdmin = new MemorySecretAdmin();
    await secretAdmin.addVersion("outfitter-github-pat", "a-github-pat-value-1234");
    const app = await buildTestApp({}, { secretAdmin });
    const res = await app.fastify.inject({ method: "DELETE", url: "/api/operator/secrets/outfitter-github-pat" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().set, false);
    assert.equal(await secretAdmin.accessLatest("outfitter-github-pat"), undefined);
    await app.fastify.close();
  });
});

describe("POST /api/operator/secrets/:secretName/test", () => {
  test("accepts the shared GitHub token, which probes as a GitHub credential", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/operator/secrets/outfitter-github-token-default/test",
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, false);
    assert.equal(res.json().detail, "no value set");
    await app.fastify.close();
  });

  test("reports no value set when nothing is stored and none is given", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "POST", url: "/api/operator/secrets/outfitter-github-pat/test", payload: {} });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, false);
    assert.equal(res.json().detail, "no value set");
    await app.fastify.close();
  });

  test("400s for an unmanaged secret name", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "POST", url: "/api/operator/secrets/some-random-secret/test", payload: {} });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });

  test("the App private key is not operator-managed, and the App id is not probed as a PAT", async () => {
    const secretAdmin = new MemorySecretAdmin();
    await secretAdmin.addVersion("outfitter-github-app-id", "42");
    await secretAdmin.addVersion("outfitter-github-app-private-key", "-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----");
    const app = await buildTestApp({}, { secretAdmin });
    const put = await app.fastify.inject({
      method: "PUT",
      url: "/api/operator/secrets/outfitter-github-app-private-key",
      payload: { value: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" },
    });
    assert.equal(put.statusCode, 400);
    const missing = await app.fastify.inject({
      method: "POST",
      url: "/api/operator/secrets/outfitter-github-app-private-key/test",
      payload: {},
    });
    assert.equal(missing.statusCode, 400);
    const probed = await app.fastify.inject({
      method: "POST",
      url: "/api/operator/secrets/outfitter-github-app-id/test",
      payload: {},
    });
    assert.equal(probed.statusCode, 200);
    assert.deepEqual(probed.json(), { ok: false, detail: "This secret is not probed." });
    assert.equal(probed.body.includes("42"), false);
    assert.equal(probed.body.includes("secret-key-material"), false);
    await app.fastify.close();
  });
});
