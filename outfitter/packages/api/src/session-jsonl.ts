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
 * Stored order with every entry after its parent. Insertion order is nearly that already, but two
 * processes (link instances after an agentd reconnect, or the web role storing a capture) writing in
 * the same second get ObjectIds ordered by a per-process random field, not by time. A child listed
 * before its parent is moved to just after it. Iterative, so a long chain can't overflow the stack.
 */
function parentsFirst(entries: PiEntry[]): PiEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const placed = new Set<string>();
  const out: PiEntry[] = [];
  for (const entry of entries) {
    // Walk up to the first ancestor not yet placed, then place that chain top-down.
    const chain: PiEntry[] = [];
    const onChain = new Set<string>();
    let at: PiEntry | undefined = entry;
    while (at && !placed.has(at.id) && !onChain.has(at.id)) {
      chain.push(at);
      onChain.add(at.id);
      at = at.parentId != null ? byId.get(at.parentId) : undefined;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      placed.add(chain[i].id);
      out.push(chain[i]);
    }
  }
  return out;
}

/**
 * Entries parents-first (above), with every root after the first attached to the entry before it.
 * pi reads a session as a tree: the last line is the leaf and its context is that leaf's ancestors.
 * Sessions woken before this fix have a second root per run (each started pi on an empty file), and
 * agentd's own entries (the Playwright check) are stored with `parentId: null`. Left alone, either
 * one as the last line would give the model only that fragment. Attached, the model sees the thread
 * the page shows. An entry whose parent isn't in the transcript at all is treated the same.
 */
export function linkedEntries(entries: PiEntry[]): PiEntry[] {
  const present = new Set(entries.map((e) => e.id));
  let previous: string | undefined;
  return parentsFirst(entries).map((entry) => {
    const parent = entry.parentId;
    const orphan = previous !== undefined && (parent == null || !present.has(parent));
    const linked = orphan ? { ...entry, parentId: previous } : entry;
    previous = entry.id;
    return linked;
  });
}

/** The session as pi-compatible JSONL: header line, then linkedEntries, newline-terminated. */
export function sessionJsonl(session: Session, entries: PiEntry[]): string {
  const lines = [headerLine(session), ...linkedEntries(entries).map((e) => JSON.stringify(e))];
  return lines.join("\n") + "\n";
}
