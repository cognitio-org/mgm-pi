import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OAuth2Client } from "google-auth-library";
import { buildTestApp, seedGuru } from "./helpers.ts";
import { makeQueue, openAgentSocket, runTokenFor, makeRunningSession, sendHello, type SocketHandle } from "./agent-socket.ts";
import type { Session } from "../src/store/types.ts";
import {
  authorFor,
  githubAppNotInstalledDetail,
  githubAppPermissionsMissingDetail,
  githubAppRejectedDetail,
} from "../src/agentlink.ts";
import type { MintFailureContext } from "../src/github-app.ts";
import { MAIL_MAX_ATTEMPTS, mailHeldFailureNotice } from "../src/mail.ts";
import type { SecretsBroker } from "../src/secrets.ts";
import { MemoryStore } from "../src/store/memory.ts";

/** Polls until `predicate` holds -- used where the assertion depends on the server having processed
 * a socket close (there is no event to await for that from the client side). */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}


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

  test("#205: the bye's close comes only after its store writes; 1011 when they fail, so agentd resends", async () => {
    for (const fail of [false, true]) {
      const app = await buildTestApp();
      const { session, runId, runToken } = await makeRunningSession(app);
      const releaseRun = app.store.mail.releaseRun.bind(app.store.mail);
      let released = false;
      app.store.mail.releaseRun = async (id) => {
        await new Promise((r) => setTimeout(r, 200));
        if (fail) throw new Error("store hiccup");
        const result = await releaseRun(id);
        released = true;
        return result;
      };

      const agent = await openAgentSocket(app, runId);
      sendHello(agent, runId, session.id, runToken);
      await agent.nextMessage(); // run.spec
      agent.send({ t: "bye", reason: "idle" });
      const close = await agent.nextClose();
      // agentd exits on a 1000 (Link.sendFinal), so everything must already be stored by then.
      assert.equal(close.code, fail ? 1011 : 1000);
      assert.equal((await app.store.runs.findById(runId))?.state, "stopped");
      assert.equal(released, !fail);

      app.stopBackgroundTasks();
      await app.fastify.close();
    }
  });

  test("#185: a backlog replayed the moment run.spec arrives is stored in full, not capped at 256", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    // Hold the api in its post-run.spec awaits, the window where the pre-hello buffer still
    // collects frames, so the replay piles up there as it does against Atlas.
    // (handleConnection's first-contact write right after it sends run.spec: lastSeenAt alone.)
    const update = app.store.runs.update.bind(app.store.runs);
    let slowed = false;
    app.store.runs.update = async (id, patch) => {
      if (!slowed && Object.keys(patch).sort().join() === "lastSeenAt,updatedAt") {
        slowed = true;
        await new Promise((r) => setTimeout(r, 300));
      }
      return update(id, patch);
    };

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    const total = 400;
    for (let seq = 1; seq <= total; seq++) {
      agent.send({ t: "entry", seq, entry: { id: `e${seq}`, parentId: seq === 1 ? null : `e${seq - 1}`, type: "message" } });
    }
    const start = Date.now();
    while ((await app.store.entries.listForSession(session.id)).length < total && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal((await app.store.entries.listForSession(session.id)).length, total);
    assert.equal((await app.store.runs.findById(runId))?.state === "failed", false);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#187: heartbeats keep the sandbox's memory high-water mark and limit on the run", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    agent.send({ t: "heartbeat", idleSeconds: 0, memMb: 90, sandboxMemMb: 1500, sandboxMemLimitMb: 4096 });
    await settle();
    agent.send({ t: "heartbeat", idleSeconds: 0, memMb: 90, sandboxMemMb: 700, sandboxMemLimitMb: 4096 });
    await settle();
    let run = await app.store.runs.findById(runId);
    assert.equal(run?.sandboxMemPeakMb, 1500, "a lower reading doesn't lower the peak");
    assert.equal(run?.sandboxMemLastMb, 700, "but the latest reading is kept on its own");
    assert.equal(run?.sandboxMemLimitMb, 4096);

    // An older agentd's heartbeat, or garbage, leaves the stored values alone.
    agent.send({ t: "heartbeat", idleSeconds: 0, memMb: 90 });
    agent.send({ t: "heartbeat", idleSeconds: 0, memMb: 90, sandboxMemMb: "lots", sandboxMemLimitMb: -1 });
    agent.send({ t: "heartbeat", idleSeconds: 0, memMb: 90, sandboxMemMb: 0.4, sandboxMemLimitMb: 0.4 }); // would round to 0
    await settle();
    run = await app.store.runs.findById(runId);
    assert.equal(run?.sandboxMemPeakMb, 1500);
    assert.equal(run?.sandboxMemLastMb, 700);
    assert.equal(run?.sandboxMemLimitMb, 4096);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#193: onAgentLost fires when the run's own socket closes, not when a replaced one does", async () => {
    const app = await buildTestApp({ AGENT_SOCKET_GRACE_MS: "0" });
    const lost: string[] = [];
    app.agentLink.onAgentLost((runId) => lost.push(runId));
    const { session, runId, runToken } = await makeRunningSession(app);

    const first = await openAgentSocket(app, runId);
    sendHello(first, runId, session.id, runToken);
    await first.nextMessage(); // run.spec
    const second = await openAgentSocket(app, runId);
    sendHello(second, runId, session.id, runToken);
    await second.nextMessage(); // run.spec
    await first.nextClose(); // replaced: 1001
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(lost, [], "the replacement is live, so nothing is lost");

    // A client-side close doesn't reliably reach the server's `close` in this harness (nor, for a
    // killed pod, in production, which is why RunManager also probes silent runs), so drive the
    // handler directly, as the supersede test above does.
    const link = app.agentLink as unknown as {
      sockets: Map<string, object>;
      onAgentSocketClosed(runId: string, socket: object): void;
    };
    link.onAgentSocketClosed(runId, {});
    assert.deepEqual(lost, [], "a socket that isn't the registered one doesn't count");
    link.onAgentSocketClosed(runId, link.sockets.get(runId)!);
    assert.deepEqual(lost, [runId]);

    second.send({ t: "bye", reason: "stop" });
    await second.nextClose();
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

  test("#147: an agentd entry is stored with its run id and goes out with outfitterRunId, the entry itself unchanged", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    const received: { type: string; data: any }[] = [];
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
    const entry = { id: "e1", parentId: null, type: "message" };
    agent.send({ t: "entry", seq: 1, entry });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 1 });

    const [row] = await app.store.entries.listForSession(session.id);
    assert.equal(row!.runId, runId);
    assert.deepEqual(row!.entry, entry, "the pi entry is stored as agentd sent it");
    const sse = received.find((r) => r.type === "entry");
    assert.deepEqual(sse?.data, { ...entry, outfitterRunId: runId });

    const listed = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}/entries` });
    assert.deepEqual(listed.json(), [{ ...entry, outfitterRunId: runId }]);
    // A pi session file must stay pi's: the export writes the stored entry, not the wire form.
    const exported = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}/export.jsonl` });
    assert.equal(exported.statusCode, 200);
    assert.ok(!exported.body.includes("outfitterRunId"), exported.body);

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
    assert.match(close.reason, /protocol v0 is older than the API's v2/);
    // agentd exits on 4409, so the run must not be left "provisioning" pinning the session.
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "failed");
    assert.match(run?.reason ?? "", /protocol v0 is older/);
    // The browser-visible half (see the 4412 test): a note that names the fix, not just the skew.
    assert.match(run?.statusDetail ?? "", /outfitter-agent image needs redeploying/);

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
    sendHello(agent, runId, session.id, runToken, 0, 2); // matches API_PROTOCOL_VERSION
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("protocolVersion 1 is older than the API and is refused", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken, 0, 1);
    const close = await agent.nextClose();
    assert.equal(close.code, 4409);
    assert.match(close.reason, /protocol v1 is older than the API's v2/);
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "failed");

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

  test("a thinking delta is stored on the run, and the assistant entry clears it (#285)", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

    agent.send({
      t: "event",
      seq: 1,
      event: {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "plan",
          partial: { role: "assistant", content: [{ type: "thinking", thinking: "planning the edit" }] },
        },
      },
    });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 1 });
    assert.equal((await app.store.runs.findById(runId))?.liveThought, "planning the edit");

    agent.send({
      t: "entry",
      seq: 2,
      entry: {
        id: "a1",
        type: "message",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "planning the edit" }, { type: "text", text: "done" }] },
      },
    });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 2 });
    assert.equal((await app.store.runs.findById(runId))?.liveThought, null);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("pi entries and events stamp lastActivityAt; a heartbeat moves only lastSeenAt (#182)", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    await agent.nextMessage(); // run.spec

    agent.send({ t: "event", seq: 1, event: { type: "message_update" } });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 1 });
    const afterEvent = await app.store.runs.findById(runId);
    assert.ok(afterEvent?.lastActivityAt);

    await new Promise((r) => setTimeout(r, 5));
    agent.send({ t: "heartbeat", idleSeconds: 0, memMb: 1 });
    await new Promise((r) => setTimeout(r, 50)); // a heartbeat gets no reply; give the api a moment
    const afterBeat = await app.store.runs.findById(runId);
    assert.equal(afterBeat?.lastActivityAt, afterEvent.lastActivityAt);
    assert.ok(afterBeat!.lastSeenAt! > afterEvent.lastActivityAt!);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
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

  test("run.spec carries the stored conversation as snapshot.jsonl, so a woken run keeps the thread", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    // Two earlier runs: the second started pi on an empty file (the bug), so it has its own root.
    // Their seqs overlap, as agentd's per-run seqs do.
    await app.store.entries.insertIfNew(session.id, 1, { id: "u1", parentId: null, type: "message" }, { runId: "r1" });
    await app.store.entries.insertIfNew(session.id, 2, { id: "a1", parentId: "u1", type: "message" }, { runId: "r1" });
    await app.store.entries.insertIfNew(session.id, 1, { id: "u2", parentId: null, type: "message" }, { runId: "r2" });

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();

    const lines = String(spec.snapshot.jsonl).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].type, "session");
    assert.equal(lines[0].id, session.id);
    assert.deepEqual(
      lines.slice(1).map((e) => [e.id, e.parentId]),
      [
        ["u1", null],
        ["a1", "u1"],
        ["u2", "a1"],
      ],
    );

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a reconnect of a running run gets no snapshot.jsonl: agentd already applied its spec", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    await app.store.entries.insertIfNew(session.id, 1, { id: "u1", parentId: null, type: "message" });
    await app.store.runs.update(runId, { state: "running" });
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(spec.snapshot.jsonl, undefined);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("run.spec for a session with no entries sends no snapshot.jsonl (agentd starts an empty one)", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.snapshot.jsonl, undefined);

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

  test("an allowed checkpoint branch becomes the session branch", async () => {
    const app = await buildTestApp();
    const head = "a".repeat(40);
    const next = "b".repeat(40);
    const { session, runId, runToken } = await makeRunningSession(app, {
      branch: "outfitter/s1",
      checkpoint: { branch: "outfitter/s1", head },
    });
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.repo.branchPrefix, "outfitter/");
    assert.equal(spec.repo.branch, "outfitter/s1");

    agent.send({ t: "checkpoint", branch: "outfitter/issue-4", head: next, pushed: true });
    let moved = await app.store.sessions.findById(session.id);
    for (let i = 0; i < 20 && moved?.branch !== "outfitter/issue-4"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      moved = await app.store.sessions.findById(session.id);
    }
    assert.equal(moved?.branch, "outfitter/issue-4");
    assert.equal(moved?.checkpoint?.branch, "outfitter/issue-4");
    assert.equal(moved?.checkpoint?.head, next);
    // #501: a frame that sent commits records when.
    assert.equal(moved?.checkpoint?.pushed, true);
    const pushedAt = moved?.checkpoint?.pushedAt;
    assert.ok(pushedAt);

    agent.send({ t: "checkpoint", branch: "outfitter/s1", head: "c".repeat(40), pushed: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stayed = await app.store.sessions.findById(session.id);
    assert.equal(stayed?.branch, "outfitter/issue-4");
    assert.equal(stayed?.checkpoint?.branch, "outfitter/issue-4");
    assert.equal(stayed?.checkpoint?.head, next);
    assert.equal(stayed?.checkpoint?.landed, false, "another branch's frame never says the session's branch landed");
    assert.ok(stayed?.checkpoint?.at);

    // E9 §5.3: pushed:false with a head is agentd finding the remote already at that head.
    const already = "d".repeat(40);
    agent.send({ t: "checkpoint", branch: "outfitter/issue-4", head: already, pushed: false });
    let landed = await app.store.sessions.findById(session.id);
    for (let i = 0; i < 20 && landed?.checkpoint?.head !== already; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      landed = await app.store.sessions.findById(session.id);
    }
    assert.equal(landed?.checkpoint?.head, already);
    assert.equal(landed?.checkpoint?.landed, true);
    // #501: found there, not pushed: the push time stays the last real push's.
    assert.equal(landed?.checkpoint?.pushed, false);
    assert.equal(landed?.checkpoint?.pushedAt, pushedAt);
    const detail = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    assert.deepEqual(detail.json().lastPush, { sha: already, branch: "outfitter/issue-4", at: pushedAt, pushed: false });
    // No head (nothing could be pushed): not landed, the last head kept.
    agent.send({ t: "checkpoint", branch: "outfitter/issue-4", pushed: false });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const failed = await app.store.sessions.findById(session.id);
    assert.equal(failed?.checkpoint?.landed, false);
    assert.equal(failed?.checkpoint?.head, already);

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
    // ...and the reason has to be somewhere the browser actually shows it. `reason` only reaches the
    // header's one-line "LOAD ERROR — ..."; statusDetail is the note the session page renders in
    // full (sse.ts -> useSessionStream -> SessionPage), so it carries the remedy.
    assert.match(run?.statusDetail ?? "", /no GitHub token is stored for this session/);
    assert.match(run?.statusDetail ?? "", /An operator has to create/);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("preview.open is answered not-configured until phase 2 (#217); run.spec carries no preview config", async () => {
    const app = await buildTestApp({});
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(spec.preview, undefined);
    assert.equal(spec.secrets.ngrokAuthtoken, undefined);

    agent.send({ t: "preview.open", requestId: "req-1", port: 3000, internalUrl: "https://p3000.r.internal", share: false });
    assert.deepEqual(await agent.nextMessage(), { t: "preview.result", requestId: "req-1", error: "not-configured" });
    agent.send({ t: "preview.close", port: 3000 });

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
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

// Finding #1 (docs/reports/security-review-pr41.md): the run token proved the caller was this run's
// sandbox, but nothing stopped a *second* caller holding it from being handed its own run.spec --
// GitHub token, LiteLLM key -- and displacing agentd on the run's down-channel. A run now has one
// live agent connection at a time.
describe("one live agent connection per run", () => {
  test("refuses a second connection while the first is live, and never sends it run.spec", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const agentd = await openAgentSocket(app, runId);
    sendHello(agentd, runId, session.id, runToken);
    assert.equal((await agentd.nextMessage()).t, "run.spec");

    // The model's shell, with a leaked RUN_TOKEN and a valid agent identity token of its own.
    const impostor = await openAgentSocket(app, runId);
    sendHello(impostor, runId, session.id, runToken);
    const close = await impostor.nextClose();
    assert.equal(close.code, 4429);
    assert.equal(impostor.messageCount(), 0, "the second connection must never be handed run.spec");

    // ...and agentd's own connection is untouched: still registered, still acked.
    assert.equal(app.agentLink.hasSocket(runId), true);
    agentd.send({ t: "entry", seq: 1, entry: { type: "message", id: "e1", parentId: "s1", timestamp: "t", message: { role: "user", content: "hi" } } });
    const ack = await agentd.nextMessage();
    assert.equal(ack.t, "ack");
    assert.equal(ack.seq, 1);

    agentd.send({ t: "bye", reason: "stop" });
    await agentd.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("agentd's own reconnect still gets run.spec once its previous socket has closed", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const first = await openAgentSocket(app, runId);
    sendHello(first, runId, session.id, runToken);
    assert.equal((await first.nextMessage()).t, "run.spec");

    // What link.ts's 55-minute rotation (and any dropped connection) does: close, then reconnect.
    first.close();
    await first.nextClose();
    await waitFor(() => app.agentLink.hasSocket(runId) === false);

    const reconnected = await openAgentSocket(app, runId);
    sendHello(reconnected, runId, session.id, runToken, 1);
    const spec = await reconnected.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(app.agentLink.hasSocket(runId), true);

    reconnected.send({ t: "bye", reason: "stop" });
    await reconnected.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a socket silent past AGENT_SOCKET_GRACE_MS is treated as half-open and replaced", async () => {
    // Grace 0: every incumbent counts as silent, which is how a real half-open socket (peer gone,
    // no close frame, still OPEN here) looks after four missed heartbeats. Without this path a
    // partitioned sandbox's reconnect would be refused until TCP noticed, wedging the run.
    const app = await buildTestApp({ AGENT_SOCKET_GRACE_MS: "0" });
    const { session, runId, runToken } = await makeRunningSession(app);

    const stale = await openAgentSocket(app, runId);
    sendHello(stale, runId, session.id, runToken);
    assert.equal((await stale.nextMessage()).t, "run.spec");

    const replacement = await openAgentSocket(app, runId);
    sendHello(replacement, runId, session.id, runToken);
    assert.equal((await replacement.nextMessage()).t, "run.spec");

    // The displaced socket is closed with a *non-terminal* code: a live agentd that lost the race
    // must reconnect, not exit (link.ts's TERMINAL_CLOSE_CODES).
    const close = await stale.nextClose();
    assert.equal(close.code, 1001);
    assert.equal(app.agentLink.hasSocket(runId), true);

    replacement.send({ t: "bye", reason: "stop" });
    await replacement.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});

// The motivating incident (session 2cc9494a on cognitio-org/testit, 2026-09-23): the api refused the
// sandbox's connection, agentd went away, and the run sat in `provisioning` with the reason visible
// only in Cloud Logging. Every refusal that is a fact about the run now says so on the run itself --
// and, just as importantly, every refusal that is only a fact about the *caller* still says nothing
// there (see agentlink.ts's refuse(): a write on an unproven caller's word would be a way to fail
// other people's runs).
describe("api-side refusals explain themselves", () => {
  test("a run whose session record is gone is failed with a note, not left provisioning", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store);
    const now = new Date().toISOString();
    // A run pointing at a session that isn't there: what a deleted (or never-replicated) session
    // leaves behind. Its agent is refused before the run token is even looked at, which is fine
    // here -- whether the session exists doesn't depend on who is asking.
    await app.store.runs.insert({
      id: "orphan-run",
      sessionId: "gone",
      state: "provisioning",
      lastAckedSeq: 0,
      pending: [],
      createdAt: now,
      updatedAt: now,
    });

    const agent = await openAgentSocket(app, "orphan-run");
    sendHello(agent, "orphan-run", "gone", "irrelevant");
    const close = await agent.nextClose();
    assert.equal(close.code, 4404);
    assert.equal(agent.messageCount(), 0, "a refused connection is never handed run.spec");

    const run = await app.store.runs.findById("orphan-run");
    assert.equal(run?.state, "failed");
    assert.match(run?.statusDetail ?? "", /session record is missing/);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a session whose guru was deleted is failed with a note naming the guru", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    await app.store.gurus.delete("test-guru");

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const close = await agent.nextClose();
    assert.equal(close.code, 4404);

    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "failed");
    assert.match(run?.statusDetail ?? "", /guru \(test-guru\) no longer exists/);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a buildRunSpec failure the api may yet recover from explains itself without failing the run", async () => {
    // Not MissingGithubTokenError: a broker that is simply unavailable. register()'s catch closes
    // with 1011, which agentd retries (link.ts), so the run keeps its state -- but it must not sit
    // in `provisioning` with the cause visible only in the server log.
    const brokenBroker: SecretsBroker = {
      secretsForRun: async () => {
        throw new Error("secret manager unavailable");
      },
      defaultLitellmKey: async () => "some-key",
    };
    const app = await buildTestApp({}, { secretsBroker: brokenBroker });
    const { session, runId, runToken } = await makeRunningSession(app);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const close = await agent.nextClose();
    assert.equal(close.code, 1011);
    assert.equal(agent.messageCount(), 0);

    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "provisioning", "a transient failure must stay retryable");
    assert.match(run?.statusDetail ?? "", /could not build this run's spec: secret manager unavailable/);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a bad run token writes nothing on the run -- an unproven caller can't fail someone else's", async () => {
    // Finding #2 (docs/reports/security-review-pr1.md): a valid agent id token only proves the
    // caller is *some* execution of the shared agent job, so this refusal is a fact about the caller
    // alone. Persisting it would hand any holder of an agent token a way to fail arbitrary runs;
    // runs.ts's reconciler is what fails a run whose sandbox really never connected.
    const app = await buildTestApp();
    const { session, runId } = await makeRunningSession(app);

    const impostor = await openAgentSocket(app, runId);
    sendHello(impostor, runId, session.id, "not-the-run-token");
    const close = await impostor.nextClose();
    assert.equal(close.code, 4401);

    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "provisioning");
    assert.equal(run?.statusDetail, undefined);
    assert.equal(run?.reason, undefined);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("refusing a second live connection leaves the running run's own state and note alone", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);

    const agentd = await openAgentSocket(app, runId);
    sendHello(agentd, runId, session.id, runToken);
    assert.equal((await agentd.nextMessage()).t, "run.spec");

    const impostor = await openAgentSocket(app, runId);
    sendHello(impostor, runId, session.id, runToken);
    assert.equal((await impostor.nextClose()).code, 4429);

    // Nothing is wrong with this run -- its own agent is connected -- so the refusal must not leave
    // a note on it claiming otherwise.
    const run = await app.store.runs.findById(runId);
    assert.notEqual(run?.state, "failed");
    assert.equal(run?.statusDetail, undefined);

    agentd.send({ t: "bye", reason: "stop" });
    await agentd.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("run.spec carries playwrightBeforeCheckpoint only when the guru set it true", async () => {
    const on = await buildTestApp();
    await seedGuru(on.store, { playwrightBeforeCheckpoint: true });
    const now = new Date().toISOString();
    const session: Session = {
      id: "s-pw",
      guruId: "test-guru",
      repo: "o/r",
      branch: "main",
      status: "open",
      cost: 0,
      createdAt: now,
      updatedAt: now,
    };
    await on.store.sessions.insert(session);
    const run = await on.runs.wake(session.id);
    const agent = await openAgentSocket(on, run.id);
    sendHello(agent, run.id, session.id, runTokenFor(on, run.id));
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(spec.guru.playwrightBeforeCheckpoint, true);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    on.stopBackgroundTasks();
    await on.fastify.close();

    const off = await buildTestApp();
    const { session: plain, runId, runToken } = await makeRunningSession(off);
    const plainAgent = await openAgentSocket(off, runId);
    sendHello(plainAgent, runId, plain.id, runToken);
    const plainSpec = await plainAgent.nextMessage();
    assert.equal(plainSpec.t, "run.spec");
    assert.equal(plainSpec.guru.playwrightBeforeCheckpoint, undefined);
    plainAgent.send({ t: "bye", reason: "stop" });
    await plainAgent.nextClose();
    off.stopBackgroundTasks();
    await off.fastify.close();
  });

  test("#132: run.spec carries allowExternalHtmlResources only when true, and the run records it", async () => {
    const on = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(on);
    await on.store.gurus.update("test-guru", { allowExternalHtmlResources: true });
    const agent = await openAgentSocket(on, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(spec.guru.allowExternalHtmlResources, true);
    assert.equal((await on.store.runs.findById(runId))?.allowExternalHtmlResources, true);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    on.stopBackgroundTasks();
    await on.fastify.close();

    const off = await buildTestApp();
    const plain = await makeRunningSession(off);
    const plainAgent = await openAgentSocket(off, plain.runId);
    sendHello(plainAgent, plain.runId, plain.session.id, plain.runToken);
    const plainSpec = await plainAgent.nextMessage();
    assert.equal(plainSpec.guru.allowExternalHtmlResources, undefined);
    // Recorded as an explicit false, so a later spec for this run can't pick up a Tape edited since.
    assert.equal((await off.store.runs.findById(plain.runId))?.allowExternalHtmlResources, false);
    plainAgent.send({ t: "bye", reason: "stop" });
    await plainAgent.nextClose();
    off.stopBackgroundTasks();
    await off.fastify.close();
  });

  test("#132: a run that already recorded the flag keeps it, whatever the Tape says now", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    // As if an earlier connection of this run was given the external paragraph, then the Tape was
    // switched off before agentd reconnected.
    await app.store.runs.update(runId, { allowExternalHtmlResources: true });
    await app.store.gurus.update("test-guru", { allowExternalHtmlResources: false });
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.guru.allowExternalHtmlResources, true);
    assert.equal((await app.store.runs.findById(runId))?.allowExternalHtmlResources, true);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});

describe("GitHub App installation-token refresh", () => {
  const soon = (extraMs: number) => new Date(Date.now() + 5 * 60_000 + extraMs).toISOString();
  const later = () => new Date(Date.now() + 60 * 60_000).toISOString();

  function nextCredentialWithin(agent: SocketHandle, ms: number): Promise<{ t?: string; token?: string }> {
    return Promise.race([
      agent.nextCredential(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no credential within ${ms}ms`)), ms)),
    ]);
  }

  test("a superseded socket does not disarm the replacement's refresh", async () => {
    const app = await buildTestApp(
      { AGENT_SOCKET_GRACE_MS: "0" },
      {
        githubRefresh: { floorMs: 5, retryMs: 20, maxAttempts: 5 },
        secretsBroker: {
          async secretsForRun() {
            return { githubToken: "ghs_original", litellmKey: "k", githubTokenExpiresAt: soon(200) };
          },
          async defaultLitellmKey() {
            return "k";
          },
          async refreshGithubAppToken() {
            return { token: "ghs_replacement", expiresAt: later() };
          },
        },
      },
    );
    const { session, runId, runToken } = await makeRunningSession(app);
    const stale = await openAgentSocket(app, runId);
    sendHello(stale, runId, session.id, runToken);
    assert.equal((await stale.nextMessage()).t, "run.spec");

    const replacement = await openAgentSocket(app, runId);
    sendHello(replacement, runId, session.id, runToken);
    assert.equal((await replacement.nextMessage()).t, "run.spec");
    // The real close of `stale` is ordered by the socket. Call the same handler with a socket that
    // is not the one `buildRunSpec` just armed, which is the race when that close lands late.
    (app.agentLink as unknown as { onAgentSocketClosed(runId: string, socket: object): void }).onAgentSocketClosed(runId, {});

    assert.equal((await replacement.nextCredential()).token, "ghs_original");
    const frame = await nextCredentialWithin(replacement, 1500);
    assert.equal(frame.t, "github.credential");
    assert.equal(frame.token, "ghs_replacement");
    const stored = await app.store.runs.findById(runId);
    assert.equal(JSON.stringify(stored?.pending).includes("ghs_replacement"), false);

    const displaced = await stale.nextClose();
    assert.equal(displaced.code, 1001);
    replacement.send({ t: "bye", reason: "stop" });
    await replacement.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a credential that misses the open socket is not stored on the run", async () => {
    let release: (token: { token: string; expiresAt: string } | undefined) => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const app = await buildTestApp(
      {},
      {
        githubRefresh: { floorMs: 5, retryMs: 30, maxAttempts: 2 },
        secretsBroker: {
          async secretsForRun() {
            return { githubToken: "ghs_original", litellmKey: "k", githubTokenExpiresAt: soon(20) };
          },
          async defaultLitellmKey() {
            return "k";
          },
          refreshGithubAppToken() {
            markStarted();
            return new Promise((resolve) => {
              release = resolve;
            });
          },
        },
      },
    );
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    assert.equal((await agent.nextMessage()).t, "run.spec");
    await started;
    agent.close();
    await agent.nextClose();
    await waitFor(() => app.agentLink.hasSocket(runId) === false);
    release({ token: "ghs_replacement", expiresAt: later() });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const stored = await app.store.runs.findById(runId);
    assert.equal(JSON.stringify(stored).includes("ghs_replacement"), false);
    assert.equal(JSON.stringify(stored?.pending).includes("github.credential"), false);
    const abort = await app.fastify.inject({ method: "POST", url: `/api/sessions/${session.id}/abort` });
    assert.equal(abort.body.includes("ghs_replacement"), false);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a failed refresh retries, and a PAT run is not refreshed", async () => {
    let mints = 0;
    const app = await buildTestApp(
      {},
      {
        githubRefresh: { floorMs: 5, retryMs: 20, maxAttempts: 5 },
        secretsBroker: {
          async secretsForRun() {
            return { githubToken: "ghs_original", litellmKey: "k", githubTokenExpiresAt: soon(20) };
          },
          async defaultLitellmKey() {
            return "k";
          },
          async refreshGithubAppToken() {
            mints += 1;
            if (mints < 3) return undefined;
            return { token: "ghs_replacement", expiresAt: later() };
          },
        },
      },
    );
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    assert.equal((await agent.nextMessage()).t, "run.spec");
    assert.equal((await agent.nextCredential()).token, "ghs_original");
    const frame = await nextCredentialWithin(agent, 1500);
    assert.equal(frame.t, "github.credential");
    assert.equal(frame.token, "ghs_replacement");
    assert.equal(mints, 3);
    const stored = await app.store.runs.findById(runId);
    assert.equal(JSON.stringify(stored).includes("ghs_replacement"), false);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();

    let patMints = 0;
    const pat = await buildTestApp(
      {},
      {
        githubRefresh: { floorMs: 5, retryMs: 20, maxAttempts: 5 },
        secretsBroker: {
          async secretsForRun() {
            return { githubToken: "ghp_session", litellmKey: "k" };
          },
          async defaultLitellmKey() {
            return "k";
          },
          async refreshGithubAppToken() {
            patMints += 1;
            return { token: "ghs_should_not_replace", expiresAt: later() };
          },
        },
      },
    );
    const second = await makeRunningSession(pat, { id: "s-pat" });
    const patAgent = await openAgentSocket(pat, second.runId);
    sendHello(patAgent, second.runId, second.session.id, second.runToken);
    assert.equal((await patAgent.nextMessage()).t, "run.spec");
    assert.equal((await patAgent.nextCredential()).token, "ghp_session");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(patMints, 0);
    assert.equal(patAgent.credentialCount(), 0);
    assert.equal(patAgent.messageCount(), 0);
    patAgent.send({ t: "bye", reason: "stop" });
    await patAgent.nextClose();
    pat.stopBackgroundTasks();
    await pat.fastify.close();
  });

  test("refresh stops after the cap and leaves the current token in place", async () => {
    let mints = 0;
    const app = await buildTestApp(
      {},
      {
        githubRefresh: { floorMs: 5, retryMs: 20, maxAttempts: 2 },
        secretsBroker: {
          async secretsForRun() {
            return { githubToken: "ghs_original", litellmKey: "k", githubTokenExpiresAt: soon(15) };
          },
          async defaultLitellmKey() {
            return "k";
          },
          async refreshGithubAppToken() {
            mints += 1;
            return undefined;
          },
        },
      },
    );
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    assert.equal((await agent.nextMessage()).t, "run.spec");
    await waitFor(() => mints >= 3, 1500);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(mints, 3);
    assert.equal(agent.messageCount(), 0);
    const stored = await app.store.runs.findById(runId);
    assert.equal(stored?.pending.length, 0);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a reconnect delivers the token the new hello resolved, because a second run.spec is ignored", async () => {
    const tokens = ["ghs_first", "ghs_second"];
    let n = 0;
    const app = await buildTestApp(
      {},
      {
        githubRefresh: { floorMs: 60_000, retryMs: 60_000, maxAttempts: 1 },
        secretsBroker: {
          async secretsForRun() {
            const token = tokens[Math.min(n, tokens.length - 1)]!;
            n += 1;
            return { githubToken: token, litellmKey: "k", githubTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString() };
          },
          async defaultLitellmKey() {
            return "k";
          },
          async refreshGithubAppToken() {
            return { token: "ghs_from_refresh", expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() };
          },
        },
      },
    );
    const { session, runId, runToken } = await makeRunningSession(app);
    const first = await openAgentSocket(app, runId);
    sendHello(first, runId, session.id, runToken);
    assert.equal((await first.nextMessage()).t, "run.spec");
    assert.equal((await first.nextCredential()).token, "ghs_first");
    first.close();
    await first.nextClose();
    await waitFor(() => app.agentLink.hasSocket(runId) === false);

    const again = await openAgentSocket(app, runId);
    sendHello(again, runId, session.id, runToken, 1);
    assert.equal((await again.nextMessage()).t, "run.spec");
    assert.equal((await again.nextCredential()).token, "ghs_second");
    assert.equal(again.credentialCount(), 0);

    again.send({ t: "bye", reason: "stop" });
    await again.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a mint that finishes after a new hello does not overwrite that hello's token", async () => {
    let releaseRefresh: (token: { token: string; expiresAt: string } | undefined) => void = () => {};
    let markRefresh: () => void = () => {};
    const refreshStarted = new Promise<void>((resolve) => {
      markRefresh = resolve;
    });
    let hellos = 0;
    const app = await buildTestApp(
      { AGENT_SOCKET_GRACE_MS: "0" },
      {
        githubRefresh: { floorMs: 5, retryMs: 60_000, maxAttempts: 2 },
        secretsBroker: {
          async secretsForRun() {
            hellos += 1;
            if (hellos === 1) {
              return { githubToken: "ghs_first", litellmKey: "k", githubTokenExpiresAt: soon(15) };
            }
            return { githubToken: "ghs_second", litellmKey: "k", githubTokenExpiresAt: later() };
          },
          async defaultLitellmKey() {
            return "k";
          },
          refreshGithubAppToken() {
            markRefresh();
            return new Promise((resolve) => {
              releaseRefresh = resolve;
            });
          },
        },
      },
    );
    const { session, runId, runToken } = await makeRunningSession(app);
    const first = await openAgentSocket(app, runId);
    sendHello(first, runId, session.id, runToken);
    assert.equal((await first.nextCredential()).token, "ghs_first");
    await refreshStarted;

    const again = await openAgentSocket(app, runId);
    sendHello(again, runId, session.id, runToken, 1);
    assert.equal((await again.nextCredential()).token, "ghs_second");
    releaseRefresh({ token: "ghs_stale", expiresAt: later() });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(again.credentialCount(), 0);
    const stored = await app.store.runs.findById(runId);
    assert.equal(JSON.stringify(stored).includes("ghs_stale"), false);

    const displaced = await first.nextClose();
    assert.equal(displaced.code, 1001);
    again.send({ t: "bye", reason: "stop" });
    await again.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  /** A test app whose broker reports an App mint failure on every secretsForRun. devMode off: dev
   * mode skips the GitHub token check entirely, so agentd's bearer is a (stubbed) Google id token,
   * as in the 4412 test above; connect with `openAgentSocket(app, runId, ID_TOKEN)`. */
  async function appWithMintFailure(
    t: { mock: { method: typeof import("node:test").mock.method } },
    reason: "unavailable" | "not-installed" | "misconfigured" | "permissions-missing" | "rejected",
    refreshed?: () => void,
    context?: MintFailureContext,
  ) {
    t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
      getPayload: () => ({ email: "agent@test.local" }),
    }));
    return buildTestApp(
      { AGENT_SOCKET_GRACE_MS: "0", OUTFITTER_DEV: "0", AGENT_SA_EMAIL: "agent@test.local" },
      {
        githubRefresh: { floorMs: 5, retryMs: 20, maxAttempts: 3 },
        secretsBroker: {
          async secretsForRun() {
            return { githubToken: "", litellmKey: "k", githubAppFailure: reason, ...(context ? { githubAppFailureContext: context } : {}) };
          },
          async defaultLitellmKey() {
            return "k";
          },
          async refreshGithubAppToken() {
            refreshed?.();
            return { token: "ghs_minted_again", expiresAt: later() };
          },
        },
      },
    );
  }

  test("#158: a reconnect whose mint fails keeps agentd's token and tries the mint again", async (t) => {
    let refreshes = 0;
    const app = await appWithMintFailure(t, "unavailable", () => {
      refreshes += 1;
    });
    const { session, runId, runToken } = await makeRunningSession(app);
    // pi is already going: this hello is a reconnect, and agentd holds the token its first spec had.
    await app.store.runs.update(runId, { state: "running" });
    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec", "not refused");
    assert.equal(spec.secrets.githubToken, "");
    // No credential replaces agentd's token; the retry mints the App token again instead.
    const frame = await nextCredentialWithin(agent, 1500);
    assert.equal(frame.token, "ghs_minted_again");
    assert.ok(refreshes >= 1);
    const run = await app.store.runs.findById(runId);
    assert.notEqual(run?.state, "failed");
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#158: a reconnect when the App can't reach the repo is refused, so a pre-App shared PAT isn't kept", async (t) => {
    const app = await appWithMintFailure(t, "not-installed");
    const { session, runId, runToken } = await makeRunningSession(app);
    await app.store.runs.update(runId, { state: "idle" });
    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    sendHello(agent, runId, session.id, runToken);
    const close = await agent.nextClose();
    assert.equal(close.code, 4412);
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "failed");
    assert.match(run?.statusDetail ?? "", /installation can't reach o\/r/);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#158: misconfigured App secrets fail a first connect with an operator note, and a reconnect keeps its token", async (t) => {
    const first = await appWithMintFailure(t, "misconfigured");
    const a = await makeRunningSession(first);
    const agentA = await openAgentSocket(first, a.runId, "any-google-id-token");
    sendHello(agentA, a.runId, a.session.id, a.runToken);
    assert.equal((await agentA.nextClose()).code, 4412);
    assert.match((await first.store.runs.findById(a.runId))?.statusDetail ?? "", /secrets are set but can't be used/);
    first.stopBackgroundTasks();
    await first.fastify.close();

    const again = await appWithMintFailure(t, "misconfigured");
    const b = await makeRunningSession(again);
    await again.store.runs.update(b.runId, { state: "running" });
    const agentB = await openAgentSocket(again, b.runId, "any-google-id-token");
    sendHello(agentB, b.runId, b.session.id, b.runToken);
    assert.equal((await agentB.nextMessage()).t, "run.spec");
    assert.notEqual((await again.store.runs.findById(b.runId))?.state, "failed");
    agentB.send({ t: "bye", reason: "stop" });
    await agentB.nextClose();
    again.stopBackgroundTasks();
    await again.fastify.close();
  });

  test("#158: a first connect while the mint is unavailable closes 1011 to retry, with a note, and doesn't fail the run", async (t) => {
    const app = await appWithMintFailure(t, "unavailable");
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    sendHello(agent, runId, session.id, runToken);
    const close = await agent.nextClose();
    assert.equal(close.code, 1011);
    const run = await app.store.runs.findById(runId);
    assert.notEqual(run?.state, "failed");
    assert.match(run?.statusDetail ?? "", /GitHub App could not mint a token/);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#158/#172: a first connect (a user's Play, not mail) to a repo the installation doesn't cover fails the run with a note, holding nothing", async (t) => {
    const app = await appWithMintFailure(t, "not-installed", undefined, { installationAccount: "o" });
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    sendHello(agent, runId, session.id, runToken);
    const close = await agent.nextClose();
    assert.equal(close.code, 4412);
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "failed");
    assert.equal(run?.statusDetail, githubAppNotInstalledDetail("o/r", "o"));
    assert.match(run?.statusDetail ?? "", /installation on o doesn't cover o\/r/);
    assert.equal(await app.store.mail.countHeld(session.id), 0, "no mail, nothing held");
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#172: a missing required permission fails the run with a note naming it", async (t) => {
    const app = await appWithMintFailure(t, "permissions-missing", undefined, { missingPermissions: ["contents:write"] });
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    sendHello(agent, runId, session.id, runToken);
    assert.equal((await agent.nextClose()).code, 4412);
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "failed");
    assert.equal(run?.statusDetail, githubAppPermissionsMissingDetail("o/r", ["contents:write"]));
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  /** A session with queued user mail whose run was started by the mail (wakeForMail). */
  async function mailDrivenRun(app: Awaited<ReturnType<typeof buildTestApp>>) {
    await seedGuru(app.store);
    const now = new Date().toISOString();
    await app.store.sessions.insert({ id: "s1", guruId: "test-guru", repo: "o/r", branch: "main", status: "open", cost: 0, createdAt: now, updatedAt: now });
    await app.store.mail.insertIfNew({
      id: "m1", sessionId: "s1", from: { kind: "user" }, text: "please fix it", behavior: "followUp", status: "queued", attempts: 0, createdAt: now,
    });
    assert.equal(await app.mail.wakeForMail("s1"), "woken");
    const run = await app.store.runs.findActiveForSession("s1");
    assert.ok(run?.mailWakePending);
    return { runId: run.id, runToken: runTokenFor(app, run.id) };
  }

  test("#172: a mail-driven run refused for a permanent GitHub failure holds the mail with the reason; the sweep stops waking it; Retry releases it", async (t) => {
    const app = await appWithMintFailure(t, "permissions-missing", undefined, { missingPermissions: ["contents:write"] });
    const { runId, runToken } = await mailDrivenRun(app);
    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    sendHello(agent, runId, "s1", runToken);
    assert.equal((await agent.nextClose()).code, 4412);

    const stored = await app.store.mail.findById("m1");
    assert.equal(stored?.status, "held");
    const reason = githubAppPermissionsMissingDetail("o/r", ["contents:write"]);
    assert.equal(stored?.heldDetail, reason);
    // (The session page's notice for it is covered in mail.test.ts, where the routes need no auth.)
    assert.match(mailHeldFailureNotice(reason), /^Messages held: the Outfitter GitHub App is missing the Contents: read and write permission/);

    // The /tick sweep no longer starts a run (and a sandbox) for it, however often it runs.
    const starts = app.provider.startCalls.length;
    for (let i = 0; i < MAIL_MAX_ATTEMPTS + 2; i++) assert.deepEqual(await app.mail.sweep(), []);
    assert.equal(app.provider.startCalls.length, starts);
    assert.deepEqual(await app.store.mail.expireExhausted(new Date().toISOString(), MAIL_MAX_ATTEMPTS), [], "held, not dead-lettered");
    // New mail joins the hold, with the same reason, and wakes nothing.
    await app.mail.post({ sessionId: "s1", from: { kind: "user" }, text: "and this" });
    assert.equal(await app.store.mail.countHeld("s1"), 2);
    assert.equal(await app.store.mail.heldDetail("s1"), reason);
    assert.equal(app.provider.startCalls.length, starts);

    // Retry (what POST /api/sessions/:id/mail/retry calls): released with a fresh budget and one wake.
    assert.deepEqual(await app.mail.retryHeld("s1"), { released: true, result: "woken" });
    assert.equal(await app.store.mail.countHeld("s1"), 0);
    assert.equal(app.provider.startCalls.length, starts + 1);
    assert.equal((await app.store.mail.findById("m1"))?.heldDetail, undefined);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#172 review: pressing Retry again and again while the credential problem lasts never dead-letters the mail", async (t) => {
    const app = await appWithMintFailure(t, "permissions-missing", undefined, { missingPermissions: ["contents:write"] });
    let { runId, runToken } = await mailDrivenRun(app);
    for (let i = 0; i < MAIL_MAX_ATTEMPTS + 3; i++) {
      const agent = await openAgentSocket(app, runId, "any-google-id-token");
      sendHello(agent, runId, "s1", runToken);
      assert.equal((await agent.nextClose()).code, 4412, `try ${i}`);
      const stored = await app.store.mail.findById("m1");
      assert.equal(stored?.status, "held", `try ${i}`);
      assert.equal(stored?.attempts, 0, "a refused run never tried to deliver, so it costs no attempt");
      assert.deepEqual(await app.store.mail.expireExhausted(new Date().toISOString(), MAIL_MAX_ATTEMPTS), []);
      // Retry: released and woken; the new run is refused the same way.
      assert.deepEqual(await app.mail.retryHeld("s1"), { released: true, result: "woken" });
      const run = await app.store.runs.findActiveForSession("s1");
      assert.ok(run);
      runId = run.id;
      runToken = runTokenFor(app, run.id);
    }
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#172: another session's run validating the protocol doesn't release a credential hold", async (t) => {
    const app = await appWithMintFailure(t, "not-installed");
    const { runId, runToken } = await mailDrivenRun(app);
    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    sendHello(agent, runId, "s1", runToken);
    assert.equal((await agent.nextClose()).code, 4412);
    assert.equal(await app.store.mail.countHeld("s1"), 1);
    // The deploy-mismatch release every validated hello does leaves it alone.
    assert.deepEqual(await app.store.mail.releaseHeld(undefined, "deploy-mismatch"), []);
    assert.equal(await app.store.mail.countHeld("s1"), 1);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#172: a transient mint failure on a mail-driven run holds nothing (1011, agentd retries)", async (t) => {
    const app = await appWithMintFailure(t, "unavailable");
    const { runId, runToken } = await mailDrivenRun(app);
    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    sendHello(agent, runId, "s1", runToken);
    assert.equal((await agent.nextClose()).code, 1011);
    assert.equal(await app.store.mail.countHeld("s1"), 0);
    assert.equal((await app.store.mail.findById("m1"))?.status, "queued");
    // Still charged, so a failure that keeps recurring runs the mail out of attempts instead of
    // starting a run every tick forever.
    assert.equal((await app.store.mail.findById("m1"))?.attempts, 1);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#172: a session whose spec builds again releases its own credential hold", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    const now = new Date().toISOString();
    await app.store.mail.insertIfNew({
      id: "h", sessionId: session.id, from: { kind: "user" }, text: "x", behavior: "followUp", status: "held", attempts: 1,
      createdAt: now, heldAt: now, heldDetail: "the Outfitter GitHub App is missing the Checks: read permission",
    });
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    assert.equal((await agent.nextMessage()).t, "run.spec");
    for (let i = 0; i < 100 && (await app.store.mail.countHeld(session.id)) > 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await app.store.mail.findById("h"))?.status, "queued");
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#159: buildRunSpec records the credential the run was given", async () => {
    const app = await buildTestApp(
      {},
      {
        secretsBroker: {
          async secretsForRun() {
            return { githubToken: "ghs_app", litellmKey: "k", githubCredential: "app" };
          },
          async defaultLitellmKey() {
            return "k";
          },
        },
      },
    );
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    assert.equal((await agent.nextMessage()).t, "run.spec");
    assert.equal((await app.store.runs.findById(runId))?.githubCredential, "app");
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#159: a refused run records none before it is failed", async (t) => {
    t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
      getPayload: () => ({ email: "agent@test.local" }),
    }));
    const app = await buildTestApp(
      { OUTFITTER_DEV: "0", AGENT_SA_EMAIL: "agent@test.local" },
      {
        secretsBroker: {
          async secretsForRun() {
            return { githubToken: "", litellmKey: "k", githubCredential: "none", githubAppFailure: "not-installed" };
          },
          async defaultLitellmKey() {
            return "k";
          },
        },
      },
    );
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    sendHello(agent, runId, session.id, runToken);
    assert.equal((await agent.nextClose()).code, 4412);
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.githubCredential, "none");
    assert.equal(run?.state, "failed");
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#159: a reconnect that keeps agentd's token does not relabel the credential", async (t) => {
    t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
      getPayload: () => ({ email: "agent@test.local" }),
    }));
    const app = await buildTestApp(
      { AGENT_SOCKET_GRACE_MS: "0", OUTFITTER_DEV: "0", AGENT_SA_EMAIL: "agent@test.local" },
      {
        githubRefresh: { floorMs: 60_000, retryMs: 60_000, maxAttempts: 1 },
        secretsBroker: {
          async secretsForRun() {
            return { githubToken: "", litellmKey: "k", githubCredential: "none", githubAppFailure: "unavailable" };
          },
          async defaultLitellmKey() {
            return "k";
          },
          async refreshGithubAppToken() {
            return undefined;
          },
        },
      },
    );
    const { session, runId, runToken } = await makeRunningSession(app);
    await app.store.runs.update(runId, { state: "running", githubCredential: "app" });
    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(spec.secrets.githubToken, "");
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.githubCredential, "app");
    assert.notEqual(run?.state, "failed");
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#159: a store failure while recording the credential does not hide the refusal", async (t) => {
    t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
      getPayload: () => ({ email: "agent@test.local" }),
    }));
    const app = await buildTestApp(
      { OUTFITTER_DEV: "0", AGENT_SA_EMAIL: "agent@test.local" },
      {
        secretsBroker: {
          async secretsForRun() {
            return { githubToken: "", litellmKey: "k", githubCredential: "none", githubAppFailure: "not-installed" };
          },
          async defaultLitellmKey() {
            return "k";
          },
        },
      },
    );
    const original = app.store.runs.update.bind(app.store.runs);
    app.store.runs.update = async (id, patch) => {
      if ("githubCredential" in patch) throw new Error("store down");
      return original(id, patch);
    };
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId, "any-google-id-token");
    sendHello(agent, runId, session.id, runToken);
    const close = await agent.nextClose();
    assert.equal(close.code, 4412);
    // #172's wording for not-installed.
    assert.match(close.reason, /installation doesn't cover the repo/);
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.state, "failed");
    assert.equal(run?.githubCredential, undefined);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("#159: a delivered refresh records its credential, and a miss leaves the old one", async () => {
    const delivered = await buildTestApp(
      {},
      {
        githubRefresh: { floorMs: 5, retryMs: 60_000, maxAttempts: 1 },
        secretsBroker: {
          async secretsForRun() {
            return { githubToken: "ghs_original", litellmKey: "k", githubTokenExpiresAt: soon(20), githubCredential: "app" };
          },
          async defaultLitellmKey() {
            return "k";
          },
          async refreshGithubAppToken() {
            return { token: "ghp_session", credential: "session" };
          },
        },
      },
    );
    const first = await makeRunningSession(delivered);
    const agent = await openAgentSocket(delivered, first.runId);
    sendHello(agent, first.runId, first.session.id, first.runToken);
    assert.equal((await agent.nextMessage()).t, "run.spec");
    assert.equal((await agent.nextCredential()).token, "ghs_original");
    const frame = await nextCredentialWithin(agent, 1500);
    assert.equal(frame.token, "ghp_session");
    const start = Date.now();
    let credential = (await delivered.store.runs.findById(first.runId))?.githubCredential;
    while (credential !== "session" && Date.now() - start < 1500) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      credential = (await delivered.store.runs.findById(first.runId))?.githubCredential;
    }
    assert.equal(credential, "session");
    assert.equal(JSON.stringify(await delivered.store.runs.findById(first.runId)).includes("ghp_session"), false);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    delivered.stopBackgroundTasks();
    await delivered.fastify.close();

    let misses = 0;
    const missed = await buildTestApp(
      {},
      {
        githubRefresh: { floorMs: 5, retryMs: 60_000, maxAttempts: 1 },
        secretsBroker: {
          async secretsForRun() {
            return { githubToken: "ghs_original", litellmKey: "k", githubTokenExpiresAt: soon(20), githubCredential: "app" };
          },
          async defaultLitellmKey() {
            return "k";
          },
          async refreshGithubAppToken() {
            misses += 1;
            return undefined;
          },
        },
      },
    );
    const second = await makeRunningSession(missed, { id: "s-miss" });
    const quiet = await openAgentSocket(missed, second.runId);
    sendHello(quiet, second.runId, second.session.id, second.runToken);
    assert.equal((await quiet.nextMessage()).t, "run.spec");
    await waitFor(() => misses >= 1, 1500);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await missed.store.runs.findById(second.runId))?.githubCredential, "app");
    quiet.send({ t: "bye", reason: "stop" });
    await quiet.nextClose();
    missed.stopBackgroundTasks();
    await missed.fastify.close();
  });
});

describe("#172: GitHub App failure notes", () => {
  test("not-installed: a repo in the installation's own account says the installation doesn't cover it", () => {
    const text = githubAppNotInstalledDetail("cognitio-org/spec-studio", "cognitio-org");
    assert.match(text, /installation on cognitio-org doesn't cover cognitio-org\/spec-studio/);
    assert.match(text, /An owner of cognitio-org adds the repository/);
    assert.doesNotMatch(text, /Install the App/);
  });

  test("not-installed: a repo in another account says only that installation is used", () => {
    const text = githubAppNotInstalledDetail("mgmonteleone/git-ai", "cognitio-org");
    assert.match(text, /^Outfitter only uses the GitHub App's installation on cognitio-org, and mgmonteleone\/git-ai belongs to mgmonteleone/);
    assert.match(text, /Use a repository in cognitio-org, or have an operator store a GitHub token for this session/);
    assert.equal(githubAppNotInstalledDetail("MGMonteleone/git-ai", "mgmonteleone").includes("doesn't cover"), true, "owners compare case-insensitively");
  });

  test("not-installed: without the installation's account, the note covers both cases", () => {
    const text = githubAppNotInstalledDetail("o/r");
    assert.match(text, /installation can't reach o\/r/);
    assert.match(text, /single installation/);
  });

  test("permissions-missing names the permission and where an owner grants and accepts it", () => {
    const one = githubAppPermissionsMissingDetail("o/r", ["contents:write"]);
    assert.match(one, /missing the Contents: read and write permission,/);
    assert.match(one, /grants it in the App's settings/);
    assert.match(one, /accepts the new permissions on the App's installation/);
    assert.match(githubAppPermissionsMissingDetail("o/r", ["contents:write", "metadata:read"]), /Contents: read and write, Metadata: read permissions/);
    assert.match(githubAppPermissionsMissingDetail("o/r"), /a permission runs need \(Contents: read and write, Pull requests: read and write, Metadata: read\)/);
  });

  test("rejected quotes GitHub's message", () => {
    assert.match(githubAppRejectedDetail("o/r", "Validation Failed"), /token request for o\/r \("Validation Failed"\)/);
    assert.doesNotMatch(githubAppRejectedDetail("o/r"), /\(""\)/);
  });

  test("the held-mail notice reuses the note without its own 'start the run again'", () => {
    assert.equal(
      mailHeldFailureNotice("the App is missing X. An owner grants it, then start the run again."),
      "Messages held: the App is missing X. An owner grants it. Press Retry once that's fixed.",
    );
    // Every note reads cleanly without its "so this run has no GitHub access" clause.
    for (const [note, expected] of [
      [githubAppPermissionsMissingDetail("acme/my.repo", ["contents:write"]), "Messages held: the Outfitter GitHub App is missing the Contents: read and write permission. An owner grants it"],
      [githubAppNotInstalledDetail("acme/r", "acme"), "Messages held: the Outfitter GitHub App's installation on acme doesn't cover acme/r. An owner of acme"],
      [githubAppNotInstalledDetail("other/r", "acme"), "Messages held: Outfitter only uses the GitHub App's installation on acme, and other/r belongs to other. Use a repository"],
    ] as const) {
      const notice = mailHeldFailureNotice(note);
      assert.ok(notice.startsWith(expected), notice);
      assert.doesNotMatch(notice, /this run|start the run again/);
    }
  });
});
