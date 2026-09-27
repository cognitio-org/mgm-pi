// A run's sandbox for the session page (#196, #197): details, stats and logs. Web role only, and
// readable by anyone who can open the session, the same audience as its transcript (owner decision
// on #196). `runId` selects one of the session's runs; it must belong to this session, so one
// session's page can't read another's logs.

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import type { Run } from "../store/types.ts";
import { getSessionOr404 } from "./sessions.ts";
import { providerNameFor } from "../runs.ts";
import { TelemetryUnavailable, isRunId } from "../sandbox-telemetry.ts";

/** Stats history starts this long before the run was created (a warm pod exists before its
 * claim) and ends when it was last seen, or now while it's live. */
const METRICS_LEAD_MS = 2 * 60_000;
/** Cap on one metrics window: Monitoring keeps six weeks, and a run's minute points past a day are
 * more than the page can draw. */
const METRICS_MAX_MS = 24 * 60 * 60_000;

function isActive(run: Run): boolean {
  return run.state !== "stopped" && run.state !== "failed";
}

/** The session's run a request means: `runId` if given (and this session's), else the active run,
 * else the latest. Undefined when there is none or the id isn't this session's. */
async function runFor(ctx: RouteContext, sessionId: string, runId: string | undefined): Promise<Run | undefined> {
  if (runId !== undefined) {
    if (!isRunId(runId)) return undefined;
    const run = await ctx.store.runs.findById(runId);
    return run && run.sessionId === sessionId ? run : undefined;
  }
  return (await ctx.store.runs.findActiveForSession(sessionId)) ?? (await ctx.store.runs.findLatestForSession(sessionId)) ?? undefined;
}

function telemetryError(reply: { code: (n: number) => { send: (body: unknown) => unknown } }, err: unknown) {
  if (err instanceof TelemetryUnavailable) {
    const status = err.kind === "not-configured" ? 501 : err.kind === "forbidden" ? 503 : 502;
    return reply.code(status).send({ error: err.message, unavailable: err.kind });
  }
  throw err;
}

export async function registerSandboxRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/sessions/:id/sandbox", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const { runId } = req.query as { runId?: string };
    const run = await runFor(ctx, session.id, runId);
    if (!run) return reply.code(404).send({ error: runId ? "no such run in this session" : "this session has no run yet" });

    const provider = providerNameFor(run, ctx.config.sandboxProvider);
    // Live details only while the run can still have a sandbox; a finished pod is deleted ~2 min on.
    let live;
    if (isActive(run) && run.providerHandle) {
      const sandboxProvider = await ctx.providers.get(provider).catch(() => undefined);
      live = await sandboxProvider?.describe?.(run.providerHandle).catch(() => undefined);
    }
    const runs = await ctx.store.runs.listForSession(session.id);
    return {
      run: {
        id: run.id,
        state: run.state,
        provider,
        createdAt: run.createdAt,
        ...(run.lastSeenAt ? { lastSeenAt: run.lastSeenAt } : {}),
        ...(run.reason ? { reason: run.reason } : {}),
      },
      memory: {
        ...(run.sandboxMemLastMb !== undefined ? { lastMb: run.sandboxMemLastMb } : {}),
        ...(run.sandboxMemPeakMb !== undefined ? { peakMb: run.sandboxMemPeakMb } : {}),
        ...(run.sandboxMemLimitMb !== undefined ? { limitMb: run.sandboxMemLimitMb } : {}),
      },
      ...(run.sandboxExit ? { exit: run.sandboxExit } : {}),
      ...(live ? { live } : {}),
      // Newest first, for a run picker; ids and states only.
      runs: runs
        .slice()
        .reverse()
        .map((r) => ({ id: r.id, state: r.state, createdAt: r.createdAt })),
    };
  });

  app.get("/api/sessions/:id/sandbox/logs", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const { runId, pageToken, pageSize } = req.query as { runId?: string; pageToken?: string; pageSize?: string };
    const run = await runFor(ctx, session.id, runId);
    if (!run) return reply.code(404).send({ error: runId ? "no such run in this session" : "this session has no run yet" });
    try {
      const page = await ctx.telemetry.logs(run.id, {
        ...(pageToken ? { pageToken } : {}),
        ...(pageSize && /^\d+$/.test(pageSize) ? { pageSize: Number(pageSize) } : {}),
      });
      return { runId: run.id, lines: page.lines, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
    } catch (err) {
      return telemetryError(reply, err);
    }
  });

  app.get("/api/sessions/:id/sandbox/metrics", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const { runId } = req.query as { runId?: string };
    const run = await runFor(ctx, session.id, runId);
    if (!run) return reply.code(404).send({ error: runId ? "no such run in this session" : "this session has no run yet" });
    if (providerNameFor(run, ctx.config.sandboxProvider) !== "gke") {
      return reply.code(501).send({ error: "stats history is kept for GKE sandboxes only", unavailable: "not-configured" });
    }
    try {
      // The pod's name comes from the run's own log lines (their resource labels), so it's known
      // even after the pod is deleted, without storing it.
      const podName = (await ctx.telemetry.logs(run.id, { pageSize: 1 })).podName;
      if (!podName) return { runId: run.id, series: { memoryMb: [], cpuCores: [], diskMb: [] } };
      const endMs = isActive(run) ? Date.now() : Date.parse(run.lastSeenAt ?? run.updatedAt);
      const startMs = Math.max(Date.parse(run.createdAt) - METRICS_LEAD_MS, endMs - METRICS_MAX_MS);
      const series = await ctx.telemetry.metrics(podName, new Date(startMs), new Date(endMs + 60_000));
      return { runId: run.id, podName, series };
    } catch (err) {
      return telemetryError(reply, err);
    }
  });
}
