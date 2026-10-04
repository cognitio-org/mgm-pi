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
// The writers are PUT /api/operator/fleet-settings (routes/operator.ts) and, for every fleet-level
// key of the central settings schema (#392), PUT /api/operator/config/fleet (routes/config.ts);
// operators only, both through updateFleetSettings, which bumps `version`.
//
// Off is the default everywhere: no document, a document with Sentry disabled, or a reader that
// cannot reach the API (a laptop with no Dongle) all mean nothing is sent. The Agent Engine Python
// agent has no API channel at start-up and still reads SENTRY_DSN from its own env.

import type { Store } from "./store/types.ts";
import type { SettingValue } from "./central/settings-schema.ts";

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
  /** #392 central settings (docs/specs/central-auth.md §3.3): the fleet level's values for every
   * other schema key (central/settings-schema.ts). The three `telemetry.sentry.*` keys are never
   * here: they stay in `telemetry.sentry` above, which older readers know. */
  values?: Record<string, SettingValue>;
  /** Bumped by every write (both PUTs); absent means 0. The fleet ETag (§3.5). */
  version?: number;
  updatedAt?: string;
  updatedBy?: string;
}

/** What a client (Kernal, the web app) is told: the DSN only while Sentry is on. `release` (#421)
 * is this deploy's outfitter-v* tag (OUTFITTER_RELEASE), there only while on and only on a tagged
 * deploy: the web app reports under it, so its events land on the Sentry release the deploy workflow
 * created. Kernal ignores it (a laptop reports its own kernal@X.Y.Z). */
export interface ClientFleetSettings {
  telemetry: { sentry: { enabled: false } | { enabled: true; dsn: string; tracesSampleRate: number; release?: string } };
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
  const values = fleetValues(doc?.values);
  if (values) base.values = values;
  if (typeof doc?.version === "number" && Number.isInteger(doc.version) && doc.version > 0) base.version = doc.version;
  if (typeof doc?.updatedAt === "string") base.updatedAt = doc.updatedAt;
  if (typeof doc?.updatedBy === "string") base.updatedBy = doc.updatedBy;
  return base;
}

/** The stored `values` with anything that isn't a plain value, and the Sentry keys (which live in
 * `telemetry.sentry`), dropped. Undefined when nothing is left. Type checks against the schema
 * happen in the resolver, which skips a value that no longer fits. */
function fleetValues(raw: unknown): Record<string, SettingValue> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith(SENTRY_KEY_PREFIX)) continue;
    if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The schema keys that are read from, and written to, `telemetry.sentry` instead of `values`. */
export const SENTRY_KEY_PREFIX = "telemetry.sentry.";

/** Writes the fleet document through `change` (given the current one, defaults filled in) and
 * bumps `version`, only if the stored version is still `expectedVersion`; without one, retries a
 * few times against concurrent writers, so the operator PUT (no If-Match) still never loses a
 * version bump. Answers the stored document, or the current one when the version didn't match. */
export async function updateFleetSettings(
  store: Pick<Store, "fleetSettings">,
  change: (current: FleetSettings) => FleetSettings,
  expectedVersion?: number,
): Promise<{ ok: true; settings: FleetSettings } | { ok: false; current: FleetSettings }> {
  for (let attempt = 0; ; attempt++) {
    const current = withDefaults(await store.fleetSettings.get());
    const version = current.version ?? 0;
    if (expectedVersion !== undefined && version !== expectedVersion) return { ok: false, current };
    const next = { ...change(current), version: version + 1 };
    if (await store.fleetSettings.replaceAtVersion(next, version)) return { ok: true, settings: next };
    if (expectedVersion !== undefined || attempt >= 4) return { ok: false, current: withDefaults(await store.fleetSettings.get()) };
  }
}

/** On only with a DSN to send to; a stored `enabled: true` without one reads as off. */
export function sentryOn(s: SentryFleetSettings): s is SentryFleetSettings & { dsn: string } {
  return s.enabled && typeof s.dsn === "string" && s.dsn !== "";
}

export function clientFleetSettings(settings: FleetSettings, opts: { release?: string } = {}): ClientFleetSettings {
  const s = settings.telemetry.sentry;
  return {
    telemetry: {
      sentry: sentryOn(s)
        ? { enabled: true, dsn: s.dsn, tracesSampleRate: s.tracesSampleRate, ...(opts.release ? { release: opts.release } : {}) }
        : { enabled: false },
    },
    ...(settings.updatedAt ? { updatedAt: settings.updatedAt } : {}),
  };
}

function isRate(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** A Sentry DSN: https://<public key>@<host>/<numeric project id> (http:// too with `allowHttp`,
 * for a local test sink in dev). Not a secret (it ships in every browser bundle that uses Sentry),
 * but a typo would silently send nothing anywhere, and http:// would send stack traces in clear. */
export function isSentryDsn(value: string, allowHttp = false): boolean {
  if (value.length > 300) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || (allowHttp && url.protocol === "http:")) && url.username !== "" && !url.password && /^\/\d+$/.test(url.pathname) && !url.search && !url.hash;
}

/** Validates PUT /api/operator/fleet-settings' body: the whole `telemetry.sentry` section. An empty
 * DSN removes it; turning Sentry on needs one. */
export function parseSentryUpdate(body: unknown, opts: { allowHttp?: boolean } = {}): { value: SentryFleetSettings } | { error: string } {
  const s = (body as { telemetry?: { sentry?: unknown } } | undefined)?.telemetry?.sentry as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return { error: "telemetry.sentry is required" };
  if (typeof s.enabled !== "boolean") return { error: "telemetry.sentry.enabled must be true or false" };
  if (s.dsn !== undefined && typeof s.dsn !== "string") return { error: "telemetry.sentry.dsn must be a string" };
  const dsn = typeof s.dsn === "string" ? s.dsn.trim() : "";
  if (dsn && !isSentryDsn(dsn, opts.allowHttp)) return { error: "telemetry.sentry.dsn is not a Sentry DSN (https://<key>@<host>/<project id>)" };
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
