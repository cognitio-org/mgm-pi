// Settings → Agent Engine agents (E9 §4): the allowlist of Agent Engine agents Drives may call.
// Sysops only (requireOperator), on the web role like the other operator routes. Changes need a
// person in the web UI, not a Dongle: an agent holding a sysop's token could otherwise widen what
// agents may call. Every change writes an adminAudit row (via "web").
//
//   GET    /api/operator/agent-engine/agents       {agents}
//   POST   /api/operator/agent-engine/agents       {id, workspaceId, name, description?, enabled?}
//   PUT    /api/operator/agent-engine/agents/:id   any of workspaceId, name, description, enabled
//   DELETE /api/operator/agent-engine/agents/:id

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.ts";
import { requireOperator } from "../auth.ts";
import { auditId } from "../admin/ops.ts";
import { isAgentEngineId } from "../agentengine/index.ts";
import type { AeAgent } from "../store/types.ts";

/** Lowercase slug; it goes into the Agent Engine session id (`outf-<session8>-<id>`, at most 128
 * characters of letters, digits, `_` and `-`). */
export const AE_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;

type Body = Record<string, unknown>;

/** The fields of `body` as an allowlist patch, or the first problem. `create` needs every field. */
export function aeAgentFields(body: Body, create: boolean): { ok: true; fields: Partial<AeAgent> } | { ok: false; error: string } {
  const out: Partial<AeAgent> = {};
  if (create) {
    if (typeof body.id !== "string" || !AE_AGENT_ID.test(body.id)) return { ok: false, error: "id must be a lowercase slug (letters, digits, - and _, up to 48)" };
    out.id = body.id;
  }
  if (body.workspaceId !== undefined || create) {
    if (!isAgentEngineId(body.workspaceId)) return { ok: false, error: "workspaceId must be an Agent Engine workspace id" };
    out.workspaceId = body.workspaceId;
  }
  if (body.name !== undefined || create) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME) return { ok: false, error: `name is required, up to ${MAX_NAME} characters` };
    out.name = name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.length > MAX_DESCRIPTION) return { ok: false, error: `description must be text, up to ${MAX_DESCRIPTION} characters` };
    out.description = body.description.trim();
  } else if (create) out.description = "";
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
    out.enabled = body.enabled;
  } else if (create) out.enabled = true;
  return { ok: true, fields: out };
}

/** People only: a Dongle (even a sysop's) can read the list but not change it. */
function personOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.identity?.viaToken) {
    reply.code(403).send({ error: "change Agent Engine agents in the Outfitter web UI" });
    return false;
  }
  return true;
}

export async function registerAgentEngineRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const audit = async (req: FastifyRequest, op: string, target: string, ok: boolean, error?: string) => {
    const now = Date.now();
    try {
      await ctx.store.adminAudit.insert({
        id: auditId(now),
        at: new Date(now).toISOString(),
        actor: req.identity!.email,
        via: "web",
        op,
        target,
        ok,
        ...(error ? { error } : {}),
        approved: true,
      });
    } catch (err) {
      req.log.warn({ err }, "aeAgents audit insert failed");
    }
  };

  app.get("/api/operator/agent-engine/agents", { preHandler: requireOperator }, async () => {
    // No "configured" flag: the agents project's credentials live on the link role only
    // (deploy/service.sh), so this role can't tell.
    return { agents: await ctx.store.aeAgents.list() };
  });

  app.post("/api/operator/agent-engine/agents", { preHandler: requireOperator }, async (req, reply) => {
    if (!personOnly(req, reply)) return;
    const parsed = aeAgentFields((req.body ?? {}) as Body, true);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const now = new Date().toISOString();
    const agent = { ...parsed.fields, createdAt: now, updatedAt: now, updatedBy: req.identity!.email } as AeAgent;
    if (!(await ctx.store.aeAgents.insert(agent))) {
      await audit(req, "aeAgents.create", agent.id, false, "duplicate");
      return reply.code(409).send({ error: "that id or workspace is already listed" });
    }
    await audit(req, "aeAgents.create", agent.id, true);
    return reply.code(201).send({ agent });
  });

  app.put("/api/operator/agent-engine/agents/:id", { preHandler: requireOperator }, async (req, reply) => {
    if (!personOnly(req, reply)) return;
    const { id } = req.params as { id: string };
    const parsed = aeAgentFields((req.body ?? {}) as Body, false);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const updated = await ctx.store.aeAgents.update(id, { ...parsed.fields, updatedAt: new Date().toISOString(), updatedBy: req.identity!.email });
    if (updated === null) return reply.code(404).send({ error: "no such agent" });
    if (updated === "duplicate") {
      await audit(req, "aeAgents.update", id, false, "duplicate workspace");
      return reply.code(409).send({ error: "that workspace is already listed" });
    }
    // What changed, for the audit: a re-pointed workspace or an enable matters most.
    const changed = Object.entries(parsed.fields)
      .map(([k, v]) => (k === "workspaceId" || k === "enabled" ? `${k}=${String(v)}` : k))
      .join(", ");
    await audit(req, "aeAgents.update", changed ? `${id}: ${changed}` : id, true);
    return { agent: updated };
  });

  app.delete("/api/operator/agent-engine/agents/:id", { preHandler: requireOperator }, async (req, reply) => {
    if (!personOnly(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!(await ctx.store.aeAgents.delete(id))) return reply.code(404).send({ error: "no such agent" });
    await audit(req, "aeAgents.delete", id, true);
    return reply.code(204).send();
  });
}
