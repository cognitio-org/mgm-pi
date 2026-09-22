// Serves the built web UI (packages/web/dist, built separately) at "/". Until that package
// exists, GET "/" returns a one-line placeholder instead of a 404, so the bare API is still
// checkable in a browser.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const WEB_DIST = fileURLToPath(new URL("../../../web/dist", import.meta.url));

/** Whether a request that matched no route should get the SPA shell (index.html). Only GETs for
 * client-side routes do. API and agent paths, and anything that looks like a file (under /assets/
 * or with an extension in its last segment), get a real 404: after a deploy, a browser holding the
 * previous index.html asks for the previous build's hashed assets, and answering those with HTML
 * turns a clear 404 into a blank page and a MIME-type error. */
export function servesSpaShell(method: string, url: string): boolean {
  if (method !== "GET") return false;
  const path = url.split("?")[0];
  if (path.startsWith("/api/") || path.startsWith("/agent/") || path.startsWith("/assets/")) return false;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return !last.includes(".");
}

/** The shell must never be cached: it names the current build's hashed assets. */
const NO_CACHE = "no-cache";

export async function registerStaticRoutes(app: FastifyInstance): Promise<void> {
  if (existsSync(WEB_DIST)) {
    const fastifyStatic = (await import("@fastify/static")).default;
    // wildcard: false -- we register our own catch-all below for the SPA fallback, so
    // @fastify/static only needs to serve actual files (JS/CSS/etc.) under their real paths.
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: "/",
      wildcard: false,
      setHeaders: (reply, filePath) => {
        if (filePath.endsWith("index.html")) reply.header("Cache-Control", NO_CACHE);
      },
    });

    // SPA fallback: react-router's client-side routes (e.g. /sessions/:id, /providers) have no
    // matching file in dist/, so any GET that isn't an API route and isn't a static asset falls
    // through to index.html and the router takes over client-side. Registered after the api/agent
    // routes (registerRoutes in routes/index.ts calls this last) so it never shadows them.
    app.setNotFoundHandler((req, reply) => {
      if (!servesSpaShell(req.method, req.url)) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      reply.header("Cache-Control", NO_CACHE).sendFile("index.html");
    });
    return;
  }

  app.get("/", async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return "<!doctype html><title>Outfitter</title><p>outfitter-api is running. The web UI has not been built yet.</p>";
  });
}
