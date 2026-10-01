// E9 §1 turn-settled signal (src/turns.ts): the three completion layers, the store contract on
// MemoryStore and a real MongoDB (mongodb-memory-server, or OUTFITTER_TEST_MONGODB_URI, as in
// mongo-entry-runs.test.ts), and the agentd socket + /api/hooks/tick wiring.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../src/store/memory.ts";
import { MongoStore } from "../src/store/mongo.ts";
import type { Mail, Run, Session, Store, TurnWaiter } from "../src/store/types.ts";
import { TURN_WAITER_ACTIVITY_MS, TURN_WAITER_ADOPT_AFTER_MS, TURN_WAITER_CAP_MS, TURN_WAITER_DEADLINE_MS, TurnWaiters } from "../src/turns.ts";
import { buildTestApp } from "./helpers.ts";
import { makeRunningSession, openAgentSocket, sendHello } from "./agent-socket.ts";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const MIN = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A TurnWaiters over a MemoryStore with a hand-moved clock and a recording stop. */
async function setup() {
  const store = new MemoryStore();
  let now = T0;
  const stops: Array<{ runId: string; reason?: string; waiters: TurnWaiter[] }> = [];
  const runs = {
    async stop(runId: string, reason?: string): Promise<Run | null> {
      // What the waiters looked like when the run was stopped: the deadline stops first.
      stops.push({ runId, reason, waiters: await store.turnWaiters.listOpen(100) });
      return store.runs.update(runId, { state: "stopped", reason, updatedAt: iso(now) });
    },
  };
  const turns = new TurnWaiters(store, runs, () => {}, () => now);
  const session: Session = { id: "s1", guruId: "g", repo: null, status: "open", cost: 0, createdAt: iso(T0), updatedAt: iso(T0) };
  await store.sessions.insert(session);
  return {
    store,
    turns,
    stops,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    insertRun: async (id: string, extra: Partial<Run> = {}) => {
      const run: Run = { id, sessionId: "s1", state: "running", lastAckedSeq: 0, pending: [], createdAt: iso(now), updatedAt: iso(now), ...extra };
      await store.runs.insert(run);
      return run;
    },
    insertMail: async (extra: Partial<Mail> = {}) => {
      const mail: Mail = { id: "m1", sessionId: "s1", from: { kind: "user" }, text: "hi", behavior: "followUp", status: "queued", attempts: 0, createdAt: iso(now), ...extra };
      await store.mail.insertIfNew(mail);
      return mail;
    },
  };
}

describe("TurnWaiters: layer 1, settle", () => {
  test("completes on the first settle after its mail was accepted, never on an earlier one", async () => {
    const { store, turns } = await setup();
    const settles: Array<[string, string | undefined]> = [];
    const finished: TurnWaiter[] = [];
    turns.onSettled((sessionId, lastEntryId) => settles.push([sessionId, lastEntryId]));
    turns.onFinished((w) => finished.push(w));
    const waiter = await turns.register({ sessionId: "s1", mailId: "m1", owner: "a2a" });
    assert.equal(waiter.status, "open");
    assert.equal(waiter.owner, "a2a");

    await turns.noteSettled("s1", "r1", 3, "e-before"); // the owner's earlier turn, before the mail
    assert.equal((await turns.get(waiter.id))?.status, "open");

    await turns.noteMailAccepted("s1", "r1", "m1", 7);
    await turns.noteMailAccepted("s1", "r1", "m1", 12); // a replayed response: the first one stands
    assert.equal((await turns.get(waiter.id))?.ackSeq, 7);
    await turns.noteSettled("s1", "r1", 5); // replayed from before the acceptance
    await turns.noteSettled("s1", "r2", 9); // another run's seq counter
    assert.equal((await turns.get(waiter.id))?.status, "open");

    await turns.noteSettled("s1", "r1", 9, "e-final");
    const done = await turns.get(waiter.id);
    assert.equal(done?.status, "settled");
    assert.equal(done?.settledEntryId, "e-final");
    assert.ok(done?.finishedAt);
    const session = await store.sessions.findById("s1");
    assert.equal(session?.settledEntryId, "e-final");
    assert.ok(session?.settledAt);
    assert.deepEqual(finished.map((w) => w.id), [waiter.id]);
    assert.deepEqual(settles.at(-1), ["s1", "e-final"]);
    assert.equal(settles.length, 4, "every settle is signalled, matched to a waiter or not");
  });

  test("a replayed settle completes nothing new, doesn't rewrite the session, and isn't signalled twice", async () => {
    const { store, turns } = await setup();
    const settles: string[] = [];
    turns.onSettled((_s, lastEntryId) => settles.push(lastEntryId ?? "-"));
    await turns.noteSettled("s1", "r1", 9, "e9");
    const first = await store.sessions.findById("s1");
    await turns.noteSettled("s1", "r1", 9, "e9");
    await turns.noteSettled("s1", "r1", 4);
    assert.deepEqual(settles, ["e9"]);
    assert.deepEqual(await store.sessions.findById("s1"), first);
    await turns.noteSettled("s1", "r1", 12);
    const after = await store.sessions.findById("s1");
    assert.equal(after?.settledSeq, 12);
    assert.equal(after?.settledEntryId, null, "a settle without lastEntryId clears the old one");
  });

  test("an acceptance the stream missed is taken from the mail only after a while, provisionally, and the real response replaces it", async () => {
    const { store, turns, advance, insertRun, insertMail } = await setup();
    await insertRun("r1");
    await turns.noteSettled("s1", "r1", 5, "e5"); // the last settle recorded before the mail
    await insertMail({ id: "late", status: "acked", deliveredRunId: "r1", ackedAt: iso(T0) });
    const waiter = await turns.register({ sessionId: "s1", mailId: "late" });
    assert.equal(waiter.ackRunId, undefined, "a fresh mail.ack may have overtaken the stream: wait for it");

    advance(TURN_WAITER_ADOPT_AFTER_MS);
    await turns.sweep();
    const adopted = await turns.get(waiter.id);
    assert.equal(adopted?.ackRunId, "r1");
    assert.equal(adopted?.ackSeq, 5, "only a settle after the last recorded one counts");
    assert.equal(adopted?.ackFromMail, true);
    await turns.noteSettled("s1", "r1", 5);
    assert.equal((await turns.get(waiter.id))?.status, "open");

    await turns.noteMailAccepted("s1", "r1", "late", 7); // the response, late
    const real = await turns.get(waiter.id);
    assert.equal(real?.ackSeq, 7);
    assert.equal(real?.ackFromMail, undefined);
    await turns.noteSettled("s1", "r1", 6); // queued ahead of the response
    assert.equal((await turns.get(waiter.id))?.status, "open");
    await turns.noteSettled("s1", "r1", 8, "e8");
    assert.equal((await turns.get(waiter.id))?.settledEntryId, "e8");
    assert.equal((await store.turnWaiters.findById(waiter.id))?.status, "settled");
  });
});

describe("TurnWaiters: layer 2, the run ends unsettled", () => {
  test("a stopped or failed run ends its accepted waiters with the reason; unaccepted ones wait for the next run", async () => {
    const { store, turns, insertRun } = await setup();
    await insertRun("r1");
    const accepted = await turns.register({ sessionId: "s1", mailId: "m1" });
    const queued = await turns.register({ sessionId: "s1", mailId: "m2" });
    await turns.noteMailAccepted("s1", "r1", "m1", 2);

    await turns.noteRunEnded("r1"); // still running: nothing
    assert.equal((await turns.get(accepted.id))?.status, "open");

    await store.runs.update("r1", { state: "failed", reason: "error", statusDetail: "pi crashed" });
    await turns.noteRunEnded("r1");
    const ended = await turns.get(accepted.id);
    assert.equal(ended?.status, "ended");
    assert.equal(ended?.endReason, "run_failed");
    assert.equal(ended?.detail, "pi crashed");
    assert.equal((await turns.get(queued.id))?.status, "open", "its mail goes to the next run");

    await insertRun("r2");
    await turns.noteMailAccepted("s1", "r2", "m2", 4);
    await store.runs.update("r2", { state: "stopped", reason: "user" });
    await turns.noteRunEnded("r2");
    assert.equal((await turns.get(queued.id))?.endReason, "run_stopped");
  });

  test("a finished waiter is never overwritten: not by a settle, a run end, a cancel, or the sweep", async () => {
    const { store, turns, insertRun, advance } = await setup();
    await insertRun("r1");
    const canceled = await turns.register({ sessionId: "s1", mailId: "m1" });
    await turns.noteMailAccepted("s1", "r1", "m1", 1);
    assert.equal((await turns.cancel(canceled.id, "caller gave up"))?.endReason, "canceled");
    assert.equal(await turns.cancel(canceled.id), null, "a second cancel is a no-op");
    await turns.noteSettled("s1", "r1", 2, "e2");
    await store.runs.update("r1", { state: "failed" });
    await turns.noteRunEnded("r1");
    advance(TURN_WAITER_CAP_MS + MIN);
    await turns.sweep();
    const after = await turns.get(canceled.id);
    assert.equal(after?.status, "ended");
    assert.equal(after?.endReason, "canceled");
    assert.equal(after?.detail, "caller gave up");
    assert.equal(after?.settledEntryId, undefined);
  });
});

describe("TurnWaiters: layer 3, the deadline", () => {
  test("defaults to 60 minutes; an expired deadline is pushed out while the run works, up to the 4 h cap, then the run is stopped first", async () => {
    const { store, turns, stops, advance, now, insertRun } = await setup();
    await insertRun("r1");
    const waiter = await turns.register({ sessionId: "s1", mailId: "m1" });
    assert.equal(Date.parse(waiter.deadlineAt), T0 + TURN_WAITER_DEADLINE_MS);
    assert.equal(Date.parse(waiter.capAt), T0 + TURN_WAITER_CAP_MS);
    await turns.noteMailAccepted("s1", "r1", "m1", 1);

    advance(TURN_WAITER_DEADLINE_MS - MIN);
    assert.deepEqual(await turns.sweep(), { ended: 0, extended: 0 }, "not due yet");

    advance(2 * MIN);
    await store.runs.update("r1", { lastActivityAt: iso(now() - 2 * MIN) });
    assert.deepEqual(await turns.sweep(), { ended: 0, extended: 1 });
    assert.equal((await turns.get(waiter.id))?.deadlineAt, iso(now() - 2 * MIN + TURN_WAITER_ACTIVITY_MS));
    assert.equal(stops.length, 0);

    // Busy right up to the cap: extended to the cap, never past it, then expired there.
    while (now() < T0 + TURN_WAITER_CAP_MS) {
      advance(5 * MIN);
      await store.runs.update("r1", { lastActivityAt: iso(now()) });
      await turns.sweep();
      assert.ok(Date.parse((await turns.get(waiter.id))!.deadlineAt) <= T0 + TURN_WAITER_CAP_MS);
    }
    const done = await turns.get(waiter.id);
    assert.equal(done?.status, "ended");
    assert.equal(done?.endReason, "deadline");
    assert.match(done?.detail ?? "", /4 hour/);
    assert.equal(stops.length, 1);
    assert.equal(stops[0]!.runId, "r1");
    assert.equal(stops[0]!.reason, "deadline");
    assert.deepEqual(stops[0]!.waiters.map((w) => w.id), [waiter.id], "the run is stopped while the waiter is still open");
  });

  test("no activity in the last 10 minutes: the deadline expires, stopping an idle run; a provisioning run counts from its start", async () => {
    const { store, turns, stops, advance, now, insertRun, insertMail } = await setup();
    await insertRun("r1", { state: "idle", lastActivityAt: iso(T0) });
    const idle = await turns.register({ sessionId: "s1", mailId: "m1", deadlineMs: 5 * MIN });
    await turns.noteMailAccepted("s1", "r1", "m1", 1);
    advance(6 * MIN);
    await store.runs.update("r1", { lastActivityAt: iso(now()) });
    await turns.sweep();
    assert.equal((await turns.get(idle.id))?.endReason, "deadline", "idle is not working, recent activity or not");
    assert.deepEqual(stops.map((s) => s.reason), ["deadline"]);

    await insertRun("r2", { state: "provisioning" });
    await insertMail({ id: "m2" });
    const waking = await turns.register({ sessionId: "s1", mailId: "m2", deadlineMs: 0 });
    await turns.sweep();
    assert.equal((await turns.get(waking.id))?.status, "open", "a run started under 10 minutes ago is still coming up");
    advance(TURN_WAITER_ACTIVITY_MS);
    await turns.sweep();
    const ended = await turns.get(waking.id);
    assert.equal(ended?.endReason, "deadline");
    assert.match(ended?.detail ?? "", /not picked up/);
    assert.equal(stops.length, 1, "no run accepted the mail: the session's run is left alone");
  });
});

describe("TurnWaiters: the sweep", () => {
  test("ends waiters whose run ended without a bye or whose mail is dead or held, and adopts a missed acceptance", async () => {
    const { store, turns, advance, insertRun, insertMail } = await setup();
    await insertRun("r1");
    const lost = await turns.register({ sessionId: "s1", mailId: "m1" });
    await turns.noteMailAccepted("s1", "r1", "m1", 1);
    await store.runs.update("r1", { state: "failed", statusDetail: "this run's sandbox stopped reporting" });

    await insertMail({ id: "dead", status: "dead" });
    const dead = await turns.register({ sessionId: "s1", mailId: "dead" });
    await insertMail({ id: "held", status: "held", heldDetail: "no GitHub credential" });
    const held = await turns.register({ sessionId: "s1", mailId: "held" });
    await insertMail({ id: "queued" });
    const missed = await turns.register({ sessionId: "s1", mailId: "queued" });
    await insertRun("r2", { state: "idle" });
    await store.mail.claimNext("s1", "r2", iso(T0), iso(T0 + MIN), 6);
    await store.mail.ack("queued", "r2", iso(T0));
    advance(TURN_WAITER_ADOPT_AFTER_MS);

    assert.deepEqual(await turns.sweep(), { ended: 3, extended: 0 });
    assert.equal((await turns.get(lost.id))?.endReason, "run_failed");
    assert.equal((await turns.get(dead.id))?.endReason, "mail_dead");
    assert.equal((await turns.get(held.id))?.detail, "no GitHub credential");
    const adopted = await turns.get(missed.id);
    assert.equal(adopted?.status, "open");
    assert.equal(adopted?.ackRunId, "r2");
    await turns.noteSettled("s1", "r2", 40);
    assert.equal((await turns.get(missed.id))?.status, "settled");
  });
});

function waiterRow(id: string, sessionId: string, createdAt: string): TurnWaiter {
  return { id, sessionId, mailId: `mail-${id}`, status: "open", createdAt, updatedAt: createdAt, deadlineAt: createdAt, capAt: createdAt };
}

function contract(name: string, getStore: () => Store) {
  describe(`${name}: turnWaiters collection`, () => {
    test("markAcked once, finish only while open, extendDeadline, listOpen oldest first, deleteForSession", async () => {
      const store = getStore();
      const sessionId = `s-${randomUUID().slice(0, 8)}`;
      await store.turnWaiters.insert(waiterRow(`${sessionId}-b`, sessionId, "2026-10-01T00:00:02.000Z"));
      await store.turnWaiters.insert(waiterRow(`${sessionId}-a`, sessionId, "2026-10-01T00:00:01.000Z"));
      await store.turnWaiters.insert(waiterRow(`${sessionId}-x`, `other-${sessionId}`, "2026-10-01T00:00:00.000Z"));

      assert.equal(await store.turnWaiters.markAcked(sessionId, `mail-${sessionId}-a`, "r1", 4, "2026-10-01T00:01:00.000Z"), 1);
      assert.equal(await store.turnWaiters.markAcked(sessionId, `mail-${sessionId}-a`, "r1", 9, "2026-10-01T00:02:00.000Z"), 0);
      const acked = await store.turnWaiters.findById(`${sessionId}-a`);
      assert.equal(acked?.ackRunId, "r1");
      assert.equal(acked?.ackSeq, 4);

      assert.deepEqual((await store.turnWaiters.listOpenForSession(sessionId)).map((w) => w.id), [`${sessionId}-a`, `${sessionId}-b`]);
      assert.equal(await store.turnWaiters.extendDeadline(`${sessionId}-b`, "2026-10-01T01:00:00.000Z", "2026-10-01T00:03:00.000Z"), true);
      assert.equal((await store.turnWaiters.findById(`${sessionId}-b`))?.deadlineAt, "2026-10-01T01:00:00.000Z");
      assert.equal(await store.turnWaiters.extendDeadline(`${sessionId}-b`, "2026-10-01T00:30:00.000Z", "2026-10-01T00:03:00.000Z"), false, "never backwards");

      // A provisional acceptance (from the mail) yields to pi's response, never the other way.
      assert.equal(await store.turnWaiters.markAcked(sessionId, `mail-${sessionId}-b`, "r1", 2, "2026-10-01T00:03:00.000Z", true), 1);
      assert.equal(await store.turnWaiters.markAcked(sessionId, `mail-${sessionId}-b`, "r1", 3, "2026-10-01T00:03:00.000Z", true), 0);
      assert.equal((await store.turnWaiters.findById(`${sessionId}-b`))?.ackFromMail, true);
      assert.equal(await store.turnWaiters.markAcked(sessionId, `mail-${sessionId}-b`, "r1", 6, "2026-10-01T00:03:00.000Z"), 1);
      const real = await store.turnWaiters.findById(`${sessionId}-b`);
      assert.equal(real?.ackSeq, 6);
      assert.equal("ackFromMail" in real!, false);

      const settled = await store.turnWaiters.finish(`${sessionId}-a`, { status: "settled", settledEntryId: undefined }, "2026-10-01T00:04:00.000Z");
      assert.equal(settled?.status, "settled");
      assert.equal(settled?.finishedAt, "2026-10-01T00:04:00.000Z");
      assert.equal("settledEntryId" in settled!, false, "absent, not null");
      assert.equal("expireAt" in settled!, false, "Mongo's TTL field stays internal");
      assert.equal(await store.turnWaiters.finish(`${sessionId}-a`, { status: "ended", endReason: "canceled" }, "2026-10-01T00:05:00.000Z"), null);
      assert.equal((await store.turnWaiters.findById(`${sessionId}-a`))?.status, "settled");
      assert.equal(await store.turnWaiters.extendDeadline(`${sessionId}-a`, "2026-10-01T02:00:00.000Z", "2026-10-01T00:06:00.000Z"), false);

      const open = (await store.turnWaiters.listOpen(100)).filter((w) => w.sessionId.endsWith(sessionId));
      assert.deepEqual(open.map((w) => w.id), [`${sessionId}-x`, `${sessionId}-b`]);
      assert.equal(await store.turnWaiters.deleteForSession(sessionId), 2);
      assert.equal(await store.turnWaiters.findById(`${sessionId}-b`), null);
      assert.ok(await store.turnWaiters.findById(`${sessionId}-x`));
    });
  });
}

contract("MemoryStore", (() => {
  const store = new MemoryStore();
  return () => store;
})());

describe("MongoStore", () => {
  const DB_NAME = `outfitter_turns_${randomUUID().slice(0, 8)}`;
  let mongo: MongoStore;
  let server: { stop(): Promise<unknown> } | undefined;

  before(async () => {
    let uri = process.env.OUTFITTER_TEST_MONGODB_URI;
    if (!uri) {
      const { MongoMemoryServer } = await import("mongodb-memory-server");
      const started = await MongoMemoryServer.create();
      server = started;
      uri = started.getUri();
    }
    mongo = await MongoStore.connect(uri, DB_NAME);
  }, { timeout: 120_000 });

  after(async () => {
    // @ts-expect-error -- reach past the Store interface to drop the scratch database itself.
    await mongo.client?.db(DB_NAME).dropDatabase();
    await mongo.close();
    await server?.stop();
  });

  contract("MongoStore", () => mongo);
});

describe("turn waiters over the agentd socket and /api/hooks/tick", () => {
  const TASKS_AUTH = { authorization: "Bearer test-agent-token" };

  async function waitFor(check: () => Promise<unknown>, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  test("pi's response to the mail, then agent_settled with lastEntryId, settles the waiter; a settle before it doesn't", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app, { repo: null });
    const waiter = await app.turns.register({ sessionId: session.id, mailId: "task-1" });
    await app.mail.post({ sessionId: session.id, from: { kind: "system" }, text: "do it", id: "task-1" });

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    assert.equal((await agent.nextMessage()).t, "run.spec");
    agent.send({ t: "status", state: "idle" });
    const mail = await agent.nextMessage();
    assert.equal(mail.t, "mail");
    assert.equal(mail.id, "task-1");

    agent.send({ t: "event", seq: 1, event: { type: "agent_settled" } }); // a turn already finishing
    agent.send({ t: "event", seq: 2, event: { type: "response", id: "mail:task-1", command: "prompt", success: true } });
    agent.send({ t: "mail.ack", id: "task-1" });
    agent.send({ t: "entry", seq: 3, entry: { id: "e-final", parentId: null, type: "message", message: { role: "assistant", content: [] } } });
    for (let seq = 1; seq <= 3; seq++) assert.equal((await agent.nextMessage()).seq, seq);
    assert.equal((await app.turns.get(waiter.id))?.status, "open");

    agent.send({ t: "event", seq: 4, event: { type: "agent_settled", lastEntryId: "e-final" } });
    await waitFor(async () => (await app.turns.get(waiter.id))?.status === "settled", "the settle");
    assert.equal((await app.turns.get(waiter.id))?.settledEntryId, "e-final");
    assert.equal((await app.store.sessions.findById(session.id))?.settledEntryId, "e-final");

    agent.send({ t: "bye", reason: "idle" });
    await agent.nextClose();
    assert.equal((await app.turns.get(waiter.id))?.status, "settled", "the bye doesn't touch a settled waiter");
    await app.fastify.close();
  });

  test("a bye with reason error ends an accepted, unsettled waiter as run_failed", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app, { repo: null });
    const waiter = await app.turns.register({ sessionId: session.id, mailId: "task-2" });
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    assert.equal((await agent.nextMessage()).t, "run.spec");
    agent.send({ t: "event", seq: 1, event: { type: "response", id: "mail:task-2", command: "prompt", success: true } });
    assert.equal((await agent.nextMessage()).seq, 1);
    agent.send({ t: "bye", reason: "error", message: "pi exited" });
    await agent.nextClose();
    const ended = await app.turns.get(waiter.id);
    assert.equal(ended?.status, "ended");
    assert.equal(ended?.endReason, "run_failed");
    await app.fastify.close();
  });

  test("the tick sweeps an expired waiter, stopping the run that accepted its mail", async () => {
    const app = await buildTestApp();
    const { session, runId } = await makeRunningSession(app, { repo: null });
    const waiter = await app.turns.register({ sessionId: session.id, mailId: "never-posted", deadlineMs: 0 });
    await app.turns.noteMailAccepted(session.id, runId, "never-posted", 1);
    await app.store.mail.insertIfNew({ id: "never-posted", sessionId: session.id, from: { kind: "system" }, text: "x", behavior: "followUp", status: "queued", attempts: 0, createdAt: new Date().toISOString() });
    await app.store.runs.update(runId, { state: "running", lastSeenAt: new Date().toISOString(), lastActivityAt: new Date(Date.now() - 20 * MIN).toISOString() });
    const tick = await app.fastify.inject({ method: "POST", url: "/api/hooks/tick", headers: TASKS_AUTH });
    assert.equal(tick.statusCode, 200);
    assert.deepEqual(tick.json().turns, { ended: 1, extended: 0 });
    assert.equal((await app.turns.get(waiter.id))?.endReason, "deadline");
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "stopped");
    assert.equal(run?.reason, "deadline");
    await app.fastify.close();
  });
});
