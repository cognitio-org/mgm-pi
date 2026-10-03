// Sentry (error reporting + tracing) for the API process, switched by the fleet settings an operator
// sets in the web app (fleet-settings.ts), not by this process's env. Off until those settings say
// on, and every export here is a harmless no-op while off, so call sites never need their own "is
// Sentry on" branch.
//
// buildApp (server.ts) owns the FleetSettingsCache and calls applySentrySettings with every copy it
// reads, so an operator's change reaches each instance within the cache's refresh window:
//   - off → on: the SDK starts then (Sentry.init runs at most once per process).
//   - on → off, or a new sample rate: applied at once; beforeSend/tracesSampler read the live state.
//   - a new DSN: the SDK's DSN is fixed once it starts, so this instance sends nothing until it
//     restarts (the next deploy, or Cloud Run replacing it) rather than keep sending to the old one.

import * as Sentry from "@sentry/node";
import type { FastifyInstance } from "fastify";
import { sentryOn, type SentryFleetSettings } from "./fleet-settings.ts";

export interface SentryRuntime {
  /** The outfitter-v* tag (OUTFITTER_RELEASE); empty in dev. */
  release: string;
  environment: string;
  /** Tests only: where events go instead of the network. */
  transport?: Sentry.NodeOptions["transport"];
}

let initialized = false;
let initDsn: string | undefined;
let sending = false;
let tracesSampleRate = 0;

/** Applies the fleet settings' Sentry section to this process (see the module comment). */
export function applySentrySettings(settings: SentryFleetSettings, runtime: SentryRuntime): void {
  if (!sentryOn(settings)) {
    sending = false;
    return;
  }
  tracesSampleRate = settings.tracesSampleRate;
  if (!initialized) {
    const makeTransport = runtime.transport ?? Sentry.makeNodeTransport;
    Sentry.init({
      dsn: settings.dsn,
      environment: runtime.environment,
      ...(runtime.release ? { release: runtime.release } : {}),
      // Defaults minus OnUnhandledRejection: its listener would turn Node's crash on an unhandled
      // rejection into a warning, for the rest of the process even after Sentry is turned off.
      integrations: (defaults) => defaults.filter((i) => i.name !== "OnUnhandledRejection"),
      // No sentry-trace/baggage headers on outbound calls (GitHub, LiteLLM, GCP, ngrok): the SDK's
      // default is every host, and it keeps adding them while Sentry is off.
      tracePropagationTargets: [],
      // Live gates: the SDK keeps running once started, so turning Sentry off (or changing the
      // rate) must be read per event, not baked into init.
      tracesSampler: () => (sending ? tracesSampleRate : 0),
      // Never the request itself: its headers carry Dongles and IAP assertions, and an operator
      // route's body can be a secret's value. (The SDK starts after Fastify and http are loaded, so
      // its request instrumentation is not hooked in today; this holds if that ever changes.)
      beforeSend: (event) => {
        if (!sending) return null;
        if (event.request) event.request = { method: event.request.method, url: event.request.url?.split("?")[0] };
        return event;
      },
      beforeSendTransaction: (event) => (sending ? event : null),
      // And at the wire: client reports (counts of what the gates dropped) and sessions bypass the
      // hooks above. While off, nothing at all leaves this process.
      transport: (options) => {
        const wire = makeTransport(options);
        return { send: (envelope) => (sending ? wire.send(envelope) : Promise.resolve({})), flush: (timeout) => wire.flush(timeout) };
      },
    });
    initialized = true;
    initDsn = settings.dsn;
  }
  sending = settings.dsn === initDsn;
}

/** Whether events are being sent right now. */
export function sentryEnabled(): boolean {
  return sending;
}

/** Adds Sentry's Fastify error hook (captures unhandled route errors, status >= 500 by default)
 * without replacing the app's own setErrorHandler. Installed whether or not Sentry is on yet --
 * it can turn on later -- and a no-op while off (no client, or beforeSend drops the event). */
export function installSentryErrorHandler(fastify: FastifyInstance): void {
  Sentry.setupFastifyErrorHandler(fastify);
}

/** Sends what is queued before the process exits (Cloud Run's SIGTERM). Returns at once while
 * Sentry was never started. */
export async function closeSentry(timeoutMs = 2000): Promise<void> {
  if (initialized) await Sentry.close(timeoutMs).catch(() => undefined);
}

/** Test-only: forgets the SDK state so the next applySentrySettings starts a fresh client. */
export async function resetSentryForTests(): Promise<void> {
  await Sentry.getClient()?.close(0);
  initialized = false;
  initDsn = undefined;
  sending = false;
  tracesSampleRate = 0;
}

export { Sentry };
