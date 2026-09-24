// Drive browser_capture (docs/specs/chrome-companion.md §13). The Chrome extension is faked:
// while agentd's loopback listener is waiting, this test uploads a jpeg through the API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CaptureListener, captureDownloadError } from "../../agentd/src/browser-capture.ts";
import outfitterBrowser from "../../agentd/pi-extension/outfitter-browser.ts";
import { buildTestApp, type TestApp } from "./helpers.ts";
import { makeRunningSession, openAgentSocket, runTokenFor, sendHello, type SocketHandle } from "./agent-socket.ts";
import { generateToken, hashToken, tokenPrefix, TOKEN_TTL_MS } from "../src/tokens.ts";
import type { Store } from "../src/store/types.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const AGENT_TOKEN = "test-agent-token";

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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function linkDrive(): Promise<{ app: TestApp; sessionId: string; runId: string; runToken: string; agent: SocketHandle }> {
  const app = await buildTestApp({ OUTFITTER_ROLE: "link" });
  const { session, runId, runToken } = await makeRunningSession(app, {
    id: "s-drive",
    repo: null,
    branch: undefined,
    ownerEmail: "owner@example.com",
  });
  const agent = await openAgentSocket(app, runId);
  sendHello(agent, runId, session.id, runToken);
  assert.equal((await agent.nextMessage()).t, "run.spec");
  agent.send({ t: "status", state: "idle" });
  await waitFor(async () => (await app.store.runs.findById(runId))?.state === "idle");
  return { app, sessionId: session.id, runId, runToken, agent };
}

function readResults(agent: SocketHandle, listener: CaptureListener): void {
  void (async () => {
    for (;;) {
      const frame = await agent.nextMessage();
      if (frame.t === "browser.capture.result") listener.deliver(frame);
    }
  })();
}

async function closeDrive(app: TestApp, agent: SocketHandle): Promise<void> {
  agent.send({ t: "bye", reason: "stop" });
  await agent.nextClose();
  app.stopBackgroundTasks();
  await app.fastify.close();
}

test("a Drive capture uploads through the API and the tool returns the jpeg path", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-drive-capture-"));
  const drive = await linkDrive();
  const { app, sessionId, runToken, agent } = drive;
  const owner = { authorization: `Bearer ${await mint(app.store, "owner@example.com")}` };
  const base = `/api/sessions/${sessionId}/browser`;
  const shared = await app.fastify.inject({
    method: "PUT",
    url: `${base}/share`,
    headers: owner,
    payload: { tabTitle: "Docs", tabUrl: "https://example.test/docs" },
  });
  assert.equal(shared.statusCode, 200);

  let requestId = "";
  let uploadError: unknown;
  const listener = new CaptureListener({
    workspace,
    waitMs: 4_000,
    download: async (captureId) => {
      const res = await app.fastify.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/browser/captures/${captureId}`,
        headers: { authorization: `Bearer ${AGENT_TOKEN}`, "x-outfitter-run-token": runToken },
      });
      if (res.statusCode === 413) throw captureDownloadError("too_large");
      if (res.statusCode !== 200) throw captureDownloadError("timeout");
      return res.rawPayload;
    },
    sendRequest: (id) => {
      requestId = id;
      agent.send({ t: "browser.capture.request", requestId: id });
      void (async () => {
        try {
          await waitFor(async () => (await app.store.browserRequests.findById(sessionId, id))?.status === "pending");
          const uploaded = await app.fastify.inject({
            method: "POST",
            url: `${base}/captures`,
            headers: owner,
            payload: {
              requestId: id,
              title: "Docs",
              url: "https://example.test/docs",
              jpegBase64: JPEG.toString("base64"),
            },
          });
          if (uploaded.statusCode !== 200) uploadError = new Error(`upload ${uploaded.statusCode} ${uploaded.body}`);
        } catch (err) {
          uploadError = err;
        }
      })();
    },
  });
  await listener.start();
  readResults(agent, listener);
  try {
    const env = { OUTFITTER_BROWSER_PORT: String(listener.port), OUTFITTER_BROWSER_TOKEN: listener.token };
    assert.equal("OUTFITTER_TOKEN" in env, false);
    let tool: { execute: (id: string, params: object) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }> } | undefined;
    outfitterBrowser({ registerTool: (registered) => { if (registered.name === "browser_capture") tool = registered as typeof tool; } }, env);
    const result = await tool!.execute("call-1", {});
    assert.equal(uploadError, undefined);
    const text = result.content[0].text ?? "";
    assert.match(text, /title: Docs/);
    assert.match(text, /url: https:\/\/example\.test\/docs/);
    const path = join(workspace, ".outfitter", "captures");
    assert.match(text, /path: /);
    const file = text.split("path: ")[1]?.trim();
    assert.ok(file);
    assert.equal(file, join(path, `${(await app.store.browserRequests.findById(sessionId, requestId))?.captureId}.jpg`));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path)).mode & 0o777, 0o700);
    assert.equal((await stat(join(workspace, ".outfitter"))).mode & 0o777, 0o700);
    const image = result.content.find((block) => block.type === "image");
    assert.equal(image?.mimeType, "image/jpeg");
    assert.equal(image?.data, JPEG.toString("base64"));
    // The api did not allocate an entry seq. agentd would emit that row; this test stops at the tool.
    assert.equal(await app.store.entries.findByEntryId(sessionId, `browser-capture:${requestId}`), null);
  } finally {
    await listener.stop();
    await closeDrive(app, agent);
  }
});

test("a revoke while the Drive is waiting yields skipped", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-drive-skip-"));
  const { app, sessionId, agent } = await linkDrive();
  const owner = { authorization: `Bearer ${await mint(app.store, "owner@example.com")}` };
  const base = `/api/sessions/${sessionId}/browser`;
  assert.equal(
    (await app.fastify.inject({
      method: "PUT",
      url: `${base}/share`,
      headers: owner,
      payload: { tabTitle: "Docs", tabUrl: "https://example.test/docs" },
    })).statusCode,
    200,
  );
  let uploadError: unknown;
  const listener = new CaptureListener({
    workspace,
    waitMs: 4_000,
    download: async () => {
      throw new Error("skipped capture must not be downloaded");
    },
    sendRequest: (id) => {
      agent.send({ t: "browser.capture.request", requestId: id });
      void (async () => {
        try {
          await waitFor(async () => (await app.store.browserRequests.findById(sessionId, id))?.status === "pending");
          const revoked = await app.fastify.inject({
            method: "POST",
            url: `${base}/requests/${id}/revoke`,
            headers: owner,
            payload: {},
          });
          if (revoked.statusCode !== 200) uploadError = new Error(`revoke ${revoked.statusCode}`);
        } catch (err) {
          uploadError = err;
        }
      })();
    },
  });
  await listener.start();
  readResults(agent, listener);
  try {
    let tool: { execute: (id: string, params: object) => Promise<{ content: Array<{ type: string; text?: string }> }> } | undefined;
    outfitterBrowser(
      { registerTool: (registered) => { if (registered.name === "browser_capture") tool = registered as typeof tool; } },
      { OUTFITTER_BROWSER_PORT: String(listener.port), OUTFITTER_BROWSER_TOKEN: listener.token },
    );
    const result = await tool!.execute("call-1", {});
    assert.equal(uploadError, undefined);
    assert.equal(result.content[0].text, "skipped");
    assert.equal(result.content.length, 1);
    await assert.rejects(readdir(join(workspace, ".outfitter", "captures")));
  } finally {
    await listener.stop();
    await closeDrive(app, agent);
  }
});

test("a reported tab_gone makes a waiting capture return tab_gone instead of hanging", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-drive-gone-"));
  const { app, sessionId, agent } = await linkDrive();
  const owner = { authorization: `Bearer ${await mint(app.store, "owner@example.com")}` };
  const base = `/api/sessions/${sessionId}/browser`;
  assert.equal(
    (await app.fastify.inject({
      method: "PUT",
      url: `${base}/share`,
      headers: owner,
      payload: { tabTitle: "Docs", tabUrl: "https://example.test/docs" },
    })).statusCode,
    200,
  );
  const results: Array<{ requestId?: string; error?: string }> = [];
  let requestId = "";
  let uploadError: unknown;
  const listener = new CaptureListener({
    workspace,
    waitMs: 4_000,
    download: async () => {
      throw new Error("tab_gone must not download a jpeg");
    },
    sendRequest: (id) => {
      requestId = id;
      agent.send({ t: "browser.capture.request", requestId: id });
      void (async () => {
        try {
          await waitFor(async () => (await app.store.browserRequests.findById(sessionId, id))?.status === "pending");
          const reported = await app.fastify.inject({
            method: "POST",
            url: `${base}/requests/${id}/fail`,
            headers: owner,
            payload: { error: "tab_gone" },
          });
          if (reported.statusCode !== 200) uploadError = new Error(`fail ${reported.statusCode} ${reported.body}`);
        } catch (err) {
          uploadError = err;
        }
      })();
    },
  });
  await listener.start();
  void (async () => {
    for (;;) {
      const frame = await agent.nextMessage();
      if (frame.t === "browser.capture.result") {
        results.push(frame);
        listener.deliver(frame);
      }
    }
  })();
  try {
    let tool: { execute: (id: string, params: object) => Promise<{ content: Array<{ type: string; text?: string }> }> } | undefined;
    outfitterBrowser(
      { registerTool: (registered) => { if (registered.name === "browser_capture") tool = registered as typeof tool; } },
      { OUTFITTER_BROWSER_PORT: String(listener.port), OUTFITTER_BROWSER_TOKEN: listener.token },
    );
    const result = await tool!.execute("call-1", {});
    assert.equal(uploadError, undefined);
    assert.equal(result.content[0].text, "tab_gone");
    assert.equal(result.content.length, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].error, "tab_gone");
    assert.equal(results[0].requestId, requestId);
    const row = await app.store.browserRequests.findById(sessionId, requestId);
    assert.equal(row?.status, "failed");
    assert.equal(row?.error, "tab_gone");
    assert.equal((await app.store.browserRequests.listPending(sessionId)).length, 0);
    assert.equal(await app.store.entries.findByEntryId(sessionId, `browser-capture:${requestId}`), null);

    const again = await app.fastify.inject({
      method: "POST",
      url: `${base}/requests/${requestId}/fail`,
      headers: owner,
      payload: { error: "permission_denied" },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().status, "failed");
    assert.equal(again.json().error, "tab_gone");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(results.length, 1);
    assert.equal((await app.store.browserRequests.listPending(sessionId)).length, 0);
    assert.equal(await app.store.entries.findByEntryId(sessionId, `browser-capture:${requestId}`), null);
  } finally {
    await listener.stop();
    await closeDrive(app, agent);
  }
});

test("no share answers no_share, and the same requestId is one row", async () => {
  const { app, sessionId, agent } = await linkDrive();
  const owner = { authorization: `Bearer ${await mint(app.store, "owner@example.com")}` };
  const workspace = await mkdtemp(join(tmpdir(), "outfitter-drive-none-"));
  const listener = new CaptureListener({
    workspace,
    waitMs: 4_000,
    download: async () => JPEG,
    sendRequest: (id) => {
      agent.send({ t: "browser.capture.request", requestId: id });
    },
  });
  await listener.start();
  readResults(agent, listener);
  try {
    let tool: { execute: (id: string, params: object) => Promise<{ content: Array<{ type: string; text?: string }> }> } | undefined;
    outfitterBrowser(
      { registerTool: (registered) => { if (registered.name === "browser_capture") tool = registered as typeof tool; } },
      { OUTFITTER_BROWSER_PORT: String(listener.port), OUTFITTER_BROWSER_TOKEN: listener.token },
    );
    const missing = await tool!.execute("call-1", {});
    assert.equal(missing.content[0].text, "no_share");

    const shared = await app.fastify.inject({
      method: "PUT",
      url: `/api/sessions/${sessionId}/browser/share`,
      headers: owner,
      payload: { tabTitle: "Docs", tabUrl: "https://example.test/docs" },
    });
    assert.equal(shared.statusCode, 200);
    agent.send({ t: "browser.capture.request", requestId: "same-id" });
    await waitFor(async () => (await app.store.browserRequests.findById(sessionId, "same-id"))?.status === "pending");
    agent.send({ t: "browser.capture.request", requestId: "same-id" });
    const until = Date.now() + 100;
    while (Date.now() < until) {
      assert.equal((await app.store.browserRequests.listPending(sessionId)).length, 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await app.store.browserRequests.findById(sessionId, "same-id"))?.requesterEmail, "owner@example.com");
  } finally {
    await listener.stop();
    await closeDrive(app, agent);
  }
});

test("the sandbox downloads a capture with the run token, not a Dongle", async () => {
  const app = await buildTestApp({ OUTFITTER_ROLE: "link" });
  const { session, runToken } = await makeRunningSession(app, {
    id: "s-dl",
    repo: null,
    branch: undefined,
    ownerEmail: "owner@example.com",
  });
  const now = new Date().toISOString();
  await app.store.sessions.insert({
    id: "s-other",
    guruId: "test-guru",
    repo: null,
    status: "open",
    cost: 0,
    createdAt: now,
    updatedAt: now,
  });
  const other = await app.runs.wake("s-other");
  const otherToken = runTokenFor(app, other.id);
  const owner = { authorization: `Bearer ${await mint(app.store, "owner@example.com")}` };
  const base = `/api/sessions/${session.id}/browser`;
  assert.equal(
    (await app.fastify.inject({
      method: "PUT",
      url: `${base}/share`,
      headers: owner,
      payload: { tabTitle: "Docs", tabUrl: "https://example.test/docs" },
    })).statusCode,
    200,
  );
  const asked = await app.fastify.inject({ method: "POST", url: `${base}/requests`, headers: owner, payload: {} });
  assert.equal(asked.statusCode, 201);
  const uploaded = await app.fastify.inject({
    method: "POST",
    url: `${base}/captures`,
    headers: owner,
    payload: { requestId: asked.json().id, title: "Docs", url: "https://example.test/docs", jpegBase64: JPEG.toString("base64") },
  });
  assert.equal(uploaded.statusCode, 200);
  const url = `${base}/captures/${uploaded.json().captureId}`;

  const anonymous = await app.fastify.inject({ method: "GET", url });
  assert.equal(anonymous.statusCode, 401);
  const wrongRun = await app.fastify.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${AGENT_TOKEN}`, "x-outfitter-run-token": otherToken },
  });
  assert.equal(wrongRun.statusCode, 401);
  const agent = await app.fastify.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${AGENT_TOKEN}`, "x-outfitter-run-token": runToken },
  });
  assert.equal(agent.statusCode, 200);
  assert.equal(agent.headers["content-type"], "image/jpeg");
  assert.deepEqual(agent.rawPayload, JPEG);
  const dongle = await app.fastify.inject({ method: "GET", url, headers: owner });
  assert.equal(dongle.statusCode, 200);

  app.stopBackgroundTasks();
  await app.fastify.close();
});
