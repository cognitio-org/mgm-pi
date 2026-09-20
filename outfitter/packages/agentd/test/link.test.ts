import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Link } from "../src/link.js";
import type { DownMessage } from "../src/protocol.js";

/** Minimal stand-in for the `ws` module's WebSocket, matching only what link.ts touches:
 * constructor(url, opts), on(event, cb), send(data), close(), readyState, static OPEN. */
class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  url: string;
  opts: { headers?: Record<string, string> };

  constructor(url: string, opts?: { headers?: Record<string, string> }) {
    super();
    this.url = url;
    this.opts = opts ?? {};
    FakeWebSocket.instances.push(this);
  }

  send(data: string, callback?: (err?: Error) => void): void {
    this.sent.push(data);
    if (callback) setTimeout(() => callback(), 5); // real ws flushes asynchronously
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  // test helpers
  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  triggerMessage(obj: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(obj)));
  }

  triggerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** connect() and wait for the Nth (1-based) FakeWebSocket instance to be constructed -- open() is
 * async now (it awaits the headers provider before constructing the socket), so instances are no
 * longer available synchronously right after connect(). */
async function connectAndGetInstance(link: Link, n = 1): Promise<FakeWebSocket> {
  link.connect();
  await waitFor(() => FakeWebSocket.instances.length >= n);
  return FakeWebSocket.instances[n - 1];
}

function makeLink(overrides: Partial<ConstructorParameters<typeof Link>[0]> = {}): Link {
  FakeWebSocket.instances = [];
  return new Link({
    url: "wss://api.example.test/agent/ws?run=run1",
    headers: async () => ({ Authorization: "Bearer t" }),
    runId: "run1",
    sessionId: "sess1",
    agentdVersion: "0.1.0",
    piVersion: "0.85.1",
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    WebSocketImpl: FakeWebSocket as any,
    ...overrides,
  });
}

test("Link: sends hello with lastAckedSeq=0 on first open", async (t) => {
  const link = makeLink();
  t.after(() => link.close());
  const ws = await connectAndGetInstance(link);
  ws.triggerOpen();
  const hello = JSON.parse(ws.sent[0]);
  assert.equal(hello.t, "hello");
  assert.equal(hello.runId, "run1");
  assert.equal(hello.lastAckedSeq, 0);
});

test("Link: sendSeq assigns monotonic seq and buffers until acked", async (t) => {
  const link = makeLink();
  t.after(() => link.close());
  const ws = await connectAndGetInstance(link);
  ws.triggerOpen();
  ws.sent.length = 0; // drop the hello frame from the log

  const s1 = link.sendSeq((seq) => ({ t: "entry", seq, entry: { type: "message", id: "a" } as any }));
  const s2 = link.sendSeq((seq) => ({ t: "event", seq, event: { type: "agent_start" } as any }));
  assert.equal(s1, 1);
  assert.equal(s2, 2);
  assert.equal(link.getPendingCount(), 2);
  assert.equal(ws.sent.length, 2);

  const received: DownMessage[] = [];
  link.onMessage((m) => received.push(m));
  ws.triggerMessage({ t: "ack", seq: 1 });
  assert.equal(link.getPendingCount(), 1);
  assert.equal(link.getLastAckedSeq(), 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].t, "ack");
});

test("Link: non-seq frames (heartbeat, status) are not buffered", async (t) => {
  const link = makeLink();
  t.after(() => link.close());
  const ws = await connectAndGetInstance(link);
  ws.triggerOpen();
  ws.sent.length = 0;

  link.send({ t: "heartbeat", idleSeconds: 5, memMb: 100 });
  assert.equal(link.getPendingCount(), 0);
  assert.equal(ws.sent.length, 1);
});

test("Link: reconnects with backoff and resends hello + unacked frames in order", async (t) => {
  const link = makeLink();
  t.after(() => link.close());
  const ws1 = await connectAndGetInstance(link);
  ws1.triggerOpen();
  ws1.sent.length = 0;

  link.sendSeq((seq) => ({ t: "entry", seq, entry: { type: "message", id: "a" } as any }));
  ws1.triggerMessage({ t: "ack", seq: 1 }); // seq 1 acked
  link.sendSeq((seq) => ({ t: "entry", seq, entry: { type: "message", id: "b" } as any })); // seq 2, unacked

  ws1.triggerClose();
  await waitFor(() => FakeWebSocket.instances.length === 2);
  const ws2 = FakeWebSocket.instances[1];
  ws2.triggerOpen();

  assert.equal(ws2.sent.length, 2); // hello + resent seq 2
  const hello = JSON.parse(ws2.sent[0]);
  assert.equal(hello.t, "hello");
  assert.equal(hello.lastAckedSeq, 1);
  const resent = JSON.parse(ws2.sent[1]);
  assert.equal(resent.t, "entry");
  assert.equal(resent.seq, 2);
});

test("Link: setSessionId changes the sessionId used in later hello frames", async (t) => {
  const link = makeLink({ sessionId: "" });
  t.after(() => link.close());
  const ws1 = await connectAndGetInstance(link);
  ws1.triggerOpen();
  let hello = JSON.parse(ws1.sent[0]);
  assert.equal(hello.sessionId, "");

  link.setSessionId("learned-session-id");
  ws1.triggerClose();
  await waitFor(() => FakeWebSocket.instances.length === 2);
  const ws2 = FakeWebSocket.instances[1];
  ws2.triggerOpen();
  hello = JSON.parse(ws2.sent[0]);
  assert.equal(hello.sessionId, "learned-session-id");
});

test("Link: close() stops reconnecting", async () => {
  const link = makeLink();
  const ws1 = await connectAndGetInstance(link);
  ws1.triggerOpen();
  link.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("Link: sendAndFlush resolves only after the socket confirms the write", async (t) => {
  const link = makeLink();
  t.after(() => link.close());
  const ws = await connectAndGetInstance(link);
  ws.triggerOpen();
  ws.sent.length = 0;

  let resolved = false;
  const p = link.sendAndFlush({ t: "bye", reason: "stop" }).then(() => {
    resolved = true;
  });
  // FakeWebSocket.send's callback fires on a 5ms timer -- sendAndFlush must not resolve before that.
  assert.equal(resolved, false);
  await p;
  assert.equal(resolved, true);
  assert.equal(JSON.parse(ws.sent[0]).t, "bye");
});

test("Link: sendAndFlush resolves immediately when not connected (nothing to flush)", async () => {
  const link = makeLink();
  // never call connect()/triggerOpen() -- no socket
  await link.sendAndFlush({ t: "bye", reason: "stop" }); // must not hang
});

test("Link: the headers provider is invoked fresh on every (re)connect, not cached from the first connect", async (t) => {
  let calls = 0;
  const link = makeLink({
    headers: async () => {
      calls++;
      return { Authorization: `Bearer token-${calls}` };
    },
  });
  t.after(() => link.close());

  const ws1 = await connectAndGetInstance(link);
  assert.equal(calls, 1);
  assert.equal(ws1.opts.headers?.Authorization, "Bearer token-1");
  ws1.triggerOpen();

  ws1.triggerClose(); // simulate a drop -- Link should reconnect and re-fetch headers
  await waitFor(() => FakeWebSocket.instances.length === 2);
  const ws2 = FakeWebSocket.instances[1];
  assert.equal(calls, 2);
  assert.equal(ws2.opts.headers?.Authorization, "Bearer token-2");
});

test("Link: a headers-provider failure is treated like a failed connection attempt and retried with backoff", async (t) => {
  let calls = 0;
  const link = makeLink({
    headers: async () => {
      calls++;
      if (calls === 1) throw new Error("metadata server unreachable");
      return { Authorization: "Bearer token-2" };
    },
  });
  t.after(() => link.close());

  link.connect();
  // The eventual (successful, retried) connection is the observable outcome; the retry happens
  // fast enough (backoffBaseMs=5ms) that asserting "no socket yet" in between is inherently racy.
  await waitFor(() => FakeWebSocket.instances.length === 1, 2000);
  assert.equal(calls, 2);
  assert.equal(FakeWebSocket.instances[0].opts.headers?.Authorization, "Bearer token-2");
});

test("Link: proactively reconnects once a connection reaches maxConnectionAgeMs (Cloud Run's 60 min cap)", async (t) => {
  const link = makeLink({ maxConnectionAgeMs: 15 });
  t.after(() => link.close());
  const ws1 = await connectAndGetInstance(link);
  ws1.triggerOpen(); // arms the connection-age timer

  // Without any external close/error, the connection should be proactively rotated.
  await waitFor(() => FakeWebSocket.instances.length === 2, 2000);
  assert.equal(ws1.readyState, FakeWebSocket.CLOSED);
  const ws2 = FakeWebSocket.instances[1];
  ws2.triggerOpen();
  assert.equal(JSON.parse(ws2.sent[0]).t, "hello");
});

test("Link: the connection-age timer does not fire again after close() (no leaked reconnect)", async (t) => {
  const link = makeLink({ maxConnectionAgeMs: 15 });
  t.after(() => link.close());
  const ws1 = await connectAndGetInstance(link);
  ws1.triggerOpen();
  link.close();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(FakeWebSocket.instances.length, 1);
});
