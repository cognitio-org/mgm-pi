// Fleet settings: the settings an operator sets once in the web app (Settings → Telemetry) for every
// Kernal laptop, Drive and Outfitter service, instead of each machine carrying its own copy in env.
// One document in the `fleetSettings` collection (store/types.ts FleetSettingsCollection).
//
// Sentry is the first setting here (#368): where events go (the DSN), whether anything is sent at
// all, and the trace sample rate. Readers:
//   - GET /api/fleet-settings (routes/me.ts): any signed-in caller, a laptop's Dongle included.
//     Kernal's sentry extension caches the answer (kernal/.pi/extensions/_shared/fleet-settings.ts).
//   - the API itself (sentry.ts, through FleetSettingsCache below).
//   - agentd, through run.spec's `telemetry` (agentlink.ts), so a Drive needs no Sentry env either.
//   - the web app (lib/sentry.ts), from GET /api/fleet-settings before it starts Sentry.
// The one writer is PUT /api/operator/fleet-settings (routes/operator.ts), operators only.
//
// Off is the default everywhere: no document, a document with Sentry disabled, or a reader that
// cannot reach the API (a laptop with no Dongle) all mean nothing is sent. The Agent Engine Python
// agent has no API channel at start-up and still reads SENTRY_DSN from its own env.

import type { Store } from "./store/types.ts";

export interface SentryFleetSettings {
  enabled: boolean;
  /** Kept while Sentry is off, so turning it back on needs no re-entry. Never sent to clients
   * while off (clientFleetSettings). */
  dsn?: string;
  /** Fraction of traces kept, 0..1. Errors are always sent in full while enabled. */
  tracesSampleRate: number;
}

export interface FleetSettings {
  telemetry: { sentry: SentryFleetSettings };
  updatedAt?: string;
  updatedBy?: string;
}

/** What a client (Kernal, the web app) is told: the DSN only while Sentry is on. */
export interface ClientFleetSettings {
  telemetry: { sentry: { enabled: false } | { enabled: true; dsn: string; tracesSampleRate: number } };
  updatedAt?: string;
}

export const DEFAULT_TRACES_SAMPLE_RATE = 0.05;

/** The project's own Sentry DSN (the owner's, 2026-10-01), so turning Sentry on is one click with
 * nothing to paste. Stored, never sent anywhere while Sentry is off: off stays the default. A DSN is
 * not a secret (every browser bundle using Sentry ships one). */
export const DEFAULT_SENTRY_DSN = "https://1318f3af9a71b190730c227fb61c32dc@o4512181408432128.ingest.us.sentry.io/4512181422260224";

export function defaultFleetSettings(): FleetSettings {
  return { telemetry: { sentry: { enabled: false, dsn: DEFAULT_SENTRY_DSN, tracesSampleRate: DEFAULT_TRACES_SAMPLE_RATE } } };
}

/** Writes the defaults (Sentry off, with the project DSN kept) when no document exists yet, so the
 * DSN is in the store from the first boot. Never touches a document an operator has saved, even one
 * whose DSN they cleared. True when it wrote one. */
export async function ensureFleetSettings(store: Pick<Store, "fleetSettings">): Promise<boolean> {
  return store.fleetSettings.insertIfAbsent(defaultFleetSettings());
}

/** The stored document with every missing field defaulted; a malformed field reads as its default. */
export function withDefaults(doc: Partial<FleetSettings> | null | undefined): FleetSettings {
  const base = defaultFleetSettings();
  const s = doc?.telemetry?.sentry;
  if (s && typeof s === "object") {
    base.telemetry.sentry = {
      enabled: s.enabled === true,
      ...(typeof s.dsn === "string" && s.dsn ? { dsn: s.dsn } : {}),
      tracesSampleRate: isRate(s.tracesSampleRate) ? s.tracesSampleRate : DEFAULT_TRACES_SAMPLE_RATE,
    };
  }
  if (typeof doc?.updatedAt === "string") base.updatedAt = doc.updatedAt;
  if (typeof doc?.updatedBy === "string") base.updatedBy = doc.updatedBy;
  return base;
}

/** On only with a DSN to send to; a stored `enabled: true` without one reads as off. */
export function sentryOn(s: SentryFleetSettings): s is SentryFleetSettings & { dsn: string } {
  return s.enabled && typeof s.dsn === "string" && s.dsn !== "";
}

export function clientFleetSettings(settings: FleetSettings): ClientFleetSettings {
  const s = settings.telemetry.sentry;
  return {
    telemetry: { sentry: sentryOn(s) ? { enabled: true, dsn: s.dsn, tracesSampleRate: s.tracesSampleRate } : { enabled: false } },
    ...(settings.updatedAt ? { updatedAt: settings.updatedAt } : {}),
  };
}

function isRate(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** A Sentry DSN: http(s)://<public key>@<host>/<numeric project id>. Not a secret (it ships in
 * every browser bundle that uses Sentry), but a typo would silently send nothing anywhere. */
export function isSentryDsn(value: string): boolean {
  if (value.length > 300) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.username !== "" && !url.password && /^\/\d+$/.test(url.pathname) && !url.search && !url.hash;
}

/** Validates PUT /api/operator/fleet-settings' body: the whole `telemetry.sentry` section. An empty
 * DSN removes it; turning Sentry on needs one. */
export function parseSentryUpdate(body: unknown): { value: SentryFleetSettings } | { error: string } {
  const s = (body as { telemetry?: { sentry?: unknown } } | undefined)?.telemetry?.sentry as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return { error: "telemetry.sentry is required" };
  if (typeof s.enabled !== "boolean") return { error: "telemetry.sentry.enabled must be true or false" };
  if (s.dsn !== undefined && typeof s.dsn !== "string") return { error: "telemetry.sentry.dsn must be a string" };
  const dsn = typeof s.dsn === "string" ? s.dsn.trim() : "";
  if (dsn && !isSentryDsn(dsn)) return { error: "telemetry.sentry.dsn is not a Sentry DSN (https://<key>@<host>/<project id>)" };
  if (s.enabled && !dsn) return { error: "a DSN is required to turn Sentry on" };
  const rate = s.tracesSampleRate === undefined ? DEFAULT_TRACES_SAMPLE_RATE : s.tracesSampleRate;
  if (!isRate(rate)) return { error: "telemetry.sentry.tracesSampleRate must be a number from 0 to 1" };
  return { value: { enabled: s.enabled, ...(dsn ? { dsn } : {}), tracesSampleRate: rate } };
}

/** The stored settings, re-read at most every `maxAgeMs`. Cloud Run gives an instance CPU only
 * while it serves a request, so instead of a timer the readers (a request's onRequest hook, a
 * run.spec) ask for a refresh when the copy is stale -- the same shape as ProviderStatusService's
 * refreshIfStale. An operator's change reaches every instance within `maxAgeMs`; the instance
 * that took the PUT sees it at once (set()). A failed read keeps the last good copy. */
export class FleetSettingsCache {
  private value: FleetSettings | undefined;
  private readAt = 0;
  /** Bumped by every set(): a read that started before an operator's PUT must not undo it. */
  private generation = 0;
  private inflight: Promise<FleetSettings> | undefined;
  private readonly listeners: Array<(s: FleetSettings) => void> = [];
  private readonly store: Pick<Store, "fleetSettings">;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(store: Pick<Store, "fleetSettings">, maxAgeMs = 60_000, now: () => number = Date.now) {
    this.store = store;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
  }

  /** The current settings, read from the store first when stale. */
  async get(): Promise<FleetSettings> {
    if (this.value && this.now() - this.readAt < this.maxAgeMs) return this.value;
    if (this.inflight) return this.inflight;
    const startedAt = this.generation;
    const read = this.store.fleetSettings
      .get()
      .then((doc) => {
        if (this.generation !== startedAt && this.value) return this.value; // a newer copy won
        const settings = withDefaults(doc);
        this.set(settings);
        return settings;
      })
      .catch((err) => {
        // Keep serving the last good copy; without one, off. Retry on the next call.
        console.warn(`[fleet-settings] read failed: ${err instanceof Error ? err.message : String(err)}`);
        return this.value ?? defaultFleetSettings();
      })
      .finally(() => {
        this.inflight = undefined;
      });
    this.inflight = read;
    return read;
  }

  /** Fire-and-forget refresh for callers that must not wait (a request hook). */
  refreshIfStale(): void {
    void this.get();
  }

  set(settings: FleetSettings): void {
    this.generation++;
    this.value = settings;
    this.readAt = this.now();
    for (const listener of this.listeners) listener(settings);
  }

  /** Called with every new copy (sentry.ts applies the Sentry section). */
  onChange(listener: (s: FleetSettings) => void): void {
    this.listeners.push(listener);
  }
}
