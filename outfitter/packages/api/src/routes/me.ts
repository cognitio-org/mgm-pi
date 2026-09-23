import type { FastifyInstance } from "fastify";
import { greetingName } from "../greeting.ts";
import type { RouteContext } from "./context.ts";

/** GET /api/me: the caller's identity, established by the auth preHandler in server.ts. Also
 * registered on the "link" role (routes/index.ts) so a teleport client can sanity-check its token
 * without touching a session; `linkOrigin` is only meaningful there conceptually but is returned
 * from every role so the web UI's Tokens page (which only ever talks to the "web"/"all" role) can
 * read it too -- it comes from OUTFITTER_LINK_ORIGIN (config.ts), set on the "web" role's own env
 * once the link service's URL is known (see deploy/service.sh). `operator` (EPIC.md Decisions
 * table) is what the web UI's App shell uses to decide whether to show the Settings nav link --
 * always `false` on the "link" role, since identityFromLinkRequest never grants it (auth.ts). */
export async function registerMeRoute(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/me", async (req) => {
    const email = req.identity!.email;
    const user = await ctx.store.users.upsertSeen(email);
    const name = greetingName(user);
    return {
      email,
      operator: req.identity!.operator,
      linkOrigin: ctx.config.linkOrigin || undefined,
      // Omitted when there is nothing safe to greet with. The web UI copies it into a cookie the
      // kernal.one landing page can read; see landing/public/welcome.js.
      ...(name ? { name } : {}),
    };
  });
}
