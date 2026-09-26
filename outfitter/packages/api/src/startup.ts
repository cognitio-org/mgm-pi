// Run start-up timing: what the api and agentd record about how long a run took to start
// (Run.startup, store/types.ts), the checks on agentd's part of it, and the summary the web UI and
// the "startup summary" log line both use.
//
// Where each number comes from:
//   wakeAt, providerReturnedAt      RunManager.wake (runs.ts), on the web or link role
//   helloAt, specSentAt, readyAt    AgentLink (agentlink.ts), on the link role
//   agentd                          hello.boot: agentd's own boot durations (main.ts)
//   phases                          the `startup` up-frame: agentd's run phases through "pi ready"
//
// agentd's numbers are durations on its own clock, never timestamps, so a sandbox clock that is off
// cannot distort them. They still come from the sandbox, so they are checked here: known names only,
// finite numbers, clamped, a bounded list.

import type { AgentdBootTimings, Run, RunStartup, StartupPhase } from "./store/types.ts";

/** The boot fields hello.boot may carry, each with its own ceiling. */
const BOOT_LIMITS_MS: Record<Exclude<keyof AgentdBootTimings, "preBooted">, number> = {
  bootMs: 30 * 24 * 60 * 60 * 1000,
  setupMs: 60 * 60 * 1000,
  // A warm pod can idle for most of a day before it is claimed.
  assignmentWaitMs: 30 * 24 * 60 * 60 * 1000,
  sinceAssignedMs: 60 * 60 * 1000,
  identityTokenMs: 60 * 60 * 1000,
  connectMs: 60 * 60 * 1000,
};

/** How much earlier than the wake a pod's boot must be to count as having existed before it (a
 * warm pod). Covers the api/sandbox request latency and the two api clocks (web stamps wakeAt, link
 * stamps helloAt). A cold pod boots after the wake, so it lands well on the other side. */
export const WARM_BOOT_SLACK_MS = 2_000;

/** agentd's run phase names (agentd's startup-phases.ts / run.ts), the only ones kept. */
export const STARTUP_PHASE_NAMES = [
  "run.spec received",
  "repo cloned",
  "workspace restored",
  "session import done",
  "pi spawned",
  "pi ready",
] as const;
const PHASE_NAMES = new Set<string>(STARTUP_PHASE_NAMES);
const PHASE_MAX_MS = 60 * 60 * 1000;

/** After the run is ready, how long to wait for agentd's "pi ready" before showing the partial
 * total anyway (pi died while loading, or the frame was lost). */
export const PI_READY_GRACE_MS = 2 * 60 * 1000;

function clampMs(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.round(Math.min(max, Math.max(0, value)));
}

/** hello.boot, checked: unknown keys dropped, each value a clamped whole number of ms. undefined
 * when nothing usable is left (an older agentd sends no `boot` at all). */
export function parseBootTimings(raw: unknown): AgentdBootTimings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: AgentdBootTimings = {};
  for (const [key, max] of Object.entries(BOOT_LIMITS_MS) as Array<[keyof typeof BOOT_LIMITS_MS, number]>) {
    const value = clampMs((raw as Record<string, unknown>)[key], max);
    if (value !== undefined) out[key] = value;
  }
  const preBooted = (raw as Record<string, unknown>).preBooted;
  if (typeof preBooted === "boolean") out.preBooted = preBooted;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The `startup` frame's `phases`, checked: known names only, first occurrence of each, clamped
 * ms. undefined when nothing usable is left. */
export function parseStartupPhases(raw: unknown): StartupPhase[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: StartupPhase[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, STARTUP_PHASE_NAMES.length * 2)) {
    if (!item || typeof item !== "object") continue;
    const name = (item as Record<string, unknown>).name;
    if (typeof name !== "string" || !PHASE_NAMES.has(name) || seen.has(name)) continue;
    const ms = clampMs((item as Record<string, unknown>).ms, PHASE_MAX_MS);
    if (ms === undefined) continue;
    seen.add(name);
    out.push({ name, ms });
  }
  // In time order, whatever order agentd listed them in (a stable sort keeps ties as sent).
  out.sort((a, b) => a.ms - b.ms);
  return out.length > 0 ? out : undefined;
}

export interface StartupDetail {
  label: string;
  ms: number;
}

export interface StartupSegment {
  id: "request" | "sandbox" | "workspace" | "pi";
  label: string;
  ms: number;
  details?: StartupDetail[];
}

/** What the web UI shows and the log line records. Sent as `startup` on GET /api/sessions/:id and
 * on SSE `status` events. */
export interface StartupSummary {
  runId: string;
  provider?: string;
  warm?: boolean;
  /** Wake -> pi ready when agentd reported it, else wake -> ready. */
  totalMs: number;
  /** false only while the partial total is still expected to grow (see PI_READY_GRACE_MS). */
  complete: boolean;
  segments: StartupSegment[];
}

function at(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

function phaseMs(phases: StartupPhase[] | undefined, name: string): number | undefined {
  return phases?.find((p) => p.name === name)?.ms;
}

const nonNegative = (n: number) => Math.max(0, Math.round(n));

/**
 * Whether the run got a warm sandbox. The provider's own answer wins when it has one (GKE cold mode
 * says false; warm mode says true only when its one GET after create already saw the claim adopted
 * and Ready, so it is usually undefined). Otherwise, for GKE only, it is worked out from agentd:
 *  - boot.preBooted: agentd waited more than a second for its assignment, so the pod sat in the pool;
 *  - the pod's boot on the api clock, helloAt - boot.bootMs (agentd's own boot->hello duration, so
 *    no sandbox clock is involved), came before the wake by more than WARM_BOOT_SLACK_MS.
 * A cold fallback pod in warm mode (the pool was empty) also waits on its assignment files, but finds
 * them on the first poll and boots after the wake, so both signals say cold. Other providers (Cloud
 * Run, docker, inprocess) have no warm pool: unknown, and left out.
 */
export function deriveWarm(s: RunStartup): boolean | undefined {
  if (typeof s.warm === "boolean") return s.warm;
  if (s.provider !== "gke" || !s.agentd) return undefined;
  if (s.agentd.preBooted === true) return true;
  const wake = at(s.wakeAt);
  const hello = at(s.helloAt);
  if (wake === undefined || hello === undefined || s.agentd.bootMs === undefined) return undefined;
  return hello - s.agentd.bootMs < wake - WARM_BOOT_SLACK_MS;
}

/** The per-step breakdown of a run's start, or null while it hasn't started (no readyAt and no
 * "pi ready" yet) or for a run that predates Run.startup. Segments always add up to totalMs. */
export function summarizeStartup(run: Pick<Run, "id" | "startup">, now = Date.now()): StartupSummary | null {
  const s: RunStartup | undefined = run.startup;
  if (!s) return null;
  const wake = at(s.wakeAt);
  const ready = at(s.readyAt);
  const hello = at(s.helloAt);
  const specSent = at(s.specSentAt);
  const piReadyMs = phaseMs(s.phases, "pi ready");
  const piSpawnedMs = phaseMs(s.phases, "pi spawned");
  if (wake === undefined || (ready === undefined && (piReadyMs === undefined || specSent === undefined))) return null;

  const segments: StartupSegment[] = [];
  // Boundaries on the api's clock, kept in order: a hello that beats provider.start()'s return
  // (possible on a warm claim) just makes "requesting" end at the hello.
  const helloT = hello ?? specSent ?? ready ?? wake;
  const providerT = Math.min(at(s.providerReturnedAt) ?? helloT, helloT);
  segments.push({ id: "request", label: "Requesting a sandbox", ms: nonNegative(providerT - wake) });

  const sandboxMs = nonNegative(helloT - providerT);
  const a = s.agentd;
  const warm = deriveWarm(s);
  const sandboxDetails: StartupDetail[] = [];
  if (a) {
    const agentdOwn = a.sinceAssignedMs;
    if (agentdOwn !== undefined) {
      const before = nonNegative(sandboxMs - agentdOwn);
      sandboxDetails.push({ label: warm ? "Handing over the warm sandbox" : "Starting the container", ms: before });
    }
    // On a warm pod the setup ran before the claim, while it idled: not part of this wait. A cold
    // fallback pod (warm mode, empty pool) also has an assignmentWaitMs, but it really did wait for
    // its setup, so this goes by the derived warmth.
    if (a.setupMs !== undefined && warm !== true) sandboxDetails.push({ label: "agentd setup", ms: a.setupMs });
    if (a.identityTokenMs !== undefined) sandboxDetails.push({ label: "Identity token", ms: a.identityTokenMs });
    if (a.connectMs !== undefined) sandboxDetails.push({ label: "Connecting to Outfitter", ms: a.connectMs });
  }
  segments.push({ id: "sandbox", label: "Sandbox starting", ms: sandboxMs, ...(sandboxDetails.length ? { details: sandboxDetails } : {}) });

  const specT = Math.max(specSent ?? helloT, helloT);
  const specMs = nonNegative(specT - helloT);
  let totalMs: number;
  if (piReadyMs !== undefined && specSent !== undefined) {
    // agentd measured everything after run.spec on its own clock.
    const spawned = Math.min(piSpawnedMs ?? piReadyMs, piReadyMs);
    const details: StartupDetail[] = [{ label: "Run spec (secrets, tokens)", ms: specMs }];
    let prev = 0;
    for (const p of s.phases ?? []) {
      if (p.name === "run.spec received" || p.name === "pi ready") continue;
      if (p.ms > spawned) continue;
      details.push({ label: phaseLabel(p.name), ms: nonNegative(p.ms - prev) });
      prev = p.ms;
    }
    segments.push({ id: "workspace", label: "Preparing the workspace", ms: specMs + spawned, details });
    segments.push({ id: "pi", label: "Loading pi", ms: nonNegative(piReadyMs - spawned) });
    totalMs = segments.reduce((sum, seg) => sum + seg.ms, 0);
  } else {
    // No agentd phases (an older agentd, or "pi ready" not in yet): stop at ready.
    const readyT = Math.max(ready ?? specT, specT);
    segments.push({ id: "workspace", label: "Preparing the workspace", ms: specMs + nonNegative(readyT - specT) });
    totalMs = segments.reduce((sum, seg) => sum + seg.ms, 0);
  }

  // A newer agentd (it sent hello.boot) will report "pi ready" shortly after ready; until then the
  // total is partial. Older agentd never will, and a run whose pi never got ready stops waiting.
  const complete =
    piReadyMs !== undefined || !a || ready === undefined || now - ready >= PI_READY_GRACE_MS;

  return {
    runId: run.id,
    ...(s.provider ? { provider: s.provider } : {}),
    ...(warm !== undefined ? { warm } : {}),
    totalMs,
    complete,
    segments,
  };
}

function phaseLabel(name: string): string {
  switch (name) {
    case "repo cloned":
      return "Cloning the repo";
    case "workspace restored":
      return "Restoring the workspace";
    case "session import done":
      return "Importing the session";
    case "pi spawned":
      return "Starting pi";
    default:
      return name;
  }
}

/** The structured log line written once "pi ready" arrives, for Cloud Logging queries like
 * jsonPayload.message="startup summary". */
export function startupLogLine(summary: StartupSummary): Record<string, unknown> {
  return {
    severity: "INFO",
    message: "startup summary",
    runId: summary.runId,
    provider: summary.provider,
    warm: summary.warm,
    totalMs: summary.totalMs,
    ...Object.fromEntries(summary.segments.map((seg) => [`${seg.id}Ms`, seg.ms])),
  };
}
