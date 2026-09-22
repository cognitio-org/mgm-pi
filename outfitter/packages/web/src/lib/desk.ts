// Pure logic for the GEOS-style desktop entry page (DeskPage.tsx): the status-bar derivation and
// the icon-grid keyboard navigation. Kept framework-free so both are unit-testable without
// mounting React.

import type { ProviderRow, SessionSummary } from "../api/client.ts";

export interface DeskStatus {
  sessionCount: number;
  runningCount: number;
  todaysCost: number;
  providersUp: number;
  providersTotal: number;
}

const RUNNING_RUN_STATES = new Set(["running", "queued", "provisioning"]);
const STOPPED_RUN_STATES = new Set(["stopped", "failed"]);

/** True when an ISO timestamp falls on the same local calendar day as `now`. */
function isToday(iso: string, now: Date): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  );
}

/** Derives the desk's one-line status bar (session/running counts, today's cost, provider health)
 * from data the app already fetches elsewhere (GET /api/sessions, GET /api/providers) -- no new
 * endpoint. `now` is injectable for tests. */
export function deriveDeskStatus(sessions: SessionSummary[], providers: ProviderRow[], now: Date = new Date()): DeskStatus {
  let runningCount = 0;
  let todaysCost = 0;
  for (const s of sessions) {
    if (s.runState && RUNNING_RUN_STATES.has(s.runState)) runningCount++;
    if (isToday(s.updatedAt, now)) todaysCost += s.cost ?? 0;
  }
  const providersUp = providers.filter((p) => p.status === "up").length;
  return {
    sessionCount: sessions.length,
    runningCount,
    todaysCost,
    providersUp,
    providersTotal: providers.length,
  };
}

/** Sessions whose run state reads as "stopped" for the desktop's Trash icon (stopped or failed --
 * the states the Fleet/Disk Box page's own RUN_STATES list treats as terminal, minus idle/queued
 * which are still "in the drive"). */
export function stoppedSessionCount(sessions: SessionSummary[]): number {
  return sessions.filter((s) => s.runState && STOPPED_RUN_STATES.has(s.runState)).length;
}

/** Icon-grid keyboard navigation: given a grid of `cols` columns and `count` items (row-major,
 * last row may be short), returns the next focused index for an arrow key from `current`, or
 * `current` unchanged if the move would leave the grid. Pure so DeskPage's onKeyDown handler is
 * just `setFocused(moveGridFocus(...))`. */
export type GridKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

export function moveGridFocus(current: number, key: GridKey, count: number, cols: number): number {
  if (count <= 0) return current;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "ArrowRight": {
      const next = current + 1;
      return next < count ? next : current;
    }
    case "ArrowLeft": {
      const next = current - 1;
      return next >= 0 ? next : current;
    }
    case "ArrowDown": {
      const next = current + cols;
      return next < count ? next : current;
    }
    case "ArrowUp": {
      const next = current - cols;
      return next >= 0 ? clamp(next) : current;
    }
    default:
      return current;
  }
}
