import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { registerSessionRoutes, registerTeleportRoutes } from "./sessions.ts";
import { registerGuruRoutes } from "./gurus.ts";
import { registerEnvironmentRoutes } from "./environments.ts";
import { registerMeRoute } from "./me.ts";
import { registerTokenRoutes } from "./tokens.ts";
import { registerHookRoutes } from "./hooks.ts";
import { registerProviderRoutes } from "./providers.ts";
import { registerStaticRoutes } from "./static.ts";

export type { RouteContext } from "./context.ts";

/** Which routes register depends on OutfitterRole (config.ts): "web" registers browser REST/SSE
 * plus token management, "link" registers exactly what teleport needs (registerTeleportRoutes,
 * GET /api/me) plus the ngrok hook (agentLink.register in server.ts adds /agent/ws separately),
 * "all" (default, dev) registers everything. Every /api/* route here (except /api/hooks/*) is
 * gated by server.ts's auth preHandler: IAP-or-token on "web"/"all", token-only on "link". */
export async function registerRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  if (ctx.config.role !== "link") {
    await registerSessionRoutes(app, ctx);
    await registerGuruRoutes(app, ctx);
    await registerEnvironmentRoutes(app, ctx);
    await registerMeRoute(app, ctx);
    await registerTokenRoutes(app, ctx);
    await registerProviderRoutes(app, ctx);
    await registerStaticRoutes(app);
  } else {
    // No more than teleport needs (see docs/protocol.md "browser <-> api" and EPIC.md's E4.1b):
    // list/get/export/import/stop plus GET /api/me so a teleport client can check its token.
    await registerTeleportRoutes(app, ctx);
    await registerMeRoute(app, ctx);
  }
  if (ctx.config.role !== "web") {
    await registerHookRoutes(app, ctx);
  }
}
