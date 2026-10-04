/**
 * Fleet settings: what an Outfitter operator set once for every machine (Settings → Telemetry in the
 * web app; outfitter/packages/api/src/fleet-settings.ts), read with this laptop's Dongle from
 * GET /api/fleet-settings. Sentry is the first setting here; more will follow the same path.
 *
 * Start-up never waits for the network. `cachedFleetSettings` returns the last answer at once, from a
 * file beside the release bundles (so it survives upgrades, like kernal-update's check cache), and
 * `refreshFleetSettings` fetches a fresh one in the background and rewrites the file. A change made
 * in Outfitter is therefore in force on this laptop from its next Kernal start, or later in the
 * session if the refresh lands first and the caller applies it.
 *
 * No Dongle (OUTFITTER_API/OUTFITTER_TOKEN unset) means no fleet settings at all, cached or not:
 * every setting is at its off/default value. The cache remembers which OUTFITTER_API answered, so
 * pointing Kernal at another Outfitter never applies the previous one's settings.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { env } from "./env.ts";
import { outfitterBearer, sendWithBearer, type OutfitterCredentials } from "./outfitter-env.ts";

export type SentrySettings = { enabled: false } | { enabled: true; dsn: string; tracesSampleRate: number };

export interface FleetSettings {
  telemetry: { sentry: SentrySettings };
  updatedAt?: string;
}

interface CacheFile {
  api: string;
  fetchedAt: string;
  settings: FleetSettings;
}

const OFF: FleetSettings = { telemetry: { sentry: { enabled: false } } };
const FETCH_TIMEOUT_MS = 5_000;
/** A cached answer older than this reads as off: a laptop that has not reached its Outfitter in a
 * month no longer follows what it said then. */
export const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Beside the bundles: ~/.kernal/.fleet-settings.json for a release, ~/localllm/.fleet-settings.json
 * for a source checkout (the same rule as kernal-update's .update-check.json). */
export function fleetSettingsCachePath(): string {
  const override = env("FLEET_SETTINGS_CACHE");
  if (override) return override;
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(dirname(agentDir), "..", ".fleet-settings.json");
}

/** The answer's shape checked field by field; anything unexpected reads as off. */
export function parseFleetSettings(json: unknown): FleetSettings {
  const s = (json as { telemetry?: { sentry?: Record<string, unknown> } } | null)?.telemetry?.sentry;
  const updatedAt = (json as { updatedAt?: unknown } | null)?.updatedAt;
  const base = typeof updatedAt === "string" ? { updatedAt } : {};
  if (!s || s.enabled !== true || typeof s.dsn !== "string" || !/^https?:\/\/[^/@\s]+@[^/\s]+\/\d+$/.test(s.dsn)) {
    return { telemetry: { sentry: { enabled: false } }, ...base };
  }
  const rate = typeof s.tracesSampleRate === "number" && s.tracesSampleRate >= 0 && s.tracesSampleRate <= 1 ? s.tracesSampleRate : 0;
  return { telemetry: { sentry: { enabled: true, dsn: s.dsn, tracesSampleRate: rate } }, ...base };
}

/** The last answer from this laptop's Outfitter, or off: no Dongle, nothing cached yet, an
 * unreadable file, or a file another OUTFITTER_API wrote. */
export function cachedFleetSettings(creds: OutfitterCredentials, file = fleetSettingsCachePath(), now = Date.now()): FleetSettings {
  if (!creds.api || !creds.token) return OFF;
  try {
    const cache = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheFile>;
    if (cache.api !== creds.api) return OFF;
    const age = now - Date.parse(cache.fetchedAt ?? "");
    if (!(age >= 0 && age < MAX_CACHE_AGE_MS)) return OFF;
    return parseFleetSettings(cache.settings);
  } catch {
    return OFF;
  }
}

/** Fetches the current settings and caches them; off when Outfitter refuses the Dongle. Undefined
 * when there is no Dongle or the API could not answer (offline, a 5xx, an Outfitter without fleet
 * settings yet): the caller keeps what it has. Never throws. */
export async function refreshFleetSettings(
  creds: OutfitterCredentials,
  opts: { fetch?: typeof fetch; file?: string; timeoutMs?: number } = {},
): Promise<FleetSettings | undefined> {
  if (!creds.api || !creds.token) return undefined;
  const doFetch = opts.fetch ?? fetch;
  let settings: FleetSettings;
  try {
    const signal = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS);
    // A 401 for a session token is retried once with a newer one before it counts as a refusal.
    const res = await sendWithBearer(
      (rejected) => outfitterBearer(creds, rejected),
      (token) =>
        doFetch(`${creds.api!.replace(/\/+$/, "")}/api/fleet-settings`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          signal,
        }),
    );
    // A refused Dongle (revoked, expired) is an answer, not an outage: the cached "on" must not
    // outlive it, so it is replaced with off. Anything else (5xx, an older Outfitter) keeps it.
    if (res.status === 401 || res.status === 403) settings = OFF;
    else if (!res.ok) return undefined;
    else settings = parseFleetSettings(await res.json());
  } catch {
    return undefined;
  }
  const file = opts.file ?? fleetSettingsCachePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const cache: CacheFile = { api: creds.api, fetchedAt: new Date().toISOString(), settings };
    // Written whole then renamed: a second Kernal starting at the same moment never reads half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
    renameSync(tmp, file);
  } catch {
    // An unwritable cache only means the next start reads the network's answer a little later.
  }
  return settings;
}
