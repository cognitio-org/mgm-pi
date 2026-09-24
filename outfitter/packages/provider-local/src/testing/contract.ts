// Provider contract suite (docs/specs/gke-sandbox-provider.md §6.2, gke-sandbox-provider-plan.md §5
// item 2): every SandboxProvider implementation -- inprocess, docker, cloudrun, gke (PR2), noop --
// must satisfy the same eight behaviors (C1-C8) regardless of what actually runs the sandbox, so a
// deploy can switch SANDBOX_PROVIDER without a behavior change no one tested for.
//
// Each provider's own test file supplies an "adapter": a SandboxProvider instance plus a `world`
// that can do the two things the SandboxProvider interface itself can't -- read back what a launch
// actually delivered to the sandbox, and simulate the agent process exiting on its own (not via
// provider.stop()) -- then calls runProviderContract(name, makeProvider) once. `makeProvider`
// rejecting (e.g. the docker adapter finding no docker binary) skips every case with that reason
// instead of failing the suite.

import { test, describe, before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { RunLaunch, SandboxHandle, SandboxProvider } from "../types.js";

/** What the sandbox launched by `handle` actually received, read back through whatever channel
 * the provider uses (env vars for inprocess/docker/cloudrun; claim annotations for gke). */
export interface ContractReceived {
  runId?: string;
  runToken?: string;
  apiOrigin?: string;
}

/** Adapter-specific control plane the suite needs beyond what SandboxProvider itself exposes. */
export interface ContractWorld {
  /** Reads back what `handle`'s sandbox was actually given (C1). Polls briefly rather than
   * assuming the channel is synchronous with start() resolving. */
  received(handle: SandboxHandle): Promise<ContractReceived | undefined>;
  /** Simulates the agent process exiting on its own -- not via provider.stop() -- so C3 can prove
   * status() eventually reports "exited" without the suite ever calling stop() itself. */
  exitByItself(handle: SandboxHandle): Promise<void>;
  /** Releases anything the world created beyond what provider.stop() already releases (e.g. a
   * leftover container or temp file). Best-effort; called after every case that started a handle. */
  cleanup?(handle: SandboxHandle): Promise<void>;
}

export interface ContractInstance {
  provider: SandboxProvider;
  world: ContractWorld;
}

export type MakeContractProvider = () => Promise<ContractInstance> | ContractInstance;

function makeLaunch(overrides: Partial<RunLaunch> = {}): RunLaunch {
  return {
    runId: `contract-${randomUUID()}`,
    apiOrigin: "https://api.contract.example",
    runToken: randomBytes(16).toString("hex"),
    ...overrides,
  };
}

/** Polls `check` until it resolves true or `timeoutMs` elapses; throws `label` on timeout. Used
 * for C3 ("eventually", under whichever clock the adapter's world actually runs on). */
async function waitUntil(check: () => Promise<boolean>, label: string, timeoutMs = 5_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms`);
}

/**
 * Runs contract cases C1-C8 against one provider adapter. `name` labels the describe block;
 * `makeProvider` builds (or rejects, to skip) the provider+world pair once, in a `before()` shared
 * by every case below.
 */
export function runProviderContract(name: string, makeProvider: MakeContractProvider): void {
  describe(`SandboxProvider contract: ${name}`, () => {
    let instance: ContractInstance | undefined;
    let skipReason: string | undefined;

    before(async () => {
      try {
        instance = await makeProvider();
      } catch (err) {
        skipReason = err instanceof Error ? err.message : String(err);
      }
    });

    /** Returns the shared instance, or skips `t` and returns undefined when setup failed. */
    function guard(t: TestContext): ContractInstance | undefined {
      if (skipReason || !instance) {
        t.skip(skipReason ?? "adapter setup did not run");
        return undefined;
      }
      return instance;
    }

    test("C1: start delivers runId, runToken and apiOrigin to the sandbox", async (t) => {
      const ctx = guard(t);
      if (!ctx) return;
      const launch = makeLaunch();
      const { handle } = await ctx.provider.start(launch);
      try {
        assert.equal(typeof handle, "string");
        assert.ok(handle.length > 0, "handle must be a non-empty string");
        const received = await ctx.world.received(handle);
        assert.equal(received?.runId, launch.runId);
        assert.equal(received?.runToken, launch.runToken);
        assert.equal(received?.apiOrigin, launch.apiOrigin);
      } finally {
        await ctx.provider.stop(handle);
        await ctx.world.cleanup?.(handle);
      }
    });

    test("C2: status of a freshly started handle is starting or running, never exited", async (t) => {
      const ctx = guard(t);
      if (!ctx) return;
      const { handle } = await ctx.provider.start(makeLaunch());
      try {
        const status = await ctx.provider.status(handle);
        assert.ok(status === "starting" || status === "running", `got ${status}`);
      } finally {
        await ctx.provider.stop(handle);
        await ctx.world.cleanup?.(handle);
      }
    });

    test("C3: once the agent exits by itself, status eventually becomes exited", async (t) => {
      const ctx = guard(t);
      if (!ctx) return;
      const { handle } = await ctx.provider.start(makeLaunch());
      try {
        await ctx.world.exitByItself(handle);
        await waitUntil(async () => (await ctx.provider.status(handle)) === "exited", "C3 status never became exited");
      } finally {
        await ctx.provider.stop(handle);
        await ctx.world.cleanup?.(handle);
      }
    });

    test("C4: stop is idempotent", async (t) => {
      const ctx = guard(t);
      if (!ctx) return;
      const { handle } = await ctx.provider.start(makeLaunch());
      try {
        await ctx.provider.stop(handle);
        await assert.doesNotReject(() => ctx.provider.stop(handle));
        await ctx.world.exitByItself(handle).catch(() => {
          // some adapters can't act on an already-stopped handle; irrelevant to this case
        });
        await assert.doesNotReject(() => ctx.provider.stop(handle));
      } finally {
        await ctx.world.cleanup?.(handle);
      }
    });

    test("C5: status('') and stop('') don't throw", async (t) => {
      const ctx = guard(t);
      if (!ctx) return;
      await assert.doesNotReject(() => ctx.provider.status(""));
      await assert.doesNotReject(() => ctx.provider.stop(""));
    });

    test("C6: status of an unknown handle is exited or unknown, and does not throw", async (t) => {
      const ctx = guard(t);
      if (!ctx) return;
      const status = await ctx.provider.status(`no-such-handle-${randomUUID()}`);
      assert.ok(status === "exited" || status === "unknown", `got ${status}`);
    });

    test("C7: capacity, if present, returns active >= 0 and counts a started sandbox", async (t) => {
      const ctx = guard(t);
      if (!ctx) return;
      if (!ctx.provider.capacity) {
        t.skip("provider has no capacity()");
        return;
      }
      const before_ = await ctx.provider.capacity();
      assert.ok(before_.active >= 0);
      const { handle } = await ctx.provider.start(makeLaunch());
      try {
        const after = await ctx.provider.capacity();
        assert.ok(after.active >= 1, `expected at least one active sandbox, got ${after.active}`);
      } finally {
        await ctx.provider.stop(handle);
        await ctx.world.cleanup?.(handle);
      }
    });

    test("C8: the run token does not appear in the handle", async (t) => {
      const ctx = guard(t);
      if (!ctx) return;
      const launch = makeLaunch();
      const { handle } = await ctx.provider.start(launch);
      try {
        assert.ok(!handle.includes(launch.runToken));
      } finally {
        await ctx.provider.stop(handle);
        await ctx.world.cleanup?.(handle);
      }
    });
  });
}
