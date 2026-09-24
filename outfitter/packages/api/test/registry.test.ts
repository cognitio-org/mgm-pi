// SandboxProviders registry (docs/specs/gke-sandbox-provider.md §2.4, plan §5 item 4): lazy,
// memoized construction; an unconfigured provider throws instead of crashing the caller;
// providerNameFor()'s legacy inference; and a RunManager that keeps stopping a run recorded under
// a provider the deployment's default has since switched away from.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { NoopProvider } from "../src/providers/noop.ts";
import { SandboxProviders } from "../src/providers/registry.ts";
import { RunManager, providerNameFor } from "../src/runs.ts";
import type { Run } from "../src/store/types.ts";
import type { SandboxProvider } from "@outfitter/provider-local";

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    sessionId: "s1",
    state: "running",
    lastAckedSeq: 0,
    pending: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("SandboxProviders", () => {
  test("get() builds lazily and memoizes: the factory runs at most once", async () => {
    let builds = 0;
    const provider = new NoopProvider();
    const providers = new SandboxProviders("inprocess", {
      inprocess: async () => {
        builds++;
        return provider;
      },
    });

    const [a, b] = await Promise.all([providers.get("inprocess"), providers.get("inprocess")]);
    assert.equal(a, provider);
    assert.equal(b, provider);
    assert.equal(builds, 1);
  });

  test("get() on an unconfigured name throws, rather than crashing the caller", async () => {
    const providers = new SandboxProviders("inprocess", { inprocess: async () => new NoopProvider() });
    await assert.rejects(() => providers.get("cloudrun"), /sandbox provider "cloudrun" is not configured here/);
  });

  test("get() memoizes a factory that throws synchronously, as a rejection (not an uncaught throw)", async () => {
    const providers = new SandboxProviders("inprocess", {
      inprocess: () => {
        throw new Error("boom");
      },
    });
    await assert.rejects(() => providers.get("inprocess"), /boom/);
  });

  test("SandboxProviders.single wraps one provider as the named default", async () => {
    const provider = new NoopProvider();
    const providers = SandboxProviders.single("cloudrun", provider);
    assert.equal(providers.defaultName, "cloudrun");
    assert.equal(await providers.get("cloudrun"), provider);
    await assert.rejects(() => providers.get("gke"), /not configured here/);
  });
});

describe("providerNameFor", () => {
  test("uses Run.sandboxProvider when set", () => {
    const run = makeRun({ sandboxProvider: "gke", providerHandle: "outfitter-sandboxes/run-1" });
    assert.equal(providerNameFor(run, "cloudrun"), "gke");
  });

  test("infers cloudrun from a legacy Cloud Run execution-name handle when sandboxProvider is absent", () => {
    const run = makeRun({ providerHandle: "projects/p/locations/r/jobs/outfitter-agent/executions/abc" });
    assert.equal(providerNameFor(run, "gke"), "cloudrun");
  });

  test("falls back to the given default when neither is available", () => {
    const run = makeRun({ providerHandle: "inproc-1" });
    assert.equal(providerNameFor(run, "inprocess"), "inprocess");
    assert.equal(providerNameFor(makeRun(), "docker"), "docker");
  });
});

describe("RunManager provider resolution via the registry", () => {
  test("stops a run recorded under 'cloudrun' after the deployment's default has switched to 'gke'", async () => {
    const store = new MemoryStore();
    const cloudrun = new NoopProvider();
    const gke = new NoopProvider();
    const providers = new SandboxProviders("gke", {
      cloudrun: async () => cloudrun,
      gke: async () => gke,
    });
    const config = loadConfig({ SANDBOX_PROVIDER: "gke" } as NodeJS.ProcessEnv);
    const runs = new RunManager(store, providers, config);

    const run = makeRun({ providerHandle: "exec-legacy", sandboxProvider: "cloudrun" });
    await store.runs.insert(run);

    const stopped = await runs.stop(run.id);

    assert.equal(stopped?.state, "stopped");
    assert.deepEqual(cloudrun.stopCalls, ["exec-legacy"]);
    assert.equal(gke.stopCalls.length, 0);
  });

  test("a run under a provider no longer configured at all: state still changes, no provider call, warning logged once", async () => {
    const store = new MemoryStore();
    const gke = new NoopProvider();
    const providers = new SandboxProviders("gke", { gke: async () => gke });
    const config = loadConfig({ SANDBOX_PROVIDER: "gke" } as NodeJS.ProcessEnv);
    const runs = new RunManager(store, providers, config);

    const run = makeRun({ providerHandle: "exec-orphan", sandboxProvider: "cloudrun" });
    await store.runs.insert(run);

    const logged = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    let stopped;
    try {
      stopped = await runs.stop(run.id);
    } finally {
      console.warn = logged;
    }

    assert.equal(stopped?.state, "stopped");
    assert.equal(gke.stopCalls.length, 0);
    assert.equal(warnings.length, 1);
  });

  test("RunManager still accepts a bare SandboxProvider (source compatibility)", async () => {
    const store = new MemoryStore();
    const provider: SandboxProvider = new NoopProvider();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const runs = new RunManager(store, provider, config);

    const run = await runs.wake("s1");
    assert.equal(run.state, "provisioning");
    assert.equal(run.sandboxProvider, config.sandboxProvider);
  });
});
