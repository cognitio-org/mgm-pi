// Pure helpers behind the retro error/status vocabulary (docs/reports/mobile-desk.md "Thinking,
// Kernal naming, error vocabulary"): headline + plain sentence + action, never just a red banner.
// Kept framework-free so the mapping itself is unit-testable without mounting any component --
// ErrorBoundary.tsx, SystemErrorDialog.tsx and SessionPage.tsx own the actual rendering.

export interface RetroErrorContent {
  headline: string;
  message: string;
}

/** "Sorry, a system error occurred." bomb dialog content (SystemErrorDialog.tsx): the headline is
 * fixed by the brief, the body is the API's own message (falling back to a plain sentence when the
 * API didn't send one -- a network failure, a non-JSON error body, etc). */
export function systemErrorContent(apiMessage: string | undefined): RetroErrorContent {
  return {
    headline: "Sorry, a system error occurred.",
    message: apiMessage?.trim() || "An unexpected error occurred.",
  };
}

/** The bomb dialog's "ID = " field -- an HTTP status when there is one, else a short fallback for
 * an error that never reached the network stack (a thrown non-ApiError, e.g. a client-side bug). */
export function systemErrorId(status: number | undefined): string {
  return typeof status === "number" ? String(status) : "ERR";
}

export type ContextMeterState = "ok" | "warn" | "danger" | "outOfMemory";

/** Mirrors the session header's context meter thresholds (danger >=80%, warn >=50%), plus the new
 * 95%+ "out of memory" state -- kept as one ordered mapping so the four states can never overlap. */
export function contextMeterState(percent: number): ContextMeterState {
  if (percent >= 95) return "outOfMemory";
  if (percent >= 80) return "danger";
  if (percent >= 50) return "warn";
  return "ok";
}

/** "?OUT OF MEMORY ERROR" note shown beside the context meter once it crosses 95% -- null below
 * that threshold, so callers can `{contextMeterMessage(percent) && <.../>}` directly. */
export function contextMeterMessage(percent: number): string | null {
  if (contextMeterState(percent) !== "outOfMemory") return null;
  return "?OUT OF MEMORY ERROR — context window almost full; the agent will compact soon";
}

/** The session header/composer's idle-state line. "ready"/"break"/"loadError" are the only states
 * with their own text -- while a run is actively working the existing <Working> indicator already
 * covers it, so callers never ask for a "working" line here. */
export type TransportOutcome = "break" | "loadError";

export function transportStatusLine(outcome: TransportOutcome | "ready"): string {
  switch (outcome) {
    case "ready":
      return "READY.";
    case "break":
      return "BREAK";
    case "loadError":
      return "LOAD ERROR";
  }
}

/** Which status line (if any) the session header/composer should show right now: a just-finished
 * Break/failed-Play outcome wins while it's still flashed, otherwise "READY." once nothing is
 * running, otherwise null (the <Working> indicator is showing instead). Pure so the precedence
 * rule is unit-testable without a timer. */
export function deriveTransportStatusLine(active: boolean, outcome: TransportOutcome | null): string | null {
  if (outcome) return transportStatusLine(outcome);
  if (!active) return transportStatusLine("ready");
  return null;
}
