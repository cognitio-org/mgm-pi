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

  constructor(url: string, _opts?: unknown) {
    super();
    this.url = url;
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

function makeLink(overrides: Partial<ConstructorParameters<typeof Link>[0]> = {}): Link {
  FakeWebSocket.instances = [];
  return new Link({
    url: "wss://api.example.test/agent/ws?run=run1",
    headers: { Authorization: "Bearer t" },
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

test("Link: sends hello with lastAckedSeq=0 on first open", () => {
  const link = makeLink();
  link.connect();
  const ws = FakeWebSocket.instances[0];
  ws.triggerOpen();
  const hello = JSON.parse(ws.sent[0]);
  assert.equal(hello.t, "hello");
  assert.equal(hello.runId, "run1");
  assert.equal(hello.lastAckedSeq, 0);
});

test("Link: sendSeq assigns monotonic seq and buffers until acked", () => {
  const link = makeLink();
  link.connect();
  const ws = FakeWebSocket.instances[0];
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

test("Link: non-seq frames (heartbeat, status) are not buffered", () => {
  const link = makeLink();
  link.connect();
  const ws = FakeWebSocket.instances[0];
  ws.triggerOpen();
  ws.sent.length = 0;

  link.send({ t: "heartbeat", idleSeconds: 5, memMb: 100 });
  assert.equal(link.getPendingCount(), 0);
  assert.equal(ws.sent.length, 1);
});

test("Link: reconnects with backoff and resends hello + unacked frames in order", async () => {
  const link = makeLink();
  link.connect();
  const ws1 = FakeWebSocket.instances[0];
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

test("Link: setSessionId changes the sessionId used in later hello frames", async () => {
  const link = makeLink({ sessionId: "" });
  link.connect();
  const ws1 = FakeWebSocket.instances[0];
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
  link.connect();
  const ws1 = FakeWebSocket.instances[0];
  ws1.triggerOpen();
  link.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("Link: sendAndFlush resolves only after the socket confirms the write", async () => {
  const link = makeLink();
  link.connect();
  const ws = FakeWebSocket.instances[0];
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
