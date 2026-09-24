// NoopProvider's adapter for the shared SandboxProvider contract suite -- a sanity check that the
// contract itself makes sense against the simplest possible provider (docs/specs/
// gke-sandbox-provider.md §6.2's "NoopProvider as a sanity check").

import { NoopProvider } from "../src/providers/noop.ts";
import { runProviderContract } from "@outfitter/provider-local/testing";
import type { ContractInstance, ContractWorld } from "@outfitter/provider-local/testing";

function makeNoopContract(): ContractInstance {
  const provider = new NoopProvider();
  const world: ContractWorld = {
    async received(handle) {
      // NoopProvider hands out "noop-1", "noop-2", ... in start() call order, one-to-one with
      // startCalls' index -- no separate correlation map needed.
      const match = /^noop-(\d+)$/.exec(handle);
      if (!match) return undefined;
      const call = provider.startCalls[Number(match[1]) - 1];
      if (!call) return undefined;
      return { runId: call.runId, runToken: call.runToken, apiOrigin: call.apiOrigin };
    },
    async exitByItself() {
      provider.nextStatus = "exited";
    },
  };
  return { provider, world };
}

runProviderContract("noop", makeNoopContract);
