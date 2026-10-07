// #503 Auto-fix CI: the per-floppy switch (PUT /api/sessions/:id/autofix), the watcher that sends
// the agent one message per failed pull request head, its multi-instance claim and daily cap.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory.ts";
import { generateToken, hashToken, tokenPrefix } from "../src/tokens.ts";
import {
  AUTOFIX_MAX_CHARS,
  AUTOFIX_POLL_MS,
  AUTOFIX_SETTLE_MS,
  AutofixWatcher,
  type AutofixGithub,
} from "../src/autofix.ts";
import type { GithubBroker, SessionCheck, SessionPrStatus, SessionPullState } from "../src/github-broker.ts";
import { mailIdFor } from "../src/mail.ts";
import type { Session, Store } from "../src/store/types.ts";
import { buildTestApp } from "./helpers.ts";
import { TEST_IAP_AUDIENCE } from "./device-iap.ts";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const T0 = Date.parse("2026-10-07T12:00:00.000Z");

function check(overrides: Partial<SessionCheck> & { name: string }): SessionCheck {
  return {
    id: String(100 + overrides.name.length),
    kind: "check-run",
    status: "completed",
    conclusion: "success",
    state: "pass",
    startedAt: "2026-10-07T11:50:00Z",
    completedAt: "2026-10-07T11:55:00Z",
    detailsUrl: `https://github.com/acme/widgets/actions/runs/5/job/${overrides.name}`,
    hasLog: true,
    ...overrides,
  };
}

const failing = (name: string, id: string) => check({ name, id, conclusion: "failure", state: "fail" });

function pr(checks: SessionCheck[], sha = SHA): SessionPullState {
  const failed = checks.filter((c) => c.state === "fail").length;
  const pending = checks.filter((c) => c.state === "running").length;
  return {
    number: 7,
    url: "https://github.com/acme/widgets/pull/7",
    title: "Add widgets",
    draft: false,
    base: "main",
    headSha: sha,
    checks,
    checkSummary: {
      passed: checks.length - failed - pending,
      failed,
      pending,
      total: checks.length,
      state: failed ? "fail" : pending ? "pending" : checks.length ? "pass" : "none",
    },
    review: "none",
    mergeable: true,
    mergeableState: "clean",
  };
}

/** A scripted broker: `status` is what the next read returns. */
function fakeGithub(initial: SessionPrStatus) {
  const state = { status: initial, statusReads: 0, logReads: [] as string[], log: (id: string) => `step 1\nstep 2\nError in ${id}: expected 1 to equal 2` };
  const github: AutofixGithub = {
    async sessionPrStatus() {
      state.statusReads++;
      return state.status;
    },
    async sessionCheckLog(_session, checkId) {
      state.logReads.push(checkId);
      return { ok: true, data: { id: checkId, name: checkId, conclusion: "failure", detailsUrl: null, log: state.log(checkId), truncated: false } };
    },
  };
  return { state, github };
}

async function seed(store: Store, overrides: Partial<Session> = {}): Promise<Session> {
  const session: Session = {
    id: "s1",
    guruId: "test-guru",
    repo: "acme/widgets",
    branch: "feature",
    baseBranch: "main",
    ownerEmail: "owner@example.com",
    status: "open",
    cost: 0,
    autofixCi: true,
    createdAt: new Date(T0 - 3_600_000).toISOString(),
    updatedAt: new Date(T0 - 3_600_000).toISOString(),
    ...overrides,
  };
  await store.sessions.insert(session);
  return session;
}

function watcher(store: Store, github: AutofixGithub, clock: { now: number }) {
  const posts: { sessionId: string; mailId: string; text: string }[] = [];
  const w = new AutofixWatcher({
    store,
    github,
    now: () => clock.now,
    post: async (sessionId, mailId, text) => {
      posts.push({ sessionId, mailId, text });
    },
  });
  return { w, posts };
}

describe("#503 Auto-fix CI watcher", () => {
  test("a failed head gets one message with the check names and log tails, then nothing more for that sha", async () => {
    const store = new MemoryStore();
    await seed(store);
    const { state, github } = fakeGithub({ mergeAllowed: false, pr: pr([failing("test", "201"), failing("lint", "202"), check({ name: "build" })]) });
    const clock = { now: T0 };
    const { w, posts } = watcher(store, github, clock);

    const first = await w.sweep();
    assert.deepEqual(first, { checked: 1, sent: ["s1"], capped: [] });
    assert.equal(posts.length, 1);
    const text = posts[0]!.text;
    assert.match(text, /^Auto-fix: CI failed on #7 \(test, lint\) at aaaaaaa\. Fix it and push\.\n\ntest:\n```\n/);
    assert.match(text, /Error in 201: expected 1 to equal 2\n```/);
    assert.match(text, /lint:\n```\nstep 1/);
    assert.ok(!text.includes("build"), "passing checks aren't named");
    assert.deepEqual(state.logReads, ["201", "202"]);

    const view = (await store.sessions.findById("s1"))!.autofix!;
    assert.equal(view.lastSha, SHA);
    assert.deepEqual(view.lastChecks, ["test", "lint"]);

    // Within the poll interval: not even a read.
    clock.now += 10_000;
    await w.sweep();
    assert.equal(state.statusReads, 1);
    // After it: read, same sha, no second message.
    clock.now += AUTOFIX_POLL_MS;
    await w.sweep();
    assert.equal(state.statusReads, 2);
    assert.equal(posts.length, 1);

    // A new push that fails again: a second message.
    state.status = { mergeAllowed: false, pr: pr([failing("test", "201")], SHA2) };
    clock.now += AUTOFIX_POLL_MS;
    await w.sweep();
    assert.equal(posts.length, 2);
    assert.match(posts[1]!.text, /at bbbbbbb\./);
    assert.notEqual(posts[0]!.mailId, posts[1]!.mailId);
  });

  test("two instances racing for one session: only one reads GitHub and only one sends", async () => {
    const store = new MemoryStore();
    await seed(store);
    const { state, github } = fakeGithub({ mergeAllowed: false, pr: pr([failing("test", "201")]) });
    const clock = { now: T0 };
    const a = watcher(store, github, clock);
    const b = watcher(store, github, clock);
    const [ra, rb] = await Promise.all([a.w.sweep(), b.w.sweep()]);
    assert.equal(a.posts.length + b.posts.length, 1);
    assert.equal(ra.sent.length + rb.sent.length, 1);
    assert.equal(state.statusReads, 1);

    // Both instances read the session as due for a poll at once: the conditional write lets one through.
    const session = (await store.sessions.findById("s1"))!;
    const stale = { ...session, autofix: { rev: session.autofix!.rev, polledAt: new Date(T0 - 2 * AUTOFIX_POLL_MS).toISOString() } };
    await store.sessions.casAutofix("s1", session.autofix!.rev, { ...stale.autofix, rev: session.autofix!.rev + 1 });
    const fresh = (await store.sessions.findById("s1"))!;
    clock.now += AUTOFIX_POLL_MS;
    const outcomes = await Promise.all([a.w.checkSession(fresh), b.w.checkSession(fresh)]);
    assert.deepEqual(outcomes.sort(), ["claimed-elsewhere", "sent"]);
    assert.equal(a.posts.length + b.posts.length, 2);
  });

  test("passing, pending, no pull request, a read error, and still-running checks send nothing", async () => {
    const store = new MemoryStore();
    await seed(store);
    const { state, github } = fakeGithub({ mergeAllowed: false, pr: pr([check({ name: "test" })]) });
    const clock = { now: T0 };
    const { w, posts } = watcher(store, github, clock);
    const step = async (status: SessionPrStatus) => {
      state.status = status;
      clock.now += AUTOFIX_POLL_MS;
      return w.checkSession((await store.sessions.findById("s1"))!);
    };
    assert.equal(await step({ mergeAllowed: false, pr: pr([check({ name: "test" })]) }), "passing");
    assert.equal(await step({ mergeAllowed: false, pr: pr([check({ name: "test", state: "running", status: "in_progress", conclusion: null, completedAt: null })]) }), "pending");
    assert.equal(await step({ mergeAllowed: false, pr: null }), "no-pr");
    assert.equal(await step({ mergeAllowed: false, pr: null, prError: "rate limited" }), "pr-error");
    // A failure while another check runs waits for it, unless the failure is old enough.
    const recentFail = failing("test", "201");
    recentFail.completedAt = new Date(clock.now).toISOString();
    const running = check({ name: "e2e", state: "running", status: "in_progress", conclusion: null, completedAt: null });
    assert.equal(await step({ mergeAllowed: false, pr: pr([recentFail, running]) }), "pending");
    assert.equal(posts.length, 0);
    clock.now += AUTOFIX_SETTLE_MS;
    assert.equal(await step({ mergeAllowed: false, pr: pr([recentFail, running]) }), "sent");
    assert.equal(posts.length, 1);
  });

  test("archived, switched off, or repo-less sessions aren't watched", async () => {
    const store = new MemoryStore();
    await seed(store, { id: "archived", archivedAt: "2026-10-07T00:00:00.000Z" });
    await seed(store, { id: "off", autofixCi: false });
    await seed(store, { id: "never" , autofixCi: undefined });
    await seed(store, { id: "chat", repo: null, branch: undefined });
    await seed(store, { id: "stale", updatedAt: new Date(T0 - 8 * 24 * 3_600_000).toISOString() });
    const { state, github } = fakeGithub({ mergeAllowed: false, pr: pr([failing("test", "201")]) });
    const { w, posts } = watcher(store, github, { now: T0 });
    const result = await w.sweep();
    assert.deepEqual(result, { checked: 0, sent: [], capped: [] });
    assert.equal(state.statusReads, 0);
    assert.equal(posts.length, 0);
    // A session archived after it was listed: the claim refuses it.
    const live = await seed(store, { id: "live" });
    await store.sessions.setArchivedAt("live", "2026-10-07T00:00:00.000Z");
    assert.equal(await w.checkSession(live), "claimed-elsewhere");
  });

  test("at most 3 messages a day; then a notice, and turning it on again resumes", async () => {
    const store = new MemoryStore();
    await seed(store);
    const { state, github } = fakeGithub({ mergeAllowed: false, pr: null });
    const clock = { now: T0 };
    const { w, posts } = watcher(store, github, clock);
    for (let i = 0; i < 4; i++) {
      state.status = { mergeAllowed: false, pr: pr([failing("test", "201")], String(i).repeat(40)) };
      clock.now += AUTOFIX_POLL_MS;
      await w.sweep();
    }
    assert.equal(posts.length, 3);
    const { autofixView } = await import("../src/autofix.ts");
    const capped = autofixView((await store.sessions.findById("s1"))!, clock.now);
    assert.equal(capped.capped, true);
    assert.match(capped.notice!, /Auto-fix paused/);
    assert.equal(capped.lastSha, "2".repeat(40));

    // The owner turns it on again: the cap is lifted, the last sha kept.
    const resumed = (await store.sessions.setAutofixCi("s1", true))!;
    assert.equal(autofixView(resumed, clock.now).capped, undefined);
    clock.now += AUTOFIX_POLL_MS;
    await w.sweep();
    assert.equal(posts.length, 4);

    // A day later the window frees by itself.
    state.status = { mergeAllowed: false, pr: pr([failing("test", "201")], "9".repeat(40)) };
    clock.now += 25 * 3_600_000;
    await w.sweep();
    assert.equal(posts.length, 5);
  });

  test("long logs are cut so the message stays under about 8 KB, and a log can't close its fence", async () => {
    const store = new MemoryStore();
    await seed(store);
    const { state, github } = fakeGithub({ mergeAllowed: false, pr: pr([failing("test", "201"), failing("lint", "202"), check({ name: "circle", id: "status:circle", kind: "status", state: "fail", hasLog: false })]) });
    state.log = (id) => `${"x".repeat(100)}\n`.repeat(200) + `\`\`\`\nlast line of ${id}`;
    const { w, posts } = watcher(store, github, { now: T0 });
    await w.sweep();
    const text = posts[0]!.text;
    assert.ok(text.length <= AUTOFIX_MAX_CHARS, `${text.length} chars`);
    assert.match(text, /last line of 201\n````/);
    assert.match(text, /last line of 202\n````/);
    assert.match(text, /circle: no log here \(https:\/\/github\.com\/acme\/widgets\/actions\/runs\/5\/job\/circle\)\./);
    assert.deepEqual(state.logReads, ["201", "202"]);
  });

  test("a failed post gives the sha back so the next poll tries again", async () => {
    const store = new MemoryStore();
    await seed(store);
    const { github } = fakeGithub({ mergeAllowed: false, pr: pr([failing("test", "201")]) });
    const clock = { now: T0 };
    let fail = true;
    const sent: string[] = [];
    const w = new AutofixWatcher({
      store,
      github,
      now: () => clock.now,
      post: async (_sessionId, _mailId, text) => {
        if (fail) throw new Error("mongo down");
        sent.push(text);
      },
    });
    await assert.rejects(w.checkSession((await store.sessions.findById("s1"))!));
    assert.equal((await store.sessions.findById("s1"))!.autofix!.lastSha, undefined);
    fail = false;
    clock.now += AUTOFIX_POLL_MS;
    assert.equal(await w.checkSession((await store.sessions.findById("s1"))!), "sent");
    assert.equal(sent.length, 1);
  });
});

/** An `outf_` bearer for `email`, inserted straight into the store. */
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

describe("#503 PUT /api/sessions/:id/autofix", () => {
  test("only the owner (or a sysop) may switch it; GET shows it", async () => {
    const store = new MemoryStore();
    const app = await buildTestApp({ OUTFITTER_DEV: "0", OUTFITTER_OPERATORS: "sysop@example.com", IAP_AUDIENCE: TEST_IAP_AUDIENCE }, { store });
    await seed(store, { autofixCi: undefined });
    const put = async (headers: Record<string, string>, on: unknown) =>
      app.fastify.inject({ method: "PUT", url: "/api/sessions/s1/autofix", headers, payload: { on } });

    const other = await put(await bearerFor(store, "someone@example.com"), true);
    assert.equal(other.statusCode, 403);
    assert.equal((await store.sessions.findById("s1"))!.autofixCi, undefined);

    const owner = await bearerFor(store, "owner@example.com");
    assert.equal((await put(owner, "yes")).statusCode, 400);
    const on = await put(owner, true);
    assert.equal(on.statusCode, 200);
    assert.deepEqual(on.json(), { autofixCi: true, autofix: { on: true } });

    const detail = (await app.fastify.inject({ method: "GET", url: "/api/sessions/s1", headers: owner })).json();
    assert.equal(detail.autofixCi, true);
    assert.deepEqual(detail.autofix, { on: true });

    const off = await put(owner, false);
    assert.deepEqual(off.json(), { autofixCi: false, autofix: { on: false } });
    await app.fastify.close();
  });

  test("an archived or repo-less floppy can't be switched on; GET hides the watcher's bookkeeping", async () => {
    const app = await buildTestApp();
    await seed(app.store, { id: "shelved", autofixCi: undefined, archivedAt: "2026-10-07T00:00:00.000Z" });
    await seed(app.store, { id: "chat", autofixCi: undefined, repo: null, branch: undefined });
    await seed(app.store, {
      id: "s1",
      autofix: { rev: 4, polledAt: "2026-10-07T12:00:00.000Z", lastSha: SHA, lastAt: "2026-10-07T12:00:00.000Z", lastPr: 7, lastChecks: ["test"], sends: ["2026-10-07T12:00:00.000Z"] },
    });
    const put = (id: string, on: boolean) => app.fastify.inject({ method: "PUT", url: `/api/sessions/${id}/autofix`, payload: { on } });
    assert.equal((await put("shelved", true)).statusCode, 409);
    assert.equal((await put("shelved", false)).statusCode, 200);
    assert.equal((await put("chat", true)).statusCode, 409);
    const detail = (await app.fastify.inject({ method: "GET", url: "/api/sessions/s1" })).json();
    assert.deepEqual(detail.autofix, { on: true, lastSha: SHA, lastAt: "2026-10-07T12:00:00.000Z", lastPr: 7, lastChecks: ["test"] });
    assert.equal("sends" in detail, false);
    assert.equal(detail.autofix.polledAt, undefined);
    await app.fastify.close();
  });

  test("the tick sends the message as mail from `system`, waking the Drive like a person's message", async () => {
    const { state, github } = fakeGithub({ mergeAllowed: false, pr: pr([failing("test", "201")]) });
    const app = await buildTestApp({}, { github: github as unknown as GithubBroker });
    await seed(app.store, { updatedAt: new Date().toISOString() });
    const tick = await app.fastify.inject({ method: "POST", url: "/api/hooks/tick", headers: { authorization: "Bearer test-agent-token" } });
    assert.equal(tick.statusCode, 200);
    assert.deepEqual(tick.json().autofix, { checked: 1, sent: ["s1"], capped: [] });
    assert.equal(state.statusReads, 1);
    const rev = (await app.store.sessions.findById("s1"))!.autofix!.rev;
    const mail = await app.store.mail.findById(mailIdFor("s1", SHA, `autofix:${rev}`));
    assert.ok(mail);
    assert.deepEqual(mail.from, { kind: "system" });
    assert.match(mail.text, /^Auto-fix: CI failed on #7 \(test\) at aaaaaaa\./);
    assert.ok(await app.store.runs.findActiveForSession("s1"), "the mail woke a run");
    // A second tick: same sha, nothing more.
    await app.fastify.inject({ method: "POST", url: "/api/hooks/tick", headers: { authorization: "Bearer test-agent-token" } });
    assert.equal((await app.store.sessions.findById("s1"))!.autofix!.rev, rev);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});
