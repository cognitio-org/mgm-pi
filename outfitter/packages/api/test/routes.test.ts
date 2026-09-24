import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedGuru } from "./helpers.ts";
import { GITHUB_APP_ID_SECRET, GITHUB_APP_INSTALLATION_SECRET, GITHUB_APP_KEY_SECRET, GITHUB_APP_SLUG_SECRET } from "../src/github-app.ts";

describe("POST /api/sessions", () => {
  test("creates a session, wakes a queued->provisioning run, and calls the provider", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);

    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "hello" },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.session.status, "open");
    assert.equal(body.run.state, "provisioning");
    assert.equal(app.provider.startCalls.length, 1);
    assert.equal(app.provider.startCalls[0].runId, body.run.id);

    await app.fastify.close();
  });

  test("400s on an unknown guruId", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "nope", repo: "o/r", prompt: "hello" },
    });
    assert.equal(res.statusCode, 400);
    await app.fastify.close();
  });

  test("creates and wakes a non-coding session when repo is omitted", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);

    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", prompt: "just think about this" },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.session.repo, null);
    assert.equal(body.session.branch, undefined);
    assert.equal(body.run.state, "provisioning");
    assert.equal(app.provider.startCalls.length, 1); // wake() still ran despite no repo

    await app.fastify.close();
  });
});

describe("GET /api/sessions/:id", () => {
  test("includes runState from the active run, falling back to the latest run once none is active", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);

    const createRes = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "hello" },
    });
    const { session } = createRes.json();

    const getRes = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.json().runState, "provisioning");
    // Still the full Session shape underneath (used by teleport's OutfitterStore to build a manifest).
    assert.equal(getRes.json().id, session.id);
    assert.equal(getRes.json().repo, "o/r");
    assert.equal(getRes.json().github.repo, "o/r");
    assert.equal(getRes.json().github.credential, "none");
    assert.equal(getRes.json().github.merge, false);
    assert.equal(getRes.json().github.onBehalfOf, null);

    const pem = "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----";
    await app.secretAdmin.addVersion(GITHUB_APP_ID_SECRET, "42");
    await app.secretAdmin.addVersion(GITHUB_APP_KEY_SECRET, pem);
    await app.secretAdmin.addVersion(GITHUB_APP_INSTALLATION_SECRET, "7");
    await app.secretAdmin.addVersion(GITHUB_APP_SLUG_SECRET, "outfitter");
    const asApp = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    assert.equal(asApp.json().github.credential, "app");
    assert.equal(asApp.json().github.appSlug, "outfitter");
    assert.equal(asApp.body.includes(pem), false);
    assert.equal(asApp.body.includes("not-a-real-key"), false);

    await app.fastify.inject({ method: "POST", url: `/api/sessions/${session.id}/abort` });
    const afterAbortRun = await app.store.runs.findActiveForSession(session.id);
    await app.store.runs.update(afterAbortRun!.id, { state: "stopped" });

    // Not undefined any more: the run that just ended is what this session's state actually is, and
    // reporting nothing made a run the api refused indistinguishable from a clean stop -- see
    // routes/sessions.ts's reportableRun. Consumers that care about liveness (kernal's teleport
    // OutfitterStore, packages/web's desk and send-status) test against their own active-state set.
    const getAfter = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    assert.equal(getAfter.json().runState, "stopped");
    assert.equal(getAfter.json().runStateReason, undefined, "only a failed run explains itself");

    await app.fastify.close();
  });

  test("a failed run reports its state and its statusDetail, for the Drives list and the pill", async () => {
    // The incident this came from (agentlink.ts's refuse()): a run the api refused used to leave the
    // session's runState undefined, which the Disk Box list renders as the "stopped" pill -- and
    // `?runState=failed`, an option in that list's own filter, could never match anything.
    const app = await buildTestApp();
    await seedGuru(app.store);

    const createRes = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "hello" },
    });
    const { session } = createRes.json();
    const run = await app.store.runs.findActiveForSession(session.id);
    await app.store.runs.update(run!.id, {
      state: "failed",
      reason: "missing github token secret for session " + session.id,
      statusDetail: "no GitHub token is stored for this session, so its sandbox can't clone the repo.",
    });

    const detail = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    assert.equal(detail.json().runState, "failed");
    assert.match(detail.json().runStateReason, /no GitHub token is stored/);

    const failed = await app.fastify.inject({ method: "GET", url: "/api/sessions?runState=failed" });
    const rows = failed.json() as Array<{ id: string; runState?: string; runStateReason?: string }>;
    const row = rows.find((s) => s.id === session.id);
    assert.ok(row, "the list's own failed filter has to be able to match a failed run");
    assert.equal(row!.runState, "failed");
    // The full note, not the 123-byte-capped close reason, so the list row reads like a sentence.
    assert.match(row!.runStateReason ?? "", /no GitHub token is stored/);

    await app.fastify.close();
  });

  test("#132: allowExternalHtmlResources is the run's copy once it has one, the Tape's until then", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { allowExternalHtmlResources: true });
    const createRes = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "hello" },
    });
    const { session } = createRes.json();
    const detail = () => app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });

    // No run.spec built yet, so nothing is recorded on the run: the next run gets the Tape's value.
    assert.equal((await detail()).json().allowExternalHtmlResources, true);

    // The run was started sealed; the Tape being on now must not change what it reports.
    const run = await app.store.runs.findActiveForSession(session.id);
    await app.store.runs.update(run!.id, { allowExternalHtmlResources: false });
    assert.equal((await detail()).json().allowExternalHtmlResources, false);

    await app.store.runs.update(run!.id, { state: "stopped" });
    assert.equal((await detail()).json().allowExternalHtmlResources, false, "a stopped run still matches its prompt");
    await app.fastify.close();
  });

  test("#132: allowExternalHtmlResources is false for a sealed Tape", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);
    const createRes = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "hello" },
    });
    const res = await app.fastify.inject({ method: "GET", url: `/api/sessions/${createRes.json().session.id}` });
    assert.equal(res.json().allowExternalHtmlResources, false);
    await app.fastify.close();
  });

  test("#147: htmlPreviewAccessByRun maps each run that recorded a value, and leaves out the rest", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);
    const createRes = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "hello" },
    });
    const { session } = createRes.json();
    const first = await app.store.runs.findActiveForSession(session.id);
    const detail = () => app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });

    assert.deepEqual((await detail()).json().htmlPreviewAccessByRun, {}, "no run.spec built yet");

    await app.store.runs.update(first!.id, { allowExternalHtmlResources: false, state: "stopped" });
    const now = new Date(Date.now() + 1000).toISOString();
    await app.store.runs.insert({
      id: "second-run",
      sessionId: session.id,
      state: "running",
      lastAckedSeq: 0,
      pending: [],
      allowExternalHtmlResources: true,
      createdAt: now,
      updatedAt: now,
    });
    const body = (await detail()).json();
    assert.deepEqual(body.htmlPreviewAccessByRun, { [first!.id]: false, "second-run": true });
    assert.equal(body.allowExternalHtmlResources, true, "the session-wide value still follows the reportable run");
    await app.fastify.close();
  });

  test("#147: an entry the api wrote itself goes out without outfitterRunId", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);
    const createRes = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "hello" },
    });
    const { session } = createRes.json();
    await app.store.entries.insertIfNew(session.id, 1, { id: "capture", parentId: null, type: "custom" });
    const res = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}/entries` });
    assert.deepEqual(res.json(), [{ id: "capture", parentId: null, type: "custom" }]);
    await app.fastify.close();
  });
});

describe("GET /api/sessions?runState=", () => {
  // Code review M1 (docs/reports/code-review-pr15.md): `runState` filters on the computed
  // per-run state (queued/provisioning/running/...), distinct from `status` (open/closed) which
  // the store filters on directly.
  test("filters post-hoc on the computed runState, not Session.status", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);

    const createRes = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "hello" },
    });
    const { session } = createRes.json();

    const provisioning = await app.fastify.inject({ method: "GET", url: "/api/sessions?runState=provisioning" });
    assert.equal(provisioning.statusCode, 200);
    const provisioningIds = provisioning.json().map((s: { id: string }) => s.id);
    assert.ok(provisioningIds.includes(session.id));

    const running = await app.fastify.inject({ method: "GET", url: "/api/sessions?runState=running" });
    assert.equal(running.statusCode, 200);
    assert.deepEqual(running.json(), []);

    // status ("open"/"closed") still works unfiltered by runState.
    const all = await app.fastify.inject({ method: "GET", url: "/api/sessions" });
    assert.equal(all.statusCode, 200);
    assert.ok(all.json().some((s: { id: string }) => s.id === session.id));

    await app.fastify.close();
  });
});

describe("browser messages go through the mailbox", () => {
  test("the initial prompt and a follow-up message are both stored as queued mail for the session", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);

    const createRes = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "first" },
    });
    assert.equal(createRes.statusCode, 201);
    const { session, run } = createRes.json();
    assert.ok(run.id);

    const messageRes = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: { text: "second" },
    });
    assert.equal(messageRes.statusCode, 200);
    assert.equal(messageRes.json().run.id, run.id, "the second message reuses the active run");

    const now = new Date().toISOString();
    const first = await app.store.mail.claimNext(session.id, run.id, now, now, 5);
    const second = await app.store.mail.claimNext(session.id, run.id, now, now, 5);
    assert.deepEqual([first?.text, second?.text], ["first", "second"]);
    assert.equal(second?.behavior, "followUp");
    assert.equal(second?.from.kind, "user");
    assert.equal((await app.store.runs.findById(run.id))?.pending.length, 0);

    await app.fastify.close();
  });
});

describe("export.jsonl / import round trip", () => {
  test("exported JSONL re-imports into a fresh session with the same entries", async () => {
    const app = await buildTestApp();
    const now = new Date().toISOString();
    await app.store.sessions.insert({
      id: "session-a",
      guruId: "test-guru",
      repo: "o/r",
      branch: "main",
      status: "open",
      cost: 0,
      createdAt: now,
      updatedAt: now,
    });
    await app.store.entries.insertIfNew("session-a", 1, { id: "e1", parentId: null, type: "message" });
    await app.store.entries.insertIfNew("session-a", 2, { id: "e2", parentId: "e1", type: "message" });

    const exportRes = await app.fastify.inject({ method: "GET", url: "/api/sessions/session-a/export.jsonl" });
    assert.equal(exportRes.statusCode, 200);
    const jsonl = exportRes.body;
    const lines = jsonl.trim().split("\n");
    assert.equal(lines.length, 3); // header + 2 entries
    assert.equal(JSON.parse(lines[0]).type, "session");

    const importedId = "session-a"; // same id, into an empty store this time
    const freshApp = await buildTestApp();
    const importRes = await freshApp.fastify.inject({
      method: "PUT",
      url: `/api/sessions/${importedId}/import`,
      headers: { "content-type": "application/x-ndjson" },
      payload: jsonl,
    });
    assert.equal(importRes.statusCode, 200);
    assert.equal(importRes.json().imported, 2);

    const reExport = await freshApp.fastify.inject({ method: "GET", url: `/api/sessions/${importedId}/export.jsonl` });
    const reLines = reExport.body.trim().split("\n");
    assert.equal(reLines.length, 3);
    assert.deepEqual(JSON.parse(reLines[1]), { id: "e1", parentId: null, type: "message" });
    assert.deepEqual(JSON.parse(reLines[2]), { id: "e2", parentId: "e1", type: "message" });

    await app.fastify.close();
    await freshApp.fastify.close();
  });

  test("import is refused with 409 while a run is active", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);
    const createRes = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "hi" },
    });
    const { session } = createRes.json();

    const header = JSON.stringify({ type: "session", version: 3, id: session.id, cwd: "/workspace" });
    const importRes = await app.fastify.inject({
      method: "PUT",
      url: `/api/sessions/${session.id}/import`,
      headers: { "content-type": "application/x-ndjson" },
      payload: header + "\n",
    });
    assert.equal(importRes.statusCode, 409);

    await app.fastify.close();
  });

  test("import headers set repo, branch, base, and checkpoint", async () => {
    const app = await buildTestApp();
    const id = "session-teleport";
    const head = "0123456789abcdef0123456789abcdef01234567";
    const header = JSON.stringify({ type: "session", version: 3, id, cwd: "/tmp" });
    const entry = JSON.stringify({ id: "e1", parentId: null, type: "message" });
    const res = await app.fastify.inject({
      method: "PUT",
      url: `/api/sessions/${id}/import`,
      headers: {
        "content-type": "application/x-ndjson",
        "x-outfitter-repo": "acme/widgets",
        "x-outfitter-branch": "feature",
        "x-outfitter-base": "develop",
        "x-outfitter-head": head,
      },
      payload: `${header}\n${entry}\n`,
    });
    assert.equal(res.statusCode, 200);
    const session = await app.store.sessions.findById(id);
    assert.equal(session?.repo, "acme/widgets");
    assert.equal(session?.branch, "feature");
    assert.equal(session?.baseBranch, "develop");
    assert.deepEqual(session?.checkpoint, { branch: "feature", head });
    await app.fastify.close();
  });

  test("import without repo headers leaves repo null and sets no checkpoint", async () => {
    const app = await buildTestApp();
    const id = "session-plain";
    const header = JSON.stringify({ type: "session", version: 3, id, cwd: "/tmp" });
    const res = await app.fastify.inject({
      method: "PUT",
      url: `/api/sessions/${id}/import`,
      headers: { "content-type": "application/x-ndjson" },
      payload: `${header}\n`,
    });
    assert.equal(res.statusCode, 200);
    const session = await app.store.sessions.findById(id);
    assert.equal(session?.repo, null);
    assert.equal(session?.branch, undefined);
    assert.equal(session?.baseBranch, undefined);
    assert.equal(session?.checkpoint, undefined);
    await app.fastify.close();
  });

  test("import rejects a branch of .. or -x and does not import", async () => {
    for (const branch of ["..", "-x"]) {
      const app = await buildTestApp();
      const id = `session-bad-${branch === ".." ? "dotdot" : "dash"}`;
      const header = JSON.stringify({ type: "session", version: 3, id, cwd: "/tmp" });
      const entry = JSON.stringify({ id: "e1", parentId: null, type: "message" });
      const res = await app.fastify.inject({
        method: "PUT",
        url: `/api/sessions/${id}/import`,
        headers: {
          "content-type": "application/x-ndjson",
          "x-outfitter-repo": "acme/widgets",
          "x-outfitter-branch": branch,
        },
        payload: `${header}\n${entry}\n`,
      });
      assert.equal(res.statusCode, 400, branch);
      assert.equal(await app.store.sessions.findById(id), null);
      assert.deepEqual(await app.store.entries.listForSession(id), []);
      await app.fastify.close();
    }
  });

  test("import rejects a repo that is not owner/repo, including an ssh url", async () => {
    const app = await buildTestApp();
    const id = "session-ssh";
    const header = JSON.stringify({ type: "session", version: 3, id, cwd: "/tmp" });
    const res = await app.fastify.inject({
      method: "PUT",
      url: `/api/sessions/${id}/import`,
      headers: {
        "content-type": "application/x-ndjson",
        "x-outfitter-repo": "git@github.com:acme/widgets",
        "x-outfitter-branch": "feature",
        "x-outfitter-base": "main",
        "x-outfitter-head": "0123456789abcdef0123456789abcdef01234567",
      },
      payload: `${header}\n`,
    });
    assert.equal(res.statusCode, 400);
    assert.equal(await app.store.sessions.findById(id), null);
    await app.fastify.close();
  });

  test("a second import cannot retarget an existing repository", async () => {
    const app = await buildTestApp();
    const id = "session-bound";
    const head = "0123456789abcdef0123456789abcdef01234567";
    const header = JSON.stringify({ type: "session", version: 3, id, cwd: "/tmp" });
    const headers = {
      "content-type": "application/x-ndjson",
      "x-outfitter-repo": "acme/widgets",
      "x-outfitter-branch": "feature",
      "x-outfitter-base": "main",
      "x-outfitter-head": head,
    };
    const first = await app.fastify.inject({ method: "PUT", url: `/api/sessions/${id}/import`, headers, payload: `${header}\n` });
    assert.equal(first.statusCode, 200);
    const second = await app.fastify.inject({
      method: "PUT",
      url: `/api/sessions/${id}/import`,
      headers: { ...headers, "x-outfitter-repo": "bob/other" },
      payload: `${header}\n`,
    });
    assert.equal(second.statusCode, 409);
    assert.equal((await app.store.sessions.findById(id))?.repo, "acme/widgets");
    const branchOnly = await app.fastify.inject({
      method: "PUT",
      url: `/api/sessions/${id}/import`,
      headers: { "content-type": "application/x-ndjson", "x-outfitter-branch": "main" },
      payload: `${header}\n`,
    });
    assert.equal(branchOnly.statusCode, 400);
    assert.equal((await app.store.sessions.findById(id))?.branch, "feature");
    await app.fastify.close();
  });
});
