import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { StartupPhases, STARTUP_PROBE_ID } from "../src/startup-phases.js";
import { RunController, type LinkPort } from "../src/run.js";
import { createLogger } from "../src/logger.js";
import { writeSnapshotFile, emptySessionJsonl, preloadSessionManager } from "../src/session.js";
import type { DownMessage, DownRunSpec, PiRpcCommand, PiRpcEvent, UpMessage } from "../src/protocol.js";
import type { PiProcess } from "../src/pi.js";

test("StartupPhases: logs each phase once, with time since start and since the previous phase", () => {
  let now = 1000;
  const lines: Array<Record<string, unknown>> = [];
  const phases = new StartupPhases({ log: (message, fields) => lines.push({ message, ...fields }), now: () => now });
  now = 1200;
  phases.mark("session import done");
  now = 1250;
  phases.mark("session import done"); // repeated: ignored
  now = 4200;
  phases.mark("pi ready", { extra: 1 });
  assert.deepEqual(lines, [
    { message: "phase", phase: "session import done", ms: 200, sinceLastMs: 200 },
    { message: "phase", phase: "pi ready", ms: 3200, sinceLastMs: 3000, extra: 1 },
  ]);
});

test("StartupPhases: the probe is a get_state with agentd's own id; its response is swallowed and marks readiness", () => {
  const lines: string[] = [];
  const phases = new StartupPhases({ log: (_m, fields) => lines.push(String(fields.phase)) });
  const sent: PiRpcCommand[] = [];
  phases.probe({ send: (c) => sent.push(c) });
  assert.deepEqual(sent, [{ id: STARTUP_PROBE_ID, type: "get_state" }]);

  assert.equal(phases.observe({ type: "response", id: STARTUP_PROBE_ID, command: "get_state", success: true }), true);
  assert.equal(phases.observe({ type: "response", command: "get_state", success: true }), false, "someone else's get_state is forwarded");
  assert.equal(phases.observe({ type: "response", command: "prompt", success: true }), false);
  assert.equal(phases.observe({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } }), false);
  assert.equal(phases.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "o" } }), false);
  assert.equal(phases.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "k" } }), false);
  assert.equal(phases.observe({ type: "agent_end" }), false);
  assert.deepEqual(lines, ["pi ready", "first prompt accepted", "first model token", "first answer done"]);
});

class FakeLink implements LinkPort {
  sent: UpMessage[] = [];
  private seq = 1;
  private handler: ((msg: DownMessage) => void) | undefined;
  sendSeq(build: (seq: number) => UpMessage): number {
    const seq = this.seq++;
    this.sent.push(build(seq));
    return seq;
  }
  send(msg: UpMessage): void {
    this.sent.push(msg);
  }
  onMessage(handler: (msg: DownMessage) => void): void {
    this.handler = handler;
  }
  setSessionId(): void {}
  deliver(msg: DownMessage): void {
    this.handler?.(msg);
  }
}

function controllablePi(): PiProcess & { emit(event: PiRpcEvent): void; sent: PiRpcCommand[] } {
  const handlers: Array<(event: PiRpcEvent) => void> = [];
  const sent: PiRpcCommand[] = [];
  return {
    send: (c) => void sent.push(c),
    onEvent: (h) => void handlers.push(h),
    onStderr() {},
    onExit() {},
    kill() {},
    pid: 1,
    sent,
    emit: (e) => handlers.forEach((h) => h(e)),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function startRun(startupPhases: boolean) {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-phases-test-"));
  const link = new FakeLink();
  const logLines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n").filter(Boolean)) logLines.push(JSON.parse(line));
      cb();
    },
  });
  let pi: ReturnType<typeof controllablePi> | undefined;
  const controller = new RunController({
    link,
    gitOps: {} as any,
    workspace,
    piBin: "unused",
    agentdVersion: "test",
    piVersion: "test",
    heartbeatIntervalMs: 60_000,
    spawnPi: () => (pi = controllablePi()),
    importSession: async (snapshotFile, _cwd, sessionId) => {
      const file = join(await mkdtemp(join(tmpdir(), "outfitter-phases-session-")), `${sessionId}.jsonl`);
      await copyFile(snapshotFile, file);
      return file;
    },
    writeSnapshotFile,
    createTailer: () => ({ start() {}, stop() {}, async poll() {} }),
    onExit: () => {},
    logger: createLogger({}, { stream, isTTY: false }),
    startupPhases,
  });
  const spec: DownRunSpec = {
    t: "run.spec",
    session: { id: "sess-phases", name: "phases", cwd: "/workspace" },
    guru: { model: "fake/model" },
    snapshot: { jsonl: emptySessionJsonl("sess-phases", "/workspace") },
    secrets: {},
    idleStopSeconds: 3600,
    checkpointEvery: "turn",
  };
  link.deliver(spec);
  link.deliver({ t: "prompt", text: "hello" }); // arrives while pi is still starting: queued
  await waitFor(() => pi !== undefined && pi.sent.some((c) => c.type === "prompt"));
  return { controller, link, logLines, pi: pi! };
}

test("RunController with startupPhases: probes pi once before the queued prompt, swallows the probe's answer, logs every phase", async () => {
  const { controller, link, logLines, pi } = await startRun(true);
  assert.deepEqual(pi.sent.map((c) => c.type), ["get_state", "prompt"], "the probe goes first so it measures load, not the turn");
  assert.equal(pi.sent[0].id, STARTUP_PROBE_ID);

  pi.emit({ type: "response", id: STARTUP_PROBE_ID, command: "get_state", success: true, data: {} });
  pi.emit({ type: "response", command: "prompt", success: true });
  pi.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  pi.emit({ type: "agent_end", messages: [] });

  const forwarded = link.sent.filter((m) => m.t === "event").map((m: any) => m.event);
  assert.ok(!forwarded.some((e) => e.id === STARTUP_PROBE_ID), "the probe's response never reaches the api");
  assert.deepEqual(forwarded.map((e) => e.type), ["response", "message_update", "agent_end"]);

  const phases = logLines.filter((l) => l.message === "phase");
  assert.deepEqual(phases.map((l) => l.phase), [
    "run.spec received", "session import done", "pi spawned", "pi ready",
    "first prompt accepted", "first model token", "first answer done",
  ]);
  for (const p of phases) assert.equal(typeof p.ms, "number");
  controller.dispose();
});

test("preloadSessionManager never surfaces an error by itself (importSession reports it where it matters)", async () => {
  const rejections: unknown[] = [];
  const onRejection = (err: unknown) => rejections.push(err);
  process.on("unhandledRejection", onRejection);
  try {
    preloadSessionManager(); // pi's package may or may not be resolvable from here; either way no throw
    preloadSessionManager(); // and a second call shares the first import
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("RunController without startupPhases: pi sees only the api's commands and no phase lines are logged", async () => {
  const { controller, logLines, pi } = await startRun(false);
  assert.deepEqual(pi.sent.map((c) => c.type), ["prompt"]);
  assert.equal(logLines.filter((l) => l.message === "phase").length, 0);
  controller.dispose();
});
