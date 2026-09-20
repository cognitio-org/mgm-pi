// Test double: records every call instead of starting real compute.

import type { SandboxProvider, RunLaunch, SandboxStatus, SandboxHandle } from "@outfitter/provider-local";

export class NoopProvider implements SandboxProvider {
  readonly startCalls: RunLaunch[] = [];
  readonly stopCalls: SandboxHandle[] = [];
  readonly statusCalls: SandboxHandle[] = [];
  private nextId = 1;
  /** Overridable per test; defaults to reporting the sandbox as running. */
  nextStatus: SandboxStatus = "running";

  async start(run: RunLaunch): Promise<{ handle: SandboxHandle }> {
    this.startCalls.push(run);
    return { handle: `noop-${this.nextId++}` };
  }

  async stop(handle: SandboxHandle): Promise<void> {
    this.stopCalls.push(handle);
  }

  async status(handle: SandboxHandle): Promise<SandboxStatus> {
    this.statusCalls.push(handle);
    return this.nextStatus;
  }
}
