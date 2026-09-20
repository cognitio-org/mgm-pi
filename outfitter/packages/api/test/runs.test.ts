// RunManager.wake / reconcileOnce (src/runs.ts): starting a run mints a per-run secret bound to
// the run's own token hash (finding #2, docs/reports/security-review-pr1.md); reconcileOnce stops
// orphaned provider executions and respects the provisioning grace window before marking a stale
// run failed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { NoopProvider } from "../src/providers/noop.ts";
import { RunManager } from "../src/runs.ts";
import type { Run } from "../src/store/types.ts";

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    sessionId: "s1",
    state: "running",
    lastAckedSeq: 0,
    pending: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("RunManager.wake", () => {
  test("generates a per-run token, hands the plaintext to the provider, and stores only its hash", async () => {
    const store = new MemoryStore();
    const provider = new NoopProvider();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const runs = new RunManager(store, provider, config);

    const run = await runs.wake("s1");

    assert.equal(provider.startCalls.length, 1);
    const launched = provider.startCalls[0];
    assert.equal(launched.runId, run.id);
    assert.equal(typeof launched.runToken, "string");
    assert.ok(launched.runToken.length >= 32); // 32 random bytes, hex-encoded

    const stored = await store.runs.findById(run.id);
    assert.equal(typeof stored?.runTokenHash, "string");
    // Only the hash is ever persisted -- never the plaintext token itself.
    assert.notEqual(stored?.runTokenHash, launched.runToken);
    const expectedHash = createHash("sha256").update(launched.runToken).digest("hex");
    assert.equal(stored?.runTokenHash, expectedHash);
  });

  test("two runs get distinct tokens and distinct hashes", async () => {
    const store = new MemoryStore();
    const provider = new NoopProvider();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const runs = new RunManager(store, provider, config);

    const run1 = await runs.wake("s1");
    // s1 already has an active run, so wake() again for the same session is a no-op; use a
    // different session to force a second real launch.
    const run2 = await runs.wake("s2");

    assert.notEqual(run1.id, run2.id);
    const [call1, call2] = provider.startCalls;
    assert.notEqual(call1.runToken, call2.runToken);
    const stored1 = await store.runs.findById(run1.id);
    const stored2 = await store.runs.findById(run2.id);
    assert.notEqual(stored1?.runTokenHash, stored2?.runTokenHash);
  });
});

describe("RunManager.reconcileOnce", () => {
  test("stops the provider handle (best effort) before marking a stale run failed", async () => {
    const store = new MemoryStore();
    const provider = new NoopProvider();
    provider.nextStatus = "running"; // not "starting": eligible to be failed
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const runs = new RunManager(store, provider, config);

    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString(); // well past both the stale
    // cutoff and the provisioning grace window
    const run = makeRun({ createdAt: staleAt, lastSeenAt: staleAt, providerHandle: "exec-1" });
    await store.runs.insert(run);

    await runs.reconcileOnce(60_000);

    assert.equal(provider.stopCalls.length, 1);
    assert.equal(provider.stopCalls[0], "exec-1");
    const stored = await store.runs.findById(run.id);
    assert.equal(stored?.state, "failed");
    assert.equal(stored?.reason, "no heartbeat");
  });

  test("never fails a run younger than the provisioning grace window, even if stale by heartbeat", async () => {
    const store = new MemoryStore();
    const provider = new NoopProvider();
    provider.nextStatus = "running";
    const config = loadConfig({ PROVISIONING_GRACE_MS: "600000" } as NodeJS.ProcessEnv); // 10 min default
    const runs = new RunManager(store, provider, config);

    // created 5s ago (well inside the 10-minute grace) with no heartbeat since.
    const recentlyCreated = new Date(Date.now() - 5_000).toISOString();
    const run = makeRun({
      state: "provisioning",
      createdAt: recentlyCreated,
      providerHandle: "exec-2",
    });
    await store.runs.insert(run);

    // staleAfterMs=0 makes the cutoff "now", so the run is stale by heartbeat immediately.
    await runs.reconcileOnce(0);

    assert.equal(provider.stopCalls.length, 0);
    assert.equal(provider.statusCalls.length, 0); // grace check happens before any provider call
    const stored = await store.runs.findById(run.id);
    assert.equal(stored?.state, "provisioning");
  });

  test("skips (does not stop or fail) a run the provider still reports as starting", async () => {
    const store = new MemoryStore();
    const provider = new NoopProvider();
    provider.nextStatus = "starting";
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const runs = new RunManager(store, provider, config);

    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const run = makeRun({ createdAt: staleAt, lastSeenAt: staleAt, providerHandle: "exec-3" });
    await store.runs.insert(run);

    await runs.reconcileOnce(60_000);

    assert.equal(provider.stopCalls.length, 0);
    const stored = await store.runs.findById(run.id);
    assert.equal(stored?.state, "running"); // unchanged
  });
});
