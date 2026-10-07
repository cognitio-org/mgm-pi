// Repositories the GitHub App can reach, for the browser.
//
// The list, one repository, creating a repository, and a Floppy's live branch / pull requests
// all go through GithubCatalog. That class mints its own short-lived tokens. Nothing here
// returns a token or an installation id. The link role does not register these routes: a Dongle
// that can steer a Floppy is not a way to list or create repositories.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SessionActor } from "../github-broker.ts";
import type { RouteContext } from "./context.ts";
import { getManageableSessionOr404, getSessionOr404 } from "./sessions.ts";

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
  // #500: plus `pr` (the branch's open pull request with checks, review and mergeability, read
  // through the broker) and `mergeAllowed`. `prError` says why `pr` couldn't be read.
  // `?fresh=1` skips the broker's short cache.
  app.get("/api/sessions/:id/github-status", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const fresh = (req.query as { fresh?: string } | undefined)?.fresh === "1";
    const [status, pr] = await Promise.all([
      ctx.githubCatalog.sessionStatus(session),
      ctx.github.sessionPrStatus(session, { fresh }),
    ]);
    return { ...status, ...pr };
  });

  // #500: the session owner's (or a sysop's) pull request actions. Each write takes an optional
  // idempotency key (`Idempotency-Key` header, or `idempotencyKey` in the body): a repeat with the
  // same key gets the first answer back instead of acting twice.

  // { title, body?, draft? } → 201 { number, url, draft, base, template }. 409 `pr-exists` (with
  // number and url), `no-commits`, `no-branch`.
  app.post("/api/sessions/:id/pr", async (req, reply) => {
    const session = await getManageableSessionOr404(ctx, req, reply);
    if (!session) return;
    const body = bodyOf(req.body);
    const result = await ctx.github.createSessionPr(session, actorOf(req), body, keyOf(req.headers, body));
    if (!result.ok) return fail(reply, result);
    ctx.githubCatalog.forgetSessionStatus(session);
    return reply.code(201).send(result.data);
  });

  // { sha, method?: "squash" | "merge" | "rebase" } → { number, method, sha, merged, detail }.
  // 403 `merge-not-allowed` unless the tape has mergeFromCloud (never for an A2A session);
  // 409 `no-pr`, `head-moved`, `not-mergeable`.
  app.post("/api/sessions/:id/pr/merge", async (req, reply) => {
    const session = await getManageableSessionOr404(ctx, req, reply);
    if (!session) return;
    const body = bodyOf(req.body);
    const result = await ctx.github.mergeSessionPr(session, actorOf(req), body, keyOf(req.headers, body));
    if (!result.ok) return fail(reply, result);
    ctx.githubCatalog.forgetSessionStatus(session);
    return result.data;
  });

  // → { status: "updated" | "up-to-date" | "conflict", via, base, sha?, branchMoved, agentNote? }.
  // A conflict is a 200. `branchMoved: true` means GitHub's branch has a commit a live Drive's
  // checkout doesn't: the UI should tell the agent `agentNote` (pull before going on).
  app.post("/api/sessions/:id/sync", async (req, reply) => {
    const session = await getManageableSessionOr404(ctx, req, reply);
    if (!session) return;
    const body = bodyOf(req.body);
    const result = await ctx.github.syncSession(session, actorOf(req), keyOf(req.headers, body));
    if (!result.ok) return fail(reply, result);
    ctx.githubCatalog.forgetSessionStatus(session);
    return result.data;
  });

  // → { status: "rerun" | "nothing-to-rerun", sha, rerun: [{ id, name }] }. 403
  // `actions-permission` until the App has Actions: write.
  app.post("/api/sessions/:id/checks/rerun", async (req, reply) => {
    const session = await getManageableSessionOr404(ctx, req, reply);
    if (!session) return;
    const body = bodyOf(req.body);
    const result = await ctx.github.rerunSessionChecks(session, actorOf(req), keyOf(req.headers, body));
    if (!result.ok) return fail(reply, result);
    return result.data;
  });

  // The tail of one failed GitHub Actions job's log (`checks[].id` where `hasLog`), for Fix CI.
  // → { id, name, conclusion, detailsUrl, log, truncated }. Owner or sysop only: a CI log can say
  // more than the repository's name does.
  app.get("/api/sessions/:id/checks/:checkId/log", async (req, reply) => {
    const session = await getManageableSessionOr404(ctx, req, reply);
    if (!session) return;
    const { checkId } = req.params as { checkId: string };
    const result = await ctx.github.sessionCheckLog(session, checkId);
    if (!result.ok) return fail(reply, result);
    return result.data;
  });
}

function bodyOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function keyOf(headers: Record<string, unknown>, body: Record<string, unknown>): unknown {
  const header = headers["idempotency-key"];
  if (typeof header === "string" && header) return header;
  return body.idempotencyKey;
}

function actorOf(req: FastifyRequest): SessionActor {
  // getManageableSessionOr404 has already refused a request without an identity.
  return { email: req.identity?.email ?? "" };
}

function fail(
  reply: FastifyReply,
  result: { status: number; error: string; code?: string; data?: Record<string, unknown> },
): FastifyReply {
  return reply.code(result.status).send({ ...(result.data ?? {}), error: result.error, ...(result.code ? { code: result.code } : {}) });
}
