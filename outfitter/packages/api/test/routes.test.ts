import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedGuru } from "./helpers.ts";

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
  test("includes runState from the active run, undefined once there is none", async () => {
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

    await app.fastify.inject({ method: "POST", url: `/api/sessions/${session.id}/abort` });
    const afterAbortRun = await app.store.runs.findActiveForSession(session.id);
    await app.store.runs.update(afterAbortRun!.id, { state: "stopped" });

    const getAfter = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    assert.equal(getAfter.json().runState, undefined);

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
});
