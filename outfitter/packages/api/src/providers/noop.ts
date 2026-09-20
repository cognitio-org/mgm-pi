// Test double: records every call instead of starting real compute.

import type { SandboxProvider, RunStartInput, ProviderStatus } from "./types.ts";

export class NoopProvider implements SandboxProvider {
  readonly startCalls: RunStartInput[] = [];
  readonly stopCalls: unknown[] = [];
  readonly statusCalls: unknown[] = [];
  /** Overridable per test; defaults to reporting the sandbox as running. */
  nextStatus: ProviderStatus = { state: "running" };

  async start(run: RunStartInput): Promise<{ handle: unknown }> {
    this.startCalls.push(run);
    return { handle: { runId: run.runId } };
  }

  async stop(handle: unknown): Promise<void> {
    this.stopCalls.push(handle);
  }

  async status(handle: unknown): Promise<ProviderStatus> {
    this.statusCalls.push(handle);
    return this.nextStatus;
  }
}
