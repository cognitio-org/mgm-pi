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
// a click after 90 s asks again, and a running IDE answers at once. The asking itself is ../ide.ts,
// shared with the model's `vscode` tool (#273).
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { canManageSession, getSessionOr404 } from "./sessions.ts";
import { askForIde, ideView } from "../ide.ts";

export async function registerIdeRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/sessions/:id/ide", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (!canManageSession(session, req.identity)) return reply.code(403).send({ error: "only the floppy's owner or a sysop can open its IDE" });
    return ideView(await ctx.store.runs.findActiveForSession(session.id));
  });

  app.post("/api/sessions/:id/ide", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (!canManageSession(session, req.identity)) return reply.code(403).send({ error: "only the floppy's owner or a sysop can open its IDE" });
    const run = await ctx.store.runs.findActiveForSession(session.id);
    const outcome = await askForIde(ctx, session, run, (message) => ctx.agentLink.send(run!.id, message));
    if ("error" in outcome) return reply.code(outcome.status).send({ error: outcome.error });
    if (outcome.asked) req.log.info({ sessionId: session.id, runId: run?.id, by: req.identity?.email }, "ide: open requested");
    return reply.code(outcome.status).send(outcome.body);
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
