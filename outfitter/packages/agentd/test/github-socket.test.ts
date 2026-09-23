import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunController, type LinkPort } from "../src/run.js";
import { listenGithubSocket } from "../src/github-socket.js";
import { emptySessionJsonl } from "../src/session.js";
import { authHeaderSecret, type GitOps } from "../src/git.js";
import type { DownMessage, DownRunSpec, UpGithubRequest, UpMessage } from "../src/protocol.js";
import type { PiProcess } from "../src/pi.js";

const TOKEN = "ghp_test_TOKEN_89_do_not_leak";

class FakeLink implements LinkPort {
  sent: UpMessage[] = [];
  private handler: ((msg: DownMessage) => void) | undefined;
  private closeHandlers: Array<() => void> = [];
  private openHandlers: Array<() => void> = [];

  sendSeq(build: (seq: number) => UpMessage): number {
    const msg = build(1);
    this.sent.push(msg);
    return 1;
  }

  send(msg: UpMessage): void {
    this.sent.push(msg);
  }

  onMessage(handler: (msg: DownMessage) => void): void {
    this.handler = handler;
  }

  setSessionId(): void {}

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  deliver(msg: DownMessage): void {
    this.handler?.(msg);
  }

  drop(): void {
    for (const handler of this.closeHandlers) handler();
  }

  reopen(): void {
    for (const handler of this.openHandlers) handler();
  }
}

function githubFrames(link: FakeLink): UpGithubRequest[] {
  return link.sent.filter((msg): msg is UpGithubRequest => msg.t === "github.request");
}

function idlePi(): PiProcess {
  return { send() {}, onEvent() {}, onStderr() {}, onExit() {}, kill() {}, pid: 1 };
}

function fakeGit(): GitOps {
  return {
    async clone() {},
    async commitAll() {
      return { committed: false };
    },
    async push() {
      return { head: "abc", pushed: false };
    },
    async diff() {
      return "";
    },
  };
}

async function socketDir(): Promise<{ dir: string; path: string }> {
  let dir = await mkdtemp(join(tmpdir(), "ghs-"));
  let path = join(dir, "s");
  // macOS sun_path is 104 bytes. A long tmpdir would make listen fail.
  if (Buffer.byteLength(path) > 100) {
    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp("/tmp/ghs-");
    path = join(dir, "s");
  }
  return { dir, path };
}

function connect(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Lines from `socket`, including any that arrived before `next()` was called. */
function lineReader(socket: net.Socket): { next(): Promise<string> } {
  let buf = "";
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  socket.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
      idx = buf.indexOf("\n");
    }
  });
  return {
    next() {
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
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

async function settledSoon(pending: Promise<unknown>, ms = 40): Promise<boolean> {
  const winner = await Promise.race([
    pending.then(() => "done"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
  return winner === "done";
}

test("github socket: 0660, forwards each reqId, pins the path, and keeps the token out of env and logs", async (t) => {
  const { dir, path } = await socketDir();
  const logs: string[] = [];
  const link = new FakeLink();
  let spawnEnv: Record<string, string> | undefined;
  const workspace = await mkdtemp(join(tmpdir(), "ghs-ws-"));
  const controller = new RunController({
    link,
    gitOps: fakeGit(),
    workspace,
    piBin: "unused-in-test",
    agentdVersion: "test",
    piVersion: "test",
    heartbeatIntervalMs: 60_000,
    githubSocketPath: path,
    spawnPi: (opts) => {
      spawnEnv = opts.env;
      return idlePi();
    },
    importSession: async () => join(workspace, "session.jsonl"),
    writeSnapshotFile: async () => join(workspace, "snap.jsonl"),
    onExit: () => {},
    onLog: (line) => logs.push(line),
  });
  const clients: net.Socket[] = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    controller.dispose();
    await new Promise((r) => setTimeout(r, 50));
    await rm(dir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  const previousUmask = process.umask(0o022);
  try {
    const spec: DownRunSpec = {
      t: "run.spec",
      session: { id: "sess-gh", name: "gh", cwd: "/workspace" },
      repo: {
        cloneUrl: "https://github.com/acme/widget.git",
        branch: "outfitter/sess-gh",
        baseBranch: "main",
        createBranch: true,
      },
      guru: {
        model: "fake/model",
        env: {
          OUTFITTER_GITHUB_SOCKET: "/tmp/spoofed.sock",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authHeaderSecret(TOKEN)}`,
        },
      },
      snapshot: { jsonl: emptySessionJsonl("sess-gh", "/workspace") },
      secrets: { githubToken: TOKEN },
      idleStopSeconds: 3600,
      checkpointEvery: "turn",
    };
    link.deliver(spec);
    await waitFor(() => spawnEnv !== undefined);
  } finally {
    process.umask(previousUmask);
  }

  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o660, `socket mode is ${mode.toString(8)}, want 660`);

  const env = spawnEnv!;
  assert.equal(env.OUTFITTER_GITHUB_SOCKET, path, "guru.env cannot retarget the socket");
  const envBlob = JSON.stringify(env);
  assert.ok(!envBlob.includes(TOKEN), "token in the environment overlay");
  assert.ok(!envBlob.includes(authHeaderSecret(TOKEN)), "token base64 in the environment overlay");
  assert.ok(!envBlob.toLowerCase().includes("extraheader"));
  assert.ok(!envBlob.toLowerCase().includes("authorization"));
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.match(env.GIT_CONFIG_KEY_0!, /^url\.http:\/\/127\.0\.0\.1:\d+\/acme\/widget\.git\.insteadOf$/);

  const clientA = await connect(path);
  const clientB = await connect(path);
  clients.push(clientA, clientB);
  const linesA = lineReader(clientA);
  const linesB = lineReader(clientB);
  clientA.write(`${JSON.stringify({ t: "github.request", reqId: "req-a", op: "issues.list", args: { note: TOKEN } })}\n`);
  clientB.write(
    `${JSON.stringify({ t: "github.request", reqId: "req-b", op: "pulls.create", args: { title: "x" }, idempotencyKey: "idem-1" })}\n`,
  );
  await waitFor(() => githubFrames(link).length >= 2);

  const frames = githubFrames(link);
  assert.equal(frames.length, 2);
  const frameA = frames.find((frame) => frame.reqId === "req-a");
  const frameB = frames.find((frame) => frame.reqId === "req-b");
  assert.ok(frameA && frameB, "each request keeps its own reqId");
  assert.equal(frameA.op, "issues.list");
  assert.deepEqual(frameA.args, { note: TOKEN });
  assert.equal(frameA.idempotencyKey, undefined);
  assert.equal("seq" in frameA, false);
  assert.equal(frameB.op, "pulls.create");
  assert.equal(frameB.idempotencyKey, "idem-1");
  assert.deepEqual(frameB.args, { title: "x" });

  // Out of order, and the refusal string is the API's, unchanged.
  link.deliver({ t: "github.result", reqId: "req-b", ok: false, error: "not permitted" });
  link.deliver({ t: "github.result", reqId: "req-a", ok: true, data: { items: [] } });

  const lineB = await linesB.next();
  const lineA = await linesA.next();
  assert.equal(lineB.includes("\n"), false);
  assert.equal(lineA.includes("\n"), false);
  assert.deepEqual(JSON.parse(lineB), { t: "github.result", reqId: "req-b", ok: false, error: "not permitted" });
  assert.deepEqual(JSON.parse(lineA), { t: "github.result", reqId: "req-a", ok: true, data: { items: [] } });
  assert.ok(!lineA.includes(TOKEN) && !lineB.includes(TOKEN), "token in a socket response");
  assert.equal(await settledSoon(linesA.next()), false, "result A was more than one line");
  assert.equal(await settledSoon(linesB.next()), false, "result B was more than one line");

  const logBlob = logs.join("\n");
  assert.ok(!logBlob.includes(TOKEN), `token in logs: ${logBlob}`);
  assert.ok(!logBlob.includes(authHeaderSecret(TOKEN)), "token base64 in logs");
});

test("github socket: a dropped link fails a write immediately and retries a read once", async (t) => {
  const { dir, path } = await socketDir();
  const link = new FakeLink();
  const workspace = await mkdtemp(join(tmpdir(), "ghs-ws-"));
  let spawned = false;
  const controller = new RunController({
    link,
    gitOps: fakeGit(),
    workspace,
    piBin: "unused-in-test",
    agentdVersion: "test",
    piVersion: "test",
    heartbeatIntervalMs: 60_000,
    githubSocketPath: path,
    spawnPi: () => {
      spawned = true;
      return idlePi();
    },
    importSession: async () => join(workspace, "session.jsonl"),
    writeSnapshotFile: async () => join(workspace, "snap.jsonl"),
    onExit: () => {},
    onLog: () => {},
  });
  const clients: net.Socket[] = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    controller.dispose();
    await new Promise((r) => setTimeout(r, 50));
    await rm(dir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  link.deliver({
    t: "run.spec",
    session: { id: "sess-drop", name: "drop", cwd: "/workspace" },
    guru: { model: "fake/model" },
    snapshot: { jsonl: emptySessionJsonl("sess-drop", "/workspace") },
    secrets: {},
    idleStopSeconds: 3600,
    checkpointEvery: "turn",
  });
  await waitFor(() => spawned);

  const reader = await connect(path);
  const writer = await connect(path);
  clients.push(reader, writer);
  const readLines = lineReader(reader);
  const writeLines = lineReader(writer);
  reader.write(`${JSON.stringify({ t: "github.request", reqId: "read-1", op: "issues.list", args: {} })}\n`);
  writer.write(
    `${JSON.stringify({ t: "github.request", reqId: "write-1", op: "issues.create", args: { title: "t" }, idempotencyKey: "key-1" })}\n`,
  );
  await waitFor(() => githubFrames(link).length === 2);

  const readPending = readLines.next();
  link.drop();
  assert.equal(await settledSoon(readPending), false, "a read must not fail on the first drop");
  const writeLine = await writeLines.next();
  assert.deepEqual(JSON.parse(writeLine), {
    t: "github.result",
    reqId: "write-1",
    ok: false,
    error: "api link dropped",
  });

  link.reopen();
  await waitFor(() => githubFrames(link).filter((frame) => frame.reqId === "read-1").length === 2);
  assert.equal(githubFrames(link).filter((frame) => frame.reqId === "write-1").length, 1, "a write is not resent");
  assert.equal(await settledSoon(readPending), false, "the retry is another up frame, not an error yet");

  link.drop();
  const readLine = await readPending;
  assert.deepEqual(JSON.parse(readLine), {
    t: "github.result",
    reqId: "read-1",
    ok: false,
    error: "api link dropped",
  });
  const before = githubFrames(link).length;
  link.reopen();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(githubFrames(link).length, before, "a second drop ends the read");
});

test("github socket: chown 0:group after listen, and a client token is not logged", async (t) => {
  const { dir, path } = await socketDir();
  const logs: string[] = [];
  const chowns: Array<{ uid: number; gid: number }> = [];
  const previousUmask = process.umask(0o022);
  let forwarded = false;
  let socket: Awaited<ReturnType<typeof listenGithubSocket>> | undefined;
  try {
    socket = await listenGithubSocket({
      path,
      group: 42,
      log: (line) => logs.push(line),
      send: () => {
        forwarded = true;
      },
      chown: async (_path, uid, gid) => {
        chowns.push({ uid, gid });
      },
    });
  } finally {
    process.umask(previousUmask);
  }
  t.after(async () => {
    await socket?.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(chowns, [{ uid: 0, gid: 42 }]);
  assert.equal((await stat(path)).mode & 0o777, 0o660);

  const client = await connect(path);
  t.after(() => client.destroy());
  client.write(`${JSON.stringify({ t: "github.request", reqId: "r", op: "issues.list", args: { note: TOKEN } })}\n`);
  await waitFor(() => forwarded);
  assert.ok(logs.every((line) => !line.includes(TOKEN)), `token in socket logs: ${logs.join("\n")}`);
});
