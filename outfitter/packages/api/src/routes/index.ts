import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { registerSessionRoutes } from "./sessions.ts";
import { registerGuruRoutes } from "./gurus.ts";
import { registerEnvironmentRoutes } from "./environments.ts";
import { registerMeRoute } from "./me.ts";
import { registerHookRoutes } from "./hooks.ts";
import { registerStaticRoutes } from "./static.ts";

export type { RouteContext } from "./context.ts";

/** Which routes register depends on OutfitterRole (config.ts): "web" registers browser REST/SSE
 * only, "link" registers only the ngrok hook (agentLink.register in server.ts adds /agent/ws
 * separately), "all" (default, dev) registers everything. */
export async function registerRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  if (ctx.config.role !== "link") {
    await registerSessionRoutes(app, ctx);
    await registerGuruRoutes(app, ctx);
    await registerEnvironmentRoutes(app, ctx);
    await registerMeRoute(app, ctx);
    await registerStaticRoutes(app);
  }
  if (ctx.config.role !== "web") {
    await registerHookRoutes(app, ctx);
  }
}
