// Repositories the GitHub App can reach, for the browser.
//
// The list, one repository, creating a repository, and a Floppy's live branch / pull requests
// all go through GithubCatalog. That class mints its own short-lived tokens. Nothing here
// returns a token or an installation id. The link role does not register these routes: a Dongle
// that can steer a Floppy is not a way to list or create repositories.

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";
import { getSessionOr404 } from "./sessions.ts";

export async function registerGithubRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  // 200 even when the App is not set up, so the page can explain why the list is empty.
  // `?fresh=1` skips the short cache (the page's Try again).
  app.get("/api/github/repos", async (req) => {
    const fresh = (req.query as { fresh?: string }).fresh === "1";
    return ctx.githubCatalog.list({ fresh });
  });

  app.get("/api/github/repos/:owner/:repo", async (req, reply) => {
    const { owner, repo } = req.params as { owner: string; repo: string };
    const result = await ctx.githubCatalog.detail(owner, repo);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.repo;
  });

  app.post("/api/github/repos", async (req, reply) => {
    const body = (req.body ?? {}) as { owner?: unknown; name?: unknown; private?: unknown; description?: unknown };
    if (typeof body.owner !== "string" || typeof body.name !== "string") {
      return reply.code(400).send({ error: "owner and name must be GitHub names, like acme/widget" });
    }
    const result = await ctx.githubCatalog.create({
      owner: body.owner,
      name: body.name,
      ...(body.private !== undefined ? { private: body.private as boolean } : {}),
      ...(typeof body.description === "string" ? { description: body.description } : {}),
    });
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send({ repo: result.repo });
  });

  // Always 200 when the Floppy exists. `connected: false` means the App cannot see the repository;
  // the Floppy page then hides the live facts and keeps the ordinary repository chip.
  app.get("/api/sessions/:id/github-status", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    return ctx.githubCatalog.sessionStatus(session);
  });
}
