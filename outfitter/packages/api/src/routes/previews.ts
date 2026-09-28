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
import { validPreviewPort } from "../previews.ts";

const LIVE = new Set(["queued", "provisioning", "running", "idle", "stopping"]);
/** A share is made only while the Drive is up for good: not while it's starting or stopping (a
 * share made mid-stop could outlive closeRun's pass until the sweeper's). */
const SHAREABLE = new Set(["running", "idle"]);

function view(p: Preview) {
  // Only ever built by PreviewService as https://<hex>.<PREVIEW_DOMAIN>; asserted anyway, since the
  // page renders it as a link.
  if (!p.url.startsWith("https://")) throw new Error(`preview ${p.id} has a non-https url`);
  return { id: p.id, port: p.port, share: p.share, url: p.url, createdAt: p.createdAt, ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}) };
}

export async function registerPreviewRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/sessions/:id/previews", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const run = await ctx.store.runs.findActiveForSession(session.id);
    // The IDE's endpoint (#242) isn't a preview chip: it has its own route (routes/ide.ts), and no
    // share control.
    const open = run && LIVE.has(run.state)
      ? (await ctx.store.previews.listOpenForSession(session.id)).filter((p) => p.runId === run.id && p.kind !== "ide")
      : [];
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
    const rawPort = (req.params as { port: string }).port;
    const port = Number(rawPort);
    if (!/^\d{1,5}$/.test(rawPort) || !validPreviewPort(port)) return reply.code(400).send({ error: "port must be a number from 1024 to 65535" });
    const run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run || !SHAREABLE.has(run.state)) return reply.code(409).send({ error: "the Drive isn't running" });
    // Only a port the model already previewed: that proves the tunnel is up, and keeps a person from
    // publishing a port the agent never meant to serve.
    const secure = await ctx.store.previews.findOpen(run.id, port, false);
    // #242: never the IDE (a shell), whatever port it's filed under.
    if (secure?.kind === "ide") return reply.code(409).send({ error: "the IDE can't be shared" });
    if (!secure) return reply.code(409).send({ error: `there's no preview of port ${port} to share; ask the agent to preview it first` });
    const body = (req.body ?? {}) as { ttlSeconds?: unknown };
    const ttl = typeof body.ttlSeconds === "number" && Number.isFinite(body.ttlSeconds) && body.ttlSeconds > 0 ? Math.floor(body.ttlSeconds) : undefined;
    const result = await ctx.previews.open(run.id, port, true, undefined, { ttlSeconds: ttl });
    if ("error" in result) {
      const status = { "too-many": 429, "not-configured": 503, "port-not-allowed": 400 }[result.error] ?? 502;
      return reply.code(status).send({ error: result.error });
    }
    const made = await ctx.store.previews.findOpen(run.id, port, true);
    // The agent may have closed the port while the link was being made (preview.close lists the
    // run's previews before this one existed): a share must not outlive its private preview.
    if (made && !(await ctx.store.previews.findOpen(run.id, port, false))) {
      await ctx.previews.closeById(session.id, made.id, "its private preview closed");
      return reply.code(409).send({ error: `the preview of port ${port} closed while the link was being made` });
    }
    req.log.info({ sessionId: session.id, port, by: req.identity?.email, expiresAt: result.expiresAt }, "previews: public share link made");
    return made ? view(made) : { url: result.url, expiresAt: result.expiresAt, port, share: true };
  });

  app.delete("/api/sessions/:id/previews/:previewId", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    if (!canManageSession(session, req.identity)) return reply.code(403).send({ error: "only the floppy's owner or a sysop can close a preview" });
    const { previewId } = req.params as { previewId: string };
    if (!/^[0-9a-f]{32}$/.test(previewId)) return reply.code(404).send({ error: "no such preview" });
    // The IDE closes through DELETE /api/sessions/:id/ide (#242), which also updates the run's state.
    const target = (await ctx.store.previews.listOpenForSession(session.id)).find((p) => p.id === previewId && p.kind !== "ide");
    const closed = target ? await ctx.previews.closeById(session.id, previewId) : false;
    if (!closed) return reply.code(404).send({ error: "no such preview" });
    req.log.info({ sessionId: session.id, previewId, port: target!.port, share: target!.share, by: req.identity?.email }, "previews: preview closed from the session page");
    return reply.code(204).send();
  });
}
