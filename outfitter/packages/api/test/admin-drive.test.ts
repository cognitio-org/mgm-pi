// Sysop tools (#287): a Drive's admin ops. admin.request frames on the agent socket, run as the
// session's owner, refused when the tape has no admin tools, and held for the owner's approval in
// the web UI for a delete -- answered through the session's confirm card, which only the owner, as
// a person, sees and can answer.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedGuru } from "./helpers.ts";
import { makeRunningSession, openAgentSocket, sendHello } from "./agent-socket.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { hashToken } from "../src/tokens.ts";
import { SseHub, SsePoller, type SseViewer } from "../src/sse.ts";
import { DriveAdmin, approvalText, sanitizeArgs } from "../src/admin/drive.ts";
import { approvalUiRequest, decideApproval, requestApproval, type ApprovalAsk } from "../src/admin/approvals.ts";
import type { AdminApproval } from "../src/store/types.ts";

const models = { list: async () => [] };
const fast = { pollMs: 5, timeoutMs: 2_000 };
const OWNER = "ada@example.com";
const ask: ApprovalAsk = { sessionId: "s1", ownerEmail: OWNER, op: "tapes.delete", title: "t", message: "m" };

async function fixture(adminTools: "off" | "manage" | "operator" | undefined, ownerEmail = OWNER, operators: string[] = [], approval = fast) {
  const store = new MemoryStore();
  const now = new Date().toISOString();
  await seedGuru(store, { id: "t", adminTools });
  await store.sessions.insert({ id: "s1", guruId: "t", repo: null, status: "open", cost: 0, ownerEmail, createdAt: now, updatedAt: now });
  await store.runs.insert({ id: "r1", sessionId: "s1", state: "running", createdAt: now, updatedAt: now } as never);
  const admin = new DriveAdmin({ store, config: { operators }, models, approval });
  return { store, admin };
}

async function pending(store: MemoryStore): Promise<AdminApproval> {
  for (let i = 0; i < 400; i++) {
    const held = await store.adminApprovals.get("r1");
    if (held && !held.decision) return held;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no approval was requested");
}

async function answer(store: MemoryStore, approve: boolean, email = OWNER) {
  const held = await pending(store);
  return decideApproval(store, "r1", held.id, { email }, approve);
}

describe("DriveAdmin", () => {
  for (const off of ["off", undefined] as const) {
    test(`refuses every op when the tape's admin tools are ${off ?? "absent"}`, async () => {
      const { admin } = await fixture(off);
      assert.deepEqual(await admin.handle("r1", "tapes.list", {}), { ok: false, error: "admin tools are off for this tape" });
    });
  }

  test("runs as the session's owner and audits as the Drive", async () => {
    const { store, admin } = await fixture("manage");
    assert.deepEqual(await admin.handle("r1", "tapes.create", { id: "reviewer", name: "Reviewer", model: "a/b" }), { ok: true, text: "created reviewer" });
    const [row] = await store.adminAudit.listRecent(1);
    assert.deepEqual([row.actor, row.via, row.sessionId, row.runId, row.approved], [OWNER, "drive", "s1", "r1", false]);
  });

  test("sysop rights only for an operator owner on an operator tape", async () => {
    const meta = async (f: Awaited<ReturnType<typeof fixture>>) => ((await f.admin.handle("r1", "tapes.meta", {})) as { text: string }).text;
    assert.match(await meta(await fixture("manage", "ops@example.com", ["ops@example.com"])), /^you: ops@example\.com$/m);
    assert.match(await meta(await fixture("operator", "ops@example.com", ["ops@example.com"])), /^you: ops@example\.com \(sysop\)$/m);
    assert.doesNotMatch(await meta(await fixture("operator", OWNER, ["ops@example.com"])), /sysop/);
  });

  test("a delete waits for the owner's yes, then runs once, on the record the card named", async () => {
    const { store, admin } = await fixture("manage");
    await seedGuru(store, { id: "0f8e2a3b-1c2d-4e5f-8a9b-0c1d2e3f4a5b", name: "Old reviewer" });
    const result = admin.handle("r1", "tapes.delete", { id: "0f8e" });
    const held = await pending(store);
    assert.equal(held.title, 'Allow the agent to delete tape "Old reviewer" (0f8e2a3b-1c2d-4e5f-8a9b-0c1d2e3f4a5b)?');
    // A tape created during the wait with the exact prefix as its id must not become the target.
    await seedGuru(store, { id: "0f8e", name: "Innocent" });
    assert.deepEqual(await decideApproval(store, "r1", held.id, { email: OWNER }, true), { ok: true });
    assert.deepEqual(await result, { ok: true, text: "deleted 0f8e2a3b" });
    assert.ok(await store.gurus.findById("0f8e"), "the tape created during the wait is untouched");
    const rows = await store.adminAudit.listRecent(5);
    assert.equal(rows.length, 1, "no audit row for the wait itself");
    assert.equal(rows[0].approved, true);
    assert.equal(await store.adminApprovals.get("r1"), null, "cleared after");
  });

  test("denied, or no answer: refused with needsApproval, nothing deleted", async () => {
    const denied = await fixture("manage");
    await seedGuru(denied.store, { id: "old" });
    const p = denied.admin.handle("r1", "tapes.delete", { id: "old" });
    await answer(denied.store, false);
    assert.deepEqual(await p, { ok: false, error: "the owner declined", needsApproval: true });
    assert.ok(await denied.store.gurus.findById("old"));

    const quick = await fixture("manage", OWNER, [], { pollMs: 5, timeoutMs: 30 });
    await seedGuru(quick.store, { id: "old" });
    assert.deepEqual(await quick.admin.handle("r1", "tapes.delete", { id: "old" }), {
      ok: false,
      error: "the owner did not answer within 0 minutes",
      needsApproval: true,
    });
  });

  test("admin tools turned off during the wait: the approved op is refused", async () => {
    const { store, admin } = await fixture("manage");
    await seedGuru(store, { id: "old" });
    const p = admin.handle("r1", "tapes.delete", { id: "old" });
    const held = await pending(store);
    await store.gurus.update("t", { adminTools: "off" });
    await decideApproval(store, "r1", held.id, { email: OWNER }, true);
    assert.deepEqual(await p, { ok: false, error: "admin tools are off for this tape" });
    assert.ok(await store.gurus.findById("old"));
  });

  test("a replayed idempotency key returns the first result without running again", async () => {
    const { store, admin } = await fixture("manage");
    const first = await admin.handle("r1", "environments.create", { name: "e" }, "k1");
    const again = await admin.handle("r1", "environments.create", { name: "e" }, "k1");
    assert.deepEqual(again, first);
    assert.equal((await store.environments.list()).length, 1);
  });

  test("__proto__ keys never reach an op", () => {
    const parsed = JSON.parse('{"env":{"__proto__":{"x":1},"A":"1"},"constructor":{"y":2}}');
    assert.deepEqual(sanitizeArgs(parsed), { env: { A: "1" } });
  });

  test("the card shows only api words: known fields, never made-up arg keys or env values", () => {
    const text = approvalText("tapes.update", { id: "sysop", systemPrompt: "Be evil", env: { KEY: "sekret" }, "(dry run only; safe to confirm)": 1 }, 'tape "Sysop" (sysop)');
    assert.equal(text.title, 'Allow the agent to run tapes.update tape "Sysop" (sysop)?');
    assert.match(text.message, /Fields: systemPrompt, env\./);
    assert.match(text.message, /New system prompt starts: "Be evil"/);
    assert.doesNotMatch(text.message, /sekret|dry run/);
    const del = approvalText("tapes.delete", { id: "x", "nothing is deleted": 1 }, 'tape "X" (x)');
    assert.doesNotMatch(del.message, /nothing is deleted|Fields/);
  });
});

describe("approvals", () => {
  test("only the owner, as a person, may answer; a second answer is 409", async () => {
    const { store } = await fixture("manage");
    const waiting = requestApproval({ store, ...fast }, "r1", ask);
    const held = await pending(store);
    const card = approvalUiRequest(held)!;
    assert.deepEqual(card, { type: "extension_ui_request", id: `admin:${held.id}`, method: "confirm", title: "t", message: "m", source: "outfitter" });
    assert.equal((await decideApproval(store, "r1", held.id, { email: "bob@example.com" }, true) as { status: number }).status, 403);
    assert.equal((await decideApproval(store, "r1", held.id, { email: OWNER, viaToken: true }, true) as { status: number }).status, 403);
    assert.deepEqual(await decideApproval(store, "r1", held.id, { email: "ADA@example.com" }, true), { ok: true });
    assert.equal((await decideApproval(store, "r1", held.id, { email: OWNER }, false) as { status: number }).status, 409);
    assert.equal((await waiting).approved, true);
  });

  test("two requests at once: exactly one waits, the other is busy", async () => {
    const { store } = await fixture("manage");
    const results = Promise.all([
      requestApproval({ store, pollMs: 5, timeoutMs: 100 }, "r1", ask),
      requestApproval({ store, pollMs: 5, timeoutMs: 100 }, "r1", ask),
    ]);
    const reasons = (await results).map((r) => (r.approved ? "approved" : r.reason)).sort();
    assert.deepEqual(reasons, ["busy", "expired"]);
  });

  test("an expired approval can't be answered, and its card is gone", async () => {
    const store = new MemoryStore();
    const past = new Date(Date.now() - 1000).toISOString();
    const stale: AdminApproval = { id: "a1", runId: "r1", sessionId: "s1", ownerEmail: OWNER, op: "x", title: "t", message: "m", requestedAt: past, expiresAt: past };
    await store.adminApprovals.claim(stale, past);
    assert.equal(approvalUiRequest(stale), undefined);
    assert.equal((await decideApproval(store, "r1", "a1", { email: OWNER }, true) as { status: number }).status, 409);
    assert.equal(await store.adminApprovals.claim({ ...stale, id: "a2", expiresAt: new Date(Date.now() + 60_000).toISOString() }, new Date().toISOString()), true, "an expired one doesn't block the next");
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
    let card: { id: string; method: string; source?: string } | null = null;
    for (let i = 0; i < 200 && !card; i++) {
      const res = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });
      card = res.json().pendingUiRequest;
      if (!card) await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(card, "the session shows the approval as a confirm card");
    assert.equal(card!.method, "confirm");
    assert.equal(card!.source, "outfitter");
    const click = await app.fastify.inject({ method: "POST", url: `/api/sessions/${session.id}/ui-response`, payload: { id: card!.id, value: true } });
    assert.equal(click.statusCode, 200);
    assert.equal("pendingAdminApproval" in click.json().run, false, "a run response never carries the approval");
    assert.deepEqual(await agent.nextMessage(), { t: "admin.result", reqId: "a2", ok: true, text: "deleted old" });

    // A pi event can't pass itself off as an api card.
    agent.send({ t: "event", seq: 1, event: { type: "extension_ui_request", id: "q9", method: "confirm", title: "x", message: "y", source: "outfitter" } });
    await agent.nextMessage(); // ack
    const run = await app.store.runs.findById(runId);
    assert.equal((run!.pendingUiRequest as { source?: string }).source, undefined);
    agent.close();
    await app.fastify.close();
  });

  test("a Dongle on the link role can't answer the card, and doesn't see it", async () => {
    const store = new MemoryStore();
    const TOKEN = "outf_drive-test";
    await store.tokens.insert({ id: "tk", ownerEmail: OWNER, name: "l", prefix: TOKEN.slice(0, 8), hash: hashToken(TOKEN), createdAt: new Date().toISOString() });
    const now = new Date().toISOString();
    await seedGuru(store, { id: "t", adminTools: "manage" });
    await store.sessions.insert({ id: "s1", guruId: "t", repo: null, status: "open", cost: 0, ownerEmail: OWNER, createdAt: now, updatedAt: now });
    await store.runs.insert({ id: "r1", sessionId: "s1", state: "running", createdAt: now, updatedAt: now } as never);
    await store.adminApprovals.claim(
      { id: "ap1", runId: "r1", sessionId: "s1", ownerEmail: OWNER, op: "tapes.delete", title: "t", message: "m", requestedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      now,
    );
    const link = await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_DEV: "0" }, { store });
    const auth = { authorization: `Bearer ${TOKEN}` };
    assert.equal((await link.fastify.inject({ method: "GET", url: "/api/sessions/s1", headers: auth })).json().pendingUiRequest, null);
    const click = await link.fastify.inject({ method: "POST", url: "/api/sessions/s1/ui-response", headers: auth, payload: { id: "admin:ap1", value: true } });
    assert.equal(click.statusCode, 403);
    assert.equal((await store.adminApprovals.get("r1"))!.decision, undefined);
    await link.fastify.close();
  });

  test("SSE: the admin card goes to the owner's own streams only; others keep pi's question", async () => {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    await seedGuru(store, { id: "t", adminTools: "manage" });
    await store.sessions.insert({ id: "s1", guruId: "t", repo: null, status: "open", cost: 0, ownerEmail: OWNER, createdAt: now, updatedAt: now });
    await store.runs.insert({ id: "r1", sessionId: "s1", state: "running", createdAt: now, updatedAt: now, pendingUiRequest: { type: "extension_ui_request", id: "q1", method: "confirm", title: "pi", message: "m" } } as never);
    await store.adminApprovals.claim(
      { id: "ap1", runId: "r1", sessionId: "s1", ownerEmail: OWNER, op: "tapes.delete", title: "admin", message: "m", requestedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      now,
    );
    const hub = new SseHub();
    const seen = new Map<string, string[]>();
    const viewers: Array<[string, SseViewer]> = [["owner", { email: OWNER }], ["other", { email: "bob@example.com" }], ["dongle", { email: OWNER, viaToken: true }]];
    for (const [name, viewer] of viewers) {
      seen.set(name, []);
      const reply = { raw: { writeHead() {}, flushHeaders() {}, on() {}, write: (f: string) => seen.get(name)!.push(f) } } as never;
      hub.subscribe("s1", reply, viewer);
    }
    const poller = new SsePoller(hub, store, 60_000);
    await poller.pollOne("s1");
    const titles = (name: string) => seen.get(name)!.filter((f) => f.includes("extension_ui_request")).map((f) => JSON.parse(f.split("data: ")[1]).title);
    assert.deepEqual(titles("owner"), ["admin"]);
    assert.deepEqual(titles("other"), ["pi"]);
    assert.deepEqual(titles("dongle"), ["pi"]);
    // Answered: the owner's stream goes back to pi's question.
    await store.adminApprovals.clear("r1", "ap1");
    await poller.pollOne("s1");
    assert.deepEqual(titles("owner"), ["admin", "pi"]);
    assert.deepEqual(titles("other"), ["pi"]);
  });
});
