// Serves the built web UI (packages/web/dist, built separately) at "/". Until that package
// exists, GET "/" returns a one-line placeholder instead of a 404, so the bare API is still
// checkable in a browser.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const WEB_DIST = fileURLToPath(new URL("../../../web/dist", import.meta.url));

export async function registerStaticRoutes(app: FastifyInstance): Promise<void> {
  if (existsSync(WEB_DIST)) {
    const fastifyStatic = (await import("@fastify/static")).default;
    await app.register(fastifyStatic, { root: WEB_DIST, prefix: "/" });
    return;
  }

  app.get("/", async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return "<!doctype html><title>Outfitter</title><p>outfitter-api is running. The web UI has not been built yet.</p>";
  });
}
