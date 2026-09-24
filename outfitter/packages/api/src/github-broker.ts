// Phase 3 GitHub broker. The run's token stays in this process: agentd sends a
// github.request up-frame and gets a github.result down-frame. No gh passthrough.
// GraphQL is used only for review-thread replies and resolve.

import { createHash } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { SecretsBroker } from "./secrets.ts";
import type { GithubIdempotencyRecord, GithubWriteProgress, Session, Store } from "./store/types.ts";
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
  | { ok: false; error: string; progress?: GithubWriteProgress };

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
  | { ok: false; error: string };

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
    if (!session.repo) {
      return this.settle(runId, op, key, write, { ok: false, error: "this session has no repository" });
    }
    const parsed = parseSessionRepo(session.repo);
    if (!parsed) {
      return this.settle(runId, op, key, write, { ok: false, error: "this session's repository is not a github.com repository" });
    }
    if (op === "github_pr.merge" && guru.mergeFromCloud !== true) {
      return this.settle(runId, op, key, write, { ok: false, error: "not permitted" });
    }
    const secrets = await this.secrets.secretsForRun(session, guru);
    const token = secrets.githubToken.trim();
    if (!token) {
      // #158: with the App configured, secretsForRun never falls back to the shared PAT, so this
      // one request fails instead of being written as the PAT's user.
      const error =
        secrets.githubAppFailure === "unavailable"
          ? "the GitHub App could not get a token just now; try again shortly"
          : secrets.githubAppFailure === "not-installed"
            ? "the Outfitter GitHub App is not installed on this repository"
            : "not permitted";
      return this.settle(runId, op, key, write, { ok: false, error });
    }

    const ctx: Ctx = {
      runId,
      op,
      key,
      write,
      session,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: session.branch?.trim() || `outfitter/${session.id}`,
      token,
      transport: this.transportFor(token),
      footer: await this.footerFor(session),
      paced: false,
      resume,
    };
    const result = await this.execute(ctx, args);
    return this.settle(runId, op, key, write, result);
  }

  private async ownerLogin(session: Session): Promise<string> {
    if (!session.ownerEmail) return "";
    try {
      const user = await this.store.users.findByEmail(session.ownerEmail);
      const login = user?.githubLogin?.replace(/^@/, "").trim() ?? "";
      return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login) ? login : "";
    } catch {
      return "";
    }
  }

  private async footerFor(session: Session): Promise<string> {
    const login = await this.ownerLogin(session);
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
    const stored = structuredClone(result);
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
    if (isRateLimit(res)) return { ok: false, error: "rate limit exceeded" };
    if (res.status === 401 || res.status === 403) return { ok: false, error: "not permitted" };
    if (res.status === 404) return { ok: false, error: "not found" };
    if (res.status < 200 || res.status >= 300) return { ok: false, error: publicHttpError(res) };
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
  ): Promise<{ checks?: { passed: number; failed: number; pending: number; total: number }; jobs: { name: string; state: string; url: string }[] } | { error: string }> {
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

  private async createPr(ctx: Ctx, args: Record<string, unknown>): Promise<GithubOpResult> {
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
      if (templates.length > 1 && !wanted) {
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
    if (!res.ok) return { ok: false, error: res.error };
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
    if (head !== pin) return { ok: false, error: `The pull request head moved from ${pin} to ${head}. Look again before merging.` };
    const res = await this.call(ctx, "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
      owner: ctx.owner, repo: ctx.repo, pull_number: number, merge_method: method, sha: pin,
    });
    if (!res.ok) return { ok: false, error: res.error };
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
}

function stamp(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : undefined;
}

function collectChecks(checkRuns: any[], statuses: any[]): { checks?: { passed: number; failed: number; pending: number; total: number }; jobs: { name: string; state: string; url: string }[] } {
  const nodes: CheckNode[] = [];
  let index = 0;
  for (const run of checkRuns) {
    nodes.push({
      name: String(run?.name ?? "check"),
      state: String(run?.conclusion ?? run?.status ?? "").toUpperCase(),
      url: String(run?.html_url ?? run?.details_url ?? ""),
      time: stamp(run?.completed_at ?? run?.started_at ?? run?.created_at),
      index: index++,
    });
  }
  for (const status of statuses) {
    nodes.push({
      name: String(status?.context ?? "status"),
      state: String(status?.state ?? "").toUpperCase(),
      url: String(status?.target_url ?? ""),
      time: stamp(status?.updated_at ?? status?.created_at),
      index: index++,
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
  if (!latest.length) return { jobs: [] };
  let passed = 0, failed = 0, pending = 0;
  for (const node of latest) {
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(node.state)) passed++;
    else if (FAILED_CHECK.has(node.state)) failed++;
    else pending++;
  }
  return {
    checks: { passed, failed, pending, total: latest.length },
    jobs: latest.map((node) => ({ name: node.name, state: node.state, url: node.url })),
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
