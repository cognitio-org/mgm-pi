// Run lifecycle: `queued -> provisioning -> running <-> idle -> stopped | failed` (protocol.md
// "Run state machine"). wake() starts a provider execution for a session; stop() asks the provider
// to cancel; the reconciler marks runs failed once their lastSeenAt is stale, unless the provider
// still reports them as provisioning.

import { randomUUID } from "node:crypto";
import type { Store, Run } from "./store/types.ts";
import type { SandboxProvider } from "./providers/types.ts";
import type { Config } from "./config.ts";

const STALE_AFTER_MS = 90_000;
const RECONCILE_INTERVAL_MS = 60_000;

export class RunManager {
  private readonly store: Store;
  private readonly provider: SandboxProvider;
  private readonly config: Config;

  constructor(store: Store, provider: SandboxProvider, config: Config) {
    this.store = store;
    this.provider = provider;
    this.config = config;
  }

  /** Creates a run for the session and asks the provider to start it, unless one is already active. */
  async wake(sessionId: string): Promise<Run> {
    const existing = await this.store.runs.findActiveForSession(sessionId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      sessionId,
      state: "queued",
      lastAckedSeq: 0,
      pending: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.runs.insert(run);

    try {
      const { handle } = await this.provider.start({ runId: run.id, sessionId, apiOrigin: this.config.origin });
      return (
        (await this.store.runs.update(run.id, {
          state: "provisioning",
          providerHandle: handle,
          lastSeenAt: now,
          updatedAt: new Date().toISOString(),
        })) ?? run
      );
    } catch (err) {
      await this.store.runs.update(run.id, {
        state: "failed",
        reason: err instanceof Error ? err.message : String(err),
        updatedAt: new Date().toISOString(),
      });
      throw err;
    }
  }

  /** Asks the provider to stop the run's sandbox and marks the run stopped. */
  async stop(runId: string, reason = "user"): Promise<Run | null> {
    const run = await this.store.runs.findById(runId);
    if (!run) return null;
    if (run.providerHandle) {
      await this.provider.stop(run.providerHandle).catch(() => {
        // best-effort: the reconciler will clean up an unresponsive sandbox later
      });
    }
    return this.store.runs.update(runId, {
      state: "stopped",
      reason,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Starts the 60s reconciler loop; returns a function that stops it. */
  startReconciler(intervalMs = RECONCILE_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      this.reconcileOnce().catch(() => {
        // errors are transient (store/provider hiccup); next tick retries
      });
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Marks runs with no heartbeat/status for STALE_AFTER_MS as failed, unless still provisioning. */
  async reconcileOnce(staleAfterMs = STALE_AFTER_MS): Promise<void> {
    const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
    const stale = await this.store.runs.listStale(cutoff);
    for (const run of stale) {
      if (run.providerHandle) {
        const status = await this.provider.status(run.providerHandle).catch(() => ({ state: "unknown" as const }));
        if (status.state === "provisioning") continue;
      }
      await this.store.runs.update(run.id, {
        state: "failed",
        reason: "no heartbeat",
        updatedAt: new Date().toISOString(),
      });
    }
  }
}
