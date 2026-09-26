// Bug 2 (docs/reports/cloud-fixes.md): the session page kept showing STOPPED and no new entries
// after a run went provisioning -> idle -> running and answered, because in a split deployment the
// "link" role's process (agentd's WebSocket, AgentLink.publish) and the "web" role's process
// (browser SSE subscribers) are different Cloud Run services with no shared memory -- an
// in-process SseHub publish on one never reaches subscribers on the other.
//
// This test reproduces the split deployment directly: two independent SseHub instances (one per
// "process"), sharing one MemoryStore, exactly as the real two roles share one Atlas store. Writes
// that mimic agentd's frames land in the store the way agentlink.ts writes them (bypassing the
// "link" hub, as a real cross-process write would). The "web" role's SsePoller, watching its own
// hub, must still see the update once it polls.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory.ts";
import { SseHub, SsePoller } from "../src/sse.ts";
import type { FastifyReply } from "fastify";
import type { Run, Session } from "../src/store/types.ts";

function fakeSubscriber(): { reply: FastifyReply; frames: string[] } {
  const frames: string[] = [];
  const listeners: Record<string, () => void> = {};
  const reply = {
    raw: {
      writeHead() {},
      flushHeaders() {},
      write(chunk: string) {
        frames.push(chunk);
        return true;
      },
      on(event: string, cb: () => void) {
        listeners[event] = cb;
      },
      close() {
        listeners.close?.();
      },
    },
  } as unknown as FastifyReply;
  return { reply, frames };
}

async function seedSession(store: MemoryStore, id: string): Promise<void> {
  const now = new Date().toISOString();
  const session: Session = {
    id,
    guruId: "g",
    repo: null,
    status: "open",
    cost: 0,
    createdAt: now,
    updatedAt: now,
  };
  await store.sessions.insert(session);
}

describe("SsePoller (bug 2: split web/link deployment)", () => {
  test("delivers entries and run-state changes written by another process's role to this process's subscribers", async () => {
    const store = new MemoryStore(); // shared Atlas store, stands in for both roles
    const webHub = new SseHub(); // "web" role's process: browsers subscribe here
    const poller = new SsePoller(webHub, store, 5 /* ms, fast for the test */);

    await seedSession(store, "s1");
    const { reply, frames } = fakeSubscriber();
    webHub.subscribe("s1", reply);
    poller.watch("s1");

    // Simulate the "link" role's process: agentd connects, agentlink.ts writes straight into the
    // shared store (as handleUpFrame does for "status" and "entry" frames) -- note this never
    // touches webHub, exactly like the real cross-process case.
    const now = new Date().toISOString();
    const run: Run = {
      id: "r1",
      sessionId: "s1",
      state: "provisioning",
      lastAckedSeq: 0,
      pending: [],
      createdAt: now,
      updatedAt: now,
    };
    await store.runs.insert(run);
    await store.runs.update("r1", { state: "running", updatedAt: now });
    await store.entries.insertIfNew("s1", 1, { id: "e1", type: "message", role: "assistant", text: "hi" });

    await poller.pollOne("s1");

    const statusFrames = frames.filter((f) => f.startsWith("event: status"));
    const entryFrames = frames.filter((f) => f.startsWith("event: entry"));
    assert.ok(statusFrames.some((f) => f.includes('"state":"running"')), "run-state change must reach the web-role subscriber");
    assert.ok(entryFrames.some((f) => f.includes('"id":"e1"')), "new entry must reach the web-role subscriber");
  });

  test("reflects a run leaving the active set as status: stopped, once", async () => {
    const store = new MemoryStore();
    const webHub = new SseHub();
    const poller = new SsePoller(webHub, store, 5);
    await seedSession(store, "s2");
    const { reply, frames } = fakeSubscriber();
    webHub.subscribe("s2", reply);
    poller.watch("s2");

    const now = new Date().toISOString();
    await store.runs.insert({ id: "r2", sessionId: "s2", state: "idle", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now });
    await poller.pollOne("s2"); // running/idle seen

    await store.runs.update("r2", { state: "stopped", updatedAt: now }); // bye idle -> stopped, no longer "active"
    frames.length = 0;
    await poller.pollOne("s2");
    await poller.pollOne("s2"); // second poll must not re-send the same stopped status

    const statusFrames = frames.filter((f) => f.startsWith("event: status"));
    assert.equal(statusFrames.length, 1, "stopped status published exactly once, not every tick");
    assert.ok(statusFrames[0].includes('"state":"stopped"'));
  });

  test("stops polling a session once its last subscriber disconnects", async () => {
    const store = new MemoryStore();
    const webHub = new SseHub();
    const poller = new SsePoller(webHub, store, 5);
    await seedSession(store, "s3");
    const { reply } = fakeSubscriber();
    webHub.subscribe("s3", reply);
    poller.watch("s3");

    (reply.raw as unknown as { close: () => void }).close();
    poller.unwatch("s3");

    // pollAll must not throw or touch a session nobody is watching anymore.
    await poller.pollAll();
    poller.stop();
  });
});

describe("SsePoller liveness (#182)", () => {
  function livenessFrames(frames: string[]) {
    return frames
      .filter((f) => f.startsWith("event: liveness"))
      .map((f) => JSON.parse(f.split("data: ")[1]) as { seenAgoMs?: number; activityAgoMs?: number });
  }

  test("sends how long ago agentd spoke and pi acted, as ages, once per change", async () => {
    const store = new MemoryStore();
    const webHub = new SseHub();
    const poller = new SsePoller(webHub, store, 5);
    await seedSession(store, "sl");
    const { reply, frames } = fakeSubscriber();
    webHub.subscribe("sl", reply);
    poller.watch("sl");

    const t = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    await store.runs.insert({
      id: "rl",
      sessionId: "sl",
      state: "running",
      lastAckedSeq: 0,
      pending: [],
      lastSeenAt: iso(t - 5_000),
      lastActivityAt: iso(t - 180_000),
      createdAt: iso(t),
      updatedAt: iso(t),
    });
    await poller.pollOne("sl");
    await poller.pollOne("sl"); // nothing changed: no second frame

    let sent = livenessFrames(frames);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].seenAgoMs! >= 5_000 && sent[0].seenAgoMs! < 10_000);
    assert.ok(sent[0].activityAgoMs! >= 180_000 && sent[0].activityAgoMs! < 185_000);

    // A heartbeat moves lastSeenAt only: the page learns agentd is alive though pi is still quiet.
    await store.runs.update("rl", { lastSeenAt: iso(Date.now()) });
    await poller.pollOne("sl");
    sent = livenessFrames(frames);
    assert.equal(sent.length, 2);
    assert.ok(sent[1].seenAgoMs! < 1_000);
    assert.ok(sent[1].activityAgoMs! >= 180_000);
  });

  test("nothing for a run agentd hasn't reached yet, or for no active run", async () => {
    const store = new MemoryStore();
    const webHub = new SseHub();
    const poller = new SsePoller(webHub, store, 5);
    await seedSession(store, "sn");
    const { reply, frames } = fakeSubscriber();
    webHub.subscribe("sn", reply);
    poller.watch("sn");
    await poller.pollOne("sn");
    const now = new Date().toISOString();
    await store.runs.insert({ id: "rn", sessionId: "sn", state: "provisioning", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now });
    await poller.pollOne("sn");
    assert.equal(livenessFrames(frames).length, 0);
  });
});

describe("SsePoller entry window (review fix)", () => {
  test("publishes a later run's entries even though agentd's seq restarted below the last one seen", async () => {
    const store = new MemoryStore();
    const webHub = new SseHub();
    const poller = new SsePoller(webHub, store, 5);
    await seedSession(store, "s4");
    const { reply, frames } = fakeSubscriber();
    webHub.subscribe("s4", reply);
    poller.watch("s4");

    // Run 1: entries interleaved with many events, so its last entry carries a high seq.
    await store.entries.insertIfNew("s4", 3, { id: "a", type: "message" });
    await store.entries.insertIfNew("s4", 900, { id: "b", type: "message" });
    await poller.pollOne("s4");
    frames.length = 0;

    // Run 2: a fresh agentd, seq restarted; its first new entry has seq 7.
    await store.entries.insertIfNew("s4", 7, { id: "c", type: "message" });
    await poller.pollOne("s4");
    await poller.pollOne("s4");

    const entryFrames = frames.filter((f) => f.startsWith("event: entry"));
    assert.equal(entryFrames.length, 1, "the new entry is published exactly once");
    assert.ok(entryFrames[0].includes('"id":"c"'));
    poller.stop();
  });
});

// A statusDetail belongs to one run: agentlink.ts's refuse() writes the api's reason for refusing a
// run's agent there, and the session page renders it as its own note. Since a status event with no
// `detail` deliberately leaves the last note standing (agentd sends state-only frames constantly)
// and a fresh run has no detail of its own, a dead run's note used to stay pinned over its
// successor -- press Play after a refused run and the old alert was still there.
describe("SsePoller statusDetail belongs to one run", () => {
  test("a failed run's note is published, then explicitly cleared when a new run appears", async () => {
    const store = new MemoryStore();
    const webHub = new SseHub();
    const poller = new SsePoller(webHub, store, 5);
    await seedSession(store, "s5");
    const { reply, frames } = fakeSubscriber();
    webHub.subscribe("s5", reply);
    poller.watch("s5");

    const now = new Date().toISOString();
    await store.runs.insert({ id: "r5a", sessionId: "s5", state: "provisioning", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now });
    await poller.pollOne("s5");

    // What refuse() writes for a repo session with no GitHub token secret.
    await store.runs.update("r5a", {
      state: "failed",
      reason: "missing github token secret for session s5",
      statusDetail: "no GitHub token is stored for this session, so its sandbox can't clone the repo.",
      updatedAt: new Date().toISOString(),
    });
    frames.length = 0;
    await poller.pollOne("s5");
    const failedFrame = frames.filter((f) => f.startsWith("event: status")).at(-1) ?? "";
    assert.ok(failedFrame.includes('"state":"failed"'));
    assert.ok(failedFrame.includes("no GitHub token is stored"), "the note reaches the browser at all");
    assert.ok(failedFrame.includes("missing github token secret"), "and so does the short reason the header uses");

    // Press Play: a second run, with no statusDetail of its own.
    const later = new Date(Date.now() + 1000).toISOString();
    await store.runs.insert({ id: "r5b", sessionId: "s5", state: "provisioning", lastAckedSeq: 0, pending: [], createdAt: later, updatedAt: later });
    frames.length = 0;
    await poller.pollOne("s5");
    const freshFrame = frames.filter((f) => f.startsWith("event: status")).at(-1) ?? "";
    assert.ok(freshFrame.includes('"state":"provisioning"'));
    assert.ok(
      freshFrame.includes('"detail":null'),
      "an explicit null is what tells the browser to drop the previous run's note (see useSessionStream)",
    );
    poller.stop();
  });

  test("a state-only poll of the same run does not re-send or clear its note", async () => {
    const store = new MemoryStore();
    const webHub = new SseHub();
    const poller = new SsePoller(webHub, store, 5);
    await seedSession(store, "s6");
    const { reply, frames } = fakeSubscriber();
    webHub.subscribe("s6", reply);
    poller.watch("s6");

    const now = new Date().toISOString();
    await store.runs.insert({
      id: "r6",
      sessionId: "s6",
      state: "provisioning",
      statusDetail: "the api could not build this run's spec: secret manager unavailable. Retrying.",
      lastAckedSeq: 0,
      pending: [],
      createdAt: now,
      updatedAt: now,
    });
    await poller.pollOne("s6");
    frames.length = 0;
    await poller.pollOne("s6");
    await poller.pollOne("s6");

    assert.equal(frames.filter((f) => f.startsWith("event: status")).length, 0, "nothing changed, so nothing is re-sent");
    poller.stop();
  });
});

// A pending question is published when it appears. When it then disappears (answered, or the run
// left the active set) the browser has to be told: resetting lastUiRequestKey alone left the lamp
// blue. A session that never had a question must not get that clear frame on its first poll.
describe("SsePoller pending question clear", () => {
  test("publishes one clear frame when an answered question disappears, and none when there never was one", async () => {
    const store = new MemoryStore();
    const webHub = new SseHub();
    const poller = new SsePoller(webHub, store, 5);
    await seedSession(store, "s7");
    const { reply, frames } = fakeSubscriber();
    webHub.subscribe("s7", reply);
    poller.watch("s7");

    const now = new Date().toISOString();
    await store.runs.insert({
      id: "r7",
      sessionId: "s7",
      state: "running",
      lastAckedSeq: 0,
      pending: [],
      createdAt: now,
      updatedAt: now,
    });
    await poller.pollOne("s7");
    assert.equal(
      frames.filter((f) => f.startsWith("event: event")).length,
      0,
      "a session that never had a question must not get a clear frame",
    );

    const question = { type: "extension_ui_request", id: "q1", method: "confirm", title: "Ship it?" };
    await store.runs.update("r7", { pendingUiRequest: question, updatedAt: now });
    frames.length = 0;
    await poller.pollOne("s7");
    const questionFrames = frames.filter((f) => f.startsWith("event: event"));
    assert.equal(questionFrames.length, 1);
    assert.ok(questionFrames[0].includes('"id":"q1"'));
    assert.ok(!questionFrames[0].includes('"cleared":true'));

    // What POST /ui-response writes after the person answers.
    await store.runs.update("r7", { pendingUiRequest: undefined, updatedAt: now });
    frames.length = 0;
    await poller.pollOne("s7");
    await poller.pollOne("s7");
    const clearFrames = frames.filter((f) => f.startsWith("event: event"));
    assert.equal(clearFrames.length, 1, "the disappearance is published once");
    assert.ok(clearFrames[0].includes('"type":"extension_ui_request"'));
    assert.ok(clearFrames[0].includes('"cleared":true'));

    await store.runs.update("r7", {
      pendingUiRequest: { type: "extension_ui_request", id: "q2", method: "input" },
      updatedAt: now,
    });
    frames.length = 0;
    await poller.pollOne("s7");
    const again = frames.filter((f) => f.startsWith("event: event"));
    assert.equal(again.length, 1, "a later question is published again");
    assert.ok(again[0].includes('"id":"q2"'));
    poller.stop();
  });

  test("publishes one clear frame when the run stops with a question still stored", async () => {
    const store = new MemoryStore();
    const webHub = new SseHub();
    const poller = new SsePoller(webHub, store, 5);
    await seedSession(store, "s8");
    const { reply, frames } = fakeSubscriber();
    webHub.subscribe("s8", reply);
    poller.watch("s8");

    const now = new Date().toISOString();
    await store.runs.insert({
      id: "r8",
      sessionId: "s8",
      state: "running",
      pendingUiRequest: { type: "extension_ui_request", id: "q1", method: "select" },
      lastAckedSeq: 0,
      pending: [],
      createdAt: now,
      updatedAt: now,
    });
    await poller.pollOne("s8");
    frames.length = 0;

    // Stop does not have to wipe the field: the run is no longer active, so the question is gone.
    await store.runs.update("r8", { state: "stopped", updatedAt: now });
    await poller.pollOne("s8");
    await poller.pollOne("s8");

    const clearFrames = frames.filter((f) => f.startsWith("event: event") && f.includes('"cleared":true'));
    assert.equal(clearFrames.length, 1, "leaving the active set publishes the clear once");
    const statusFrames = frames.filter((f) => f.startsWith("event: status"));
    assert.ok(statusFrames.some((f) => f.includes('"state":"stopped"')));
    poller.stop();
  });
});
