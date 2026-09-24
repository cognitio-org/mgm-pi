// GkeProvider's adapter for the shared SandboxProvider contract suite
// (@outfitter/provider-local/testing, docs/specs/gke-sandbox-provider.md §6.2). Same in-memory-map
// style as gke.test.ts's own fake KubeClientLike and contract.cloudrun.test.ts's adapter -- no
// credentials, no network.

import { GkeProvider, KubeError, type KubeClientLike } from "../src/providers/gke.ts";
import { runProviderContract } from "@outfitter/provider-local/testing";
import type { ContractInstance, ContractWorld } from "@outfitter/provider-local/testing";
import type { SandboxHandle } from "@outfitter/provider-local";

const NS = "outfitter-sandboxes";
const POOL = "outfitter-agent";
const CLAIMS_PATH = `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NS}/sandboxclaims`;
const WARM_POOL_PATH = `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NS}/sandboxwarmpools/${POOL}`;

interface FakeClaim {
  metadata: { name: string; namespace: string; labels?: Record<string, string>; deletionTimestamp?: string };
  spec: { env?: Array<{ name: string; value: string }> };
  status?: { conditions?: Array<{ type?: string; status?: string; reason?: string }> };
}

function makeGkeContract(): ContractInstance {
  const store = new Map<string, unknown>();
  store.set(WARM_POOL_PATH, { spec: { replicas: 0 }, status: { readyReplicas: 0 } });

  const kube: KubeClientLike = {
    async get<T>(path: string): Promise<T | null> {
      return store.has(path) ? (structuredClone(store.get(path)) as T) : null;
    },
    async create<T>(path: string, body: unknown): Promise<T> {
      const b = body as { metadata: { name: string } };
      const itemPath = `${path}/${b.metadata.name}`;
      if (store.has(itemPath)) throw new KubeError(409, `${itemPath} already exists`);
      // A freshly created claim starts Ready=True here, standing in for "the pod is up" -- this
      // fake has no separate pod-scheduling delay to model (C2 just needs starting|running, and
      // Ready=True satisfies that as "running").
      const claim = { ...(body as FakeClaim), status: { conditions: [{ type: "Ready", status: "True" }] } };
      store.set(itemPath, claim);
      return claim as T;
    },
    async delete(path: string): Promise<void> {
      store.delete(path);
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
      const existing = store.get(path) as { spec: object } | undefined;
      if (!existing) throw new KubeError(404, `${path} not found`);
      const patchBody = body as { spec?: Record<string, unknown> };
      store.set(path, { ...existing, spec: { ...existing.spec, ...patchBody.spec } });
    },
  };

  const provider = new GkeProvider(
    { project: "p", location: "us-central1", cluster: "outfitter", namespace: NS, warmPool: POOL, launchMode: "cold", maxActive: 100 },
    { kube: async () => kube },
  );

  function pathFor(handle: SandboxHandle): string | undefined {
    const match = /^gke:([^/]+)\/(.+)$/.exec(handle);
    return match ? `${CLAIMS_PATH}/${match[2]}` : undefined;
  }

  const world: ContractWorld = {
    async received(handle: SandboxHandle) {
      const path = pathFor(handle);
      const claim = path ? (store.get(path) as FakeClaim | undefined) : undefined;
      if (!claim) return undefined;
      const env = Object.fromEntries((claim.spec.env ?? []).map((e) => [e.name, e.value]));
      return { runId: env.RUN_ID, runToken: env.RUN_TOKEN, apiOrigin: env.OUTFITTER_API };
    },
    async exitByItself(handle: SandboxHandle) {
      const path = pathFor(handle);
      if (!path) return;
      const claim = store.get(path) as FakeClaim | undefined;
      if (claim) store.set(path, { ...claim, status: { conditions: [{ type: "Ready", status: "False", reason: "PodSucceeded" }] } });
    },
  };

  return { provider, world };
}

runProviderContract("gke", makeGkeContract);
