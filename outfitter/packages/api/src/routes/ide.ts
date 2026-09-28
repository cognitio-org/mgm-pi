// Browser IDE (#242, docs/specs/browser-ide.md §3-§4): the session page's "Open in VS Code".
//
// - POST .../ide queues `ide.open` for the Drive (agentLink.send: now if its socket is here, else
//   through the store for the link role's poller) and records the request on the run. It answers 202
//   straight away: installing and starting take seconds, so the page polls GET.
// - GET .../ide is the run's IDE state and, once the link role has made the endpoint, its URL.
// - DELETE .../ide closes the public endpoint; code-server keeps running in the Drive, and the next
//   open makes a new endpoint (with the owner and sysops as they are then).
// All three are the floppy's owner's or a sysop's (canManageSession): the IDE is a shell.
// ide.status isn't replayed, so a frame lost to a dropped link can leave the state at "starting";
// another click (allowed whenever it isn't ready) asks again, and a running IDE answers at once.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import type { Run } from "../store/types.ts";
import { canManageSession, getSessionOr404 } from "./sessions.ts";
import { IDE_PREVIEW_PORT } from "../previews.ts";

/** An IDE can be opened only on a Drive that's up for good (as for share links). */
const OPENABLE = new Set(["running", "idle"]);
const LIVE = new Set(["queued", "provisioning", "running", "idle", "stopping"]);

function view(run: Run | null) {
  const available = run?.browserIde === true && LIVE.has(run.state);
  if (!available || !run?.ide) return { available, state: "none" as const };
  return {
    available,
    state: run.ide.state,
    ...(run.ide.state === "ready" && run.ide.url?.startsWith("https://") ? { url: run.ide.url } : {}),
    ...(run.ide.detail ? { detail: run.ide.detail } : {}),
    updatedAt: run.ide.updatedAt,
  };
}

export async function registerIdeRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/sessions/:id/ide", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (!canManageSession(session, req.identity)) return reply.code(403).send({ error: "only the floppy's owner or a sysop can open its IDE" });
    return view(await ctx.store.runs.findActiveForSession(session.id));
  });

  app.post("/api/sessions/:id/ide", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (!canManageSession(session, req.identity)) return reply.code(403).send({ error: "only the floppy's owner or a sysop can open its IDE" });
    if (!session.ownerEmail) return reply.code(409).send({ error: "this floppy has no owner on record, so its IDE has no one to let in" });
    if (!ctx.previews.enabled) return reply.code(503).send({ error: "previews aren't enabled, and the IDE is served through them" });
    const run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run || !OPENABLE.has(run.state)) return reply.code(409).send({ error: "the Drive isn't running" });
    if (run.browserIde !== true) return reply.code(409).send({ error: "this Drive has no IDE: turn on \"VS Code in the browser\" on its Tape, then start a new Drive" });
    // Already open: answer with it, if its endpoint really is still there.
    if (run.ide?.state === "ready" && run.ide.url) {
      const open = await ctx.store.previews.findOpen(run.id, IDE_PREVIEW_PORT, false);
      if (open?.kind === "ide" && open.url === run.ide.url) return reply.code(200).send(view(run));
    }
    const reqId = randomUUID();
    const updated = await ctx.store.runs.update(run.id, { ide: { reqId, state: "requested", updatedAt: new Date().toISOString() } });
    await ctx.agentLink.send(run.id, { t: "ide.open", reqId });
    req.log.info({ sessionId: session.id, runId: run.id, by: req.identity?.email }, "ide: open requested");
    return reply.code(202).send(view(updated ?? run));
  });

  app.delete("/api/sessions/:id/ide", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (!canManageSession(session, req.identity)) return reply.code(403).send({ error: "only the floppy's owner or a sysop can close its IDE" });
    const run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run?.ide) return reply.code(204).send();
    await ctx.previews.closeIde(run.id, "closed by a person");
    await ctx.store.runs.update(run.id, { ide: { reqId: run.ide.reqId, state: "closed", updatedAt: new Date().toISOString() } });
    req.log.info({ sessionId: session.id, runId: run.id, by: req.identity?.email }, "ide: closed");
    return reply.code(204).send();
  });
}
