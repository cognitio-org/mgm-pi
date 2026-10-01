// E9 §1 turn-settled signal (docs/specs/atlas-agent-engine-and-a2a.md; EPIC.md E5.2's three
// completion layers, built here without the delegate tool so A2A tasks, E5.2 and E5.6 share them).
//
// A turn waiter waits for the turn one mail starts. It finishes exactly once:
//   1. settled -- the first `agent_settled` after pi accepted its mail. agentd flushes its entry
//      tailer before forwarding the settle (protocol.md), so the turn's entries are stored first.
//      Acceptance is pi's RPC `response` to `mail:<id>`, read off the same seq stream as the settle,
//      so the two can't arrive out of order the way the unsequenced `mail.ack` frame could.
//   2. ended -- the run that accepted the mail reached stopped/failed first, or the mail can't reach
//      a run (dead, held).
//   3. ended at the deadline -- `deadlineAt` (default 60 min), swept by /api/hooks/tick, pushed out
//      while the run is working and capped at 4 h; at expiry the run is stopped first.
// Run state `idle` is never completion: agentd is idle before its first prompt.
//
// The store is the truth (several Cloud Run instances: the settle reaches whichever holds the
// socket). The in-process listeners are only a fast path for a caller on the same instance.

import { randomUUID } from "node:crypto";
import type { Mail, Run, Store, TurnWaiter, TurnWaiterFinish } from "./store/types.ts";

/** Layer 3's starting deadline. */
export const TURN_WAITER_DEADLINE_MS = 60 * 60_000;
/** Hard cap on a waiter's life, extensions included. */
export const TURN_WAITER_CAP_MS = 4 * 60 * 60_000;
/** The sweep extends an expired deadline while the run has shown activity this recently. */
export const TURN_WAITER_ACTIVITY_MS = 10 * 60_000;
/** Open waiters looked at per sweep, oldest first. */
const SWEEP_LIMIT = 500;

export interface RegisterTurnWaiter {
  sessionId: string;
  /** The mail whose turn to wait for. Choose the id (MailService.post's `id`), register, then
   * post, so its acceptance can't be missed; registering later still works, from the mail's own
   * acked state, but a turn that already settled by then is only caught when the session's
   * `settledAt` is after the mail's `ackedAt`. */
  mailId: string;
  /** Who is waiting ("a2a", "delegate", ...), stored as-is. */
  owner?: string;
  /** Overrides TURN_WAITER_DEADLINE_MS; clamped to the 4 h cap. */
  deadlineMs?: number;
}

export interface TurnSweepResult {
  settled: number;
  ended: number;
  extended: number;
}

type SettledListener = (sessionId: string, lastEntryId: string | undefined) => void;
type FinishedListener = (waiter: TurnWaiter) => void;

/** The one RunManager call the deadline needs. */
export interface TurnRunStopper {
  stop(runId: string, reason?: string): Promise<Run | null>;
}

function isTerminal(run: Run): boolean {
  return run.state === "stopped" || run.state === "failed";
}

export class TurnWaiters {
  private readonly settledListeners = new Set<SettledListener>();
  private readonly finishedListeners = new Set<FinishedListener>();
  private readonly store: Store;
  private readonly runs: TurnRunStopper;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly now: () => number;

  constructor(store: Store, runs: TurnRunStopper, log: (msg: string, err?: unknown) => void = () => {}, now: () => number = Date.now) {
    this.store = store;
    this.runs = runs;
    this.log = log;
    this.now = now;
  }

  /** Opens a waiter for the turn `mailId` starts. */
  async register(input: RegisterTurnWaiter): Promise<TurnWaiter> {
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const capAt = now + TURN_WAITER_CAP_MS;
    const deadlineMs = Math.max(0, input.deadlineMs ?? TURN_WAITER_DEADLINE_MS);
    const waiter: TurnWaiter = {
      id: randomUUID(),
      sessionId: input.sessionId,
      mailId: input.mailId,
      ...(input.owner ? { owner: input.owner } : {}),
      status: "open",
      createdAt: nowIso,
      updatedAt: nowIso,
      deadlineAt: new Date(Math.min(now + deadlineMs, capAt)).toISOString(),
      capAt: new Date(capAt).toISOString(),
    };
    await this.store.turnWaiters.insert(waiter);
    const mail = await this.store.mail.findById(waiter.mailId);
    return (mail ? await this.adoptMailAck(waiter, mail) : null) ?? waiter;
  }

  async get(id: string): Promise<TurnWaiter | null> {
    return this.store.turnWaiters.findById(id);
  }

  /** Ends an open waiter as `canceled`. Null when it had already finished (left as it was). */
  async cancel(id: string, detail?: string): Promise<TurnWaiter | null> {
    return this.finish(id, { status: "ended", endReason: "canceled", ...(detail ? { detail } : {}) });
  }

  /** In-process: every settle this instance records. Returns an unsubscribe. */
  onSettled(listener: SettledListener): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  /** In-process: every waiter this instance finishes, however it finished. Returns an
   * unsubscribe. A waiter finished on another instance only shows in the store. */
  onFinished(listener: FinishedListener): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  /** agentlink: pi's `response` to `mail:<mailId>` came back `success: true`, as seq `seq`. */
  async noteMailAccepted(sessionId: string, runId: string, mailId: string, seq: number): Promise<void> {
    await this.store.turnWaiters.markAcked(sessionId, mailId, runId, seq, this.nowIso());
  }

  /** agentlink: an `agent_settled` event, seq `seq`, from `runId`. Records it on the session,
   * completes the waiters whose mail this run accepted earlier in its stream, then tells the
   * in-process listeners. */
  async noteSettled(sessionId: string, runId: string, seq: number, lastEntryId?: string): Promise<void> {
    const nowIso = this.nowIso();
    await this.store.sessions.update(sessionId, { settledAt: nowIso, ...(lastEntryId ? { settledEntryId: lastEntryId } : {}) });
    for (const waiter of await this.store.turnWaiters.listOpenForSession(sessionId)) {
      if (waiter.ackRunId !== runId || waiter.ackSeq === undefined || waiter.ackSeq >= seq) continue;
      await this.finish(waiter.id, { status: "settled", ...(lastEntryId ? { settledEntryId: lastEntryId } : {}) });
    }
    for (const listener of this.settledListeners) {
      try {
        listener(sessionId, lastEntryId);
      } catch (err) {
        this.log("turn settled listener threw", err);
      }
    }
  }

  /** Layer 2, prompt path: `runId` just reached stopped/failed (agentlink's `bye`). The tick sweep
   * catches every other way a run ends. */
  async noteRunEnded(runId: string): Promise<void> {
    const run = await this.store.runs.findById(runId);
    if (!run || !isTerminal(run)) return;
    for (const waiter of await this.store.turnWaiters.listOpenForSession(run.sessionId)) {
      if (waiter.ackRunId === runId) await this.endForRun(waiter, run);
    }
  }

  /** /api/hooks/tick: layer 2 for runs that ended without a bye, mail that can't be delivered,
   * acceptance the stream missed, and layer 3's deadlines. */
  async sweep(): Promise<TurnSweepResult> {
    const result: TurnSweepResult = { settled: 0, ended: 0, extended: 0 };
    for (const open of await this.store.turnWaiters.listOpen(SWEEP_LIMIT)) {
      try {
        await this.sweepOne(open, result);
      } catch (err) {
        this.log(`turn waiter ${open.id}: sweep failed`, err);
      }
    }
    return result;
  }

  private async sweepOne(open: TurnWaiter, result: TurnSweepResult): Promise<void> {
    let waiter = open;
    if (waiter.ackRunId === undefined) {
      // No mail yet is not dead mail: the caller registers before posting. Layer 3 ends a waiter
      // whose mail never appears.
      const mail = await this.store.mail.findById(waiter.mailId);
      if (mail?.status === "dead") {
        if (await this.finish(waiter.id, { status: "ended", endReason: "mail_dead", detail: "the message could not be delivered" })) result.ended++;
        return;
      }
      if (mail?.status === "held") {
        const detail = mail.heldDetail ?? "the message is held: this floppy's drives keep failing to start";
        if (await this.finish(waiter.id, { status: "ended", endReason: "mail_held", detail })) result.ended++;
        return;
      }
      const caughtUp = mail ? await this.adoptMailAck(waiter, mail) : null;
      if (caughtUp && caughtUp.status !== "open") {
        result.settled++;
        return;
      }
      waiter = caughtUp ?? waiter;
    }

    const run = waiter.ackRunId
      ? await this.store.runs.findById(waiter.ackRunId)
      : await this.store.runs.findActiveForSession(waiter.sessionId);
    if (waiter.ackRunId && (!run || isTerminal(run))) {
      if (await this.endForRun(waiter, run)) result.ended++;
      return;
    }

    const now = this.now();
    if (Date.parse(waiter.deadlineAt) > now) return;
    const capAt = Date.parse(waiter.capAt);
    if (now < capAt && run && (run.state === "provisioning" || run.state === "running")) {
      const activeAt = Date.parse(run.lastActivityAt ?? (run.state === "provisioning" ? run.createdAt : "")) || 0;
      if (now - activeAt < TURN_WAITER_ACTIVITY_MS) {
        const deadlineAt = new Date(Math.min(activeAt + TURN_WAITER_ACTIVITY_MS, capAt)).toISOString();
        if (await this.store.turnWaiters.extendDeadline(waiter.id, deadlineAt, this.nowIso())) result.extended++;
        return;
      }
    }
    // Expired. Stop the run first, so nothing the waiter's caller reports as given up keeps
    // running (and billing); then end the waiter.
    if (run && !isTerminal(run)) await this.runs.stop(run.id, "deadline");
    const detail =
      now >= capAt
        ? "the turn ran past the 4 hour limit"
        : waiter.ackRunId
          ? "the turn made no progress before its deadline"
          : "the message was not picked up before its deadline";
    if (await this.finish(waiter.id, { status: "ended", endReason: "deadline", detail })) result.ended++;
  }

  /** The mail was accepted without this waiter seeing pi's `response` (it was registered after,
   * or the event was lost): take the acceptance from the mail itself, as seq 0 of the run it was
   * delivered to, so any settle of that run after now completes it. If the session already
   * settled after the mail was acked, the turn is done: settle the waiter now. Returns the waiter
   * as it now is, or null when the mail isn't acked. */
  private async adoptMailAck(waiter: TurnWaiter, mail: Mail): Promise<TurnWaiter | null> {
    if (mail.sessionId !== waiter.sessionId || mail.status !== "acked" || !mail.deliveredRunId || !mail.ackedAt) {
      return null;
    }
    await this.store.turnWaiters.markAcked(waiter.sessionId, waiter.mailId, mail.deliveredRunId, 0, this.nowIso());
    const session = await this.store.sessions.findById(waiter.sessionId);
    if (session?.settledAt && session.settledAt >= mail.ackedAt) {
      const settled = await this.finish(waiter.id, {
        status: "settled",
        ...(session.settledEntryId ? { settledEntryId: session.settledEntryId } : {}),
      });
      if (settled) return settled;
    }
    return this.store.turnWaiters.findById(waiter.id);
  }

  private async endForRun(waiter: TurnWaiter, run: Run | null): Promise<TurnWaiter | null> {
    const failed = run?.state === "failed";
    const detail = run?.statusDetail ?? run?.reason ?? "the run is gone";
    return this.finish(waiter.id, { status: "ended", endReason: failed ? "run_failed" : "run_stopped", detail });
  }

  /** The store's conditional finish (never overwrites a finished waiter), then the listeners. */
  private async finish(id: string, outcome: TurnWaiterFinish): Promise<TurnWaiter | null> {
    const finished = await this.store.turnWaiters.finish(id, outcome, this.nowIso());
    if (!finished) return null;
    for (const listener of this.finishedListeners) {
      try {
        listener(finished);
      } catch (err) {
        this.log("turn finished listener threw", err);
      }
    }
    return finished;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}
