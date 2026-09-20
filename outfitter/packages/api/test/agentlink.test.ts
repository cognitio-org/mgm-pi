import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedGuru } from "./helpers.ts";
import type { Session } from "../src/store/types.ts";

// injectWS's connect promise can resolve *after* the server has already written its first frame
// (run.spec is sent proactively, not in reply to a client message), so a `message` listener
// attached only once the promise resolves can miss it. `onInit` fires before the mock connection
// even starts, so listeners registered there never race the server.
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
  };
}

interface SocketHandle {
  send: (frame: unknown) => void;
  nextMessage: () => Promise<any>;
  // Resolves once the socket has closed (either side initiated) *and* force-terminates it
  // afterwards. `ws` keeps a ~30s ref'd close timer alive until the underlying socket fully ends,
  // which the injectWS test transport doesn't always signal promptly; terminate() clears it so
  // node:test's process can exit immediately instead of waiting out that timer.
  nextClose: () => Promise<{ code: number; reason: string }>;
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
  };
}

async function makeRunningSession(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  overrides: Partial<Session> = {},
): Promise<{ session: Session; runId: string }> {
  await seedGuru(app.store);
  const now = new Date().toISOString();
  const session: Session = {
    id: "s1",
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
  return { session, runId: run.id };
}

describe("agentd <-> api WebSocket", () => {
  test("connect sends run.spec, then hello/ack/entry-dedup/bye", async () => {
    const app = await buildTestApp();
    const { session, runId } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);

    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(spec.session.id, session.id);
    assert.equal(spec.repo.branch, "main");

    agent.send({ t: "hello", runId, sessionId: session.id, lastAckedSeq: 0 });

    // send the same entry twice; the second must be a no-op (idempotent on entry.id)
    const entry = { id: "e1", parentId: null, type: "message" };
    agent.send({ t: "entry", seq: 1, entry });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 1 });

    agent.send({ t: "entry", seq: 1, entry });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 1 });

    const stored = await app.store.entries.listForSession(session.id);
    assert.equal(stored.length, 1);

    agent.send({ t: "bye", reason: "stop" });
    const close = await agent.nextClose();
    assert.equal(close.code, 1000);

    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "stopped");

    app.stopReconciler();
    await app.fastify.close();
  });

  test("event frames are fanned out over SSE and acked", async () => {
    const app = await buildTestApp();
    const { session, runId } = await makeRunningSession(app);

    const received: { type: string; data: unknown }[] = [];
    const fakeReply = {
      raw: {
        writeHead: () => {},
        flushHeaders: () => {},
        write: (chunk: string) => {
          const [eventLine, dataLine] = chunk.split("\n");
          received.push({ type: eventLine.replace("event: ", ""), data: JSON.parse(dataLine.replace("data: ", "")) });
        },
        on: () => {},
      },
    };
    app.sse.subscribe(session.id, fakeReply as any);

    const agent = await openAgentSocket(app, runId);
    await agent.nextMessage(); // run.spec

    agent.send({ t: "event", seq: 1, event: { type: "agent_start" } });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 1 });

    assert.equal(received.length, 1);
    assert.equal(received[0].type, "event");
    assert.deepEqual(received[0].data, { type: "agent_start" });

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopReconciler();
    await app.fastify.close();
  });

  test("closes the connection with a bad token instead of sending run.spec", async () => {
    const app = await buildTestApp();
    const { runId } = await makeRunningSession(app);

    // the WS upgrade itself succeeds (auth happens after, inside the handler); the handler then
    // closes the socket rather than sending run.spec.
    const agent = await openAgentSocket(app, runId, "wrong-token");
    const close = await agent.nextClose();
    assert.equal(close.code, 4401);

    app.stopReconciler();
    await app.fastify.close();
  });

  test("run.spec omits repo and carries workspace for a repo-less session", async () => {
    const app = await buildTestApp();
    const { runId } = await makeRunningSession(app, { repo: null, branch: undefined });

    const agent = await openAgentSocket(app, runId);
    const spec = await agent.nextMessage();

    assert.equal(spec.repo, undefined);
    // JSON drops the undefined snapshotUrl key entirely (no prior checkpoint to restore from).
    assert.deepEqual(spec.workspace, {});

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose(); // leaving this socket open makes fastify.close() hang (see closeQuietly)
    app.stopReconciler();
    await app.fastify.close();
  });

  test("a checkpoint frame with only workspaceUrl stores just that field", async () => {
    const app = await buildTestApp();
    const { session, runId } = await makeRunningSession(app, { repo: null, branch: undefined });

    const agent = await openAgentSocket(app, runId);
    await agent.nextMessage(); // run.spec

    agent.send({ t: "checkpoint", workspaceUrl: "file:///tmp/s1-workspace.tar.gz" });
    // checkpoint isn't seq'd/acked; give the async handler a tick to persist it.
    await new Promise((resolve) => setImmediate(resolve));

    const stored = await app.store.sessions.findById(session.id);
    assert.deepEqual(stored?.checkpoint, { workspaceUrl: "file:///tmp/s1-workspace.tar.gz" });

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopReconciler();
    await app.fastify.close();
  });

  test("run.spec substitutes the guru's fallbackModel when the laptop preflight is offline (E2.8)", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { model: "litellm/local-qwen-mlx", fallbackModel: "litellm/gpt-5-mini" });
    app.laptopProbe.setOnline(false);

    const now = new Date().toISOString();
    const session: Session = {
      id: "s-fallback",
      guruId: "test-guru",
      repo: "o/r",
      branch: "main",
      status: "open",
      cost: 0,
      createdAt: now,
      updatedAt: now,
    };
    await app.store.sessions.insert(session);
    const run = await app.runs.wake(session.id);

    const agent = await openAgentSocket(app, run.id);
    const spec = await agent.nextMessage();
    assert.equal(spec.guru.model, "litellm/gpt-5-mini");

    const stored = await app.store.runs.findById(run.id);
    assert.deepEqual(stored?.modelFallback, { wanted: "litellm/local-qwen-mlx", used: "litellm/gpt-5-mini" });

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopReconciler();
    await app.fastify.close();
  });

  test("down-messages queue during provisioning and drain after the first idle/running status, in order", async () => {
    const app = await buildTestApp();
    const { session, runId } = await makeRunningSession(app);

    // run.state is "provisioning" (wake() just started it): both sends must queue, not deliver.
    await app.agentLink.send(runId, { t: "prompt", text: "first" });
    await app.agentLink.send(runId, { t: "prompt", text: "second" });
    const queued = await app.store.runs.findById(runId);
    assert.equal(queued?.pending.length, 2);

    const agent = await openAgentSocket(app, runId);
    await agent.nextMessage(); // run.spec

    agent.send({ t: "hello", runId, sessionId: session.id, lastAckedSeq: 0 });
    // hello must NOT drain: the run is still provisioning at this point.
    const afterHello = await app.store.runs.findById(runId);
    assert.equal(afterHello?.pending.length, 2);

    agent.send({ t: "status", state: "idle" });
    // the first idle status drains the queue, in order.
    assert.deepEqual(await agent.nextMessage(), { t: "prompt", text: "first" });
    assert.deepEqual(await agent.nextMessage(), { t: "prompt", text: "second" });

    const afterStatus = await app.store.runs.findById(runId);
    assert.equal(afterStatus?.state, "idle");
    assert.equal(afterStatus?.pending.length, 0);

    // now that the run is ready, a send delivers straight over the live socket.
    await app.agentLink.send(runId, { t: "prompt", text: "third" });
    assert.deepEqual(await agent.nextMessage(), { t: "prompt", text: "third" });
    const afterThird = await app.store.runs.findById(runId);
    assert.equal(afterThird?.pending.length, 0);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopReconciler();
    await app.fastify.close();
  });

  test("run.spec passes the guru's model through untouched when the laptop preflight is online", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { model: "litellm/local-qwen-mlx", fallbackModel: "litellm/gpt-5-mini" });
    app.laptopProbe.setOnline(true);

    const now = new Date().toISOString();
    const session: Session = {
      id: "s-online",
      guruId: "test-guru",
      repo: "o/r",
      branch: "main",
      status: "open",
      cost: 0,
      createdAt: now,
      updatedAt: now,
    };
    await app.store.sessions.insert(session);
    const run = await app.runs.wake(session.id);

    const agent = await openAgentSocket(app, run.id);
    const spec = await agent.nextMessage();
    assert.equal(spec.guru.model, "litellm/local-qwen-mlx");

    const stored = await app.store.runs.findById(run.id);
    assert.equal(stored?.modelFallback, undefined);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopReconciler();
    await app.fastify.close();
  });

  test("session cost is the sum of each run's delta above the key's spend at that run's start, not the raw cumulative key spend", async () => {
    const app = await buildTestApp();
    const { session, runId: run1Id } = await makeRunningSession(app);

    const agent1 = await openAgentSocket(app, run1Id);
    await agent1.nextMessage(); // run.spec

    // key balance is 5 when run1 first reports spend: that's run1's baseline, contributing 0 yet.
    agent1.send({ t: "spend", keySpend: 5 });
    await new Promise((resolve) => setImmediate(resolve));
    let run1 = await app.store.runs.findById(run1Id);
    let stored = await app.store.sessions.findById(session.id);
    assert.equal(run1?.keySpendStart, 5);
    assert.equal(run1?.cost, 0);
    assert.equal(stored?.cost, 0);

    // key balance rises to 8: run1 added 3.
    agent1.send({ t: "spend", keySpend: 8 });
    await new Promise((resolve) => setImmediate(resolve));
    run1 = await app.store.runs.findById(run1Id);
    stored = await app.store.sessions.findById(session.id);
    assert.equal(run1?.cost, 3);
    assert.equal(stored?.cost, 3);

    agent1.send({ t: "bye", reason: "stop" });
    await agent1.nextClose(); // agentlink's bye handler marks run1 "stopped", freeing the session for wake()

    // a second run on the same session: the key's cumulative spend continues from 8, not reset.
    const run2 = await app.runs.wake(session.id);
    const agent2 = await openAgentSocket(app, run2.id);
    await agent2.nextMessage(); // run.spec

    // run2's own baseline is pinned to 8 (its own first spend frame), so it starts at 0 too.
    agent2.send({ t: "spend", keySpend: 8 });
    await new Promise((resolve) => setImmediate(resolve));
    stored = await app.store.sessions.findById(session.id);
    assert.equal(stored?.cost, 3); // unchanged: run1's 3 + run2's 0

    // key balance rises to 12: run2 added 4. Total session cost is the sum of both runs' deltas
    // (3 + 4 = 7), not max(existing session.cost, rawKeySpend) which the old bug would compute
    // as max(3, 12) = 12 — inflated by spend this session's runs never made.
    agent2.send({ t: "spend", keySpend: 12 });
    await new Promise((resolve) => setImmediate(resolve));
    const run2Stored = await app.store.runs.findById(run2.id);
    stored = await app.store.sessions.findById(session.id);
    assert.equal(run2Stored?.cost, 4);
    assert.equal(stored?.cost, 7);

    agent2.send({ t: "bye", reason: "stop" });
    await agent2.nextClose();
    app.stopReconciler();
    await app.fastify.close();
  });
});
