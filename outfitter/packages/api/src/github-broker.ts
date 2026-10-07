// Phase 3 GitHub broker. The run's token stays in this process: agentd sends a
// github.request up-frame and gets a github.result down-frame. No gh passthrough.
// GraphQL is used only for review-thread replies and resolve.

import { createHash } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { isA2ASession, type SecretsBroker } from "./secrets.ts";
import { isA2ABranch } from "./branch-policy.ts";
import type { GithubIdempotencyRecord, GithubWriteProgress, Guru, Session, Store } from "./store/types.ts";
import { parseSessionRepo } from "./session-repo.ts";

const PENDING_MARK = "idempotency pending";
const LOW_REMAINING = 10;
const MAX_BACKOFF_MS = 3_000;
const MAX_KEY_LEN = 200;
const HTTP_TIMEOUT_MS = 60_000;

const READ_OPS = [
  "github_pr.view",
  "github_pr.list",
  "github_pr.checks",
  "github_issue.list",
  "github_issue.view",
  "github_repo.view",
  "github_repo.search",
  "github_repo.releases",
] as const;

const WRITE_OPS = [
  "github_pr.create",
  "github_pr.edit",
  "github_pr.comment",
  "github_pr.reply",
  "github_pr.review",
  "github_pr.resolve",
  "github_pr.merge",
  "github_issue.create",
  "github_issue.comment",
  "github_issue.edit",
  "github_issue.close",
  "github_issue.reopen",
] as const;

const OPS = new Set<string>([...READ_OPS, ...WRITE_OPS]);
const WRITES = new Set<string>(WRITE_OPS);

const TEMPLATE_FILES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];
const TEMPLATE_DIRS = [".github/PULL_REQUEST_TEMPLATE", ".github/pull_request_template", "docs/PULL_REQUEST_TEMPLATE"];

const FAILED_CHECK = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "CANCELED",
  "ACTION_REQUIRED",
  "ERROR",
  "STARTUP_FAILURE",
]);

export interface RateLimit {
  remaining: number;
  reset: number;
}

export type GithubOpResult =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      error: string;
      progress?: GithubWriteProgress;
      /** GitHub's HTTP status, for the web routes (#500). Never sent on the socket or stored. */
      status?: number;
    };

export interface GithubResponse {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

/** One GitHub round-trip. Production uses Octokit; tests pass a fake. */
export interface GithubTransport {
  request(route: string, params: Record<string, unknown>): Promise<GithubResponse>;
}

export interface GithubRequest {
  runId: string;
  op: unknown;
  args: unknown;
  idempotencyKey?: unknown;
}

type CallResult =
  | { ok: true; data: any }
  | { ok: false; error: string; status?: number; message?: string };

interface Ctx {
  runId: string;
  op: string;
  key?: string;
  write: boolean;
  session: Session;
  owner: string;
  repo: string;
  branch: string;
  token: string;
  transport: GithubTransport;
  footer: string;
  paced: boolean;
  rateLimit?: RateLimit;
  /** Steps of this write that already reached GitHub. A replay skips those and finishes the rest. */
  resume?: GithubWriteProgress;
}



const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

export function octokitTransport(token: string): GithubTransport {
  const octokit = new Octokit({ auth: token, userAgent: "outfitter", log: silentLog });
  const request = octokit.request as unknown as (
    route: string,
    params?: Record<string, unknown>,
  ) => Promise<{ status: number; data: unknown; headers: unknown }>;
  return {
    async request(route, params) {
      try {
        const res = await request(route, { ...params, request: { timeout: HTTP_TIMEOUT_MS } });
        return { status: res.status, data: res.data, headers: headerMap(res.headers) };
      } catch (err) {
        if (isRequestError(err)) {
          return { status: err.status, data: err.response?.data, headers: headerMap(err.response?.headers) };
        }
        throw err;
      }
    },
  };
}

export function headerMap(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return out;
  const asHeaders = headers as { forEach?: (fn: (value: string, key: string) => void) => void; get?: unknown };
  if (typeof asHeaders.forEach === "function" && typeof asHeaders.get === "function") {
    asHeaders.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
    else if (typeof value === "number") out[key.toLowerCase()] = String(value);
    else if (Array.isArray(value) && typeof value[0] === "string") out[key.toLowerCase()] = value[0];
  }
  return out;
}

export function rateLimitFromHeaders(headers: Record<string, string>): RateLimit | undefined {
  const remaining = Number(headers["x-ratelimit-remaining"]);
  const reset = Number(headers["x-ratelimit-reset"]);
  if (!Number.isFinite(remaining) || !Number.isFinite(reset)) return undefined;
  return { remaining, reset };
}

/** The github.request ops an A2A task's session may use (E9 §8): reads, and creating the pull
 * request for its own branch (the broker always uses the session branch as head). */
const A2A_GITHUB_OPS = new Set([
  "github_pr.view",
  "github_pr.checks",
  "github_pr.list",
  "github_pr.create",
  "github_issue.list",
  "github_issue.view",
  "github_repo.view",
  "github_repo.search",
  "github_repo.releases",
]);

export class GithubBroker {
  private readonly memory = new Map<string, Map<string, GithubIdempotencyRecord>>();
  private readonly inflight = new Map<string, Promise<GithubOpResult>>();
  private readonly heads = new Map<string, string>();
  /** Latest budget per token. Sessions on this process can use different credentials. */
  private readonly budgets = new Map<string, RateLimit>();
  private readonly store: Store;
  private readonly secrets: SecretsBroker;
  private readonly transportFor: (token: string) => GithubTransport;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    store: Store,
    secrets: SecretsBroker,
    transportFor: (token: string) => GithubTransport = octokitTransport,
    sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.store = store;
    this.secrets = secrets;
    this.transportFor = transportFor;
    this.sleep = sleep;
  }

  async handle(req: GithubRequest): Promise<GithubOpResult> {
    try {
      return await this.dispatch(req);
    } catch {
      return { ok: false, error: "github request failed" };
    }
  }

  private dispatch(req: GithubRequest): Promise<GithubOpResult> {
    const op = typeof req.op === "string" ? req.op.trim() : "";
    if (!OPS.has(op)) return this.settle(req.runId, op || "?", undefined, false, { ok: false, error: "unknown op" });
    const write = WRITES.has(op);
    const key = idempotencyKey(req.idempotencyKey);
    if (write && !key) {
      return this.settle(req.runId, op, undefined, false, { ok: false, error: "idempotencyKey is required" });
    }
    if (write && key && key.length > MAX_KEY_LEN) {
      return this.settle(req.runId, op, undefined, false, { ok: false, error: "idempotencyKey is too long" });
    }
    if (write && key) {
      const flight = `${req.runId}\0${key}`;
      const existing = this.inflight.get(flight);
      if (existing) return existing;
      const p = this.run(req.runId, op, argsOf(req.args), key, true);
      this.inflight.set(flight, p);
      return p.finally(() => {
        if (this.inflight.get(flight) === p) this.inflight.delete(flight);
      });
    }
    return this.run(req.runId, op, argsOf(req.args), undefined, false);
  }

  private async run(
    runId: string,
    op: string,
    args: Record<string, unknown>,
    key: string | undefined,
    write: boolean,
  ): Promise<GithubOpResult> {
    let resume: GithubWriteProgress | undefined;
    if (write && key) {
      const prior = await this.recall(runId, key);
      if (prior && !isPending(prior)) {
        if (!prior.ok && prior.progress) resume = prior.progress;
        else return this.settle(runId, op, key, true, prior, true);
      }
      if (!resume && (!prior || isPending(prior))) {
        const claim = prior
          ? { status: "existing" as const, record: prior }
          : await this.store.runs.claimGithubIdempotency(runId, key, { ok: false, error: PENDING_MARK });
        if (claim.status === "missing") return this.settle(runId, op, key, write, { ok: false, error: "not found" });
        if (claim.status === "existing" && !isPending(claim.record)) {
          if (!claim.record.ok && claim.record.progress) resume = claim.record.progress;
          else return this.settle(runId, op, key, true, claim.record, true);
        } else if (claim.status === "existing") {
          const waited = await this.waitForKey(runId, key);
          if (!waited) return this.settle(runId, op, key, write, { ok: false, error: "this write is still in progress" });
          if (!waited.ok && waited.progress) resume = waited.progress;
          else return this.settle(runId, op, key, true, waited, true);
        }
      }
    }
    const run = await this.store.runs.findById(runId);
    const session = run ? await this.store.sessions.findById(run.sessionId) : null;
    const guru = session ? await this.store.gurus.findById(session.guruId) : null;
    if (!run || !session || !guru) return this.settle(runId, op, key, write, { ok: false, error: "not found" });
    const opened = await this.openSession(session, guru, { runId, op, key, write, resume });
    if (!opened.ok) return this.settle(runId, op, key, write, { ok: false, error: opened.error });
    const result = await this.execute(opened.ctx, args);
    return this.settle(runId, op, key, write, result);
  }

  /**
   * The policy and the credential every GitHub call for a session goes through: the agent's
   * github.request ops (run()) and the web UI's session routes (#500) alike. Refuses before any
   * token is minted; otherwise returns a Ctx on the broker's own installation token (or the
   * session's PAT). `footerEmail` names who the writes are on behalf of (default: the owner).
   */
  private async openSession(
    session: Session,
    guru: Guru | null,
    opts: { runId: string; op: string; key?: string; write: boolean; resume?: GithubWriteProgress; footerEmail?: string },
  ): Promise<{ ok: true; ctx: Ctx } | { ok: false; status: number; error: string }> {
    const { op } = opts;
    if (!session.repo) return { ok: false, status: 400, error: "this session has no repository" };
    const parsed = parseSessionRepo(session.repo);
    if (!parsed) return { ok: false, status: 400, error: "this session's repository is not a github.com repository" };
    // E9 §8: an A2A task's session never merges, whatever its tape says now (the tape may have
    // been edited after the task started; the task start already refuses mergeFromCloud tapes).
    if (op === "github_pr.merge" && !mergeAllowedFor(session, guru)) {
      return { ok: false, status: 403, error: "not permitted" };
    }
    // E9 §8: a remote caller acts only on its own branch. Reads, and opening this branch's pull
    // request, are all an A2A session's agent may do; edits, reviews and comments on other pull
    // requests, and issue writes, go out as the App on the owner's behalf, so they are refused.
    // And only when that branch is an `outfitter/a2a-*` one: fail closed on a session whose branch
    // was moved (agentlink.ts refuses such a session's run as well).
    if (isA2ASession(session) && (!A2A_GITHUB_OPS.has(op) || !isA2ABranch(session.branch))) {
      return { ok: false, status: 403, error: "not permitted" };
    }
    // The broker mints its own installation token (issues, PRs, checks, actions). A stub that
    // only implements secretsForRun still works; that path is the drive token.
    const brokerCred = this.secrets.brokerGithubToken
      ? await this.secrets.brokerGithubToken(session)
      : undefined;
    if (!brokerCred && !guru) return { ok: false, status: 404, error: "not found" };
    const runSecrets = brokerCred ? undefined : await this.secrets.secretsForRun(session, guru!);
    const token = (brokerCred ? brokerCred.token : runSecrets!.githubToken).trim();
    const appFailure = brokerCred ? brokerCred.appFailure : runSecrets!.githubAppFailure;
    if (!token) {
      // #158: with the App configured, neither mint falls back to the shared PAT, so this
      // one request fails instead of being written as the PAT's user.
      return { ok: false, status: appFailure === "unavailable" ? 503 : 403, error: tokenFailureMessage(appFailure) };
    }
    const ctx: Ctx = {
      runId: opts.runId,
      op,
      key: opts.key,
      write: opts.write,
      session,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: session.branch?.trim() || `outfitter/${session.id}`,
      token,
      transport: this.transportFor(token),
      footer: opts.footerEmail !== undefined ? await this.footerForEmail(opts.footerEmail) : await this.footerFor(session),
      paced: false,
      resume: opts.resume,
    };
    return { ok: true, ctx };
  }

  /**
   * E9 §5.3: the html_url of the open pull request whose head is `branch` in the session's
   * repository, for an A2A task's result. Undefined when there is none, or when GitHub can't be
   * asked (no token, an error, a rate limit); never throws. Read-only, with the broker's own
   * credential, so it works after the task's Drive has stopped.
   */
  async openPullUrl(session: Session, branch: string): Promise<string | undefined> {
    try {
      const parsed = session.repo ? parseSessionRepo(session.repo) : undefined;
      if (!parsed || !branch) return undefined;
      // Same fail-closed rule as the broker's A2A gate: only the session's own outfitter/a2a-* branch.
      if (isA2ASession(session) && (!isA2ABranch(session.branch) || branch !== session.branch)) return undefined;
      let token = "";
      if (this.secrets.brokerGithubToken) {
        token = (await this.secrets.brokerGithubToken(session)).token;
      } else {
        const guru = await this.store.gurus.findById(session.guruId);
        if (!guru) return undefined;
        token = (await this.secrets.secretsForRun(session, guru)).githubToken;
      }
      token = token.trim();
      if (!token) return undefined;
      const res = await this.transportFor(token).request("GET /repos/{owner}/{repo}/pulls", {
        owner: parsed.owner,
        repo: parsed.repo,
        head: `${parsed.owner}:${branch}`,
        state: "open",
        per_page: 1,
      });
      if (res.status < 200 || res.status >= 300 || !Array.isArray(res.data)) return undefined;
      const url = (res.data[0] as { html_url?: unknown } | undefined)?.html_url;
      // Only a github.com pull request URL goes back to the caller.
      return typeof url === "string" && /^https:\/\/github\.com\/[^\s?#]+\/pull\/\d+$/.test(url) ? url : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- #500: the web UI's actions on the session's own pull request ----
  //
  // Whoever may manage the session (routes check canManageSession) gets, from the browser, what the
  // agent already gets through github.request: create the branch's pull request, read its checks,
  // merge it (only as the agent could), plus sync with base and re-run failed checks. Same gates
  // (openSession), same credential, same helpers. Writes go out "on behalf of" the signed-in person.
  //
  // Idempotency: an optional key per write, remembered in this process for SESSION_WRITE_TTL_MS
  // (a session has no run to persist it on). Each write is also safe to repeat on GitHub's side: a
  // second create finds the open pull request (409), a merge is pinned to a sha, a second sync
  // finds nothing behind, a second re-run re-runs what is still failed.

  private readonly sessionWrites = new Map<string, { at: number; result: SessionGithubResult<any> }>();
  private readonly sessionInflight = new Map<string, Promise<SessionGithubResult<any>>>();
  private readonly prStates = new Map<string, { at: number; ttl: number; value: SessionPrStatus }>();

  /** Forget the cached pull request state of a session, so the next status read asks GitHub. */
  forgetSessionPr(sessionId: string): void {
    this.prStates.delete(sessionId);
  }

  /** The session branch's open pull request with its checks, review and mergeability, plus whether
   * Merge may be offered. Cached per session (shorter while checks run). Never throws. */
  async sessionPrStatus(session: Session, opts: { fresh?: boolean } = {}): Promise<SessionPrStatus> {
    const guru = await this.guruOf(session);
    const mergeAllowed = mergeAllowedFor(session, guru);
    if (!session.repo) return { mergeAllowed, pr: null };
    const hit = this.prStates.get(session.id);
    // mergeAllowed is the tape's live setting, never the cached one.
    if (!opts.fresh && hit && Date.now() - hit.at < hit.ttl) return { ...hit.value, mergeAllowed };
    let value: SessionPrStatus;
    let ttl = PR_STATE_TTL_MS;
    try {
      const opened = await this.openSession(session, guru, { runId: `session:${session.id}`, op: "github_pr.checks", write: false });
      if (!opened.ok) {
        value = { mergeAllowed, pr: null, prError: opened.error };
        ttl = PR_STATE_BUSY_TTL_MS;
      } else {
        const read = await this.readSessionPull(opened.ctx);
        if ("error" in read) {
          value = { mergeAllowed, pr: null, prError: read.error };
          ttl = PR_STATE_BUSY_TTL_MS;
        } else {
          value = { mergeAllowed, pr: read.pr };
          if (read.pr && (read.pr.checkSummary.state === "pending" || read.pr.mergeable === null)) ttl = PR_STATE_BUSY_TTL_MS;
        }
      }
    } catch {
      value = { mergeAllowed, pr: null, prError: "github request failed" };
      ttl = PR_STATE_BUSY_TTL_MS;
    }
    if (this.prStates.size >= SESSION_WRITE_MAX) this.prStates.delete(this.prStates.keys().next().value!);
    this.prStates.set(session.id, { at: Date.now(), ttl, value });
    return value;
  }

  /** POST /api/sessions/:id/pr: open the session branch's pull request against its base. The body
   * defaults to the repository's pull request template (the first, if it has several). */
  async createSessionPr(
    session: Session,
    actor: SessionActor,
    input: { title?: unknown; body?: unknown; draft?: unknown },
    idempotencyKey?: unknown,
  ): Promise<SessionGithubResult<{ number: number | null; url: string; draft: boolean; base: string; template: string | null }>> {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) return sessionFail(400, "A title is required.");
    if (title.length > 256) return sessionFail(400, "A title can be at most 256 characters.");
    if (input.body !== undefined && input.body !== null && typeof input.body !== "string") return sessionFail(400, "body must be a string.");
    if (input.draft !== undefined && typeof input.draft !== "boolean") return sessionFail(400, "draft must be true or false.");
    const body = typeof input.body === "string" && input.body.trim() ? input.body : undefined;
    const draft = input.draft === true;
    return this.sessionWrite(session, actor, "github_pr.create", idempotencyKey, async (ctx) => {
      const existing = await this.openPull(ctx);
      if (!existing.ok) return sessionFail(routeStatus(existing.status), existing.error);
      if (existing.pr) {
        const url = String(existing.pr.html_url ?? "");
        return sessionFail(409, "This branch already has an open pull request.", "pr-exists", { number: existing.pr.number, url });
      }
      const base = baseBranch(undefined, ctx.session.baseBranch);
      if (typeof base !== "string") return sessionFail(400, base.error);
      const compared = await this.compareBranch(ctx, base);
      if (!compared.ok) return compared;
      if (compared.aheadBy === 0) {
        return sessionFail(409, `The branch has no commits ahead of ${base}, so there is nothing to open a pull request for.`, "no-commits");
      }
      const created = await this.createPr(ctx, { title, ...(body ? { body } : {}), ...(draft ? { draft: true } : {}) }, { firstTemplate: true });
      if (!created.ok) {
        if (created.status === 422 && /already exists/i.test(created.error)) {
          return sessionFail(409, "This branch already has an open pull request.", "pr-exists");
        }
        return sessionFail(routeStatus(created.status), created.error);
      }
      const url = String(created.data.url ?? "");
      const number = /\/pull\/(\d+)$/.exec(url)?.[1];
      const template = typeof created.data.template === "string" ? created.data.template : null;
      return { ok: true, data: { number: number ? Number(number) : null, url, draft, base, template } };
    });
  }

  /** POST /api/sessions/:id/pr/merge: the broker's merge, pinned to the head the person saw. Only
   * when the tape has mergeFromCloud, and never for an A2A task's session. */
  async mergeSessionPr(
    session: Session,
    actor: SessionActor,
    input: { sha?: unknown; method?: unknown },
    idempotencyKey?: unknown,
  ): Promise<SessionGithubResult<{ number: number; method: string; sha: string; merged: true; detail: string }>> {
    const sha = typeof input.sha === "string" ? input.sha.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{40}$/.test(sha)) return sessionFail(400, "sha must be the full 40-character head commit you saw.");
    const method = input.method === undefined || input.method === null ? "squash" : input.method;
    if (method !== "squash" && method !== "merge" && method !== "rebase") return sessionFail(400, "method must be squash, merge or rebase.");
    const guru = await this.guruOf(session);
    if (!mergeAllowedFor(session, guru)) {
      return sessionFail(
        403,
        isA2ASession(session)
          ? "An A2A task's session is never merged from Outfitter."
          : "This floppy's tape doesn't allow merging from the cloud (mergeFromCloud is off).",
        "merge-not-allowed",
      );
    }
    return this.sessionWrite(session, actor, "github_pr.merge", idempotencyKey, async (ctx) => {
      const open = await this.openPull(ctx);
      if (!open.ok) return sessionFail(routeStatus(open.status), open.error);
      if (!open.pr) return sessionFail(409, "This branch has no open pull request to merge.", "no-pr");
      const number = Number(open.pr.number);
      const merged = await this.mergePr(ctx, { number, method, sha });
      if (!merged.ok) {
        if (merged.status === 409 && /head moved/i.test(merged.error)) return sessionFail(409, merged.error, "head-moved");
        if (merged.status === 405) return sessionFail(409, merged.error, "not-mergeable");
        return sessionFail(routeStatus(merged.status), merged.error);
      }
      return { ok: true, data: { number, method, sha, merged: true, detail: String(merged.data.detail ?? "merged") } };
    });
  }

  /** POST /api/sessions/:id/sync: bring the base branch into the session branch on GitHub. With an
   * open pull request, GitHub's update-branch (a merge commit, pinned to the head it saw);
   * without one, the merges API. A conflict is a result, not an error. */
  async syncSession(session: Session, actor: SessionActor, idempotencyKey?: unknown): Promise<SessionGithubResult<SessionSyncResult>> {
    return this.sessionWrite(session, actor, "github_pr.sync", idempotencyKey, async (ctx) => {
      const base = baseBranch(undefined, ctx.session.baseBranch);
      if (typeof base !== "string") return sessionFail(400, base.error);
      const compared = await this.compareBranch(ctx, base);
      if (!compared.ok) return compared;
      const upToDate: SessionSyncResult = { status: "up-to-date", via: null, base, branchMoved: false };
      const conflict = (via: SessionSyncResult["via"]): SessionGithubResult<SessionSyncResult> => ({
        ok: true,
        data: { status: "conflict", via, base, branchMoved: false },
      });
      if (compared.behindBy === 0) return { ok: true, data: upToDate };
      const open = await this.openPull(ctx);
      if (!open.ok) return sessionFail(routeStatus(open.status), open.error);
      if (open.pr) {
        const head = typeof open.pr.head?.sha === "string" && /^[0-9a-f]{40}$/i.test(open.pr.head.sha) ? open.pr.head.sha.toLowerCase() : undefined;
        if (open.pr.mergeable_state === "dirty") return conflict("update-branch");
        const res = await this.call(ctx, "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch", {
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number: Number(open.pr.number),
          ...(head ? { expected_head_sha: head } : {}),
        });
        if (res.ok) {
          return { ok: true, data: { status: "updated", via: "update-branch", base, branchMoved: true, agentNote: SYNC_AGENT_NOTE } };
        }
        const said = `${res.message ?? ""} ${res.error}`;
        if (res.status === 422 && /conflict/i.test(said)) return conflict("update-branch");
        if (res.status === 422 && /no new commits/i.test(said)) return { ok: true, data: upToDate };
        if (res.status === 422 && /expected head sha|head sha/i.test(said)) {
          return sessionFail(409, "The branch moved while syncing. Look again and retry.", "head-moved");
        }
        return sessionFail(routeStatus(res.status), res.error);
      }
      const footer = ctx.footer.trim();
      const res = await this.call(ctx, "POST /repos/{owner}/{repo}/merges", {
        owner: ctx.owner,
        repo: ctx.repo,
        base: ctx.branch,
        head: base,
        commit_message: `Merge ${base} into ${ctx.branch}${footer ? `\n\n${footer}` : ""}`,
      });
      if (res.ok) {
        // 201 with the merge commit; 204 (no body) when there was nothing to merge.
        const sha = typeof res.data?.sha === "string" ? res.data.sha.toLowerCase() : undefined;
        if (!sha) return { ok: true, data: upToDate };
        return { ok: true, data: { status: "updated", via: "merge", base, sha, branchMoved: true, agentNote: SYNC_AGENT_NOTE } };
      }
      if (res.status === 409) return conflict("merge");
      if (res.status === 404) return sessionFail(409, `The branch or ${base} isn't on GitHub.`, "no-branch");
      return sessionFail(routeStatus(res.status), res.error);
    });
  }

  /** POST /api/sessions/:id/checks/rerun: re-run the failed jobs of every failed workflow run on the
   * branch head. The write needs `actions: write`, minted on its own (RERUN_PERMISSIONS) so the
   * broker's token is unchanged; until the App has it, this answers 403 with RERUN_PERMISSION_ERROR. */
  async rerunSessionChecks(
    session: Session,
    actor: SessionActor,
    idempotencyKey?: unknown,
  ): Promise<SessionGithubResult<SessionRerunResult>> {
    return this.sessionWrite<SessionRerunResult>(session, actor, "github_pr.rerun", idempotencyKey, async (ctx) => {
      const open = await this.openPull(ctx);
      if (!open.ok) return sessionFail(routeStatus(open.status), open.error);
      let sha = typeof open.pr?.head?.sha === "string" ? open.pr.head.sha : "";
      if (!sha) {
        const branch = await this.call(ctx, "GET /repos/{owner}/{repo}/branches/{branch}", { owner: ctx.owner, repo: ctx.repo, branch: ctx.branch });
        if (!branch.ok) {
          return branch.status === 404
            ? sessionFail(409, "The branch isn't on GitHub yet.", "no-branch")
            : sessionFail(routeStatus(branch.status), branch.error);
        }
        sha = typeof branch.data?.commit?.sha === "string" ? branch.data.commit.sha : "";
      }
      sha = sha.toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(sha)) return sessionFail(502, "Could not read the branch head.");
      const runs = await this.call(ctx, "GET /repos/{owner}/{repo}/actions/runs", { owner: ctx.owner, repo: ctx.repo, head_sha: sha, per_page: 50 });
      if (!runs.ok) {
        return sessionFail(
          routeStatus(runs.status),
          runs.status === 403 ? "Outfitter's GitHub App can't read this repository's Actions runs." : runs.error,
        );
      }
      const listed: any[] = Array.isArray(runs.data?.workflow_runs) ? runs.data.workflow_runs : [];
      const failed = listed.filter(
        (run) => run?.status === "completed" && FAILED_RUN.has(String(run?.conclusion ?? "").toLowerCase()) && Number.isSafeInteger(run?.id),
      );
      if (!failed.length) return { ok: true, data: { status: "nothing-to-rerun" as const, sha, rerun: [] } };
      const cred = this.secrets.rerunGithubToken ? await this.secrets.rerunGithubToken(ctx.session) : { token: ctx.token };
      const token = cred.token.trim();
      if (!token) {
        const reason = "appFailure" in cred ? cred.appFailure : undefined;
        if (reason === "permissions-missing") return sessionFail(403, RERUN_PERMISSION_ERROR, "actions-permission");
        return sessionFail(reason === "unavailable" ? 503 : 403, tokenFailureMessage(reason));
      }
      const actx: Ctx = { ...ctx, token, transport: token === ctx.token ? ctx.transport : this.transportFor(token), paced: false };
      const rerun: { id: number; name: string }[] = [];
      for (const run of failed) {
        const res = await this.call(actx, "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs", {
          owner: ctx.owner,
          repo: ctx.repo,
          run_id: run.id,
        });
        if (!res.ok) {
          const done = rerun.length ? { rerun } : undefined;
          if (res.status === 403) return sessionFail(403, RERUN_PERMISSION_ERROR, "actions-permission", done);
          return sessionFail(routeStatus(res.status), res.error, done ? "partial" : undefined, done);
        }
        rerun.push({ id: Number(run.id), name: String(run.name ?? "workflow") });
      }
      return { ok: true, data: { status: "rerun" as const, sha, rerun } };
    });
  }

  /** GET /api/sessions/:id/checks/:checkId/log: the tail of one GitHub Actions job's log, for Fix CI. */
  async sessionCheckLog(
    session: Session,
    checkId: string,
  ): Promise<SessionGithubResult<{ id: string; name: string; conclusion: string | null; detailsUrl: string | null; log: string; truncated: boolean }>> {
    if (!/^\d{1,19}$/.test(checkId)) return sessionFail(400, "checkId must be a check run id.");
    try {
      const guru = await this.guruOf(session);
      const opened = await this.openSession(session, guru, { runId: `session:${session.id}`, op: "github_pr.checks", write: false });
      if (!opened.ok) return sessionFail(opened.status, opened.error);
      const ctx = opened.ctx;
      const run = await this.call(ctx, "GET /repos/{owner}/{repo}/check-runs/{check_run_id}", { owner: ctx.owner, repo: ctx.repo, check_run_id: Number(checkId) });
      if (!run.ok) return sessionFail(routeStatus(run.status), run.error);
      const detailsUrl = webUrlOrNull(run.data?.html_url ?? run.data?.details_url);
      if (run.data?.app?.slug !== "github-actions") {
        return sessionFail(404, "This check isn't a GitHub Actions job, so its log can't be read here. Open it on GitHub.", "no-log", { detailsUrl });
      }
      const log = await this.call(ctx, "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", { owner: ctx.owner, repo: ctx.repo, job_id: Number(checkId) });
      if (!log.ok) {
        return log.status === 404 || log.status === 410
          ? sessionFail(404, "This job's log isn't available (it hasn't started, or it has expired).", "no-log", { detailsUrl })
          : sessionFail(routeStatus(log.status), log.error);
      }
      const text = textOf(log.data);
      if (text === undefined) return sessionFail(502, "GitHub returned a log Outfitter couldn't read.");
      const tail = logTail(text);
      return {
        ok: true,
        data: {
          id: checkId,
          name: String(run.data?.name ?? "check"),
          conclusion: typeof run.data?.conclusion === "string" ? run.data.conclusion.toLowerCase() : null,
          detailsUrl,
          ...tail,
        },
      };
    } catch {
      return sessionFail(502, "github request failed");
    }
  }

  private async guruOf(session: Session): Promise<Guru | null> {
    try {
      return await this.store.gurus.findById(session.guruId);
    } catch {
      return null;
    }
  }

  /** The open pull request whose head is the session branch, or null. */
  private async openPull(ctx: Ctx): Promise<{ ok: true; pr: any | null } | { ok: false; error: string; status?: number }> {
    const res = await this.call(ctx, "GET /repos/{owner}/{repo}/pulls", {
      owner: ctx.owner, repo: ctx.repo, head: `${ctx.owner}:${ctx.branch}`, state: "open", per_page: 1,
    });
    if (!res.ok) return res;
    const first = Array.isArray(res.data) ? res.data[0] : undefined;
    return { ok: true, pr: first && typeof first.number === "number" ? first : null };
  }

  /** How far the session branch is ahead of and behind `base`. A missing branch is a 409. */
  private async compareBranch(
    ctx: Ctx,
    base: string,
  ): Promise<{ ok: true; aheadBy: number; behindBy: number } | { ok: false; status: number; error: string; code?: string }> {
    const res = await this.call(ctx, "GET /repos/{owner}/{repo}/compare/{basehead}", {
      owner: ctx.owner, repo: ctx.repo, basehead: `${base}...${ctx.branch}`, per_page: 1,
    });
    if (!res.ok) {
      if (res.status === 404) {
        return sessionFail(409, `The branch ${ctx.branch} (or ${base}) isn't on GitHub yet; the agent has to push it first.`, "no-branch");
      }
      return sessionFail(routeStatus(res.status), res.error);
    }
    const aheadBy = Number(res.data?.ahead_by);
    const behindBy = Number(res.data?.behind_by);
    if (!Number.isFinite(aheadBy) || !Number.isFinite(behindBy)) return sessionFail(502, "GitHub's comparison had no counts.");
    return { ok: true, aheadBy, behindBy };
  }

  private async readSessionPull(ctx: Ctx): Promise<{ pr: SessionPullState | null } | { error: string }> {
    const listed = await this.openPull(ctx);
    if (!listed.ok) return { error: listed.error };
    if (!listed.pr) return { pr: null };
    const number = Number(listed.pr.number);
    // The list leaves out mergeable / mergeable_state; one pull request read has them.
    const full = await this.call(ctx, "GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner: ctx.owner, repo: ctx.repo, pull_number: number });
    const pr = full.ok && full.data && typeof full.data === "object" ? full.data : listed.pr;
    const sha = typeof pr?.head?.sha === "string" && /^[0-9a-f]{40}$/i.test(pr.head.sha) ? pr.head.sha.toLowerCase() : null;
    let checks: SessionCheck[] = [];
    let counts: { passed: number; failed: number; pending: number; total: number } | undefined;
    let checksError: string | undefined;
    if (sha) {
      this.rememberHead(ctx, number, sha);
      const roll = await this.loadChecks(ctx, sha);
      if ("error" in roll) checksError = roll.error;
      else {
        checks = roll.details;
        counts = roll.checks;
      }
    }
    const reviews = await this.call(ctx, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: ctx.owner, repo: ctx.repo, pull_number: number, per_page: 100,
    });
    return {
      pr: {
        number,
        url: String(pr?.html_url ?? ""),
        title: String(pr?.title ?? ""),
        draft: pr?.draft === true,
        base: pr?.base?.ref ? String(pr.base.ref) : null,
        headSha: sha,
        checks,
        checkSummary: summaryOf(counts),
        ...(checksError ? { checksError } : {}),
        review: reviewOf(pr, reviews.ok && Array.isArray(reviews.data) ? reviews.data : undefined),
        mergeable: typeof pr?.mergeable === "boolean" ? pr.mergeable : null,
        mergeableState: typeof pr?.mergeable_state === "string" ? pr.mergeable_state : null,
      },
    };
  }

  private async sessionWrite<T>(
    session: Session,
    actor: SessionActor,
    op: string,
    rawKey: unknown,
    work: (ctx: Ctx) => Promise<SessionGithubResult<T>>,
  ): Promise<SessionGithubResult<T>> {
    let key: string | undefined;
    if (rawKey !== undefined && rawKey !== null && rawKey !== "") {
      key = idempotencyKey(rawKey);
      if (!key) return sessionFail(400, "The idempotency key must be a string without \".\" or \"$\".");
      if (key.length > MAX_KEY_LEN) return sessionFail(400, "The idempotency key is too long.");
    }
    const memo = key ? `${session.id}\0${actor.email.toLowerCase()}\0${op}\0${key}` : undefined;
    if (memo) {
      const prior = this.sessionWrites.get(memo);
      if (prior && Date.now() - prior.at < SESSION_WRITE_TTL_MS) {
        this.logSessionWrite(session, actor, op, prior.result, true);
        return structuredClone(prior.result);
      }
      const flight = this.sessionInflight.get(memo);
      if (flight) return flight as Promise<SessionGithubResult<T>>;
    }
    const p = this.runSessionWrite(session, actor, op, work);
    if (!memo) return p;
    this.sessionInflight.set(memo, p);
    try {
      const result = await p;
      // A transient failure may be retried with the same key; anything else is the answer.
      if (result.ok || (result.status < 500 && result.status !== 429)) {
        if (this.sessionWrites.size >= SESSION_WRITE_MAX) this.pruneSessionWrites();
        this.sessionWrites.set(memo, { at: Date.now(), result: structuredClone(result) });
      }
      return result;
    } finally {
      if (this.sessionInflight.get(memo) === p) this.sessionInflight.delete(memo);
    }
  }

  private async runSessionWrite<T>(
    session: Session,
    actor: SessionActor,
    op: string,
    work: (ctx: Ctx) => Promise<SessionGithubResult<T>>,
  ): Promise<SessionGithubResult<T>> {
    let result: SessionGithubResult<T>;
    try {
      const guru = await this.guruOf(session);
      // write: false: these writes keep no run checkpoint (there is no run); see sessionWrite.
      const opened = await this.openSession(session, guru, { runId: `session:${session.id}`, op, write: false, footerEmail: actor.email });
      result = opened.ok ? await work(opened.ctx) : sessionFail(opened.status, opened.error);
    } catch {
      result = sessionFail(502, "github request failed");
    }
    this.prStates.delete(session.id);
    this.logSessionWrite(session, actor, op, result, false);
    return result;
  }

  private logSessionWrite(session: Session, actor: SessionActor, op: string, result: SessionGithubResult<unknown>, replay: boolean): void {
    const who = actor.email.replace(/[\r\n\s]/g, "").slice(0, 200);
    const outcome = result.ok ? "ok" : `err ${result.status}${result.code ? ` ${result.code}` : ""}`;
    console.log(`[github] session ${session.id} ${op} by ${who} ${outcome}${replay ? " replay" : ""}`);
  }

  private pruneSessionWrites(): void {
    const cutoff = Date.now() - SESSION_WRITE_TTL_MS;
    for (const [memo, entry] of this.sessionWrites) if (entry.at < cutoff) this.sessionWrites.delete(memo);
    while (this.sessionWrites.size >= SESSION_WRITE_MAX) this.sessionWrites.delete(this.sessionWrites.keys().next().value!);
  }

  private async ownerLogin(session: Session): Promise<string> {
    return this.loginFor(session.ownerEmail);
  }

  private async loginFor(email: string | undefined): Promise<string> {
    if (!email) return "";
    try {
      const user = await this.store.users.findByEmail(email);
      const login = user?.githubLogin?.replace(/^@/, "").trim() ?? "";
      return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login) ? login : "";
    } catch {
      return "";
    }
  }

  private async footerFor(session: Session): Promise<string> {
    return this.footerForEmail(session.ownerEmail);
  }

  private async footerForEmail(email: string | undefined): Promise<string> {
    const login = await this.loginFor(email);
    return login ? `Outfitter, on behalf of @${login}` : "";
  }

  private async settle(
    runId: string,
    op: string,
    key: string | undefined,
    write: boolean,
    result: GithubOpResult,
    replay = false,
  ): Promise<GithubOpResult> {
    if (write && key && !replay) await this.remember(runId, key, result);
    const shown = op.replace(/[\r\n]/g, " ").slice(0, 80);
    console.log(`[github] run ${runId} ${shown} ${result.ok ? "ok" : "err"}${replay ? " replay" : ""}`);
    if (!result.ok) return { ok: false, error: result.error };
    return result;
  }

  private async recall(runId: string, key: string): Promise<GithubOpResult | undefined> {
    const mem = this.memory.get(runId)?.get(key);
    if (mem) return structuredClone(mem);
    const run = await this.store.runs.findById(runId);
    const hit = run?.githubIdempotency?.[key];
    if (!hit) return undefined;
    this.noteMemory(runId, key, hit);
    return structuredClone(hit);
  }

  private noteMemory(runId: string, key: string, result: GithubIdempotencyRecord): void {
    let bucket = this.memory.get(runId);
    if (!bucket) {
      bucket = new Map();
      this.memory.set(runId, bucket);
    }
    bucket.set(key, result);
  }

  private async remember(runId: string, key: string, result: GithubOpResult): Promise<void> {
    const stored: GithubOpResult = structuredClone(result.ok ? result : { ok: false, error: result.error, ...(result.progress ? { progress: result.progress } : {}) });
    this.noteMemory(runId, key, stored);
    try {
      await this.store.runs.finishGithubIdempotency(runId, key, stored);
    } catch {
      console.warn(`[github] run ${runId} idempotency persist failed`);
    }
  }

  /** Another instance claimed this key and is still calling GitHub. */
  private async waitForKey(runId: string, key: string): Promise<GithubIdempotencyRecord | undefined> {
    for (let i = 0; i < 60; i++) {
      await this.sleep(500);
      const hit = await this.recall(runId, key);
      if (hit && !isPending(hit)) return hit;
    }
    return undefined;
  }

  private tokenKey(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private async pace(token: string): Promise<void> {
    const rl = this.budgets.get(this.tokenKey(token));
    if (!rl || rl.remaining > LOW_REMAINING) return;
    let ms = 0;
    if (rl.remaining <= 0) {
      const until = rl.reset * 1000 - Date.now();
      if (until > 0) ms = Math.min(until, MAX_BACKOFF_MS);
    } else {
      ms = Math.min(MAX_BACKOFF_MS, (LOW_REMAINING - rl.remaining + 1) * 200);
    }
    if (ms > 0) await this.sleep(ms);
  }

  private async call(ctx: Ctx, route: string, params: Record<string, unknown>): Promise<CallResult> {
    if (!ctx.paced) {
      ctx.paced = true;
      await this.pace(ctx.token);
    }
    let res: GithubResponse;
    try {
      res = await ctx.transport.request(route, params);
    } catch (err) {
      return { ok: false, error: safeClientError(err, ctx.token) };
    }
    const rl = rateLimitFromHeaders(res.headers);
    if (rl) {
      this.budgets.set(this.tokenKey(ctx.token), rl);
      ctx.rateLimit = rl;
    }
    if (isRateLimit(res)) return { ok: false, error: "rate limit exceeded", status: 429 };
    if (res.status === 401 || res.status === 403) return { ok: false, error: "not permitted", status: 403, message: messageOf(res.data) };
    if (res.status === 404) return { ok: false, error: "not found", status: 404 };
    if (res.status < 200 || res.status >= 300) return { ok: false, error: publicHttpError(res), status: res.status, message: messageOf(res.data) };
    return { ok: true, data: res.data };
  }

  private async graphql(ctx: Ctx, query: string, variables: Record<string, unknown>): Promise<CallResult> {
    const res = await this.call(ctx, "POST /graphql", { query, variables });
    if (!res.ok) return res;
    const errors = (res.data as { errors?: { type?: string; message?: string }[] } | undefined)?.errors;
    if (Array.isArray(errors) && errors.length) {
      const forbidden = errors.some(
        (e) => e?.type === "FORBIDDEN" || /resource not accessible|requires authentication|not permitted/i.test(String(e?.message ?? "")),
      );
      if (forbidden) return { ok: false, error: "not permitted" };
      const msg = errors.map((e) => String(e?.message ?? "")).filter(Boolean).join("; ");
      return { ok: false, error: clip(msg || "github request failed", 500) };
    }
    return { ok: true, data: (res.data as { data?: unknown } | undefined)?.data };
  }

  private data(ctx: Ctx, fields: Record<string, unknown>): GithubOpResult {
    return { ok: true, data: withRateLimit(obj(fields), ctx.rateLimit) };
  }

  private async execute(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    switch (ctx.op) {
      case "github_pr.view":
        return this.viewPr(ctx, args, false);
      case "github_pr.checks":
        return this.viewPr(ctx, args, true);
      case "github_pr.list":
        return this.listPrs(ctx, args);
      case "github_pr.create":
        return this.createPr(ctx, args);
      case "github_pr.edit":
        return this.editPr(ctx, args);
      case "github_pr.comment":
        return this.commentOn(ctx, args, "pull request");
      case "github_pr.reply":
        return this.replyThread(ctx, args);
      case "github_pr.review":
        return this.reviewPr(ctx, args);
      case "github_pr.resolve":
        return this.resolveThread(ctx, args);
      case "github_pr.merge":
        return this.mergePr(ctx, args);
      case "github_issue.list":
        return this.listIssues(ctx, args);
      case "github_issue.view":
        return this.viewIssue(ctx, args);
      case "github_issue.create":
        return this.createIssue(ctx, args);
      case "github_issue.comment":
        return this.commentOn(ctx, args, "issue");
      case "github_issue.edit":
        return this.editIssue(ctx, args);
      case "github_issue.close":
        return this.closeIssue(ctx, args);
      case "github_issue.reopen":
        return this.reopenIssue(ctx, args);
      case "github_repo.view":
        return this.viewRepo(ctx);
      case "github_repo.search":
        return this.searchRepo(ctx, args);
      case "github_repo.releases":
        return this.releases(ctx, args);
      default:
        return { ok: false, error: "unknown op" };
    }
  }

  private headKey(ctx: Ctx, number: number): string {
    return `${ctx.runId}\0${ctx.owner}/${ctx.repo}#${number}`;
  }

  private rememberHead(ctx: Ctx, number: number, sha: unknown): void {
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) return;
    this.heads.set(this.headKey(ctx, number), sha.toLowerCase());
  }

  private async viewPr(ctx: Ctx, args: Record<string, unknown>, checksOnly: boolean): Promise<GithubOpResult> {
    const number = positiveInt(args.number);
    const loaded = await this.findPull(ctx, number);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const pr = loaded.pr;
    const sha = typeof pr?.head?.sha === "string" ? pr.head.sha.toLowerCase() : undefined;
    this.rememberHead(ctx, loaded.number, sha);
    let checks: ReturnType<typeof collectChecks>["checks"];
    let jobs: { name: string; state: string; url: string }[] = [];
    if (sha) {
      const roll = await this.loadChecks(ctx, sha);
      if ("error" in roll) {
        if (checksOnly || roll.error !== "not permitted") return { ok: false, error: roll.error };
      } else {
        checks = roll.checks;
        jobs = roll.jobs;
      }
    } else if (checksOnly) {
      return { ok: false, error: "Could not read the pull request head." };
    }
    if (checksOnly) {
      return this.data(ctx, { number: loaded.number, sha, url: String(pr?.html_url ?? ""), checks: checks ?? null, jobs });
    }
    let review: string | undefined;
    const reviews = await this.call(ctx, "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: ctx.owner, repo: ctx.repo, pull_number: loaded.number, per_page: 100,
    });
    if (reviews.ok && Array.isArray(reviews.data)) review = reviewFrom(reviews.data);
    return this.data(ctx, normalizePull(pr, review, checks, jobs));
  }

  private async findPull(ctx: Ctx, number: number | undefined): Promise<{ ok: true; number: number; pr: any } | { ok: false; error: string }> {
    if (number) {
      const res = await this.call(ctx, "GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: ctx.owner, repo: ctx.repo, pull_number: number,
      });
      if (!res.ok) return res;
      return { ok: true, number, pr: res.data };
    }
    for (const state of ["open", "closed"] as const) {
      const res = await this.call(ctx, "GET /repos/{owner}/{repo}/pulls", {
        owner: ctx.owner, repo: ctx.repo, head: `${ctx.owner}:${ctx.branch}`, state, per_page: 1,
      });
      if (!res.ok) return res;
      const first = Array.isArray(res.data) ? res.data[0] : undefined;
      if (first && typeof first.number === "number") return { ok: true, number: first.number, pr: first };
    }
    return { ok: false, error: "not found" };
  }

  private async loadChecks(
    ctx: Ctx,
    sha: string,
  ): Promise<ReturnType<typeof collectChecks> | { error: string }> {
    const runs = await this.call(ctx, "GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      owner: ctx.owner, repo: ctx.repo, ref: sha, per_page: 100,
    });
    if (!runs.ok) return { error: runs.error };
    const status = await this.call(ctx, "GET /repos/{owner}/{repo}/commits/{ref}/status", {
      owner: ctx.owner, repo: ctx.repo, ref: sha,
    });
    const statuses = status.ok && Array.isArray((status.data as { statuses?: unknown }).statuses)
      ? (status.data as { statuses: any[] }).statuses
      : [];
    if (!status.ok && status.error !== "not permitted" && status.error !== "not found") return { error: status.error };
    const checkRuns = Array.isArray((runs.data as { check_runs?: unknown })?.check_runs)
      ? (runs.data as { check_runs: any[] }).check_runs
      : [];
    return collectChecks(checkRuns, statuses);
  }

  private async listPrs(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const state = args.state ?? "open";
    if (state !== "open" && state !== "closed" && state !== "merged" && state !== "all") {
      return { ok: false, error: `Unknown state "${String(state)}".` };
    }
    const limit = limitOf(args.limit);
    const apiState = state === "all" ? "all" : state === "open" ? "open" : "closed";
    const res = await this.call(ctx, "GET /repos/{owner}/{repo}/pulls", {
      owner: ctx.owner, repo: ctx.repo, state: apiState, per_page: state === "open" || state === "all" ? limit : 100,
    });
    if (!res.ok) return { ok: false, error: res.error };
    let rows = Array.isArray(res.data) ? res.data : [];
    if (state === "merged") rows = rows.filter((row) => row?.merged_at);
    if (state === "closed") rows = rows.filter((row) => !row?.merged_at);
    rows = rows.slice(0, limit);
    for (const row of rows) this.rememberHead(ctx, Number(row?.number), row?.head?.sha);
    return this.data(ctx, { pullRequests: rows.map((row) => normalizePull(row, undefined, undefined, [], false)) });
  }

  private async createPr(ctx: Ctx, args: Record<string, unknown>, opts: { firstTemplate?: boolean } = {}): Promise<GithubOpResult> {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return { ok: false, error: "A title is required." };
    const base = baseBranch(args.base, ctx.session.baseBranch);
    if (typeof base !== "string") return { ok: false, error: base.error };
    const explicit = typeof args.body === "string" && args.body.trim() ? args.body : undefined;
    let templatePath: string | null = null;
    let templateBody: string | undefined;
    if (explicit === undefined) {
      const templates = await this.loadTemplates(ctx);
      const wanted = typeof args.template === "string" ? args.template.trim() : "";
      if (templates.length > 1 && !wanted && !opts.firstTemplate) {
        return { ok: false, error: "This repository has more than one pull request template. Pass template with one of:\n" + templates.map((t) => t.path).join("\n") };
      }
      if (wanted) {
        const match = templates.find((t) => t.path === wanted || t.path.endsWith("/" + wanted));
        if (!match) {
          return { ok: false, error: `No pull request template matches "${wanted}".\n` + (templates.map((t) => t.path).join("\n") || "(none)") };
        }
        templatePath = match.path;
        templateBody = match.body;
      } else if (templates[0]) {
        templatePath = templates[0].path;
        templateBody = templates[0].body;
      }
    }
    const closes = closesFrom(args, ctx.branch);
    const body = composePrBody({
      template: templateBody,
      body: explicit,
      summary: typeof args.summary === "string" ? args.summary : undefined,
      testPlan: typeof args.testPlan === "string" ? args.testPlan : undefined,
      closes,
      footer: ctx.footer,
    });
    const res = await this.call(ctx, "POST /repos/{owner}/{repo}/pulls", {
      owner: ctx.owner,
      repo: ctx.repo,
      title,
      head: ctx.branch,
      base,
      body,
      ...(args.draft === true ? { draft: true } : {}),
    });
    if (!res.ok) return { ok: false, error: res.error, status: res.status };
    return this.data(ctx, { url: String(res.data?.html_url ?? ""), template: templatePath, closes });
  }

  private async editPr(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const number = positiveInt(args.number);
    if (!number) return { ok: false, error: "A pull request number is required." };
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const body = typeof args.body === "string" ? withFooter(args.body, ctx.footer) : undefined;
    const baseRaw = typeof args.base === "string" ? args.base.trim() : "";
    if (baseRaw.startsWith("-")) return { ok: false, error: "A base branch cannot start with \"-\"." };
    if (!title && body === undefined && !baseRaw) return { ok: false, error: "Nothing to change. Pass a title, a body or a base." };
    const res = await this.call(ctx, "PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: number,
      ...(title ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(baseRaw ? { base: baseRaw } : {}),
    });
    if (!res.ok) return { ok: false, error: res.error };
    return this.data(ctx, { number, url: res.data?.html_url ? String(res.data.html_url) : undefined });
  }

  private async commentOn(ctx: Ctx, args: Record<string, unknown>, what: string): Promise<GithubOpResult> {
    const number = positiveInt(args.number);
    if (!number) return { ok: false, error: `A ${what} number is required.` };
    if (typeof args.body !== "string" || !args.body.trim()) return { ok: false, error: "A comment body is required." };
    const res = await this.call(ctx, "POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: ctx.owner, repo: ctx.repo, issue_number: number, body: withFooter(args.body, ctx.footer),
    });
    if (!res.ok) return { ok: false, error: res.error };
    return this.data(ctx, { number, url: res.data?.html_url ? String(res.data.html_url) : undefined });
  }

  private async replyThread(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const thread = typeof args.thread === "string" ? args.thread.trim() : "";
    if (!thread || thread.startsWith("-")) return { ok: false, error: "A review thread id is required." };
    if (typeof args.body !== "string" || !args.body.trim()) return { ok: false, error: "A reply body is required." };
    const allowed = await this.threadInSession(ctx, thread);
    if (allowed) return allowed;
    const query = "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{url}}}";
    const res = await this.graphql(ctx, query, { id: thread, body: withFooter(args.body, ctx.footer) });
    if (!res.ok) return { ok: false, error: res.error };
    const url = res.data?.addPullRequestReviewThreadReply?.comment?.url;
    return this.data(ctx, { thread, url: url ? String(url) : undefined });
  }

  private async resolveThread(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const thread = typeof args.thread === "string" ? args.thread.trim() : "";
    if (!thread || thread.startsWith("-")) return { ok: false, error: "A review thread id is required." };
    const allowed = await this.threadInSession(ctx, thread);
    if (allowed) return allowed;
    const query = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}";
    const res = await this.graphql(ctx, query, { id: thread });
    if (!res.ok) return { ok: false, error: res.error };
    return this.data(ctx, { thread, resolved: res.data?.resolveReviewThread?.thread?.isResolved === true });
  }

  /** A review-thread node id is global. Refuse it unless that thread's pull request is this session's repo. */
  private async threadInSession(ctx: Ctx, thread: string): Promise<GithubOpResult | undefined> {
    const query = "query($id:ID!){node(id:$id){... on PullRequestReviewThread{pullRequest{repository{nameWithOwner}}}}}";
    const res = await this.graphql(ctx, query, { id: thread });
    if (!res.ok) return { ok: false, error: res.error };
    const name = (res.data as { node?: { pullRequest?: { repository?: { nameWithOwner?: string } } } } | undefined)
      ?.node?.pullRequest?.repository?.nameWithOwner;
    const expected = `${ctx.owner}/${ctx.repo}`;
    if (typeof name !== "string" || name.toLowerCase() !== expected.toLowerCase()) {
      return { ok: false, error: "not permitted" };
    }
    return undefined;
  }

  private async reviewPr(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const number = positiveInt(args.number);
    if (!number) return { ok: false, error: "A pull request number is required." };
    const decision = reviewDecision(args.decision) ?? "comment";
    if (decision === "unknown") return { ok: false, error: `Unknown review decision "${String(args.decision)}". Use comment, approve or request-changes.` };
    const inline = Array.isArray(args.comments) ? args.comments : [];
    const bodyIn = typeof args.body === "string" ? args.body : "";
    if ((decision === "request-changes" || decision === "comment") && !bodyIn.trim() && !inline.length) {
      return { ok: false, error: "A review body is required." };
    }
    for (const c of inline) {
      if (!c || typeof c !== "object" || typeof (c as any).path !== "string" || !(c as any).path.trim() || typeof (c as any).body !== "string" || !(c as any).body.trim() || !Number.isInteger((c as any).line) || (c as any).line <= 0) {
        return { ok: false, error: "Each inline comment needs a path, a line and a body." };
      }
      if ((c as any).side !== undefined && (c as any).side !== "LEFT" && (c as any).side !== "RIGHT") {
        return { ok: false, error: "An inline comment side must be LEFT or RIGHT." };
      }
    }
    const body = withFooter(bodyIn, ctx.footer);
    let sha: string | undefined;
    if (inline.length) {
      sha = typeof args.sha === "string" ? args.sha.trim().toLowerCase() : "";
      if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
        const viewed = await this.call(ctx, "GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: ctx.owner, repo: ctx.repo, pull_number: number,
        });
        if (!viewed.ok) return { ok: false, error: viewed.error };
        sha = String(viewed.data?.head?.sha ?? "").toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, error: "Could not read the pull request head, which inline comments have to name." };
      }
      this.rememberHead(ctx, number, sha);
    }
    const res = await this.call(ctx, "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: number,
      event: reviewEvent(decision),
      ...(body.trim() ? { body: body.trim() } : {}),
      ...(sha ? {
        commit_id: sha,
        comments: inline.map((c: any) => ({ path: c.path.trim(), line: c.line, side: c.side ?? "RIGHT", body: c.body })),
      } : {}),
    });
    if (!res.ok) return { ok: false, error: res.error };
    return this.data(ctx, { number, decision, ...(sha ? { sha } : {}), url: res.data?.html_url ? String(res.data.html_url) : undefined });
  }

  private async mergePr(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const number = positiveInt(args.number);
    if (!number) return { ok: false, error: "A pull request number is required." };
    const method = args.method;
    if (method !== "merge" && method !== "squash" && method !== "rebase") {
      return { ok: false, error: "method must be merge, squash or rebase." };
    }
    const given = typeof args.sha === "string" ? args.sha.trim().toLowerCase() : "";
    if (given && !/^[0-9a-f]{40}$/.test(given)) return { ok: false, error: "sha must be the full 40-character head you saw." };
    const pin = given || this.heads.get(this.headKey(ctx, number));
    if (!pin) return { ok: false, error: "View the pull request first, or pass sha, so the merge is pinned to the commit you saw." };
    const live = await this.call(ctx, "GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: ctx.owner, repo: ctx.repo, pull_number: number,
    });
    if (!live.ok) return { ok: false, error: live.error };
    const head = String(live.data?.head?.sha ?? "").toLowerCase();
    if (!head) return { ok: false, error: "Could not read the pull request head." };
    if (head !== pin) return { ok: false, status: 409, error: `The pull request head moved from ${pin} to ${head}. Look again before merging.` };
    const res = await this.call(ctx, "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
      owner: ctx.owner, repo: ctx.repo, pull_number: number, merge_method: method, sha: pin,
    });
    if (!res.ok) return { ok: false, error: res.error, status: res.status };
    this.heads.delete(this.headKey(ctx, number));
    return this.data(ctx, { number, method, sha: pin, detail: clip(String(res.data?.message ?? "merged"), 500) });
  }

  private async listIssues(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const state = args.state ?? "open";
    if (state !== "open" && state !== "closed" && state !== "all") return { ok: false, error: `Unknown state "${String(state)}".` };
    const assigneeIn = typeof args.assignee === "string" ? args.assignee.trim() : "";
    if (assigneeIn && !loginOk(assigneeIn)) return { ok: false, error: `"${assigneeIn}" is not a login.` };
    let assignee = assigneeIn;
    if (assignee === "@me") {
      // An installation token is the App, not a user: GET /user is 403 and would fail the whole list.
      if (ctx.token.startsWith("ghs_")) {
        const login = await this.ownerLogin(ctx.session);
        if (!login) return { ok: false, error: "an installation token has no GitHub user; pass a login instead of @me" };
        assignee = login;
      } else {
        const me = await this.call(ctx, "GET /user", {});
        if (!me.ok) return { ok: false, error: me.error };
        assignee = String(me.data?.login ?? "");
        if (!assignee) return { ok: false, error: "not permitted" };
      }
    }
    const limit = limitOf(args.limit);
    const res = await this.call(ctx, "GET /repos/{owner}/{repo}/issues", {
      owner: ctx.owner,
      repo: ctx.repo,
      state,
      per_page: limit,
      ...(assignee ? { assignee } : {}),
    });
    if (!res.ok) return { ok: false, error: res.error };
    const rows = (Array.isArray(res.data) ? res.data : []).filter((row) => !row?.pull_request).slice(0, limit);
    return this.data(ctx, { issues: rows.map(normalizeIssue) });
  }

  private async viewIssue(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const number = positiveInt(args.number);
    if (!number) return { ok: false, error: "An issue number is required." };
    const res = await this.call(ctx, "GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner: ctx.owner, repo: ctx.repo, issue_number: number,
    });
    if (!res.ok) return { ok: false, error: res.error };
    if (res.data?.pull_request) return { ok: false, error: "not found" };
    return this.data(ctx, normalizeIssue(res.data));
  }

  private async createIssue(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return { ok: false, error: "A title is required." };
    const labels = stringList(args.labels, "labels");
    if ("error" in labels) return { ok: false, error: labels.error };
    const assignees = stringList(args.assignees, "assignees");
    if ("error" in assignees) return { ok: false, error: assignees.error };
    const body = typeof args.body === "string" ? withFooter(args.body, ctx.footer) : "";
    const res = await this.call(ctx, "POST /repos/{owner}/{repo}/issues", {
      owner: ctx.owner,
      repo: ctx.repo,
      title,
      ...(body ? { body } : {}),
      ...(labels.values.length ? { labels: labels.values } : {}),
      ...(assignees.values.length ? { assignees: assignees.values } : {}),
    });
    if (!res.ok) return { ok: false, error: res.error };
    return this.data(ctx, { url: String(res.data?.html_url ?? "") });
  }

  private async editIssue(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const number = positiveInt(args.number);
    if (!number) return { ok: false, error: "An issue number is required." };
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const body = typeof args.body === "string" ? withFooter(args.body, ctx.footer) : undefined;
    const labels = stringList(args.labels, "labels");
    if ("error" in labels) return { ok: false, error: labels.error };
    const removeLabels = stringList(args.removeLabels, "removeLabels");
    if ("error" in removeLabels) return { ok: false, error: removeLabels.error };
    const assignees = stringList(args.assignees, "assignees");
    if ("error" in assignees) return { ok: false, error: assignees.error };
    const removeAssignees = stringList(args.removeAssignees, "removeAssignees");
    if ("error" in removeAssignees) return { ok: false, error: removeAssignees.error };
    if (!title && body === undefined && !labels.values.length && !removeLabels.values.length && !assignees.values.length && !removeAssignees.values.length) {
      return { ok: false, error: "Nothing to change. Pass a title, a body, labels or assignees." };
    }
    const progress: GithubWriteProgress = { ...(ctx.resume ?? {}) };
    const removed = new Set(progress.labelsRemoved ?? []);
    if ((title || body !== undefined) && !progress.patched) {
      const res = await this.call(ctx, "PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: number,
        ...(title ? { title } : {}),
        ...(body !== undefined ? { body } : {}),
      });
      if (!res.ok) return { ok: false, error: res.error, progress };
      progress.patched = true;
      await this.checkpoint(ctx, progress);
    }
    if (labels.values.length && !progress.labelsAdded) {
      const res = await this.call(ctx, "POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner: ctx.owner, repo: ctx.repo, issue_number: number, labels: labels.values,
      });
      if (!res.ok) return { ok: false, error: res.error, progress };
      progress.labelsAdded = true;
      await this.checkpoint(ctx, progress);
    }
    for (const name of removeLabels.values) {
      if (removed.has(name)) continue;
      const res = await this.call(ctx, "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
        owner: ctx.owner, repo: ctx.repo, issue_number: number, name,
      });
      if (!res.ok) return { ok: false, error: res.error, progress: { ...progress, labelsRemoved: [...removed] } };
      removed.add(name);
      progress.labelsRemoved = [...removed];
      await this.checkpoint(ctx, progress);
    }
    if (assignees.values.length && !progress.assigneesAdded) {
      const res = await this.call(ctx, "POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
        owner: ctx.owner, repo: ctx.repo, issue_number: number, assignees: assignees.values,
      });
      if (!res.ok) return { ok: false, error: res.error, progress };
      progress.assigneesAdded = true;
      await this.checkpoint(ctx, progress);
    }
    if (removeAssignees.values.length && !progress.assigneesRemoved) {
      const res = await this.call(ctx, "DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
        owner: ctx.owner, repo: ctx.repo, issue_number: number, assignees: removeAssignees.values,
      });
      if (!res.ok) return { ok: false, error: res.error, progress };
    }
    return this.data(ctx, { number });
  }

  /** Remember a half-finished write so a replay does not repeat the steps that already landed. */
  private async checkpoint(ctx: Ctx, progress: GithubWriteProgress): Promise<void> {
    if (!ctx.write || !ctx.key) return;
    await this.remember(ctx.runId, ctx.key, { ok: false, error: "incomplete", progress });
  }

  private async closeIssue(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const number = positiveInt(args.number);
    if (!number) return { ok: false, error: "An issue number is required." };
    const reason = args.reason === undefined ? "completed" : args.reason === "not planned" || args.reason === "completed" ? args.reason : "";
    if (!reason) return { ok: false, error: `Unknown close reason "${String(args.reason)}". Use completed or "not planned".` };
    const progress: GithubWriteProgress = { ...(ctx.resume ?? {}) };
    if (typeof args.body === "string" && args.body.trim() && !progress.commented) {
      const commented = await this.call(ctx, "POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: ctx.owner, repo: ctx.repo, issue_number: number, body: withFooter(args.body, ctx.footer),
      });
      if (!commented.ok) return { ok: false, error: commented.error, progress };
      progress.commented = true;
      await this.checkpoint(ctx, progress);
    }
    const res = await this.call(ctx, "PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: number,
      state: "closed",
      state_reason: reason === "not planned" ? "not_planned" : "completed",
    });
    if (!res.ok) return { ok: false, error: res.error, progress };
    return this.data(ctx, { number, state: "closed", reason });
  }

  private async reopenIssue(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const number = positiveInt(args.number);
    if (!number) return { ok: false, error: "An issue number is required." };
    const res = await this.call(ctx, "PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
      owner: ctx.owner, repo: ctx.repo, issue_number: number, state: "open",
    });
    if (!res.ok) return { ok: false, error: res.error };
    return this.data(ctx, { number, state: "open" });
  }

  private async viewRepo(ctx: Ctx): Promise<GithubOpResult> {
    const res = await this.call(ctx, "GET /repos/{owner}/{repo}", { owner: ctx.owner, repo: ctx.repo });
    if (!res.ok) return { ok: false, error: res.error };
    const templates = await this.loadTemplates(ctx);
    return this.data(ctx, {
      repo: String(res.data?.full_name ?? `${ctx.owner}/${ctx.repo}`),
      url: res.data?.html_url ? String(res.data.html_url) : undefined,
      defaultBranch: res.data?.default_branch ? String(res.data.default_branch) : undefined,
      permission: permissionOf(res.data),
      templates: templates.map((t) => ({ path: t.path, body: clip(t.body, 2000) })),
    });
  }

  private async searchRepo(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { ok: false, error: "A search query is required." };
    if (query.startsWith("-")) return { ok: false, error: "A search query cannot start with \"-\"." };
    const limit = limitOf(args.limit);
    const wantIssues = !/\bis:pr\b/.test(query) || /\bis:issue\b/.test(query);
    const wantPrs = !/\bis:issue\b/.test(query) || /\bis:pr\b/.test(query);
    const base = boundQuery(query, ctx.owner, ctx.repo);
    const issues = wantIssues ? await this.searchKind(ctx, qualify(base, "is:issue"), limit) : [];
    if (!Array.isArray(issues)) return { ok: false, error: issues.error };
    const pullRequests = wantPrs ? await this.searchKind(ctx, qualify(base, "is:pr"), limit) : [];
    if (!Array.isArray(pullRequests)) return { ok: false, error: pullRequests.error };
    return this.data(ctx, { issues, pullRequests });
  }

  private async searchKind(ctx: Ctx, q: string, limit: number): Promise<{ number: number; title: string; state: string; url: string }[] | { error: string }> {
    const res = await this.call(ctx, "GET /search/issues", { q, per_page: limit });
    if (!res.ok) return { error: res.error };
    return searchRows(res.data);
  }

  private async releases(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
    const res = await this.call(ctx, "GET /repos/{owner}/{repo}/releases", {
      owner: ctx.owner, repo: ctx.repo, per_page: limitOf(args.limit),
    });
    if (!res.ok) return { ok: false, error: res.error };
    const rows = Array.isArray(res.data) ? res.data : [];
    return this.data(ctx, {
      releases: rows.map((rel) => obj({
        tagName: String(rel?.tag_name ?? ""),
        name: String(rel?.name ?? rel?.tag_name ?? ""),
        publishedAt: rel?.published_at ? String(rel.published_at) : undefined,
        isDraft: rel?.draft === true,
        isPrerelease: rel?.prerelease === true,
      })),
    });
  }

  private async loadTemplates(ctx: Ctx): Promise<{ path: string; body: string }[]> {
    const found: { path: string; body: string }[] = [];
    for (const path of TEMPLATE_FILES) {
      const text = await this.readContent(ctx, path);
      if (text !== undefined) found.push({ path, body: text });
    }
    for (const dir of TEMPLATE_DIRS) {
      const listed = await this.call(ctx, "GET /repos/{owner}/{repo}/contents/{path}", { owner: ctx.owner, repo: ctx.repo, path: dir });
      if (!listed.ok || !Array.isArray(listed.data)) continue;
      const names = listed.data
        .filter((entry: any) => entry?.type === "file" && /\.(md|txt)$/i.test(String(entry?.name ?? "")))
        .map((entry: any) => String(entry.name))
        .sort();
      for (const name of names) {
        const path = `${dir}/${name}`;
        const text = await this.readContent(ctx, path);
        if (text !== undefined) found.push({ path, body: text });
      }
    }
    return found;
  }

  private async readContent(ctx: Ctx, path: string): Promise<string | undefined> {
    const res = await this.call(ctx, "GET /repos/{owner}/{repo}/contents/{path}", { owner: ctx.owner, repo: ctx.repo, path });
    if (!res.ok || !res.data || Array.isArray(res.data)) return undefined;
    if (res.data.encoding !== "base64" || typeof res.data.content !== "string") return undefined;
    return Buffer.from(res.data.content.replace(/\n/g, ""), "base64").toString("utf8");
  }
}

/** Whether the session's pull request may be merged from Outfitter at all: the tape allows merging
 * from the cloud, and the session is not an A2A task's (E9 §8: those never merge). */
export function mergeAllowedFor(session: Session, guru: Pick<Guru, "mergeFromCloud"> | null | undefined): boolean {
  return guru?.mergeFromCloud === true && !isA2ASession(session);
}

function tokenFailureMessage(appFailure: string | undefined): string {
  return appFailure === "unavailable"
    ? "the GitHub App could not get a token just now; try again shortly"
    : appFailure === "not-installed"
      ? "the Outfitter GitHub App's installation doesn't cover this repository"
      : appFailure === "permissions-missing"
        ? "the Outfitter GitHub App is missing a permission runs need; an owner has to grant it"
        : appFailure === "rejected"
          ? "GitHub refused the Outfitter GitHub App's token request; an operator has to check the App"
          : appFailure === "misconfigured"
            ? "the Outfitter GitHub App is not set up correctly; an operator has to fix it"
            : "not permitted";
}

/** #500: what the web routes return. `status` is the HTTP status; `code` a stable reason the UI can
 * branch on (pr-exists, no-commits, merge-not-allowed, head-moved, actions-permission, ...). */
export type SessionGithubResult<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; code?: string; data?: Record<string, unknown> };

/** Who a web route acts for: the signed-in person (the session's owner or a sysop). */
export interface SessionActor {
  email: string;
}

export type SessionReview = "approved" | "changes_requested" | "review_required" | "none";

/** #500: the session branch's open pull request as the web UI shows it. */
export interface SessionPullState {
  number: number;
  url: string;
  title: string;
  draft: boolean;
  base: string | null;
  headSha: string | null;
  checks: SessionCheck[];
  checkSummary: { passed: number; failed: number; pending: number; total: number; state: "pass" | "fail" | "pending" | "none" };
  /** Why the checks couldn't be read (e.g. "not permitted" without checks:read); checks is then []. */
  checksError?: string;
  review: SessionReview;
  /** GitHub's `mergeable`: null while GitHub is still working it out. */
  mergeable: boolean | null;
  /** GitHub's `mergeable_state` (clean, dirty, blocked, behind, unstable, draft, unknown, ...). */
  mergeableState: string | null;
}

export interface SessionPrStatus {
  /** The tape has mergeFromCloud and the session isn't an A2A task's. The UI shows Merge only then. */
  mergeAllowed: boolean;
  /** The open pull request whose head is the session branch, or null when there is none. */
  pr: SessionPullState | null;
  /** Why `pr` couldn't be read (no token, a rate limit, ...), when it couldn't. */
  prError?: string;
}

/** #500: sync's result. `branchMoved`: the branch on GitHub got a new commit the Drive's checkout
 * doesn't have; the UI should tell the agent to pull (see `agentNote`) before it pushes again. */
export interface SessionSyncResult {
  status: "updated" | "up-to-date" | "conflict";
  via: "update-branch" | "merge" | null;
  base: string;
  sha?: string;
  branchMoved: boolean;
  agentNote?: string;
}

export interface SessionRerunResult {
  status: "rerun" | "nothing-to-rerun";
  sha: string;
  /** The workflow runs whose failed jobs were re-run. */
  rerun: { id: number; name: string }[];
}

export const SYNC_AGENT_NOTE =
  "The base branch was merged into this branch on GitHub. Run `git pull` on the branch before you change anything else, or your next push will be rejected.";

const SESSION_WRITE_TTL_MS = 15 * 60_000;
const SESSION_WRITE_MAX = 1_000;
const PR_STATE_TTL_MS = 30_000;
/** While checks run (or GitHub is still computing mergeable), the UI wants fresher answers. */
const PR_STATE_BUSY_TTL_MS = 10_000;
const LOG_TAIL_LINES = 80;
const LOG_TAIL_CHARS = 8_000;
const FAILED_RUN = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);
export const RERUN_PERMISSION_ERROR = "Outfitter's GitHub App needs the Actions: write permission to re-run checks.";

function sessionFail(
  status: number,
  error: string,
  code?: string,
  data?: Record<string, unknown>,
): { ok: false; status: number; error: string; code?: string; data?: Record<string, unknown> } {
  return { ok: false, status, error, ...(code ? { code } : {}), ...(data ? { data } : {}) };
}

/** A broker failure as an HTTP status for the browser. GitHub's own 5xx is a 502 here. */
function routeStatus(status: number | undefined): number {
  if (status === undefined) return 502;
  if (status === 401 || status === 403) return 403;
  if (status === 404 || status === 409 || status === 422 || status === 429 || status === 400) return status;
  if (status === 405) return 409;
  return 502;
}

function reviewOf(pr: any, reviews: any[] | undefined): SessionReview {
  const decided = reviews ? reviewFrom(reviews) : undefined;
  if (decided === "APPROVED") return "approved";
  if (decided === "CHANGES_REQUESTED") return "changes_requested";
  const users = Array.isArray(pr?.requested_reviewers) ? pr.requested_reviewers.length : 0;
  const teams = Array.isArray(pr?.requested_teams) ? pr.requested_teams.length : 0;
  return users + teams > 0 ? "review_required" : "none";
}

function summaryOf(checks: { passed: number; failed: number; pending: number; total: number } | undefined): SessionPullState["checkSummary"] {
  if (!checks || checks.total === 0) return { passed: 0, failed: 0, pending: 0, total: 0, state: "none" };
  const state = checks.failed > 0 ? "fail" : checks.pending > 0 ? "pending" : "pass";
  return { ...checks, state };
}

/** The last lines of a GitHub Actions job log, without the per-line timestamps and colour codes. */
export function logTail(raw: string): { log: string; truncated: boolean } {
  const lines = raw
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, ""));
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const kept = lines.slice(-LOG_TAIL_LINES);
  let truncated = kept.length < lines.length;
  let text = kept.join("\n");
  if (text.length > LOG_TAIL_CHARS) {
    text = text.slice(text.length - LOG_TAIL_CHARS);
    const cut = text.indexOf("\n");
    if (cut >= 0) text = text.slice(cut + 1);
    truncated = true;
  }
  return { log: text, truncated };
}

function textOf(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function idempotencyKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim();
  if (!key || key.includes(".") || key.includes("$")) return undefined;
  return key;
}

function isPending(record: GithubIdempotencyRecord): boolean {
  return record.ok === false && record.error === PENDING_MARK;
}

function argsOf(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  // The session owns the repository and the branch. A model-supplied owner, repo, or head is ignored.
  delete out.owner;
  delete out.repo;
  delete out.head;
  return out;
}

function obj(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function withRateLimit(data: Record<string, unknown>, rl: RateLimit | undefined): Record<string, unknown> {
  if (!rl) return data;
  return { ...data, rateLimit: { remaining: rl.remaining, reset: rl.reset } };
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

function positiveInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^[1-9]\d*$/.test(v)) return Number(v);
  return undefined;
}

function limitOf(v: unknown, fallback = 20): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
  return Math.min(Math.max(n, 1), 50);
}

function stringList(v: unknown, what: string): { values: string[] } | { error: string } {
  if (v === undefined || v === null) return { values: [] };
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : null;
  if (!arr) return { error: `${what} must be a list of strings.` };
  const values: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string" || !item.trim()) return { error: `${what} must be a list of strings.` };
    const s = item.trim();
    if (s.startsWith("-") || /[\n\r]/.test(s)) return { error: `${what} cannot start with "-" or contain a newline.` };
    values.push(s);
  }
  return { values };
}

function loginOk(v: string): boolean {
  return v === "@me" || /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(v);
}

type ReviewDecision = "comment" | "approve" | "request-changes";

function reviewDecision(raw: unknown): ReviewDecision | "unknown" | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const s = String(raw).trim().toLowerCase().replace(/[_ ]+/g, "-");
  if (s === "approve" || s === "approved") return "approve";
  if (s === "request-changes" || s === "request-change" || s === "changes-requested" || s === "changes") return "request-changes";
  if (s === "comment" || s === "commented") return "comment";
  return "unknown";
}

function reviewEvent(decision: ReviewDecision): "COMMENT" | "APPROVE" | "REQUEST_CHANGES" {
  if (decision === "approve") return "APPROVE";
  if (decision === "request-changes") return "REQUEST_CHANGES";
  return "COMMENT";
}

function isRequestError(err: unknown): err is { status: number; response?: { data?: unknown; headers?: unknown } } {
  return !!err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number";
}

function isRateLimit(res: GithubResponse): boolean {
  if (res.status !== 403 && res.status !== 429) return false;
  const msg = messageOf(res.data);
  if (/rate limit/i.test(msg)) return true;
  const remaining = Number(res.headers["x-ratelimit-remaining"]);
  return res.status === 429 || (res.status === 403 && remaining === 0);
}

function messageOf(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const message = (data as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function publicHttpError(res: GithubResponse): string {
  const msg = messageOf(res.data).trim();
  return clip(msg || "github request failed", 500);
}

function safeClientError(err: unknown, token: string): string {
  const raw = err instanceof Error ? err.message : "github request failed";
  const first = raw.split("\n")[0] ?? "github request failed";
  const scrubbed = token ? first.split(token).join("[redacted]") : first;
  if (scrubbed.includes("[redacted]") || /authorization|bearer /i.test(scrubbed)) return "github request failed";
  return clip(scrubbed, 300) || "github request failed";
}

function withFooter(text: string, footer: string): string {
  const line = footer.trim();
  let out = text.endsWith("\n") || !text ? text : text + "\n";
  if (line && !out.includes(line)) out = out.trimEnd() + "\n\n" + line + "\n";
  if (out && !out.endsWith("\n")) out += "\n";
  return out;
}

function issuesNamed(branch: string | undefined): number[] {
  if (!branch) return [];
  const found = new Set<number>();
  for (const match of branch.matchAll(/#(\d+)\b/g)) {
    const before = branch.slice(0, match.index ?? 0);
    if (/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(before)) continue;
    found.add(Number(match[1]));
  }
  for (const match of branch.matchAll(/(?:^|[/\-])issues?[/\-](\d+)\b/gi)) found.add(Number(match[1]));
  for (const match of branch.matchAll(/(?:^|\/)(\d+)-[A-Za-z]/g)) found.add(Number(match[1]));
  return [...found].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
}

function closesFrom(args: Record<string, unknown>, branch: string): number[] {
  const found = new Set(issuesNamed(branch));
  if (Array.isArray(args.closes)) {
    for (const n of args.closes) {
      const v = positiveInt(n);
      if (v) found.add(v);
    }
  }
  return [...found].sort((a, b) => a - b);
}

const closing = (n: number) => new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s*#${n}\\b`, "i");

function insertUnder(markdown: string, heading: RegExp, value: string): { text: string; found: boolean } {
  const trimmed = value.trim();
  if (!trimmed) return { text: markdown, found: false };
  const m = heading.exec(markdown);
  if (!m) return { text: markdown, found: false };
  const at = m.index + m[0].length;
  const next = markdown.indexOf("\n#", at);
  const section = markdown.slice(at, next === -1 ? undefined : next);
  if (section.includes(trimmed)) return { text: markdown, found: true };
  return { text: markdown.slice(0, at) + "\n" + trimmed + "\n" + markdown.slice(at), found: true };
}

function composePrBody(input: {
  template?: string;
  body?: string;
  summary?: string;
  testPlan?: string;
  closes?: number[];
  footer?: string;
}): string {
  let text = input.body?.trim() ?? "";
  if (!text && input.template?.trim()) {
    let filled = input.template.endsWith("\n") ? input.template : input.template + "\n";
    const summary = insertUnder(filled, /^#{1,6}[^\n]*\bsummary\b[^\n]*\n/im, input.summary ?? "");
    filled = summary.text;
    const plan = insertUnder(filled, /^#{1,6}[^\n]*\btest plan\b[^\n]*\n/im, input.testPlan ?? "");
    filled = plan.text;
    if (!summary.found && input.summary?.trim()) filled = filled.trimEnd() + `\n\n## Summary\n\n${input.summary.trim()}\n`;
    if (!plan.found && input.testPlan?.trim()) filled = filled.trimEnd() + `\n\n## Test plan\n\n${input.testPlan.trim()}\n`;
    text = filled.trim();
  } else if (!text) {
    text = `## Summary\n\n${input.summary?.trim() || "See the commits on this branch."}\n\n## Test plan\n\n${input.testPlan?.trim() || "- [ ] not run"}`;
  }
  const missing = (input.closes ?? []).filter((n) => !closing(n).test(text));
  if (missing.length) text = text.trimEnd() + "\n\n" + missing.map((n) => `Closes #${n}`).join("\n");
  return withFooter(text, input.footer ?? "");
}

function prState(pr: any): string {
  if (pr?.merged_at) return "MERGED";
  return String(pr?.state ?? "").toUpperCase();
}

function normalizePull(
  pr: any,
  review: string | undefined,
  checks: { passed: number; failed: number; pending: number; total: number } | undefined,
  jobs: { name: string; state: string; url: string }[],
  includeBody = true,
): Record<string, unknown> {
  const sha = typeof pr?.head?.sha === "string" ? pr.head.sha.toLowerCase() : undefined;
  return obj({
    number: Number(pr?.number),
    title: String(pr?.title ?? ""),
    url: String(pr?.html_url ?? ""),
    state: prState(pr),
    draft: pr?.draft === true,
    base: pr?.base?.ref ? String(pr.base.ref) : undefined,
    sha,
    review,
    author: pr?.user?.login ? String(pr.user.login) : undefined,
    head: pr?.head?.ref ? String(pr.head.ref) : undefined,
    ...(includeBody && typeof pr?.body === "string" ? { body: clip(pr.body, 8000) } : {}),
    checks,
    jobs,
  });
}

function baseBranch(raw: unknown, sessionBase: string | undefined): string | { error: string } {
  const base = typeof raw === "string" && raw.trim() ? raw.trim() : (sessionBase?.trim() || "main");
  if (base.startsWith("-")) return { error: "A base branch cannot start with \"-\"." };
  return base;
}

function qualify(query: string, which: "is:issue" | "is:pr"): string {
  const re = which === "is:issue" ? /\bis:issue\b/ : /\bis:pr\b/;
  if (re.test(query)) return query;
  return `${query} ${which}`;
}

function normalizeIssue(data: any): Record<string, unknown> {
  const labels = Array.isArray(data?.labels) ? data.labels.map((l: any) => String(l?.name ?? l)).filter(Boolean) : [];
  const assignees = Array.isArray(data?.assignees) ? data.assignees.map((a: any) => String(a?.login ?? a)).filter(Boolean) : [];
  return obj({
    number: Number(data?.number),
    title: String(data?.title ?? ""),
    url: String(data?.html_url ?? data?.url ?? ""),
    state: String(data?.state ?? "").toUpperCase(),
    labels,
    assignees,
    body: typeof data?.body === "string" ? clip(data.body, 8000) : undefined,
  });
}

interface CheckNode {
  name: string;
  state: string;
  url: string;
  time?: number;
  index: number;
  detail: SessionCheck;
}

/** #500: one check on the session's pull request head, for the web UI's checks list. */
export interface SessionCheck {
  /** A check run's numeric id (the log route takes it), or `status:<context>` for a commit status. */
  id: string;
  name: string;
  kind: "check-run" | "status";
  /** GitHub's check-run status (queued, in_progress, completed, ...), or `pending` / `completed` for a status. */
  status: string;
  /** GitHub's conclusion (success, failure, ...), lower case; null while it runs. */
  conclusion: string | null;
  /** pass / fail / running / skipped, the UI's four lamps. */
  state: "pass" | "fail" | "running" | "skipped";
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
  /** A GitHub Actions job: GET /api/sessions/:id/checks/:checkId/log can read its log. */
  hasLog: boolean;
}

function checkState(upper: string): SessionCheck["state"] {
  if (upper === "SUCCESS") return "pass";
  if (upper === "NEUTRAL" || upper === "SKIPPED") return "skipped";
  if (FAILED_CHECK.has(upper)) return "fail";
  return "running";
}

function isoOrNull(raw: unknown): string | null {
  return typeof raw === "string" && Number.isFinite(Date.parse(raw)) ? raw : null;
}

function webUrlOrNull(raw: unknown): string | null {
  return typeof raw === "string" && /^https:\/\/[^\s]+$/.test(raw) ? raw : null;
}

function stamp(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : undefined;
}

function collectChecks(checkRuns: any[], statuses: any[]): {
  checks?: { passed: number; failed: number; pending: number; total: number };
  jobs: { name: string; state: string; url: string }[];
  details: SessionCheck[];
} {
  const nodes: CheckNode[] = [];
  let index = 0;
  for (const run of checkRuns) {
    const name = String(run?.name ?? "check");
    const state = String(run?.conclusion ?? run?.status ?? "").toUpperCase();
    const url = String(run?.html_url ?? run?.details_url ?? "");
    const id = typeof run?.id === "number" && Number.isSafeInteger(run.id) ? String(run.id) : `run:${index}`;
    nodes.push({
      name,
      state,
      url,
      time: stamp(run?.completed_at ?? run?.started_at ?? run?.created_at),
      index: index++,
      detail: {
        id,
        name,
        kind: "check-run",
        status: String(run?.status ?? "").toLowerCase() || "queued",
        conclusion: typeof run?.conclusion === "string" && run.conclusion ? run.conclusion.toLowerCase() : null,
        state: checkState(state),
        startedAt: isoOrNull(run?.started_at),
        completedAt: isoOrNull(run?.completed_at),
        detailsUrl: webUrlOrNull(run?.html_url ?? run?.details_url),
        hasLog: run?.app?.slug === "github-actions" && /^\d+$/.test(id),
      },
    });
  }
  for (const status of statuses) {
    const name = String(status?.context ?? "status");
    const state = String(status?.state ?? "").toUpperCase();
    const done = state !== "PENDING" && state !== "";
    nodes.push({
      name,
      state,
      url: String(status?.target_url ?? ""),
      time: stamp(status?.updated_at ?? status?.created_at),
      index: index++,
      detail: {
        id: `status:${name}`,
        name,
        kind: "status",
        status: done ? "completed" : "pending",
        conclusion: done ? state.toLowerCase() : null,
        state: checkState(state),
        startedAt: isoOrNull(status?.created_at),
        completedAt: done ? isoOrNull(status?.updated_at) : null,
        detailsUrl: webUrlOrNull(status?.target_url),
        hasLog: false,
      },
    });
  }
  const best = new Map<string, CheckNode>();
  for (const node of nodes) {
    const key = node.name.trim() || `\0${node.index}`;
    const prev = best.get(key);
    const wins = !prev
      || (node.time !== undefined && prev.time !== undefined
        ? node.time > prev.time || (node.time === prev.time && node.index > prev.index)
        : node.index > prev.index);
    if (wins) best.set(key, node);
  }
  const latest = [...best.values()].sort((a, b) => a.index - b.index);
  if (!latest.length) return { jobs: [], details: [] };
  let passed = 0, failed = 0, pending = 0;
  for (const node of latest) {
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(node.state)) passed++;
    else if (FAILED_CHECK.has(node.state)) failed++;
    else pending++;
  }
  return {
    checks: { passed, failed, pending, total: latest.length },
    jobs: latest.map((node) => ({ name: node.name, state: node.state, url: node.url })),
    details: latest.map((node) => node.detail),
  };
}

function reviewFrom(reviews: any[]): string | undefined {
  const sorted = reviews
    .filter((r) => r && r.state && r.state !== "PENDING" && r.state !== "COMMENTED")
    .sort((a, b) => String(a.submitted_at ?? "").localeCompare(String(b.submitted_at ?? "")));
  for (let i = sorted.length - 1; i >= 0; i--) {
    const state = String(sorted[i].state);
    if (state === "DISMISSED") continue;
    if (state === "APPROVED" || state === "CHANGES_REQUESTED") return state;
  }
  return undefined;
}

function permissionOf(repo: any): string | null {
  const p = repo?.permissions;
  if (!p || typeof p !== "object") return null;
  if (p.admin) return "ADMIN";
  if (p.maintain) return "MAINTAIN";
  if (p.push) return "WRITE";
  if (p.triage) return "TRIAGE";
  if (p.pull) return "READ";
  return null;
}

function boundQuery(query: string, owner: string, repo: string): string {
  const stripped = query.replace(/(?:^|\s)-?repo:\S+/gi, " ").replace(/\s+/g, " ").trim();
  return `${stripped} repo:${owner}/${repo}`.trim();
}

function searchRows(data: any): { number: number; title: string; state: string; url: string }[] {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.map((item: any) => ({
    number: Number(item?.number),
    title: String(item?.title ?? ""),
    state: String(item?.state ?? ""),
    url: String(item?.html_url ?? ""),
  }));
}
