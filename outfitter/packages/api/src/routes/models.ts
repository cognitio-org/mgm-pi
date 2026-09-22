// E3.7: GET /api/models -- the LiteLLM router's chat models (plus config.localModels), for the
// Gurus page's model/fallback-model pickers. See models.ts's ModelsService for the fetch/cache/merge
// logic; this route is just the thin Fastify wrapper.

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";

export async function registerModelRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/models", async () => ({ models: await ctx.modelsService.list() }));
}
