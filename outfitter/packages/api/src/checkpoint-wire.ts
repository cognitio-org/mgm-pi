// #501: a session's checkpoint as the browser sees it, over SSE (`checkpoint` events from
// agentlink.ts and sse.ts's SsePoller) and in GET /api/sessions/:id (`lastPush`). Only the git
// facts: snapshot and workspace URLs stay server-side.

import type { Session } from "./store/types.ts";

type Checkpoint = NonNullable<Session["checkpoint"]>;

export interface CheckpointEvent {
  t: "checkpoint";
  branch?: string;
  /** The last head that landed on GitHub. */
  head?: string;
  /** This checkpoint landed (pushed, or found the remote already there). */
  landed?: boolean;
  /** This checkpoint sent commits. */
  pushed?: boolean;
  /** When the api stored this checkpoint. */
  at?: string;
  landedAt?: string;
  /** When a checkpoint last sent commits. */
  pushedAt?: string;
}

/** The checkpoint's git facts only: what any browser-facing copy of it carries. */
export type PublicCheckpoint = Omit<CheckpointEvent, "t">;

export function publicCheckpoint(checkpoint: Checkpoint): PublicCheckpoint {
  const out: PublicCheckpoint = {};
  for (const key of ["branch", "head", "landed", "pushed", "at", "landedAt", "pushedAt"] as const) {
    if (checkpoint[key] !== undefined) (out as Record<string, unknown>)[key] = checkpoint[key];
  }
  return out;
}

export function checkpointEvent(checkpoint: Checkpoint): CheckpointEvent {
  return { t: "checkpoint", ...publicCheckpoint(checkpoint) };
}

/** A session for a browser response: its checkpoint without snapshotUrl/workspaceUrl. Those are
 * the api's to hand the next run (run.spec), never a viewer's. */
export function sessionForWire<T extends { checkpoint?: Checkpoint }>(session: T): Omit<T, "checkpoint"> & { checkpoint?: PublicCheckpoint } {
  const { checkpoint, ...rest } = session;
  return checkpoint ? { ...rest, checkpoint: publicCheckpoint(checkpoint) } : rest;
}

export interface LastPush {
  sha: string;
  branch?: string;
  /** When a checkpoint last sent commits (pushedAt). Absent on rows from before it was recorded:
   * landedAt is not a substitute, since every no-op re-land moves it. */
  at?: string;
  /** The latest checkpoint sent commits (false: it found GitHub already at `sha`, or didn't land). */
  pushed: boolean;
}

/** The commit last known to be on GitHub, or null before any has landed. */
export function lastPush(checkpoint: Session["checkpoint"]): LastPush | null {
  if (!checkpoint?.head) return null;
  return {
    sha: checkpoint.head,
    ...(checkpoint.branch ? { branch: checkpoint.branch } : {}),
    ...(checkpoint.pushedAt ? { at: checkpoint.pushedAt } : {}),
    pushed: checkpoint.pushed === true,
  };
}
