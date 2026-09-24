// POST /api/hooks/ngrok: signature accept/reject and the laptopOnline flip it drives. See
// src/routes/hooks.ts. verifyNgrokSignature itself is exercised indirectly through the route so
// these tests also cover the route wiring (raw-body parsing, header lookup, status codes).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildTestApp } from "./helpers.ts";
import { GkeProvider, KubeError, type KubeClientLike } from "../src/providers/gke.ts";

const SECRET = "test-ngrok-secret";
/** Matches buildTestApp's OUTFITTER_DEV_TOKEN default -- verifyTasksToken's dev-mode bearer check
 * (src/auth.ts), same credential mail.test.ts uses for /api/hooks/tick and /api/hooks/tasks/wake. */
const TASKS_AUTH = { authorization: "Bearer test-agent-token" };

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
}

describe("POST /api/hooks/ngrok", () => {
  test("a correctly signed agent_session_stop.v0 is accepted and flips the probe offline", async () => {
    const app = await buildTestApp({ NGROK_WEBHOOK_SECRET: SECRET });
    app.laptopProbe.setOnline(true);

    const body = JSON.stringify({ event_type_id: "agent_session_stop.v0" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/ngrok",
      headers: { "content-type": "application/json", "ngrok-signature": sign(body) },
      payload: body,
    });

    assert.equal(res.statusCode, 204);
    assert.equal(await app.laptopProbe.isOnline(), false);
    await app.fastify.close();
  });

  test("a correctly signed agent_session_start.v0 is accepted and flips the probe online", async () => {
    const app = await buildTestApp({ NGROK_WEBHOOK_SECRET: SECRET });
    app.laptopProbe.setOnline(false);

    const body = JSON.stringify({ event_type_id: "agent_session_start.v0" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/ngrok",
      headers: { "content-type": "application/json", "ngrok-signature": sign(body) },
      payload: body,
    });

    assert.equal(res.statusCode, 204);
    assert.equal(await app.laptopProbe.isOnline(), true);
    await app.fastify.close();
  });

  test("a wrong signature is rejected with 401 and the probe is untouched", async () => {
    const app = await buildTestApp({ NGROK_WEBHOOK_SECRET: SECRET });
    app.laptopProbe.setOnline(true);

    const body = JSON.stringify({ event_type_id: "agent_session_stop.v0" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/ngrok",
      headers: { "content-type": "application/json", "ngrok-signature": "0".repeat(64) },
      payload: body,
    });

    assert.equal(res.statusCode, 401);
    assert.equal(await app.laptopProbe.isOnline(), true);
    await app.fastify.close();
  });

  test("a missing signature header is rejected with 401", async () => {
    const app = await buildTestApp({ NGROK_WEBHOOK_SECRET: SECRET });
    const body = JSON.stringify({ event_type_id: "agent_session_stop.v0" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/ngrok",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    assert.equal(res.statusCode, 401);
    await app.fastify.close();
  });

  test("an unconfigured secret rejects every delivery (never silently trusts an unsigned endpoint)", async () => {
    const app = await buildTestApp(); // NGROK_WEBHOOK_SECRET left unset
    const body = JSON.stringify({ event_type_id: "agent_session_stop.v0" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/ngrok",
      headers: { "content-type": "application/json", "ngrok-signature": sign(body) },
      payload: body,
    });
    assert.equal(res.statusCode, 401);
    await app.fastify.close();
  });
});

// POST /api/hooks/warm-pool: gke-sandbox-provider.md §5.3 guardrail 1 -- the scheduled warm-up/
// warm-down Cloud Scheduler jobs resize the warm pool through this hook, authenticated exactly
// like /api/hooks/tick (verifyTasksToken). See routes/hooks.ts.

const WARM_POOL_PATH = "/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/outfitter-sandboxes/sandboxwarmpools/outfitter-agent";

function fakeKubeWithPool(initialReplicas: number | undefined): { kube: KubeClientLike; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  if (initialReplicas !== undefined) store.set(WARM_POOL_PATH, { spec: { replicas: initialReplicas }, status: {} });
  const kube: KubeClientLike = {
    async get<T>(path: string) {
      return store.has(path) ? (structuredClone(store.get(path)) as T) : null;
    },
    async create<T>(path: string, body: unknown) {
      store.set(path, body);
      return body as T;
    },
    async delete() {},
    async list<T>() {
      return [] as T[];
    },
    async patch(path: string, body: unknown) {
      const existing = store.get(path) as { spec: object } | undefined;
      if (!existing) throw new KubeError(404, `${path} not found`);
      const patchBody = body as { spec?: Record<string, unknown> };
      store.set(path, { ...existing, spec: { ...existing.spec, ...patchBody.spec } });
    },
  };
  return { kube, store };
}

function gkeProviderWithPool(initialReplicas: number | undefined): { provider: GkeProvider; store: Map<string, unknown> } {
  const { kube, store } = fakeKubeWithPool(initialReplicas);
  const provider = new GkeProvider(
    { project: "p", location: "us-central1", cluster: "outfitter", namespace: "outfitter-sandboxes", warmPool: "outfitter-agent", launchMode: "cold", maxActive: 3 },
    { kube: async () => kube },
  );
  return { provider, store };
}

describe("POST /api/hooks/warm-pool", () => {
  test("a correctly authenticated request patches the pool's spec.replicas", async () => {
    const { provider, store } = gkeProviderWithPool(0);
    const app = await buildTestApp({ SANDBOX_PROVIDER: "gke", GKE_CLUSTER: "outfitter" }, { extraProviders: { gke: async () => provider } });

    const res = await app.fastify.inject({ method: "POST", url: "/api/hooks/warm-pool", headers: TASKS_AUTH, payload: { replicas: 1 } });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { replicas: 1 });
    assert.equal((store.get(WARM_POOL_PATH) as { spec: { replicas: number } }).spec.replicas, 1);
    await app.fastify.close();
  });

  test("missing/invalid auth is rejected with 401 and the pool is untouched", async () => {
    const { provider, store } = gkeProviderWithPool(0);
    const app = await buildTestApp({ SANDBOX_PROVIDER: "gke", GKE_CLUSTER: "outfitter" }, { extraProviders: { gke: async () => provider } });

    const noAuth = await app.fastify.inject({ method: "POST", url: "/api/hooks/warm-pool", payload: { replicas: 1 } });
    assert.equal(noAuth.statusCode, 401);

    const badAuth = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/warm-pool",
      headers: { authorization: "Bearer wrong-token" },
      payload: { replicas: 1 },
    });
    assert.equal(badAuth.statusCode, 401);

    assert.equal((store.get(WARM_POOL_PATH) as { spec: { replicas: number } }).spec.replicas, 0);
    await app.fastify.close();
  });

  test("replicas is clamped to 0..2", async () => {
    const { provider, store } = gkeProviderWithPool(0);
    const app = await buildTestApp({ SANDBOX_PROVIDER: "gke", GKE_CLUSTER: "outfitter" }, { extraProviders: { gke: async () => provider } });

    const tooHigh = await app.fastify.inject({ method: "POST", url: "/api/hooks/warm-pool", headers: TASKS_AUTH, payload: { replicas: 50 } });
    assert.equal(tooHigh.statusCode, 200);
    assert.deepEqual(tooHigh.json(), { replicas: 2 });

    const negative = await app.fastify.inject({ method: "POST", url: "/api/hooks/warm-pool", headers: TASKS_AUTH, payload: { replicas: -5 } });
    assert.equal(negative.statusCode, 200);
    assert.deepEqual(negative.json(), { replicas: 0 });

    assert.equal((store.get(WARM_POOL_PATH) as { spec: { replicas: number } }).spec.replicas, 0);
    await app.fastify.close();
  });

  test("a non-numeric body is rejected with 400", async () => {
    const { provider } = gkeProviderWithPool(0);
    const app = await buildTestApp({ SANDBOX_PROVIDER: "gke", GKE_CLUSTER: "outfitter" }, { extraProviders: { gke: async () => provider } });

    const res = await app.fastify.inject({ method: "POST", url: "/api/hooks/warm-pool", headers: TASKS_AUTH, payload: { replicas: "one" } });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });

  test("gke not configured here: 404, never crashes the request", async () => {
    // No "gke" factory registered at all -- the default provider is the usual test NoopProvider.
    const app = await buildTestApp();

    const res = await app.fastify.inject({ method: "POST", url: "/api/hooks/warm-pool", headers: TASKS_AUTH, payload: { replicas: 1 } });
    assert.equal(res.statusCode, 404);
    await app.fastify.close();
  });

  test("the warm pool object itself is missing: 404 from the underlying patch", async () => {
    const { provider } = gkeProviderWithPool(undefined); // no SandboxWarmPool seeded at all
    const app = await buildTestApp({ SANDBOX_PROVIDER: "gke", GKE_CLUSTER: "outfitter" }, { extraProviders: { gke: async () => provider } });

    const res = await app.fastify.inject({ method: "POST", url: "/api/hooks/warm-pool", headers: TASKS_AUTH, payload: { replicas: 1 } });
    assert.equal(res.statusCode, 404);
    await app.fastify.close();
  });

  test("a patch conflict from the cluster surfaces as 409", async () => {
    const { kube } = fakeKubeWithPool(0);
    const conflictingKube: KubeClientLike = {
      ...kube,
      async patch() {
        throw new KubeError(409, "resourceVersion conflict");
      },
    };
    const provider = new GkeProvider(
      { project: "p", location: "us-central1", cluster: "outfitter", namespace: "outfitter-sandboxes", warmPool: "outfitter-agent", launchMode: "cold", maxActive: 3 },
      { kube: async () => conflictingKube },
    );
    const app = await buildTestApp({ SANDBOX_PROVIDER: "gke", GKE_CLUSTER: "outfitter" }, { extraProviders: { gke: async () => provider } });

    const res = await app.fastify.inject({ method: "POST", url: "/api/hooks/warm-pool", headers: TASKS_AUTH, payload: { replicas: 1 } });
    assert.equal(res.statusCode, 409);
    await app.fastify.close();
  });
});
