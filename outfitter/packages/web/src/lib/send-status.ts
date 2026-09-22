// Cloud-fixes 11: what the session page shows between pressing Send and the reply arriving. Before
// this, nothing visibly happened after Send until a reply appeared -- a cold start (waking a drive)
// takes about a minute, so the page looked broken.
//
// Everything the page shows about "is this floppy doing something" derives from one call to
// deriveSessionActivity: the status line beside the composer, the optimistic user entry, the run
// pill, Play/Stop/RUN-STOP, and the composer's disabled state. They can't disagree because none of
// them look at runState on their own any more.

import type { PiEntry } from "../api/client.ts";

/** Waking a drive (a Cloud Run Job cold start) normally takes about a minute. */
export const WAKE_TIMEOUT_MS = 3 * 60_000;
/** A running turn that produces no entry and no status change for this long is presumed stuck. */
export const WORK_TIMEOUT_MS = 2 * 60_000;

/** Run states with a live run behind them (the Stop button's domain). */
export const LIVE_RUN_STATES: ReadonlySet<string> = new Set(["queued", "provisioning", "running", "idle", "stopping"]);

/** The message the user just sent, held client-side until the stored entry for it arrives. */
export interface PendingSend {
  /** Client-side id for the optimistic transcript row. */
  localId: string;
  text: string;
  behavior?: "steer" | "followUp";
  sentAt: number;
  /** When the API accepted (stored) the message; unset while the POST is in flight. */
  acceptedAt?: number;
  /** The POST failed: the message was never stored. */
  error?: string;
  /** entries.length when Send was pressed -- only entries after this can be the echo or reply. */
  baseline: number;
  /** The run state when Send was pressed. */
  runStateAtSend?: string;
  /** Some run state other than runStateAtSend has been seen since -- so a "failed"/"stopped" now
   * is about this send, not left over from before it. */
  sawChange: boolean;
  /** "running" has been seen since the send: a later "idle" means the turn finished. */
  sawRunning: boolean;
}

export type ActivityPhase =
  | "none"
  /** POST /messages in flight. */
  | "sending"
  /** Accepted, no live run yet: a drive is being provisioned. */
  | "waking"
  /** A run is working on it. */
  | "working"
  /** The POST failed. Retry re-sends. */
  | "sendFailed"
  /** No run came up within WAKE_TIMEOUT_MS (or it failed before running). Retry re-wakes. */
  | "wakeTimeout"
  /** A running turn went quiet for WORK_TIMEOUT_MS (or the run failed mid-turn). Retry re-sends. */
  | "workTimeout";

export interface ActivityInput {
  runState?: string;
  runStateReason?: string;
  entries: PiEntry[];
  pending: PendingSend | null;
  now: number;
  /** When the page last saw progress: a new entry or a run state change (ms). */
  lastProgressAt: number;
  /** A header button's own request is in flight. */
  pendingAction?: "abort" | "stop" | "wake" | null;
}

export interface SessionActivity {
  phase: ActivityPhase;
  /** Status-line text beside the composer, or null when there's nothing to say. */
  label: string | null;
  /** Retro error headline for the two timeouts and a failed send. */
  errorHeadline: string | null;
  /** Show the optimistic user row (the stored entry hasn't arrived yet). */
  showOptimistic: boolean;
  /** The state the run pill shows. */
  pillState?: string;
  canWake: boolean;
  canStop: boolean;
  canAbort: boolean;
  composerDisabled: boolean;
}

function userText(e: PiEntry): string | null {
  if (e.type !== "message") return null;
  const m = e.message as { role?: string; content?: unknown } | undefined;
  if (m?.role !== "user") return null;
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .filter((c): c is { type: string; text: string } => (c as { type?: string })?.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function isAssistant(e: PiEntry): boolean {
  return e.type === "message" && (e.message as { role?: string } | undefined)?.role === "assistant";
}

/** Index (into entries) of the stored entry that echoes the pending message, or -1: the first user
 * entry after the baseline with the same text, else the first user entry after it at all (pi may
 * normalise whitespace). */
export function findEcho(entries: PiEntry[], pending: Pick<PendingSend, "text" | "baseline">): number {
  const want = pending.text.trim();
  let firstUser = -1;
  for (let i = pending.baseline; i < entries.length; i++) {
    const t = userText(entries[i]);
    if (t === null) continue;
    if (t.trim() === want) return i;
    if (firstUser < 0) firstUser = i;
  }
  return firstUser;
}

/** Whether the pending message is finished with: its reply arrived, or the run went back to idle
 * after running (the reply entry can trail the status frame by a poll). */
export function isAnswered(input: Pick<ActivityInput, "entries" | "runState">, pending: PendingSend): boolean {
  if (pending.acceptedAt === undefined || pending.error !== undefined) return false;
  const echo = findEcho(input.entries, pending);
  const from = echo >= 0 ? echo + 1 : pending.baseline;
  for (let i = from; i < input.entries.length; i++) if (isAssistant(input.entries[i])) return true;
  return input.runState === "idle" && pending.sawRunning;
}

export function deriveSessionActivity(input: ActivityInput): SessionActivity {
  const { runState, pending } = input;
  const live = runState !== undefined && LIVE_RUN_STATES.has(runState);
  const phase = derivePhase(input);
  const busyButton = Boolean(input.pendingAction);
  const stopping = runState === "stopping";

  return {
    phase,
    label: phaseLabel(phase),
    errorHeadline: phaseError(phase),
    showOptimistic: pending !== null && (pending.error !== undefined || (findEcho(input.entries, pending) < 0 && phase !== "none")),
    // Once a send is accepted with no live run, a drive is being woken even before the first
    // status frame says so -- the pill mustn't still read "stopped"/"failed" then.
    pillState: phase === "waking" && !live ? "queued" : runState,
    canWake: !live && phase !== "sending" && phase !== "waking" && !busyButton,
    canStop: live && !stopping && !busyButton,
    canAbort: live && !stopping && !busyButton,
    composerDisabled: phase === "sending" || busyButton,
  };
}

function derivePhase({ runState, pending, now, lastProgressAt, entries }: ActivityInput): ActivityPhase {
  const quiet = (since: number) => now - since > WORK_TIMEOUT_MS;
  if (pending) {
    if (pending.error !== undefined) return "sendFailed";
    if (pending.acceptedAt === undefined) return "sending";
    if (isAnswered({ entries, runState }, pending)) return "none";
    const since = Math.max(pending.acceptedAt, lastProgressAt);
    // idle-but-not-yet-running: the mail is on its way to the run, so it counts as working.
    if (runState === "running" || runState === "idle" || runState === "stopping") return quiet(since) ? "workTimeout" : "working";
    const ended = runState === "failed" || runState === "stopped" || runState === undefined;
    if (ended && pending.sawChange) return pending.sawRunning ? "workTimeout" : "wakeTimeout";
    // queued/provisioning, or a stale ended state from before the send: a drive is waking.
    return now - pending.acceptedAt > WAKE_TIMEOUT_MS ? "wakeTimeout" : "waking";
  }
  // No send of ours in flight: the page was reloaded mid-wait, or a run was started elsewhere.
  if (runState === "queued" || runState === "provisioning") return now - lastProgressAt > WAKE_TIMEOUT_MS ? "wakeTimeout" : "waking";
  if (runState === "running") return quiet(lastProgressAt) ? "workTimeout" : "working";
  return "none";
}

export function phaseLabel(phase: ActivityPhase): string | null {
  switch (phase) {
    case "sending":
      return "Sending…";
    case "waking":
      return "Waking a drive, about a minute";
    case "working":
      return "Working…";
    case "sendFailed":
      return "message not sent";
    case "wakeTimeout":
      return "the drive didn't come up";
    case "workTimeout":
      return "no progress for 2 minutes";
    case "none":
      return null;
  }
}

function phaseError(phase: ActivityPhase): string | null {
  if (phase === "wakeTimeout") return "?DEVICE NOT PRESENT ERROR";
  if (phase === "workTimeout" || phase === "sendFailed") return "LOAD ERROR";
  return null;
}

/** Folds a new run state into the pending send's sawChange/sawRunning flags. */
export function notePendingRunState(pending: PendingSend | null, runState: string | undefined): PendingSend | null {
  if (!pending || pending.acceptedAt === undefined) return pending;
  const sawChange = pending.sawChange || runState !== pending.runStateAtSend;
  const sawRunning = pending.sawRunning || runState === "running";
  if (sawChange === pending.sawChange && sawRunning === pending.sawRunning) return pending;
  return { ...pending, sawChange, sawRunning };
}
