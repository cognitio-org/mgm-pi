// A small GEOS-styled dialog offering the 75-second Manual tour, shown once and remembered in
// localStorage (try/catch, same pattern as ThemeToggle/SoundToggle). Exported standalone so the
// desk/entry page landing alongside this branch can mount it later; for now it's mounted on the
// Manual page itself (see ManualPage.tsx) so the offer has somewhere to live immediately.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const STORAGE_KEY = "outfitterTourOffered";

function hasBeenOffered(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markOffered(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // best-effort only
  }
}

export interface TourOfferProps {
  /** Where "Take the tour" navigates to. Defaults to /manual. */
  tourPath?: string;
}

export function TourOffer({ tourPath = "/manual" }: TourOfferProps) {
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!hasBeenOffered()) setVisible(true);
  }, []);

  function dismiss() {
    markOffered();
    setVisible(false);
  }

  function takeTour() {
    markOffered();
    setVisible(false);
    navigate(tourPath);
  }

  if (!visible) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onClick={dismiss}>
      <div
        className="dialog tour-offer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-offer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-titlebar">
          <span className="panel-label" id="tour-offer-title">
            WELCOME
          </span>
        </div>
        <div className="panel-body">
          <p>Take the 75-second tour?</p>
          <p className="tour-storyboard-note">
            It walks through Kernals, Tapes, Floppies, Drives and the rest of Outfitter's vocabulary. You can
            always open it again from the Manual.
          </p>
          <div className="tour-offer-actions">
            <button type="button" className="btn" onClick={dismiss}>
              Not now
            </button>
            <button type="button" className="btn btn-primary" onClick={takeTour} autoFocus>
              Take the tour
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
