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
    this.emit("close", 1000, Buffer.from(""));
  }

  // test helpers
  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  triggerMessage(obj: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(obj)));
  }

  /** `code`/`reason` match what real `ws` passes to a 'close' listener. */
  triggerClose(code = 1006, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
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
    runToken: "test-run-token",
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
  assert.equal(hello.runToken, "test-run-token");
  // Bug 9 (docs/reports/cloud-fixes.md): the wire protocol version, so a version-skewed link can
  // refuse the connection loudly instead of silently ignoring frames it doesn't understand.
  assert.equal(typeof hello.protocolVersion, "number");
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

// --- terminal close codes (4400/4401/4404/4409/4412) --------------------------------------------

for (const code of [4400, 4401, 4404, 4409, 4412]) {
  test(`Link: close code ${code} is terminal -- stops reconnecting and fires onTerminal`, async (t) => {
    const link = makeLink();
    t.after(() => link.close());
    const ws = await connectAndGetInstance(link);
    ws.triggerOpen();

    const seen: Array<[number, string]> = [];
    link.onTerminal((c, reason) => seen.push([c, reason]));

    ws.triggerClose(code, "run not found");
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(seen, [[code, "run not found"]]);
    assert.equal(FakeWebSocket.instances.length, 1); // no reconnect attempt
  });
}

test("Link: close code 1011 (server internal error) keeps reconnecting, not terminal", async (t) => {
  const link = makeLink();
  t.after(() => link.close());
  const ws1 = await connectAndGetInstance(link);
  ws1.triggerOpen();

  const seen: Array<[number, string]> = [];
  link.onTerminal((c, reason) => seen.push([c, reason]));

  ws1.triggerClose(1011, "internal error");
  await waitFor(() => FakeWebSocket.instances.length === 2);

  assert.deepEqual(seen, []);
});

test("Link: an unrecognized close code also keeps reconnecting", async (t) => {
  const link = makeLink();
  t.after(() => link.close());
  const ws1 = await connectAndGetInstance(link);
  ws1.triggerOpen();
  ws1.triggerClose(1005, "");
  await waitFor(() => FakeWebSocket.instances.length === 2);
});

// --- backoff only resets once a connection is stable, or acked ---------------------------------

test("Link: attempt/backoff is NOT reset just by 'open' -- a server that closes immediately keeps growing backoff up to the cap", async (t) => {
  const link = makeLink({ backoffBaseMs: 5, backoffMaxMs: 30, stableAfterMs: 10_000 });
  t.after(() => link.close());

  // Flap three times: open then immediately close, never staying open long enough to be "stable"
  // and never sending an ack/run.spec. Reconnects happen automatically via scheduleReconnect --
  // never call connect() again here, or it would open a new socket immediately and bypass backoff.
  let ws = await connectAndGetInstance(link, 1);
  ws.triggerOpen();
  ws.triggerClose(1006, "");
  await waitFor(() => FakeWebSocket.instances.length === 2);
  ws = FakeWebSocket.instances[1];
  ws.triggerOpen();
  ws.triggerClose(1006, "");
  await waitFor(() => FakeWebSocket.instances.length === 3);
  ws = FakeWebSocket.instances[2];
  ws.triggerOpen();
  const before = Date.now();
  ws.triggerClose(1006, "");
  await waitFor(() => FakeWebSocket.instances.length === 4);
  const elapsed = Date.now() - before;
  // attempt has grown to 2 by the third close (0 -> 1 -> 2), so the 4th reconnect waits
  // min(30, 5 * 2**2) = 20ms, not the base 5ms it would be if 'open' had reset attempt each time.
  assert.ok(elapsed >= 15, `expected backoff to have grown past the base delay, got ${elapsed}ms`);
});

test("Link: backoff resets once a connection stays open for stableAfterMs", async (t) => {
  const link = makeLink({ backoffBaseMs: 5, backoffMaxMs: 30, stableAfterMs: 20 });
  t.after(() => link.close());

  let ws = await connectAndGetInstance(link, 1);
  ws.triggerOpen();
  ws.triggerClose(1006, ""); // attempt -> 1, no stability reached
  await waitFor(() => FakeWebSocket.instances.length === 2);
  ws = FakeWebSocket.instances[1];
  ws.triggerOpen();
  // Stay open long enough to become "stable" this time.
  await new Promise((r) => setTimeout(r, 30));
  const before = Date.now();
  ws.triggerClose(1006, "");
  await waitFor(() => FakeWebSocket.instances.length === 3);
  const elapsed = Date.now() - before;
  // attempt was reset to 0 by the stability timer, so this reconnect uses the base delay (~5ms),
  // not a grown backoff.
  assert.ok(elapsed < 20, `expected backoff to have reset to the base delay, got ${elapsed}ms`);
});

test("Link: backoff resets immediately once an ack or run.spec arrives, without waiting for stableAfterMs", async (t) => {
  const link = makeLink({ backoffBaseMs: 5, backoffMaxMs: 30, stableAfterMs: 10_000 });
  t.after(() => link.close());

  let ws = await connectAndGetInstance(link, 1);
  ws.triggerOpen();
  ws.triggerClose(1006, ""); // attempt -> 1
  await waitFor(() => FakeWebSocket.instances.length === 2);
  ws = FakeWebSocket.instances[1];
  ws.triggerOpen();
  ws.triggerMessage({ t: "ack", seq: 0 }); // real progress -- reset attempt right away
  const before = Date.now();
  ws.triggerClose(1006, "");
  await waitFor(() => FakeWebSocket.instances.length === 3);
  const elapsed = Date.now() - before;
  assert.ok(elapsed < 20, `expected an ack to reset backoff immediately, got ${elapsed}ms`);
});

// --- maxUnspecMs: give up if run.spec never arrives ---------------------------------------------

test("Link: onUnspecTimeout fires once if run.spec never arrives within maxUnspecMs", async (t) => {
  const link = makeLink({ maxUnspecMs: 20, backoffBaseMs: 5, backoffMaxMs: 10 });
  t.after(() => link.close());

  let fired = 0;
  link.onUnspecTimeout(() => fired++);

  const ws = await connectAndGetInstance(link);
  ws.triggerOpen(); // opens fine, but never sends run.spec

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fired, 1);
});

test("Link: onUnspecTimeout does not fire once run.spec has arrived", async (t) => {
  const link = makeLink({ maxUnspecMs: 20, backoffBaseMs: 5, backoffMaxMs: 10 });
  t.after(() => link.close());

  let fired = 0;
  link.onUnspecTimeout(() => fired++);

  const ws = await connectAndGetInstance(link);
  ws.triggerOpen();
  ws.triggerMessage({
    t: "run.spec",
    session: { id: "s1", name: "n", cwd: "/workspace" },
    guru: { model: "m" },
    snapshot: {},
    secrets: {},
    idleStopSeconds: 60,
    checkpointEvery: 5,
  });

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fired, 0);
});
