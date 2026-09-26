// A session's stored entries as a pi session file (JSONL): the transcript a new run restores
// (run.spec.snapshot.jsonl, agentlink.ts) and GET /api/sessions/:id/export.jsonl (teleport).
//
// The store is the only complete copy of a conversation. Every run writes its entries there, but no
// run leaves a session file behind (agentd sends no snapshotUrl), so before this a woken session's
// pi started empty while the page still showed the whole thread.

import type { Session, PiEntry } from "./store/types.ts";

/** Matches pi's CURRENT_SESSION_VERSION. */
export const SESSION_VERSION = 3;

function headerLine(session: Session): string {
  const header = {
    type: "session" as const,
    version: SESSION_VERSION,
    id: session.id,
    timestamp: session.createdAt,
    cwd: "/workspace",
    ...(session.parentId ? { parentSession: session.parentId } : {}),
  };
  return JSON.stringify(header);
}

/**
 * Entries in stored (insertion) order, with every root after the first attached to the entry
 * before it. pi reads a session as a tree: the last line is the leaf and its context is that leaf's
 * ancestors. Sessions woken before this fix have a second root per run (each started pi on an empty
 * file), and agentd's own entries (the Playwright check) are stored with `parentId: null`. Left
 * alone, either one as the last line would give the model only that fragment. Attached, the model
 * sees the thread the page shows. An entry whose parent isn't in the transcript is treated the same.
 */
export function linkedEntries(entries: PiEntry[]): PiEntry[] {
  const seen = new Set<string>();
  let previous: string | undefined;
  return entries.map((entry) => {
    const parent = entry.parentId;
    const orphan = previous !== undefined && (parent == null || !seen.has(parent));
    const linked = orphan ? { ...entry, parentId: previous } : entry;
    seen.add(entry.id);
    previous = entry.id;
    return linked;
  });
}

/** The session as pi-compatible JSONL: header line, then linkedEntries, newline-terminated. */
export function sessionJsonl(session: Session, entries: PiEntry[]): string {
  const lines = [headerLine(session), ...linkedEntries(entries).map((e) => JSON.stringify(e))];
  return lines.join("\n") + "\n";
}
