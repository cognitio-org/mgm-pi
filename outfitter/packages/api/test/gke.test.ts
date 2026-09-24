// GkeProvider (docs/specs/gke-sandbox-provider.md §4 and §6.1, gke-sandbox-provider-plan.md PR2).
// Mirrors cloudrun.test.ts's style: an in-memory fake KubeClientLike, no credentials, no network.
// The fake stores objects by their exact resource path (the same paths GkeProvider itself builds),
// so tests can assert on precisely what got POSTed/PATCHed without re-implementing a Kubernetes API.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  GkeProvider,
  GkeEndpointError,
  KubeError,
  HttpKubeClient,
  resolveGkeEndpoint,
  WARM_POOL_MAX_REPLICAS,
  WARM_POOL_MIN_REPLICAS,
  type KubeClientLike,
  type GkeProviderConfig,
} from "../src/providers/gke.ts";
import type { RunLaunch } from "@outfitter/provider-local";

const NS = "outfitter-sandboxes";
const POOL = "outfitter-agent";
const CLAIMS_PATH = `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NS}/sandboxclaims`;
const WARM_POOL_PATH = `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NS}/sandboxwarmpools/${POOL}`;
const SANDBOXES_PATH = `/apis/agents.x-k8s.io/v1beta1/namespaces/${NS}/sandboxes`;

interface FakeClaim {
  metadata: { name: string; namespace: string; labels?: Record<string, string>; deletionTimestamp?: string };
  spec: Record<string, unknown>;
  status?: { conditions?: Array<{ type?: string; status?: string; reason?: string }>; sandbox?: { name?: string } };
}

/** A minimal in-memory Kubernetes REST fake: objects keyed by their exact resource path. `create`
 * throws KubeError(409) on a path that already exists (matching the real API); `delete` is a no-op
 * on a missing path (matching KubeClientLike's own "404 is success" contract); `list` filters by
 * path prefix and, when given one, an exact `key=value` labelSelector. */
function makeFakeKube(): { kube: KubeClientLike; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const kube: KubeClientLike = {
    async get<T>(path: string): Promise<T | null> {
      return store.has(path) ? (structuredClone(store.get(path)) as T) : null;
    },
    async create<T>(path: string, body: unknown): Promise<T> {
      const b = body as { metadata: { name: string } };
      const itemPath = `${path}/${b.metadata.name}`;
      if (store.has(itemPath)) throw new KubeError(409, `${itemPath} already exists`);
      store.set(itemPath, structuredClone(body));
      return structuredClone(body) as T;
    },
    async delete(path: string): Promise<void> {
      store.delete(path); // deleting an absent key is a no-op: "404 is success"
    },
    async list<T>(path: string, labelSelector?: string): Promise<T[]> {
      const prefix = `${path}/`;
      const items: T[] = [];
      for (const [key, value] of store) {
        if (!key.startsWith(prefix)) continue;
        if (labelSelector) {
          const [k, v] = labelSelector.split("=");
          const labels = (value as FakeClaim).metadata?.labels ?? {};
          if (labels[k] !== v) continue;
        }
        items.push(structuredClone(value) as T);
      }
      return items;
    },
    async patch(path: string, body: unknown): Promise<void> {
      const existing = store.get(path);
      if (!existing) throw new KubeError(404, `${path} not found`);
      const patchBody = body as { spec?: Record<string, unknown> };
      const merged = { ...(existing as Record<string, unknown>), spec: { ...(existing as { spec: object }).spec, ...patchBody.spec } };
      store.set(path, merged);
    },
  };
  return { kube, store };
}

function baseConfig(overrides: Partial<GkeProviderConfig> = {}): GkeProviderConfig {
  return {
    project: "p",
    location: "us-central1",
    cluster: "outfitter",
    namespace: NS,
    warmPool: POOL,
    launchMode: "cold",
    maxActive: 3,
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunLaunch> = {}): RunLaunch {
  return {
    runId: "11111111-1111-1111-1111-111111111111",
    apiOrigin: "https://link.example",
    runToken: "super-secret-token",
    ...overrides,
  };
}

function seedWarmPool(store: Map<string, unknown>, replicas: number, readyReplicas: number): void {
  store.set(WARM_POOL_PATH, { spec: { replicas }, status: { readyReplicas } });
}

function seedClaim(
  store: Map<string, unknown>,
  name: string,
  patch: Partial<FakeClaim> = {},
): void {
  store.set(`${CLAIMS_PATH}/${name}`, {
    metadata: { name, namespace: NS, labels: { "app.kubernetes.io/managed-by": "outfitter" } },
    spec: {},
    ...patch,
  });
}

describe("GkeProvider.start", () => {
  test("cold: POSTs a claim with warmPoolRef, lifecycle and claim env, no additionalPodMetadata", async () => {
    const { kube, store } = makeFakeKube();
    seedWarmPool(store, 0, 0);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const provider = new GkeProvider(baseConfig({ launchMode: "cold" }), { kube: async () => kube, now: () => now });

    const run = makeRun();
    const { handle, warm } = await provider.start(run);

    assert.equal(handle, `gke:${NS}/run-${run.runId}`);
    assert.equal(warm, false);

    const claim = store.get(`${CLAIMS_PATH}/run-${run.runId}`) as FakeClaim & {
      spec: { warmPoolRef: { name: string }; env?: Array<{ name: string; value: string }>; additionalPodMetadata?: unknown; lifecycle: Record<string, unknown> };
    };
    assert.ok(claim, "claim must have been created");
    assert.deepEqual(claim.spec.warmPoolRef, { name: POOL });
    assert.equal(claim.spec.additionalPodMetadata, undefined);
    assert.deepEqual(claim.spec.lifecycle, {
      shutdownPolicy: "Delete",
      shutdownTime: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      ttlSecondsAfterFinished: 120,
    });
    const env = Object.fromEntries((claim.spec.env ?? []).map((e) => [e.name, e.value]));
    assert.equal(env.RUN_ID, run.runId);
    assert.equal(env.RUN_TOKEN, run.runToken);
    assert.equal(env.OUTFITTER_API, run.apiOrigin);
    assert.equal(claim.metadata.labels?.["outfitter.dev/run-id"], run.runId);
  });

  test("warm: the same claim shape with outfitter.dev/* annotations and no spec.env", async () => {
    const { kube, store } = makeFakeKube();
    seedWarmPool(store, 1, 1);
    const provider = new GkeProvider(baseConfig({ launchMode: "warm" }), { kube: async () => kube });

    const run = makeRun();
    await provider.start(run);

    const claim = store.get(`${CLAIMS_PATH}/run-${run.runId}`) as FakeClaim & {
      spec: { env?: unknown; additionalPodMetadata?: { annotations?: Record<string, string> } };
    };
    assert.equal(claim.spec.env, undefined);
    assert.deepEqual(claim.spec.additionalPodMetadata?.annotations, {
      "outfitter.dev/run-id": run.runId,
      "outfitter.dev/run-token": run.runToken,
      "outfitter.dev/api": run.apiOrigin,
    });
  });

  test("409 on the same claim name: returns the existing claim's handle instead of throwing", async () => {
    const { kube, store } = makeFakeKube();
    seedWarmPool(store, 0, 0);
    const run = makeRun();
    seedClaim(store, `run-${run.runId}`);
    const provider = new GkeProvider(baseConfig(), { kube: async () => kube });

    const { handle } = await provider.start(run);
    assert.equal(handle, `gke:${NS}/run-${run.runId}`);
  });

  // Review round 1, L5: a 409 whose existing claim is already terminating can't be adopted --
  // that's a real failure (the run would silently attach to a claim that's about to vanish), not
  // the idempotent-retry case above.
  test("409 whose existing claim has deletionTimestamp set: rethrows instead of adopting it", async () => {
    const { kube, store } = makeFakeKube();
    seedWarmPool(store, 0, 0);
    const run = makeRun();
    seedClaim(store, `run-${run.runId}`, { metadata: { name: `run-${run.runId}`, namespace: NS, deletionTimestamp: "2026-01-01T00:00:00Z" } });
    const provider = new GkeProvider(baseConfig(), { kube: async () => kube });

    await assert.rejects(() => provider.start(run), /terminating/);
  });

  // Review round 1, M3: the 409 path's follow-up GET can itself observe the claim gone (deleted
  // between the 409 and the GET) -- that must rethrow the original conflict, not silently succeed
  // with a handle for a claim that isn't there.
  test("409 whose follow-up GET returns null (claim vanished): rethrows", async () => {
    const { store } = makeFakeKube();
    seedWarmPool(store, 0, 0);
    const run = makeRun();
    const flakyKube: KubeClientLike = {
      async get() {
        return null; // the claim is gone by the time start() re-reads it
      },
      async create() {
        throw new KubeError(409, "gke: 409 Conflict");
      },
      async delete() {},
      async list() {
        return [];
      },
      async patch() {},
    };
    const provider = new GkeProvider(baseConfig(), { kube: async () => flakyKube });

    await assert.rejects(() => provider.start(run), (err: unknown) => err instanceof KubeError && err.status === 409);
  });

  test("at GKE_MAX_ACTIVE: throws and makes no POST", async () => {
    const { kube, store } = makeFakeKube();
    seedWarmPool(store, 0, 0);
    seedClaim(store, "run-a");
    seedClaim(store, "run-b");
    seedClaim(store, "run-c");
    const provider = new GkeProvider(baseConfig({ maxActive: 3 }), { kube: async () => kube });

    const run = makeRun();
    await assert.rejects(() => provider.start(run), /gke: max active sandboxes \(3\) reached/);
    assert.equal(store.has(`${CLAIMS_PATH}/run-${run.runId}`), false, "no claim should have been created");
  });

  // Review round 1, M2/M3: the previous version of this test only drove the max-active path, where
  // the token was never in scope at all -- a change that stopped redacting it entirely would still
  // have passed. This drives a real failure from create() (as a Kubernetes 4xx admission response
  // would echo the request body back, and the claim body carries RUN_TOKEN in cold mode) and
  // checks the token is actually redacted, not merely absent by construction.
  test("the run token is redacted from a create() error, even if the transport echoed it back", async () => {
    const { store } = makeFakeKube();
    seedWarmPool(store, 0, 0);
    const run = makeRun({ runToken: "unmistakable-secret-xyz" });
    const echoingKube: KubeClientLike = {
      async get() {
        return null;
      },
      async create() {
        // Simulates a Kubernetes 4xx admission response that echoes the rejected object's fields,
        // RUN_TOKEN included -- errorFor() itself never does this (M2), but start() must not rely
        // on that alone.
        throw new Error(`gke: 422 Invalid: spec.env[1].value: ${run.runToken} is not permitted`);
      },
      async delete() {},
      async list() {
        return [];
      },
      async patch() {},
    };
    const provider = new GkeProvider(baseConfig(), { kube: async () => echoingKube });

    try {
      await provider.start(run);
      assert.fail("expected start() to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes(run.runToken), `error message leaked the run token: ${message}`);
      assert.match(message, /«redacted»/, "the redaction marker should be present in place of the token");
    }
  });

  // Review round 1, M1: a failed kube() build must not be cached -- the first start() call rejects
  // (a transient clusters.get 5xx, say), and a second call must retry rather than replay the same
  // rejected promise forever.
  test("a failed kube() build is retried, not cached, on the next call", async () => {
    const { kube, store } = makeFakeKube();
    seedWarmPool(store, 0, 0);
    let attempts = 0;
    const provider = new GkeProvider(baseConfig(), {
      kube: async () => {
        attempts++;
        if (attempts === 1) throw new Error("gke: transient clusters.get failure");
        return kube;
      },
    });

    const run = makeRun();
    await assert.rejects(() => provider.start(run), /transient clusters\.get failure/);
    const { handle } = await provider.start(run);
    assert.equal(handle, `gke:${NS}/run-${run.runId}`);
    assert.equal(attempts, 2);
  });
});

describe("GkeProvider.stop", () => {
  test("DELETEs the claim at the right path", async () => {
    const { kube, store } = makeFakeKube();
    seedClaim(store, "run-x");
    const provider = new GkeProvider(baseConfig(), { kube: async () => kube });

    await provider.stop(`gke:${NS}/run-x`);

    assert.equal(store.has(`${CLAIMS_PATH}/run-x`), false);
  });

  test("a 404 (already gone) is swallowed, not thrown", async () => {
    const { kube } = makeFakeKube();
    const provider = new GkeProvider(baseConfig(), { kube: async () => kube });

    await assert.doesNotReject(() => provider.stop(`gke:${NS}/run-does-not-exist`));
  });

  test("an empty handle is a no-op", async () => {
    const { kube, store } = makeFakeKube();
    seedClaim(store, "run-x");
    const provider = new GkeProvider(baseConfig(), { kube: async () => kube });

    await provider.stop("");

    assert.equal(store.has(`${CLAIMS_PATH}/run-x`), true, "stop('') must not touch anything");
  });
});

describe("GkeProvider.status", () => {
  /** Same shape as makeFakeKube, but bound to a store the test seeds beforehand (status() tests
   * only ever read, so this omits create/patch's 409/404 bookkeeping the write-path tests need). */
  function providerWith(store: Map<string, unknown>): GkeProvider {
    return new GkeProvider(baseConfig(), { kube: async () => makeFakeKubeOn(store) });
  }

  function makeFakeKubeOn(store: Map<string, unknown>): KubeClientLike {
    return {
      async get<T>(path: string): Promise<T | null> {
        return store.has(path) ? (structuredClone(store.get(path)) as T) : null;
      },
      async create<T>(path: string, body: unknown): Promise<T> {
        const b = body as { metadata: { name: string } };
        store.set(`${path}/${b.metadata.name}`, structuredClone(body));
        return structuredClone(body) as T;
      },
      async delete(path: string): Promise<void> {
        store.delete(path);
      },
      async list<T>(path: string): Promise<T[]> {
        const prefix = `${path}/`;
        return [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => structuredClone(v) as T);
      },
      async patch(path: string, body: unknown): Promise<void> {
        const existing = store.get(path) as { spec: object } | undefined;
        if (!existing) throw new KubeError(404, "not found");
        const patchBody = body as { spec?: Record<string, unknown> };
        store.set(path, { ...existing, spec: { ...existing.spec, ...patchBody.spec } });
      },
    };
  }

  test("claim 404 -> exited", async () => {
    const provider = providerWith(new Map());
    assert.equal(await provider.status(`gke:${NS}/run-gone`), "exited");
  });

  test("claim with deletionTimestamp -> exited", async () => {
    const store = new Map<string, unknown>();
    store.set(`${CLAIMS_PATH}/run-x`, { metadata: { name: "run-x", namespace: NS, deletionTimestamp: "2026-01-01T00:00:00Z" } });
    const provider = providerWith(store);
    assert.equal(await provider.status(`gke:${NS}/run-x`), "exited");
  });

  test("Ready=True -> running", async () => {
    const store = new Map<string, unknown>();
    store.set(`${CLAIMS_PATH}/run-x`, {
      metadata: { name: "run-x", namespace: NS },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
    const provider = providerWith(store);
    assert.equal(await provider.status(`gke:${NS}/run-x`), "running");
  });

  test("Ready=False with an exited reason -> exited", async () => {
    for (const reason of ["PodSucceeded", "PodFailed", "ClaimExpired", "SandboxSuspended"]) {
      const store = new Map<string, unknown>();
      store.set(`${CLAIMS_PATH}/run-x`, {
        metadata: { name: "run-x", namespace: NS },
        status: { conditions: [{ type: "Ready", status: "False", reason }] },
      });
      const provider = providerWith(store);
      assert.equal(await provider.status(`gke:${NS}/run-x`), "exited", `reason ${reason}`);
    }
  });

  test("Ready=False with another reason, no status.sandbox.name -> starting", async () => {
    const store = new Map<string, unknown>();
    store.set(`${CLAIMS_PATH}/run-x`, {
      metadata: { name: "run-x", namespace: NS },
      status: { conditions: [{ type: "Ready", status: "False", reason: "DependenciesNotReady" }] },
    });
    const provider = providerWith(store);
    assert.equal(await provider.status(`gke:${NS}/run-x`), "starting");
  });

  test("no Ready condition at all, no status.sandbox.name -> starting", async () => {
    const store = new Map<string, unknown>();
    store.set(`${CLAIMS_PATH}/run-x`, { metadata: { name: "run-x", namespace: NS } });
    const provider = providerWith(store);
    assert.equal(await provider.status(`gke:${NS}/run-x`), "starting");
  });

  test("status.sandbox.name set, claim not Ready, Sandbox Finished=True -> exited (fallback GET)", async () => {
    const store = new Map<string, unknown>();
    store.set(`${CLAIMS_PATH}/run-x`, {
      metadata: { name: "run-x", namespace: NS },
      status: { conditions: [{ type: "Ready", status: "False", reason: "PodTerminating" }], sandbox: { name: "run-x" } },
    });
    store.set(`${SANDBOXES_PATH}/run-x`, { status: { conditions: [{ type: "Finished", status: "True" }] } });
    const provider = providerWith(store);
    assert.equal(await provider.status(`gke:${NS}/run-x`), "exited");
  });

  test("status.sandbox.name set, claim not Ready, Sandbox not Finished -> starting", async () => {
    const store = new Map<string, unknown>();
    store.set(`${CLAIMS_PATH}/run-x`, {
      metadata: { name: "run-x", namespace: NS },
      status: { conditions: [{ type: "Ready", status: "False", reason: "PodTerminating" }], sandbox: { name: "run-x" } },
    });
    store.set(`${SANDBOXES_PATH}/run-x`, { status: { conditions: [{ type: "Finished", status: "False" }] } });
    const provider = providerWith(store);
    assert.equal(await provider.status(`gke:${NS}/run-x`), "starting");
  });

  test("empty handle -> unknown, and doesn't throw", async () => {
    const provider = providerWith(new Map());
    assert.equal(await provider.status(""), "unknown");
  });

  test("a malformed handle -> unknown, and doesn't throw", async () => {
    const provider = providerWith(new Map());
    assert.equal(await provider.status("not-a-gke-handle"), "unknown");
  });

  // Review round 1, M3: a permission or server error is a real failure the reconciler needs to
  // see (runs.ts turns a thrown status() into "unknown" itself, spec §4.3's last row) -- status()
  // must never quietly report "exited" for one of these instead of propagating it.
  for (const status of [401, 403, 500, 503]) {
    test(`a ${status} from the claim GET throws, and does not report 'exited'`, async () => {
      const throwingKube: KubeClientLike = {
        async get() {
          throw new KubeError(status, `gke: ${status} error`);
        },
        async create() {
          throw new Error("not used");
        },
        async delete() {},
        async list() {
          return [];
        },
        async patch() {},
      };
      const provider = new GkeProvider(baseConfig(), { kube: async () => throwingKube });
      await assert.rejects(() => provider.status(`gke:${NS}/run-x`), (err: unknown) => err instanceof KubeError && err.status === status);
    });
  }

  // Review round 1, M4: a claim can sit Ready=False for a reason that never resolves on its own
  // (ImagePullBackOff, unschedulable, a persistent AdoptionConflict). Without a deadline this would
  // report "starting" forever; the reconciler skips "starting" outright, so the run would never
  // fail and would hold a GKE_MAX_ACTIVE slot indefinitely.
  test("Ready=False with an ambiguous reason, past the start deadline -> unknown, not starting forever", async () => {
    const store = new Map<string, unknown>();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    store.set(`${CLAIMS_PATH}/run-x`, {
      metadata: { name: "run-x", namespace: NS, creationTimestamp: createdAt.toISOString() },
      status: { conditions: [{ type: "Ready", status: "False", reason: "ImagePullBackOff" }] },
    });
    const provider = new GkeProvider(baseConfig(), {
      kube: async () => makeFakeKubeOn(store),
      now: () => new Date(createdAt.getTime() + 11 * 60_000), // 11 min later, past the 10 min deadline
    });
    assert.equal(await provider.status(`gke:${NS}/run-x`), "unknown");
  });

  test("Ready=False with an ambiguous reason, well within the start deadline -> still starting", async () => {
    const store = new Map<string, unknown>();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    store.set(`${CLAIMS_PATH}/run-x`, {
      metadata: { name: "run-x", namespace: NS, creationTimestamp: createdAt.toISOString() },
      status: { conditions: [{ type: "Ready", status: "False", reason: "ImagePullBackOff" }] },
    });
    const provider = new GkeProvider(baseConfig(), {
      kube: async () => makeFakeKubeOn(store),
      now: () => new Date(createdAt.getTime() + 2 * 60_000), // 2 min later, S4's worst case was 145s
    });
    assert.equal(await provider.status(`gke:${NS}/run-x`), "starting");
  });

  test("no creationTimestamp at all -> never forced to unknown, even under a far-future clock", async () => {
    const store = new Map<string, unknown>();
    store.set(`${CLAIMS_PATH}/run-x`, {
      metadata: { name: "run-x", namespace: NS },
      status: { conditions: [{ type: "Ready", status: "False", reason: "ImagePullBackOff" }] },
    });
    const provider = new GkeProvider(baseConfig(), {
      kube: async () => makeFakeKubeOn(store),
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    });
    assert.equal(await provider.status(`gke:${NS}/run-x`), "starting");
  });
});

describe("GkeProvider.capacity", () => {
  test("counts only non-exited managed claims; reads the pool's replicas and readyReplicas", async () => {
    const { kube, store } = makeFakeKube();
    seedWarmPool(store, 1, 1);
    seedClaim(store, "run-running", { status: { conditions: [{ type: "Ready", status: "True" }] } });
    seedClaim(store, "run-starting");
    seedClaim(store, "run-exited", { status: { conditions: [{ type: "Ready", status: "False", reason: "PodSucceeded" }] } });
    // Not managed by outfitter: must not be counted.
    store.set(`${CLAIMS_PATH}/someone-elses-claim`, { metadata: { name: "someone-elses-claim", namespace: NS, labels: {} } });

    const provider = new GkeProvider(baseConfig({ maxActive: 3 }), { kube: async () => kube });
    const capacity = await provider.capacity();

    assert.equal(capacity.active, 2); // run-running + run-starting, not run-exited or the unmanaged one
    assert.equal(capacity.warmReady, 1);
    assert.equal(capacity.warmDesired, 1);
    assert.equal(capacity.limit, 3);
  });

  test("no warm pool object yet: warmReady/warmDesired are undefined, active still counts", async () => {
    const { kube, store } = makeFakeKube();
    seedClaim(store, "run-a");
    const provider = new GkeProvider(baseConfig(), { kube: async () => kube });

    const capacity = await provider.capacity();
    assert.equal(capacity.active, 1);
    assert.equal(capacity.warmReady, undefined);
    assert.equal(capacity.warmDesired, undefined);
  });
});

describe("GkeProvider.setWarmPoolReplicas", () => {
  test("merge-patches spec.replicas on the warm pool", async () => {
    const { kube, store } = makeFakeKube();
    seedWarmPool(store, 0, 0);
    const provider = new GkeProvider(baseConfig(), { kube: async () => kube });

    await provider.setWarmPoolReplicas(1);

    const pool = store.get(WARM_POOL_PATH) as { spec: { replicas: number } };
    assert.equal(pool.spec.replicas, 1);
  });

  test("a missing warm pool throws KubeError(404)", async () => {
    const { kube } = makeFakeKube();
    const provider = new GkeProvider(baseConfig(), { kube: async () => kube });

    await assert.rejects(() => provider.setWarmPoolReplicas(1), (err: unknown) => err instanceof KubeError && err.status === 404);
  });
});

describe("warm-pool replica clamp constants", () => {
  test("min/max match the §5.3 guardrail (0..2)", () => {
    assert.equal(WARM_POOL_MIN_REPLICAS, 0);
    assert.equal(WARM_POOL_MAX_REPLICAS, 2);
  });
});

// ---------- transport: auth token + endpoint resolution (§4.1), stubbed fetch, no network ----------

describe("resolveGkeEndpoint", () => {
  test("GETs clusters.get with a bearer token and reads the DNS endpoint", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      return new Response(
        JSON.stringify({ controlPlaneEndpointsConfig: { dnsEndpointConfig: { endpoint: "gke-abc-123.us-central1.gke.goog" } } }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const endpoint = await resolveGkeEndpoint(
        { project: "p", location: "us-central1", cluster: "outfitter" },
        async () => "test-token",
      );
      assert.equal(endpoint, "gke-abc-123.us-central1.gke.goog");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://container.googleapis.com/v1/projects/p/locations/us-central1/clusters/outfitter");
      assert.equal(calls[0].headers.Authorization, "Bearer test-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws when the cluster has no dnsEndpointConfig.endpoint (enable-dns-access not set)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    try {
      await assert.rejects(
        () => resolveGkeEndpoint({ project: "p", location: "us-central1", cluster: "outfitter" }, async () => "tok"),
        /dnsEndpointConfig\.endpoint/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Review round 1, L6: endpoint resolution failures are a distinct type from KubeError -- a wrong
  // cluster/location/project is not "the warm pool is missing" or "the claim doesn't exist", even
  // though a 404 can result from either. routes/hooks.ts checks for GkeEndpointError first so this
  // doesn't get misreported as one of those.
  test("a non-2xx from clusters.get throws GkeEndpointError, not KubeError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    try {
      await assert.rejects(
        () => resolveGkeEndpoint({ project: "p", location: "us-central1", cluster: "outfitter" }, async () => "tok"),
        (err: unknown) => err instanceof GkeEndpointError && !(err instanceof KubeError) && /403/.test(err.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Review round 1, L2: bounded, so a hung metadata server or cluster can't wedge a wake or a
  // reconcile tick. Verified two ways: the request actually carries an AbortSignal, and a fetch
  // rejection shaped like AbortSignal.timeout()'s firing produces a clean, bounded message rather
  // than a raw DOMException reaching a run's statusDetail.
  test("passes an AbortSignal to fetch, and turns a timeout rejection into a clean message", async () => {
    const originalFetch = globalThis.fetch;
    const signals: unknown[] = [];
    globalThis.fetch = (async (_url: string, init?: { signal?: unknown }) => {
      signals.push(init?.signal);
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => resolveGkeEndpoint({ project: "p", location: "us-central1", cluster: "outfitter" }, async () => "tok"),
        (err: unknown) => err instanceof GkeEndpointError && /timed out after 15000ms/.test(err.message),
      );
      assert.equal(signals.length, 1);
      assert.ok(signals[0] instanceof AbortSignal, "clusters.get must be called with an AbortSignal");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("HttpKubeClient", () => {
  test("sends a bearer token and merge-patch content type", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers as Record<string, string>) ?? {}, body: init?.body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      const client = new HttpKubeClient("gke-abc-123.us-central1.gke.goog", async () => "test-token");
      await client.patch("/apis/x/v1beta1/namespaces/ns/sandboxwarmpools/pool", { spec: { replicas: 1 } });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://gke-abc-123.us-central1.gke.goog/apis/x/v1beta1/namespaces/ns/sandboxwarmpools/pool");
      assert.equal(calls[0].method, "PATCH");
      assert.equal(calls[0].headers.Authorization, "Bearer test-token");
      assert.equal(calls[0].headers["Content-Type"], "application/merge-patch+json");
      assert.equal(calls[0].body, JSON.stringify({ spec: { replicas: 1 } }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("get() returns null on 404 instead of throwing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    try {
      const client = new HttpKubeClient("gke-abc.us-central1.gke.goog", async () => "test-token");
      assert.equal(await client.get("/apis/x/v1beta1/namespaces/ns/sandboxclaims/missing"), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("delete() treats 404 as success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    try {
      const client = new HttpKubeClient("gke-abc.us-central1.gke.goog", async () => "test-token");
      await assert.doesNotReject(() => client.delete("/apis/x/v1beta1/namespaces/ns/sandboxclaims/missing"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Review round 1, M2/M3: drive create() against a stubbed fetch returning a 422 whose body is a
  // Kubernetes Status object that echoes the rejected claim's RUN_TOKEN back in `message` (a real
  // admission rejection can do exactly this). Assert the thrown message contains neither the token
  // nor the raw JSON body -- only the curated `code`/`reason` translation.
  test("create() against a 422 whose body echoes the token: the thrown message has neither the token nor the raw body", async () => {
    const token = "unmistakable-secret-xyz";
    const rawBody = JSON.stringify({
      kind: "Status",
      status: "Failure",
      message: `admission webhook denied the request: spec.env[1].value: ${token} is not permitted`,
      reason: "Invalid",
      code: 422,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(rawBody, { status: 422 })) as typeof fetch;
    try {
      const client = new HttpKubeClient("gke-abc.us-central1.gke.goog", async () => "test-token");
      await assert.rejects(
        () => client.create("/apis/x/v1beta1/namespaces/ns/sandboxclaims", { spec: {} }),
        (err: unknown) => {
          if (!(err instanceof KubeError)) return false;
          if (err.status !== 422) return false;
          if (err.message.includes(token)) return false;
          if (err.message.includes(rawBody)) return false;
          if (err.message.includes("admission webhook")) return false; // the raw `message` field itself
          return /422/.test(err.message) && /Invalid/.test(err.message);
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a non-JSON error body falls back to the plain HTTP status/statusText, still no raw body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("<html>502 Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" })) as typeof fetch;
    try {
      const client = new HttpKubeClient("gke-abc.us-central1.gke.goog", async () => "test-token");
      await assert.rejects(
        () => client.create("/apis/x/v1beta1/namespaces/ns/sandboxclaims", { spec: {} }),
        (err: unknown) => err instanceof KubeError && err.status === 502 && !err.message.includes("<html>") && /502/.test(err.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Review round 1, L2.
  test("every request carries an AbortSignal timeout, and a timeout rejection is a clean KubeError", async () => {
    const originalFetch = globalThis.fetch;
    const signals: unknown[] = [];
    globalThis.fetch = (async (_url: string, init?: { signal?: unknown }) => {
      signals.push(init?.signal);
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as typeof fetch;
    try {
      const client = new HttpKubeClient("gke-abc.us-central1.gke.goog", async () => "test-token");
      await assert.rejects(
        () => client.get("/apis/x/v1beta1/namespaces/ns/sandboxclaims/run-x"),
        (err: unknown) => err instanceof KubeError && /timed out after 15000ms/.test(err.message),
      );
      assert.equal(signals.length, 1);
      assert.ok(signals[0] instanceof AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
