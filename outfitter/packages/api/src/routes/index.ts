import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { registerPanelRoutes, registerSessionRoutes, registerTeleportRoutes } from "./sessions.ts";
import { registerBrowserRoutes } from "./browser.ts";
import { registerGuruRoutes } from "./gurus.ts";
import { registerModelRoutes } from "./models.ts";
import { registerEnvironmentRoutes } from "./environments.ts";
import { registerMeRoute } from "./me.ts";
import { registerTokenRoutes } from "./tokens.ts";
import { registerHookRoutes } from "./hooks.ts";
import { registerProviderRoutes } from "./providers.ts";
import { registerOperatorRoutes } from "./operator.ts";
import { registerStaticRoutes } from "./static.ts";
import { registerSandboxRoutes } from "./sandbox.ts";
import { registerPreviewRoutes } from "./previews.ts";
import { registerIdeRoutes } from "./ide.ts";
import { registerVoiceRoutes } from "./voice.ts";
import { registerAdminRoutes } from "./admin.ts";

export type { RouteContext } from "./context.ts";

/** Which routes register depends on OutfitterRole (config.ts): "web" registers browser REST/SSE
 * plus token management, "link" registers teleport (registerTeleportRoutes), the side-panel
 * session routes (registerPanelRoutes), the browser companion (registerBrowserRoutes), and
 * GET /api/me and POST /api/admin/ops (the Sysop tools' op registry, never operator ops on this
 * role) — not the gurus REST routes, operator, or token management — plus the ngrok hook (agentLink.register
 * in server.ts adds /agent/ws separately), "all" (default, dev) registers everything. Every
 * /api/* route here (except /api/hooks/*) is gated by server.ts's auth preHandler: IAP-or-token
 * on "web"/"all", token-only on "link". */
export async function registerRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  if (ctx.config.role !== "link") {
    await registerSessionRoutes(app, ctx);
    await registerSandboxRoutes(app, ctx);
    await registerPreviewRoutes(app, ctx);
    await registerIdeRoutes(app, ctx);
    await registerGuruRoutes(app, ctx);
    await registerModelRoutes(app, ctx);
    await registerEnvironmentRoutes(app, ctx);
    await registerMeRoute(app, ctx);
    await registerTokenRoutes(app, ctx);
    await registerProviderRoutes(app, ctx);
    await registerOperatorRoutes(app, ctx);
    await registerVoiceRoutes(app, ctx);
    await registerAdminRoutes(app, ctx);
    await registerStaticRoutes(app);
  } else {
    // Teleport, plus the side panel and browser companion (docs/protocol.md "Browser companion").
    // No guru, operator, or token-management routes: a Dongle that can steer is not an operator.
    await registerTeleportRoutes(app, ctx);
    await registerPanelRoutes(app, ctx);
    await registerMeRoute(app, ctx);
    // Sysop tools (#286): the admin op registry, for Kernal with a Dongle. Tokens are never
    // operators here, so the registry's operator ops stay out of reach on this origin.
    await registerAdminRoutes(app, ctx);
  }
  await registerBrowserRoutes(app, ctx);
  if (ctx.config.role !== "web") {
    await registerHookRoutes(app, ctx);
  }
}
