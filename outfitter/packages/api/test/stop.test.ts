// Graceful stop (routes/sessions.ts POST /stop, RunManager.reconcileStoppingOnce) and up-frame
// ordering (agentlink.ts). Two production bugs, both observed on the deployed stack where
// outfitter-api (web role) and outfitter-link (link role) are separate Cloud Run services sharing
// one Atlas store:
//
// 1. `/stop` used to branch on `agentLink.hasSocket(run.id)`, which is process-local and always
//    false on the web role (it never holds an agentd socket at all -- see docs/protocol.md "Two
//    origins"), so it fell through to a provider cancel (SIGTERM) instead of the graceful `stop`
//    down-message. The fix always enqueues `stop` through the store and marks the run `stopping`;
//    the link role's poller (or this process, if it happens to hold the socket) delivers it, and
//    the reconciler cancels via the provider only if the run is still `stopping` past
//    STOP_GRACE_MS.
// 2. Up-frames on one socket used to be handled concurrently (no await between messages), so a
//    `status` frame's store update could land after a `bye` right behind it and overwrite the
//    terminal state. The fix serializes handling per connection and makes `bye` final.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { NoopProvider } from "../src/providers/noop.ts";
import { RunManager } from "../src/runs.ts";
import { API_PROTOCOL_VERSION } from "../src/agentlink.ts";
import { buildTestApp, seedGuru } from "./helpers.ts";
import type { Session, Run, RunsCollection, DownMessage, Store } from "../src/store/types.ts";

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    sessionId: "s1",
    state: "running",
    lastAckedSeq: 0,
    pending: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("RunManager.reconcileStoppingOnce", () => {
  test("cancels a run stuck in stopping past the grace, marking it stopped", async () => {
    const store = new MemoryStore();
    const provider = new NoopProvider();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const runs = new RunManager(store, provider, config);

    const staleAt = new Date(Date.now() - 5 * 60_000).toISOString(); // well past any grace
    const run = makeRun({ state: "stopping", updatedAt: staleAt, providerHandle: "exec-stop-1" });
    await store.runs.insert(run);

    await runs.reconcileStoppingOnce(60_000);

    assert.equal(provider.stopCalls.length, 1);
    assert.equal(provider.stopCalls[0], "exec-stop-1");
    const stored = await store.runs.findById(run.id);
    assert.equal(stored?.state, "stopped");
    assert.equal(stored?.reason, "stop grace expired");
  });

  test("leaves a run alone while still inside the grace window", async () => {
    const store = new MemoryStore();
    const provider = new NoopProvider();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const runs = new RunManager(store, provider, config);

    const recentlyStopping = new Date(Date.now() - 1_000).toISOString();
    const run = makeRun({ state: "stopping", updatedAt: recentlyStopping, providerHandle: "exec-stop-2" });
    await store.runs.insert(run);

    await runs.reconcileStoppingOnce(60_000);

    assert.equal(provider.stopCalls.length, 0);
    const stored = await store.runs.findById(run.id);
    assert.equal(stored?.state, "stopping");
  });
});

// --- Below: WebSocket-level tests, following the same scaffolding as agentlink.test.ts (its
// helpers aren't exported, so the minimal pieces needed here are duplicated). ---

function makeQueue<T>() {
  const items: T[] = [];
  const waiters: Array<(v: T) => void> = [];
  return {
    push(v: T) {
      const waiter = waiters.shift();
      if (waiter) waiter(v);
      else items.push(v);
    },
    next(): Promise<T> {
      const item = items.shift();
      if (item !== undefined) return Promise.resolve(item);
      return new Promise((resolve) => waiters.push(resolve));
    },
    count(): number {
      return items.length;
    },
  };
}

interface SocketHandle {
  send: (frame: unknown) => void;
  nextMessage: () => Promise<any>;
  nextClose: () => Promise<{ code: number; reason: string }>;
  messageCount: () => number;
}

async function openAgentSocket(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  runId: string,
  token = "test-agent-token",
): Promise<SocketHandle> {
  const messages = makeQueue<any>();
  const closes = makeQueue<{ code: number; reason: string }>();
  const ws = await app.fastify.injectWS(
    `/agent/ws?run=${runId}`,
    { headers: { authorization: `Bearer ${token}` } } as any,
    {
      onInit(socket: any) {
        socket.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));
        socket.on("close", (code: number, reason: Buffer) => closes.push({ code, reason: reason?.toString() ?? "" }));
      },
    } as any,
  );
  return {
    send: (frame: unknown) => ws.send(JSON.stringify(frame)),
    nextMessage: messages.next,
    nextClose: async () => {
      const close = await closes.next();
      ws.terminate();
      return close;
    },
    messageCount: messages.count,
  };
}

function runTokenFor(app: Awaited<ReturnType<typeof buildTestApp>>, runId: string): string {
  const call = [...app.provider.startCalls].reverse().find((c) => c.runId === runId);
  if (!call) throw new Error(`no provider.start call recorded for run ${runId}`);
  return call.runToken;
}

async function makeRunningSession(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  overrides: Partial<Session> = {},
): Promise<{ session: Session; runId: string; runToken: string }> {
  await seedGuru(app.store);
  const now = new Date().toISOString();
  const session: Session = {
    id: overrides.id ?? "s1",
    guruId: "test-guru",
    repo: "o/r",
    branch: "main",
    status: "open",
    cost: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await app.store.sessions.insert(session);
  const run = await app.runs.wake(session.id);
  return { session, runId: run.id, runToken: runTokenFor(app, run.id) };
}

function sendHello(agent: SocketHandle, runId: string, sessionId: string, runToken: string, lastAckedSeq = 0): void {
  // protocolVersion must match agentlink.ts's API_PROTOCOL_VERSION (bug 9, docs/reports/cloud-fixes.md)
  // or the connection is refused with 4409 before this test gets anywhere.
  agent.send({ t: "hello", runId, sessionId, lastAckedSeq, runToken, protocolVersion: API_PROTOCOL_VERSION });
}

describe("POST /api/sessions/:id/stop (graceful, process-independent)", () => {
  test("enqueues the stop down-message and marks the run stopping, even on a process holding no socket for it", async () => {
    const store = new MemoryStore();
    // "owner" mirrors outfitter-link: it holds the real agentd socket. "sender" mirrors
    // outfitter-api (web role): it never holds a socket for any run at all -- the exact condition
    // under which the old `ctx.agentLink.hasSocket(run.id)` check was always false and fell
    // through to a provider cancel (SIGTERM) instead of a graceful stop.
    const owner = await buildTestApp({}, { store });
    const sender = await buildTestApp({}, { store });

    const { session, runId, runToken } = await makeRunningSession(owner);
    const agent = await openAgentSocket(owner, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec
    agent.send({ t: "status", state: "running" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sender.agentLink.hasSocket(runId), false);

    const res = await sender.fastify.inject({ method: "POST", url: `/api/sessions/${session.id}/stop` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().run.state, "stopping");

    // No SIGTERM-equivalent provider.stop was ever called on either process.
    assert.equal(owner.provider.stopCalls.length, 0);
    assert.equal(sender.provider.stopCalls.length, 0);

    const stored = await store.runs.findById(runId);
    assert.equal(stored?.state, "stopping");
    // Enqueued in the shared store rather than delivered directly (sender has no socket for it).
    assert.equal(stored?.pending.length, 1);
    assert.deepEqual(stored?.pending[0], { t: "stop", reason: "user" });

    // The owning process's poller (or, in this test, a direct call to it -- see
    // agentlink.test.ts's cross-process delivery test for why that's deterministic) delivers the
    // graceful stop over the socket it actually holds, and agentd's bye then finishes the job.
    await owner.agentLink.pollDownQueuesOnce();
    const delivered = await agent.nextMessage();
    assert.deepEqual(delivered, { t: "stop", reason: "user" });

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    const final = await store.runs.findById(runId);
    assert.equal(final?.state, "stopped");

    owner.stopBackgroundTasks();
    sender.stopBackgroundTasks();
    await owner.fastify.close();
    await sender.fastify.close();
  });

  test("code review M2: a second /stop while already stopping is a no-op, not a force-cancel", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);
    const createRes = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "hi" },
    });
    const { session, run } = createRes.json();

    // Simulate a first /stop already having put the run into "stopping" (mid-drain, e.g. a
    // checkpoint push in flight) without going through the route again.
    await app.store.runs.update(run.id, { state: "stopping", updatedAt: new Date().toISOString() });

    const res = await app.fastify.inject({ method: "POST", url: `/api/sessions/${session.id}/stop` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().run.state, "stopping");
    // The old collapsed branch would have taken this as "no live agent, cancel directly" and
    // force-killed the run via the provider -- assert that never happens.
    assert.equal(app.provider.stopCalls.length, 0);

    const stored = await app.store.runs.findById(run.id);
    assert.equal(stored?.state, "stopping");

    await app.fastify.close();
  });

  test("cancels via the provider directly for a queued/provisioning run (no live agent to ask gracefully)", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);
    const createRes = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { guruId: "test-guru", repo: "o/r", prompt: "hi" },
    });
    const { session, run } = createRes.json();
    assert.equal(run.state, "provisioning");

    const res = await app.fastify.inject({ method: "POST", url: `/api/sessions/${session.id}/stop` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().run.state, "stopped");
    assert.equal(app.provider.stopCalls.length, 1);

    await app.fastify.close();
  });
});

describe("agentlink up-frame ordering", () => {
  test("frames on one socket are applied in arrival order, even when an earlier frame's store update resolves later", async () => {
    // Wraps MemoryStore's runs collection so the *first* call to update() is artificially delayed,
    // simulating a store whose update can resolve out of order relative to a later call. Before
    // per-connection serialization, handleUpFrame calls for two frames sent back-to-back ran
    // concurrently, so whichever frame's update settled last won -- regardless of which frame
    // actually arrived first. With serialization, the second frame's handling can't even start
    // until the first's (including this delayed update) has fully settled, so the final state
    // always reflects arrival order.
    const inner = new MemoryStore();
    let firstUpdateSeen = false;
    const delayingRuns: RunsCollection = {
      insert: (r) => inner.runs.insert(r),
      insertIfNoActive: (r) => inner.runs.insertIfNoActive(r),
      findById: (id) => inner.runs.findById(id),
      findActiveForSession: (s) => inner.runs.findActiveForSession(s),
      findLatestForSession: (s) => inner.runs.findLatestForSession(s),
      listForSession: (s) => inner.runs.listForSession(s),
      async update(id, patch) {
        if (!firstUpdateSeen) {
          firstUpdateSeen = true;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return inner.runs.update(id, patch);
      },
      listStale: (c) => inner.runs.listStale(c),
      listStopping: (c) => inner.runs.listStopping(c),
      enqueueDownMessage: (id, m: DownMessage) => inner.runs.enqueueDownMessage(id, m),
      drainDownMessages: (id) => inner.runs.drainDownMessages(id),
      claimGithubIdempotency: (id, key, pending) => inner.runs.claimGithubIdempotency(id, key, pending),
      finishGithubIdempotency: (id, key, result) => inner.runs.finishGithubIdempotency(id, key, result),
    };
    const store: Store = {
      sessions: inner.sessions,
      entries: inner.entries,
      runs: delayingRuns,
      mail: inner.mail,
      gurus: inner.gurus,
      environments: inner.environments,
      users: inner.users,
      providers: inner.providers,
      tokens: inner.tokens,
      browserShares: inner.browserShares,
      browserRequests: inner.browserRequests,
      browserCaptures: inner.browserCaptures,
      close: () => inner.close(),
    };

    const app = await buildTestApp({}, { store });
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

    // Sent back-to-back, no await between them: a `status` frame whose resulting store update is
    // the (artificially delayed) first update call, immediately followed by `bye`.
    agent.send({ t: "status", state: "stopping" });
    agent.send({ t: "bye", reason: "stop" });

    const close = await agent.nextClose();
    assert.equal(close.code, 1000);

    // If frames were handled concurrently, bye's fast update could finish first and then get
    // silently overwritten once status's delayed update resolves after it. Serialized, status
    // fully finishes (including the 50ms delay) before bye is even processed, so bye's terminal
    // "stopped" is always the one that lands last.
    const stored = await app.store.runs.findById(runId);
    assert.equal(stored?.state, "stopped");

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a bye followed by a late status leaves the run stopped (bye is final)", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

    // bye first; a status frame that arrives right behind it (e.g. already in flight when bye was
    // processed) must not resurrect the run out of its terminal state.
    agent.send({ t: "bye", reason: "stop" });
    agent.send({ t: "status", state: "running" });
    await agent.nextClose();

    const stored = await app.store.runs.findById(runId);
    assert.equal(stored?.state, "stopped");

    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});
