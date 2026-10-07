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

export function checkpointEvent(checkpoint: Checkpoint): CheckpointEvent {
  const event: CheckpointEvent = { t: "checkpoint" };
  for (const key of ["branch", "head", "landed", "pushed", "at", "landedAt", "pushedAt"] as const) {
    if (checkpoint[key] !== undefined) (event as unknown as Record<string, unknown>)[key] = checkpoint[key];
  }
  return event;
}

export interface LastPush {
  sha: string;
  branch?: string;
  /** When those commits were pushed: pushedAt, else (rows from before it) when the head landed. */
  at?: string;
  /** The latest checkpoint sent commits (false: it found GitHub already at `sha`, or didn't land). */
  pushed: boolean;
}

/** The commit last known to be on GitHub, or null before any has landed. */
export function lastPush(checkpoint: Session["checkpoint"]): LastPush | null {
  if (!checkpoint?.head) return null;
  const at = checkpoint.pushedAt ?? checkpoint.landedAt;
  return {
    sha: checkpoint.head,
    ...(checkpoint.branch ? { branch: checkpoint.branch } : {}),
    ...(at ? { at } : {}),
    pushed: checkpoint.pushed === true,
  };
}
