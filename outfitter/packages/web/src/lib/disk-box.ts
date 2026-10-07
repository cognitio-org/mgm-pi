// #498: the Disk Box sidebar beside a floppy (docs/design/sessions-redesign-demo.html note 1).
// Floppies in three groups -- Running, Today, Earlier -- each with a lamp a person can read at a
// glance. Pure, so the grouping and the lamps are testable without mounting the sidebar.

import type { SessionSummary } from "../api/client.ts";

export type DiskLamp = "running" | "needsYou" | "ready" | "error" | "stopped";

export type DiskGroup = "Running" | "Today" | "Earlier";

export const DISK_GROUPS: readonly DiskGroup[] = ["Running", "Today", "Earlier"];

/** A drive is spinning: the floppy is working, or on its way to. */
const SPINNING = new Set(["queued", "provisioning", "running"]);

export interface DiskRow {
  summary: SessionSummary;
  lamp: DiskLamp;
  group: DiskGroup;
}

/** The row's lamp. `needsYou` comes from the open floppy's own stream: the list doesn't carry a
 * pending question, so only the floppy on screen can show it. */
export function diskLamp(summary: Pick<SessionSummary, "runState">, needsYou = false): DiskLamp {
  if (summary.runState === "failed") return "error";
  if (needsYou) return "needsYou";
  if (summary.runState && SPINNING.has(summary.runState)) return "running";
  if (summary.runState === "idle") return "ready";
  return "stopped";
}

export const LAMP_WORD: Record<DiskLamp, string> = {
  running: "RUNNING",
  needsYou: "NEEDS YOU",
  ready: "READY.",
  error: "LOAD ERROR",
  stopped: "STOPPED",
};

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** What the search box matches: the title, the repository and the branch. */
export function matchesQuery(summary: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [summary.name ?? `Floppy ${summary.id.slice(0, 8)}`, summary.id, summary.repo ?? "", summary.branch ?? ""].join(" ").toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/** Rows by group, newest first inside each. Running holds anything with a spinning drive or a
 * question waiting; the rest go by the day they last changed. */
export function groupDiskBox(
  sessions: SessionSummary[],
  options: { query?: string; now?: Date; needsYouId?: string } = {},
): Record<DiskGroup, DiskRow[]> {
  const now = options.now ?? new Date();
  const groups: Record<DiskGroup, DiskRow[]> = { Running: [], Today: [], Earlier: [] };
  const sorted = [...sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  for (const summary of sorted) {
    if (!matchesQuery(summary, options.query ?? "")) continue;
    const lamp = diskLamp(summary, summary.id === options.needsYouId);
    const updated = new Date(summary.updatedAt);
    const group: DiskGroup =
      lamp === "running" || lamp === "needsYou" ? "Running" : !Number.isNaN(updated.getTime()) && sameDay(updated, now) ? "Today" : "Earlier";
    groups[group].push({ summary, lamp, group });
  }
  return groups;
}

/** The row's short time: "now", "5m", "3h", "Mon", "Sep 30". */
export function shortWhen(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const mins = Math.floor((now.getTime() - t.getTime()) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (sameDay(t, now)) return `${Math.floor(mins / 60)}h`;
  if (mins < 6 * 24 * 60) return t.toLocaleDateString("en-US", { weekday: "short" });
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The row's second line: repository and branch, or that it has none. */
export function rowMeta(summary: Pick<SessionSummary, "repo" | "branch">): string {
  if (!summary.repo) return "no repository";
  const repo = summary.repo.split("/").pop() ?? summary.repo;
  return summary.branch ? `${repo} · ${summary.branch}` : repo;
}
