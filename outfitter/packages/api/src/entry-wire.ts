// How a stored entry goes to a browser (GET /api/sessions/:id/entries and SSE `entry` events).
//
// The wire carries pi's entry object as it is, plus `outfitterRunId` when the store knows which
// run wrote it (#147). The web uses it to start each HTML preview the way that run's prompt said
// (GET /api/sessions/:id's htmlPreviewAccessByRun). The name is namespaced so it can't collide
// with a field pi adds to its own entries later; the stored entry itself is never changed.

import type { Entry, PiEntry } from "./store/types.ts";

export function entryForWire(row: Pick<Entry, "entry" | "runId">): PiEntry {
  return row.runId ? { ...row.entry, outfitterRunId: row.runId } : row.entry;
}
