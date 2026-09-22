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
