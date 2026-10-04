import type { FastifyInstance } from "fastify";
import { greetingName } from "../greeting.ts";
import { clientFleetSettings, withDefaults } from "../fleet-settings.ts";
import type { RouteContext } from "./context.ts";
import { clientIp } from "../central/device-login.ts";

/** GET /api/me: the caller's identity, established by the auth preHandler in server.ts. Also
 * registered on the "link" role (routes/index.ts) so a teleport client can sanity-check its token
 * without touching a session; `linkOrigin` is only meaningful there conceptually but is returned
 * from every role so the web UI's Tokens page (which only ever talks to the "web"/"all" role) can
 * read it too -- it comes from OUTFITTER_LINK_ORIGIN (config.ts), set on the "web" role's own env
 * once the link service's URL is known (see deploy/service.sh). `operator` (EPIC.md Decisions
 * table) is what the web UI's App shell uses to decide whether to show the Settings nav link --
 * always `false` on the "link" role, since identityFromLinkRequest never grants it (auth.ts). */
export async function registerMeRoute(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  // The web app's version indicator: what's deployed. Signed-in users only, like every /api route.
  app.get("/api/version", async () => ({
    commit: ctx.config.buildCommit || null,
    release: ctx.config.release || null,
  }));

  // Fleet settings (fleet-settings.ts) for this caller's own machine: Kernal reads it with a
  // Dongle on the link role, the web app under IAP before it starts Sentry. Read from the store,
  // not the instance cache, so a laptop sees an operator's change on its next start.
  app.get("/api/fleet-settings", async () => clientFleetSettings(withDefaults(await ctx.store.fleetSettings.get())));

  app.get("/api/me", async (req) => {
    const email = req.identity!.email;
    const user = await ctx.store.users.upsertSeen(email);
    const name = greetingName(user);
    return {
      email,
      operator: req.identity!.operator,
      linkOrigin: ctx.config.linkOrigin || undefined,
      // #389 CA-1: the caller's IP as this role sees it, so the approve page can warn when a device
      // code was requested from somewhere else (docs/specs/central-auth.md §1.9).
      ip: clientIp(req),
      // Omitted when there is nothing safe to greet with. The web UI copies it into a cookie the
      // kernal.one landing page can read; see landing/public/welcome.js.
      ...(name ? { name } : {}),
    };
  });
}
