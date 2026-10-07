import { useEffect, useState } from "react";
import type { DiffNote } from "../lib/git-view.ts";

const KEY = "outfitterDiffNotes:";

function read(sessionId: string): DiffNote[] {
  try {
    const raw = sessionStorage.getItem(KEY + sessionId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as DiffNote[]) : [];
  } catch {
    return [];
  }
}

function write(sessionId: string, notes: DiffNote[]): void {
  try {
    if (notes.length === 0) sessionStorage.removeItem(KEY + sessionId);
    else sessionStorage.setItem(KEY + sessionId, JSON.stringify(notes));
  } catch {
    // private browsing, or a test environment without storage
  }
}

/** #502: notes left on diff lines, per floppy, until they're sent or discarded. Kept in this tab's
 * sessionStorage, so a reload doesn't lose them and another floppy never sees them. */
export function useDiffNotes(sessionId: string) {
  const [state, setState] = useState(() => ({ sessionId, notes: read(sessionId) }));
  // Another floppy (the page stays mounted): load its own notes in the same render.
  const notes = state.sessionId === sessionId ? state.notes : read(sessionId);
  useEffect(() => {
    if (state.sessionId !== sessionId) setState({ sessionId, notes: read(sessionId) });
  }, [sessionId, state.sessionId]);

  function set(next: DiffNote[]) {
    write(sessionId, next);
    setState({ sessionId, notes: next });
  }

  return {
    notes,
    add: (note: DiffNote) => set([...notes, note]),
    remove: (index: number) => set(notes.filter((_, i) => i !== index)),
    clear: () => set([]),
  };
}

export type DiffNotes = ReturnType<typeof useDiffNotes>;
