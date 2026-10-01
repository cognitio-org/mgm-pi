// Phase 3 GitHub broker: github.request / github.result on the agent socket, plus the
// policy the API enforces before any token reaches GitHub.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory.ts";
import { MemorySecretsBroker } from "../src/secrets.ts";
import { GithubBroker, headerMap, rateLimitFromHeaders, type GithubResponse, type GithubTransport } from "../src/github-broker.ts";
import type { Run, Session } from "../src/store/types.ts";
import { buildTestApp, seedGuru } from "./helpers.ts";
import { openAgentSocket, runTokenFor, sendHello } from "./agent-socket.ts";

const SHA = "a".repeat(40);
let failIssueClose = 0;
const SHA_B = "b".repeat(40);
const RATE = { "x-ratelimit-remaining": "4800", "x-ratelimit-reset": "1700000000" };

interface Call {
  route: string;
  params: Record<string, unknown>;
}

function response(status: number, data: unknown, headers: Record<string, string> = RATE): GithubResponse {
  return { status, data, headers };
}

function pull(params: Record<string, unknown>, sha = SHA) {
  return {
    number: Number(params.pull_number ?? 7),
    title: "Add tools",
    html_url: `https://github.com/${params.owner}/${params.repo}/pull/${params.pull_number ?? 7}`,
    state: "open",
    draft: false,
    body: "hello",
    user: { login: "ada" },
    head: { ref: "feature", sha },
    base: { ref: "main" },
  };
}

/** Canned GitHub. Contents are missing (no templates). Everything else is a small happy path. */
function fakeGithub(calls: Call[]): GithubTransport {
  return {
    async request(route, params) {
      calls.push({ route, params: { ...params } });
      if (route === "GET /repos/{owner}/{repo}") {
        return response(200, {
          full_name: `${params.owner}/${params.repo}`,
          html_url: `https://github.com/${params.owner}/${params.repo}`,
          default_branch: "main",
          permissions: { push: true, pull: true },
        });
      }
      if (route.startsWith("GET /repos/{owner}/{repo}/contents/")) return response(404, { message: "Not Found" });
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return response(200, pull(params));
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        return response(200, [pull({ ...params, pull_number: 7 })]);
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
        return response(200, [{ state: "APPROVED", submitted_at: "2020-01-02T00:00:00Z" }]);
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
        return response(200, { check_runs: [{ name: "test", conclusion: "success", status: "completed", html_url: "https://example/check" }] });
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/status") return response(200, { statuses: [] });
      if (route === "PATCH /repos/{owner}/{repo}/issues/{issue_number}" && params.state === "closed") {
        if (failIssueClose > 0) {
          failIssueClose -= 1;
          return response(500, { message: "nope" });
        }
        return response(200, { number: params.issue_number, state: "closed" });
      }
      if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        return response(201, { html_url: `https://github.com/${params.owner}/${params.repo}/issues/${params.issue_number}#issuecomment-9` });
      }
      if (route === "POST /repos/{owner}/{repo}/pulls") {
        return response(201, { html_url: `https://github.com/${params.owner}/${params.repo}/pull/7`, number: 7 });
      }
      if (route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge") {
        return response(200, { merged: true, message: "merged", sha: SHA });
      }
      if (route === "POST /graphql") {
        const query = String(params.query ?? "");
        if (query.includes("nameWithOwner")) {
          const id = String((params.variables as { id?: string } | undefined)?.id ?? "");
          const nameWithOwner = id === "other-repo" ? "other/repo" : "acme/widgets";
          return response(200, { data: { node: { pullRequest: { repository: { nameWithOwner } } } } });
        }
        if (query.includes("addPullRequestReviewThreadReply")) {
          return response(200, { data: { addPullRequestReviewThreadReply: { comment: { url: "https://github.com/acme/widgets/pull/7#discussion_r1" } } } });
        }
        return response(200, { data: { resolveReviewThread: { thread: { isResolved: true } } } });
      }
      return response(500, { message: `unhandled ${route}` });
    },
  };
}

function owners(calls: Call[]): string[] {
  return calls.map((c) => `${c.params.owner ?? ""}/${c.params.repo ?? ""}`);
}

async function socketApp(opts: { mergeFromCloud?: boolean; a2a?: boolean } = {}) {
  const store = new MemoryStore();
  const secrets = new MemorySecretsBroker("test-github-token", "llm");
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const github = new GithubBroker(store, secrets, () => fakeGithub(calls), async (ms) => {
    sleeps.push(ms);
  });
  const app = await buildTestApp({}, { store, secretsBroker: secrets, github });
  await seedGuru(app.store, {
    ...(opts.mergeFromCloud ? { mergeFromCloud: true } : {}),
    // An A2A session's run needs a tape that passes a2aTapeProblem (agentlink.ts).
    ...(opts.a2a ? { tools: ["read", "bash", "github_pr"] } : {}),
  });
  const now = new Date().toISOString();
  if (opts.a2a) {
    // And an active key behind it.
    await store.tokens.insert({ id: "k1", ownerEmail: "o@x", name: "k", prefix: "outf_x", hash: "h-k1", createdAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), kind: "a2a", a2a: { tapes: ["test-guru"], repos: ["acme/widgets"], maxConcurrent: 2 } });
  }
  const session: Session = {
    id: "s1",
    guruId: "test-guru",
    repo: "acme/widgets",
    branch: opts.a2a ? "outfitter/a2a-0123456789ab" : "feature",
    baseBranch: "main",
    ...(opts.a2a ? { origin: "a2a" as const, a2aTokenId: "k1" } : {}),
    status: "open",
    cost: 0,
    createdAt: now,
    updatedAt: now,
  };
  await app.store.sessions.insert(session);
  const run = await app.runs.wake(session.id);
  return { app, store, calls, sleeps, github, session, runId: run.id, runToken: runTokenFor(app, run.id) };
}

describe("github broker", () => {
  test("an installation token does not call GET /user for assignee @me", async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretsBroker("ghs_installation", "");
    const now = new Date().toISOString();
    await store.gurus.insert({ id: "g", name: "G", model: "p/m", createdAt: now, updatedAt: now });
    await store.sessions.insert({
      id: "s", guruId: "g", repo: "acme/widgets", branch: "feature", status: "open", cost: 0, createdAt: now, updatedAt: now, ownerEmail: "ada@example.com",
    });
    const run: Run = { id: "run", sessionId: "s", state: "running", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now };
    await store.runs.insert(run);
    const calls: Call[] = [];
    const broker = new GithubBroker(store, secrets, () => fakeGithub(calls), async () => {});
    const result = await broker.handle({ runId: "run", op: "github_issue.list", args: { assignee: "@me" } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /pass a login instead of @me/);
    assert.equal(calls.some((call) => call.route === "GET /user"), false);
  });

  test("#172: a token minted without checks:read still views a pull request; only the checks call says not permitted", async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretsBroker("ghs_no_checks", "");
    const now = new Date().toISOString();
    await store.gurus.insert({ id: "g", name: "G", model: "p/m", createdAt: now, updatedAt: now });
    await store.sessions.insert({
      id: "s", guruId: "g", repo: "acme/widgets", branch: "feature", status: "open", cost: 0, createdAt: now, updatedAt: now,
    });
    await store.runs.insert({ id: "run", sessionId: "s", state: "running", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now });
    const calls: Call[] = [];
    const base = fakeGithub(calls);
    const noChecks: GithubTransport = {
      async request(route, params) {
        if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
          calls.push({ route, params: { ...params } });
          return response(403, { message: "Resource not accessible by integration" });
        }
        return base.request(route, params);
      },
    };
    const broker = new GithubBroker(store, secrets, () => noChecks, async () => {});
    const view = await broker.handle({ runId: "run", op: "github_pr.view", args: { number: 7 } });
    assert.equal(view.ok, true, "the pull request itself still comes back");
    if (view.ok) assert.equal((view.data as { checks?: unknown }).checks, undefined);
    const checks = await broker.handle({ runId: "run", op: "github_pr.checks", args: { number: 7 } });
    assert.deepEqual(checks, { ok: false, error: "not permitted" });
  });

  test("a write replay returns the same result and does not post twice", async () => {
    const { app, calls, session, runId, runToken } = await socketApp();
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    assert.equal((await agent.nextMessage()).t, "run.spec");

    const frame = {
      t: "github.request",
      reqId: "c1",
      op: "github_pr.comment",
      args: { number: 7, body: "hello", owner: "evil", repo: "other" },
      idempotencyKey: "k1",
    };
    agent.send(frame);
    const first = await agent.nextMessage();
    agent.send({ ...frame, reqId: "c2" });
    const second = await agent.nextMessage();

    assert.equal(first.t, "github.result");
    assert.equal(first.ok, true);
    assert.equal(first.data.number, 7);
    assert.equal(first.data.url, "https://github.com/acme/widgets/issues/7#issuecomment-9");
    assert.deepEqual(first.data.rateLimit, { remaining: 4800, reset: 1700000000 });
    assert.deepEqual(second.data, first.data);
    assert.equal(second.reqId, "c2");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].route, "POST /repos/{owner}/{repo}/issues/{issue_number}/comments");
    assert.deepEqual(owners(calls), ["acme/widgets"]);
    assert.equal(calls[0].params.body, "hello\n");
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.lastAckedSeq, 0);
    assert.equal(run?.githubIdempotency?.k1?.ok, true);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("the same idempotency key replays from the store on a new broker", async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretsBroker("test-github-token", "");
    const now = new Date().toISOString();
    await store.gurus.insert({ id: "g", name: "G", model: "p/m", createdAt: now, updatedAt: now });
    await store.sessions.insert({
      id: "s", guruId: "g", repo: "acme/widgets", branch: "feature", status: "open", cost: 0, createdAt: now, updatedAt: now,
    });
    const run: Run = { id: "run", sessionId: "s", state: "running", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now };
    await store.runs.insert(run);
    const firstCalls: Call[] = [];
    const broker = new GithubBroker(store, secrets, () => fakeGithub(firstCalls), async () => {});
    const req = { runId: "run", op: "github_issue.comment", args: { number: 4, body: "note" }, idempotencyKey: "once" };
    const first = await broker.handle(req);
    assert.equal(first.ok, true);
    assert.equal(firstCalls.length, 1);

    const secondCalls: Call[] = [];
    const again = new GithubBroker(store, secrets, () => fakeGithub(secondCalls), async () => {});
    const second = await again.handle({ ...req, op: "github_issue.create", args: { title: "nope" } });
    assert.deepEqual(second, first);
    assert.equal(secondCalls.length, 0);
  });

  test("E9: an A2A task's session never merges (even on a tape that opts in) or writes to others' PRs and issues", async () => {
    const a2a = await socketApp({ a2a: true });
    const agent = await openAgentSocket(a2a.app, a2a.runId);
    sendHello(agent, a2a.runId, a2a.session.id, a2a.runToken);
    await agent.nextMessage();
    // The tape opts in after the run started (a run of a mergeFromCloud tape is refused outright).
    await a2a.store.gurus.update("test-guru", { mergeFromCloud: true });
    agent.send({ t: "github.request", reqId: "m1", op: "github_pr.merge", args: { number: 7, method: "squash", sha: SHA }, idempotencyKey: "merge-a2a" });
    assert.deepEqual(await agent.nextMessage(), { t: "github.result", reqId: "m1", ok: false, error: "not permitted" });
    // Nor reviews, edits or comments on other pull requests, nor issue writes.
    for (const [i, op] of ["github_pr.review", "github_pr.edit", "github_pr.comment", "github_issue.close", "github_issue.create"].entries()) {
      agent.send({ t: "github.request", reqId: `w${i}`, op, args: { number: 9, decision: "approve", body: "x", title: "x" }, idempotencyKey: `a2a-${i}` });
      assert.deepEqual(await agent.nextMessage(), { t: "github.result", reqId: `w${i}`, ok: false, error: "not permitted" }, op);
    }
    assert.equal(a2a.calls.length, 0);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    a2a.app.stopBackgroundTasks();
    await a2a.app.fastify.close();
  });

  test("github_pr.merge is refused unless the guru opts in, and then uses the session repo", async () => {
    const refused = await socketApp();
    const agent = await openAgentSocket(refused.app, refused.runId);
    sendHello(agent, refused.runId, refused.session.id, refused.runToken);
    await agent.nextMessage();
    agent.send({
      t: "github.request",
      reqId: "m1",
      op: "github_pr.merge",
      args: { number: 7, method: "squash", sha: SHA, owner: "evil", repo: "other" },
      idempotencyKey: "merge-1",
    });
    const denied = await agent.nextMessage();
    assert.deepEqual(denied, { t: "github.result", reqId: "m1", ok: false, error: "not permitted" });
    assert.equal(refused.calls.length, 0);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    refused.app.stopBackgroundTasks();
    await refused.app.fastify.close();

    const allowed = await socketApp({ mergeFromCloud: true });
    const live = await openAgentSocket(allowed.app, allowed.runId);
    sendHello(live, allowed.runId, allowed.session.id, allowed.runToken);
    await live.nextMessage();
    live.send({
      t: "github.request",
      reqId: "m2",
      op: "github_pr.merge",
      args: { number: 7, method: "squash", sha: SHA, owner: "evil", repo: "other" },
      idempotencyKey: "merge-2",
    });
    const merged = await live.nextMessage();
    assert.equal(merged.ok, true);
    assert.deepEqual(
      { number: merged.data.number, method: merged.data.method, sha: merged.data.sha },
      { number: 7, method: "squash", sha: SHA },
    );
    assert.ok(allowed.calls.some((c) => c.route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"));
    assert.ok(allowed.calls.every((c) => c.params.owner === "acme" && c.params.repo === "widgets"));
    live.send({ t: "bye", reason: "stop" });
    await live.nextClose();
    allowed.app.stopBackgroundTasks();
    await allowed.app.fastify.close();
  });

  test("a review thread in another repository is not permitted", async () => {
    const { app, calls, session, runId, runToken } = await socketApp();
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage();
    agent.send({
      t: "github.request",
      reqId: "th1",
      op: "github_pr.reply",
      args: { thread: "other-repo", body: "hello" },
      idempotencyKey: "thread-other",
    });
    const result = await agent.nextMessage();
    assert.equal(result.ok, false);
    assert.equal(result.error, "not permitted");
    assert.equal(calls.some((c) => String(c.params.query ?? "").includes("addPullRequestReviewThreadReply")), false);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a close that fails after the comment does not comment again on replay", async () => {
    failIssueClose = 1;
    const { app, calls, session, runId, runToken } = await socketApp();
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage();
    const request = {
      t: "github.request",
      op: "github_issue.close",
      args: { number: 4, body: "done" },
      idempotencyKey: "close-1",
    };
    agent.send({ ...request, reqId: "c1" });
    const first = await agent.nextMessage();
    assert.equal(first.ok, false);
    assert.equal(first.progress, undefined);
    const comments = () => calls.filter((c) => c.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments").length;
    assert.equal(comments(), 1);
    agent.send({ ...request, reqId: "c2" });
    const second = await agent.nextMessage();
    assert.equal(second.ok, true);
    assert.equal(second.data.state, "closed");
    assert.equal(comments(), 1);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
    failIssueClose = 0;
  });

  test("an unknown op, including wait_ci, is an error and does not call GitHub", async () => {
    const { app, calls, session, runId, runToken } = await socketApp();
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage();
    agent.send({ t: "github.request", reqId: "u1", op: "github_pr.wait_ci", args: { number: 7 } });
    const result = await agent.nextMessage();
    assert.deepEqual(result, { t: "github.result", reqId: "u1", ok: false, error: "unknown op" });
    agent.send({ t: "github.request", reqId: "u2", op: "github_pr.delete", args: {} });
    assert.equal((await agent.nextMessage()).error, "unknown op");
    assert.equal(calls.length, 0);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a differing owner and repo are ignored; view fields match the local normalizer", async () => {
    const { app, calls, session, runId, runToken } = await socketApp();
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage();
    agent.send({
      t: "github.request",
      reqId: "v1",
      op: "github_pr.view",
      args: { number: 7, owner: "evil", repo: "other", head: "attacker" },
    });
    const result = await agent.nextMessage();
    assert.equal(result.ok, true);
    assert.equal(result.data.number, 7);
    assert.equal(result.data.title, "Add tools");
    assert.equal(result.data.state, "OPEN");
    assert.equal(result.data.draft, false);
    assert.equal(result.data.sha, SHA);
    assert.equal(result.data.author, "ada");
    assert.equal(result.data.head, "feature");
    assert.equal(result.data.base, "main");
    assert.equal(result.data.review, "APPROVED");
    assert.deepEqual(result.data.checks, { passed: 1, failed: 0, pending: 0, total: 1 });
    assert.deepEqual(result.data.jobs, [{ name: "test", state: "SUCCESS", url: "https://example/check" }]);
    assert.equal(result.data.rateLimit.remaining, 4800);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => c.params.owner === undefined || c.params.owner === "acme"));
    assert.ok(calls.every((c) => c.params.repo === undefined || c.params.repo === "widgets"));
    assert.equal(calls.some((c) => c.params.owner === "evil" || c.params.repo === "other" || c.params.head === "attacker"), false);

    agent.send({ t: "github.request", reqId: "r1", op: "github_repo.view", args: { owner: "evil", repo: "other" } });
    const repo = await agent.nextMessage();
    assert.equal(repo.ok, true);
    assert.equal(repo.data.repo, "acme/widgets");
    assert.equal(repo.data.defaultBranch, "main");
    assert.equal(repo.data.permission, "WRITE");
    assert.deepEqual(repo.data.templates, []);

    agent.send({ t: "github.request", reqId: "l1", op: "github_pr.list", args: {} });
    const listed = await agent.nextMessage();
    assert.equal(listed.ok, true);
    assert.equal(listed.data.pullRequests[0].number, 7);
    assert.equal(listed.data.pullRequests[0].sha, SHA);
    assert.equal(listed.data.pullRequests[0].body, undefined);
    assert.equal(listed.data.items, undefined);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a write without an idempotency key does not call GitHub", async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretsBroker("test-github-token", "");
    const now = new Date().toISOString();
    await store.gurus.insert({ id: "g", name: "G", model: "p/m", createdAt: now, updatedAt: now });
    await store.sessions.insert({
      id: "s", guruId: "g", repo: "https://github.com/acme/widgets.git", branch: "feature", status: "open", cost: 0, createdAt: now, updatedAt: now,
    });
    await store.runs.insert({ id: "run", sessionId: "s", state: "running", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now });
    const calls: Call[] = [];
    const broker = new GithubBroker(store, secrets, () => fakeGithub(calls), async () => {});
    const missing = await broker.handle({ runId: "run", op: "github_pr.create", args: { title: "T" } });
    assert.deepEqual(missing, { ok: false, error: "idempotencyKey is required" });
    assert.equal(calls.length, 0);
    const created = await broker.handle({
      runId: "run", op: "github_pr.create", idempotencyKey: "c", args: { title: "T", summary: "S", owner: "nope", repo: "nope" },
    });
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.equal(created.data.template, null);
      assert.equal(created.data.url, "https://github.com/acme/widgets/pull/7");
    }
    const post = calls.find((c) => c.route === "POST /repos/{owner}/{repo}/pulls");
    assert.equal(post?.params.owner, "acme");
    assert.equal(post?.params.repo, "widgets");
    assert.equal(post?.params.head, "feature");
    assert.match(String(post?.params.body), /## Summary\n\nS/);
  });

  test("backoff sleeps at most a few seconds when the budget is empty", async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretsBroker("test-github-token", "");
    const now = new Date().toISOString();
    await store.gurus.insert({ id: "g", name: "G", model: "p/m", createdAt: now, updatedAt: now });
    await store.sessions.insert({
      id: "s", guruId: "g", repo: "acme/widgets", branch: "feature", status: "open", cost: 0, createdAt: now, updatedAt: now,
    });
    await store.runs.insert({ id: "run", sessionId: "s", state: "running", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now });
    const sleeps: number[] = [];
    let remaining = "0";
    const transport: GithubTransport = {
      async request(route) {
        if (route.startsWith("GET /repos/{owner}/{repo}/contents/")) {
          return response(404, { message: "Not Found" }, { "x-ratelimit-remaining": remaining, "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 10_000) });
        }
        return response(200, {
          full_name: "acme/widgets", html_url: "https://github.com/acme/widgets", default_branch: "main", permissions: { pull: true },
        }, { "x-ratelimit-remaining": remaining, "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 10_000) });
      },
    };
    const broker = new GithubBroker(store, secrets, () => transport, async (ms) => {
      sleeps.push(ms);
    });
    await broker.handle({ runId: "run", op: "github_repo.view", args: {} });
    assert.deepEqual(sleeps, []);
    remaining = "0";
    await broker.handle({ runId: "run", op: "github_repo.view", args: {} });
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0]! <= 3000);
    assert.ok(sleeps[0]! > 0);
  });

  test("an empty token is not permitted and is not sent anywhere", async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretsBroker("", "");
    const now = new Date().toISOString();
    await store.gurus.insert({ id: "g", name: "G", model: "p/m", mergeFromCloud: true, createdAt: now, updatedAt: now });
    await store.sessions.insert({
      id: "s", guruId: "g", repo: "acme/widgets", branch: "feature", status: "open", cost: 0, createdAt: now, updatedAt: now,
    });
    await store.runs.insert({ id: "run", sessionId: "s", state: "running", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now });
    let built = 0;
    const broker = new GithubBroker(store, secrets, () => {
      built++;
      return fakeGithub([]);
    }, async () => {});
    const result = await broker.handle({ runId: "run", op: "github_repo.view", args: {} });
    assert.deepEqual(result, { ok: false, error: "not permitted" });
    assert.equal(built, 0);
  });

  test("#158: an App mint failure fails that one request with a reason, and nothing is sent", async () => {
    for (const [failure, error] of [
      ["unavailable", "the GitHub App could not get a token just now; try again shortly"],
      ["not-installed", "the Outfitter GitHub App's installation doesn't cover this repository"],
      ["permissions-missing", "the Outfitter GitHub App is missing a permission runs need; an owner has to grant it"],
      ["rejected", "GitHub refused the Outfitter GitHub App's token request; an operator has to check the App"],
    ] as const) {
      const store = new MemoryStore();
      const secrets = {
        async secretsForRun() {
          return { githubToken: "", litellmKey: "", githubAppFailure: failure };
        },
        async defaultLitellmKey() {
          return "";
        },
      };
      const now = new Date().toISOString();
      await store.gurus.insert({ id: "g", name: "G", model: "p/m", createdAt: now, updatedAt: now });
      await store.sessions.insert({
        id: "s", guruId: "g", repo: "acme/widgets", branch: "feature", status: "open", cost: 0, createdAt: now, updatedAt: now,
      });
      await store.runs.insert({ id: "run", sessionId: "s", state: "running", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now });
      let built = 0;
      const broker = new GithubBroker(store, secrets, () => {
        built++;
        return fakeGithub([]);
      }, async () => {});
      const result = await broker.handle({ runId: "run", op: "github_repo.view", args: {} });
      assert.deepEqual(result, { ok: false, error }, failure);
      assert.equal(built, 0, failure);
    }
  });

  test("#160: brokerGithubToken is what gets sent, not the drive token from secretsForRun", async () => {
    const store = new MemoryStore();
    const secrets = {
      async secretsForRun() {
        return { githubToken: "drive-token", litellmKey: "" };
      },
      async brokerGithubToken() {
        return { token: "broker-token" };
      },
      async defaultLitellmKey() {
        return "";
      },
    };
    const now = new Date().toISOString();
    await store.gurus.insert({ id: "g", name: "G", model: "p/m", createdAt: now, updatedAt: now });
    await store.sessions.insert({
      id: "s", guruId: "g", repo: "acme/widgets", branch: "feature", status: "open", cost: 0, createdAt: now, updatedAt: now,
    });
    await store.runs.insert({ id: "run", sessionId: "s", state: "running", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now });
    let seen = "";
    const broker = new GithubBroker(store, secrets, (token) => {
      seen = token;
      return fakeGithub([]);
    }, async () => {});
    const result = await broker.handle({ runId: "run", op: "github_repo.view", args: {} });
    assert.equal(result.ok, true);
    assert.equal(seen, "broker-token");
  });

  test("rate-limit headers are read from either a plain object or a Headers instance", () => {
    assert.deepEqual(rateLimitFromHeaders(headerMap({ "X-RateLimit-Remaining": "12", "X-RateLimit-Reset": "99" })), { remaining: 12, reset: 99 });
    const headers = new Headers({ "X-RateLimit-Remaining": "3", "X-RateLimit-Reset": "50" });
    assert.deepEqual(rateLimitFromHeaders(headerMap(headers)), { remaining: 3, reset: 50 });
    assert.equal(rateLimitFromHeaders({}), undefined);
  });

  test("merge is refused when the head moved, without merging", async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretsBroker("test-github-token", "");
    const now = new Date().toISOString();
    await store.gurus.insert({ id: "g", name: "G", model: "p/m", mergeFromCloud: true, createdAt: now, updatedAt: now });
    await store.sessions.insert({
      id: "s", guruId: "g", repo: "acme/widgets", branch: "feature", status: "open", cost: 0, createdAt: now, updatedAt: now,
    });
    await store.runs.insert({ id: "run", sessionId: "s", state: "running", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now });
    const calls: Call[] = [];
    const transport: GithubTransport = {
      async request(route, params) {
        calls.push({ route, params });
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return response(200, pull(params, SHA_B));
        return response(500, { message: "should not merge" });
      },
    };
    const broker = new GithubBroker(store, secrets, () => transport, async () => {});
    const result = await broker.handle({
      runId: "run", op: "github_pr.merge", idempotencyKey: "m", args: { number: 7, method: "squash", sha: SHA },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, new RegExp(`moved from ${SHA} to ${SHA_B}`));
    assert.equal(calls.some((c) => c.route.includes("merge")), false);
  });
});
