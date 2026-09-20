import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";

/** GET /api/me: the caller's identity, established by the auth preHandler in server.ts. */
export async function registerMeRoute(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/me", async (req) => {
    const email = req.identity!.email;
    await ctx.store.users.upsertSeen(email);
    return { email };
  });
}
