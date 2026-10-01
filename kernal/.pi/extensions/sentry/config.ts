/**
 * Sentry configuration: pure functions over `process.env`-shaped objects, so the test suite can
 * check every default and override without touching the network or @sentry/node. See index.ts for
 * how this feeds `@sentry/node`'s `init()`.
 *
 * Env vars (the plain names, not KERNAL_-prefixed: Sentry's own docs and every other Sentry SDK use
 * these, and a person wiring up a dashboard follows that convention, not kernal's):
 *   SENTRY_DSN                  where events go. Defaults to this project's Sentry project, so
 *                                errors and traces land somewhere without extra setup; set to the
 *                                empty string to opt out entirely (see `enabled`).
 *   SENTRY_ENVIRONMENT           tag separating e.g. a laptop checkout from a packaged release.
 *                                Defaults to "development" outside a packaged bundle, "production"
 *                                inside one (installedVersion() in kernal-update/lib.ts is how the
 *                                rest of kernal tells those apart).
 *   SENTRY_TRACES_SAMPLE_RATE    fraction of agent turns/tool calls traced (0..1). Default 0.05.
 */
export const DEFAULT_DSN = "https://1318f3af9a71b190730c227fb61c32dc@o4512181408432128.ingest.us.sentry.io/4512181422260224";
export const DEFAULT_TRACES_SAMPLE_RATE = 0.05;
/** Errors are always worth the event quota they cost: 100%, independent of the trace sample rate. */
export const ERROR_SAMPLE_RATE = 1;

export interface SentryConfig {
  /** undefined (not empty string) means "do not call Sentry.init at all". */
  dsn: string | undefined;
  environment: string;
  tracesSampleRate: number;
  enabled: boolean;
}

/** Clamp to [0, 1]; NaN (unset or unparsable) falls back to `fallback`. */
export function parseSampleRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** True once a release bundle (not a source checkout) is running; see kernal-update/lib.ts. */
export function defaultEnvironment(isPackagedBundle: boolean): string {
  return isPackagedBundle ? "production" : "development";
}

/**
 * Builds the config from an env map. `SENTRY_DSN` set to the empty string is an explicit opt-out
 * (distinct from "unset", which takes the default DSN): a person or CI job that wants no telemetry
 * sets `SENTRY_DSN=` rather than hunting for a separate kill switch.
 */
export function sentryConfig(env: Record<string, string | undefined>, isPackagedBundle: boolean): SentryConfig {
  const dsnRaw = env.SENTRY_DSN;
  const dsn = dsnRaw === undefined ? DEFAULT_DSN : dsnRaw.trim() === "" ? undefined : dsnRaw.trim();
  const environment = env.SENTRY_ENVIRONMENT?.trim() || defaultEnvironment(isPackagedBundle);
  const tracesSampleRate = parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, DEFAULT_TRACES_SAMPLE_RATE);
  return { dsn, environment, tracesSampleRate, enabled: dsn !== undefined };
}
