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
import { RunManager, silentRunDetail } from "../src/runs.ts";
import type { Run } from "../src/store/types.ts";
import type { SandboxExit, SandboxProvider } from "@outfitter/provider-local";

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

describe("RunManager.wake: which origin a sandbox dials", () => {
  // 2026-09-22: the deployed web role woke a Floppy and passed its own IAP-protected origin; the
  // sandbox's WebSocket was turned away by IAP (close 1006) and never reached the link service.
  test("the web role hands sandboxes the link service's origin", async () => {
    const provider = new NoopProvider();
    const config = loadConfig({ OUTFITTER_ROLE: "web", OUTFITTER_ORIGIN: "https://web.example", OUTFITTER_LINK_ORIGIN: "https://link.example" } as NodeJS.ProcessEnv);
    await new RunManager(new MemoryStore(), provider, config).wake("s1");
    assert.equal(provider.startCalls[0].apiOrigin, "https://link.example");
  });
  test("role all (one service holds both) keeps its own origin", async () => {
    const provider = new NoopProvider();
    const config = loadConfig({ OUTFITTER_ORIGIN: "https://all.example", OUTFITTER_LINK_ORIGIN: "https://link.example" } as NodeJS.ProcessEnv);
    await new RunManager(new MemoryStore(), provider, config).wake("s1");
    assert.equal(provider.startCalls[0].apiOrigin, "https://all.example");
  });
});

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

  // Plan §5 item 6 / review finding #7 (PR #124): a start refusal (a future GKE_MAX_ACTIVE
  // refusal is the motivating case, spec §2.4) must also set statusDetail, the #54 convention
  // (store/types.ts's Run.statusDetail doc) for the few things a person sees for a run that never
  // got as far as connecting.
  test("a provider.start() refusal marks the run failed with reason and statusDetail set", async () => {
    const store = new MemoryStore();
    const provider: SandboxProvider = {
      start: async () => {
        throw new Error("gke: max active sandboxes (3) reached");
      },
      stop: async () => {},
      status: async () => "unknown",
    };
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const runs = new RunManager(store, provider, config);

    await assert.rejects(() => runs.wake("s1"), /max active sandboxes/);

    const stored = await store.runs.findLatestForSession("s1");
    assert.equal(stored?.state, "failed");
    assert.equal(stored?.reason, "gke: max active sandboxes (3) reached");
    assert.match(stored?.statusDetail ?? "", /failed to start.*max active sandboxes \(3\) reached\. Press Play to start a new one\./);
  });

  test("a start refusal whose message already ends in '.' doesn't produce a double full stop", async () => {
    const store = new MemoryStore();
    const provider: SandboxProvider = {
      start: async () => {
        throw new Error("cluster unreachable.");
      },
      stop: async () => {},
      status: async () => "unknown",
    };
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const runs = new RunManager(store, provider, config);

    await assert.rejects(() => runs.wake("s1"));

    const stored = await store.runs.findLatestForSession("s1");
    assert.equal(stored?.statusDetail, "this run's sandbox failed to start: cluster unreachable. Press Play to start a new one.");
  });
});

/** A NoopProvider whose exitInfo answers from a queue (#193). */
class ExitingProvider extends NoopProvider {
  exits: (SandboxExit | undefined)[] = [];
  exitCalls = 0;
  async exitInfo(): Promise<SandboxExit | undefined> {
    this.exitCalls++;
    return this.exits.length > 1 ? this.exits.shift() : this.exits[0];
  }
}

describe("RunManager: sandbox exit reasons (#193)", () => {
  const oom: SandboxExit = { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-09-26T05:04:49Z" };

  test("checkSandboxExit fails a running run now with the orchestrator's OOMKilled, and stops its handle", async () => {
    const store = new MemoryStore();
    const provider = new ExitingProvider();
    provider.exits = [oom];
    const runs = new RunManager(store, provider, loadConfig({} as NodeJS.ProcessEnv));
    const run = makeRun({ providerHandle: "h-1", sandboxMemLimitMb: 4096 });
    await store.runs.insert(run);

    assert.equal(await runs.checkSandboxExit(run.id), true);
    const stored = await store.runs.findById(run.id);
    assert.equal(stored?.state, "failed");
    assert.equal(stored?.reason, "out of memory");
    assert.deepEqual(stored?.sandboxExit, oom);
    assert.match(stored?.statusDetail ?? "", /ran out of memory \(4096 MiB\) and was killed \(OOMKilled\)/);
    assert.deepEqual(provider.stopCalls, ["h-1"]);
  });

  test("checkSandboxExit reports another exit with its code, and leaves a still-running sandbox alone", async () => {
    const store = new MemoryStore();
    const provider = new ExitingProvider();
    const runs = new RunManager(store, provider, loadConfig({} as NodeJS.ProcessEnv));
    const alive = makeRun({ providerHandle: "h-alive" });
    await store.runs.insert(alive);
    provider.exits = [undefined];
    assert.equal(await runs.checkSandboxExit(alive.id), false, "not settled: look again later");
    assert.equal((await store.runs.findById(alive.id))?.state, "running");

    const crashed = makeRun({ providerHandle: "h-crash" });
    await store.runs.insert(crashed);
    provider.exits = [{ reason: "Error", exitCode: 1 }];
    await runs.checkSandboxExit(crashed.id);
    const stored = await store.runs.findById(crashed.id);
    assert.equal(stored?.reason, "sandbox exited (Error)");
    assert.match(stored?.statusDetail ?? "", /its agent exited with exit code 1 \(Error\)/);
  });

  test("#199 review: a clean exit (0/Completed) with a lost bye is a stop, not a failure", async () => {
    const store = new MemoryStore();
    const provider = new ExitingProvider();
    provider.exits = [{ reason: "Completed", exitCode: 0 }];
    const runs = new RunManager(store, provider, loadConfig({} as NodeJS.ProcessEnv));
    const run = makeRun({ providerHandle: "h-idle", state: "idle" });
    await store.runs.insert(run);
    await runs.checkSandboxExit(run.id);
    const stored = await store.runs.findById(run.id);
    assert.equal(stored?.state, "stopped");
    assert.equal(stored?.reason, "agent exited");
    assert.equal(stored?.statusDetail, undefined, "no failure note");

    // The reconciler reaches the same answer for a run it finds first.
    provider.nextStatus = "exited";
    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const quiet = makeRun({ providerHandle: "h-q", createdAt: staleAt, lastSeenAt: staleAt });
    await store.runs.insert(quiet);
    await runs.reconcileOnce(60_000);
    assert.equal((await store.runs.findById(quiet.id))?.state, "stopped");
  });

  test("#199 review: a user's Stop (state stopping) is left to the stop-grace path", async () => {
    const store = new MemoryStore();
    const provider = new ExitingProvider();
    provider.exits = [{ reason: "Completed", exitCode: 0 }];
    const runs = new RunManager(store, provider, loadConfig({} as NodeJS.ProcessEnv));
    const quietAt = new Date(Date.now() - 45_000).toISOString();
    const run = makeRun({ providerHandle: "h-stop", state: "stopping", lastSeenAt: quietAt, createdAt: quietAt });
    await store.runs.insert(run);
    assert.equal(await runs.checkSandboxExit(run.id), true);
    await runs.probeSilentRuns(30_000);
    assert.equal((await store.runs.findById(run.id))?.state, "stopping");
    assert.equal(provider.exitCalls, 0);
  });

  test("checkSandboxExit never touches a run that ended cleanly or already failed", async () => {
    const store = new MemoryStore();
    const provider = new ExitingProvider();
    provider.exits = [oom];
    const runs = new RunManager(store, provider, loadConfig({} as NodeJS.ProcessEnv));
    for (const state of ["stopped", "failed"] as const) {
      const run = makeRun({ providerHandle: `h-${state}`, state, reason: "keep me" });
      await store.runs.insert(run);
      assert.equal(await runs.checkSandboxExit(run.id), true);
      assert.equal((await store.runs.findById(run.id))?.reason, "keep me");
    }
    assert.equal(provider.exitCalls, 0);
  });

  test("noteAgentLost looks again after a first 'still running', then records the exit", async () => {
    const store = new MemoryStore();
    const provider = new ExitingProvider();
    provider.exits = [undefined, oom];
    const runs = new RunManager(store, provider, loadConfig({} as NodeJS.ProcessEnv));
    const run = makeRun({ providerHandle: "h-late" });
    await store.runs.insert(run);
    runs.noteAgentLost(run.id, [5, 5]);
    for (let i = 0; i < 50 && (await store.runs.findById(run.id))?.state !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await store.runs.findById(run.id))?.reason, "out of memory");
    assert.equal(provider.exitCalls, 2);
  });

  test("probeSilentRuns looks only at active runs quiet past the cutoff, and fails the ones that ended", async () => {
    const store = new MemoryStore();
    const provider = new ExitingProvider();
    provider.exits = [oom];
    const runs = new RunManager(store, provider, loadConfig({} as NodeJS.ProcessEnv));
    const quietAt = new Date(Date.now() - 45_000).toISOString();
    const quiet = makeRun({ providerHandle: "h-quiet", lastSeenAt: quietAt, createdAt: quietAt });
    const chatty = makeRun({ providerHandle: "h-chatty", lastSeenAt: new Date().toISOString() });
    const booting = makeRun({ providerHandle: "h-boot", state: "provisioning", createdAt: quietAt });
    for (const run of [quiet, chatty, booting]) await store.runs.insert(run);

    await runs.probeSilentRuns(30_000);

    assert.equal((await store.runs.findById(quiet.id))?.reason, "out of memory");
    assert.equal((await store.runs.findById(chatty.id))?.state, "running");
    assert.equal((await store.runs.findById(booting.id))?.state, "provisioning");
    assert.equal(provider.exitCalls, 1, "only the quiet, started run was looked at");
  });

  test("the reconciler asks exitInfo before stop(), and a real reason beats the memory estimate", async () => {
    const store = new MemoryStore();
    const provider = new ExitingProvider();
    provider.nextStatus = "exited";
    provider.exits = [{ reason: "Error", exitCode: 2 }];
    const runs = new RunManager(store, provider, loadConfig({} as NodeJS.ProcessEnv));
    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
    // Memory near the limit would have said "most likely ran out of memory".
    const run = makeRun({ createdAt: staleAt, lastSeenAt: staleAt, providerHandle: "h-r", sandboxMemLastMb: 1900, sandboxMemLimitMb: 2048 });
    await store.runs.insert(run);
    await runs.reconcileOnce(60_000);
    const stored = await store.runs.findById(run.id);
    assert.equal(stored?.state, "failed");
    assert.deepEqual(stored?.sandboxExit, { reason: "Error", exitCode: 2 });
    assert.match(stored?.statusDetail ?? "", /exit code 2 \(Error\)/);
    assert.doesNotMatch(stored?.statusDetail ?? "", /most likely/);
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

  test("#187: a silent run whose sandbox was near its memory limit is failed with an out-of-memory note", async () => {
    const store = new MemoryStore();
    const provider = new NoopProvider();
    provider.nextStatus = "exited";
    const runs = new RunManager(store, provider, loadConfig({} as NodeJS.ProcessEnv));
    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const run = makeRun({
      createdAt: staleAt,
      lastSeenAt: staleAt,
      providerHandle: "exec-1",
      sandboxMemPeakMb: 1900,
      sandboxMemLastMb: 1900,
      sandboxMemLimitMb: 2048,
    });
    await store.runs.insert(run);

    await runs.reconcileOnce(60_000);

    const stored = await store.runs.findById(run.id);
    assert.equal(stored?.state, "failed");
    assert.equal(stored?.reason, "no heartbeat");
    assert.match(stored?.statusDetail ?? "", /memory was at 1900 MiB of its 2048 MiB limit/);
    assert.match(stored?.statusDetail ?? "", /ran out of memory/);
  });

  test("#187: a silent run with memory well below its limit in its last report keeps the generic note", async () => {
    assert.match(silentRunDetail({ sandboxMemLastMb: 600, sandboxMemLimitMb: 2048 }), /stopped reporting to the api/);
    assert.match(silentRunDetail({}), /stopped reporting to the api/);
    assert.match(silentRunDetail({ sandboxMemLastMb: 1700, sandboxMemLimitMb: 2048 }), /ran out of memory/, "83% counts");
  });

  test("#187 review: an early spike the run survived doesn't get the blame for a later death", async () => {
    const store = new MemoryStore();
    const provider = new NoopProvider();
    provider.nextStatus = "exited";
    const runs = new RunManager(store, provider, loadConfig({} as NodeJS.ProcessEnv));
    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const run = makeRun({
      createdAt: staleAt,
      lastSeenAt: staleAt,
      providerHandle: "exec-1",
      sandboxMemPeakMb: 1950, // a build an hour ago
      sandboxMemLastMb: 420, // what it was using when it went quiet
      sandboxMemLimitMb: 2048,
    });
    await store.runs.insert(run);
    await runs.reconcileOnce(60_000);
    assert.match((await store.runs.findById(run.id))?.statusDetail ?? "", /stopped reporting to the api/);
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
