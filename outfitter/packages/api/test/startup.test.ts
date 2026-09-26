// Run start-up timing (src/startup.ts): what RunManager.wake and AgentLink stamp on Run.startup,
// the checks on agentd's own numbers (hello.boot, the `startup` frame), the summary the web UI
// shows, and how that summary reaches the browser (GET /api/sessions/:id, SSE status events from
// AgentLink in-process and from SsePoller across roles).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyReply } from "fastify";
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { RunManager } from "../src/runs.ts";
import { SseHub, SsePoller } from "../src/sse.ts";
import type { Run, Session } from "../src/store/types.ts";
import type { SandboxProvider } from "@outfitter/provider-local";
import {
  PI_READY_GRACE_MS,
  parseBootTimings,
  parseStartupPhases,
  startupLogLine,
  summarizeStartup,
} from "../src/startup.ts";
import { buildTestApp } from "./helpers.ts";
import { openAgentSocket, makeRunningSession, CURRENT_TEST_PROTOCOL_VERSION, type SocketHandle } from "./agent-socket.ts";

const T0 = Date.parse("2026-09-26T10:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function sseCollector(): { reply: FastifyReply; frames: Array<{ type: string; data: any }> } {
  const frames: Array<{ type: string; data: any }> = [];
  const reply = {
    raw: {
      writeHead() {},
      flushHeaders() {},
      write(chunk: string) {
        if (chunk.startsWith(":")) return true;
        const [eventLine, dataLine] = chunk.split("\n");
        frames.push({ type: eventLine.replace("event: ", ""), data: JSON.parse(dataLine.replace("data: ", "")) });
        return true;
      },
      on() {},
    },
  } as unknown as FastifyReply;
  return { reply, frames };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Frames on one connection are handled in order and an entry is acked only once handled, so an
 * acked entry proves every frame sent before it has been applied. */
let syncSeq = 1000;
async function sync(agent: SocketHandle): Promise<void> {
  const seq = syncSeq++;
  agent.send({ t: "entry", seq, entry: { id: `sync-${seq}`, parentId: null, type: "custom" } });
  const ack = await agent.nextMessage();
  assert.deepEqual(ack, { t: "ack", seq });
}

function hello(runId: string, sessionId: string, runToken: string, boot?: unknown) {
  return { t: "hello", runId, sessionId, lastAckedSeq: 0, runToken, protocolVersion: CURRENT_TEST_PROTOCOL_VERSION, ...(boot ? { boot } : {}) };
}

describe("parseBootTimings / parseStartupPhases: agent-supplied numbers are checked", () => {
  test("hello.boot keeps known keys only, as clamped whole ms", () => {
    assert.deepEqual(
      parseBootTimings({ bootMs: 1500.4, setupMs: -3, identityTokenMs: 1e12, connectMs: "5", sinceAssignedMs: NaN, runToken: "secret", extra: 1 }),
      { bootMs: 1500, setupMs: 0, identityTokenMs: 3_600_000 },
    );
    assert.equal(parseBootTimings(undefined), undefined, "an older agentd sends no boot");
    assert.equal(parseBootTimings([1, 2]), undefined);
    assert.equal(parseBootTimings({ nope: 1 }), undefined);
    assert.equal(parseBootTimings("x"), undefined);
  });

  test("phases keep known names, first occurrence, clamped ms, bounded list", () => {
    assert.deepEqual(
      parseStartupPhases([
        { name: "run.spec received", ms: 0 },
        { name: "pi spawned", ms: 900.7 },
        { name: "pi spawned", ms: 5 },
        { name: "first model token", ms: 1 },
        { name: "<script>", ms: 1 },
        { name: "pi ready", ms: 9e9 },
        { name: "session import done", ms: "fast" },
        null,
        "pi ready",
      ]),
      [
        { name: "run.spec received", ms: 0 },
        { name: "pi spawned", ms: 901 },
        { name: "pi ready", ms: 3_600_000 },
      ],
    );
    assert.equal(parseStartupPhases({ name: "pi ready", ms: 1 }), undefined);
    assert.equal(parseStartupPhases([]), undefined);
    const flood = Array.from({ length: 10_000 }, () => ({ name: "nope", ms: 1 }));
    flood.push({ name: "pi ready", ms: 1 });
    assert.equal(parseStartupPhases(flood), undefined, "only the first few items are even looked at");
  });
});

describe("summarizeStartup", () => {
  const base = {
    wakeAt: iso(0),
    providerReturnedAt: iso(1_000),
    helloAt: iso(6_000),
    specSentAt: iso(6_400),
    readyAt: iso(9_000),
    provider: "gke" as const,
    warm: false,
  };

  test("null for a run without startup data, before it is ready, or without wakeAt", () => {
    assert.equal(summarizeStartup({ id: "r" }), null);
    assert.equal(summarizeStartup({ id: "r", startup: { wakeAt: iso(0), helloAt: iso(5) } }), null);
    assert.equal(summarizeStartup({ id: "r", startup: { readyAt: iso(5) } }), null);
  });

  test("an older agentd (no boot, no phases): wake -> ready, complete at once", () => {
    const s = summarizeStartup({ id: "r", startup: base }, T0 + 9_500)!;
    assert.equal(s.totalMs, 9_000);
    assert.equal(s.complete, true);
    assert.equal(s.provider, "gke");
    assert.equal(s.warm, false);
    assert.deepEqual(
      s.segments.map((seg) => [seg.id, seg.ms]),
      [["request", 1_000], ["sandbox", 5_000], ["workspace", 3_000]],
    );
    assert.equal(s.segments[1].details, undefined);
  });

  test("a newer agentd before pi ready: partial, not complete until the grace runs out", () => {
    const startup = { ...base, agentd: { bootMs: 4_200, setupMs: 300, sinceAssignedMs: 4_200, identityTokenMs: 700, connectMs: 150 } };
    assert.equal(summarizeStartup({ id: "r", startup }, T0 + 9_500)!.complete, false);
    assert.equal(summarizeStartup({ id: "r", startup }, T0 + 9_000 + PI_READY_GRACE_MS)!.complete, true);
  });

  test("with agentd's boot and phases: wake -> pi ready, segments add up, sandbox details from agentd", () => {
    const startup = {
      ...base,
      agentd: { bootMs: 4_200, setupMs: 300, sinceAssignedMs: 4_200, identityTokenMs: 700, connectMs: 150 },
      phases: [
        { name: "run.spec received", ms: 0 },
        { name: "repo cloned", ms: 1_500 },
        { name: "session import done", ms: 2_000 },
        { name: "pi spawned", ms: 2_300 },
        { name: "pi ready", ms: 5_300 },
      ],
    };
    const s = summarizeStartup({ id: "r", startup }, T0 + 9_500)!;
    assert.equal(s.complete, true);
    // 1000 request + 5000 sandbox + (400 spec + 2300 to spawn) + 3000 loading pi
    assert.equal(s.totalMs, 11_700);
    assert.equal(s.segments.reduce((sum, seg) => sum + seg.ms, 0), s.totalMs);
    const byId = Object.fromEntries(s.segments.map((seg) => [seg.id, seg]));
    assert.equal(byId.pi.ms, 3_000);
    assert.equal(byId.workspace.ms, 2_700);
    assert.deepEqual(byId.workspace.details, [
      { label: "Run spec (secrets, tokens)", ms: 400 },
      { label: "Cloning the repo", ms: 1_500 },
      { label: "Importing the session", ms: 500 },
      { label: "Starting pi", ms: 300 },
    ]);
    assert.deepEqual(byId.sandbox.details, [
      { label: "Starting the container", ms: 800 },
      { label: "agentd setup", ms: 300 },
      { label: "Identity token", ms: 700 },
      { label: "Connecting to Outfitter", ms: 150 },
    ]);
  });

  test("a warm pod: the idle wait and pre-claim setup are left out of the breakdown", () => {
    const startup = {
      ...base,
      warm: true,
      helloAt: iso(2_000),
      specSentAt: iso(2_100),
      readyAt: iso(4_000),
      agentd: { bootMs: 3_600_000, setupMs: 400, assignmentWaitMs: 3_599_000, sinceAssignedMs: 600, identityTokenMs: 350, connectMs: 100 },
    };
    const s = summarizeStartup({ id: "r", startup }, T0 + 4_000 + PI_READY_GRACE_MS)!;
    assert.equal(s.totalMs, 4_000);
    const sandbox = s.segments.find((seg) => seg.id === "sandbox")!;
    assert.equal(sandbox.ms, 1_000);
    assert.deepEqual(sandbox.details, [
      { label: "Handing over the warm sandbox", ms: 400 },
      { label: "Identity token", ms: 350 },
      { label: "Connecting to Outfitter", ms: 100 },
    ]);
  });

  test("a hello that beats provider.start()'s return (or a skewed clock) never yields a negative segment", () => {
    const s = summarizeStartup({ id: "r", startup: { ...base, providerReturnedAt: iso(7_000), specSentAt: iso(5_000) } }, T0 + 20_000)!;
    for (const seg of s.segments) assert.ok(seg.ms >= 0, JSON.stringify(s.segments));
    assert.equal(s.totalMs, 9_000);
  });

  test("startupLogLine flattens the segments for Cloud Logging", () => {
    const s = summarizeStartup({ id: "r1", startup: base }, T0 + 9_500)!;
    assert.deepEqual(startupLogLine(s), {
      severity: "INFO",
      message: "startup summary",
      runId: "r1",
      provider: "gke",
      warm: false,
      totalMs: 9_000,
      requestMs: 1_000,
      sandboxMs: 5_000,
      workspaceMs: 3_000,
    });
  });
});

describe("RunManager.wake stamps startup", () => {
  function stubProvider(result: { handle: string; warm?: boolean }): SandboxProvider {
    return {
      start: async () => result,
      stop: async () => {},
      status: async () => "running",
    };
  }

  test("wakeAt and provider at creation, providerReturnedAt and warm once start() resolves", async () => {
    const store = new MemoryStore();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const run = await new RunManager(store, stubProvider({ handle: "h1", warm: true }), config).wake("s1");
    const s = run.startup!;
    assert.equal(s.wakeAt, run.createdAt);
    assert.equal(s.provider, config.sandboxProvider);
    assert.equal(s.warm, true);
    assert.ok(Date.parse(s.providerReturnedAt!) >= Date.parse(s.wakeAt!));
  });

  test("a provider that can't tell warm from cold leaves warm out", async () => {
    const store = new MemoryStore();
    const run = await new RunManager(store, stubProvider({ handle: "h1" }), loadConfig({} as NodeJS.ProcessEnv)).wake("s1");
    assert.equal("warm" in run.startup!, false);
    assert.ok(run.startup!.providerReturnedAt);
  });

  test("a hello stamped before start() returns is not lost", async () => {
    const store = new MemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider: SandboxProvider = {
      start: async (launch) => {
        await store.runs.mergeStartup(launch.runId, { helloAt: "2026-09-26T10:00:01.000Z" }, "helloAt");
        await gate;
        return { handle: "h", warm: false };
      },
      stop: async () => {},
      status: async () => "running",
    };
    const woken = new RunManager(store, provider, loadConfig({} as NodeJS.ProcessEnv)).wake("s1");
    release();
    const run = await woken;
    assert.equal(run.startup?.helloAt, "2026-09-26T10:00:01.000Z");
    assert.equal(run.startup?.warm, false);
  });
});

describe("AgentLink records startup and publishes the summary", () => {
  test("hello, run.spec, first ready and the `startup` frame are stamped once; SSE and GET carry the summary; a log line is written", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    const sse = sseCollector();
    app.sse.subscribe(session.id, sse.reply);

    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      let agent = await openAgentSocket(app, runId);
      agent.send(hello(runId, session.id, runToken, { bootMs: 4200, setupMs: 300, sinceAssignedMs: 4200, identityTokenMs: 700, connectMs: 150, assignmentWaitMs: -5, runToken: "leak?" }));
      assert.equal((await agent.nextMessage()).t, "run.spec");
      await sync(agent);

      let run = (await app.store.runs.findById(runId))!;
      assert.ok(run.startup?.helloAt);
      assert.ok(run.startup?.specSentAt);
      assert.ok(Date.parse(run.startup.specSentAt!) >= Date.parse(run.startup.helloAt!));
      assert.deepEqual(run.startup.agentd, { bootMs: 4200, setupMs: 300, assignmentWaitMs: 0, sinceAssignedMs: 4200, identityTokenMs: 700, connectMs: 150 });
      const firstHello = run.startup.helloAt;
      const firstSpec = run.startup.specSentAt;

      // Not ready yet: no summary.
      const before = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });
      assert.equal(before.json().startup, null);

      // A `startup` field agentd puts on its own status frame never reaches the browser.
      agent.send({ t: "status", state: "cloning", startup: { totalMs: 1 } });
      agent.send({ t: "status", state: "idle", startup: { totalMs: 1 } });
      await sync(agent);
      run = (await app.store.runs.findById(runId))!;
      assert.ok(run.startup?.readyAt);
      const statuses = sse.frames.filter((f) => f.type === "status");
      assert.equal(statuses[0].data.state, "cloning");
      assert.equal("startup" in statuses[0].data, false);
      const readyFrame = statuses[1].data;
      assert.equal(readyFrame.state, "idle");
      assert.equal(readyFrame.startup.runId, runId);
      assert.equal(readyFrame.startup.complete, false, "a newer agentd's pi ready is still to come");

      // Later ready transitions don't move readyAt or re-publish a summary.
      agent.send({ t: "status", state: "running" });
      await sync(agent);
      const firstReady = run.startup.readyAt;
      run = (await app.store.runs.findById(runId))!;
      assert.equal(run.startup?.readyAt, firstReady);
      assert.equal("startup" in sse.frames.filter((f) => f.type === "status").at(-1)!.data, false);

      agent.send({
        t: "startup",
        phases: [
          { name: "run.spec received", ms: 0 },
          { name: "session import done", ms: 800 },
          { name: "pi spawned", ms: 1_000 },
          { name: "pi ready", ms: 3_500 },
          { name: "made up", ms: 5 },
        ],
      });
      await sync(agent);
      run = (await app.store.runs.findById(runId))!;
      assert.deepEqual(run.startup?.phases?.map((p) => p.name), ["run.spec received", "session import done", "pi spawned", "pi ready"]);
      const summaryFrame = sse.frames.filter((f) => f.type === "status").at(-1)!.data;
      assert.equal(summaryFrame.startup.complete, true);
      assert.equal(summaryFrame.state, "running");
      const pi = summaryFrame.startup.segments.find((seg: any) => seg.id === "pi");
      assert.equal(pi.ms, 2_500);

      const lines = logged.filter((l) => l.includes('"startup summary"')).map((l) => JSON.parse(l));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].runId, runId);
      assert.equal(lines[0].totalMs, summaryFrame.startup.totalMs);
      assert.equal(lines[0].piMs, 2_500);

      // A second `startup` frame is ignored.
      agent.send({ t: "startup", phases: [{ name: "pi ready", ms: 1 }] });
      await sync(agent);
      run = (await app.store.runs.findById(runId))!;
      assert.equal(run.startup?.phases?.find((p) => p.name === "pi ready")?.ms, 3_500);
      assert.equal(logged.filter((l) => l.includes('"startup summary"')).length, 1);

      const detail = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });
      assert.equal(detail.json().startup.complete, true);
      assert.equal(detail.json().startup.totalMs, summaryFrame.startup.totalMs);

      // A reconnect (the sandbox lost its socket) doesn't move helloAt/specSentAt or replace boot.
      agent.close();
      await waitFor(() => !app.agentLink.hasSocket(runId));
      agent = await openAgentSocket(app, runId);
      agent.send(hello(runId, session.id, runToken, { bootMs: 999_999, setupMs: 1, sinceAssignedMs: 1 }));
      assert.equal((await agent.nextMessage()).t, "run.spec");
      await sync(agent);
      run = (await app.store.runs.findById(runId))!;
      assert.equal(run.startup?.helloAt, firstHello);
      assert.equal(run.startup?.specSentAt, firstSpec);
      assert.equal(run.startup?.agentd?.bootMs, 4200);

      agent.send({ t: "bye", reason: "stop" });
      await agent.nextClose();
    } finally {
      console.log = origLog;
      app.stopBackgroundTasks();
      await app.fastify.close();
    }
  });

  test("a run created before Run.startup existed gets no stamps and no summary", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    await app.store.runs.update(runId, { startup: undefined });
    const agent = await openAgentSocket(app, runId);
    agent.send(hello(runId, session.id, runToken, { bootMs: 10, setupMs: 1, sinceAssignedMs: 10 }));
    await agent.nextMessage(); // run.spec
    agent.send({ t: "status", state: "idle" });
    agent.send({ t: "startup", phases: [{ name: "pi ready", ms: 5 }] });
    await sync(agent);
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.startup, undefined);
    const detail = await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    assert.equal(detail.json().startup, null);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("an older agentd (no hello.boot, no `startup` frame) still gets a complete wake -> ready summary", async () => {
    const app = await buildTestApp();
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    agent.send(hello(runId, session.id, runToken));
    await agent.nextMessage(); // run.spec
    agent.send({ t: "status", state: "idle" });
    await sync(agent);
    const run = await app.store.runs.findById(runId);
    assert.equal(run?.startup?.agentd, undefined);
    const detail = (await app.fastify.inject({ method: "GET", url: `/api/sessions/${session.id}` })).json();
    assert.equal(detail.startup.complete, true);
    assert.deepEqual(detail.startup.segments.map((s: any) => s.id), ["request", "sandbox", "workspace"]);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});

describe("SsePoller carries the startup summary across roles", () => {
  test("published with the status when it appears or changes, and null for a new run without one", async () => {
    const store = new MemoryStore();
    const hub = new SseHub();
    const poller = new SsePoller(hub, store, 60_000);
    const sse = sseCollector();
    const now = new Date().toISOString();
    const session: Session = { id: "s1", guruId: "g", repo: null, status: "open", cost: 0, createdAt: now, updatedAt: now };
    await store.sessions.insert(session);
    hub.subscribe("s1", sse.reply);
    poller.watch("s1");
    poller.stop();

    const run: Run = {
      id: "r1",
      sessionId: "s1",
      state: "provisioning",
      lastAckedSeq: 0,
      pending: [],
      createdAt: now,
      updatedAt: now,
      startup: { wakeAt: iso(0), providerReturnedAt: iso(500), helloAt: iso(2_000), specSentAt: iso(2_100) },
    };
    await store.runs.insert(run);
    await poller.pollOne("s1");
    let status = sse.frames.filter((f) => f.type === "status");
    assert.equal(status.length, 1);
    assert.equal(status[0].data.startup, null, "not started yet");

    await store.runs.update("r1", { state: "idle" });
    await store.runs.mergeStartup("r1", { readyAt: iso(3_000) });
    await poller.pollOne("s1");
    status = sse.frames.filter((f) => f.type === "status");
    assert.equal(status.length, 2);
    assert.equal(status[1].data.startup.totalMs, 3_000);

    await poller.pollOne("s1");
    assert.equal(sse.frames.filter((f) => f.type === "status").length, 2, "unchanged: nothing new");

    await store.runs.mergeStartup("r1", { phases: [{ name: "pi spawned", ms: 800 }, { name: "pi ready", ms: 2_000 }] });
    await poller.pollOne("s1");
    status = sse.frames.filter((f) => f.type === "status");
    assert.equal(status.length, 3);
    assert.equal(status[2].data.state, "idle");
    assert.equal(status[2].data.startup.totalMs, 2_100 + 2_000);

    // The run stops and a new one starts: the old summary is dropped with an explicit null.
    await store.runs.update("r1", { state: "stopped", updatedAt: new Date(Date.now() + 1000).toISOString() });
    await store.runs.insert({ ...run, id: "r2", state: "provisioning", startup: { wakeAt: iso(10_000) } });
    await poller.pollOne("s1");
    status = sse.frames.filter((f) => f.type === "status");
    assert.equal(status.at(-1)!.data.startup, null);
  });
});
