// Run lifecycle: `queued -> provisioning -> running <-> idle -> stopping -> stopped | failed`
// (protocol.md "Run state machine"). wake() starts a provider execution for a session; stop() asks
// the provider to cancel directly (used only when there's no live agent to ask gracefully, or once
// a graceful stop's grace period has expired); the reconciler marks runs failed once their
// lastSeenAt is stale, unless the provider still reports them as provisioning or the run is still
// within its provisioning grace window, stopping the provider execution first so a reconciled run
// doesn't leave an orphaned Job running. reconcileStoppingOnce separately cancels any run stuck in
// `stopping` (agentd never got, or never acted on, the graceful `stop` down-message) past
// config.stopGraceMs.

import { sandboxOrigin } from "./config.ts";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { Store, Run } from "./store/types.ts";
import type { SandboxProvider } from "@outfitter/provider-local";
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

  /** Creates a run for the session and asks the provider to start it, unless one is already active.
   * `mailDriven` (bug 10, docs/reports/cloud-fixes.md): set by MailService.wakeForMail so
   * agentlink.ts's handleConnection knows this specific run exists to deliver mail and should
   * charge the mail's attempt once (and only once) its hello actually validates -- see
   * store/types.ts's Run.mailWakePending doc comment for why that's a separate flag from
   * Run.protocolAcked. */
  async wake(sessionId: string, opts: { mailDriven?: boolean } = {}): Promise<Run> {
    const existing = await this.store.runs.findActiveForSession(sessionId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const candidate: Run = {
      id: randomUUID(),
      sessionId,
      state: "queued",
      lastAckedSeq: 0,
      pending: [],
      createdAt: now,
      updatedAt: now,
      ...(opts.mailDriven ? { mailWakePending: true } : {}),
    };
    const { run, inserted } = await this.store.runs.insertIfNoActive(candidate);
    if (!inserted) return run;

    // Finding #2 (docs/reports/security-review-pr1.md): every sandbox execution shares one agent
    // SA identity, so a valid agent id token alone doesn't prove the caller is *this* run's own
    // execution. runToken is a per-run secret handed to the provider (RUN_TOKEN env) and never
    // stored itself -- only its sha256 hash lands on the Run record, for AgentLink.handleConnection
    // to compare against what the real agentd sends back in its `hello` frame.
    const runToken = randomBytes(32).toString("hex");
    const runTokenHash = createHash("sha256").update(runToken).digest("hex");

    try {
      const { handle } = await this.provider.start({
        runId: run.id,
        apiOrigin: sandboxOrigin(this.config),
        runToken,
        // devToken is the SANDBOX_PROVIDER=inprocess/docker auth bypass (see @outfitter/
        // provider-local's RunLaunch doc); cloudrun ignores it, and the sandbox authenticates
        // with the job's own metadata-server identity token instead.
        devToken: this.config.devMode ? this.config.devToken : undefined,
      });
      return (
        (await this.store.runs.update(run.id, {
          state: "provisioning",
          providerHandle: handle,
          runTokenHash,
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

  /** Starts the 60s reconciler loop (stale-run failure and stuck-stopping cancellation); returns a
   * function that stops it. */
  startReconciler(intervalMs = RECONCILE_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      this.reconcileOnce().catch(() => {
        // errors are transient (store/provider hiccup); next tick retries
      });
      this.reconcileStoppingOnce().catch(() => {
        // errors are transient (store/provider hiccup); next tick retries
      });
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Marks runs with no heartbeat/status for STALE_AFTER_MS as failed, unless still provisioning.
   * A run younger than config.provisioningGraceMs is skipped outright (a cold Cloud Run Job start
   * can outlast STALE_AFTER_MS with no heartbeat yet, and that's not a failure). Before marking a
   * run failed, best-effort stops its provider handle first so a reconciled run's Job execution
   * doesn't keep running as an orphan after the run is marked dead.
   */
  async reconcileOnce(staleAfterMs = STALE_AFTER_MS): Promise<void> {
    const now = Date.now();
    const cutoff = new Date(now - staleAfterMs).toISOString();
    const stale = await this.store.runs.listStale(cutoff);
    for (const run of stale) {
      const ageMs = now - new Date(run.createdAt).getTime();
      if (ageMs < this.config.provisioningGraceMs) continue;

      if (run.providerHandle) {
        const status = await this.provider.status(run.providerHandle).catch(() => "unknown" as const);
        if (status === "starting") continue;
        await this.provider.stop(run.providerHandle).catch(() => {
          // best effort: still mark the run failed below even if the provider stop call itself fails
        });
      }
      await this.store.runs.update(run.id, {
        state: "failed",
        reason: "no heartbeat",
        // "no heartbeat" is the whole of what the session page used to show for this ("LOAD ERROR
        // — No heartbeat"), and it named neither a cause nor anything to do about it. statusDetail
        // is the field the page renders in full (packages/web SessionPage, agentlink.ts's
        // refuse()), so spend it on the three things that actually produce a silent sandbox --
        // including a connection the api itself refused before it could prove which run it was
        // (agentlink.ts's run-token check, which deliberately writes nothing on the run).
        statusDetail:
          "this run's sandbox stopped reporting to the api, so the api gave up on it. It may have " +
          "failed to start, been refused when it tried to connect (the server log for this run id " +
          "says why), or died mid-run. Press Play to start a new one.",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Cancels any run still `stopping` whose graceful stop (routes/sessions.ts's `/stop` enqueues a
   * `stop` down-message and sets `stopping`; agentlink.ts's `bye` handler is what normally finishes
   * the job by marking it `stopped`) hasn't completed within `graceMs` of entering that state --
   * agentd never got the down-message (e.g. its socket died before the queue poller could deliver
   * it), or got it but never sent `bye`. Best-effort provider cancel first, same as reconcileOnce,
   * so a stuck run doesn't leave an orphaned sandbox behind.
   */
  async reconcileStoppingOnce(graceMs = this.config.stopGraceMs): Promise<void> {
    const cutoff = new Date(Date.now() - graceMs).toISOString();
    const stuck = await this.store.runs.listStopping(cutoff);
    for (const run of stuck) {
      if (run.providerHandle) {
        await this.provider.stop(run.providerHandle).catch(() => {
          // best effort: still mark the run stopped below even if the provider stop call itself fails
        });
      }
      await this.store.runs.update(run.id, {
        state: "stopped",
        reason: "stop grace expired",
        updatedAt: new Date().toISOString(),
      });
    }
  }
}
