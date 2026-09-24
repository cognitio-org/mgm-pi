// Confirmed click and type. The link API stores an action row. It does not run JavaScript.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/types.ts";
import { generateToken, hashToken, tokenPrefix, TOKEN_TTL_MS } from "../src/tokens.ts";
import { buildTestApp, type TestApp } from "./helpers.ts";
import { makeRunningSession, openAgentSocket, sendHello } from "./agent-socket.ts";

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

test("POST /browser/actions is 409 without a share and rejects JavaScript", async () => {
  const store = new MemoryStore();
  const app = await linkApp(store);
  const sessionId = "s-action";
  const now = new Date().toISOString();
  await store.sessions.insert({ id: sessionId, guruId: "g", repo: null, status: "open", cost: 0, createdAt: now, updatedAt: now });
  const owner = { authorization: `Bearer ${await mint(store, "owner@example.com")}` };
  const base = `/api/sessions/${sessionId}/browser`;
  const missing = await app.fastify.inject({
    method: "POST",
    url: `${base}/actions`,
    headers: owner,
    payload: { kind: "click", selector: "#go" },
  });
  assert.equal(missing.statusCode, 409);
  assert.equal(missing.json().error, "no browser share");

  await app.fastify.inject({
    method: "PUT",
    url: `${base}/share`,
    headers: owner,
    payload: { tabTitle: "Docs", tabUrl: "https://example.test/docs" },
  });
  const script = await app.fastify.inject({
    method: "POST",
    url: `${base}/actions`,
    headers: owner,
    payload: { kind: "click", selector: "javascript:alert(1)" },
  });
  assert.equal(script.statusCode, 400);
  const extra = await app.fastify.inject({
    method: "POST",
    url: `${base}/actions`,
    headers: owner,
    payload: { kind: "click", selector: "#go", text: "no" },
  });
  assert.equal(extra.statusCode, 400);
  assert.equal((await store.browserRequests.listPending(sessionId)).length, 0);

  const other = { authorization: `Bearer ${await mint(store, "other@example.com")}` };
  const created = await app.fastify.inject({
    method: "POST",
    url: `${base}/actions`,
    headers: other,
    payload: { kind: "type", selector: " #q ", text: "hello" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().kind, "type");
  assert.equal(created.json().selector, "#q");
  assert.equal(created.json().requesterEmail, "other@example.com");
  assert.equal(created.json().status, "pending");

  const denied = await app.fastify.inject({
    method: "POST",
    url: `${base}/actions/${created.json().id}/result`,
    headers: other,
    payload: { error: "denied" },
  });
  assert.equal(denied.statusCode, 403);

  const result = await app.fastify.inject({
    method: "POST",
    url: `${base}/actions/${created.json().id}/result`,
    headers: owner,
    payload: { error: "denied" },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().status, "failed");
  assert.equal(result.json().error, "denied");
  assert.equal((await store.browserRequests.listPending(sessionId)).length, 0);
  assert.equal(await store.browserCaptures.findByRequestId(sessionId, created.json().id), null);

  const queue = await app.fastify.inject({ method: "GET", url: `${base}/requests?status=pending`, headers: owner });
  assert.deepEqual(queue.json(), []);
  await app.fastify.close();
});

test("a pending action is listed with its kind, and revoke skips it without a capture result", async () => {
  const store = new MemoryStore();
  const app = await linkApp(store);
  const { session, runId, runToken } = await makeRunningSession(app, { id: "s-act-live", repo: null, branch: undefined });
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
  const created = await app.fastify.inject({
    method: "POST",
    url: `${base}/actions`,
    headers: owner,
    payload: { kind: "click", selector: "button.go" },
  });
  assert.equal(created.statusCode, 201);
  const queue = await app.fastify.inject({ method: "GET", url: `${base}/requests?status=pending`, headers: owner });
  assert.equal(queue.json()[0].kind, "click");
  assert.equal(queue.json()[0].selector, "button.go");
  assert.equal(queue.json()[0].text, undefined);

  const revoked = await app.fastify.inject({
    method: "POST",
    url: `${base}/requests/${created.json().id}/revoke`,
    headers: owner,
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().status, "skipped");
  const frame = await agent.nextMessage();
  assert.equal(frame.t, "browser.action.result");
  assert.equal(frame.requestId, created.json().id);
  assert.equal(frame.error, "skipped");
  assert.equal(frame.captureId, undefined);

  agent.send({ t: "browser.action.request", requestId: "drive-1", kind: "click", selector: "javascript:alert(1)" });
  const rejected = await agent.nextMessage();
  assert.deepEqual(rejected, { t: "browser.action.result", requestId: "drive-1", error: "rejected" });
  assert.equal(await store.browserRequests.findById(session.id, "drive-1"), null);

  const removed = await app.fastify.inject({ method: "DELETE", url: `${base}/share`, headers: owner });
  assert.equal(removed.statusCode, 200);
  agent.send({ t: "browser.action.request", requestId: "drive-2", kind: "type", selector: "#q", text: "ok" });
  const noShare = await agent.nextMessage();
  assert.equal(noShare.t, "browser.action.result");
  assert.equal(noShare.error, "no_share");
  assert.equal(await store.browserRequests.findById(session.id, "drive-2"), null);

  agent.send({ t: "bye", reason: "stop" });
  await agent.nextClose();
  app.stopBackgroundTasks();
  await app.fastify.close();
});
