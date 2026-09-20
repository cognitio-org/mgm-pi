import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { registerSessionRoutes } from "./sessions.ts";
import { registerGuruRoutes } from "./gurus.ts";
import { registerEnvironmentRoutes } from "./environments.ts";
import { registerMeRoute } from "./me.ts";
import { registerHookRoutes } from "./hooks.ts";
import { registerStaticRoutes } from "./static.ts";

export type { RouteContext } from "./context.ts";

export async function registerRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  await registerSessionRoutes(app, ctx);
  await registerGuruRoutes(app, ctx);
  await registerEnvironmentRoutes(app, ctx);
  await registerMeRoute(app, ctx);
  await registerHookRoutes(app, ctx);
  await registerStaticRoutes(app);
}
