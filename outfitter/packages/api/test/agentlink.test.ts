import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OAuth2Client } from "google-auth-library";
import { buildTestApp, seedGuru } from "./helpers.ts";
import { makeQueue, openAgentSocket, runTokenFor, makeRunningSession, sendHello, type SocketHandle } from "./agent-socket.ts";
import type { Session } from "../src/store/types.ts";
import { authorFor } from "../src/agentlink.ts";
import type { SecretsBroker } from "../src/secrets.ts";
import { MemoryStore } from "../src/store/memory.ts";


describe("agentd <-> api WebSocket", () => {
  test("connect waits for hello, then sends run.spec, then ack/entry-dedup/bye", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);

    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(spec.session.id, session.id);
    assert.equal(spec.repo.branch, "main");

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

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("event frames are fanned out over SSE and acked", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

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
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

    agent.send({ t: "event", seq: 1, event: { type: "agent_start" } });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 1 });

    assert.equal(received.length, 1);
    assert.equal(received[0].type, "event");
    assert.deepEqual(received[0].data, { type: "agent_start" });

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("bug 9 (docs/reports/cloud-fixes.md): closes with 4409 when the agentd's hello.protocolVersion is older than the API's", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken, 0, 0); // protocolVersion 0 -- an old build
    const close = await agent.nextClose();
    assert.equal(close.code, 4409);
    assert.match(close.reason, /protocol v0 is older than the API's v1/);
    // agentd exits on 4409, so the run must not be left "provisioning" pinning the session.
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "failed");
    assert.match(run?.reason ?? "", /protocol v0 is older/);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("bug 9: a missing protocolVersion (a pre-field agentd build) is treated as version 0 and refused the same way", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    agent.send({ t: "hello", runId, sessionId: session.id, lastAckedSeq: 0, runToken }); // no protocolVersion at all
    const close = await agent.nextClose();
    assert.equal(close.code, 4409);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("bug 9: a matching or newer protocolVersion connects normally", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken, 0, 1); // matches API_PROTOCOL_VERSION
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("bug 7 (docs/reports/cloud-fixes.md): a status frame's detail is persisted on the run, and not wiped by a later state-only frame", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

    // Frames on one connection are handled in arrival order (see stop.test.ts's serialization
    // comment); an "entry" frame's ack is only sent once its own handling completes, so awaiting
    // it after a "status" frame is a reliable way to know that status frame has been applied too.
    agent.send({ t: "status", state: "idle", detail: "pi rejected prompt: model not found" });
    agent.send({ t: "entry", seq: 1, entry: { id: "e1", parentId: null, type: "message" } });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 1 });
    let run = await app.store.runs.findById(runId);
    assert.equal(run?.statusDetail, "pi rejected prompt: model not found");

    // An ordinary state-only status frame (the vast majority pi/agentd sends) must not clear it.
    agent.send({ t: "status", state: "running" });
    agent.send({ t: "entry", seq: 2, entry: { id: "e2", parentId: "e1", type: "message" } });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 2 });
    run = await app.store.runs.findById(runId);
    assert.equal(run?.statusDetail, "pi rejected prompt: model not found", "a state-only frame keeps the last detail");

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("bug 6 (docs/reports/cloud-fixes.md): only interactive extension_ui_request methods become Run.pendingUiRequest, not display-only ones", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

    // Display-only methods (protocol.md/rpc.md's "fire-and-forget" list): none of these are a
    // question the run is waiting on, so none should ever land in Run.pendingUiRequest.
    for (const method of ["setStatus", "setWidget", "notify", "setTitle", "set_editor_text"]) {
      agent.send({ t: "event", seq: 1, event: { type: "extension_ui_request", id: `d-${method}`, method } });
      assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 1 });
      const run = await app.store.runs.findById(runId);
      assert.equal(run?.pendingUiRequest, undefined, `${method} must not be stored as pendingUiRequest`);
    }

    // An interactive method must still be stored -- this is the one real question the UI needs to
    // render (UiRequestPanel).
    agent.send({ t: "event", seq: 2, event: { type: "extension_ui_request", id: "q1", method: "confirm", title: "Clear session?" } });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 2 });
    const run = await app.store.runs.findById(runId);
    assert.deepEqual(run?.pendingUiRequest, { type: "extension_ui_request", id: "q1", method: "confirm", title: "Clear session?" });

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("closes the connection with a bad bearer token instead of sending run.spec", async () => {
    const app = await buildTestApp();
    const { runId } = await makeRunningSession(app);

    // the WS upgrade itself succeeds (auth happens after, inside the handler); the handler then
    // closes the socket rather than sending run.spec.
    const agent = await openAgentSocket(app, runId, "wrong-token");
    const close = await agent.nextClose();
    assert.equal(close.code, 4401);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  // Finding #2 (docs/reports/security-review-pr1.md): a valid agent SA bearer token only proves the
  // caller is *some* execution of the outfitter-agent job -- every execution shares that identity.
  // The run-scoped secret RunManager.wake hands the provider (RUN_TOKEN) is what proves the caller
  // is *this run's* execution, and the api must not do anything else with the socket until it's
  // checked.
  test("closes with 4401 and never sends run.spec when hello carries the wrong runToken", async () => {
    const app = await buildTestApp();
    const { session, runId } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, "not-the-real-run-token");
    const close = await agent.nextClose();
    assert.equal(close.code, 4401);
    assert.equal(agent.messageCount(), 0);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("closes with 4401 and never sends run.spec when hello carries no runToken", async () => {
    const app = await buildTestApp();
    const { session, runId } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    agent.send({ t: "hello", runId, sessionId: session.id, lastAckedSeq: 0 });
    const close = await agent.nextClose();
    assert.equal(close.code, 4401);
    assert.equal(agent.messageCount(), 0);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("closes with 4401 when the first frame isn't hello at all", async () => {
    const app = await buildTestApp();
    const { runId, runToken } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    // A correct runToken doesn't help if it isn't delivered as the required first (hello) frame.
    agent.send({ t: "heartbeat", idleSeconds: 0, memMb: 1, runToken });
    const close = await agent.nextClose();
    assert.equal(close.code, 4401);
    assert.equal(agent.messageCount(), 0);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("proceeds to run.spec once hello carries the correct runToken", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("run.spec omits repo and carries workspace for a repo-less session", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app, { repo: null, branch: undefined });

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();

    assert.equal(spec.repo, undefined);
    // JSON drops the undefined snapshotUrl key entirely (no prior checkpoint to restore from).
    assert.deepEqual(spec.workspace, {});

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose(); // leaving this socket open makes fastify.close() hang (see closeQuietly)
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("run.spec carries no author without a githubEmail on the owner's record, or without an owner", async () => {
    const app = await buildTestApp();
    await app.store.users.upsertSeen("ada@example.com");
    const { session, runId, runToken } = await makeRunningSession(app, { ownerEmail: "ada@example.com" });
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    // no githubEmail on record: no author, so the work email never lands in a commit trailer
    assert.equal(spec.author, undefined);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();

    const app2 = await buildTestApp();
    const second = await makeRunningSession(app2);
    const agent2 = await openAgentSocket(app2, second.runId);
    sendHello(agent2, second.runId, second.session.id, second.runToken);
    const spec2 = await agent2.nextMessage();
    assert.equal(spec2.author, undefined);
    agent2.send({ t: "bye", reason: "stop" });
    await agent2.nextClose();
    app2.stopBackgroundTasks();
    await app2.fastify.close();
  });

  test("a checkpoint frame with only workspaceUrl stores just that field", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app, { repo: null, branch: undefined });

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

    agent.send({ t: "checkpoint", workspaceUrl: "file:///tmp/s1-workspace.tar.gz" });
    // checkpoint isn't seq'd/acked; give the async handler a tick to persist it.
    await new Promise((resolve) => setImmediate(resolve));

    const stored = await app.store.sessions.findById(session.id);
    assert.deepEqual(stored?.checkpoint, { workspaceUrl: "file:///tmp/s1-workspace.tar.gz" });

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
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
    sendHello(agent, run.id, session.id, runTokenFor(app, run.id));
    const spec = await agent.nextMessage();
    assert.equal(spec.guru.model, "litellm/gpt-5-mini");

    const stored = await app.store.runs.findById(run.id);
    assert.deepEqual(stored?.modelFallback, { wanted: "litellm/local-qwen-mlx", used: "litellm/gpt-5-mini" });

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("down-messages queue during provisioning and drain after the first idle/running status, in order", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    // run.state is "provisioning" (wake() just started it): both sends must queue, not deliver.
    await app.agentLink.send(runId, { t: "prompt", text: "first" });
    await app.agentLink.send(runId, { t: "prompt", text: "second" });
    const queued = await app.store.runs.findById(runId);
    assert.equal(queued?.pending.length, 2);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

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
    app.stopBackgroundTasks();
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
    sendHello(agent, run.id, session.id, runTokenFor(app, run.id));
    const spec = await agent.nextMessage();
    assert.equal(spec.guru.model, "litellm/local-qwen-mlx");

    const stored = await app.store.runs.findById(run.id);
    assert.equal(stored?.modelFallback, undefined);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("session cost is the sum of each run's delta above the key's spend at that run's start, not the raw cumulative key spend", async () => {
    const app = await buildTestApp();
    const { session, runId: run1Id, runToken: run1Token } = await makeRunningSession(app);

    const agent1 = await openAgentSocket(app, run1Id);
    sendHello(agent1, run1Id, session.id, run1Token);
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
    sendHello(agent2, run2.id, session.id, runTokenFor(app, run2.id));
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
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  // E2.11: agentd's SpendTailer sends `estimate` as its own running total (pi's per-message cost
  // estimate, independent of LiteLLM's key-spend headers) on every `spend` frame; the handler stores
  // it on the run as-is (not folded like `cost`'s keySpendStart delta) so it stays correct even for a
  // guru whose route returns no LiteLLM headers at all.
  test("spend.estimate is stored on the run as costEstimate, independently of keySpend/cost", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

    // A route with no LiteLLM headers at all still gets a real costEstimate.
    agent.send({ t: "spend", estimate: 0.03 });
    await new Promise((resolve) => setImmediate(resolve));
    let run = await app.store.runs.findById(runId);
    assert.equal(run?.costEstimate, 0.03);
    assert.equal(run?.cost, undefined); // no keySpend on this frame: cost/keySpendStart untouched

    // A later frame carries both: keySpend still drives cost's delta-from-baseline, estimate is a
    // straight overwrite (agentd already accumulates it) -- the two fields evolve independently.
    agent.send({ t: "spend", keySpend: 5, keyMax: 20, modelGroup: "sonnet", callId: "call-2", estimate: 0.08 });
    await new Promise((resolve) => setImmediate(resolve));
    run = await app.store.runs.findById(runId);
    assert.equal(run?.costEstimate, 0.08);
    assert.equal(run?.keySpendStart, 5);
    assert.equal(run?.cost, 0);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  // E2.11b: a run that makes exactly one LiteLLM call used to under-report its cost as 0, because
  // `keySpendStart` was pinned from the *same* frame that reported the post-call balance (delta
  // against itself is always 0). The outfitter-spend extension now sends a `baseline: true` frame
  // from session_start, before any provider call, with the key's balance *before* that call --
  // when it's the first frame this run sees, `keySpendStart` pins from the true pre-call balance
  // and the single real spend frame afterward reports the call's actual cost.
  test("a baseline spend frame arriving before the run's one real call means a one-call run's cost is no longer 0", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

    // session_start's /key/info probe: the key's balance before this run's one call.
    agent.send({ t: "spend", baseline: true, keySpend: 10 });
    await new Promise((resolve) => setImmediate(resolve));
    let run = await app.store.runs.findById(runId);
    assert.equal(run?.keySpendStart, 10);
    assert.equal(run?.cost, 0);

    // The run's one and only provider call: key balance rose from 10 to 10.05.
    agent.send({ t: "spend", keySpend: 10.05, keyMax: 20, modelGroup: "claude-auto-llm", callId: "call-1" });
    await new Promise((resolve) => setImmediate(resolve));
    run = await app.store.runs.findById(runId);
    const stored = await app.store.sessions.findById(session.id);
    assert.ok(run?.cost !== undefined && Math.abs(run.cost - 0.05) < 1e-9, `expected ~0.05, got ${run?.cost}`);
    assert.ok(stored?.cost !== undefined && Math.abs(stored.cost - 0.05) < 1e-9);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});

// outfitter-api (web role) and outfitter-link (link role) are separate Cloud Run services sharing
// one Atlas store; AgentLink keeps sockets in memory per-process, so a down-message posted by one
// process for a run whose socket lives in another only reaches that run via the store. This
// simulates that split with two AgentLink instances (two buildTestApp apps) sharing one store.
describe("down-message queue poller (cross-process delivery)", () => {
  test("a message enqueued by one AgentLink instance is delivered by another instance that owns the socket, after a poll tick", async () => {
    const store = new MemoryStore();
    const owner = await buildTestApp({}, { store });
    const sender = await buildTestApp({}, { store });

    const { session, runId, runToken } = await makeRunningSession(owner);
    const agent = await openAgentSocket(owner, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

    // Mirrors what a real "status: idle" frame would do: the poller only drains a run it
    // considers ready (running/idle), same as a direct send().
    await store.runs.update(runId, { state: "idle" });

    // The sender process has no socket for this run at all: send() must enqueue in the shared
    // store rather than throw or silently drop the message.
    assert.equal(sender.agentLink.hasSocket(runId), false);
    await sender.agentLink.send(runId, { t: "prompt", text: "cross-process" });
    const queued = await store.runs.findById(runId);
    assert.equal(queued?.pending.length, 1);

    // Trigger the owner process's poll pass directly (deterministic; see pollDownQueuesOnce's
    // doc comment) rather than racing its real interval timer. It delivers the queued message
    // over the socket it actually holds.
    await owner.agentLink.pollDownQueuesOnce();
    const delivered = await agent.nextMessage();
    assert.deepEqual(delivered, { t: "prompt", text: "cross-process" });

    const afterPoll = await store.runs.findById(runId);
    assert.equal(afterPoll?.pending.length, 0);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    owner.stopBackgroundTasks();
    sender.stopBackgroundTasks();
    await owner.fastify.close();
    await sender.fastify.close();
  });
});

describe("hello sent immediately after connect is never dropped", () => {
  // Observed production bug: agentd sends `hello` the instant the WS upgrade completes, but
  // handleConnection used to await verifyAgentToken (a real network call on Cloud Run) and several
  // store lookups *before* attaching any 'message' listener. ws emits 'message' with no listener
  // attached, so a hello (and anything sent right after it) that arrived during those awaits was
  // silently lost, and the connection then sat waiting out agentd's reconnect backoff instead of
  // ever getting run.spec. Fixed by buffering frames from the moment handleConnection starts,
  // before any await -- this test makes verifyAgentToken's own promise controllable so hello (and
  // an entry frame right behind it) can be sent while it's still pending, the same as production.
  test("hello (and a frame behind it) sent while token verification is still pending still gets run.spec, and the entry is persisted, in order", async (t) => {
    let releaseVerification: (() => void) | undefined;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => {
      await verificationGate; // held open until the test explicitly releases it, below
      return { getPayload: () => ({ email: "agent@test.local" }) };
    });
    const app = await buildTestApp({ OUTFITTER_DEV: "0", AGENT_SA_EMAIL: "agent@test.local" });
    // repo-less: keeps this test focused on the hello/buffering race, not buildRunSpec's separate
    // (devMode-off) missing-githubToken check, which the default test secrets broker would trip.
    const { session, runId, runToken } = await makeRunningSession(app, { repo: null, branch: undefined });

    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    // Both frames land on the wire well before verifyAgentToken's promise ever resolves.
    sendHello(agent, runId, session.id, runToken);
    agent.send({ t: "entry", seq: 1, entry: { id: "e1", parentId: null, type: "message" } });
    // Give the server's buffering listener a couple of event-loop turns to actually receive both
    // frames before letting verification proceed, so this exercises the buffer rather than getting
    // lucky with scheduling.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(agent.messageCount(), 0); // nothing sent back yet -- still mid-handshake

    releaseVerification?.();

    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");

    // The entry frame, buffered behind hello, gets replayed (in order) once the connection is
    // fully accepted: it's acked and persisted just like it would be over the normal listener.
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 1 });
    const stored = await app.store.entries.listForSession(session.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].entry.id, "e1");

    agent.send({ t: "bye", reason: "stop" });
    const close = await agent.nextClose();
    assert.equal(close.code, 1000);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});

describe("run.spec build validates secrets", () => {
  test("closes with WS code 4412 and marks the run failed when a repo session's githubToken secret is missing (devMode off)", async (t) => {
    const emptyGithubBroker: SecretsBroker = {
      secretsForRun: async () => ({ githubToken: "", litellmKey: "some-key" }),
      defaultLitellmKey: async () => "some-key",
    };
    // devMode off: this is the production path, where a missing token really would make agentd
    // clone with no credentials. In dev mode the same missing-token check is skipped (see the
    // next test) so a public repo can still be cloned anonymously. With devMode off, agentd's
    // bearer is verified as a real Google id token (auth.ts's verifyAgentToken) instead of
    // matching OUTFITTER_DEV_TOKEN, so verifyIdToken is stubbed here rather than pulling in a
    // real GCE/ADC identity for this one connection.
    t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
      getPayload: () => ({ email: "agent@test.local" }),
    }));
    const app = await buildTestApp(
      { OUTFITTER_DEV: "0", AGENT_SA_EMAIL: "agent@test.local" },
      { secretsBroker: emptyGithubBroker },
    );
    const { session, runId, runToken } = await makeRunningSession(app); // default fixture has repo: "o/r"

    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    sendHello(agent, runId, session.id, runToken);
    const close = await agent.nextClose();
    assert.equal(close.code, 4412);
    assert.match(close.reason, /missing github token/);

    // 4412 is terminal for agentd (link.ts's TERMINAL_CLOSE_CODES) precisely because there's
    // nothing to retry -- the run should already be marked failed, not left in provisioning.
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "failed");
    assert.match(run?.reason ?? "", /missing github token/);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a missing githubToken does not fail a repo session in dev mode (anonymous clone)", async () => {
    const emptyGithubBroker: SecretsBroker = {
      secretsForRun: async () => ({ githubToken: "", litellmKey: "some-key" }),
      defaultLitellmKey: async () => "some-key",
    };
    // buildTestApp defaults to OUTFITTER_DEV=1 (devMode on): a missing secret means "no secrets
    // available", not "fail the run" -- the clone just runs anonymously.
    const app = await buildTestApp({}, { secretsBroker: emptyGithubBroker });
    const { session, runId, runToken } = await makeRunningSession(app); // default fixture has repo: "o/r"

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(spec.secrets.githubToken, "");

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("an empty githubToken does not fail a repo-less session", async () => {
    const emptyGithubBroker: SecretsBroker = {
      secretsForRun: async () => ({ githubToken: "", litellmKey: "some-key" }),
      defaultLitellmKey: async () => "some-key",
    };
    const app = await buildTestApp({}, { secretsBroker: emptyGithubBroker });
    const { session, runId, runToken } = await makeRunningSession(app, { repo: null, branch: undefined });

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(spec.secrets.githubToken, "");

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});

describe("authorFor", () => {
  test("prefers the user record's name, githubLogin and githubEmail when an operator set them", () => {
    assert.deepEqual(
      authorFor("ada@example.com", {
        email: "ada@example.com",
        createdAt: "2026-01-01T00:00:00Z",
        name: " Ada Lovelace ",
        githubLogin: "ada",
        githubEmail: "123+ada@users.noreply.github.com",
      }),
      { name: "Ada Lovelace", email: "123+ada@users.noreply.github.com", login: "ada" },
    );
  });

  test("no author without a githubEmail (never the sign-in email), or without an owner", () => {
    assert.equal(authorFor("bob@example.com", null), undefined);
    assert.equal(authorFor("bob@example.com", { email: "bob@example.com", createdAt: "x", name: "Bob" }), undefined);
    assert.equal(authorFor(undefined, null), undefined);
    // a malformed stored record falls back instead of throwing
    assert.equal(authorFor("eve@example.com", { email: "eve@example.com", createdAt: "x", githubEmail: 7 as any }), undefined);
    assert.deepEqual(
      authorFor("eve@example.com", { email: "eve@example.com", createdAt: "x", name: 42 as any, githubEmail: "1+eve@users.noreply.github.com" }),
      { name: "eve", email: "1+eve@users.noreply.github.com" },
    );
  });
});
