// #207: archiving and restoring floppies (sessions). Archive hides a floppy from the list and makes
// it read-only (no wakes, no new mail, no teleport import) until it is restored; only the owner or
// a sysop may do either.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./helpers.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { generateToken, hashToken, tokenPrefix } from "../src/tokens.ts";
import { MAIL_ENTRY_TYPE, MAIL_HELD_ARCHIVED, mailIdFor } from "../src/mail.ts";
import { SessionArchivedError } from "../src/runs.ts";
import type { Run, Session, Store } from "../src/store/types.ts";

const TASKS_AUTH = { authorization: "Bearer test-agent-token" };

async function insertSession(store: Store, id: string, overrides: Partial<Session> = {}): Promise<Session> {
  const now = new Date().toISOString();
  const session: Session = { id, guruId: "test-guru", repo: null, status: "open", cost: 0, createdAt: now, updatedAt: now, ...overrides };
  await store.sessions.insert(session);
  return session;
}

async function insertRun(store: Store, sessionId: string, overrides: Partial<Run> = {}): Promise<Run> {
  const now = new Date().toISOString();
  const run: Run = { id: crypto.randomUUID(), sessionId, state: "running", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now, ...overrides };
  await store.runs.insert(run);
  return run;
}

async function archive(app: TestApp, id: string, headers: Record<string, string> = {}) {
  return app.fastify.inject({ method: "POST", url: `/api/sessions/${id}/archive`, headers });
}

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

describe("GET /api/sessions and archived floppies", () => {
  test("hides archived floppies by default; archived=only and archived=all show them", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "live");
    await insertSession(app.store, "shelved", { archivedAt: "2026-09-27T00:00:00.000Z" });

    const ids = async (query: string) =>
      (await app.fastify.inject({ method: "GET", url: `/api/sessions${query}` })).json().map((s: { id: string }) => s.id).sort();
    assert.deepEqual(await ids(""), ["live"]);
    assert.deepEqual(await ids("?archived=exclude"), ["live"]);
    assert.deepEqual(await ids("?archived=only"), ["shelved"]);
    assert.deepEqual(await ids("?archived=all"), ["live", "shelved"]);

    const only = (await app.fastify.inject({ method: "GET", url: "/api/sessions?archived=only" })).json();
    assert.equal(only[0].archivedAt, "2026-09-27T00:00:00.000Z");

    const bad = await app.fastify.inject({ method: "GET", url: "/api/sessions?archived=yes" });
    assert.equal(bad.statusCode, 400);
    await app.fastify.close();
  });

  test("the store's list returns archived floppies when no archived filter is given", async () => {
    const store = new MemoryStore();
    await insertSession(store, "live");
    await insertSession(store, "shelved", { archivedAt: "2026-09-27T00:00:00.000Z" });
    assert.equal((await store.sessions.list()).length, 2);
  });
});

describe("POST /api/sessions/:id/archive and /restore", () => {
  test("archive stamps archivedAt, is idempotent, and restore clears it", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "s1");

    const first = await archive(app, "s1");
    assert.equal(first.statusCode, 200);
    const archivedAt = first.json().session.archivedAt;
    assert.ok(archivedAt);

    const again = await archive(app, "s1");
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().session.archivedAt, archivedAt, "a second archive keeps the first timestamp");

    const restored = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/restore" });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().session.archivedAt, undefined);
    assert.equal((await app.store.sessions.findById("s1"))?.archivedAt, undefined);

    const restoredAgain = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/restore" });
    assert.equal(restoredAgain.statusCode, 200);
    await app.fastify.close();
  });

  test("404 for a floppy that doesn't exist", async () => {
    const app = await buildTestApp();
    assert.equal((await archive(app, "nope")).statusCode, 404);
    assert.equal((await app.fastify.inject({ method: "POST", url: "/api/sessions/nope/restore" })).statusCode, 404);
    await app.fastify.close();
  });

  test("archiving a floppy with a live agent sends a graceful stop", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "s1");
    const run = await insertRun(app.store, "s1", { state: "idle" });

    assert.equal((await archive(app, "s1")).statusCode, 200);
    const stored = await app.store.runs.findById(run.id);
    assert.equal(stored?.state, "stopping");
    assert.deepEqual(stored?.pending, [{ t: "stop", reason: "user" }]);
    await app.fastify.close();
  });

  test("archiving a floppy whose drive is still provisioning cancels it at the provider", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "s1");
    const run = await insertRun(app.store, "s1", { state: "provisioning", providerHandle: "exec-1" });

    assert.equal((await archive(app, "s1")).statusCode, 200);
    assert.deepEqual(app.provider.stopCalls, ["exec-1"]);
    assert.equal((await app.store.runs.findById(run.id))?.state, "stopped");
    await app.fastify.close();
  });
});

describe("archived floppies are read-only", () => {
  test("Play, messages, mail retry and teleport import answer 409", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "s1", { archivedAt: "2026-09-27T00:00:00.000Z" });

    const wake = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/wake" });
    assert.equal(wake.statusCode, 409);
    const message = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/messages", payload: { text: "hi" } });
    assert.equal(message.statusCode, 409);
    const retry = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/mail/retry" });
    assert.equal(retry.statusCode, 409);
    const header = JSON.stringify({ type: "session", id: "s1", timestamp: "2026-09-27T00:00:00.000Z" });
    const imported = await app.fastify.inject({
      method: "PUT",
      url: "/api/sessions/s1/import",
      headers: { "content-type": "application/x-ndjson" },
      payload: header + "\n",
    });
    assert.equal(imported.statusCode, 409);

    assert.equal(await app.store.runs.findLatestForSession("s1"), null, "nothing started a run");
    assert.equal(await app.store.mail.countHeld("s1"), 0, "the refused message wasn't stored");
    await app.fastify.close();
  });

  test("RunManager.wake refuses an archived floppy", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "s1", { archivedAt: "2026-09-27T00:00:00.000Z" });
    await assert.rejects(app.runs.wake("s1"), SessionArchivedError);
    await app.fastify.close();
  });

  test("queued mail is held when the floppy is archived and shows the archived notice", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "s1");
    await app.store.mail.insertIfNew({
      id: "m1",
      sessionId: "s1",
      from: { kind: "user" },
      text: "hi",
      behavior: "followUp",
      status: "queued",
      attempts: 0,
      createdAt: new Date().toISOString(),
    });

    await archive(app, "s1");
    assert.equal(await app.store.mail.countHeld("s1"), 1);
    assert.equal(await app.store.mail.heldDetail("s1"), MAIL_HELD_ARCHIVED);
    const detail = (await app.fastify.inject({ method: "GET", url: "/api/sessions/s1" })).json();
    assert.match(detail.mailNotice, /archived/);

    // Restore leaves it held: Retry on the session page is what delivers it.
    await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/restore" });
    assert.equal(await app.store.mail.countHeld("s1"), 1);
    await app.fastify.close();
  });

  test("a Cloud Tasks wake and the /tick sweep don't start a run for an archived floppy", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "s1", { archivedAt: "2026-09-27T00:00:00.000Z" });
    await app.store.mail.insertIfNew({
      id: "m1",
      sessionId: "s1",
      from: { kind: "user" },
      text: "hi",
      behavior: "followUp",
      status: "queued",
      attempts: 0,
      createdAt: new Date().toISOString(),
    });

    const task = await app.fastify.inject({ method: "POST", url: "/api/hooks/tasks/wake", headers: TASKS_AUTH, payload: { sessionId: "s1" } });
    assert.equal(task.statusCode, 200);
    assert.equal(task.json().result, "held");
    const tick = await app.fastify.inject({ method: "POST", url: "/api/hooks/tick", headers: TASKS_AUTH });
    assert.deepEqual(tick.json().woken, []);
    assert.equal(await app.store.runs.findLatestForSession("s1"), null);
    await app.fastify.close();
  });

  test("an agent's send to an archived floppy bounces back to the sender", async () => {
    const app = await buildTestApp();
    await insertSession(app.store, "sender");
    await insertSession(app.store, "shelved", { archivedAt: "2026-09-27T00:00:00.000Z" });

    const entry = { id: "e1", parentId: null, type: "custom", customType: MAIL_ENTRY_TYPE, data: { to: "shelved", text: "hi" } };
    assert.equal(await app.mail.handleAgentSend("sender", entry), "sender");
    const bounced = await app.store.mail.findById(mailIdFor("sender", "e1", "bounce"));
    assert.match(bounced?.text ?? "", /session "shelved" is archived/);
    await app.fastify.close();
  });
});

describe("who may archive and restore", () => {
  async function prodApp(store: Store) {
    return buildTestApp({ OUTFITTER_DEV: "0", OUTFITTER_OPERATORS: "sysop@example.com" }, { store });
  }

  test("the owner may; another user gets 403", async () => {
    const store = new MemoryStore();
    const app = await prodApp(store);
    await insertSession(store, "s1", { ownerEmail: "Owner@example.com" });

    const other = await archive(app, "s1", await bearerFor(store, "someone@example.com"));
    assert.equal(other.statusCode, 403);
    assert.equal((await store.sessions.findById("s1"))?.archivedAt, undefined);

    const owner = await archive(app, "s1", await bearerFor(store, "owner@example.com"));
    assert.equal(owner.statusCode, 200, "owner emails compare case-insensitively");

    const restoreByOther = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions/s1/restore",
      headers: await bearerFor(store, "someone@example.com"),
    });
    assert.equal(restoreByOther.statusCode, 403);
    await app.fastify.close();
  });

  test("a sysop may manage anyone's floppy, and is the only one who may manage an ownerless one", async () => {
    const store = new MemoryStore();
    const app = await prodApp(store);
    await insertSession(store, "owned", { ownerEmail: "owner@example.com" });
    await insertSession(store, "ownerless");

    assert.equal((await archive(app, "ownerless", await bearerFor(store, "someone@example.com"))).statusCode, 403);
    const sysop = await bearerFor(store, "sysop@example.com");
    assert.equal((await archive(app, "owned", sysop)).statusCode, 200);
    assert.equal((await archive(app, "ownerless", sysop)).statusCode, 200);
    await app.fastify.close();
  });
});
