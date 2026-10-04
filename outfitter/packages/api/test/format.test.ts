// #208: formatting (permanently deleting) an archived floppy -- DELETE /api/sessions/:id.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedGuru, type TestApp } from "./helpers.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { generateToken, hashToken, tokenPrefix } from "../src/tokens.ts";
import { sessionGithubTokenSecretName } from "../src/operator.ts";
import { SessionFormattedError } from "../src/runs.ts";
import type { Mail, Run, Session, Store } from "../src/store/types.ts";
import { TEST_IAP_AUDIENCE, iapHeaders, useFakeIap } from "./device-iap.ts";

const TASKS_AUTH = { authorization: "Bearer test-agent-token" };
const ARCHIVED = "2026-09-27T00:00:00.000Z";

async function insertSession(store: Store, id: string, overrides: Partial<Session> = {}): Promise<Session> {
  const now = new Date().toISOString();
  const session: Session = { id, guruId: "test-guru", repo: null, status: "open", cost: 0, createdAt: now, updatedAt: now, ...overrides };
  await store.sessions.insert(session);
  return session;
}

async function insertRun(store: Store, sessionId: string, state: Run["state"]): Promise<Run> {
  const now = new Date().toISOString();
  const run: Run = { id: crypto.randomUUID(), sessionId, state, lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now };
  await store.runs.insert(run);
  return run;
}

function mail(id: string, sessionId: string, from: Mail["from"] = { kind: "user" }): Mail {
  return { id, sessionId, from, text: "hi", behavior: "followUp", status: "queued", attempts: 0, createdAt: new Date().toISOString() };
}

async function format(app: TestApp, id: string, headers: Record<string, string> = {}) {
  return app.fastify.inject({ method: "DELETE", url: `/api/sessions/${id}`, headers });
}

async function bearerFor(store: Store, email: string): Promise<Record<string, string>> {
  const token = generateToken();
  await store.tokens.insert({ id: crypto.randomUUID(), ownerEmail: email, name: "test", prefix: tokenPrefix(token), hash: hashToken(token), createdAt: new Date().toISOString() });
  return { authorization: `Bearer ${token}` };
}

describe("DELETE /api/sessions/:id (format)", () => {
  test("erases the floppy and everything keyed to it, keeping mail it sent to others", async () => {
    const app = await buildTestApp();
    const now = new Date().toISOString();
    await insertSession(app.store, "gone", { archivedAt: ARCHIVED });
    await insertSession(app.store, "peer");
    await app.store.entries.insertIfNew("gone", 1, { id: "e1", type: "message" });
    await insertRun(app.store, "gone", "stopped");
    await app.store.mail.insertIfNew(mail("to-gone", "gone"));
    await app.store.mail.insertIfNew(mail("from-gone", "peer", { kind: "session", sessionId: "gone" }));
    await app.store.browserShares.put({ sessionId: "gone", tabTitle: "t", tabUrl: "https://example.com", ownerEmail: "dev@localhost", createdAt: now });
    await app.store.browserRequests.insert({ id: "r1", sessionId: "gone", requesterEmail: "dev@localhost", status: "pending", createdAt: now, updatedAt: now });
    await app.store.browserCaptures.save(
      { id: "c1", sessionId: "gone", requestId: "r1", ownerEmail: "dev@localhost", requesterEmail: "dev@localhost", title: "t", url: "https://example.com", bytes: Buffer.from([1, 2, 3]), createdAt: now },
      now,
    );
    assert.ok(await app.store.browserCaptures.findById("gone", "c1"), "the capture was stored");
    await app.secretAdmin.addVersion(sessionGithubTokenSecretName("gone"), "ghp_example_token_value");

    const res = await format(app, "gone");
    assert.equal(res.statusCode, 204);

    assert.equal(await app.store.sessions.findById("gone"), null);
    assert.deepEqual(await app.store.entries.listForSession("gone"), []);
    assert.deepEqual(await app.store.runs.listForSession("gone"), []);
    assert.equal(await app.store.mail.findById("to-gone"), null);
    assert.ok(await app.store.mail.findById("from-gone"), "mail it sent belongs to the recipient");
    assert.equal(await app.store.browserShares.findBySession("gone"), null);
    assert.equal(await app.store.browserRequests.findById("gone", "r1"), null);
    assert.equal(await app.store.browserCaptures.findById("gone", "c1"), null);
    assert.equal((await app.secretAdmin.info(sessionGithubTokenSecretName("gone"))).set, false);
    assert.ok(await app.store.sessions.findById("peer"));

    const record = await app.store.formattedSessions.findById("gone");
    assert.equal(record?.formattedBy, "dev@localhost");

    assert.equal((await app.fastify.inject({ method: "GET", url: "/api/sessions/gone" })).statusCode, 404);
    assert.equal((await format(app, "gone")).statusCode, 404, "a second format finds nothing");
    await app.fastify.close();
  });

  test("409 unless the floppy is archived", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "live");
    const res = await format(app, "live");
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /archive/);
    assert.ok(await app.store.sessions.findById("live"));
    await app.fastify.close();
  });

  test("409 while the archived floppy's drive is still stopping", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "s1", { archivedAt: ARCHIVED });
    await insertRun(app.store, "s1", "stopping");
    assert.equal((await format(app, "s1")).statusCode, 409);
    assert.ok(await app.store.sessions.findById("s1"));
    assert.equal(await app.store.formattedSessions.findById("s1"), null);
    await app.fastify.close();
  });

  test("404 for a floppy that doesn't exist", async () => {
    const app = await buildTestApp();
    assert.equal((await format(app, "nope")).statusCode, 404);
    await app.fastify.close();
  });

  test("only the owner or a sysop may format", async (t) => {
    useFakeIap(t);
    const store = new MemoryStore();
    const app = await buildTestApp({ OUTFITTER_DEV: "0", OUTFITTER_OPERATORS: "sysop@example.com", IAP_AUDIENCE: TEST_IAP_AUDIENCE }, { store });
    await insertSession(store, "mine", { ownerEmail: "owner@example.com", archivedAt: ARCHIVED });
    await insertSession(store, "ownerless", { archivedAt: ARCHIVED });

    assert.equal((await format(app, "mine", await bearerFor(store, "someone@example.com"))).statusCode, 403);
    assert.equal((await format(app, "ownerless", await bearerFor(store, "owner@example.com"))).statusCode, 403);
    assert.equal((await format(app, "mine", await bearerFor(store, "owner@example.com"))).statusCode, 204);
    // #390: a sysop's Dongle is not a sysop; the person signed in through IAP is.
    assert.equal((await format(app, "ownerless", await bearerFor(store, "sysop@example.com"))).statusCode, 403);
    assert.equal((await format(app, "ownerless", iapHeaders("sysop@example.com"))).statusCode, 204);
    await app.fastify.close();
  });

  test("teleport can't re-import a formatted floppy's id", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "gone", { archivedAt: ARCHIVED });
    await format(app, "gone");
    const header = JSON.stringify({ type: "session", id: "gone", timestamp: ARCHIVED });
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/api/sessions/gone/import",
      headers: { "content-type": "application/x-ndjson" },
      payload: header + "\n",
    });
    assert.equal(res.statusCode, 410);
    assert.equal(await app.store.sessions.findById("gone"), null);
    await app.fastify.close();
  });

  test("a leftover Cloud Tasks wake for a formatted floppy does nothing", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "gone", { archivedAt: ARCHIVED });
    await app.store.mail.insertIfNew(mail("m1", "gone"));
    await format(app, "gone");

    const res = await app.fastify.inject({ method: "POST", url: "/api/hooks/tasks/wake", headers: TASKS_AUTH, payload: { sessionId: "gone" } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().result, "none");
    assert.equal(app.provider.startCalls.length, 0);
    await app.fastify.close();
  });

  test("formatting the last floppy on a Tape lets the Tape be deleted", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { id: "old-tape" });
    await insertSession(app.store, "s1", { guruId: "old-tape", archivedAt: ARCHIVED });

    assert.equal((await app.fastify.inject({ method: "DELETE", url: "/api/gurus/old-tape" })).statusCode, 409);
    await format(app, "s1");
    assert.equal((await app.fastify.inject({ method: "DELETE", url: "/api/gurus/old-tape" })).statusCode, 204);
    await app.fastify.close();
  });

  test("a dead-letter bounce to a formatted sender starts no drive and is dropped", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "gone", { archivedAt: ARCHIVED });
    await format(app, "gone");

    // What MailService.sweep posts when mail the formatted floppy sent runs out of attempts.
    await app.mail.post({ id: "bounce", sessionId: "gone", from: { kind: "system" }, text: "not delivered" });
    assert.equal(app.provider.startCalls.length, 0);
    assert.equal(await app.store.mail.findById("bounce"), null);
    await assert.rejects(app.runs.wake("gone"), SessionFormattedError);
    assert.equal((await app.fastify.inject({ method: "POST", url: "/api/sessions/gone/wake" })).statusCode, 404);
    await app.fastify.close();
  });

  test("a drive still starting when its floppy is formatted gets cancelled", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "s1");
    // Archive stops the queued run (no handle yet), then Format erases the run row, all while the
    // provider is still starting the sandbox.
    const start = app.provider.start.bind(app.provider);
    app.provider.start = async (launch) => {
      const started = await start(launch);
      await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/archive" });
      assert.equal((await format(app, "s1")).statusCode, 204);
      return started;
    };
    await assert.rejects(app.runs.wake("s1"), SessionFormattedError);
    assert.deepEqual(app.provider.stopCalls, ["noop-1"]);
    await app.fastify.close();
  });

  test("a restore that races a format gets 409 once the format has claimed the floppy", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "s1", { archivedAt: ARCHIVED });
    assert.ok(await app.store.sessions.claimForFormat("s1", new Date().toISOString()));
    const restore = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/restore" });
    assert.equal(restore.statusCode, 409);
    assert.equal((await format(app, "s1")).statusCode, 204, "the claimed format still finishes");
    await app.fastify.close();
  });

  test("a format that finds the drive still stopping releases its claim", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "s1", { archivedAt: ARCHIVED });
    await insertRun(app.store, "s1", "stopping");
    assert.equal((await format(app, "s1")).statusCode, 409);
    assert.equal((await app.store.sessions.findById("s1"))?.formattingAt, undefined);
    assert.equal((await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/restore" })).statusCode, 200);
    await app.fastify.close();
  });
});
