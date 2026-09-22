import { useState } from "react";
import { systemErrorContent, systemErrorId } from "../lib/retro-errors.ts";
import { BombIcon } from "./ErrorIcons.tsx";

export interface ApiErrorState {
  status?: number;
  message?: string;
}

interface Props {
  error: ApiErrorState;
  /** Retries the action that failed. Omitted when there's nothing sensible to retry (the dialog
   * still shows a Resume button so it's always dismissable). */
  onRestart?: () => void | Promise<void>;
  onResume: () => void;
}

/** The early-Mac "Sorry, a system error occurred." bomb alert (docs/reports/mobile-desk.md),
 * replacing the plain `.error-banner` every page used to show for a failed API call. ID = the HTTP
 * status (or "ERR" for a thrown non-ApiError), body = the API's own message. Restart re-runs the
 * action that failed; Resume just dismisses the dialog -- both are always available so a user is
 * never stuck looking at a bomb with no way out. */
export function SystemErrorDialog({ error, onRestart, onResume }: Props) {
  const [restarting, setRestarting] = useState(false);
  const content = systemErrorContent(error.message);
  const id = systemErrorId(error.status);

  async function handleRestart() {
    if (!onRestart) return;
    setRestarting(true);
    try {
      await onRestart();
    } finally {
      setRestarting(false);
    }
  }

  return (
    <div className="dialog-backdrop bomb-backdrop">
      <div className="dialog bomb-dialog" role="alert" aria-labelledby="bomb-title" aria-describedby="bomb-body">
        <div className="bomb-dialog-body">
          <BombIcon size={28} />
          <div className="bomb-text">
            <h2 id="bomb-title" className="bomb-title">
              {content.headline}
            </h2>
            <p className="bomb-id">ID = {id}</p>
            <p id="bomb-body" className="bomb-message">
              {content.message}
            </p>
          </div>
        </div>
        <div className="form-actions bomb-actions">
          {onRestart && (
            <button type="button" className="btn btn-primary" onClick={handleRestart} disabled={restarting}>
              {restarting ? "Restarting…" : "Restart"}
            </button>
          )}
          <button type="button" className="btn" onClick={onResume}>
            Resume
          </button>
        </div>
      </div>
    </div>
  );
}
