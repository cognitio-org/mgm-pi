// E9.9: the web app's approval widget (web LaptopApprovals.tsx) for asks from the signed-in person's
// laptops (admin/laptop-approvals.ts). Web role only, so behind IAP: a person answers, never a
// Dongle (the laptop's agent holds one). Every answer, and every refused attempt by a signed-in
// caller, is audited in adminAudit.
//
//   GET  /api/laptop-approvals            -> {approvals: LaptopApprovalView[]}  (pending, own only)
//   POST /api/laptop-approvals/:id        {approve: boolean} -> {ok: true, state}

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.ts";
import { decideLaptopApproval, pendingLaptopApprovals } from "../admin/laptop-approvals.ts";
import { auditId } from "../admin/ops.ts";
import type { AdminAuditEntry } from "../store/types.ts";

/** A same-site JSON request: not something a form or another site's page can send with the
 * person's IAP cookies (the default parsers already refuse forms; this keeps it so if one is added). */
function crossSite(req: FastifyRequest): string | undefined {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return "send JSON";
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return "cross-site requests can't answer approvals";
  return undefined;
}

export async function registerLaptopApprovalRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  async function audit(req: FastifyRequest, row: Omit<AdminAuditEntry, "id" | "at" | "via">): Promise<void> {
    try {
      await ctx.store.adminAudit.insert({ id: auditId(Date.now()), at: new Date().toISOString(), via: "web", ...row });
    } catch (err) {
      req.log.warn(`admin audit insert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  app.get("/api/laptop-approvals", async (req, reply) => {
    const approvals = await pendingLaptopApprovals(ctx.store, req.identity);
    if (!approvals) return reply.code(403).send({ error: "laptop approvals are answered in the Outfitter web app, not with a token" });
    reply.header("cache-control", "no-store");
    return { approvals };
  });

  app.post("/api/laptop-approvals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const refusedSite = crossSite(req);
    if (refusedSite) return reply.code(refusedSite === "send JSON" ? 415 : 403).send({ error: refusedSite });
    const body = (req.body ?? {}) as { approve?: unknown };
    if (typeof body.approve !== "boolean") return reply.code(400).send({ error: "approve must be true or false" });
    const op = body.approve ? "approvals.approve" : "approvals.deny";
    const decided = await decideLaptopApproval(ctx.store, id, req.identity, body.approve);
    if (!decided.ok) {
      // A refused answer from a signed-in caller (a Dongle trying, another owner's id) is the signal
      // worth keeping: an agent trying to approve itself.
      if (req.identity?.email) {
        await audit(req, { actor: req.identity.email, op, target: id.slice(0, 64), ok: false, error: decided.error, approved: false, ...(req.identity.viaToken ? { detail: "via a token" } : {}) });
      }
      return reply.code(decided.status).send({ error: decided.error });
    }
    const a = decided.approval;
    await audit(req, {
      actor: a.ownerEmail,
      sessionId: a.origin.laptopSessionId,
      op,
      target: a.id,
      ok: true,
      approved: body.approve,
      approvalId: a.id,
      detail: `${a.op} ${a.argsDigest}`,
    });
    return { ok: true, state: a.state };
  });
}
