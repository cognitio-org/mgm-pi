// POST /api/admin/ops (Sysop tools, #286): the laptop's way into the admin op registry
// (admin/ops.ts), with a Dongle. Registered on both roles, so Kernal reaches it on the link origin
// the way teleport does. A Drive reaches the same registry through agentd's admin socket instead
// (#287), never through this route.
//
// Body: {op, args?, confirmed?}. Reply: {ok: true, text} or {ok: false, error, needsApproval?},
// always 200 for a well-formed call so the tool shows the one-line error instead of an HTTP code.
// `confirmed` is the person's yes in Kernal's TUI for a delete: the Dongle's holder is the person
// at the keyboard, so the server takes their word for it.
//
// E9.9: `laptop: {sessionId, repo?}` binds a `memory.*` call (admin/memory-ops.ts): sessionId is
// `laptop:<pi session id>`, repo the working directory's GitHub `owner/name`. Both are checked here
// and only scope the token owner's own memory; the identity is always the token's owner.
// `approvalId` names the web approval a rerun of a `webApproval` op (a shared memory.save) claims;
// for those ops `confirmed` counts for nothing (admin/laptop-approvals.ts).

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { runAdminOp } from "../admin/ops.ts";
import { laptopContext } from "../agentengine/identity.ts";

/**
 * A Dongle's `memory.*` calls per minute, per owner (E9.9): recall runs on every laptop prompt and
 * recording after every turn, so this is generous for a person and a ceiling for a runaway client
 * or a leaked Dongle (each call can cost Agent Engine retrieval, embedding and extraction).
 * In-process, per instance: a bound on cost, not an exact quota.
 */
export class MemoryRateLimit {
  private readonly windows = new Map<string, { start: number; count: number }>();
  perMinute: number;
  private readonly now: () => number;

  constructor(perMinute = 120, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.now = now;
  }

  /** True when `key` may make one more call now (and counts it). */
  take(key: string): boolean {
    if (this.perMinute < 1) return false;
    const t = this.now();
    if (this.windows.size > 1_000) for (const [k, w] of this.windows) if (t - w.start >= 60_000) this.windows.delete(k);
    const w = this.windows.get(key);
    if (!w || t - w.start >= 60_000) {
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    if (w.count >= this.perMinute) return false;
    w.count += 1;
    return true;
  }
}

/** The route's limiter (tests lower `perMinute`). */
export const laptopMemoryRate = new MemoryRateLimit();

export async function registerAdminRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.post("/api/admin/ops", async (req, reply) => {
    const identity = req.identity;
    // IAP users have the web UI; this route is for agents holding a Dongle (and local dev).
    if (!identity || (!identity.viaToken && !ctx.config.devMode)) {
      return reply.code(403).send({ error: "admin ops need an API token" });
    }
    const body = (req.body ?? {}) as { op?: unknown; args?: unknown; confirmed?: unknown; laptop?: unknown; approvalId?: unknown };
    const laptop = laptopContext(body.laptop);
    if (!laptop.ok) return { ok: false, error: laptop.error };
    if (typeof body.op === "string" && body.op.startsWith("memory.") && !laptopMemoryRate.take(identity.email.toLowerCase())) {
      return { ok: false, error: "too many memory calls from this Dongle; try again in a minute" };
    }
    return runAdminOp(
      { store: ctx.store, models: ctx.modelsService, agentEngine: ctx.agentEngine, log: (m) => req.log.warn(m) },
      {
        email: identity.email,
        via: "token",
        operator: false,
        approved: body.confirmed === true,
        ...(laptop.value ? { laptop: laptop.value } : {}),
        // A string only: `null` or a number reads as no approval yet, so it asks afresh.
        ...(typeof body.approvalId === "string" ? { laptopApprovalId: body.approvalId } : {}),
      },
      body.op,
      body.args,
    );
  });
}
