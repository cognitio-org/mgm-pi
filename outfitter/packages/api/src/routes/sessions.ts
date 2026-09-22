// Session and run-control REST routes plus the SSE stream. See docs/protocol.md "browser <-> api".

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.ts";
import type { Session, PiEntry } from "../store/types.ts";

const SESSION_VERSION = 3; // matches pi's CURRENT_SESSION_VERSION; keeps export.jsonl pi-compatible

interface SessionSummary {
  id: string;
  name?: string;
  status: Session["status"];
  runState?: string;
  guru: string;
  repo: string | null;
  branch?: string;
  parentId?: string;
  cost: number;
  updatedAt: string;
}

async function summarize(ctx: RouteContext, session: Session): Promise<SessionSummary> {
  const run = await ctx.store.runs.findActiveForSession(session.id);
  return {
    id: session.id,
    name: session.name,
    status: session.status,
    runState: run?.state,
    guru: session.guruId,
    repo: session.repo,
    branch: session.branch,
    parentId: session.parentId,
    cost: session.cost,
    updatedAt: session.updatedAt,
  };
}

function headerLine(session: Session): string {
  const header = {
    type: "session" as const,
    version: SESSION_VERSION,
    id: session.id,
    timestamp: session.createdAt,
    cwd: "/workspace",
    ...(session.parentId ? { parentSession: session.parentId } : {}),
  };
  return JSON.stringify(header);
}

/** The subset of session routes the "link" role registers for teleport (docs/protocol.md "browser
 * <-> api"): list/get/export/import/stop, nothing that needs a live agentd socket beyond `stop`
 * (which only enqueues a down-message through the store either way — see the route's own comment).
 * registerSessionRoutes (the "web"/"all" role) calls this first, then adds the rest, so neither
 * role duplicates the handler logic. */
export async function registerTeleportRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/sessions", async (req) => {
    // Code review M1 (docs/reports/code-review-pr15.md): `status` here is Session.status
    // ("open"/"closed"), while `runState` (queued/provisioning/running/idle/stopping/stopped/
    // failed) only exists per-run, computed by summarize() below -- it isn't a store-level filter.
    // Filter on it post-hoc, after summarizing, rather than pretending the store can push it down.
    const query = req.query as { status?: string; guru?: string; runState?: string };
    const sessions = await ctx.store.sessions.list({ status: query.status, guruId: query.guru });
    const summaries = await Promise.all(sessions.map((s) => summarize(ctx, s)));
    if (!query.runState) return summaries;
    return summaries.filter((s) => s.runState === query.runState);
  });

  app.get("/api/sessions/:id", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    // runState (not on Session itself -- see store/types.ts's Run) lets a caller like the mgm
    // teleport extension's OutfitterStore poll "has the active run stopped yet?" without a second
    // request; GET /api/sessions already computes the same thing per-row via summarize().
    const run = await ctx.store.runs.findActiveForSession(session.id);
    return { ...session, runState: run?.state };
  });

  app.post("/api/sessions/:id/stop", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run) return reply.code(404).send({ error: "no active run" });

    // Code review M2 (docs/reports/code-review-pr15.md): branch explicitly on all three cases
    // instead of collapsing "not running/idle" into "cancel directly" -- that used to also catch
    // an already-`stopping` run and force-kill it via the provider mid-checkpoint/mid-drain, which
    // is exactly what the `stopping` grace period exists to avoid. A second `/stop` call while
    // already stopping is a no-op: return the current run and let the existing grace-period /
    // RunManager.reconcileStoppingOnce path finish it.
    if (run.state === "stopping") {
      return { run };
    }

    if (run.state !== "running" && run.state !== "idle") {
      // No live agent yet (queued/provisioning) to ask gracefully -- cancel the provider execution
      // directly, same as before.
      const stopped = await ctx.runs.stop(run.id, "user");
      return { run: stopped };
    }

    // Graceful stop: always enqueue the `stop` down-message through the store rather than branch on
    // ctx.agentLink.hasSocket, which is process-local -- outfitter-api (this, the web role) never
    // holds an agentd socket at all (see docs/protocol.md "Two origins"), so hasSocket is always
    // false here and used to fall through to a provider cancel (SIGTERM) instead of the graceful
    // stop this route means to send. agentLink.send delivers immediately if this process happens to
    // hold the live socket (e.g. local dev's role "all"), otherwise the link role's poller picks the
    // message up from the store on its next tick. Mark the run `stopping` *after* the send call so
    // an immediate, same-process delivery above still sees the run as running/idle and isn't forced
    // to queue instead. If agentd never finishes the graceful stop (checkpoint + `bye`) within
    // STOP_GRACE_MS, RunManager.reconcileStoppingOnce cancels the sandbox via the provider.
    await ctx.agentLink.send(run.id, { t: "stop", reason: "user" });
    const stopping = await ctx.store.runs.update(run.id, { state: "stopping", updatedAt: new Date().toISOString() });
    return { run: stopping };
  });

  app.get("/api/sessions/:id/export.jsonl", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const entries = await ctx.store.entries.listForSession(session.id);
    const lines = [headerLine(session), ...entries.map((e) => JSON.stringify(e.entry))];
    reply.header("Content-Type", "application/x-ndjson");
    return lines.join("\n") + "\n";
  });

  app.put("/api/sessions/:id/import", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const active = await ctx.store.runs.findActiveForSession(id);
    if (active) return reply.code(409).send({ error: "a run is active for this session" });

    const body = typeof req.body === "string" ? req.body : String(req.body ?? "");
    const lines = body.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return reply.code(400).send({ error: "empty JSONL body" });

    const header = JSON.parse(lines[0]) as { type: string; id: string; cwd?: string; timestamp?: string };
    if (header.type !== "session") return reply.code(400).send({ error: "first line must be a session header" });
    if (header.id !== id) return reply.code(400).send({ error: "header id does not match :id" });

    let session = await ctx.store.sessions.findById(id);
    const now = new Date().toISOString();
    if (!session) {
      session = {
        id,
        guruId: "",
        repo: null,
        status: "open",
        cost: 0,
        createdAt: header.timestamp ?? now,
        updatedAt: now,
      };
      await ctx.store.sessions.insert(session);
    }

    let seq = await ctx.store.entries.maxSeq(id);
    let leafId = session.leafId;
    for (const line of lines.slice(1)) {
      const entry = JSON.parse(line) as PiEntry;
      const inserted = await ctx.store.entries.insertIfNew(id, ++seq, entry);
      if (inserted) leafId = entry.id;
    }
    await ctx.store.sessions.update(id, { leafId, updatedAt: now });

    return { id, imported: lines.length - 1 };
  });
}

export async function registerSessionRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  await registerTeleportRoutes(app, ctx);

  app.post("/api/sessions", async (req, reply) => {
    const body = req.body as {
      guruId: string;
      repo?: string;
      baseBranch?: string;
      branch?: string;
      prompt: string;
      name?: string;
      /** Per-session model override; see src/laptop.ts's E2.8 preflight for how this is resolved. */
      model?: string;
    };
    if (!body?.guruId || !body?.prompt) {
      return reply.code(400).send({ error: "guruId and prompt are required" });
    }
    const guru = await ctx.store.gurus.findById(body.guruId);
    if (!guru) return reply.code(400).send({ error: `unknown guruId: ${body.guruId}` });

    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      name: body.name,
      // Recorded but not yet enforced -- see Session.ownerEmail's doc comment and EPIC.md's E2.2
      // note (finding #5, docs/reports/security-review-pr1.md).
      ownerEmail: req.identity?.email,
      guruId: body.guruId,
      // repo omitted = non-coding session (protocol.md): no clone, no branch.
      repo: body.repo ?? null,
      baseBranch: body.repo ? body.baseBranch : undefined,
      branch: body.repo ? (body.branch ?? `outfitter/${randomUUID().slice(0, 8)}`) : undefined,
      prompt: body.prompt,
      modelOverride: body.model,
      status: "open",
      cost: 0,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.store.sessions.insert(session);

    const run = await ctx.runs.wake(session.id);
    await ctx.agentLink.send(run.id, { t: "prompt", text: body.prompt });

    return reply.code(201).send({ session, run });
  });

  app.get("/api/sessions/:id/entries", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const { after } = req.query as { after?: string };
    const entries = await ctx.store.entries.listForSession(session.id, after);
    return entries.map((e) => e.entry);
  });

  app.get("/api/sessions/:id/stream", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    reply.hijack(); // we own the raw response now; Fastify must not also try to send it
    ctx.sse.subscribe(session.id, reply);
    const run = await ctx.store.runs.findActiveForSession(session.id);
    ctx.sse.publish(session.id, { type: "status", data: { t: "status", state: run?.state ?? "stopped" } });
  });

  app.post("/api/sessions/:id/messages", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const body = req.body as { text: string; behavior?: "steer" | "followUp" };
    if (!body?.text) return reply.code(400).send({ error: "text is required" });

    let run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run) run = await ctx.runs.wake(session.id);
    await ctx.agentLink.send(run.id, { t: "prompt", text: body.text, behavior: body.behavior });
    return { run };
  });

  app.post("/api/sessions/:id/abort", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run) return reply.code(404).send({ error: "no active run" });
    await ctx.agentLink.send(run.id, { t: "abort" });
    return { run };
  });

  app.post("/api/sessions/:id/wake", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const run = await ctx.runs.wake(session.id);
    return { run };
  });

  app.post("/api/sessions/:id/ui-response", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const body = req.body as { id: string; value: unknown };
    if (!body?.id) return reply.code(400).send({ error: "id is required" });
    const run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run) return reply.code(404).send({ error: "no active run" });
    await ctx.agentLink.send(run.id, { t: "ui_response", id: body.id, value: body.value });
    await ctx.store.runs.update(run.id, { pendingUiRequest: undefined, updatedAt: new Date().toISOString() });
    return { run };
  });

  app.get("/api/sessions/:id/diff", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run || !ctx.agentLink.hasSocket(run.id)) {
      return reply.code(409).send({ error: "no live run to diff" });
    }
    try {
      const result = await ctx.agentLink.request(run.id, { t: "diff" });
      return { base: result.base, patch: result.patch };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

}

async function getSessionOr404(
  ctx: RouteContext,
  req: FastifyRequest,
  reply: { code: (n: number) => { send: (body: unknown) => unknown } },
): Promise<Session | undefined> {
  const { id } = req.params as { id: string };
  const session = await ctx.store.sessions.findById(id);
  if (!session) {
    reply.code(404).send({ error: "session not found" });
    return undefined;
  }
  return session;
}
