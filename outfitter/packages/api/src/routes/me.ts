import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";

/** GET /api/me: the caller's identity, established by the auth preHandler in server.ts. Also
 * registered on the "link" role (routes/index.ts) so a teleport client can sanity-check its token
 * without touching a session; `linkOrigin` is only meaningful there conceptually but is returned
 * from every role so the web UI's Tokens page (which only ever talks to the "web"/"all" role) can
 * read it too -- it comes from OUTFITTER_LINK_ORIGIN (config.ts), set on the "web" role's own env
 * once the link service's URL is known (see deploy/service.sh). */
export async function registerMeRoute(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/me", async (req) => {
    const email = req.identity!.email;
    await ctx.store.users.upsertSeen(email);
    return { email, linkOrigin: ctx.config.linkOrigin || undefined };
  });
}
