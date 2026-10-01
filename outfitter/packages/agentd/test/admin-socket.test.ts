import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunController, type LinkPort } from "../src/run.js";
import { listenBrokerSocket } from "../src/broker-socket.js";
import { adminCapabilities, type RunSpecGuru } from "../src/protocol.js";
import { emptySessionJsonl } from "../src/session.js";
import type { GitOps } from "../src/git.js";
import type { DownMessage, DownRunSpec, UpAdminRequest, UpMessage } from "../src/protocol.js";
import type { PiProcess } from "../src/pi.js";


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

function adminFrames(link: FakeLink): UpAdminRequest[] {
  return link.sent.filter((msg): msg is UpAdminRequest => msg.t === "admin.request");
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
  let dir = await mkdtemp(join(tmpdir(), "adm-"));
  let path = join(dir, "s");
  // macOS sun_path is 104 bytes. A long tmpdir would make listen fail.
  if (Buffer.byteLength(path) > 100) {
    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp("/tmp/adm-");
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


// Sysop tools (#287): the admin kind of broker-socket.ts, and RunController opening it only for a
// tape with admin tools.

function controllerFor(path: string, link: FakeLink, workspace: string, env: { value?: Record<string, string> }) {
  return new RunController({
    link,
    gitOps: fakeGit(),
    workspace,
    piBin: "unused-in-test",
    agentdVersion: "test",
    piVersion: "test",
    heartbeatIntervalMs: 60_000,
    adminSocketPath: path,
    spawnPi: (opts) => {
      env.value = opts.env;
      return idlePi();
    },
    importSession: async () => join(workspace, "session.jsonl"),
    writeSnapshotFile: async () => join(workspace, "snap.jsonl"),
    onExit: () => {},
    onLog: () => {},
  });
}

function specFor(adminTools: "off" | "manage" | undefined, more: Partial<RunSpecGuru> = {}): DownRunSpec {
  return {
    t: "run.spec",
    session: { id: "sess-adm", name: "adm", cwd: "/workspace" },
    guru: { model: "fake/model", adminTools, ...more, env: { OUTFITTER_ADMIN_SOCKET: "/tmp/spoofed.sock", OUTFITTER_ADMIN_CAPS: "admin" } },
    snapshot: { jsonl: emptySessionJsonl("sess-adm", "/workspace") },
    secrets: {},
    idleStopSeconds: 3600,
    checkpointEvery: "turn",
  } as DownRunSpec;
}

test("admin socket: opened for a tape with admin tools, pinned, forwards frames and results", async (t) => {
  const { dir, path } = await socketDir();
  const link = new FakeLink();
  const env: { value?: Record<string, string> } = {};
  const workspace = await mkdtemp(join(tmpdir(), "adm-ws-"));
  const controller = controllerFor(path, link, workspace, env);
  const clients: net.Socket[] = [];
  t.after(async () => {
    for (const c of clients) c.destroy();
    controller.dispose();
    await new Promise((r) => setTimeout(r, 50));
    await rm(dir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });
  link.deliver(specFor("manage"));
  await waitFor(() => env.value !== undefined);
  assert.equal(env.value!.OUTFITTER_ADMIN_SOCKET, path, "guru.env cannot retarget the socket");
  assert.equal(env.value!.OUTFITTER_ADMIN_CAPS, "admin");
  assert.equal(((await stat(path)).mode & 0o777), 0o660);

  const client = await connect(path);
  clients.push(client);
  const lines = lineReader(client);
  client.write(`${JSON.stringify({ t: "admin.request", reqId: "r1", op: "tapes.list", args: {} })}\n`);
  client.write(`${JSON.stringify({ t: "admin.request", reqId: "r2", op: "tapes.delete", args: { id: "x" }, idempotencyKey: "k" })}\n`);
  await waitFor(() => adminFrames(link).length >= 2);
  assert.deepEqual(adminFrames(link).map((f) => [f.reqId, f.op, f.idempotencyKey]), [["r1", "tapes.list", undefined], ["r2", "tapes.delete", "k"]]);

  link.deliver({ t: "admin.result", reqId: "r1", ok: true, text: "reviewer  Reviewer  a/b" } as DownMessage);
  assert.deepEqual(JSON.parse(await lines.next()), { t: "admin.result", reqId: "r1", ok: true, text: "reviewer  Reviewer  a/b" });
  link.deliver({ t: "admin.result", reqId: "r2", ok: false, error: "the owner declined", needsApproval: true, extra: "dropped" } as unknown as DownMessage);
  assert.deepEqual(JSON.parse(await lines.next()), { t: "admin.result", reqId: "r2", ok: false, error: "the owner declined", needsApproval: true });

  // A github frame on the admin socket is invalid, not forwarded.
  client.write(`${JSON.stringify({ t: "github.request", reqId: "r3", op: "issues.list", args: {} })}\n`);
  assert.deepEqual(JSON.parse(await lines.next()), { t: "admin.result", reqId: "r3", ok: false, error: "invalid admin request" });
  assert.equal(adminFrames(link).length, 2);
});

for (const adminTools of ["off", undefined] as const) {
  test(`admin socket: not opened, and pinned empty, when admin tools are ${adminTools ?? "absent"}`, async (t) => {
    const { dir, path } = await socketDir();
    const link = new FakeLink();
    const env: { value?: Record<string, string> } = {};
    const workspace = await mkdtemp(join(tmpdir(), "adm-ws-"));
    const controller = controllerFor(path, link, workspace, env);
    t.after(async () => {
      controller.dispose();
      await new Promise((r) => setTimeout(r, 50));
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    });
    link.deliver(specFor(adminTools, { memory: "off", agentEngine: false }));
    await waitFor(() => env.value !== undefined);
    assert.equal(env.value!.OUTFITTER_ADMIN_SOCKET, "");
    assert.equal(env.value!.OUTFITTER_ADMIN_CAPS, "", "guru.env cannot claim capabilities");
    await assert.rejects(stat(path), { code: "ENOENT" });
  });
}

// E9 (docs/specs/atlas-agent-engine-and-a2a.md §3.3): memory and Agent Engine ops go through the
// same socket, so it opens for either; OUTFITTER_ADMIN_CAPS tells Kernal which tools to register.
for (const [label, more, caps] of [
  ["memory tool", { memory: "tool" }, "memory"],
  ["memory auto", { memory: "auto" }, "memory"],
  ["agentEngine", { agentEngine: true }, "agentEngine"],
  ["admin, memory and agentEngine", { adminTools: "operator", memory: "auto", agentEngine: true }, "admin,memory,agentEngine"],
] as const) {
  test(`admin socket: opened for ${label}, with OUTFITTER_ADMIN_CAPS=${caps}`, async (t) => {
    const { dir, path } = await socketDir();
    const link = new FakeLink();
    const env: { value?: Record<string, string> } = {};
    const workspace = await mkdtemp(join(tmpdir(), "adm-ws-"));
    const controller = controllerFor(path, link, workspace, env);
    t.after(async () => {
      controller.dispose();
      await new Promise((r) => setTimeout(r, 50));
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    });
    link.deliver(specFor(undefined, more as Partial<RunSpecGuru>));
    await waitFor(() => env.value !== undefined);
    assert.equal(env.value!.OUTFITTER_ADMIN_SOCKET, path);
    assert.equal(env.value!.OUTFITTER_ADMIN_CAPS, caps);
    assert.equal(((await stat(path)).mode & 0o777), 0o660);
  });
}

test("admin socket: a failed listen leaves both the socket and OUTFITTER_ADMIN_CAPS empty", async (t) => {
  const link = new FakeLink();
  const env: { value?: Record<string, string> } = {};
  const workspace = await mkdtemp(join(tmpdir(), "adm-ws-"));
  const controller = controllerFor("/dev/null/admin.sock", link, workspace, env);
  t.after(async () => {
    controller.dispose();
    await new Promise((r) => setTimeout(r, 50));
    await rm(workspace, { recursive: true, force: true });
  });
  link.deliver(specFor("manage", { memory: "auto" }));
  await waitFor(() => env.value !== undefined);
  assert.equal(env.value!.OUTFITTER_ADMIN_SOCKET, "");
  assert.equal(env.value!.OUTFITTER_ADMIN_CAPS, "");
});

test("adminCapabilities: only exact values count, in a fixed order", () => {
  assert.deepEqual(adminCapabilities({}), []);
  assert.deepEqual(adminCapabilities({ adminTools: "off", memory: "off", agentEngine: false }), []);
  assert.deepEqual(adminCapabilities({ memory: "bogus" as never, agentEngine: "true" as never }), []);
  assert.deepEqual(adminCapabilities({ agentEngine: true, memory: "tool", adminTools: "manage" }), ["admin", "memory", "agentEngine"]);
});

test("admin broker: a write fails on link drop and is never resent; a read is resent once", async (t) => {
  const { dir, path } = await socketDir();
  const sent: UpAdminRequest[] = [];
  const broker = await listenBrokerSocket({ kind: "admin", path, send: (m) => sent.push(m as UpAdminRequest) });
  const client = await connect(path);
  t.after(async () => {
    client.destroy();
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  });
  const lines = lineReader(client);
  client.write(`${JSON.stringify({ t: "admin.request", reqId: "w", op: "tapes.create", args: {}, idempotencyKey: "k" })}\n`);
  client.write(`${JSON.stringify({ t: "admin.request", reqId: "r", op: "tapes.list", args: {} })}\n`);
  await waitFor(() => sent.length >= 2);
  broker.onLinkDown();
  assert.deepEqual(JSON.parse(await lines.next()), { t: "admin.result", reqId: "w", ok: false, error: "api link dropped" });
  broker.onLinkUp();
  await waitFor(() => sent.length >= 3);
  assert.deepEqual(sent.map((f) => f.reqId), ["w", "r", "r"]);
});

// E9 §3.3: with Agent Engine memory on, pi-memory is off: its tools excluded, PI_MEMORY_DIR an
// empty directory pinned over guru.env, no exit summary. Off: none of that.
for (const memory of ["tool", "auto", "off"] as const) {
  test(`pi-memory with memory ${memory}: ${memory === "off" ? "left alone" : "excluded, empty dir, no exit summary"}`, async (t) => {
    const { dir, path } = await socketDir();
    const link = new FakeLink();
    const env: { value?: Record<string, string> } = {};
    const args: { value?: string[] } = {};
    const workspace = await mkdtemp(join(tmpdir(), "adm-ws-"));
    const memRoot = await mkdtemp(join(tmpdir(), "adm-mem-"));
    const controller = new RunController({
      link,
      gitOps: fakeGit(),
      workspace,
      piBin: "unused-in-test",
      agentdVersion: "test",
      piVersion: "test",
      heartbeatIntervalMs: 60_000,
      adminSocketPath: path,
      piMemoryTmpRoot: memRoot,
      spawnPi: (opts) => {
        env.value = opts.env;
        args.value = opts.args;
        return idlePi();
      },
      importSession: async () => join(workspace, "session.jsonl"),
      writeSnapshotFile: async () => join(workspace, "snap.jsonl"),
      onExit: () => {},
      onLog: () => {},
    });
    t.after(async () => {
      controller.dispose();
      await new Promise((r) => setTimeout(r, 50));
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(memRoot, { recursive: true, force: true });
    });
    const spec = specFor(undefined, { memory, excludeTools: ["web_search"] });
    spec.guru.env = { PI_MEMORY_DIR: "/home/agent/.pi/memory", PI_MEMORY_EXIT_SUMMARY: "1", OUTFITTER_MEMORY_RECALL: "1" };
    link.deliver(spec);
    await waitFor(() => env.value !== undefined);
    const a = args.value!;
    const exclude = a[a.indexOf("--exclude-tools") + 1].split(",");
    if (memory === "off") {
      assert.deepEqual(exclude, ["web_search"]);
      assert.equal(env.value!.PI_MEMORY_DIR, "/home/agent/.pi/memory");
      assert.equal(env.value!.OUTFITTER_MEMORY_RECALL, "", "a tape can't turn recall on");
      return;
    }
    assert.deepEqual(exclude, ["web_search", "memory_write", "memory_read", "memory_search", "memory_forget", "memory_restore", "memory_status", "scratchpad"]);
    assert.equal(env.value!.PI_MEMORY_EXIT_SUMMARY, "0");
    assert.ok(env.value!.PI_MEMORY_DIR.startsWith(join(memRoot, "pi-memory-off-")), "a tape can't point it at real memory");
    assert.deepEqual(await readdir(env.value!.PI_MEMORY_DIR), []);
    assert.equal(env.value!.OUTFITTER_MEMORY_RECALL, memory === "auto" ? "1" : "", "recall only for auto");
  });
}
