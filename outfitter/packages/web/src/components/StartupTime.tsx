import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { StartupSummary } from "../api/client.ts";

/** Run states in which the run's own start is still the one on screen. A stopped or failed run's
 * start is history; the next run brings its own. */
const LIVE_STATES = new Set(["running", "idle", "stopping"]);

const PROVIDER_LABELS: Record<string, string> = {
  gke: "GKE",
  cloudrun: "Cloud Run",
  docker: "Docker",
  inprocess: "local",
};

/** 4230 -> "4.2 s"; anything under a tenth of a second reads "<0.1 s" rather than "0.0 s". */
export function formatSeconds(ms: number): string {
  if (ms > 0 && ms < 100) return "<0.1 s";
  return `${(ms / 1000).toFixed(1)} s`;
}

/** "GKE warm", "Cloud Run", "local cold", or "" when neither is known. */
export function startupSource(startup: Pick<StartupSummary, "provider" | "warm">): string {
  const provider = startup.provider ? (PROVIDER_LABELS[startup.provider] ?? startup.provider) : "";
  const warmth = startup.warm === true ? "warm" : startup.warm === false ? "cold" : "";
  return [provider, warmth].filter(Boolean).join(" ");
}

/** Whether the status bar shows the item: a finished start, while that run is live. */
export function showStartupTime(startup: StartupSummary | null | undefined, runState: string | undefined): startup is StartupSummary {
  return !!startup && startup.complete && !!runState && LIVE_STATES.has(runState);
}

/** Where the fixed-position panel goes: under the button, kept inside the viewport. Fixed, not
 * absolute, because the status bar scrolls sideways on a phone (overflow-x: auto), which would clip
 * an absolutely positioned child. */
export function panelPosition(button: { left: number; bottom: number }, viewportWidth: number, panelWidth = 352): { top: number; left: number } {
  const gutter = 12;
  const left = Math.max(gutter, Math.min(button.left, viewportWidth - panelWidth - gutter));
  return { top: Math.round(button.bottom + 4), left: Math.round(left) };
}

/** One line of plain text for the hover tooltip. */
function startupTitle(startup: StartupSummary): string {
  return startup.segments.map((seg) => `${seg.label} ${formatSeconds(seg.ms)}`).join(" · ");
}

/**
 * "Started in 4.2 s · GKE warm" in the session status bar, once the run's start has finished. The
 * button opens a small breakdown (a stacked bar and a list of steps, with agentd's own details
 * nested); hovering shows the same steps as a tooltip. Hidden for runs without timing data.
 */
export function StartupTime({ startup, runState }: { startup: StartupSummary | null | undefined; runState: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const panelId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const visible = showStartupTime(startup, runState);

  // A new run's summary starts closed.
  const runId = startup?.runId;
  useEffect(() => setOpen(false), [runId]);

  // Placed before the browser paints (a layout effect), so the panel never flashes in the wrong spot.
  useLayoutEffect(() => {
    if (!open) return;
    // Follows the button while open: the transcript scrolls, the window resizes.
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setPosition(panelPosition(rect, window.innerWidth));
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (ev: PointerEvent | MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  if (!visible) return null;
  const source = startupSource(startup);
  const total = formatSeconds(startup.totalMs);

  return (
    <span className="startup-time" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="startup-time-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Started in ${total}${source ? `, ${source}` : ""}. Start-up breakdown`}
        title={startupTitle(startup)}
        onClick={() => setOpen((o) => !o)}
      >
        Started in {total}
        {source ? <span className="startup-time-source">{source}</span> : null}
      </button>
      {open && (
        <div
          className="startup-time-panel"
          id={panelId}
          role="group"
          aria-label={`Start-up breakdown, ${total} in total`}
          style={position ?? undefined}
        >
          <div className="startup-bar" aria-hidden="true">
            {startup.segments.map((seg) =>
              seg.ms > 0 ? (
                <span
                  key={seg.id}
                  className={`startup-bar-part startup-bar-${seg.id}`}
                  style={{ flexGrow: seg.ms }}
                  title={`${seg.label} ${formatSeconds(seg.ms)}`}
                />
              ) : null,
            )}
          </div>
          <ol className="startup-steps">
            {startup.segments.map((seg) => (
              <li key={seg.id} className="startup-step">
                <span className="startup-step-row">
                  <span className={`startup-swatch startup-bar-${seg.id}`} aria-hidden="true" />
                  <span className="startup-step-label">{seg.label}</span>
                  <span className="startup-step-ms">{formatSeconds(seg.ms)}</span>
                </span>
                {seg.details && seg.details.length > 0 && (
                  <ul className="startup-details">
                    {seg.details.map((d, i) => (
                      <li key={`${i}-${d.label}`} className="startup-step-row">
                        <span className="startup-step-label">{d.label}</span>
                        <span className="startup-step-ms">{formatSeconds(d.ms)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
          <p className="startup-total startup-step-row">
            <span className="startup-step-label">Total{source ? ` (${source})` : ""}</span>
            <span className="startup-step-ms">{total}</span>
          </p>
        </div>
      )}
    </span>
  );
}
