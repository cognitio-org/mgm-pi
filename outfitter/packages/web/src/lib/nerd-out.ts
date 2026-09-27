// The "nerd out" panel's pure helpers (#198): sandbox details, stats charts and the log viewer.
// Everything here formats what the api's sandbox endpoints (#197) return; nothing fetches.

import { ApiError, type SandboxExit, type SandboxLogLine, type SandboxSeries } from "../api/client.ts";

const PROVIDER_LABELS: Record<string, string> = {
  gke: "GKE",
  cloudrun: "Cloud Run",
  docker: "Docker",
  inprocess: "local",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** 812 -> "812 MiB", 3277 -> "3.2 GiB". */
export function formatMb(mb: number): string {
  if (mb < 1024) return `${Math.round(mb)} MiB`;
  return `${(mb / 1024).toFixed(1)} GiB`;
}

/** The image's last path segment, with a digest cut to 12 hex characters:
 * `.../outfitter-agent@sha256:0123456789abcdef...` -> `outfitter-agent@0123456789ab`. */
export function shortImage(image: string): string {
  const name = image.slice(image.lastIndexOf("/") + 1);
  const digest = name.match(/^(.*)@sha256:([0-9a-f]+)$/);
  return digest ? `${digest[1]}@${digest[2]!.slice(0, 12)}` : name;
}

/** Local wall-clock time, "05:04:12". Empty for a time that doesn't parse. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** Date and time, for a run picker: "27 Sep 05:04". */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString([], { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} ${time}`;
}

/** "OOMKilled · exit 137 · 05:04:12", and whether it was a clean end. */
export function exitSummary(exit: SandboxExit): { text: string; tone: "ok" | "danger" } {
  const parts = [exit.reason];
  if (exit.exitCode !== undefined) parts.push(`exit ${exit.exitCode}`);
  if (exit.finishedAt) {
    const clock = formatClock(exit.finishedAt);
    if (clock) parts.push(clock);
  }
  const clean = exit.reason === "Completed" && (exit.exitCode === undefined || exit.exitCode === 0);
  return { text: parts.join(" · "), tone: clean ? "ok" : "danger" };
}

/** What the panel says when a telemetry call has nothing to show, from the api's status codes
 * (routes/sandbox.ts): 501 not kept here, 503 not granted yet, 502 the backend failed. */
export function telemetryMessage(err: unknown, what: "Logs" | "Stats history"): string {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 501) {
    return what === "Logs" ? "Logs aren't available in this deployment." : "Stats history is kept for GKE drives only.";
  }
  if (status === 503) return `${what}: access isn't granted yet. The owner runs deploy/gke-iam.sh.`;
  if (status === 404) return "That run isn't part of this floppy.";
  if (status === 400) return `${what}: the request was refused. Try again from the start.`;
  return `${what} couldn't be loaded${status ? ` (${status})` : ""}. Try again in a moment.`;
}

/** Why the details didn't load. A 404 without a picked run is a session that never ran. */
export function detailMessage(err: unknown, defaultRun: boolean): string {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 404) return defaultRun ? "No run yet. Press Play to start one." : "That run isn't part of this floppy.";
  return `The drive's details couldn't be loaded${status ? ` (${status})` : ""}. Try again in a moment.`;
}

// ---------- charts ----------

export interface ChartGeometry {
  /** SVG path: a stepped line, one step per sample. Empty with no points. */
  path: string;
  /** The same line closed down to the baseline, for the fill under it. */
  area: string;
  max: number;
  last?: number;
  /** Where a limit line sits (SVG y), when a limit is given and fits. */
  limitY?: number;
}

/**
 * A stepped chart of one series, the look of an old strip-chart recorder: each sample holds until
 * the next one. x is by time, so a gap in the samples shows as a long step, not a squeeze. The top
 * of the scale is the larger of the peak and `limit`, so a limit line always fits.
 */
export function chartGeometry(series: SandboxSeries, width: number, height: number, limit?: number): ChartGeometry {
  const points = series
    .map(([t, v]) => [Date.parse(t), v] as const)
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
  const peak = points.reduce((m, [, v]) => Math.max(m, v), 0);
  const max = Math.max(peak, limit ?? 0) || 1;
  const y = (v: number) => round(height - (v / max) * height);
  const limitY = limit !== undefined && limit > 0 ? y(limit) : undefined;
  if (points.length === 0) return { path: "", area: "", max, ...(limitY !== undefined ? { limitY } : {}) };

  const t0 = points[0]![0];
  const span = points[points.length - 1]![0] - t0;
  const x = (t: number) => (span > 0 ? round(((t - t0) / span) * width) : width);
  let path = `M0 ${y(points[0]![1])}`;
  for (let i = 1; i < points.length; i++) {
    path += ` H${x(points[i]![0])} V${y(points[i]![1])}`;
  }
  // A single sample, or the last one, holds to the right edge.
  path += ` H${width}`;
  const area = `${path} V${height} H0 Z`;
  return { path, area, max, last: points[points.length - 1]![1], ...(limitY !== undefined ? { limitY } : {}) };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------- log viewer ----------

export type LogLevel = "all" | "warn" | "error";

/** Cloud Logging's severities, in order. DEFAULT is a line with none. */
const SEVERITY_RANK: Record<string, number> = {
  DEFAULT: 0,
  DEBUG: 100,
  INFO: 200,
  NOTICE: 300,
  WARNING: 400,
  ERROR: 500,
  CRITICAL: 600,
  ALERT: 700,
  EMERGENCY: 800,
};

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity.toUpperCase()] ?? 0;
}

/** The badge a line gets: ERR for ERROR and above, WRN for WARNING, DBG, else INF. */
export function severityTag(severity: string): { tag: string; tone: "error" | "warn" | "debug" | "info" } {
  const rank = severityRank(severity);
  if (rank >= 500) return { tag: "ERR", tone: "error" };
  if (rank >= 400) return { tag: "WRN", tone: "warn" };
  if (rank === 100) return { tag: "DBG", tone: "debug" };
  return { tag: "INF", tone: "info" };
}

/** Lines at or above `level` whose message contains `text` (case-insensitive). */
export function filterLines(lines: readonly SandboxLogLine[], text: string, level: LogLevel): SandboxLogLine[] {
  const min = level === "error" ? 500 : level === "warn" ? 400 : -1;
  const needle = text.trim().toLowerCase();
  return lines.filter((l) => severityRank(l.severity) >= min && (!needle || l.message.toLowerCase().includes(needle)));
}

function lineKey(l: SandboxLogLine): string {
  return `${Date.parse(l.time)}\u0000${l.severity}\u0000${l.message}`;
}

/**
 * The lines already shown plus a fetched page, each line once, oldest first. A union, not an
 * append: Cloud Logging can make a line readable after later ones (it lands in the middle), and a
 * page can overlap what's held (Follow, or Load earlier after the log grew). Returns the same array
 * when nothing is new, so a refresh that found nothing doesn't re-render.
 */
export function mergeLines(held: readonly SandboxLogLine[], page: readonly SandboxLogLine[]): readonly SandboxLogLine[] {
  const keys = new Set(held.map(lineKey));
  const added: SandboxLogLine[] = [];
  for (const l of page) {
    const k = lineKey(l);
    if (keys.has(k)) continue;
    keys.add(k);
    added.push(l);
  }
  if (added.length === 0) return held;
  // By parsed time, not string order: RFC 3339 fractions vary in length. The sort is stable, so
  // lines in the same millisecond keep their order.
  return [...held, ...added].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

/** Whether a newest-first page reaches back to what's held: its oldest line is not newer than the
 * newest held line. When it doesn't, lines in between are missing and the next page is needed. */
export function pageReaches(held: readonly SandboxLogLine[], page: readonly SandboxLogLine[]): boolean {
  if (held.length === 0 || page.length === 0) return true;
  return Date.parse(page[0]!.time) <= Date.parse(held[held.length - 1]!.time);
}

/** Characters a line must not use to pass itself off as something else: line breaks (a fake next
 * line), other C0/C1 controls (terminal escapes when copied) and bidi controls (reordered text). */
const HIDDEN_CHARS = /\r\n|\n|\r|\t|[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A message made safe to show and copy as one line: a line break becomes a visible "⏎", a tab
 * two spaces, and any other control or bidi character its code, e.g. "\u001b" -> "<U+001B>". */
export function displayMessage(message: string): string {
  return message.replace(HIDDEN_CHARS, (ch) => {
    if (ch === "\t") return "  ";
    if (ch === "\n" || ch === "\r" || ch === "\r\n") return " ⏎ ";
    return `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`;
  });
}

/** Plain text for the clipboard: one "time SEVERITY message" per line, each message on one line. */
export function linesToText(lines: readonly SandboxLogLine[]): string {
  return lines.map((l) => `${l.time} ${l.severity} ${displayMessage(l.message)}`).join("\n");
}
