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
/** A running turn with no progress (entry, status change, or pi activity) for this long is quiet.
 * Quiet is only an error once agentd has gone silent too (AGENT_SILENT_MS), or when the page
 * can't tell (an api without `liveness`). A long LLM call or test run is quiet, not stuck (#182).
 * So is a pi that hung while agentd keeps heartbeating: the page can't tell those apart, which is
 * why the quiet label counts the minutes and Break stays available. */
export const WORK_TIMEOUT_MS = 2 * 60_000;
/** agentd heartbeats every 15 s; this is four missed, the same allowance the api gives a silent
 * socket (config.agentSocketGraceMs). */
export const AGENT_SILENT_MS = 60_000;

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
  /** Earlier sends not yet stored when this one was pressed (a quick second message). Their user
   * entries arrive first, after the same baseline, so the echo search skips that many. */
  skipUsers?: number;
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
  /** Running, nothing new for WORK_TIMEOUT_MS, but agentd is still heartbeating: a long step. */
  | "quiet"
  /** The POST failed. Retry re-sends. */
  | "sendFailed"
  /** No run came up within WAKE_TIMEOUT_MS (or it failed before running). Retry re-wakes. */
  | "wakeTimeout"
  /** A running turn went quiet for WORK_TIMEOUT_MS with agentd silent too, or unknown (or the run
   * failed mid-turn). Retry re-sends. */
  | "workTimeout";

export interface ActivityInput {
  runState?: string;
  runStateReason?: string;
  entries: PiEntry[];
  pending: PendingSend | null;
  now: number;
  /** When the page last saw progress: a new entry, a run state change, or pi activity (ms). */
  lastProgressAt: number;
  /** When agentd last spoke, heartbeats included (useSessionStream's agentSeenAt). Undefined when
   * the api hasn't said -- then a quiet turn is treated as stuck, as before liveness existed. */
  agentSeenAt?: number;
  /** When pi last wrote an entry or streamed an event (useSessionStream's piActiveAt). Only the
   * quiet label uses it: lastProgressAt restarts on page load, pi's own time doesn't. */
  piActiveAt?: number;
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

/** An assistant entry that ends the turn. Not one that stopped to call tools (stopReason "toolUse"),
 * is still streaming ("pending"), or failed and is being retried (see below): in a tool-using turn that is the *first* assistant entry, and
 * the run keeps working for minutes after it -- counting it as the reply dropped the status line
 * (and the work timeout) right at the start of the long part of the turn. */
export function isFinalAssistant(e: PiEntry, later: PiEntry[] = []): boolean {
  if (e.type !== "message") return false;
  const m = e.message as { role?: string; stopReason?: string } | undefined;
  if (m?.role !== "assistant" || m.stopReason === "toolUse" || m.stopReason === "pending") return false;
  // A failed attempt pi is retrying: it hides the attempt from the model (a context_edit) first.
  // Counting it as the reply dropped the status line for the whole retry.
  if (m.stopReason === "error" && later.some((x) => x.type === "context_edit" && x.targetId === e.id && x.replacement == null)) return false;
  return true;
}

/** Index (into entries) of the stored entry that echoes the pending message, or -1: the first user
 * entry after the baseline with the same text, else the first user entry after it at all (pi may
 * normalise whitespace). */
export function findEcho(entries: PiEntry[], pending: Pick<PendingSend, "text" | "baseline" | "skipUsers">): number {
  const want = pending.text.trim();
  let skip = pending.skipUsers ?? 0;
  let firstUser = -1;
  for (let i = pending.baseline; i < entries.length; i++) {
    const t = userText(entries[i]);
    if (t === null) continue;
    if (skip > 0) {
      skip--;
      continue;
    }
    if (t.trim() === want) return i;
    if (firstUser < 0) firstUser = i;
  }
  return firstUser;
}

/** The baseline/skip for a new send, given the send still pending (if any): a quick second message
 * inherits the earlier send's baseline and skips its not-yet-stored echo. */
export function nextSendAnchor(
  entries: PiEntry[],
  previous: PendingSend | null,
): Pick<PendingSend, "baseline" | "skipUsers"> {
  if (previous && previous.error === undefined && findEcho(entries, previous) < 0) {
    return { baseline: previous.baseline, skipUsers: (previous.skipUsers ?? 0) + 1 };
  }
  return { baseline: entries.length, skipUsers: 0 };
}

/** Whether the pending message is finished with: its reply arrived, or the run went back to idle
 * after running (the reply entry can trail the status frame by a poll). */
export function isAnswered(input: Pick<ActivityInput, "entries" | "runState">, pending: PendingSend): boolean {
  if (pending.acceptedAt === undefined || pending.error !== undefined) return false;
  const echo = findEcho(input.entries, pending);
  const from = echo >= 0 ? echo + 1 : pending.baseline;
  for (let i = from; i < input.entries.length; i++) if (isFinalAssistant(input.entries[i], input.entries.slice(i + 1))) return true;
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
    label: phase === "quiet" ? quietLabel(input.now - quietSince(input)) : phaseLabel(phase),
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

/** Where the quiet clock starts: the last progress, or the send's acceptance if that is later. */
function progressSince({ pending, lastProgressAt }: Pick<ActivityInput, "pending" | "lastProgressAt">): number {
  return pending?.acceptedAt !== undefined ? Math.max(pending.acceptedAt, lastProgressAt) : lastProgressAt;
}

/** How long pi has really been quiet: after a reload the page's own clock starts at load, so pi's
 * last activity, when older, is the truer start. */
function quietSince(input: ActivityInput): number {
  const since = progressSince(input);
  return input.piActiveAt !== undefined ? Math.min(since, input.piActiveAt) : since;
}

function derivePhase(input: ActivityInput): ActivityPhase {
  const { runState, pending, now, lastProgressAt, entries, agentSeenAt } = input;
  const agentAlive = agentSeenAt !== undefined && now - agentSeenAt <= AGENT_SILENT_MS;
  // Only a running turn can be legitimately slow. Idle with an undelivered message, or a stop
  // that isn't finishing, is still an error after WORK_TIMEOUT_MS.
  const stalled = (since: number): ActivityPhase => {
    if (now - since <= WORK_TIMEOUT_MS) return "working";
    return runState === "running" && agentAlive ? "quiet" : "workTimeout";
  };
  if (pending) {
    if (pending.error !== undefined) return "sendFailed";
    if (pending.acceptedAt === undefined) return "sending";
    if (isAnswered({ entries, runState }, pending)) return "none";
    // idle-but-not-yet-running: the mail is on its way to the run, so it counts as working.
    if (runState === "running" || runState === "idle" || runState === "stopping") return stalled(progressSince(input));
    const ended = runState === "failed" || runState === "stopped" || runState === undefined;
    if (ended && pending.sawChange) return pending.sawRunning ? "workTimeout" : "wakeTimeout";
    // queued/provisioning, or a stale ended state from before the send: a drive is waking.
    return now - pending.acceptedAt > WAKE_TIMEOUT_MS ? "wakeTimeout" : "waking";
  }
  // No send of ours in flight: the page was reloaded mid-wait, or a run was started elsewhere.
  if (runState === "queued" || runState === "provisioning") return now - lastProgressAt > WAKE_TIMEOUT_MS ? "wakeTimeout" : "waking";
  if (runState === "running") return stalled(lastProgressAt);
  return "none";
}

/** The status line for a quiet turn, in whole minutes (it ticks with the page's clock). */
export function quietLabel(quietMs: number): string {
  return `Working, no output for ${Math.max(1, Math.floor(quietMs / 60_000))} min`;
}

export function phaseLabel(phase: ActivityPhase): string | null {
  switch (phase) {
    case "sending":
      return "Sending…";
    case "waking":
      return "Waking a drive, about a minute";
    case "working":
      return "Working…";
    case "quiet":
      return quietLabel(WORK_TIMEOUT_MS);
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
