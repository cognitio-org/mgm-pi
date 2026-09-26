// Session and run-control REST routes plus the SSE stream. See docs/protocol.md "browser <-> api".

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.ts";
import type { Session, PiEntry, Run } from "../store/types.ts";
import { MAIL_HELD_NOTICE, MAIL_MAX_TEXT } from "../mail.ts";
import { GITHUB_TOKEN_DEFAULT_SECRET } from "../secrets.ts";
import { GITHUB_APP_ID_SECRET, GITHUB_APP_INSTALLATION_SECRET, GITHUB_APP_KEY_SECRET, GITHUB_APP_SLUG_SECRET, githubAppSecretsUsable, githubRepoName } from "../github-app.ts";
import { sessionGithubTokenSecretName } from "../operator.ts";
import { entryForWire } from "../entry-wire.ts";
import { summarizeStartup } from "../startup.ts";

const SESSION_VERSION = 3; // matches pi's CURRENT_SESSION_VERSION; keeps export.jsonl pi-compatible

/** Same checks `GithubAppTokens.mint` uses before it calls GitHub. Existence of a secret version is not enough. */
async function githubAppConfigured(ctx: RouteContext, repo: string): Promise<boolean> {
  if (!githubRepoName(repo)) return false;
  try {
    const [appId, privateKey, installationId] = await Promise.all([
      ctx.secretAdmin.accessLatest(GITHUB_APP_ID_SECRET),
      ctx.secretAdmin.accessLatest(GITHUB_APP_KEY_SECRET),
      ctx.secretAdmin.accessLatest(GITHUB_APP_INSTALLATION_SECRET),
    ]);
    return githubAppSecretsUsable(appId ?? "", privateKey ?? "", installationId ?? "");
  } catch (err) {
    console.warn(`[sessions] github app secrets unreadable: ${err instanceof Error ? err.name : "Error"}`);
    return false;
  }
}

async function githubAppSlug(ctx: RouteContext): Promise<string | null> {
  const raw = (await ctx.secretAdmin.accessLatest(GITHUB_APP_SLUG_SECRET))?.trim() ?? "";
  return /^[A-Za-z0-9-]+$/.test(raw) ? raw : null;
}

interface SessionSummary {
  id: string;
  name?: string;
  status: Session["status"];
  runState?: string;
  /** Why the last run ended badly, for a `runState` of "failed" only -- its statusDetail (the
   * human-readable note agentlink.ts's refuse() and runs.ts's reconciler write) falling back to its
   * shorter `reason`. Lets the Drives list say why a floppy failed instead of only colouring the
   * pill; the session page gets the same text over SSE (sse.ts). */
  runStateReason?: string;
  guru: string;
  repo: string | null;
  branch?: string;
  parentId?: string;
  cost: number;
  updatedAt: string;
}

/** The run whose state a session row (or GET /api/sessions/:id) reports: the active one, or -- when
 * there is none -- the most recent, so a run that ended reads as what actually happened to it.
 *
 * `runState` used to be the active run's state alone, i.e. undefined for every session whose run had
 * ended. The Drives list (packages/web FleetPage) renders that as the "stopped" pill, so a session
 * whose run the api refused looked exactly like one someone had cleanly stopped; the desk's Trash
 * count (lib/desk.ts's stoppedSessionCount, which already tests for "stopped" and "failed") could
 * never count anything; and `?runState=failed` -- an option in the list's own filter -- could never
 * match. sse.ts's pollOne already resolves the session page's header this way, and consumers that
 * care about liveness test against their own active-state set rather than undefined-ness (kernal's
 * teleport OutfitterStore, lib/desk.ts, lib/send-status.ts). */
async function reportableRun(ctx: RouteContext, sessionId: string): Promise<Run | null> {
  const active = await ctx.store.runs.findActiveForSession(sessionId);
  return active ?? (await ctx.store.runs.findLatestForSession(sessionId));
}

async function htmlPreviewAccessByRun(ctx: RouteContext, sessionId: string): Promise<Record<string, boolean>> {
  const byRun: Record<string, boolean> = {};
  for (const run of await ctx.store.runs.listForSession(sessionId)) {
    if (run.allowExternalHtmlResources !== undefined) byRun[run.id] = run.allowExternalHtmlResources;
  }
  return byRun;
}

/** A failed run's own explanation, preferring the full note over the short close/reconcile reason. */
function runStateReason(run: Run | null): string | undefined {
  if (run?.state !== "failed") return undefined;
  return run.statusDetail ?? run.reason;
}

async function summarize(ctx: RouteContext, session: Session): Promise<SessionSummary> {
  const run = await reportableRun(ctx, session.id);
  return {
    id: session.id,
    name: session.name,
    status: session.status,
    runState: run?.state,
    runStateReason: runStateReason(run),
    guru: session.guruId,
    repo: session.repo,
    branch: session.branch,
    parentId: session.parentId,
    cost: session.cost,
    updatedAt: session.updatedAt,
  };
}

function headerLine(session: Session): string {
  const header = {
    type: "session" as const,
    version: SESSION_VERSION,
    id: session.id,
    timestamp: session.createdAt,
    cwd: "/workspace",
    ...(session.parentId ? { parentSession: session.parentId } : {}),
  };
  return JSON.stringify(header);
}

/** One header value. `undefined` is absent (including an empty value); `false` is a repeated header. */
function oneHeader(req: FastifyRequest, name: string): string | undefined | false {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return false;
  if (raw === undefined || raw === "") return undefined;
  return raw;
}

/** Not an option injection (`-x`) and not a `..` path segment. */
function validTeleportBranch(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !value.includes("..");
}

/** `owner/repo` only. `cloneUrlFor` turns that into https://github.com; anything else, including `git@`, would be cloned as written. */
function validOwnerRepo(value: string): boolean {
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  return parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && !part.includes(".."));
}

/** Laptop-to-cloud repo from the teleport headers. No such headers → `patch: null` (repo stays null). */
function teleportRepoPatch(req: FastifyRequest): { error: string } | { patch: Partial<Session> | null } {
  const repo = oneHeader(req, "x-outfitter-repo");
  const branch = oneHeader(req, "x-outfitter-branch");
  const base = oneHeader(req, "x-outfitter-base");
  const head = oneHeader(req, "x-outfitter-head");
  if (repo === false) return { error: "invalid x-outfitter-repo" };
  if (branch === false) return { error: "invalid x-outfitter-branch" };
  if (base === false) return { error: "invalid x-outfitter-base" };
  if (head === false) return { error: "invalid x-outfitter-head" };
  if (repo === undefined && branch === undefined && base === undefined && head === undefined) return { patch: null };
  // Any one header means a carried repository. A branch alone must not retarget a session that already has one.
  if (repo === undefined || branch === undefined || base === undefined || head === undefined || !/^[0-9a-f]{40}$/i.test(head ?? "")) {
    return { error: "x-outfitter-repo, branch, base, and a 40-hex head are required together" };
  }
  if (!validOwnerRepo(repo)) return { error: "invalid x-outfitter-repo" };
  if (!validTeleportBranch(branch)) return { error: "invalid x-outfitter-branch" };
  if (!validTeleportBranch(base)) return { error: "invalid x-outfitter-base" };
  return { patch: { repo, branch, baseBranch: base, checkpoint: { branch, head } } };
}

/** The subset of session routes the "link" role registers for teleport (docs/protocol.md "browser
 * <-> api"): list/get/export/import/stop, nothing that needs a live agentd socket beyond `stop`
 * (which only enqueues a down-message through the store either way — see the route's own comment).
 * registerSessionRoutes (the "web"/"all" role) calls this first, then adds the rest, so neither
 * role duplicates the handler logic. */
export async function registerTeleportRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/sessions", async (req) => {
    // Code review M1 (docs/reports/code-review-pr15.md): `status` here is Session.status
    // ("open"/"closed"), while `runState` (queued/provisioning/running/idle/stopping/stopped/
    // failed) only exists per-run, computed by summarize() below -- it isn't a store-level filter.
    // Filter on it post-hoc, after summarizing, rather than pretending the store can push it down.
    const query = req.query as { status?: string; guru?: string; runState?: string };
    const sessions = await ctx.store.sessions.list({ status: query.status, guruId: query.guru });
    const summaries = await Promise.all(sessions.map((s) => summarize(ctx, s)));
    if (!query.runState) return summaries;
    return summaries.filter((s) => s.runState === query.runState);
  });

  app.get("/api/sessions/:id", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    // runState (not on Session itself -- see store/types.ts's Run) lets a caller like the kernal
    // teleport extension's OutfitterStore poll "has the active run stopped yet?" without a second
    // request; GET /api/sessions already computes the same thing per-row via summarize(), and both
    // resolve it the same way (reportableRun) so the list and the detail never disagree.
    const run = await reportableRun(ctx, session.id);
    // Cloud-fixes 13: mail parked because this session's runs never validated the protocol.
    const heldMail = await ctx.store.mail.countHeld(session.id);
    // The side panel reads the approval from here. Same run as runState (reportableRun, which is
    // what the list's summarize() uses) but only while that run is active — sse.ts publishes
    // pendingUiRequest from findActiveForSession and drops it once the run is terminal. null, not
    // omitted, when there is nothing to answer.
    const pendingUiRequest =
      run && run.state !== "stopped" && run.state !== "failed" ? (run.pendingUiRequest ?? null) : null;
    const guru = await ctx.store.gurus.findById(session.guruId);
    const owner = session.ownerEmail ? await ctx.store.users.findByEmail(session.ownerEmail) : null;
    const login = owner?.githubLogin?.replace(/^@/, "").trim() ?? "";
    const ownToken = await ctx.secretAdmin.info(sessionGithubTokenSecretName(session.id));
    const appConfigured = session.repo ? await githubAppConfigured(ctx, session.repo) : false;
    const sharedToken = ownToken.set || !session.repo || appConfigured ? { set: false } : await ctx.secretAdmin.info(GITHUB_TOKEN_DEFAULT_SECRET);
    const credential = ownToken.set ? "session" : appConfigured ? "app" : sharedToken.set ? "default" : "none";
    const appSlug = credential === "app" ? await githubAppSlug(ctx) : null;
    return {
      ...session,
      runState: run?.state,
      runStateReason: runStateReason(run),
      pendingUiRequest,
      // How long the reportable run took to start, step by step (startup.ts); null before it has
      // started, or for a run that predates the timings.
      startup: run ? summarizeStartup(run) : null,
      // Issue #132: the HTML preview's starting access. The run's own copy, so an old session's
      // preview matches the prompt that run was given; before any run has recorded one, the
      // Tape's current value, which is what the next run will get.
      allowExternalHtmlResources: run?.allowExternalHtmlResources ?? guru?.allowExternalHtmlResources === true,
      // #147: each run's own value, keyed by run id, so an entry that carries `outfitterRunId`
      // (entry-wire.ts) previews the way its run was told. Runs that never recorded one are left
      // out; their entries use allowExternalHtmlResources above.
      htmlPreviewAccessByRun: await htmlPreviewAccessByRun(ctx, session.id),
      heldMail,
      ...(heldMail > 0 ? { mailNotice: MAIL_HELD_NOTICE } : {}),
      github: {
        repo: session.repo ?? null,
        branch: session.branch ?? null,
        credential,
        ...(appSlug ? { appSlug } : {}),
        merge: guru?.mergeFromCloud === true,
        onBehalfOf: /^[A-Za-z0-9-]+$/.test(login) ? login : null,
      },
    };
  });

  app.post("/api/sessions/:id/stop", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run) return reply.code(404).send({ error: "no active run" });

    // Code review M2 (docs/reports/code-review-pr15.md): branch explicitly on all three cases
    // instead of collapsing "not running/idle" into "cancel directly" -- that used to also catch
    // an already-`stopping` run and force-kill it via the provider mid-checkpoint/mid-drain, which
    // is exactly what the `stopping` grace period exists to avoid. A second `/stop` call while
    // already stopping is a no-op: return the current run and let the existing grace-period /
    // RunManager.reconcileStoppingOnce path finish it.
    if (run.state === "stopping") {
      return { run };
    }

    if (run.state !== "running" && run.state !== "idle") {
      // No live agent yet (queued/provisioning) to ask gracefully -- cancel the provider execution
      // directly, same as before.
      const stopped = await ctx.runs.stop(run.id, "user");
      return { run: stopped };
    }

    // Graceful stop: always enqueue the `stop` down-message through the store rather than branch on
    // ctx.agentLink.hasSocket, which is process-local -- outfitter-api (this, the web role) never
    // holds an agentd socket at all (see docs/protocol.md "Two origins"), so hasSocket is always
    // false here and used to fall through to a provider cancel (SIGTERM) instead of the graceful
    // stop this route means to send. agentLink.send delivers immediately if this process happens to
    // hold the live socket (e.g. local dev's role "all"), otherwise the link role's poller picks the
    // message up from the store on its next tick. Mark the run `stopping` *after* the send call so
    // an immediate, same-process delivery above still sees the run as running/idle and isn't forced
    // to queue instead. If agentd never finishes the graceful stop (checkpoint + `bye`) within
    // STOP_GRACE_MS, RunManager.reconcileStoppingOnce cancels the sandbox via the provider.
    await ctx.agentLink.send(run.id, { t: "stop", reason: "user" });
    const stopping = await ctx.store.runs.update(run.id, { state: "stopping", updatedAt: new Date().toISOString() });
    return { run: stopping };
  });

  app.get("/api/sessions/:id/export.jsonl", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const entries = await ctx.store.entries.listForSession(session.id);
    const lines = [headerLine(session), ...entries.map((e) => JSON.stringify(e.entry))];
    reply.header("Content-Type", "application/x-ndjson");
    return lines.join("\n") + "\n";
  });

  app.put("/api/sessions/:id/import", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const active = await ctx.store.runs.findActiveForSession(id);
    if (active) return reply.code(409).send({ error: "a run is active for this session" });

    // Repo rides on headers so the JSONL body stays a pi transcript: x-outfitter-repo, x-outfitter-branch, x-outfitter-base, x-outfitter-head.
    const carried = teleportRepoPatch(req);
    if ("error" in carried) return reply.code(400).send({ error: carried.error });

    const body = typeof req.body === "string" ? req.body : String(req.body ?? "");
    const lines = body.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return reply.code(400).send({ error: "empty JSONL body" });

    const header = JSON.parse(lines[0]) as { type: string; id: string; cwd?: string; timestamp?: string };
    if (header.type !== "session") return reply.code(400).send({ error: "first line must be a session header" });
    if (header.id !== id) return reply.code(400).send({ error: "header id does not match :id" });

    const existing = await ctx.store.sessions.findById(id);
    if (existing?.repo && carried.patch?.repo && existing.repo !== carried.patch.repo) {
      return reply.code(409).send({ error: "this session is already bound to a repository" });
    }
    const now = new Date().toISOString();
    let session = existing;
    if (!session) {
      session = {
        id,
        guruId: "",
        repo: carried.patch?.repo ?? null,
        branch: carried.patch?.branch,
        baseBranch: carried.patch?.baseBranch,
        checkpoint: carried.patch?.checkpoint,
        status: "open",
        cost: 0,
        createdAt: header.timestamp ?? now,
        updatedAt: now,
      };
      await ctx.store.sessions.insert(session);
    }

    let seq = await ctx.store.entries.maxSeq(id);
    let leafId = session.leafId;
    for (const line of lines.slice(1)) {
      const entry = JSON.parse(line) as PiEntry;
      const inserted = await ctx.store.entries.insertIfNew(id, ++seq, entry);
      if (inserted) leafId = entry.id;
    }
    await ctx.store.sessions.update(id, { leafId, updatedAt: now, ...(existing && carried.patch ? carried.patch : {}) });

    return { id, imported: lines.length - 1 };
  });
}

/** Session routes the side panel calls on the link role as well as web (chrome companion §9.1).
 * Not part of registerTeleportRoutes: teleport doesn't steer, answer approvals, or Play.
 * Play is POST /wake. The panel cannot call the IAP web origin, so wake lives here.
 * Stop stays on the teleport routes. */
export async function registerPanelRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/api/sessions/:id/entries", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const { after } = req.query as { after?: string };
    const entries = await ctx.store.entries.listForSession(session.id, after);
    return entries.map(entryForWire);
  });

  app.post("/api/sessions/:id/messages", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const body = req.body as { text: string; behavior?: "steer" | "followUp" };
    if (!body?.text) return reply.code(400).send({ error: "text is required" });
    if (body.text.length > MAIL_MAX_TEXT) return reply.code(413).send({ error: `text is over ${MAIL_MAX_TEXT} characters` });

    const run = await postUserMail(ctx, session.id, req.identity?.email, body.text, body.behavior);
    // 202: stored, but no run could be started yet; it will be delivered when one is.
    return reply.code(run ? 200 : 202).send({ run });
  });

  app.post("/api/sessions/:id/abort", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run) return reply.code(404).send({ error: "no active run" });
    await ctx.agentLink.send(run.id, { t: "abort" });
    return { run };
  });

  app.post("/api/sessions/:id/ui-response", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const body = req.body as { id: string; value: unknown };
    if (!body?.id) return reply.code(400).send({ error: "id is required" });
    const run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run) return reply.code(404).send({ error: "no active run" });
    await ctx.agentLink.send(run.id, { t: "ui_response", id: body.id, value: body.value });
    await ctx.store.runs.update(run.id, { pendingUiRequest: undefined, updatedAt: new Date().toISOString() });
    return { run };
  });

  app.post("/api/sessions/:id/wake", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const run = await ctx.runs.wake(session.id);
    return { run };
  });
}

export async function registerSessionRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  await registerTeleportRoutes(app, ctx);
  await registerPanelRoutes(app, ctx);

  app.post("/api/sessions", async (req, reply) => {
    const body = req.body as {
      guruId: string;
      repo?: string;
      baseBranch?: string;
      branch?: string;
      prompt: string;
      name?: string;
      /** Per-session model override; see src/laptop.ts's E2.8 preflight for how this is resolved. */
      model?: string;
    };
    if (!body?.guruId || !body?.prompt) {
      return reply.code(400).send({ error: "guruId and prompt are required" });
    }
    if (body.prompt.length > MAIL_MAX_TEXT) return reply.code(413).send({ error: `prompt is over ${MAIL_MAX_TEXT} characters` });
    const guru = await ctx.store.gurus.findById(body.guruId);
    if (!guru) return reply.code(400).send({ error: `unknown guruId: ${body.guruId}` });

    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      name: body.name,
      // Recorded but not yet enforced -- see Session.ownerEmail's doc comment and EPIC.md's E2.2
      // note (finding #5, docs/reports/security-review-pr1.md).
      ownerEmail: req.identity?.email,
      guruId: body.guruId,
      // repo omitted = non-coding session (protocol.md): no clone, no branch.
      repo: body.repo ?? null,
      baseBranch: body.repo ? body.baseBranch : undefined,
      branch: body.repo ? (body.branch ?? `outfitter/${randomUUID().slice(0, 8)}`) : undefined,
      prompt: body.prompt,
      modelOverride: body.model,
      status: "open",
      cost: 0,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.store.sessions.insert(session);

    const run = await postUserMail(ctx, session.id, req.identity?.email, body.prompt);
    return reply.code(201).send({ session, run });
  });

  app.get("/api/sessions/:id/stream", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    reply.hijack(); // we own the raw response now; Fastify must not also try to send it
    ctx.sse.subscribe(session.id, reply);
    const run = await ctx.store.runs.findActiveForSession(session.id);
    // Bug 3 (docs/reports/cloud-fixes.md): a hardcoded "stopped" here used to hide the difference
    // between a cleanly stopped run and a failed one (both have no *active* run) -- fall back to
    // the most recent run's real terminal state (and its reason) so the header/composer can tell
    // "stopped" from "LOAD ERROR" on first paint, before any live status frame arrives.
    const latest = run ?? (await ctx.store.runs.findLatestForSession(session.id));
    ctx.sse.publish(session.id, {
      type: "status",
      data: { t: "status", state: latest?.state ?? "stopped", reason: latest?.reason, startup: latest ? summarizeStartup(latest) : null },
    });
    // Bug 2 (docs/reports/cloud-fixes.md): in a split web/link deployment, entries and status
    // changes land on the "link" role's process (the agentd WebSocket) while this subscriber is on
    // the "web" role's process -- AgentLink's in-process publish never reaches it. ssePoller polls
    // the shared store on a short interval and republishes through this same hub, so this
    // subscriber (and any other on this process) still sees live updates. See sse.ts.
    ctx.ssePoller.watch(session.id);
    reply.raw.on("close", () => ctx.ssePoller.unwatch(session.id));
  });

  // Cloud-fixes 13: the web's Retry on the "Deploy mismatch" notice -- release this session's held
  // mail with a fresh wake budget and wake once.
  app.post("/api/sessions/:id/mail/retry", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const { released, result } = await ctx.mail.retryHeld(session.id);
    if (result === "active") await ctx.agentLink.deliverMailForSession(session.id);
    const heldMail = await ctx.store.mail.countHeld(session.id);
    return { released, result, heldMail };
  });

  app.get("/api/sessions/:id/diff", async (req, reply) => {
    const session = await getSessionOr404(ctx, req, reply);
    if (!session) return;
    const run = await ctx.store.runs.findActiveForSession(session.id);
    if (!run || !ctx.agentLink.hasSocket(run.id)) {
      return reply.code(409).send({ error: "no live run to diff" });
    }
    try {
      const result = await ctx.agentLink.request(run.id, { t: "diff" });
      return { base: result.base, patch: result.patch };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

}

/** Stores a browser message as mail (so a failed wake or a run that dies before it is ready can't
 * lose it); MailService.post also makes the one inline wake attempt. Returns the session's run, or
 * null when that wake failed -- the message is queued either way and Cloud Tasks / the /tick sweep
 * keep trying, so the caller must not retry (it would enqueue the text twice). */
async function postUserMail(
  ctx: RouteContext,
  sessionId: string,
  email: string | undefined,
  text: string,
  behavior?: "steer" | "followUp",
) {
  await ctx.mail.post({ sessionId, from: { kind: "user", email }, text, behavior });
  await ctx.agentLink.deliverMailForSession(sessionId);
  return ctx.store.runs.findActiveForSession(sessionId);
}

export async function getSessionOr404(
  ctx: RouteContext,
  req: FastifyRequest,
  reply: { code: (n: number) => { send: (body: unknown) => unknown } },
): Promise<Session | undefined> {
  const { id } = req.params as { id: string };
  const session = await ctx.store.sessions.findById(id);
  if (!session) {
    reply.code(404).send({ error: "session not found" });
    return undefined;
  }
  return session;
}
