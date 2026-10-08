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
import { profilingWanted } from "../sentry.ts";
import { registerSandboxRoutes } from "./sandbox.ts";
import { registerPreviewRoutes } from "./previews.ts";
import { registerIdeRoutes } from "./ide.ts";
import { registerVoiceRoutes } from "./voice.ts";
import { registerGithubRoutes } from "./github.ts";
import { registerAdminRoutes } from "./admin.ts";
import { registerAgentEngineRoutes } from "./agent-engine.ts";
import { registerA2ARoutes } from "./a2a.ts";
import { registerLaptopApprovalRoutes } from "./laptop-approvals.ts";
import { registerDeviceRoutes } from "./device.ts";
import { registerConfigRoutes } from "./config.ts";
import { registerKeyRoutes } from "./keys.ts";
import { registerConnectionRoutes } from "./connections.ts";
import { registerLocalHostRoutes } from "./local-hosts.ts";

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
    await registerAgentEngineRoutes(app, ctx);
    await registerVoiceRoutes(app, ctx);
    await registerGithubRoutes(app, ctx);
    await registerAdminRoutes(app, ctx);
    // E9.9: the approval widget's list and answer, for a person under IAP (never on link).
    await registerLaptopApprovalRoutes(app, ctx);
    // MO-5 (#487, docs/specs/mcp-connections.md): the person's OAuth MCP grants.
    await registerConnectionRoutes(app, ctx);
    // #424: the shell allows browser profiling while the fleet settings ask for web profiles.
    await registerStaticRoutes(app, { profiling: () => profilingWanted(ctx.fleetSettings.peek()?.telemetry.sentry) });
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
  // Central sign-in and settings (#389, docs/specs/central-auth.md): each module registers its own
  // routes per role.
  await registerDeviceRoutes(app, ctx);
  await registerConfigRoutes(app, ctx);
  await registerKeyRoutes(app, ctx);
  // Local Host (#378, docs/specs/local-host.md): the module registers its own routes per role.
  await registerLocalHostRoutes(app, ctx);
  if (ctx.config.role !== "web") {
    await registerHookRoutes(app, ctx);
    // E9 §5.1: the A2A server lives on the public link origin (and "all" in dev). The web role is
    // behind IAP, which no A2A client can pass.
    await registerA2ARoutes(app, ctx);
  }
}
