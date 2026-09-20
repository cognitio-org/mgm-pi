// Formats an ISO timestamp as "just now" / "5m ago" / "3h ago" / "2d ago" / a calendar date once
// it's old enough that relative units stop being useful.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = now - then;
  if (diff < 0) return "just now"; // clock skew guard
  if (diff < 30_000) return "just now";
  if (diff < MINUTE) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}
