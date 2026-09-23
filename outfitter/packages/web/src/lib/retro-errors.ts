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
    message: apiMessage?.trim() ? inVocabulary(apiMessage.trim()) : "An unexpected error occurred.",
  };
}

/** How a failed API call should be presented. Only a genuine failure (a 5xx, a network error, or
 * an error with no status at all) earns the bomb: a refusal the API made on purpose (400, 409, 422:
 * "that Tape is still used by a floppy") is ordinary feedback, and a bomb with a Restart button
 * that would just repeat the refused action was both alarming and useless. */
export type ApiErrorKind = "system" | "refused" | "signedOut" | "sysopOnly" | "notFound";

export function apiErrorKind(status: number | undefined): ApiErrorKind {
  if (typeof status !== "number" || status >= 500 || status < 400) return "system";
  if (status === 401) return "signedOut";
  if (status === 403) return "sysopOnly";
  if (status === 404) return "notFound";
  return "refused";
}

/** Headline and body for the calm (non-bomb) notice, by kind. */
export function noticeContent(kind: Exclude<ApiErrorKind, "system">, apiMessage: string | undefined): RetroErrorContent {
  const said = apiMessage?.trim() ? inVocabulary(apiMessage.trim()) : undefined;
  switch (kind) {
    case "refused":
      return { headline: "Can't do that", message: said ?? "The request was refused." };
    case "signedOut":
      return { headline: "Sign in again", message: "Your sign-in has expired. Reload the page to sign in again." };
    case "sysopOnly":
      return { headline: "Sysop only", message: said ?? "Only a Sysop can change this." };
    case "notFound":
      return { headline: "?FILE NOT FOUND ERROR", message: said ?? "It may have been deleted." };
  }
}

/** The API speaks in code names (guru, session); the UI says Tape and Floppy. Rewrites whole words
 * only, keeping the sentence's own capitalisation, so "guru is referenced by 2 sessions" reads
 * "Tape is referenced by 2 floppies". */
export function inVocabulary(message: string): string {
  const swap: Array<[RegExp, string]> = [
    [/\bgurus\b/gi, "tapes"],
    [/\bguru\b/gi, "tape"],
    [/\bsessions\b/gi, "floppies"],
    [/\bsession\b/gi, "floppy"],
  ];
  let out = message;
  for (const [re, to] of swap) {
    out = out.replace(re, (word) => (word[0] === word[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to));
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** The bomb dialog's "ID = " field -- an HTTP status when there is one, else a short fallback for
 * an error that never reached the network stack (a thrown non-ApiError, e.g. a client-side bug). */
export function systemErrorId(status: number | undefined): string {
  return typeof status === "number" ? String(status) : "ERR";
}

/** The plain-language note shown for a run that failed or stalled: the session page's own
 * `.status-detail-note` (from the run's statusDetail, streamed over SSE) and the Drives list's
 * failed row (from the summary's runStateReason) both render through this, so the same refusal reads
 * the same in both places. Runs through inVocabulary because the api writes these in its own code
 * names ("this session's guru no longer exists"), same as every other message it sends the UI.
 * Returns null when there is nothing to say, so callers can `{runStateNote(x) && <.../>}`. */
export function runStateNote(detail: string | undefined): string | null {
  const said = detail?.trim();
  return said ? inVocabulary(said) : null;
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

/** Run states that mean "the agent is doing something right now" -- the <Working> indicator (or a
 * flashed outcome) covers these, so the header/composer status line is null while they're current. */
const LIVE_RUN_STATES = new Set(["running", "queued", "provisioning", "stopping"]);

/** Bug 3 (docs/reports/cloud-fixes.md): the header/composer used to show "READY." whenever no run
 * was *active* (RUNNING_STATES), which also covers a stopped or a failed run -- so a failed run
 * read exactly like an idle one waiting for input. Distinguish by the run's actual last-known
 * state instead of a plain "is something active" boolean:
 * - a just-finished flashed outcome (BREAK / LOAD ERROR from an abort/wake failure) always wins,
 *   same precedence as before;
 * - "idle" (a live run waiting on the user) is the only state that reads READY.;
 * - "running"/"queued"/"provisioning"/"stopping" show nothing here -- <Working> is showing instead;
 * - "failed" reads LOAD ERROR, with the run's own reason appended when there is one;
 * - "stopped", or no run at all yet, reads a plain "stopped - press Play" line rather than READY.,
 *   so a cleanly stopped floppy doesn't look like it's sitting there waiting for a reply. */
export function deriveTransportStatusLine(runState: string | undefined, outcome: TransportOutcome | null, reason?: string): string | null {
  if (outcome) return transportStatusLine(outcome);
  if (runState === "idle") return transportStatusLine("ready");
  if (runState && LIVE_RUN_STATES.has(runState)) return null;
  if (runState === "failed") {
    const said = reason?.trim();
    return said ? `LOAD ERROR — ${inVocabulary(said)}` : "LOAD ERROR";
  }
  // "stopped", or no run recorded at all (a brand-new session, or one whose run never persisted).
  return "stopped · press Play";
}
