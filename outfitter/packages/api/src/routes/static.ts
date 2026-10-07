// Serves the built web UI (packages/web/dist, built separately) at "/". Until that package
// exists, GET "/" returns a one-line placeholder instead of a 404, so the bare API is still
// checkable in a browser.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";

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

/** #424: the browser's JS Self-Profiling API, which Sentry's browserProfilingIntegration needs, is
 * only there for a document served with this policy. */
export const JS_PROFILING_POLICY = "js-profiling";

export interface StaticRouteOptions {
  /** Tests: a directory standing in for packages/web/dist. */
  webDist?: string;
  /** Whether the fleet settings have web profiling on right now (Sentry on, profilesSampleRate
   * above 0): the shell then carries `Document-Policy: js-profiling`. Read per response, so a
   * change applies on each browser's next load. Absent: never. */
  profiling?: () => boolean;
}

export async function registerStaticRoutes(app: FastifyInstance, opts: StaticRouteOptions = {}): Promise<void> {
  const webDist = opts.webDist ?? WEB_DIST;
  /** The shell's own headers: never cached, and the profiling policy while profiling is on. The
   * policy goes only with profiling, not always: it makes the browser keep what a profiler needs. */
  const shellHeaders = (reply: FastifyReply): FastifyReply => {
    reply.header("Cache-Control", NO_CACHE);
    if (opts.profiling?.()) reply.header("Document-Policy", JS_PROFILING_POLICY);
    return reply;
  };
  if (existsSync(webDist)) {
    const fastifyStatic = (await import("@fastify/static")).default;
    // wildcard: false -- we register our own catch-all below for the SPA fallback, so
    // @fastify/static only needs to serve actual files (JS/CSS/etc.) under their real paths.
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      wildcard: false,
      setHeaders: (reply, filePath) => {
        if (filePath.endsWith("index.html")) shellHeaders(reply);
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
      shellHeaders(reply).sendFile("index.html");
    });
    return;
  }

  app.get("/", async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return "<!doctype html><title>Outfitter</title><p>outfitter-api is running. The web UI has not been built yet.</p>";
  });
}
