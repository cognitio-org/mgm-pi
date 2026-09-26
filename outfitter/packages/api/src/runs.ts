// Run lifecycle: `queued -> provisioning -> running <-> idle -> stopping -> stopped | failed`
// (protocol.md "Run state machine"). wake() starts a provider execution for a session; stop() asks
// the provider to cancel directly (used only when there's no live agent to ask gracefully, or once
// a graceful stop's grace period has expired); the reconciler marks runs failed once their
// lastSeenAt is stale, unless the provider still reports them as provisioning or the run is still
// within its provisioning grace window, stopping the provider execution first so a reconciled run
// doesn't leave an orphaned Job running. reconcileStoppingOnce separately cancels any run stuck in
// `stopping` (agentd never got, or never acted on, the graceful `stop` down-message) past
// config.stopGraceMs.

import { sandboxOrigin, type SandboxProviderName } from "./config.ts";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { Store, Run } from "./store/types.ts";
import type { SandboxProvider } from "@outfitter/provider-local";
import type { Config } from "./config.ts";
import { SandboxProviders } from "./providers/registry.ts";

const STALE_AFTER_MS = 90_000;
const RECONCILE_INTERVAL_MS = 60_000;

/** Which SandboxProvider started `run`; `run.providerHandle` is only meaningful to that one
 * (gke-sandbox-provider.md §2.4). Runs created before Run.sandboxProvider existed infer cloudrun
 * from the one handle shape that's unambiguously theirs (a Cloud Run execution resource name),
 * then fall back to the deployment's current default provider. */
export function providerNameFor(run: Run, fallback: SandboxProviderName): SandboxProviderName {
  if (run.sandboxProvider) return run.sandboxProvider;
  if (run.providerHandle?.startsWith("projects/")) return "cloudrun";
  return fallback;
}

export class RunManager {
  private readonly store: Store;
  private readonly providers: SandboxProviders;
  private readonly config: Config;
  /** providerNameFor() names logged once each (not per reconcile tick) when their registry lookup
   * fails -- see resolveProvider. */
  private readonly warnedUnconfiguredProviders = new Set<string>();

  /** Accepts either the registry (SandboxProviders) or, for source compatibility with existing
   * callers/tests that only ever had one provider (server.ts, most of test/*.test.ts), a bare
   * SandboxProvider -- wrapped as the registry's sole, default entry. */
  constructor(store: Store, provider: SandboxProvider | SandboxProviders, config: Config) {
    this.store = store;
    this.providers =
      provider instanceof SandboxProviders ? provider : SandboxProviders.single(config.sandboxProvider, provider);
    this.config = config;
  }

  /** Resolves the SandboxProvider that started `run` through the registry. Returns undefined
   * (rather than throwing) when that provider is no longer configured here -- e.g. a
   * SANDBOX_PROVIDER switch left old runs behind -- logging it once per provider name instead of
   * once per reconcile tick. Callers skip the provider call and still apply their own state
   * change, the same best-effort semantics this already had for a provider call that itself fails. */
  private async resolveProvider(run: Run): Promise<SandboxProvider | undefined> {
    const name = providerNameFor(run, this.config.sandboxProvider);
    try {
      return await this.providers.get(name);
    } catch (err) {
      if (!this.warnedUnconfiguredProviders.has(name)) {
        this.warnedUnconfiguredProviders.add(name);
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            message: `sandbox provider "${name}" is not configured here; skipping provider calls for its runs`,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return undefined;
    }
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
      // startup.ts: the rest of Run.startup is stamped as the run gets further.
      startup: { wakeAt: now, provider: this.config.sandboxProvider },
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
      const provider = await this.providers.get(this.config.sandboxProvider);
      const { handle, warm } = await provider.start({
        runId: run.id,
        apiOrigin: sandboxOrigin(this.config),
        runToken,
        // devToken is the SANDBOX_PROVIDER=inprocess/docker auth bypass (see @outfitter/
        // provider-local's RunLaunch doc); cloudrun/gke ignore it, and the sandbox authenticates
        // with its own metadata-server identity token instead.
        devToken: this.config.devMode ? this.config.devToken : undefined,
      });
      const providerReturnedAt = new Date().toISOString();
      const updated = await this.store.runs.update(run.id, {
        state: "provisioning",
        providerHandle: handle,
        sandboxProvider: this.config.sandboxProvider,
        runTokenHash,
        lastSeenAt: now,
        updatedAt: new Date().toISOString(),
      });
      // After the update above, not before: runTokenHash must land as soon as possible, since a fast
      // hello that arrives before it is refused 4401 for good. Its own write, not part of that
      // update: agentd may already have said hello (link role, another process) and stamped
      // startup.helloAt, which a whole-object write would lose. Best-effort: timing never fails a
      // run whose sandbox did start.
      const stamped = await this.store.runs
        .mergeStartup(run.id, { providerReturnedAt, ...(typeof warm === "boolean" ? { warm } : {}) })
        .catch(() => null);
      return stamped ?? updated ?? run;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A provider's error message occasionally already ends in its own "." (or "..." etc.); strip
      // any trailing dots before appending ours so statusDetail doesn't read "...reached.. Press Play".
      const messageForDetail = message.replace(/\.+$/, "");
      await this.store.runs.update(run.id, {
        state: "failed",
        reason: message,
        // #54's convention (store/types.ts's Run.statusDetail doc): a start refusal is one of the
        // few things a person sees for a run that never got as far as connecting, so it gets a
        // full sentence with a remedy, not just the short `reason` that also goes on the wire.
        statusDetail: `this run's sandbox failed to start: ${messageForDetail}. Press Play to start a new one.`,
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
      const provider = await this.resolveProvider(run);
      await provider?.stop(run.providerHandle).catch(() => {
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
        const provider = await this.resolveProvider(run);
        if (provider) {
          const status = await provider.status(run.providerHandle).catch(() => "unknown" as const);
          if (status === "starting") continue;
          await provider.stop(run.providerHandle).catch(() => {
            // best effort: still mark the run failed below even if the provider stop call itself fails
          });
        }
        // provider undefined (no longer configured): skip the provider call and fall through to
        // marking the run failed below anyway -- the same best-effort semantics as a provider
        // call that itself fails, per gke-sandbox-provider-plan.md §5 item 6.
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
        const provider = await this.resolveProvider(run);
        await provider?.stop(run.providerHandle).catch(() => {
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
