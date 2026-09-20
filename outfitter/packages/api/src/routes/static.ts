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
    // wildcard: false -- we register our own catch-all below for the SPA fallback, so
    // @fastify/static only needs to serve actual files (JS/CSS/etc.) under their real paths.
    await app.register(fastifyStatic, { root: WEB_DIST, prefix: "/", wildcard: false });

    // SPA fallback: react-router's client-side routes (e.g. /sessions/:id, /providers) have no
    // matching file in dist/, so any GET that isn't an API route and isn't a static asset falls
    // through to index.html and the router takes over client-side. Registered after the api/agent
    // routes (registerRoutes in routes/index.ts calls this last) so it never shadows them.
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== "GET" || req.url.startsWith("/api/") || req.url.startsWith("/agent/")) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      reply.sendFile("index.html");
    });
    return;
  }

  app.get("/", async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return "<!doctype html><title>Outfitter</title><p>outfitter-api is running. The web UI has not been built yet.</p>";
  });
}
