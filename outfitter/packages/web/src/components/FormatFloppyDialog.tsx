import { useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api/client.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { withFloppySound } from "../lib/floppy-sound.ts";
import { floppyActions } from "../lib/vocabulary.ts";
import { Working } from "./Working.tsx";
import type { ApiErrorState } from "./SystemErrorDialog.tsx";

interface Props {
  sessionId: string;
  title: string;
  /** Called once the floppy is gone. The caller unmounts the dialog (its buttons stay disabled). */
  onFormatted: () => void;
  onCancel: () => void;
  onError: (error: ApiErrorState) => void;
}

/** #209: the one confirm before Format erases an archived floppy for good (DELETE
 * /api/sessions/:id). A calm GEOS alert, like SystemErrorDialog's notices; Cancel has focus so an
 * accidental Enter doesn't erase anything. */
export function FormatFloppyDialog({ sessionId, title, onFormatted, onCancel, onError }: Props) {
  const [formatting, setFormatting] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Escape cancels, and Tab stays on the two buttons: focus must not wander to the page behind a
  // destructive confirm.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!formatting) onCancel();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const buttons = [...dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
    e.preventDefault();
    next.focus();
  }

  async function confirm() {
    setFormatting(true);
    try {
      await withFloppySound(api.formatSession(sessionId));
      onFormatted();
    } catch (err) {
      setFormatting(false);
      onError(toApiErrorState(err, "Format failed"));
    }
  }

  return (
    <div className="dialog-backdrop" onClick={formatting ? undefined : onCancel}>
      <div
        className="dialog panel notice-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="format-title"
        aria-describedby="format-body"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        ref={dialogRef}
      >
        <div className="panel-titlebar">
          <span className="panel-label" id="format-title">
            {floppyActions.format.word} {title}?
          </span>
        </div>
        <div className="panel-body">
          <p id="format-body">
            This erases the floppy's conversation, messages and browser captures for good. There is no undo. Its
            GitHub branch, if it has one, stays.
          </p>
          <div className="form-actions">
            <button type="button" className="btn btn-danger" onClick={confirm} disabled={formatting}>
              {formatting ? <Working label="Formatting" /> : "Yes, format"}
            </button>
            <button type="button" className="btn" onClick={onCancel} disabled={formatting} autoFocus>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
