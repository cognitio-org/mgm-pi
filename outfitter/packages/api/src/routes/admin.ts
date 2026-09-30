// POST /api/admin/ops (Sysop tools, #286): the laptop's way into the admin op registry
// (admin/ops.ts), with a Dongle. Registered on both roles, so Kernal reaches it on the link origin
// the way teleport does. A Drive reaches the same registry through agentd's admin socket instead
// (#287), never through this route.
//
// Body: {op, args?, confirmed?}. Reply: {ok: true, text} or {ok: false, error, needsApproval?},
// always 200 for a well-formed call so the tool shows the one-line error instead of an HTTP code.
// `confirmed` is the person's yes in Kernal's TUI for a delete: the Dongle's holder is the person
// at the keyboard, so the server takes their word for it.

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { runAdminOp } from "../admin/ops.ts";

export async function registerAdminRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.post("/api/admin/ops", async (req, reply) => {
    const identity = req.identity;
    // IAP users have the web UI; this route is for agents holding a Dongle (and local dev).
    if (!identity || (!identity.viaToken && !ctx.config.devMode)) {
      return reply.code(403).send({ error: "admin ops need an API token" });
    }
    const body = (req.body ?? {}) as { op?: unknown; args?: unknown; confirmed?: unknown };
    return runAdminOp(
      { store: ctx.store, models: ctx.modelsService, log: (m) => req.log.warn(m) },
      { email: identity.email, via: "token", operator: false, approved: body.confirmed === true },
      body.op,
      body.args,
    );
  });
}
