import { useEffect, useState } from "react";
import type { DiffNote } from "../lib/git-view.ts";

const KEY = "outfitterDiffNotes:";
/** Per floppy: notes are for a review, not an essay, and sessionStorage is small. */
export const MAX_NOTES = 50;
export const MAX_NOTES_BYTES = 20_000;

function read(sessionId: string): DiffNote[] {
  try {
    const raw = sessionStorage.getItem(KEY + sessionId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as DiffNote[]) : [];
  } catch {
    return [];
  }
}

/** Saves the notes; false when storage refused them (full, or private browsing). The notes still
 * live in the page until it's reloaded. */
function write(sessionId: string, notes: DiffNote[]): boolean {
  try {
    if (notes.length === 0) sessionStorage.removeItem(KEY + sessionId);
    else sessionStorage.setItem(KEY + sessionId, JSON.stringify(notes));
    return true;
  } catch {
    return false;
  }
}

/** Why a note can't be added, or null when it can. */
export function noteRefusal(notes: DiffNote[], note: DiffNote): string | null {
  if (notes.length >= MAX_NOTES) return `That's ${MAX_NOTES} notes already: send or discard some first.`;
  if (JSON.stringify([...notes, note]).length > MAX_NOTES_BYTES) return "The notes are too long to keep: send or discard some first.";
  return null;
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

  function set(next: DiffNote[]): boolean {
    const saved = write(sessionId, next);
    setState({ sessionId, notes: next });
    return saved;
  }

  return {
    notes,
    /** Adds a note, or says why not (too many, too long); `message` also warns when this tab
     * couldn't save it. */
    add: (note: DiffNote): { added: boolean; message: string | null } => {
      const refused = noteRefusal(notes, note);
      if (refused) return { added: false, message: refused };
      return set([...notes, note])
        ? { added: true, message: null }
        : { added: true, message: "Note added, but this tab couldn't save it: it's lost if the page reloads." };
    },
    remove: (index: number) => set(notes.filter((_, i) => i !== index)),
    clear: () => set([]),
  };
}

export type DiffNotes = ReturnType<typeof useDiffNotes>;
