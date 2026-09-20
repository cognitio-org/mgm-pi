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
    assert.equal(app.provider.startCalls[0].sessionId, body.session.id);

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

describe("down-messages queue when no agentd socket is connected", () => {
  test("the initial prompt and a follow-up message both land in run.pending", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);

    const createRes = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "first" },
    });
    const { session, run } = createRes.json();

    const afterCreate = await app.store.runs.findById(run.id);
    assert.equal(afterCreate?.pending.length, 1);
    assert.equal(afterCreate?.pending[0].t, "prompt");
    assert.equal(afterCreate?.pending[0].text, "first");

    const messageRes = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: { text: "second" },
    });
    assert.equal(messageRes.statusCode, 200);

    const afterMessage = await app.store.runs.findById(run.id);
    assert.equal(afterMessage?.pending.length, 2);
    assert.equal(afterMessage?.pending[1].text, "second");

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
