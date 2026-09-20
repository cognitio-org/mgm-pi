import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RunController, type LinkPort, type RunControllerDeps } from "../src/run.js";
import { spawnPi, SessionTailer } from "../src/pi.js";
import { writeSnapshotFile, emptySessionJsonl } from "../src/session.js";
import type { DownMessage, DownRunSpec, PiRpcCommand, PiRpcEvent, RunState, UpMessage } from "../src/protocol.js";
import type { GitOps, CloneSpec } from "../src/git.js";
import type { PiProcess } from "../src/pi.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakePiPath = join(here, "fake-pi.js");

class FakeLink implements LinkPort {
  sent: UpMessage[] = [];
  sessionId: string | undefined;
  private seq = 1;
  private handler: ((msg: DownMessage) => void) | undefined;

  sendSeq(build: (seq: number) => UpMessage): number {
    const seq = this.seq++;
    const msg = build(seq);
    this.sent.push(msg);
    return seq;
  }

  send(msg: UpMessage): void {
    this.sent.push(msg);
  }

  onMessage(handler: (msg: DownMessage) => void): void {
    this.handler = handler;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  deliver(msg: DownMessage): void {
    this.handler?.(msg);
  }
}

function fakeGitOps(): GitOps & { clones: CloneSpec[]; commits: string[]; pushes: number } {
  const clones: CloneSpec[] = [];
  const commits: string[] = [];
  let pushes = 0;
  return {
    clones,
    commits,
    get pushes() {
      return pushes;
    },
    async clone(spec) {
      clones.push(spec);
    },
    async commitAll(_cwd, message) {
      commits.push(message);
      return { committed: true };
    },
    async push(_cwd, _branch) {
      pushes++;
      return { head: `deadbeef${pushes}` };
    },
    async diff() {
      return "diff --git a/x b/x";
    },
    async headSha() {
      return "deadbeef0";
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A hand-controlled PiProcess double: no real child process, so the test drives `emit()` directly
 * and gets full, synchronous control over event timing -- needed to deterministically interleave pi
 * events with an in-flight checkpoint, which a real (fast, one-shot) fake-pi.js child can't give us. */
function makeControllablePi(): PiProcess & { emit(event: PiRpcEvent): void; sent: PiRpcCommand[] } {
  const eventHandlers: Array<(event: PiRpcEvent) => void> = [];
  const sent: PiRpcCommand[] = [];
  return {
    send(command) {
      sent.push(command);
    },
    onEvent(handler) {
      eventHandlers.push(handler);
    },
    onStderr() {},
    onExit() {},
    kill() {},
    pid: 1,
    sent,
    emit(event) {
      for (const h of eventHandlers) h(event);
    },
  };
}

async function setupController(
  overrides: Partial<DownRunSpec> = {},
  depsOverrides: Partial<RunControllerDeps> = {},
) {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-run-test-"));
  const link = new FakeLink();
  const gitOps = fakeGitOps();
  const states: RunState[] = [];
  let exitCode: number | undefined;

  const controller = new RunController({
    link,
    gitOps,
    workspace,
    piBin: "unused-in-test",
    agentdVersion: "test",
    piVersion: "test",
    heartbeatIntervalMs: 60_000,
    spawnPi: (opts) => spawnPi({ ...opts, piBin: process.execPath, args: [fakePiPath, ...opts.args] }),
    importSession: async (snapshotFile, _cwd, sessionId) => {
      const dir = await mkdtemp(join(tmpdir(), "outfitter-run-test-session-"));
      const file = join(dir, `${sessionId}.jsonl`);
      await copyFile(snapshotFile, file);
      return file;
    },
    writeSnapshotFile,
    createTailer: (file, onEntry) => new SessionTailer(file, onEntry as any, { intervalMs: 20 }),
    onExit: (code) => {
      exitCode = code;
    },
    onLog: () => {},
    ...depsOverrides,
  });
  controller.onStateChange((s) => states.push(s));

  const spec: DownRunSpec = {
    t: "run.spec",
    session: { id: "sess1", name: "test-run", cwd: "/workspace" },
    repo: { cloneUrl: "file:///dev/null", branch: "outfitter/sess1", baseBranch: "main", createBranch: true },
    guru: { model: "fake/model" },
    snapshot: { jsonl: emptySessionJsonl("sess1", "/workspace") },
    secrets: {},
    idleStopSeconds: 3600,
    checkpointEvery: "turn",
    ...overrides,
  };

  return { controller, link, gitOps, states, workspace, spec, getExitCode: () => exitCode };
}

test("RunController: cloning -> restoring -> starting -> idle on a fresh run.spec", async (t) => {
  const { controller, link, states, spec } = await setupController();
  t.after(() => controller.dispose());
  link.deliver(spec);
  await waitFor(() => states.includes("idle"));
  assert.deepEqual(states, ["cloning", "restoring", "starting", "idle"]);
  assert.equal(link.sent.filter((m) => m.t === "status").length, 4);
});

test("RunController: a prompt drives pi through agent_start -> agent_settled and back to idle, streaming events and the fake entry", async (t) => {
  const { controller, link, states, spec } = await setupController();
  t.after(() => controller.dispose());
  link.deliver(spec);
  await waitFor(() => states.includes("idle"));

  link.deliver({ t: "prompt", text: "ping" });
  await waitFor(() => link.sent.some((m) => m.t === "event" && (m as any).event.type === "agent_settled"));
  // The session-file entry append races the RPC event stream (separate polling loop); wait for it too.
  await waitFor(() => link.sent.some((m) => m.t === "entry"));

  const eventTypes = link.sent.filter((m) => m.t === "event").map((m: any) => m.event.type);
  assert.ok(eventTypes.includes("agent_start"));
  assert.ok(eventTypes.includes("message_update"));
  assert.ok(eventTypes.includes("agent_end"));
  assert.ok(eventTypes.includes("agent_settled"));

  const entryFrames = link.sent.filter((m) => m.t === "entry") as any[];
  assert.equal(entryFrames.length, 1);
  assert.equal(entryFrames[0].entry.message.content[0].text, "pong");

  // running, then back to idle
  assert.deepEqual(states, ["cloning", "restoring", "starting", "idle", "running", "idle"]);
});

test("RunController: explicit checkpoint commits, pushes, and reports the new head, then returns to idle", async (t) => {
  const { controller, link, gitOps, states, spec } = await setupController();
  t.after(() => controller.dispose());
  link.deliver(spec);
  await waitFor(() => states.includes("idle"));

  link.deliver({ t: "checkpoint", message: "manual checkpoint" });
  await waitFor(() => link.sent.some((m) => m.t === "checkpoint"));

  assert.equal(gitOps.commits.at(-1), "manual checkpoint");
  assert.equal(gitOps.pushes, 1);
  const cp = link.sent.find((m) => m.t === "checkpoint") as any;
  assert.equal(cp.pushed, true);
  assert.equal(cp.branch, "outfitter/sess1");

  await waitFor(() => states.at(-1) === "idle");
});

test("RunController: diff and read down-messages get replies", async (t) => {
  const { controller, link, spec, workspace } = await setupController();
  t.after(() => controller.dispose());
  link.deliver(spec);
  await writeFile(join(workspace, "hello.txt"), "hi there");

  link.deliver({ t: "diff", reqId: "d1" });
  await waitFor(() => link.sent.some((m) => m.t === "diff.result"));
  const diffResult = link.sent.find((m) => m.t === "diff.result") as any;
  assert.equal(diffResult.reqId, "d1");
  assert.equal(diffResult.base, "main");

  link.deliver({ t: "read", reqId: "r1", path: "hello.txt" });
  await waitFor(() => link.sent.some((m) => m.t === "read.result"));
  const readResult = link.sent.find((m) => m.t === "read.result") as any;
  assert.equal(readResult.reqId, "r1");
  assert.equal(readResult.content, "hi there");

  link.deliver({ t: "read", reqId: "r2", path: "does-not-exist.txt" });
  await waitFor(() => link.sent.filter((m) => m.t === "read.result").length === 2);
  const missing = link.sent.filter((m) => m.t === "read.result").find((m: any) => m.reqId === "r2") as any;
  assert.ok(missing.error);
});

test("RunController: stop checkpoints, sends bye('stop'), and exits 0", async (t) => {
  const { controller, link, states, spec, getExitCode } = await setupController();
  t.after(() => controller.dispose());
  link.deliver(spec);
  await waitFor(() => states.includes("idle"));

  link.deliver({ t: "stop", reason: "user requested" });
  await waitFor(() => link.sent.some((m) => m.t === "bye"));

  const bye = link.sent.find((m) => m.t === "bye") as any;
  assert.equal(bye.reason, "stop");
  assert.equal(bye.message, "user requested");
  assert.equal(getExitCode(), 0);
  assert.equal(states.at(-1), "stopping");
});

test("RunController: idle-stop fires after idleStopSeconds and sends bye('idle')", async (t) => {
  const { controller, link, getExitCode, spec } = await setupController({ idleStopSeconds: 0 });
  t.after(() => controller.dispose());
  link.deliver(spec);
  await waitFor(() => link.sent.some((m) => m.t === "bye"), 5000);
  const bye = link.sent.find((m) => m.t === "bye") as any;
  assert.equal(bye.reason, "idle");
  assert.equal(getExitCode(), 0);
});

test("RunController: repo-less run skips cloning, restores a workspace tarball, and checkpoint/diff avoid git", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-run-test-"));
  const link = new FakeLink();
  const gitOps = fakeGitOps();
  const states: RunState[] = [];

  // A prior workspace tarball to restore: one file, "seed.txt".
  const seedDir = await mkdtemp(join(tmpdir(), "outfitter-run-test-seed-"));
  await writeFile(join(seedDir, "seed.txt"), "from the snapshot");
  const tarPath = join(seedDir, "snapshot.tar.gz");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("tar", ["-czf", tarPath, "-C", seedDir, "seed.txt"]);

  const snapshotDir = await mkdtemp(join(tmpdir(), "outfitter-run-test-snapshots-"));

  const controller = new RunController({
    link,
    gitOps,
    workspace,
    piBin: "unused-in-test",
    agentdVersion: "test",
    piVersion: "test",
    heartbeatIntervalMs: 60_000,
    workspaceSnapshotDir: snapshotDir,
    spawnPi: (opts) => spawnPi({ ...opts, piBin: process.execPath, args: [fakePiPath, ...opts.args] }),
    importSession: async (snapshotFile, _cwd, sessionId) => {
      const dir = await mkdtemp(join(tmpdir(), "outfitter-run-test-session-"));
      const file = join(dir, `${sessionId}.jsonl`);
      await copyFile(snapshotFile, file);
      return file;
    },
    writeSnapshotFile,
    createTailer: (file, onEntry) => new SessionTailer(file, onEntry as any, { intervalMs: 20 }),
    onLog: () => {},
  });
  t.after(() => controller.dispose());
  controller.onStateChange((s) => states.push(s));

  const spec: DownRunSpec = {
    t: "run.spec",
    session: { id: "sess-repoless", name: "no-repo-run", cwd: "/workspace" },
    // no `repo` field at all -- the non-coding-session path
    workspace: { snapshotUrl: tarPath },
    guru: { model: "fake/model" },
    snapshot: { jsonl: emptySessionJsonl("sess-repoless", "/workspace") },
    secrets: {},
    idleStopSeconds: 3600,
    checkpointEvery: "turn",
  };

  link.deliver(spec);
  await waitFor(() => states.includes("idle"));

  // cloning is skipped entirely for a repo-less run.
  assert.deepEqual(states, ["restoring", "starting", "idle"]);
  assert.equal(gitOps.clones.length, 0);

  // the workspace tarball was restored.
  const seedContent = await readFile(join(workspace, "seed.txt"), "utf8");
  assert.equal(seedContent, "from the snapshot");

  // a file changes; diff (no repo) reports it as a changed file, not a git patch.
  await writeFile(join(workspace, "new-file.txt"), "hello");
  link.deliver({ t: "diff", reqId: "d1" });
  await waitFor(() => link.sent.some((m) => m.t === "diff.result"));
  const diffResult = link.sent.find((m) => m.t === "diff.result") as any;
  assert.equal(diffResult.base, undefined);
  assert.equal(diffResult.patch, undefined);
  assert.ok(diffResult.files.includes("new-file.txt"));

  // checkpoint (no repo) tars the workspace instead of pushing.
  link.deliver({ t: "checkpoint" });
  await waitFor(() => link.sent.some((m) => m.t === "checkpoint"));
  const cp = link.sent.find((m) => m.t === "checkpoint") as any;
  assert.equal(cp.branch, undefined);
  assert.equal(cp.pushed, undefined);
  assert.ok(cp.workspaceUrl);
  assert.equal(gitOps.commits.length, 0);
  assert.equal(gitOps.pushes, 0);

  // after that checkpoint, diff again reports nothing new (baseline was refreshed).
  link.deliver({ t: "diff", reqId: "d2" });
  await waitFor(() => link.sent.filter((m) => m.t === "diff.result").length === 2);
  const diffAfter = link.sent.filter((m) => m.t === "diff.result").find((m: any) => m.reqId === "d2") as any;
  assert.deepEqual(diffAfter.files, []);
});

test("RunController: a prompt sent before pi is spawned (still cloning/restoring/starting) is queued and delivered to pi once it starts", async (t) => {
  const { controller, link, states, spec } = await setupController();
  t.after(() => controller.dispose());

  link.deliver(spec);
  // Fire immediately, in the same tick -- begin() has only just started (it's suspended at its
  // first `await`, inside gitOps.clone()), so `pi` is definitely still undefined here.
  link.deliver({ t: "prompt", text: "ping" });

  await waitFor(() => link.sent.some((m) => m.t === "event" && (m as any).event.type === "agent_settled"));
  await waitFor(() => link.sent.some((m) => m.t === "entry"));

  const eventTypes = link.sent.filter((m) => m.t === "event").map((m: any) => m.event.type);
  assert.ok(eventTypes.includes("agent_start"), "queued prompt must still reach pi and start a turn");
  assert.ok(eventTypes.includes("agent_settled"));

  const entryFrames = link.sent.filter((m) => m.t === "entry") as any[];
  assert.equal(entryFrames.length, 1);
  assert.equal(entryFrames[0].entry.message.content[0].text, "pong");

  assert.deepEqual(states, ["cloning", "restoring", "starting", "idle", "running", "idle"]);
});

test("RunController: multiple down-messages queued before pi is up are flushed to pi in the order they arrived", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-run-test-"));
  const link = new FakeLink();
  const gitOps = fakeGitOps();
  let pi: ReturnType<typeof makeControllablePi> | undefined;

  const controller = new RunController({
    link,
    gitOps,
    workspace,
    piBin: "unused-in-test",
    agentdVersion: "test",
    piVersion: "test",
    heartbeatIntervalMs: 60_000,
    spawnPi: () => {
      pi = makeControllablePi();
      return pi;
    },
    importSession: async (_snapshotFile, _cwd, sessionId) => join(workspace, `${sessionId}.jsonl`),
    writeSnapshotFile,
    createTailer: () => ({ start() {}, stop() {}, poll: async () => {} }),
    onLog: () => {},
  });
  t.after(() => controller.dispose());

  const spec: DownRunSpec = {
    t: "run.spec",
    session: { id: "sess-queue-order", name: "queue-order", cwd: "/workspace" },
    repo: { cloneUrl: "file:///dev/null", branch: "outfitter/sess-queue-order", baseBranch: "main", createBranch: true },
    guru: { model: "fake/model" },
    snapshot: { jsonl: emptySessionJsonl("sess-queue-order", "/workspace") },
    secrets: {},
    idleStopSeconds: 3600,
    checkpointEvery: "turn",
  };

  link.deliver(spec);
  // All three land before pi is spawned (begin() is still suspended in gitOps.clone()).
  link.deliver({ t: "prompt", text: "first" });
  link.deliver({ t: "steer", text: "second" });
  link.deliver({ t: "abort" });

  await waitFor(() => pi !== undefined && pi.sent.length === 3);
  assert.deepEqual(
    pi!.sent.map((c) => c.type),
    ["prompt", "steer", "abort"],
  );
  assert.equal((pi!.sent[0] as any).message, "first");
  assert.equal((pi!.sent[1] as any).message, "second");
});

test("RunController: activity while idle that never produces agent_start/agent_settled (e.g. a `/command` prompt pi handles locally, or one it rejects) re-arms the idle timer instead of leaving it disarmed forever", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-run-test-"));
  const link = new FakeLink();
  const gitOps = fakeGitOps();
  const states: RunState[] = [];
  let exitCode: number | undefined;
  let pi: ReturnType<typeof makeControllablePi> | undefined;

  const controller = new RunController({
    link,
    gitOps,
    workspace,
    piBin: "unused-in-test",
    agentdVersion: "test",
    piVersion: "test",
    heartbeatIntervalMs: 60_000,
    spawnPi: () => {
      pi = makeControllablePi();
      return pi;
    },
    importSession: async (_snapshotFile, _cwd, sessionId) => join(workspace, `${sessionId}.jsonl`),
    writeSnapshotFile,
    createTailer: () => ({ start() {}, stop() {}, poll: async () => {} }),
    onExit: (code) => {
      exitCode = code;
    },
    onLog: () => {},
  });
  t.after(() => controller.dispose());
  controller.onStateChange((s) => states.push(s));

  const spec: DownRunSpec = {
    t: "run.spec",
    session: { id: "sess-idle-reset", name: "idle-reset", cwd: "/workspace" },
    repo: { cloneUrl: "file:///dev/null", branch: "outfitter/sess-idle-reset", baseBranch: "main", createBranch: true },
    guru: { model: "fake/model" },
    snapshot: { jsonl: emptySessionJsonl("sess-idle-reset", "/workspace") },
    secrets: {},
    idleStopSeconds: 0.05, // 50ms
    checkpointEvery: "turn",
  };

  link.deliver(spec);
  await waitFor(() => states.includes("idle"));

  // A prompt that pi never turns into a real agent turn (a `/command` it handles locally, or one it
  // rejects outright) -- no agent_start/agent_settled ever follows, so nothing but markActivity()
  // itself can re-arm the idle timer.
  link.deliver({ t: "prompt", text: "/some-local-command" });
  assert.equal(pi!.sent.length, 1);

  await waitFor(() => link.sent.some((m) => m.t === "bye"), 3000);
  const bye = link.sent.find((m) => m.t === "bye") as any;
  assert.equal(bye.reason, "idle");
  assert.equal(exitCode, 0);
});

test("RunController: an agent_settled arriving mid-checkpoint resolves to idle afterward (not the stale pre-checkpoint state), and the idle timer fires", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-run-test-"));
  const link = new FakeLink();
  const states: RunState[] = [];
  let exitCode: number | undefined;
  let pi: ReturnType<typeof makeControllablePi> | undefined;
  let releaseCommit: (() => void) | undefined;
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });

  const gitOps: GitOps = {
    async clone() {},
    async commitAll() {
      await commitGate; // block until the test releases it -- simulates a slow checkpoint push
      return { committed: false };
    },
    async push() {
      throw new Error("push should not be called when nothing was committed");
    },
    async diff() {
      return "";
    },
    async headSha() {
      return "deadbeef";
    },
  };

  const controller = new RunController({
    link,
    gitOps,
    workspace,
    piBin: "unused-in-test",
    agentdVersion: "test",
    piVersion: "test",
    heartbeatIntervalMs: 60_000,
    spawnPi: () => {
      pi = makeControllablePi();
      return pi;
    },
    importSession: async (_snapshotFile, _cwd, sessionId) => join(workspace, `${sessionId}.jsonl`),
    writeSnapshotFile,
    createTailer: () => ({ start() {}, stop() {}, poll: async () => {} }),
    onExit: (code) => {
      exitCode = code;
    },
    onLog: () => {},
  });
  t.after(() => controller.dispose());
  controller.onStateChange((s) => states.push(s));

  const spec: DownRunSpec = {
    t: "run.spec",
    session: { id: "sess-mid-checkpoint", name: "mid-checkpoint", cwd: "/workspace" },
    repo: { cloneUrl: "file:///dev/null", branch: "outfitter/sess-mid-checkpoint", baseBranch: "main", createBranch: true },
    guru: { model: "fake/model" },
    snapshot: { jsonl: emptySessionJsonl("sess-mid-checkpoint", "/workspace") },
    secrets: {},
    // Short, but not 0: 0 would race idle-stop against this test's own drive-into-"running" step
    // (armIdleTimer() with a 0ms delay can fire before the test's pi.emit("agent_start") clears
    // it, entering the real idle-stop path prematurely and starving the test's own checkpoint
    // scenario). 200ms comfortably outlasts the poll-based waitFor() latency below.
    idleStopSeconds: 0.2,
    checkpointEvery: "turn",
  };

  link.deliver(spec);
  await waitFor(() => states.includes("idle"));

  // Drive pi into "running" directly -- deterministic, unlike racing the real fake-pi.js child.
  pi!.emit({ type: "agent_start" });
  await waitFor(() => states.at(-1) === "running");

  // An explicit checkpoint starts; it blocks inside gitOps.commitAll() until the test releases it.
  link.deliver({ t: "checkpoint", message: "mid-turn checkpoint" });
  await waitFor(() => states.at(-1) === "checkpointing");

  // The turn settles while the checkpoint is still in flight.
  pi!.emit({ type: "agent_settled" });
  // Give the event a tick to be handled; it must not be lost, but also must not flip state early
  // (checkpointing must still own the state machine until checkpointNow() actually resolves).
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(states.at(-1), "checkpointing");

  const statesBeforeRelease = states.length;
  releaseCommit!();
  // idleStopSeconds is 0, so idle-stop can fire on the very next tick after entering idle --
  // checking states.at(-1) here would race that transition. Instead assert the checkpoint
  // resolved to "idle" (not a restored "running") by looking at what was appended right after the
  // checkpoint's own "checkpointing" entry.
  await waitFor(() => states.length > statesBeforeRelease);
  assert.equal(states[statesBeforeRelease], "idle");

  // ...and the idle timer was actually armed (not left disarmed from a wrongly-restored "running"):
  // idle-stop fires and the process exits.
  await waitFor(() => link.sent.some((m) => m.t === "bye"));
  const bye = link.sent.find((m) => m.t === "bye") as any;
  assert.equal(bye.reason, "idle");
  assert.equal(exitCode, 0);
});

test("RunController: a non-2xx snapshot fetch fails the run with a clear, status-including message (instead of importing an error page as the session)", async (t) => {
  const { controller, link, states, spec, getExitCode } = await setupController(
    { snapshot: { url: "https://example.test/missing-snapshot.jsonl" } },
    { fetchFn: (async () => new Response("not found", { status: 404, statusText: "Not Found" })) as any },
  );
  t.after(() => controller.dispose());

  link.deliver(spec);

  await waitFor(() => link.sent.some((m) => m.t === "bye"));
  const bye = link.sent.find((m) => m.t === "bye") as any;
  assert.equal(bye.reason, "error");
  assert.match(bye.message, /404/);
  assert.match(bye.message, /Not Found/);
  await waitFor(() => getExitCode() === 1);
  assert.ok(!states.includes("idle"));
});
