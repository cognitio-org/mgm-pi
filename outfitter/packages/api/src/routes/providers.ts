// E2.10/E3.6 provider status routes: GET /api/providers (current state), GET /api/providers/stream
// (SSE, same rows pushed on every transition), POST /api/providers/refresh (force a poll -- used by
// the dashboard's manual refresh and by tests). Browser routes only (role "web"/"all"), registered
// alongside sessions/gurus/environments in routes/index.ts.

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";

export async function registerProviderRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/providers", async () => {
    return { providers: await ctx.providerStatus.getCurrent() };
  });

  app.get("/api/providers/stream", async (req, reply) => {
    ctx.sse.subscribe("providers", reply);
    const providers = await ctx.providerStatus.getCurrent();
    ctx.sse.publish("providers", { type: "status", data: { providers } });
  });

  app.post("/api/providers/refresh", async () => {
    return { providers: await ctx.providerStatus.pollOnce() };
  });
}
