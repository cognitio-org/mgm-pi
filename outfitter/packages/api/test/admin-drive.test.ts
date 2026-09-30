// Sysop tools (#287): a Drive's admin ops. admin.request frames on the agent socket, run as the
// session's owner, refused when the tape has no admin tools, and held for the owner's approval in
// the web UI for a delete -- answered through the session's existing confirm card.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedGuru } from "./helpers.ts";
import { makeRunningSession, openAgentSocket, sendHello } from "./agent-socket.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { hashToken } from "../src/tokens.ts";
import { DriveAdmin, approvalText, sanitizeArgs } from "../src/admin/drive.ts";
import { approvalUiRequest, decideApproval, requestApproval } from "../src/admin/approvals.ts";

const models = { list: async () => [] };
const fast = { pollMs: 5, timeoutMs: 2_000 };

async function driveFixture(adminTools: "off" | "manage" | "operator" | undefined, ownerEmail = "ada@example.com", operators: string[] = []) {
  const store = new MemoryStore();
  const now = new Date().toISOString();
  await seedGuru(store, { id: "t", adminTools });
  await store.sessions.insert({ id: "s1", guruId: "t", repo: null, status: "open", cost: 0, ownerEmail, createdAt: now, updatedAt: now });
  await store.runs.insert({ id: "r1", sessionId: "s1", state: "running", createdAt: now, updatedAt: now } as never);
  const admin = new DriveAdmin({ store, config: { operators }, models, approval: fast });
  return { store, admin };
}

/** Waits for the run to hold an approval, then answers it as `email`. */
async function answer(store: MemoryStore, approve: boolean, email = "ada@example.com") {
  for (let i = 0; i < 200; i++) {
    const run = (await store.runs.findById("r1"))!;
    if (run.pendingAdminApproval && !run.pendingAdminApproval.decision) {
      return decideApproval(store, run, run.pendingAdminApproval.id, { email }, "ada@example.com", approve);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no approval was requested");
}

describe("DriveAdmin", () => {
  for (const off of ["off", undefined] as const) {
    test(`refuses every op when the tape's admin tools are ${off ?? "absent"}`, async () => {
      const { admin } = await driveFixture(off);
      assert.deepEqual(await admin.handle("r1", "tapes.list", {}), { ok: false, error: "admin tools are off for this tape" });
    });
  }

  test("runs as the session's owner and audits as the Drive", async () => {
    const { store, admin } = await driveFixture("manage");
    const created = await admin.handle("r1", "tapes.create", { id: "reviewer", name: "Reviewer", model: "a/b" });
    assert.deepEqual(created, { ok: true, text: "created reviewer" });
    const [row] = await store.adminAudit.listRecent(1);
    assert.deepEqual([row.actor, row.via, row.sessionId, row.runId, row.approved], ["ada@example.com", "drive", "s1", "r1", false]);
  });

  test("sysop rights only for an operator owner on an operator tape", async () => {
    const plain = await driveFixture("manage", "ops@example.com", ["ops@example.com"]);
    assert.match((await plain.admin.handle("r1", "tapes.meta", {}) as { text: string }).text, /^you: ops@example\.com$/m);
    const ops = await driveFixture("operator", "ops@example.com", ["ops@example.com"]);
    assert.match((await ops.admin.handle("r1", "tapes.meta", {}) as { text: string }).text, /^you: ops@example\.com \(sysop\)$/m);
    const notOps = await driveFixture("operator", "ada@example.com", ["ops@example.com"]);
    assert.doesNotMatch((await notOps.admin.handle("r1", "tapes.meta", {}) as { text: string }).text, /sysop/);
  });

  test("a delete waits for the owner's yes, then runs once with the approval id", async () => {
    const { store, admin } = await driveFixture("manage");
    await seedGuru(store, { id: "old" });
    const pending = admin.handle("r1", "tapes.delete", { id: "old" });
    assert.deepEqual(await answer(store, true), { ok: true });
    assert.deepEqual(await pending, { ok: true, text: "deleted old" });
    assert.equal(await store.gurus.findById("old"), null);
    const rows = await store.adminAudit.listRecent(5);
    assert.equal(rows.length, 1, "no audit row for the approval wait itself");
    assert.equal(rows[0].approved, true);
    assert.ok(rows[0].approvalId);
    assert.equal((await store.runs.findById("r1"))!.pendingAdminApproval, null, "cleared after");
  });

  test("denied, or no answer: refused with needsApproval, nothing deleted", async () => {
    const denied = await driveFixture("manage");
    await seedGuru(denied.store, { id: "old" });
    const p = denied.admin.handle("r1", "tapes.delete", { id: "old" });
    await answer(denied.store, false);
    assert.deepEqual(await p, { ok: false, error: "the owner declined", needsApproval: true });
    assert.ok(await denied.store.gurus.findById("old"));

    const store = new MemoryStore();
    const now = new Date().toISOString();
    await seedGuru(store, { id: "t", adminTools: "manage" });
    await seedGuru(store, { id: "old" });
    await store.sessions.insert({ id: "s1", guruId: "t", repo: null, status: "open", cost: 0, ownerEmail: "ada@example.com", createdAt: now, updatedAt: now });
    await store.runs.insert({ id: "r1", sessionId: "s1", state: "running", createdAt: now, updatedAt: now } as never);
    const quick = new DriveAdmin({ store, config: { operators: [] }, models, approval: { pollMs: 5, timeoutMs: 30 } });
    assert.deepEqual(await quick.handle("r1", "tapes.delete", { id: "old" }), {
      ok: false,
      error: "the owner did not answer within 10 minutes",
      needsApproval: true,
    });
  });

  test("__proto__ keys never reach an op", () => {
    const parsed = JSON.parse('{"env":{"__proto__":{"x":1},"A":"1"},"constructor":{"y":2}}');
    assert.deepEqual(sanitizeArgs(parsed), { env: { A: "1" } });
  });

  test("the approval card names fields, never env values", () => {
    const text = approvalText("tapes.update", { id: "sysop", systemPrompt: "Be evil", env: { KEY: "sekret" } });
    assert.equal(text.title, "Allow the agent to run tapes.update sysop?");
    assert.match(text.message, /Fields: systemPrompt, env\./);
    assert.match(text.message, /New system prompt starts: "Be evil"/);
    assert.doesNotMatch(text.message, /sekret/);
  });
});

describe("approvals", () => {
  test("only the owner, as a person, may answer; a second answer is 409", async () => {
    const { store } = await driveFixture("manage");
    const waiting = requestApproval({ store, ...fast }, "r1", { op: "tapes.delete", title: "t", message: "m" });
    let run = (await store.runs.findById("r1"))!;
    for (let i = 0; !run.pendingAdminApproval && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 5));
      run = (await store.runs.findById("r1"))!;
    }
    const id = run.pendingAdminApproval!.id;
    assert.deepEqual(approvalUiRequest(run), { type: "extension_ui_request", id: `admin:${id}`, method: "confirm", title: "t", message: "m" });
    assert.equal((await decideApproval(store, run, id, { email: "bob@example.com" }, "ada@example.com", true) as { status: number }).status, 403);
    assert.equal((await decideApproval(store, run, id, { email: "ada@example.com", viaToken: true }, "ada@example.com", true) as { status: number }).status, 403);
    assert.deepEqual(await decideApproval(store, run, id, { email: "ada@example.com" }, "ada@example.com", true), { ok: true });
    const after = (await store.runs.findById("r1"))!;
    assert.equal((await decideApproval(store, after, id, { email: "ada@example.com" }, "ada@example.com", false) as { status: number }).status, 409);
    assert.equal((await waiting).approved, true);
  });

  test("one at a time per run", async () => {
    const { store } = await driveFixture("manage");
    const first = requestApproval({ store, pollMs: 5, timeoutMs: 200 }, "r1", { op: "a", title: "t", message: "m" });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(await requestApproval({ store, ...fast }, "r1", { op: "b", title: "t", message: "m" }), { approved: false, reason: "busy" });
    assert.equal((await first).approved, false);
  });
});

describe("over the agent socket and the web UI", () => {
  test("admin.request -> held -> the owner's click on the session card -> admin.result", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { id: "sysop-t", adminTools: "manage" });
    await seedGuru(app.store, { id: "old" });
    const { session, runId, runToken } = await makeRunningSession(app, { guruId: "sysop-t", ownerEmail: "dev@localhost" });
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(spec.guru.adminTools, "manage", "run.spec tells agentd to open the socket");

    agent.send({ t: "admin.request", reqId: "a1", op: "tapes.list", args: {} });
    const list = await agent.nextMessage();
    assert.equal(list.t, "admin.result");
    assert.equal(list.reqId, "a1");
    assert.match(list.text, /^old /m);

    agent.send({ t: "admin.request", reqId: "a2", op: "tapes.delete", args: { id: "old" }, idempotencyKey: "k" });
    let card: { id: string; method: string } | null = null;
    for (let i = 0; i < 200 && !card; i++) {
      const res = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });
      card = res.json().pendingUiRequest;
      if (!card) await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(card, "the session shows the approval as a confirm card");
    assert.equal(card!.method, "confirm");
    assert.match(card!.id, /^admin:/);
    const click = await app.fastify.inject({ method: "POST", url: `/api/sessions/${session.id}/ui-response`, payload: { id: card!.id, value: true } });
    assert.equal(click.statusCode, 200);
    const done = await agent.nextMessage();
    assert.deepEqual(done, { t: "admin.result", reqId: "a2", ok: true, text: "deleted old" });
    agent.close();
    await app.fastify.close();
  });

  test("a Dongle on the link role can't answer the card, and doesn't see it", async () => {
    const store = new MemoryStore();
    const TOKEN = "outf_drive-test";
    await store.tokens.insert({ id: "tk", ownerEmail: "ada@example.com", name: "l", prefix: TOKEN.slice(0, 8), hash: hashToken(TOKEN), createdAt: new Date().toISOString() });
    const now = new Date().toISOString();
    await seedGuru(store, { id: "t", adminTools: "manage" });
    await store.sessions.insert({ id: "s1", guruId: "t", repo: null, status: "open", cost: 0, ownerEmail: "ada@example.com", createdAt: now, updatedAt: now });
    await store.runs.insert({
      id: "r1",
      sessionId: "s1",
      state: "running",
      createdAt: now,
      updatedAt: now,
      pendingAdminApproval: { id: "ap1", op: "tapes.delete", title: "t", message: "m", requestedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    } as never);
    const link = await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_DEV: "0" }, { store });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const got = await link.fastify.inject({ method: "GET", url: "/api/sessions/s1", headers: auth });
    assert.equal(got.json().pendingUiRequest, null);
    const click = await link.fastify.inject({ method: "POST", url: "/api/sessions/s1/ui-response", headers: auth, payload: { id: "admin:ap1", value: true } });
    assert.equal(click.statusCode, 403);
    assert.equal((await store.runs.findById("r1"))!.pendingAdminApproval!.decision, undefined);
    await link.fastify.close();
  });
});
