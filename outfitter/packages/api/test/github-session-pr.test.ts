// #500: the session owner's pull request routes (create, checks, merge, sync, re-run, log) over
// the broker's gates and credential, on a fake GitHub transport.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory.ts";
import { MemorySecretsBroker } from "../src/secrets.ts";
import {
  GithubBroker,
  RERUN_PERMISSION_ERROR,
  SYNC_AGENT_NOTE,
  logTail,
  type GithubResponse,
  type GithubTransport,
} from "../src/github-broker.ts";
import { generateToken, hashToken, tokenPrefix } from "../src/tokens.ts";
import type { Session, Store } from "../src/store/types.ts";
import { buildTestApp, seedGuru, type TestApp } from "./helpers.ts";

const HEAD = "a".repeat(40);
const RATE = { "x-ratelimit-remaining": "4800", "x-ratelimit-reset": "1700000000" };

interface Call {
  route: string;
  params: Record<string, unknown>;
}

function response(status: number, data: unknown): GithubResponse {
  return { status, data, headers: RATE };
}

/** What the fake GitHub knows. Tests change it between calls. */
interface World {
  openPr: boolean;
  aheadBy: number;
  behindBy: number;
  branchMissing: boolean;
  updateBranch: "ok" | "conflict";
  merges: 201 | 204 | 409;
  mergeStatus: 200 | 405;
  rerunStatus: 201 | 403;
  workflowRuns: { id: number; name: string; status: string; conclusion: string | null; head_branch?: string; head_sha?: string }[];
  defaultBranch: string;
}

function world(overrides: Partial<World> = {}): World {
  return {
    openPr: false,
    aheadBy: 2,
    behindBy: 0,
    branchMissing: false,
    updateBranch: "ok",
    merges: 201,
    mergeStatus: 200,
    rerunStatus: 201,
    workflowRuns: [],
    defaultBranch: "main",
    ...overrides,
  };
}

function pull(params: Record<string, unknown>) {
  return {
    number: 7,
    title: "Add tools",
    html_url: `https://github.com/${params.owner}/${params.repo}/pull/7`,
    state: "open",
    draft: false,
    head: { ref: "feature", sha: HEAD },
    base: { ref: "main" },
    requested_reviewers: [{ login: "grace" }],
  };
}

function fakeGithub(w: World, calls: Call[]): GithubTransport {
  return {
    async request(route, params) {
      calls.push({ route, params: { ...params } });
      if (route.startsWith("GET /repos/{owner}/{repo}/contents/")) return response(404, { message: "Not Found" });
      if (route === "GET /repos/{owner}/{repo}/pulls") return response(200, w.openPr ? [pull(params)] : []);
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return response(200, { ...pull(params), mergeable: true, mergeable_state: "clean" });
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") return response(200, []);
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
        return response(200, {
          check_runs: [
            { id: 101, name: "test", status: "completed", conclusion: "failure", started_at: "2026-10-07T10:00:00Z", completed_at: "2026-10-07T10:03:00Z", html_url: "https://github.com/acme/widgets/actions/runs/5/job/101", app: { slug: "github-actions" } },
            { id: 102, name: "lint", status: "in_progress", conclusion: null, started_at: "2026-10-07T10:00:00Z", html_url: "https://github.com/acme/widgets/actions/runs/5/job/102", app: { slug: "github-actions" } },
            { id: 103, name: "typecheck", status: "completed", conclusion: "success", started_at: "2026-10-07T10:00:00Z", completed_at: "2026-10-07T10:01:00Z", html_url: "https://github.com/acme/widgets/actions/runs/5/job/103", app: { slug: "github-actions" } },
          ],
        });
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/status") {
        return response(200, { statuses: [{ context: "deploy/preview", state: "success", target_url: "https://example.com/p", created_at: "2026-10-07T10:00:00Z", updated_at: "2026-10-07T10:02:00Z" }] });
      }
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
        if (w.branchMissing) return response(404, { message: "Not Found" });
        return response(200, { ahead_by: w.aheadBy, behind_by: w.behindBy });
      }
      if (route === "POST /repos/{owner}/{repo}/pulls") {
        return response(201, { html_url: `https://github.com/${params.owner}/${params.repo}/pull/9`, number: 9 });
      }
      if (route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge") {
        if (w.mergeStatus === 405) return response(405, { message: "Pull Request is not mergeable" });
        return response(200, { merged: true, message: "Pull Request successfully merged", sha: "c".repeat(40) });
      }
      if (route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch") {
        if (w.updateBranch === "conflict") return response(422, { message: "merge conflict between base and head" });
        return response(202, { message: "Updating pull request branch." });
      }
      if (route === "POST /repos/{owner}/{repo}/merges") {
        if (w.merges === 409) return response(409, { message: "Merge conflict" });
        if (w.merges === 204) return response(204, "");
        return response(201, { sha: "d".repeat(40) });
      }
      if (route === "GET /repos/{owner}/{repo}/branches/{branch}") return response(200, { commit: { sha: HEAD } });
      if (route === "GET /repos/{owner}/{repo}/actions/runs") {
        return response(200, { workflow_runs: w.workflowRuns.map((run) => ({ head_branch: "feature", head_sha: HEAD, ...run })) });
      }
      if (route === "GET /repos/{owner}/{repo}") return response(200, { full_name: `${params.owner}/${params.repo}`, default_branch: w.defaultBranch });
      if (route === "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs") {
        if (w.rerunStatus === 403) return response(403, { message: "Resource not accessible by integration" });
        return response(201, {});
      }
      if (route === "GET /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        const id = Number(params.check_run_id);
        return response(200, { id, name: "test", conclusion: "failure", html_url: `https://github.com/acme/widgets/actions/runs/5/job/${id}`, head_sha: id === 998 ? "e".repeat(40) : HEAD, app: { slug: id === 999 ? "circleci" : "github-actions" } });
      }
      if (route === "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs") {
        const lines = Array.from({ length: 120 }, (_, i) => `2026-10-07T10:02:${String(i % 60).padStart(2, "0")}.1234567Z line ${i}`);
        return response(200, `${lines.join("\n")}\n\u001b[31mError: expected 1 to equal 2\u001b[0m\n`);
      }
      return response(500, { message: `unhandled ${route}` });
    },
  };
}

async function seedSession(store: Store, overrides: Partial<Session> = {}): Promise<Session> {
  const now = new Date().toISOString();
  const session: Session = {
    id: "s1",
    guruId: "test-guru",
    repo: "acme/widgets",
    branch: "feature",
    baseBranch: "main",
    ownerEmail: "owner@example.com",
    status: "open",
    cost: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await store.sessions.insert(session);
  return session;
}

/** A broker on the fake, with one session (and its tape). */
async function brokerWith(opts: { world?: Partial<World>; mergeFromCloud?: boolean; session?: Partial<Session>; secrets?: MemorySecretsBroker } = {}) {
  const store = new MemoryStore();
  await seedGuru(store, opts.mergeFromCloud ? { mergeFromCloud: true } : {});
  const session = await seedSession(store, opts.session);
  const w = world(opts.world);
  const calls: Call[] = [];
  const tokens: string[] = [];
  const secrets = opts.secrets ?? new MemorySecretsBroker("ghs_broker", "");
  const broker = new GithubBroker(store, secrets, (token) => {
    tokens.push(token);
    return fakeGithub(w, calls);
  }, async () => {});
  return { store, session, w, calls, tokens, broker };
}

const OWNER = { email: "owner@example.com" };
const writes = (calls: Call[]) => calls.filter((c) => !c.route.startsWith("GET "));

describe("#500 session pull request", () => {
  test("status: the open pull request's checks, summary, review and mergeability; mergeAllowed follows the tape", async () => {
    const { broker, session } = await brokerWith({ world: { openPr: true } });
    const status = await broker.sessionPrStatus(session);
    assert.equal(status.mergeAllowed, false);
    assert.ok(status.pr);
    const pr = status.pr!;
    assert.equal(pr.number, 7);
    assert.equal(pr.headSha, HEAD);
    assert.equal(pr.review, "review_required");
    assert.equal(pr.mergeable, true);
    assert.equal(pr.mergeableState, "clean");
    assert.deepEqual(pr.checkSummary, { passed: 2, failed: 1, pending: 1, total: 4, state: "fail" });
    const test101 = pr.checks.find((c) => c.name === "test")!;
    assert.deepEqual(test101, {
      id: "101",
      name: "test",
      kind: "check-run",
      status: "completed",
      conclusion: "failure",
      state: "fail",
      startedAt: "2026-10-07T10:00:00Z",
      completedAt: "2026-10-07T10:03:00Z",
      detailsUrl: "https://github.com/acme/widgets/actions/runs/5/job/101",
      hasLog: true,
    });
    assert.equal(pr.checks.find((c) => c.name === "lint")!.state, "running");
    const deploy = pr.checks.find((c) => c.kind === "status")!;
    assert.equal(deploy.id, "status:deploy/preview");
    assert.equal(deploy.state, "pass");
    assert.equal(deploy.hasLog, false);
  });

  test("status: no open pull request is pr: null; a cached answer still reads mergeAllowed live", async () => {
    const { broker, session, store, calls } = await brokerWith();
    const first = await broker.sessionPrStatus(session);
    assert.deepEqual(first, { mergeAllowed: false, pr: null });
    await store.gurus.update("test-guru", { mergeFromCloud: true });
    const before = calls.length;
    const second = await broker.sessionPrStatus(session);
    assert.equal(second.mergeAllowed, true);
    assert.equal(calls.length, before, "served from the cache");
  });

  test("create: opens the branch's pull request against its base, on behalf of the signed-in person", async () => {
    const { broker, session, store, calls } = await brokerWith();
    const logins: Record<string, string> = { "owner@example.com": "ada", "sysop@example.com": "grace" };
    store.users.findByEmail = async (email: string) =>
      logins[email] ? { email, createdAt: new Date().toISOString(), githubLogin: logins[email] } : null;
    const result = await broker.createSessionPr(session, { email: "sysop@example.com" }, { title: "Add widgets", draft: true }, "k1");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, { number: 9, url: "https://github.com/acme/widgets/pull/9", draft: true, base: "main", template: null });
    const post = calls.find((c) => c.route === "POST /repos/{owner}/{repo}/pulls")!;
    assert.equal(post.params.head, "feature");
    assert.equal(post.params.base, "main");
    assert.equal(post.params.draft, true);
    assert.equal(post.params.title, "Add widgets");
    // No template in the repository: the broker's default body, signed for the person who clicked.
    assert.match(String(post.params.body), /## Summary/);
    assert.match(String(post.params.body), /Outfitter, on behalf of @grace\n$/);
    // A repeat with the same key gets the first answer and posts nothing.
    const again = await broker.createSessionPr(session, { email: "sysop@example.com" }, { title: "Add widgets", draft: true }, "k1");
    assert.deepEqual(again, result);
    assert.equal(calls.filter((c) => c.route === "POST /repos/{owner}/{repo}/pulls").length, 1);
  });

  test("create: 409 when a pull request already exists, or the branch has no commits ahead, or isn't pushed", async () => {
    const exists = await brokerWith({ world: { openPr: true } });
    const one = await exists.broker.createSessionPr(exists.session, OWNER, { title: "x" });
    assert.equal(one.ok, false);
    if (!one.ok) {
      assert.equal(one.status, 409);
      assert.equal(one.code, "pr-exists");
      assert.equal(one.data?.url, "https://github.com/acme/widgets/pull/7");
    }
    const empty = await brokerWith({ world: { aheadBy: 0 } });
    const two = await empty.broker.createSessionPr(empty.session, OWNER, { title: "x" });
    assert.equal(two.ok === false && two.status === 409 && two.code, "no-commits");
    const missing = await brokerWith({ world: { branchMissing: true } });
    const three = await missing.broker.createSessionPr(missing.session, OWNER, { title: "x" });
    assert.equal(three.ok === false && three.status === 409 && three.code, "no-branch");
    for (const b of [exists, empty, missing]) assert.equal(writes(b.calls).length, 0, "nothing was written");
    const untitled = await empty.broker.createSessionPr(empty.session, OWNER, { title: "  " });
    assert.equal(untitled.ok === false && untitled.status, 400);
  });

  test("merge: refused unless the tape has mergeFromCloud, and always for an A2A session", async () => {
    const off = await brokerWith({ world: { openPr: true } });
    const refused = await off.broker.mergeSessionPr(off.session, OWNER, { sha: HEAD });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.status, 403);
      assert.equal(refused.code, "merge-not-allowed");
    }
    assert.equal(off.calls.length, 0, "refused before any GitHub call");

    const a2a = await brokerWith({
      world: { openPr: true },
      mergeFromCloud: true,
      session: { origin: "a2a", a2aTokenId: "k1", branch: "outfitter/a2a-0123456789ab" },
    });
    const a2aRefused = await a2a.broker.mergeSessionPr(a2a.session, OWNER, { sha: HEAD });
    assert.equal(a2aRefused.ok === false && a2aRefused.code, "merge-not-allowed");
    assert.equal((await a2a.broker.sessionPrStatus(a2a.session)).mergeAllowed, false);
    assert.equal(a2a.calls.filter((c) => c.route.includes("/merge")).length, 0);
  });

  test("merge: SHA-pinned squash by default; a moved head or an unmergeable pull request is a 409", async () => {
    const on = await brokerWith({ world: { openPr: true }, mergeFromCloud: true });
    const bad = await on.broker.mergeSessionPr(on.session, OWNER, { sha: "abc" });
    assert.equal(bad.ok === false && bad.status, 400);
    const moved = await on.broker.mergeSessionPr(on.session, OWNER, { sha: "b".repeat(40) });
    assert.equal(moved.ok === false && moved.status === 409 && moved.code, "head-moved");
    assert.equal(on.calls.filter((c) => c.route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge").length, 0);
    const merged = await on.broker.mergeSessionPr(on.session, OWNER, { sha: HEAD.toUpperCase() });
    assert.equal(merged.ok, true);
    const put = on.calls.find((c) => c.route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge")!;
    assert.equal(put.params.merge_method, "squash");
    assert.equal(put.params.sha, HEAD);

    const stuck = await brokerWith({ world: { openPr: true, mergeStatus: 405 }, mergeFromCloud: true });
    const no = await stuck.broker.mergeSessionPr(stuck.session, OWNER, { sha: HEAD });
    assert.equal(no.ok === false && no.status === 409 && no.code, "not-mergeable");

    const none = await brokerWith({ mergeFromCloud: true });
    const noPr = await none.broker.mergeSessionPr(none.session, OWNER, { sha: HEAD });
    assert.equal(noPr.ok === false && noPr.status === 409 && noPr.code, "no-pr");
  });

  test("sync: up to date without writing; update-branch with a pull request; a conflict is a result, not an error", async () => {
    const current = await brokerWith({ world: { openPr: true, behindBy: 0 } });
    const same = await current.broker.syncSession(current.session, OWNER);
    assert.deepEqual(same, { ok: true, data: { status: "up-to-date", via: null, base: "main", branchMoved: false } });
    assert.equal(writes(current.calls).length, 0);

    const behind = await brokerWith({ world: { openPr: true, behindBy: 3 } });
    const updated = await behind.broker.syncSession(behind.session, OWNER);
    assert.deepEqual(updated, {
      ok: true,
      data: { status: "updated", via: "update-branch", base: "main", branchMoved: true, agentNote: SYNC_AGENT_NOTE },
    });
    const put = behind.calls.find((c) => c.route.endsWith("/update-branch"))!;
    assert.equal(put.params.expected_head_sha, HEAD);

    const clash = await brokerWith({ world: { openPr: true, behindBy: 3, updateBranch: "conflict" } });
    const conflict = await clash.broker.syncSession(clash.session, OWNER);
    assert.deepEqual(conflict, { ok: true, data: { status: "conflict", via: "update-branch", base: "main", branchMoved: false } });
  });

  test("sync: without a pull request, the merges API merges base into the branch; 409 is a conflict", async () => {
    const plain = await brokerWith({ world: { behindBy: 1 } });
    const merged = await plain.broker.syncSession(plain.session, OWNER);
    assert.equal(merged.ok && merged.data.status, "updated");
    assert.equal(merged.ok && merged.data.via, "merge");
    assert.equal(merged.ok && merged.data.branchMoved, true);
    const post = plain.calls.find((c) => c.route === "POST /repos/{owner}/{repo}/merges")!;
    assert.equal(post.params.base, "feature");
    assert.equal(post.params.head, "main");

    const clash = await brokerWith({ world: { behindBy: 1, merges: 409 } });
    const conflict = await clash.broker.syncSession(clash.session, OWNER);
    assert.deepEqual(conflict, { ok: true, data: { status: "conflict", via: "merge", base: "main", branchMoved: false } });
  });

  test("re-run: re-runs each failed workflow run on the head; nothing failed is nothing to re-run", async () => {
    const idle = await brokerWith({ world: { openPr: true, workflowRuns: [{ id: 5, name: "CI", status: "completed", conclusion: "success" }] } });
    const nothing = await idle.broker.rerunSessionChecks(idle.session, OWNER);
    assert.deepEqual(nothing, { ok: true, data: { status: "nothing-to-rerun", sha: HEAD, rerun: [] } });

    const red = await brokerWith({
      world: {
        openPr: true,
        workflowRuns: [
          { id: 5, name: "CI", status: "completed", conclusion: "failure" },
          { id: 6, name: "Lint", status: "in_progress", conclusion: null },
          { id: 7, name: "E2E", status: "completed", conclusion: "timed_out" },
        ],
      },
    });
    const rerun = await red.broker.rerunSessionChecks(red.session, OWNER);
    assert.deepEqual(rerun, { ok: true, data: { status: "rerun", sha: HEAD, rerun: [{ id: 5, name: "CI" }, { id: 7, name: "E2E" }] } });
    const list = red.calls.find((c) => c.route === "GET /repos/{owner}/{repo}/actions/runs")!;
    assert.equal(list.params.head_sha, HEAD);
  });

  test("re-run: GitHub refusing the write is a 403 that names the missing Actions permission", async () => {
    const red = await brokerWith({ world: { openPr: true, rerunStatus: 403, workflowRuns: [{ id: 5, name: "CI", status: "completed", conclusion: "failure" }] } });
    const refused = await red.broker.rerunSessionChecks(red.session, OWNER);
    assert.deepEqual(refused, { ok: false, status: 403, error: RERUN_PERMISSION_ERROR, code: "actions-permission" });
  });

  test("re-run: an App that can't mint actions:write fails only this route, with the same message", async () => {
    class NoActions extends MemorySecretsBroker {
      override async rerunGithubToken(): Promise<{ token: string; appFailure?: "permissions-missing" }> {
        return { token: "", appFailure: "permissions-missing" };
      }
    }
    const red = await brokerWith({
      secrets: new NoActions("ghs_broker", ""),
      world: { openPr: true, workflowRuns: [{ id: 5, name: "CI", status: "completed", conclusion: "failure" }] },
    });
    const refused = await red.broker.rerunSessionChecks(red.session, OWNER);
    assert.deepEqual(refused, { ok: false, status: 403, error: RERUN_PERMISSION_ERROR, code: "actions-permission" });
    assert.equal(red.calls.filter((c) => c.route.includes("rerun")).length, 0);
    // The broker's own token still works: status reads go on.
    assert.equal((await red.broker.sessionPrStatus(red.session)).pr?.number, 7);
  });

  test("log: the tail of a GitHub Actions job's log, without timestamps or colour codes", async () => {
    const { broker, session } = await brokerWith({ world: { openPr: true } });
    const log = await broker.sessionCheckLog(session, "101");
    assert.equal(log.ok, true);
    if (!log.ok) return;
    assert.equal(log.data.truncated, true);
    assert.match(log.data.log, /Error: expected 1 to equal 2$/);
    assert.doesNotMatch(log.data.log, /2026-10-07T/);
    assert.equal(log.data.log.split("\n").length, 80);
    const other = await broker.sessionCheckLog(session, "999");
    assert.equal(other.ok === false && other.status === 404 && other.code, "no-log");
    const bad = await broker.sessionCheckLog(session, "status:deploy");
    assert.equal(bad.ok === false && bad.status, 400);
  });

  test("logTail keeps short logs whole", () => {
    assert.deepEqual(logTail("2026-10-07T10:00:00.1Z one\r\ntwo\n\n"), { log: "one\ntwo", truncated: false });
  });
});

// ---- the routes ----

async function bearerFor(store: Store, email: string): Promise<Record<string, string>> {
  const token = generateToken();
  await store.tokens.insert({
    id: crypto.randomUUID(),
    ownerEmail: email,
    name: "test",
    prefix: tokenPrefix(token),
    hash: hashToken(token),
    createdAt: new Date().toISOString(),
  });
  return { authorization: `Bearer ${token}` };
}

async function routeApp(opts: { world?: Partial<World>; mergeFromCloud?: boolean; dev?: boolean } = {}): Promise<{ app: TestApp; calls: Call[]; w: World }> {
  const store = new MemoryStore();
  const w = world(opts.world);
  const calls: Call[] = [];
  const secrets = new MemorySecretsBroker("ghs_broker", "");
  const github = new GithubBroker(store, secrets, () => fakeGithub(w, calls), async () => {});
  const app = await buildTestApp(opts.dev === false ? { OUTFITTER_DEV: "0" } : {}, { store, secretsBroker: secrets, github });
  await seedGuru(store, opts.mergeFromCloud ? { mergeFromCloud: true } : {});
  await seedSession(store);
  return { app, calls, w };
}

async function close(app: TestApp): Promise<void> {
  app.stopBackgroundTasks();
  await app.fastify.close();
}

describe("#500 session pull request routes", () => {
  test("github-status carries pr and mergeAllowed next to the catalog's facts", async () => {
    const { app } = await routeApp({ world: { openPr: true } });
    try {
      const res = await app.fastify.inject({ method: "GET", url: "/api/sessions/s1/github-status" });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.connected, false, "the catalog has no App in tests");
      assert.equal(body.mergeAllowed, false);
      assert.equal(body.pr.number, 7);
      assert.equal(body.pr.checkSummary.state, "fail");
    } finally {
      await close(app);
    }
  });

  test("only the owner (or a sysop) may act; anyone else gets 403 and nothing reaches GitHub", async () => {
    const { app, calls } = await routeApp({ dev: false, world: { openPr: true }, mergeFromCloud: true });
    try {
      const other = await bearerFor(app.store, "someone@example.com");
      for (const [method, url, payload] of [
        ["POST", "/api/sessions/s1/pr", { title: "x" }],
        ["POST", "/api/sessions/s1/pr/merge", { sha: HEAD }],
        ["POST", "/api/sessions/s1/sync", {}],
        ["POST", "/api/sessions/s1/checks/rerun", {}],
        ["GET", "/api/sessions/s1/checks/101/log", undefined],
      ] as const) {
        const res = await app.fastify.inject({ method, url, headers: other, ...(payload ? { payload } : {}) });
        assert.equal(res.statusCode, 403, `${method} ${url}`);
      }
      assert.equal(calls.length, 0);
      const owner = await bearerFor(app.store, "owner@example.com");
      const merged = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/pr/merge", headers: owner, payload: { sha: HEAD } });
      assert.equal(merged.statusCode, 200);
      assert.equal(merged.json().merged, true);
    } finally {
      await close(app);
    }
  });

  test("create is 201, a second create is 409 pr-exists, and the Idempotency-Key header replays", async () => {
    const { app, calls, w } = await routeApp();
    try {
      const headers = { "idempotency-key": "click-1" };
      const created = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/pr", headers, payload: { title: "Add widgets" } });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().url, "https://github.com/acme/widgets/pull/9");
      w.openPr = true;
      const replay = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/pr", headers, payload: { title: "Add widgets" } });
      assert.equal(replay.statusCode, 201, "same key, same answer");
      const again = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/pr", payload: { title: "Add widgets" } });
      assert.equal(again.statusCode, 409);
      assert.equal(again.json().code, "pr-exists");
      assert.equal(again.json().url, "https://github.com/acme/widgets/pull/7");
      assert.equal(calls.filter((c) => c.route === "POST /repos/{owner}/{repo}/pulls").length, 1);
    } finally {
      await close(app);
    }
  });

  test("merge with mergeFromCloud off is 403 merge-not-allowed; sync conflict is a 200; re-run without Actions: write is 403", async () => {
    const { app } = await routeApp({
      world: { openPr: true, behindBy: 2, updateBranch: "conflict", rerunStatus: 403, workflowRuns: [{ id: 5, name: "CI", status: "completed", conclusion: "failure" }] },
    });
    try {
      const merge = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/pr/merge", payload: { sha: HEAD } });
      assert.equal(merge.statusCode, 403);
      assert.equal(merge.json().code, "merge-not-allowed");
      const sync = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/sync" });
      assert.equal(sync.statusCode, 200);
      assert.equal(sync.json().status, "conflict");
      const rerun = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/checks/rerun" });
      assert.equal(rerun.statusCode, 403);
      assert.deepEqual(rerun.json(), { error: RERUN_PERMISSION_ERROR, code: "actions-permission" });
      const log = await app.fastify.inject({ method: "GET", url: "/api/sessions/s1/checks/101/log" });
      assert.equal(log.statusCode, 200);
      assert.match(log.json().log, /expected 1 to equal 2/);
    } finally {
      await close(app);
    }
  });
});

// ---- review fixes on 08016c15 ----

const pullLists = (calls: Call[]) => calls.filter((c) => c.route === "GET /repos/{owner}/{repo}/pulls").length;

describe("#500 review fixes", () => {
  test("log: a check that isn't on the session's current head is 404 no-log, and its log is never fetched", async () => {
    const { broker, session, calls } = await brokerWith({ world: { openPr: true } });
    const other = await broker.sessionCheckLog(session, "998");
    assert.equal(other.ok, false);
    if (!other.ok) {
      assert.equal(other.status, 404);
      assert.equal(other.code, "no-log");
    }
    assert.equal(calls.some((c) => c.route.endsWith("/logs")), false);
    // Without a pull request the branch tip is the head; a check there is still readable.
    const plain = await brokerWith();
    assert.equal((await plain.broker.sessionCheckLog(plain.session, "101")).ok, true);
    assert.equal((await plain.broker.sessionCheckLog(plain.session, "998")).ok, false);
  });

  test("status: concurrent reads share one GitHub read; fresh never re-reads within 5 s", async (t) => {
    const { broker, session, calls } = await brokerWith({ world: { openPr: true } });
    const all = await Promise.all([broker.sessionPrStatus(session), broker.sessionPrStatus(session), broker.sessionPrStatus(session, { fresh: true })]);
    assert.equal(pullLists(calls), 1, "one read for three concurrent callers");
    assert.ok(all.every((s) => s.pr?.number === 7));
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    await broker.sessionPrStatus(session, { fresh: true });
    assert.equal(pullLists(calls), 1, "fresh right after a read is still the cached answer");
    t.mock.timers.tick(6_000);
    await broker.sessionPrStatus(session, { fresh: true });
    assert.equal(pullLists(calls), 2, "fresh after 5 s reads again");
    await broker.sessionPrStatus(session);
    assert.equal(pullLists(calls), 2);
  });

  test("status: the cache is per branch and base, so a moved branch doesn't read the old one's state", async () => {
    const { broker, session, calls } = await brokerWith({ world: { openPr: true } });
    await broker.sessionPrStatus(session);
    await broker.sessionPrStatus({ ...session, branch: "other" });
    await broker.sessionPrStatus({ ...session, baseBranch: "develop" });
    assert.equal(pullLists(calls), 3);
    const heads = calls.filter((c) => c.route === "GET /repos/{owner}/{repo}/pulls").map((c) => c.params.head);
    assert.deepEqual(heads, ["acme:feature", "acme:other", "acme:feature"]);
  });

  test("github-status?fresh=1 is honoured only for someone who may manage the session", async (t) => {
    const { app, calls } = await routeApp({ dev: false, world: { openPr: true } });
    try {
      const other = await bearerFor(app.store, "someone@example.com");
      const owner = await bearerFor(app.store, "owner@example.com");
      const get = (headers: Record<string, string>, fresh: boolean) =>
        app.fastify.inject({ method: "GET", url: `/api/sessions/s1/github-status${fresh ? "?fresh=1" : ""}`, headers });
      assert.equal((await get(other, false)).statusCode, 200);
      assert.equal(pullLists(calls), 1);
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      t.mock.timers.tick(6_000);
      assert.equal((await get(other, true)).statusCode, 200);
      assert.equal(pullLists(calls), 1, "a non-manager's fresh=1 is the cached answer");
      assert.equal((await get(owner, true)).json().pr.number, 7);
      assert.equal(pullLists(calls), 2, "the owner's fresh=1 reads GitHub");
      await get(owner, true);
      assert.equal(pullLists(calls), 2, "but not again within 5 s");
    } finally {
      await close(app);
    }
  });

  test("sync refuses the base branch and the repository's default branch (409 protected-branch), writing nothing", async () => {
    const onBase = await brokerWith({ world: { behindBy: 2 }, session: { branch: "main", baseBranch: "main" } });
    const one = await onBase.broker.syncSession(onBase.session, OWNER);
    assert.equal(one.ok === false && one.status === 409 && one.code, "protected-branch");
    const onDefault = await brokerWith({ world: { behindBy: 2, defaultBranch: "develop" }, session: { branch: "develop", baseBranch: "release" } });
    const two = await onDefault.broker.syncSession(onDefault.session, OWNER);
    assert.equal(two.ok === false && two.status === 409 && two.code, "protected-branch");
    for (const b of [onBase, onDefault]) assert.equal(writes(b.calls).length, 0);
  });

  test("re-run picks only the session branch's runs, never another branch's at the same commit", async () => {
    const red = await brokerWith({
      world: {
        openPr: true,
        workflowRuns: [
          { id: 5, name: "CI", status: "completed", conclusion: "failure" },
          { id: 8, name: "CI (main)", status: "completed", conclusion: "failure", head_branch: "main" },
          { id: 9, name: "CI (old)", status: "completed", conclusion: "failure", head_sha: "f".repeat(40) },
        ],
      },
    });
    const rerun = await red.broker.rerunSessionChecks(red.session, OWNER);
    assert.deepEqual(rerun, { ok: true, data: { status: "rerun", sha: HEAD, rerun: [{ id: 5, name: "CI" }] } });
    const list = red.calls.find((c) => c.route === "GET /repos/{owner}/{repo}/actions/runs")!;
    assert.equal(list.params.branch, "feature");
    assert.deepEqual(red.calls.filter((c) => c.route.includes("rerun-failed-jobs")).map((c) => c.params.run_id), [5]);
  });

  test("a failure isn't remembered for its key: once the permission is granted, the same key re-runs", async () => {
    const red = await brokerWith({ world: { openPr: true, rerunStatus: 403, workflowRuns: [{ id: 5, name: "CI", status: "completed", conclusion: "failure" }] } });
    const refused = await red.broker.rerunSessionChecks(red.session, OWNER, "click-1");
    assert.equal(refused.ok === false && refused.code, "actions-permission");
    red.w.rerunStatus = 201;
    const granted = await red.broker.rerunSessionChecks(red.session, OWNER, "click-1");
    assert.equal(granted.ok, true);
    // A success is remembered: the same key again doesn't re-run twice.
    const replay = await red.broker.rerunSessionChecks(red.session, OWNER, "click-1");
    assert.deepEqual(replay, granted);
    assert.equal(red.calls.filter((c) => c.route.includes("rerun-failed-jobs")).length, 2);
  });
});
