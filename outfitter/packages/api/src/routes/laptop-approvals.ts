// E9.9: the web app's approval widget (web LaptopApprovals.tsx) for asks from the signed-in person's
// laptops (admin/laptop-approvals.ts). Web role only, so behind IAP: a person answers, never a
// Dongle (the laptop's agent holds one). Every decision is audited in adminAudit.
//
//   GET  /api/laptop-approvals            -> {approvals: LaptopApprovalView[]}  (pending, own only)
//   POST /api/laptop-approvals/:id        {approve: boolean} -> {ok: true, state}

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { decideLaptopApproval, pendingLaptopApprovals } from "../admin/laptop-approvals.ts";
import { auditId } from "../admin/ops.ts";

export async function registerLaptopApprovalRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/laptop-approvals", async (req, reply) => {
    const approvals = await pendingLaptopApprovals(ctx.store, req.identity);
    if (!approvals) return reply.code(403).send({ error: "laptop approvals are answered in the Outfitter web app, not with a token" });
    reply.header("cache-control", "no-store");
    return { approvals };
  });

  app.post("/api/laptop-approvals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { approve?: unknown };
    if (typeof body.approve !== "boolean") return reply.code(400).send({ error: "approve must be true or false" });
    const decided = await decideLaptopApproval(ctx.store, id, req.identity, body.approve);
    if (!decided.ok) return reply.code(decided.status).send({ error: decided.error });
    const a = decided.approval;
    try {
      await ctx.store.adminAudit.insert({
        id: auditId(Date.now()),
        at: new Date().toISOString(),
        actor: a.ownerEmail,
        via: "web",
        sessionId: a.origin.laptopSessionId,
        op: body.approve ? "approvals.approve" : "approvals.deny",
        target: a.id,
        ok: true,
        approved: body.approve,
        approvalId: a.id,
      });
    } catch (err) {
      req.log.warn(`admin audit insert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true, state: a.state };
  });
}
