// Fake-agentd plumbing shared by the agentlink and mail tests: an injectWS socket with a message
// queue, and a session whose run has been woken (with the plaintext run token recovered).

import { buildTestApp, seedGuru } from "./helpers.ts";
import type { Session } from "../src/store/types.ts";

// injectWS's connect promise can resolve *after* the server has already written its first frame
// (run.spec is sent proactively, not in reply to a client message), so a `message` listener
// attached only once the promise resolves can miss it. `onInit` fires before the mock connection
// even starts, so listeners registered there never race the server.
export function makeQueue<T>() {
  const items: T[] = [];
  const waiters: Array<(v: T) => void> = [];
  return {
    push(v: T) {
      const waiter = waiters.shift();
      if (waiter) waiter(v);
      else items.push(v);
    },
    next(): Promise<T> {
      const item = items.shift();
      if (item !== undefined) return Promise.resolve(item);
      return new Promise((resolve) => waiters.push(resolve));
    },
    count(): number {
      return items.length;
    },
  };
}

export interface SocketHandle {
  send: (frame: unknown) => void;
  nextMessage: () => Promise<any>;
  // Resolves once the socket has closed (either side initiated) *and* force-terminates it
  // afterwards. `ws` keeps a ~30s ref'd close timer alive until the underlying socket fully ends,
  // which the injectWS test transport doesn't always signal promptly; terminate() clears it so
  // node:test's process can exit immediately instead of waiting out that timer.
  nextClose: () => Promise<{ code: number; reason: string }>;
  // Number of messages already received and not yet consumed via nextMessage() -- used to assert
  // "no run.spec was ever sent" without racing a nextMessage() call that would hang forever.
  messageCount: () => number;
}

export async function openAgentSocket(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  runId: string,
  token = "test-agent-token",
): Promise<SocketHandle> {
  const messages = makeQueue<any>();
  const closes = makeQueue<{ code: number; reason: string }>();
  const ws = await app.fastify.injectWS(
    `/agent/ws?run=${runId}`,
    { headers: { authorization: `Bearer ${token}` } } as any,
    {
      onInit(socket: any) {
        socket.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));
        socket.on("close", (code: number, reason: Buffer) => closes.push({ code, reason: reason?.toString() ?? "" }));
      },
    } as any,
  );
  return {
    send: (frame: unknown) => ws.send(JSON.stringify(frame)),
    nextMessage: messages.next,
    nextClose: async () => {
      const close = await closes.next();
      ws.terminate();
      return close;
    },
    messageCount: messages.count,
  };
}

/** RunManager.wake (src/runs.ts) generates a fresh runToken per run and only ever stores its hash
 * (finding #2, docs/reports/security-review-pr1.md) -- tests recover the plaintext the same way
 * agentd would receive it, from what wake() actually handed the provider. */
export function runTokenFor(app: Awaited<ReturnType<typeof buildTestApp>>, runId: string): string {
  const call = [...app.provider.startCalls].reverse().find((c) => c.runId === runId);
  if (!call) throw new Error(`no provider.start call recorded for run ${runId}`);
  return call.runToken;
}

export async function makeRunningSession(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  overrides: Partial<Session> = {},
): Promise<{ session: Session; runId: string; runToken: string }> {
  await seedGuru(app.store);
  const now = new Date().toISOString();
  const session: Session = {
    id: "s1",
    guruId: "test-guru",
    repo: "o/r",
    branch: "main",
    status: "open",
    cost: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await app.store.sessions.insert(session);
  const run = await app.runs.wake(session.id);
  return { session, runId: run.id, runToken: runTokenFor(app, run.id) };
}

/** Bug 9 (docs/reports/cloud-fixes.md): must match agentlink.ts's own API_PROTOCOL_VERSION. Tests
 * that want to exercise version-skew refusal pass an explicit (older) protocolVersion to sendHello
 * instead of relying on this default. */
export const CURRENT_TEST_PROTOCOL_VERSION = 1;

/** Sends the `hello` handshake every connection needs now (finding #2): the api waits for it,
 * checked against the run's token, before sending `run.spec` or handling anything else. */
export function sendHello(
  agent: SocketHandle,
  runId: string,
  sessionId: string,
  runToken: string,
  lastAckedSeq = 0,
  protocolVersion: number = CURRENT_TEST_PROTOCOL_VERSION,
): void {
  agent.send({ t: "hello", runId, sessionId, lastAckedSeq, runToken, protocolVersion });
}
