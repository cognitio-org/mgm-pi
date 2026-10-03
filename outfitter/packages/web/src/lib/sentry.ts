// Sentry error/performance monitoring for the browser app, switched by the fleet settings an
// operator sets on the Settings page (Telemetry): main.tsx calls initSentry() as the app starts, it
// reads GET /api/fleet-settings, and only an `enabled: true` answer (which carries the DSN) starts
// the SDK. Off, unreachable, or signed out: nothing is sent. The render does not wait for it, so a
// crash in the very first render, before the answer arrives, is not reported.
//
// A change on the Settings page applies to each browser on its next load.
import * as Sentry from "@sentry/react";
import { api, type ClientFleetSettings } from "../api/client.ts";

let initialized = false;

export function isSentryInitialized(): boolean {
  return initialized;
}

/** Starts the Sentry browser SDK when the fleet settings say so. Resolves to whether it did; never
 * throws (a failed read means off). Only the first successful call takes effect.
 *
 * Replay stays free-tier-friendly whatever the trace rate: replaysSessionSampleRate 0 (no replay for
 * ordinary sessions -- replay storage is the first thing a free plan runs out of) and
 * replaysOnErrorSampleRate 1 (once a session throws, its replay buffer is kept), the "error-only
 * replay" pattern Sentry's own docs recommend.
 */
export async function initSentry(load: () => Promise<ClientFleetSettings> = () => api.fleetSettings()): Promise<boolean> {
  if (initialized) return true;
  let settings: ClientFleetSettings;
  try {
    settings = await load();
  } catch {
    return false;
  }
  const sentry = settings.telemetry?.sentry;
  if (!sentry?.enabled || !sentry.dsn) return false;
  Sentry.init({
    dsn: sentry.dsn,
    integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    tracesSampleRate: sentry.tracesSampleRate,
    replaysSessionSampleRate: 0.0,
    replaysOnErrorSampleRate: 1.0,
  });
  initialized = true;
  return true;
}
