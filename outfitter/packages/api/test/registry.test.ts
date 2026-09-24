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
import { buildApp } from "../src/server.ts";
import { MemorySecretsBroker, MemorySecretAdmin } from "../src/secrets.ts";
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

  test("warn once: two runs (or two calls) resolving the same unconfigured provider only warn once total", async () => {
    const store = new MemoryStore();
    const gke = new NoopProvider();
    const providers = new SandboxProviders("gke", { gke: async () => gke });
    const config = loadConfig({ SANDBOX_PROVIDER: "gke" } as NodeJS.ProcessEnv);
    const runs = new RunManager(store, providers, config);

    const runA = makeRun({ providerHandle: "exec-a", sandboxProvider: "cloudrun" });
    const runB = makeRun({ id: crypto.randomUUID(), providerHandle: "exec-b", sandboxProvider: "cloudrun" });
    await store.runs.insert(runA);
    await store.runs.insert(runB);

    const logged = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      await runs.stop(runA.id);
      await runs.stop(runA.id); // a second call against the same run's provider
      await runs.stop(runB.id); // a different run, same unconfigured provider name
    } finally {
      console.warn = logged;
    }

    assert.equal(warnings.length, 1, `expected exactly one warning, got ${warnings.length}`);
  });

  test("reconcileOnce with an unconfigured provider: the run is still marked failed, no throw", async () => {
    const store = new MemoryStore();
    const gke = new NoopProvider();
    const providers = new SandboxProviders("gke", { gke: async () => gke });
    const config = loadConfig({ SANDBOX_PROVIDER: "gke" } as NodeJS.ProcessEnv);
    const runs = new RunManager(store, providers, config);

    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const run = makeRun({ createdAt: staleAt, lastSeenAt: staleAt, providerHandle: "exec-orphan", sandboxProvider: "cloudrun" });
    await store.runs.insert(run);

    await assert.doesNotReject(() => runs.reconcileOnce(60_000));

    assert.equal(gke.stopCalls.length, 0);
    const stored = await store.runs.findById(run.id);
    assert.equal(stored?.state, "failed");
    assert.equal(stored?.reason, "no heartbeat");
  });

  test("reconcileStoppingOnce with an unconfigured provider: the run is still marked stopped, no throw", async () => {
    const store = new MemoryStore();
    const gke = new NoopProvider();
    const providers = new SandboxProviders("gke", { gke: async () => gke });
    const config = loadConfig({ SANDBOX_PROVIDER: "gke" } as NodeJS.ProcessEnv);
    const runs = new RunManager(store, providers, config);

    const staleAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const run = makeRun({ state: "stopping", updatedAt: staleAt, providerHandle: "exec-orphan", sandboxProvider: "cloudrun" });
    await store.runs.insert(run);

    await assert.doesNotReject(() => runs.reconcileStoppingOnce(60_000));

    assert.equal(gke.stopCalls.length, 0);
    const stored = await store.runs.findById(run.id);
    assert.equal(stored?.state, "stopped");
    assert.equal(stored?.reason, "stop grace expired");
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

describe("buildApp wiring (main.ts-style: the full registry, not just the default provider)", () => {
  test("with cloudrun and gke both registered and default=gke, stopping a 'cloudrun' run calls the cloudrun provider's stop", async () => {
    // Regression for review finding #1 (PR #124): main.ts used to call createProvider(config),
    // which only ever registers the *default* provider, and buildApp took one bare provider --
    // RunManager then wrapped it with SandboxProviders.single(), so production had no way to
    // reach a provider other than the current default. A run recorded under a provider the
    // deployment has since switched away from (cloudrun, here) would resolve to nothing: stop/
    // reconcile would mark it stopped/failed without ever calling the real provider's stop(),
    // leaving the actual sandbox (a Cloud Run execution, in production) running and billing.
    const cloudrun = new NoopProvider();
    const gke = new NoopProvider();
    const providers = new SandboxProviders("gke", {
      cloudrun: async () => cloudrun,
      gke: async () => gke,
    });
    const store = new MemoryStore();
    const config = loadConfig({ SANDBOX_PROVIDER: "gke", OUTFITTER_DEV: "1" } as NodeJS.ProcessEnv);

    const app = await buildApp({
      store,
      config,
      provider: providers,
      secretsBroker: new MemorySecretsBroker(),
      secretAdmin: new MemorySecretAdmin(),
    });

    const run = makeRun({ providerHandle: "exec-legacy", sandboxProvider: "cloudrun" });
    await store.runs.insert(run);

    const stopped = await app.runs.stop(run.id);

    assert.equal(stopped?.state, "stopped");
    assert.deepEqual(cloudrun.stopCalls, ["exec-legacy"]);
    assert.equal(gke.stopCalls.length, 0);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});
