// SandboxProvider: starts/stops/checks the compute that runs agentd for one run.
//
// This shape is intentionally the same one the concurrently-built provider-local package uses
// (`start(run) -> {handle}`, `stop(handle)`, `status(handle)`). It is copied here rather than
// imported so this package has no build-order dependency on provider-local; unify the two once
// both are stable (see EPIC.md E1.3).

export interface RunStartInput {
  runId: string;
  sessionId: string;
  /** Origin agentd should dial back to (OUTFITTER_API env for the sandbox). */
  apiOrigin: string;
}

export type ProviderState = "provisioning" | "running" | "stopped" | "unknown";

export interface ProviderStatus {
  state: ProviderState;
  detail?: string;
}

export interface SandboxProvider {
  start(run: RunStartInput): Promise<{ handle: unknown }>;
  stop(handle: unknown): Promise<void>;
  status(handle: unknown): Promise<ProviderStatus>;
}
