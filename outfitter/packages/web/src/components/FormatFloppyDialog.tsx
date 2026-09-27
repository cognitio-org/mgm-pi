import { useState } from "react";
import { api } from "../api/client.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { withFloppySound } from "../lib/floppy-sound.ts";
import { floppyActions } from "../lib/vocabulary.ts";
import { Working } from "./Working.tsx";
import type { ApiErrorState } from "./SystemErrorDialog.tsx";

interface Props {
  sessionId: string;
  title: string;
  onFormatted: () => void;
  onCancel: () => void;
  onError: (error: ApiErrorState) => void;
}

/** #209: the one confirm before Format erases an archived floppy for good (DELETE
 * /api/sessions/:id). A calm GEOS alert, like SystemErrorDialog's notices; Cancel has focus so an
 * accidental Enter doesn't erase anything. */
export function FormatFloppyDialog({ sessionId, title, onFormatted, onCancel, onError }: Props) {
  const [formatting, setFormatting] = useState(false);

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
