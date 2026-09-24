// DevTools inspect. The link API stores a redacted result. It does not attach a debugger.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/types.ts";
import { generateToken, hashToken, tokenPrefix, TOKEN_TTL_MS } from "../src/tokens.ts";
import { buildTestApp, type TestApp } from "./helpers.ts";
import { makeRunningSession, openAgentSocket, sendHello } from "./agent-socket.ts";

const SECRET = "super-secret-value";

async function mint(store: Store, email: string): Promise<string> {
  const token = generateToken();
  const now = new Date().toISOString();
  await store.tokens.insert({
    id: randomUUID(),
    ownerEmail: email,
    name: email,
    prefix: tokenPrefix(token),
    hash: hashToken(token),
    createdAt: now,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
  });
  return token;
}

async function linkApp(store: Store): Promise<TestApp> {
  return buildTestApp({ OUTFITTER_ROLE: "link" }, { store });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("an inspect with an Authorization header does not keep the header value", async () => {
  const store = new MemoryStore();
  const app = await linkApp(store);
  const { session, runId, runToken } = await makeRunningSession(app, { id: "s-inspect", repo: null, branch: undefined });
  const agent = await openAgentSocket(app, runId);
  sendHello(agent, runId, session.id, runToken);
  assert.equal((await agent.nextMessage()).t, "run.spec");
  agent.send({ t: "status", state: "idle" });
  await waitFor(async () => (await store.runs.findById(runId))?.state === "idle");

  const owner = { authorization: `Bearer ${await mint(store, "owner@example.com")}` };
  const other = { authorization: `Bearer ${await mint(store, "other@example.com")}` };
  const base = `/api/sessions/${session.id}/browser`;
  const before = await store.entries.listForSession(session.id);

  const missing = await app.fastify.inject({ method: "POST", url: `${base}/inspects`, headers: owner, payload: {} });
  assert.equal(missing.statusCode, 409);

  await app.fastify.inject({
    method: "PUT",
    url: `${base}/share`,
    headers: owner,
    payload: { tabTitle: "Docs", tabUrl: "https://example.test" },
  });
  const named = await app.fastify.inject({
    method: "POST",
    url: `${base}/inspects`,
    headers: owner,
    payload: { tabId: 4 },
  });
  assert.equal(named.statusCode, 400);
  assert.equal((await store.browserRequests.listPending(session.id)).length, 0);

  const created = await app.fastify.inject({ method: "POST", url: `${base}/inspects`, headers: other, payload: {} });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().kind, "inspect");
  assert.equal(created.json().requesterEmail, "other@example.com");
  const queue = await app.fastify.inject({ method: "GET", url: `${base}/requests?status=pending`, headers: owner });
  assert.equal(queue.json()[0].kind, "inspect");
  assert.equal(JSON.stringify(queue.json()).includes("messages"), false);

  const stranger = await app.fastify.inject({
    method: "POST",
    url: `${base}/inspects/${created.json().id}/result`,
    headers: other,
    payload: { error: "denied" },
  });
  assert.equal(stranger.statusCode, 403);
  assert.equal((await store.browserRequests.findById(session.id, created.json().id))?.status, "pending");

  const denied = await app.fastify.inject({
    method: "POST",
    url: `${base}/inspects/${created.json().id}/result`,
    headers: owner,
    payload: { error: "denied" },
  });
  assert.equal(denied.statusCode, 200);
  assert.equal(denied.json().status, "failed");
  assert.equal(denied.json().error, "denied");
  const deniedFrame = await agent.nextMessage();
  assert.equal(deniedFrame.t, "browser.inspect.result");
  assert.equal(deniedFrame.error, "denied");
  assert.equal(deniedFrame.messages, undefined);

  agent.send({ t: "browser.inspect.request", requestId: "drive-inspect" });
  await waitFor(async () => (await store.browserRequests.findById(session.id, "drive-inspect"))?.status === "pending");
  const reported = await app.fastify.inject({
    method: "POST",
    url: `${base}/inspects/drive-inspect/result`,
    headers: owner,
    payload: {
      messages: [`log: Authorization: Bearer ${SECRET}`, `Cookie: session=${SECRET}`],
      element: "button#go.primary",
      headers: { Authorization: SECRET },
    },
  });
  assert.equal(reported.statusCode, 200);
  const frame = await agent.nextMessage();
  const encoded = JSON.stringify(frame);
  assert.equal(frame.t, "browser.inspect.result");
  assert.equal(frame.requestId, "drive-inspect");
  assert.equal(encoded.includes(SECRET), false);
  assert.match(frame.messages[0], /\[redacted\]/);
  assert.equal(frame.element, "button#go.primary");
  assert.equal(frame.headers, undefined);
  const stored = await store.browserRequests.findById(session.id, "drive-inspect");
  assert.equal(JSON.stringify(stored).includes(SECRET), false);
  assert.equal((await store.entries.listForSession(session.id)).length, before.length);

  const again = await app.fastify.inject({
    method: "POST",
    url: `${base}/inspects/drive-inspect/result`,
    headers: owner,
    payload: { messages: ["log: later"], element: null },
  });
  assert.equal(again.statusCode, 409);

  agent.send({ t: "bye", reason: "stop" });
  await agent.nextClose();
  app.stopBackgroundTasks();
  await app.fastify.close();
});

test("revoking a share skips an inspect without a capture result", async () => {
  const store = new MemoryStore();
  const app = await linkApp(store);
  const { session, runId, runToken } = await makeRunningSession(app, { id: "s-inspect-skip", repo: null, branch: undefined });
  const agent = await openAgentSocket(app, runId);
  sendHello(agent, runId, session.id, runToken);
  assert.equal((await agent.nextMessage()).t, "run.spec");
  agent.send({ t: "status", state: "idle" });
  await waitFor(async () => (await store.runs.findById(runId))?.state === "idle");
  const owner = { authorization: `Bearer ${await mint(store, "owner@example.com")}` };
  const base = `/api/sessions/${session.id}/browser`;
  await app.fastify.inject({
    method: "PUT",
    url: `${base}/share`,
    headers: owner,
    payload: { tabTitle: "Docs", tabUrl: "https://example.test" },
  });
  const created = await app.fastify.inject({ method: "POST", url: `${base}/inspects`, headers: owner, payload: {} });
  assert.equal(created.statusCode, 201);
  const removed = await app.fastify.inject({ method: "DELETE", url: `${base}/share`, headers: owner });
  assert.equal(removed.statusCode, 200);
  const frame = await agent.nextMessage();
  assert.equal(frame.t, "browser.inspect.result");
  assert.equal(frame.error, "skipped");
  assert.equal(frame.captureId, undefined);
  agent.send({ t: "browser.inspect.request", requestId: "drive-none" });
  const noShare = await agent.nextMessage();
  assert.equal(noShare.t, "browser.inspect.result");
  assert.equal(noShare.error, "no_share");
  agent.send({ t: "bye", reason: "stop" });
  await agent.nextClose();
  app.stopBackgroundTasks();
  await app.fastify.close();
});
