// MO-5 (#487, docs/specs/mcp-connections.md §3): the person's OAuth MCP grants on the router. Web role
// only (registered from routes/index.ts); never a Dongle. No token ever passes through here.

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { refuseDongle } from "./keys.ts";
import { connectUrl } from "../central/mcp-connections.ts";

export async function registerConnectionRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/me/connections", async (req, reply) => {
    if (refuseDongle(req, reply)) return;
    if (!ctx.mcpConnections) return reply.code(503).send({ error: "connections_unavailable" });
    try {
      return {
        connectUrl: connectUrl(ctx.config.litellmBaseUrl),
        // The page's Refresh follows a connect in another tab, so it always reads the router.
        connections: await ctx.mcpConnections.list(req.identity!.email, { fresh: true }),
      };
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "connections read failed");
      return reply.code(502).send({ error: "connections_upstream" });
    }
  });

  app.delete<{ Params: { name: string } }>("/api/me/connections/:name", async (req, reply) => {
    if (refuseDongle(req, reply)) return;
    if (!ctx.mcpConnections) return reply.code(503).send({ error: "connections_unavailable" });
    try {
      const outcome = await ctx.mcpConnections.disconnect(req.identity!.email, req.params.name);
      if (outcome === "unknown") return reply.code(404).send({ error: "unknown_connection" });
      req.log.info({ server: req.params.name }, "mcp connection removed");
      return reply.code(204).send();
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "connection delete failed");
      return reply.code(502).send({ error: "connections_upstream" });
    }
  });
}
