// NoopProvider's adapter for the shared SandboxProvider contract suite -- a sanity check that the
// contract itself makes sense against the simplest possible provider (docs/specs/
// gke-sandbox-provider.md §6.2's "NoopProvider as a sanity check").
//
// NoopProvider.status() ignores its handle argument and just returns a single provider-wide
// `nextStatus` (default "running"), so this adapter can't just forward status() calls to it: an
// `exitByItself` implemented as "set nextStatus = 'exited' for good" would make every *other*
// handle's status() report "exited" too, from that point on -- which used to make the whole
// contract's cases pass or fail depending on what order they happened to run in (review finding
// #6, PR #124), not on what each case actually did. This wraps NoopProvider with its own
// per-handle `started`/`exited` tracking instead, so every case is independent of the others.

import { NoopProvider } from "../src/providers/noop.ts";
import { runProviderContract } from "@outfitter/provider-local/testing";
import type { ContractInstance, ContractWorld } from "@outfitter/provider-local/testing";
import type { SandboxHandle, SandboxProvider, SandboxStatus } from "@outfitter/provider-local";

function makeNoopContract(): ContractInstance {
  const inner = new NoopProvider();
  const started = new Set<SandboxHandle>();
  const exited = new Set<SandboxHandle>();

  const provider: SandboxProvider = {
    async start(run) {
      const result = await inner.start(run);
      started.add(result.handle);
      return result;
    },
    stop: (handle) => inner.stop(handle),
    async status(handle): Promise<SandboxStatus> {
      if (exited.has(handle)) return "exited";
      if (started.has(handle)) return "running";
      return "unknown"; // never started here (C5's "", C6's made-up handle)
    },
  };

  const world: ContractWorld = {
    async received(handle) {
      // NoopProvider hands out "noop-1", "noop-2", ... in start() call order, one-to-one with
      // startCalls' index -- no separate correlation map needed.
      const match = /^noop-(\d+)$/.exec(handle);
      if (!match) return undefined;
      const call = inner.startCalls[Number(match[1]) - 1];
      if (!call) return undefined;
      return { runId: call.runId, runToken: call.runToken, apiOrigin: call.apiOrigin };
    },
    async exitByItself(handle) {
      exited.add(handle);
    },
  };
  return { provider, world };
}

runProviderContract("noop", makeNoopContract);
