// Chrome companion link API (docs/specs/chrome-companion.md §9). Identity is the bearer token's
// owner, exercised here on OUTFITTER_ROLE=link the way the extension calls it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../src/store/memory.ts";
import type { BrowserRequest, Run, Session, Store } from "../src/store/types.ts";
import { BROWSER_CAPTURES_PER_SESSION } from "../src/store/types.ts";
import { generateToken, hashToken, tokenPrefix, TOKEN_TTL_MS } from "../src/tokens.ts";
import { BROWSER_CAPTURE_MAX_BYTES } from "../src/routes/browser.ts";
import { buildTestApp, type TestApp } from "./helpers.ts";
import { makeRunningSession, openAgentSocket, sendHello } from "./agent-socket.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

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

function sessionRow(id: string): Session {
  const now = new Date().toISOString();
  return { id, guruId: "g", repo: null, status: "open", cost: 0, createdAt: now, updatedAt: now };
}

function runRow(sessionId: string, overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    sessionId,
    state: "running",
    lastAckedSeq: 0,
    pending: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
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

function countMaxSeq(store: Store): { calls: () => number } {
  const entries = store.entries;
  const orig = entries.maxSeq.bind(entries);
  let calls = 0;
  entries.maxSeq = async (sessionId: string) => {
    calls++;
    return orig(sessionId);
  };
  return { calls: () => calls };
}

describe("browser companion on the link role", () => {
  test("registers the companion routes and the four panel routes, and not guru or operator", async () => {
    const app = await buildTestApp({ OUTFITTER_ROLE: "link" });
    const has = (method: string, url: string) => app.fastify.hasRoute({ method: method as "GET", url });
    for (const url of [
      "/api/sessions/:id/entries",
      "/api/sessions/:id/browser/share",
      "/api/sessions/:id/browser/requests",
      "/api/sessions/:id/browser/requests/:requestId",
    ]) {
      assert.equal(has("GET", url), true, `GET ${url}`);
    }
    for (const url of [
      "/api/sessions/:id/messages",
      "/api/sessions/:id/ui-response",
      "/api/sessions/:id/abort",
      "/api/sessions/:id/browser/requests",
      "/api/sessions/:id/browser/requests/:requestId/revoke",
      "/api/sessions/:id/browser/captures",
    ]) {
      assert.equal(has("POST", url), true, `POST ${url}`);
    }
    assert.equal(has("PUT", "/api/sessions/:id/browser/share"), true);
    assert.equal(has("DELETE", "/api/sessions/:id/browser/share"), true);
    assert.equal(has("GET", "/api/sessions/:id/browser/captures/:captureId"), true);

    assert.equal(has("GET", "/api/gurus"), false);
    assert.equal(has("POST", "/api/gurus"), false);
    assert.equal(has("GET", "/api/operator/settings"), false);
    assert.equal(has("POST", "/api/operator/tokens/revoke"), false);
    assert.equal(has("GET", "/api/me/tokens"), false);
    assert.equal(has("POST", "/api/sessions"), false);
    await app.fastify.close();
  });

  test("GET /api/sessions/:id reports pendingUiRequest from the active run, else null", async () => {
    const store = new MemoryStore();
    const app = await linkApp(store);
    const sessionId = "s-ui";
    await store.sessions.insert(sessionRow(sessionId));
    const token = await mint(store, "owner@example.com");
    const auth = { authorization: `Bearer ${token}` };
    const url = `/api/sessions/${sessionId}`;

    const none = await app.fastify.inject({ method: "GET", url, headers: auth });
    assert.equal(none.statusCode, 200);
    assert.equal(none.json().pendingUiRequest, null);

    const question = { type: "extension_ui_request", id: "q1", method: "confirm", title: "Ship it?" };
    await store.runs.insert(runRow(sessionId, { pendingUiRequest: question }));
    const active = await app.fastify.inject({ method: "GET", url, headers: auth });
    assert.deepEqual(active.json().pendingUiRequest, question);
    assert.equal(active.json().runState, "running");

    const stopped = runRow(sessionId, {
      state: "stopped",
      pendingUiRequest: question,
      updatedAt: "2099-01-01T00:00:00.000Z",
    });
    await store.runs.update((await store.runs.findActiveForSession(sessionId))!.id, { state: "stopped" });
    await store.runs.insert(stopped);
    const terminal = await app.fastify.inject({ method: "GET", url, headers: auth });
    // The active run is gone, so the leftover question on a stopped run is not the panel's approval.
    assert.equal(terminal.json().runState, "stopped");
    assert.equal(terminal.json().pendingUiRequest, null);
    const listed = await app.fastify.inject({ method: "GET", url: "/api/sessions", headers: auth });
    const row = (listed.json() as Array<{ id: string; runState?: string }>).find((s) => s.id === sessionId);
    assert.equal(row?.runState, terminal.json().runState);

    await app.fastify.close();
  });

  test("share, request, capture, and the §9.2 access rules", async () => {
    const store = new MemoryStore();
    const app = await linkApp(store);
    const sessionId = "s-share";
    await store.sessions.insert(sessionRow(sessionId));
    const ownerToken = await mint(store, "owner@example.com");
    const otherToken = await mint(store, "other@example.com");
    const owner = { authorization: `Bearer ${ownerToken}` };
    const other = { authorization: `Bearer ${otherToken}` };
    const base = `/api/sessions/${sessionId}/browser`;

    const noShare = await app.fastify.inject({ method: "POST", url: `${base}/requests`, headers: other, payload: {} });
    assert.equal(noShare.statusCode, 409);

    const put = await app.fastify.inject({
      method: "PUT",
      url: `${base}/share`,
      headers: owner,
      payload: { tabTitle: "Docs", tabUrl: "https://example.test/docs", ownerEmail: "evil@example.com" },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().ownerEmail, "owner@example.com");
    assert.equal(put.json().tabTitle, "Docs");
    assert.equal((await store.browserShares.findBySession(sessionId))?.ownerEmail, "owner@example.com");

    const replaced = await app.fastify.inject({
      method: "PUT",
      url: `${base}/share`,
      headers: owner,
      payload: { tabTitle: "Docs 2", tabUrl: "https://example.test/2" },
    });
    assert.equal(replaced.statusCode, 200);
    assert.equal(replaced.json().tabTitle, "Docs 2");

    const conflict = await app.fastify.inject({
      method: "PUT",
      url: `${base}/share`,
      headers: other,
      payload: { tabTitle: "Hijack", tabUrl: "https://evil.test", ownerEmail: "other@example.com" },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal((await store.browserShares.findBySession(sessionId))?.tabTitle, "Docs 2");

    const seen = await app.fastify.inject({ method: "GET", url: `${base}/share`, headers: other });
    assert.equal(seen.statusCode, 200);
    assert.deepEqual(Object.keys(seen.json()).sort(), ["createdAt", "ownerEmail", "tabTitle", "tabUrl"]);
    assert.equal(seen.json().ownerEmail, "owner@example.com");

    const asked = await app.fastify.inject({
      method: "POST",
      url: `${base}/requests`,
      headers: other,
      payload: { requesterEmail: "evil@example.com" },
    });
    assert.equal(asked.statusCode, 201);
    assert.equal(asked.json().requesterEmail, "other@example.com");
    assert.equal(asked.json().status, "pending");
    const requestId = asked.json().id as string;

    const hidden = await app.fastify.inject({ method: "GET", url: `${base}/requests?status=pending`, headers: other });
    assert.equal(hidden.statusCode, 404);
    const queue = await app.fastify.inject({ method: "GET", url: `${base}/requests?status=pending`, headers: owner });
    assert.equal(queue.statusCode, 200);
    assert.deepEqual(queue.json(), [{ id: requestId, requesterEmail: "other@example.com", status: "pending", createdAt: queue.json()[0].createdAt }]);

    const stranger = await mint(store, "stranger@example.com");
    const strangerAuth = { authorization: `Bearer ${stranger}` };
    const deniedGet = await app.fastify.inject({ method: "GET", url: `${base}/requests/${requestId}`, headers: strangerAuth });
    assert.equal(deniedGet.statusCode, 404);
    const ownerGet = await app.fastify.inject({ method: "GET", url: `${base}/requests/${requestId}`, headers: owner });
    assert.equal(ownerGet.statusCode, 200);
    assert.equal(ownerGet.json().status, "pending");

    const otherUpload = await app.fastify.inject({
      method: "POST",
      url: `${base}/captures`,
      headers: other,
      payload: { requestId, title: "nope", url: "https://example.test", jpegBase64: JPEG.toString("base64"), ownerEmail: "other@example.com" },
    });
    assert.equal(otherUpload.statusCode, 403);

    const tooBig = await app.fastify.inject({
      method: "POST",
      url: `${base}/captures`,
      headers: owner,
      payload: { requestId, title: "big", url: "https://example.test", jpegBase64: Buffer.alloc(BROWSER_CAPTURE_MAX_BYTES + 1, 7).toString("base64") },
    });
    assert.equal(tooBig.statusCode, 413);
    assert.equal((await store.browserRequests.findById(sessionId, requestId))?.status, "pending");

    const uploaded = await app.fastify.inject({
      method: "POST",
      url: `${base}/captures`,
      headers: owner,
      payload: {
        requestId,
        title: "Docs 2",
        url: "https://example.test/2",
        jpegBase64: JPEG.toString("base64"),
        requesterEmail: "evil@example.com",
        ownerEmail: "evil@example.com",
      },
    });
    assert.equal(uploaded.statusCode, 200);
    const captureId = uploaded.json().captureId as string;
    const stored = await store.browserCaptures.findById(sessionId, captureId);
    assert.equal(stored?.ownerEmail, "owner@example.com");
    assert.equal(stored?.requesterEmail, "other@example.com");
    assert.deepEqual(stored?.bytes, JPEG);

    const again = await app.fastify.inject({
      method: "POST",
      url: `${base}/captures`,
      headers: owner,
      payload: { requestId, title: "different", url: "https://other.test", jpegBase64: Buffer.from([1, 2, 3]).toString("base64") },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().captureId, captureId);
    const entries = await app.fastify.inject({ method: "GET", url: `/api/sessions/${sessionId}/entries`, headers: owner });
    const captures = (entries.json() as Array<{ customType?: string; data?: { captureId?: string; title?: string; requesterEmail?: string } }>).filter(
      (entry) => entry.customType === "outfitter.browser.capture",
    );
    assert.equal(captures.length, 1);
    assert.equal(captures[0].data?.captureId, captureId);
    assert.equal(captures[0].data?.title, "Docs 2");
    assert.equal(captures[0].data?.requesterEmail, "other@example.com");

    const image = await app.fastify.inject({ method: "GET", url: `${base}/captures/${captureId}`, headers: strangerAuth });
    assert.equal(image.statusCode, 200);
    assert.equal(image.headers["content-type"], "image/jpeg");
    assert.equal(String(image.headers["x-content-type-options"]).toLowerCase(), "nosniff");
    assert.equal(String(image.headers["content-type"]).includes("html"), false);
    assert.deepEqual(image.rawPayload, JPEG);

    const atCap = Buffer.alloc(BROWSER_CAPTURE_MAX_BYTES, 4);
    const capRequest = await app.fastify.inject({ method: "POST", url: `${base}/requests`, headers: owner, payload: {} });
    const capUpload = await app.fastify.inject({
      method: "POST",
      url: `${base}/captures`,
      headers: owner,
      payload: { requestId: capRequest.json().id, title: "cap", url: "https://example.test/cap", jpegBase64: atCap.toString("base64") },
    });
    assert.equal(capUpload.statusCode, 200);

    await app.fastify.close();
  });

  test("revoke skips a pending request, and deleting the share skips the rest", async () => {
    const store = new MemoryStore();
    const app = await linkApp(store);
    const sessionId = "s-revoke";
    await store.sessions.insert(sessionRow(sessionId));
    const ownerToken = await mint(store, "owner@example.com");
    const otherToken = await mint(store, "other@example.com");
    const owner = { authorization: `Bearer ${ownerToken}` };
    const other = { authorization: `Bearer ${otherToken}` };
    const base = `/api/sessions/${sessionId}/browser`;
    await app.fastify.inject({
      method: "PUT",
      url: `${base}/share`,
      headers: owner,
      payload: { tabTitle: "t", tabUrl: "https://example.test" },
    });
    const first = await app.fastify.inject({ method: "POST", url: `${base}/requests`, headers: other, payload: {} });
    const second = await app.fastify.inject({ method: "POST", url: `${base}/requests`, headers: other, payload: {} });
    const requestId = first.json().id as string;

    const otherRevoke = await app.fastify.inject({
      method: "POST",
      url: `${base}/requests/${requestId}/revoke`,
      headers: other,
      payload: {},
    });
    assert.equal(otherRevoke.statusCode, 403);

    const revoked = await app.fastify.inject({
      method: "POST",
      url: `${base}/requests/${requestId}/revoke`,
      headers: owner,
      payload: { requesterEmail: "evil@example.com" },
    });
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.json().status, "skipped");
    const upload = await app.fastify.inject({
      method: "POST",
      url: `${base}/captures`,
      headers: owner,
      payload: { requestId, title: "late", url: "https://example.test", jpegBase64: JPEG.toString("base64") },
    });
    assert.equal(upload.statusCode, 409);

    const again = await app.fastify.inject({ method: "POST", url: `${base}/requests/${requestId}/revoke`, headers: owner, payload: {} });
    assert.equal(again.json().status, "skipped");

    await app.fastify.inject({ method: "DELETE", url: `${base}/share`, headers: other });
    assert.ok(await store.browserShares.findBySession(sessionId));
    const removed = await app.fastify.inject({ method: "DELETE", url: `${base}/share`, headers: owner });
    assert.equal(removed.statusCode, 200);
    assert.equal(await store.browserShares.findBySession(sessionId), null);
    assert.equal((await store.browserRequests.findById(sessionId, second.json().id))?.status, "skipped");
    const after = await app.fastify.inject({ method: "POST", url: `${base}/requests`, headers: other, payload: {} });
    assert.equal(after.statusCode, 409);

    await app.fastify.close();
  });

  test("a session keeps the newest captures and drops older ones in the same insert", async () => {
    const store = new MemoryStore();
    const app = await linkApp(store);
    const sessionId = "s-trim";
    await store.sessions.insert(sessionRow(sessionId));
    const owner = { authorization: `Bearer ${await mint(store, "owner@example.com")}` };
    const base = `/api/sessions/${sessionId}/browser`;
    await app.fastify.inject({
      method: "PUT",
      url: `${base}/share`,
      headers: owner,
      payload: { tabTitle: "t", tabUrl: "https://example.test" },
    });
    const ids: string[] = [];
    for (let i = 0; i < BROWSER_CAPTURES_PER_SESSION + 1; i++) {
      // createdAt is an ISO string; a same-millisecond tie would make "older" arbitrary.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const asked = await app.fastify.inject({ method: "POST", url: `${base}/requests`, headers: owner, payload: {} });
      const uploaded = await app.fastify.inject({
        method: "POST",
        url: `${base}/captures`,
        headers: owner,
        payload: { requestId: asked.json().id, title: `t${i}`, url: "https://example.test", jpegBase64: JPEG.toString("base64") },
      });
      assert.equal(uploaded.statusCode, 200);
      ids.push(uploaded.json().captureId as string);
    }
    const oldest = await app.fastify.inject({ method: "GET", url: `${base}/captures/${ids[0]}`, headers: owner });
    assert.equal(oldest.statusCode, 404);
    const kept = await app.fastify.inject({ method: "GET", url: `${base}/captures/${ids[1]}`, headers: owner });
    assert.equal(kept.statusCode, 200);
    const newest = await app.fastify.inject({ method: "GET", url: `${base}/captures/${ids[ids.length - 1]}`, headers: owner });
    assert.equal(newest.statusCode, 200);
    const entries = await app.fastify.inject({ method: "GET", url: `/api/sessions/${sessionId}/entries`, headers: owner });
    const captureEntries = (entries.json() as Array<{ customType?: string }>).filter((entry) => entry.customType === "outfitter.browser.capture");
    assert.equal(captureEntries.length, BROWSER_CAPTURES_PER_SESSION + 1);

    await app.fastify.close();
  });

  test("the panel routes on the link role are the existing handlers", async () => {
    const store = new MemoryStore();
    const app = await linkApp(store);
    const sessionId = "s-panel";
    await store.sessions.insert(sessionRow(sessionId));
    const auth = { authorization: `Bearer ${await mint(store, "owner@example.com")}` };

    const entries = await app.fastify.inject({ method: "GET", url: `/api/sessions/${sessionId}/entries`, headers: auth });
    assert.equal(entries.statusCode, 200);
    assert.deepEqual(entries.json(), []);

    const messages = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      headers: auth,
      payload: {},
    });
    assert.equal(messages.statusCode, 400);
    assert.equal(messages.json().error, "text is required");

    const abort = await app.fastify.inject({ method: "POST", url: `/api/sessions/${sessionId}/abort`, headers: auth, payload: {} });
    assert.equal(abort.statusCode, 404);
    assert.equal(abort.json().error, "no active run");

    const ui = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/ui-response`,
      headers: auth,
      payload: { id: "q1", value: true },
    });
    assert.equal(ui.statusCode, 404);
    assert.equal(ui.json().error, "no active run");

    await app.fastify.close();
  });

  test("insertPendingIfShared after deleteIfOwner returns no_share and leaves no pending row", async () => {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    const sessionId = "s-atomic";
    await store.browserShares.put({
      sessionId,
      tabTitle: "t",
      tabUrl: "https://example.test",
      ownerEmail: "owner@example.com",
      createdAt: now,
    });
    const request: BrowserRequest = {
      id: "r1",
      sessionId,
      requesterEmail: "other@example.com",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await store.browserRequests.insertPendingIfShared(sessionId, request);
    assert.notEqual(inserted, "no_share");
    assert.equal((await store.browserRequests.listPending(sessionId)).length, 1);

    assert.equal(await store.browserShares.deleteIfOwner(sessionId, "owner@example.com", now), "deleted");
    assert.equal((await store.browserRequests.findById(sessionId, "r1"))?.status, "skipped");
    assert.equal((await store.browserRequests.listPending(sessionId)).length, 0);

    const after = await store.browserRequests.insertPendingIfShared(sessionId, { ...request, id: "r2" });
    assert.equal(after, "no_share");
    assert.equal(await store.browserRequests.findById(sessionId, "r2"), null);
    assert.equal((await store.browserRequests.listPending(sessionId)).length, 0);
  });

  test("a revoke and an insert cannot leave a pending request for a session with no share", async () => {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    const sessionId = "s-race";
    await store.browserShares.put({
      sessionId,
      tabTitle: "t",
      tabUrl: "https://example.test",
      ownerEmail: "owner@example.com",
      createdAt: now,
    });
    const request: BrowserRequest = {
      id: "r-race",
      sessionId,
      requesterEmail: "other@example.com",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([
      store.browserRequests.insertPendingIfShared(sessionId, request),
      store.browserShares.deleteIfOwner(sessionId, "owner@example.com", now),
    ]);
    assert.equal(await store.browserShares.findBySession(sessionId), null);
    assert.equal((await store.browserRequests.listPending(sessionId)).length, 0);
  });

  test("POST /browser/requests is 409 when the share is already gone", async () => {
    const store = new MemoryStore();
    const app = await linkApp(store);
    const sessionId = "s-gone";
    await store.sessions.insert(sessionRow(sessionId));
    const owner = { authorization: `Bearer ${await mint(store, "owner@example.com")}` };
    const base = `/api/sessions/${sessionId}/browser`;
    await app.fastify.inject({
      method: "PUT",
      url: `${base}/share`,
      headers: owner,
      payload: { tabTitle: "t", tabUrl: "https://example.test" },
    });
    const removed = await app.fastify.inject({ method: "DELETE", url: `${base}/share`, headers: owner });
    assert.equal(removed.statusCode, 200);
    const asked = await app.fastify.inject({ method: "POST", url: `${base}/requests`, headers: owner, payload: {} });
    assert.equal(asked.statusCode, 409);
    assert.equal(asked.json().error, "no browser share");
    assert.equal((await store.browserRequests.listPending(sessionId)).length, 0);
    await app.fastify.close();
  });
});

async function shareAndAsk(app: TestApp, store: Store, sessionId: string): Promise<{ owner: { authorization: string }; requestId: string; base: string }> {
  const owner = { authorization: `Bearer ${await mint(store, "owner@example.com")}` };
  const base = `/api/sessions/${sessionId}/browser`;
  const put = await app.fastify.inject({
    method: "PUT",
    url: `${base}/share`,
    headers: owner,
    payload: { tabTitle: "Docs", tabUrl: "https://example.test/docs" },
  });
  assert.equal(put.statusCode, 200);
  const asked = await app.fastify.inject({ method: "POST", url: `${base}/requests`, headers: owner, payload: {} });
  assert.equal(asked.statusCode, 201);
  return { owner, requestId: asked.json().id as string, base };
}

function capturePayload(requestId: string) {
  return { requestId, title: "Docs", url: "https://example.test/docs", jpegBase64: JPEG.toString("base64") };
}

describe("capture entry seq while a run is live", () => {
  test("a capture upload while the run socket is ready uses the seq the agent emits, not maxSeq", async () => {
    const store = new MemoryStore();
    const app = await linkApp(store);
    const { session, runId, runToken } = await makeRunningSession(app, { id: "s-live", repo: null, branch: undefined });
    await store.entries.insertIfNew(session.id, 4, { id: "prior", type: "message", parentId: null });
    const maxSeq = countMaxSeq(store);

    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    assert.equal((await agent.nextMessage()).t, "run.spec");
    agent.send({ t: "status", state: "idle" });
    await waitFor(async () => (await store.runs.findById(runId))?.state === "idle");

    const { owner, requestId, base } = await shareAndAsk(app, store, session.id);
    const before = maxSeq.calls();
    const uploaded = await app.fastify.inject({
      method: "POST",
      url: `${base}/captures`,
      headers: owner,
      payload: capturePayload(requestId),
    });
    assert.equal(uploaded.statusCode, 200);
    assert.equal(maxSeq.calls(), before, "a live run must not allocate the entry seq with maxSeq");
    assert.equal(await store.entries.findByEntryId(session.id, `browser-capture:${requestId}`), null);
    assert.notEqual((await store.sessions.findById(session.id))?.leafId, `browser-capture:${requestId}`);

    const frame = await agent.nextMessage();
    assert.equal(frame.t, "browser.capture.entry");
    assert.equal(frame.entry.id, `browser-capture:${requestId}`);
    assert.equal(frame.entry.customType, "outfitter.browser.capture");
    assert.equal(frame.entry.data.captureId, uploaded.json().captureId);
    assert.equal(frame.entry.data.requesterEmail, "owner@example.com");

    const agentSeq = 7;
    agent.send({ t: "entry", seq: agentSeq, entry: frame.entry });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: agentSeq });

    const stored = await store.entries.findByEntryId(session.id, `browser-capture:${requestId}`);
    assert.equal(stored?.seq, agentSeq);
    assert.equal((await store.sessions.findById(session.id))?.leafId, `browser-capture:${requestId}`);

    const again = await app.fastify.inject({
      method: "POST",
      url: `${base}/captures`,
      headers: owner,
      payload: capturePayload(requestId),
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().captureId, uploaded.json().captureId);
    assert.equal(agent.messageCount(), 0, "a second upload must not send another capture down-frame");
    assert.equal(maxSeq.calls(), before);
    const captures = (await store.entries.listForSession(session.id)).filter(
      (row) => row.entry.customType === "outfitter.browser.capture",
    );
    assert.equal(captures.length, 1);
    assert.equal(captures[0].seq, agentSeq);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("a capture while the run is provisioning is queued for agentd and does not call maxSeq", async () => {
    const store = new MemoryStore();
    const app = await linkApp(store);
    const { session, runId, runToken } = await makeRunningSession(app, { id: "s-prov", repo: null, branch: undefined });
    const maxSeq = countMaxSeq(store);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    assert.equal((await agent.nextMessage()).t, "run.spec");
    assert.equal((await store.runs.findById(runId))?.state, "provisioning");

    const { owner, requestId, base } = await shareAndAsk(app, store, session.id);
    const uploaded = await app.fastify.inject({
      method: "POST",
      url: `${base}/captures`,
      headers: owner,
      payload: capturePayload(requestId),
    });
    assert.equal(uploaded.statusCode, 200);
    assert.equal(maxSeq.calls(), 0);
    assert.equal(agent.messageCount(), 0, "the frame stays queued until the run is ready");
    assert.equal(await store.entries.findByEntryId(session.id, `browser-capture:${requestId}`), null);
    const pending = (await store.runs.findById(runId))?.pending ?? [];
    assert.equal(pending.length, 1);
    assert.equal(pending[0].t, "browser.capture.entry");

    agent.send({ t: "status", state: "idle" });
    const frame = await agent.nextMessage();
    assert.equal(frame.t, "browser.capture.entry");
    assert.equal(frame.entry.id, `browser-capture:${requestId}`);
    agent.send({ t: "entry", seq: 3, entry: frame.entry });
    assert.deepEqual(await agent.nextMessage(), { t: "ack", seq: 3 });
    assert.equal((await store.entries.findByEntryId(session.id, `browser-capture:${requestId}`))?.seq, 3);
    assert.equal(maxSeq.calls(), 0);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});
