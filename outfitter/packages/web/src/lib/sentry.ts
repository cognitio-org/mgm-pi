// Sentry error/performance monitoring for the browser app. Initialized once from main.tsx before
// the app renders, so a crash during the very first render still reaches Sentry. The default DSN
// below is this project's public Sentry DSN (safe to ship in a browser bundle -- DSNs are not
// secrets, same as every other Sentry browser SDK deployed in the wild); VITE_SENTRY_DSN lets a
// fork or a different environment (e.g. a staging build) point at a different Sentry project
// without editing source.
import * as Sentry from "@sentry/react";

const DEFAULT_DSN = "https://1318f3af9a71b190730c227fb61c32dc@o4512181408432128.ingest.us.sentry.io/4512181422260224";

/** True once initSentry has run. Lets callers (the ErrorBoundary) tell a real "Sentry never
 * initialized" state apart from "Sentry initialized but had nothing to report". */
let initialized = false;

export function isSentryInitialized(): boolean {
  return initialized;
}

/** Initializes the Sentry browser SDK. Safe to call more than once (Sentry.init replaces the
 * previous client instead of stacking clients) -- tests that need a clean slate call this again
 * rather than reaching into SDK internals.
 *
 * Sample rates are deliberately low/free-tier-friendly:
 * - tracesSampleRate 0.05: a trace for 1 in 20 page loads/navigations, enough to catch
 *   performance regressions without burning the whole trace quota.
 * - replaysSessionSampleRate 0.0: no session replay for ordinary sessions -- replay storage is
 *   the first thing a free Sentry plan runs out of.
 * - replaysOnErrorSampleRate 1.0: once a session actually throws, capture its replay buffer so
 *   there's a recording of the crash to look at. This is the "error-only replay" free-tier
 *   pattern Sentry's own docs recommend.
 */
export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim() || DEFAULT_DSN;
  if (!dsn) {
    initialized = false;
    return;
  }

  Sentry.init({
    dsn,
    integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    tracesSampleRate: 0.05,
    replaysSessionSampleRate: 0.0,
    replaysOnErrorSampleRate: 1.0,
  });
  initialized = true;
}
