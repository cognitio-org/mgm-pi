// Sentry (error reporting + tracing) for the API process. SENTRY_DSN unset (the dev default,
// config.ts) means initSentry() is a no-op and every other export in this file degrades to a
// harmless no-op too, so call sites don't need their own "is Sentry on" branch.
//
// Call initSentry() once, before buildApp() registers routes, then call
// installSentryErrorHandler(fastify) after the Fastify instance exists (server.ts) so Sentry's
// onError hook runs alongside (not instead of) the app's own error handling.

import * as Sentry from "@sentry/node";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.ts";

/** 5% of requests get a trace (owner-specified default; see task). Errors are always reported
 * regardless of sampling -- tracesSampleRate only governs performance spans. */
const TRACES_SAMPLE_RATE = 0.05;

let initialized = false;

/** Starts the Sentry Node SDK for this process. Safe to call with an empty DSN (does nothing) and
 * safe to call more than once (only the first call takes effect). */
export function initSentry(config: Pick<Config, "sentryDsn" | "release">): void {
  if (!config.sentryDsn || initialized) return;
  Sentry.init({
    dsn: config.sentryDsn,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    integrations: [Sentry.fastifyIntegration()],
    ...(config.release ? { release: config.release } : {}),
  });
  initialized = true;
}

export function sentryEnabled(): boolean {
  return initialized;
}

/** Adds Sentry's Fastify error hook (captures unhandled route errors, status >= 500 by default)
 * without replacing the app's own setErrorHandler. A no-op if initSentry() was never called (or
 * ran with no DSN), so routes see no behavior change when Sentry is off. */
export function installSentryErrorHandler(fastify: FastifyInstance): void {
  if (!initialized) return;
  Sentry.setupFastifyErrorHandler(fastify);
}

/** Reports an error Sentry wouldn't otherwise see (e.g. one caught and handled outside a Fastify
 * request, like the background run reconciler). A no-op when Sentry is off. */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

/** Wraps an async task in a Sentry span (e.g. a background job tick) so it shows up in tracing
 * alongside request spans, at the same 5% sample rate. Runs the task directly, untraced, when
 * Sentry is off -- callers don't need to branch on sentryEnabled(). */
export async function withSentrySpan<T>(name: string, op: string, task: () => Promise<T>): Promise<T> {
  if (!initialized) return task();
  return Sentry.startSpan({ name, op }, task);
}

/** Test-only: resets the module's "already initialized" guard so each test gets a clean slate. */
export function resetSentryForTests(): void {
  initialized = false;
}

export { Sentry };
