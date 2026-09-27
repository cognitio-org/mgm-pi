// Drive previews on the session page (#217 phase 3, docs/specs/drive-previews.md). Web role.
// - GET lists the session's open previews, for anyone who can open the session (the same audience
//   the secure previews themselves admit).
// - POST .../share makes a public, time-limited link for a port the model already previewed. This is
//   the only way a share link is made: agentlink refuses `share` from a sandbox. Owner or sysop only
//   (canManageSession), like archive and format.
// - DELETE closes one preview (owner or sysop).

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import type { Preview } from "../store/types.ts";
import { canManageSession, getSessionOr404 } from "./sessions.ts";

const LIVE = new Set(["queued", "provisioning", "running", "idle", "stopping"]);

function view(p: Preview) {
  return { id: p.id, port: p.port, share: p.share, url: p.url, createdAt: p.createdAt, ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}) };
}

export async function registerPreviewRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/sessions/:id/previews", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const run = await ctx.store.runs.findActiveForSession(session.id);
    const open = run && LIVE.has(run.state) ? (await ctx.store.previews.listOpenForSession(session.id)).filter((p) => p.runId === run.id) : [];
    return {
      enabled: ctx.previews.enabled,
      canShare: ctx.previews.enabled && canManageSession(session, req.identity),
      shareMaxSeconds: ctx.config.previewShareMaxSeconds,
      shareDefaultSeconds: Math.min(ctx.config.previewShareTtlSeconds, ctx.config.previewShareMaxSeconds),
      previews: open.sort((a, b) => a.port - b.port || Number(a.share) - Number(b.share)).map(view),
    };
  });

  app.post("/api/sessions/:id/previews/:port/share", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (!canManageSession(session, req.identity)) return reply.code(403).send({ error: "only the floppy's owner or a sysop can make a public link" });
    if (!ctx.previews.enabled) return reply.code(503).send({ error: "previews aren't enabled" });
    const port = Number((req.params as { port: string }).port);
    const run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run || !LIVE.has(run.state)) return reply.code(409).send({ error: "the Drive isn't running" });
    // Only a port the model already previewed: that proves the tunnel is up, and keeps a person from
    // publishing a port the agent never meant to serve.
    const secure = await ctx.store.previews.findOpen(run.id, port, false);
    if (!secure) return reply.code(409).send({ error: `there's no preview of port ${port} to share; ask the agent to preview it first` });
    const body = (req.body ?? {}) as { ttlSeconds?: unknown };
    const ttl = typeof body.ttlSeconds === "number" && Number.isFinite(body.ttlSeconds) && body.ttlSeconds > 0 ? Math.floor(body.ttlSeconds) : undefined;
    const result = await ctx.previews.open(run.id, port, true, undefined, { ttlSeconds: ttl });
    if ("error" in result) {
      const status = result.error === "too-many" ? 429 : result.error === "not-configured" ? 503 : 502;
      return reply.code(status).send({ error: result.error });
    }
    const made = await ctx.store.previews.findOpen(run.id, port, true);
    req.log.info({ sessionId: session.id, port, by: req.identity?.email, expiresAt: result.expiresAt }, "previews: public share link made");
    return made ? view(made) : { url: result.url, expiresAt: result.expiresAt, port, share: true };
  });

  app.delete("/api/sessions/:id/previews/:previewId", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (!canManageSession(session, req.identity)) return reply.code(403).send({ error: "only the floppy's owner or a sysop can close a preview" });
    const { previewId } = req.params as { previewId: string };
    if (!/^[0-9a-f]{32}$/.test(previewId)) return reply.code(404).send({ error: "no such preview" });
    const closed = await ctx.previews.closeById(session.id, previewId);
    if (!closed) return reply.code(404).send({ error: "no such preview" });
    return reply.code(204).send();
  });
}
