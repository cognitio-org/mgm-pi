// E9 PR6 (docs/specs/atlas-agent-engine-and-a2a.md §5.3): A2A streaming (SendStreamingMessage and
// SubscribeToTask polling the a2aTasks row), INPUT_REQUIRED and its answer path, owner-only
// confirms and approvals, checkpoint-gated completion with the result artifact, and the stream
// limits.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { buildTestApp, seedGuru, type TestApp } from "./helpers.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { A2AKeyScope, A2ATask, ApiToken, Store } from "../src/store/types.ts";
import { generateToken, hashToken, tokenPrefix, TOKEN_TTL_MS } from "../src/tokens.ts";
import { OUTFITTER_TASK_EXTENSION } from "../src/a2a/card.ts";
import { GithubBroker, type GithubResponse } from "../src/github-broker.ts";
import { MemorySecretsBroker } from "../src/secrets.ts";

const OWNER = "owner@mgms.eu";
const LINK = "https://link.example";
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface Setup {
  store: Store;
  app: TestApp;
  token: string;
  record: ApiToken;
}

async function setup(env: Record<string, string> = {}, opts: { store?: Store; github?: GithubBroker; scope?: Partial<A2AKeyScope> } = {}): Promise<Setup> {
  const store = opts.store ?? new MemoryStore();
  if (!(await store.gurus.findById("coder"))) await seedGuru(store, { id: "coder", name: "Coder" });
  const token = generateToken();
  const now = Date.now();
  const record: ApiToken = {
    id: randomUUID(),
    ownerEmail: OWNER,
    name: "agent-engine",
    prefix: tokenPrefix(token),
    hash: hashToken(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
    kind: "a2a",
    a2a: { tapes: ["coder"], repos: ["acme/widgets"], maxConcurrent: 5, ...opts.scope },
  };
  await store.tokens.insert(record);
  const app = await buildTestApp(
    { OUTFITTER_ROLE: "link", OUTFITTER_ORIGIN: LINK, A2A_BLOCKING_CAP_MS: "300", A2A_STREAM_POLL_MS: "20", ...env },
    { store, ...(opts.github ? { github: opts.github } : {}) },
  );
  app.fastify.log.level = "warn";
  return { store, app, token, record };
}

function rpcRequest(method: string, params: unknown, token: string) {
  return {
    method: "POST" as const,
    url: "/a2a",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "a2a-version": "1.0" },
    payload: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  };
}

async function rpc(app: TestApp, token: string, method: string, params: unknown) {
  return app.fastify.inject(rpcRequest(method, params, token));
}

function message(text: string, extra: Record<string, unknown> = {}) {
  return { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text }], ...extra };
}

function withRepo(msg: Record<string, unknown>) {
  return { ...msg, metadata: { [OUTFITTER_TASK_EXTENSION]: { repo: "acme/widgets" } }, extensions: [OUTFITTER_TASK_EXTENSION] };
}

async function start(s: Setup, msg: Record<string, unknown>): Promise<{ id: string; contextId: string }> {
  const res = await rpc(s.app, s.token, "SendMessage", { message: msg, configuration: { returnImmediately: true } });
  return res.json().result.task;
}

async function getTask(s: Setup, id: string) {
  return (await rpc(s.app, s.token, "GetTask", { id, historyLength: 0 })).json().result;
}

/** The SSE body's JSON-RPC events, in order. */
function events(body: string): Array<{ id: unknown; result?: Record<string, any>; error?: { code: number } }> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

/** Each event's kind, with the state for tasks and status updates. */
function shape(body: string): string[] {
  return events(body).map((e) => {
    const r = e.result ?? {};
    if (r.task) return `task:${r.task.status.state}`;
    if (r.statusUpdate) return `status:${r.statusUpdate.status.state}`;
    if (r.artifactUpdate) return "artifact";
    if (r.message) return "message";
    return `error:${e.error?.code}`;
  });
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function row(s: Setup, id?: string): Promise<A2ATask> {
  return waitFor(async () => {
    if (id) return s.store.a2aTasks.findForToken(s.record.id, id);
    const { tasks } = await s.store.a2aTasks.list(s.record.id, { limit: 1 });
    return tasks[0]?.sessionId && tasks[0]?.waiterId ? tasks[0] : undefined;
  });
}

/** agentd's part: the run is up, pi took the task's mail, and called a tool. Returns the run id. */
async function accept(s: Setup, task: A2ATask, tool = "bash"): Promise<string> {
  const run = (await s.store.runs.findActiveForSession(task.sessionId!))!;
  await s.store.runs.update(run.id, { state: "running" });
  const seq = (await s.store.entries.maxSeq(task.sessionId!)) + 1;
  await s.app.turns.noteMailAccepted(task.sessionId!, run.id, task.mailId!, seq);
  await s.store.entries.insertIfNew(
    task.sessionId!,
    seq + 1,
    { id: `e-${randomUUID()}`, parentId: null, type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: tool }] } },
    { runId: run.id },
  );
  return run.id;
}

/** pi's final reply, then the settle. */
async function settle(s: Setup, task: A2ATask, runId: string, reply: string): Promise<void> {
  const seq = (await s.store.entries.maxSeq(task.sessionId!)) + 1;
  const entryId = `e-${randomUUID()}`;
  await s.store.entries.insertIfNew(
    task.sessionId!,
    seq,
    { id: entryId, parentId: null, type: "message", message: { role: "assistant", content: [{ type: "text", text: reply }] } },
    { runId },
  );
  await s.app.turns.noteSettled(task.sessionId!, runId, seq + 1, entryId);
}

/** A checkpoint frame as agentlink stores it. */
async function checkpoint(s: Setup, sessionId: string, landed: boolean, head = SHA): Promise<void> {
  const session = (await s.store.sessions.findById(sessionId))!;
  await s.store.sessions.update(sessionId, { checkpoint: { branch: session.branch, head, at: new Date().toISOString(), landed } });
}

function fakePulls(calls: Array<{ route: string; params: Record<string, unknown> }>, reply: (params: Record<string, unknown>) => GithubResponse): GithubBroker {
  return new GithubBroker(new MemoryStore(), new MemorySecretsBroker("ghs_test"), () => ({
    async request(route, params) {
      calls.push({ route, params });
      return reply(params);
    },
  }));
}

describe("A2A streaming (§5.3)", () => {
  test("SendStreamingMessage: the Task, a statusUpdate per change (tool name while working), the artifact, the final status, close", async () => {
    const s = await setup();
    const streaming = s.app.fastify.inject(rpcRequest("SendStreamingMessage", { message: message("fix it") }, s.token));
    const task = await row(s);
    const runId = await accept(s, task);
    await waitFor(async () => (await s.store.a2aTasks.findForToken(s.record.id, task.id))?.statusText === "working: bash");
    await new Promise((r) => setTimeout(r, 60));
    await settle(s, task, runId, "All fixed.");
    const res = await streaming;
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    const kinds = shape(res.body);
    assert.equal(kinds[0], "task:TASK_STATE_SUBMITTED");
    assert.deepEqual(kinds.slice(-2), ["artifact", "status:TASK_STATE_COMPLETED"]);
    assert.ok(kinds.includes("status:TASK_STATE_WORKING"), kinds.join());
    const all = events(res.body);
    assert.ok(all.every((e) => e.id === 7), "every event answers the request id");
    const working = all.map((e) => e.result?.statusUpdate).filter((u) => u?.status.state === "TASK_STATE_WORKING");
    assert.ok(working.some((u) => u.status.message.parts[0].text === "working: bash"));
    const artifact = all.find((e) => e.result?.artifactUpdate)!.result!.artifactUpdate;
    assert.equal(artifact.taskId, task.id);
    assert.deepEqual(artifact.artifact.parts, [{ text: "All fixed.", mediaType: "text/plain" }]);
    await s.app.fastify.close();
  });

  test("a scope rejection streams the REJECTED task alone and closes", async () => {
    const s = await setup();
    const res = await s.app.fastify.inject(
      rpcRequest("SendStreamingMessage", { message: { ...withRepo(message("x")), metadata: { [OUTFITTER_TASK_EXTENSION]: { repo: "acme/other" } } } }, s.token),
    );
    assert.deepEqual(shape(res.body), ["task:TASK_STATE_REJECTED"]);
    await s.app.fastify.close();
  });

  test("errors before the stream are plain JSON-RPC errors: bad parts, a foreign task", async () => {
    const s = await setup();
    const other = await setup({}, { store: s.store });
    const theirs = await start(other, message("theirs"));
    const bad = await rpc(s.app, s.token, "SendStreamingMessage", { message: { ...message("x"), parts: [{ url: "https://example.com/f" }] } });
    assert.equal(bad.json().error.code, -32005);
    const foreign = await rpc(s.app, s.token, "SendStreamingMessage", { message: message("hi", { taskId: theirs.id }) });
    assert.equal(foreign.json().error.code, -32001);
    const sub = await rpc(s.app, s.token, "SubscribeToTask", { id: theirs.id });
    assert.equal(sub.json().error.code, -32001);
    await s.app.fastify.close();
    await other.app.fastify.close();
  });

  test("SubscribeToTask: a terminal task is -32004; a live one streams until terminal, across instances", async () => {
    const store = new MemoryStore();
    const a = await setup({}, { store });
    const b = await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_ORIGIN: LINK, A2A_STREAM_POLL_MS: "20" }, { store });
    b.fastify.log.level = "warn";
    const task = await start(a, message("one"));
    // Instance A streams; instance B (same store) cancels. Only the row connects them.
    const streaming = a.app.fastify.inject(rpcRequest("SubscribeToTask", { id: task.id }, a.token));
    await new Promise((r) => setTimeout(r, 60));
    const canceled = await b.fastify.inject(rpcRequest("CancelTask", { id: task.id }, a.token));
    assert.equal(canceled.json().result.status.state, "TASK_STATE_CANCELED");
    const res = await streaming;
    const kinds = shape(res.body);
    assert.match(kinds[0], /^task:TASK_STATE_(SUBMITTED|WORKING)$/);
    assert.equal(kinds.at(-1), "status:TASK_STATE_CANCELED");
    assert.ok(!kinds.includes("artifact"));
    const again = await rpc(a.app, a.token, "SubscribeToTask", { id: task.id });
    assert.equal(again.json().error.code, -32004);
    await a.app.fastify.close();
    await b.fastify.close();
  });

  test("SendStreamingMessage closes on INPUT_REQUIRED; SubscribeToTask stays open through it", async () => {
    const s = await setup();
    const streaming = s.app.fastify.inject(rpcRequest("SendStreamingMessage", { message: message("ask me") }, s.token));
    const task = await row(s);
    const runId = await accept(s, task);
    await s.store.runs.update(runId, { pendingUiRequest: { type: "extension_ui_request", id: "q1", method: "input", title: "Which file?" } });
    const res = await streaming;
    assert.equal(shape(res.body).at(-1), "status:TASK_STATE_INPUT_REQUIRED");
    const last = events(res.body).at(-1)!.result!.statusUpdate;
    assert.equal(last.status.message.parts[0].text, "Which file?");

    const sub = s.app.fastify.inject(rpcRequest("SubscribeToTask", { id: task.id }, s.token));
    await new Promise((r) => setTimeout(r, 60));
    await rpc(s.app, s.token, "SendMessage", { message: message("src/a.ts", { taskId: task.id }), configuration: { returnImmediately: true } });
    await new Promise((r) => setTimeout(r, 60));
    await settle(s, task, runId, "Changed src/a.ts.");
    const subRes = await sub;
    const kinds = shape(subRes.body);
    assert.equal(kinds[0], "task:TASK_STATE_INPUT_REQUIRED");
    assert.deepEqual(kinds.slice(-2), ["artifact", "status:TASK_STATE_COMPLETED"]);
    await s.app.fastify.close();
  });

  test("a stream ends at A2A_STREAM_MAX_MS while the task still works", async () => {
    const s = await setup({ A2A_STREAM_MAX_MS: "1000" });
    const started = Date.now();
    const res = await s.app.fastify.inject(rpcRequest("SendStreamingMessage", { message: message("slow") }, s.token));
    const took = Date.now() - started;
    assert.ok(took >= 900 && took < 5000, `took ${took} ms`);
    assert.equal(shape(res.body)[0], "task:TASK_STATE_SUBMITTED");
    await s.app.fastify.close();
  });

  test("open streams per key: over the limit is HTTP 429; another key is unaffected; closing frees it", async () => {
    const s = await setup({ A2A_STREAMS_PER_KEY: "1" });
    const other = await setup({}, { store: s.store });
    const task = await start(s, message("one"));
    const first = s.app.fastify.inject(rpcRequest("SubscribeToTask", { id: task.id }, s.token));
    await new Promise((r) => setTimeout(r, 60));
    const second = await rpc(s.app, s.token, "SendStreamingMessage", { message: message("two") });
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().error.code, -32600);
    // Nothing was started for the refused stream.
    assert.equal((await s.store.a2aTasks.list(s.record.id, { limit: 10 })).total, 1);
    const otherTask = await start(other, message("theirs"));
    await rpc(s.app, other.token, "CancelTask", { id: otherTask.id });
    await rpc(s.app, s.token, "CancelTask", { id: task.id });
    await first;
    const third = await start(s, message("three"));
    const ok = s.app.fastify.inject(rpcRequest("SubscribeToTask", { id: third.id }, s.token));
    await new Promise((r) => setTimeout(r, 60));
    await rpc(s.app, s.token, "CancelTask", { id: third.id });
    assert.equal((await ok).statusCode, 200);
    await s.app.fastify.close();
    await other.app.fastify.close();
  });

  test("a client that disconnects frees its stream at once (real HTTP)", async () => {
    const s = await setup({ A2A_STREAMS_PER_KEY: "1" });
    await s.app.fastify.listen({ port: 0, host: "127.0.0.1" });
    const port = (s.app.fastify.server.address() as AddressInfo).port;
    const task = await start(s, message("one"));
    const abort = new AbortController();
    const req = rpcRequest("SubscribeToTask", { id: task.id }, s.token);
    const res = await fetch(`http://127.0.0.1:${port}/a2a`, { method: "POST", headers: req.headers, body: req.payload, signal: abort.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /TASK_STATE_(SUBMITTED|WORKING)/);
    abort.abort();
    await reader.cancel().catch(() => undefined);
    // The slot comes back once the server sees the close.
    // A stream that ends by itself (a rejected task) shows whether the key's one slot is free.
    const rejected = { ...withRepo(message("two")), metadata: { [OUTFITTER_TASK_EXTENSION]: { repo: "acme/other" } } };
    const again = await waitFor(async () => {
      const r = await rpc(s.app, s.token, "SendStreamingMessage", { message: { ...rejected, messageId: randomUUID() } });
      return r.statusCode === 200 ? r : undefined;
    }, 3000).catch(() => undefined);
    assert.ok(again, "a new stream was allowed after the disconnect");
    await s.app.fastify.close();
  });

  test("a revoked key's open stream closes", async () => {
    const s = await setup({ A2A_STREAM_POLL_MS: "20" });
    const task = await start(s, message("one"));
    const streaming = s.app.fastify.inject(rpcRequest("SubscribeToTask", { id: task.id }, s.token));
    await new Promise((r) => setTimeout(r, 60));
    await s.store.tokens.update(s.record.id, { revokedAt: new Date().toISOString() });
    const started = Date.now();
    const res = await streaming;
    assert.ok(Date.now() - started < 3000);
    assert.equal(shape(res.body).length, 1);
    await s.app.fastify.close();
  });
});

describe("INPUT_REQUIRED and owner-only requests (§5.3 What can be answered)", () => {
  test("an input request: INPUT_REQUIRED with the question; the reply answers it once, by the request's id", async () => {
    const s = await setup();
    const task = await start(s, message("go"));
    const r = await row(s, task.id);
    const runId = await accept(s, r);
    await s.store.runs.update(runId, {
      pendingUiRequest: { type: "extension_ui_request", id: "ui-7", method: "editor", title: "Edit the\nplan", prefill: "secret draft" },
    });
    const asked = await getTask(s, task.id);
    assert.equal(asked.status.state, "TASK_STATE_INPUT_REQUIRED");
    assert.equal(asked.status.message.parts[0].text, "Edit the plan");
    assert.doesNotMatch(JSON.stringify(asked), /secret draft/);

    const answer = message("the new plan", { taskId: task.id, contextId: task.contextId });
    const res = await rpc(s.app, s.token, "SendMessage", { message: answer, configuration: { returnImmediately: true } });
    assert.equal(res.json().result.task.status.state, "TASK_STATE_WORKING");
    const run = (await s.store.runs.findById(runId))!;
    assert.equal(run.pendingUiRequest, undefined);
    assert.deepEqual(run.pending, [{ t: "ui_response", id: "ui-7", value: "the new plan" }]);

    // A retried answer (same messageId) is not applied to the next question.
    await s.store.runs.update(runId, { pendingUiRequest: { type: "extension_ui_request", id: "ui-8", method: "input", title: "Next?" } });
    const retried = await rpc(s.app, s.token, "SendMessage", { message: answer, configuration: { returnImmediately: true } });
    assert.ok(retried.json().result.task);
    assert.equal((await s.store.runs.findById(runId))!.pending.length, 1);
    assert.equal((await getTask(s, task.id)).status.state, "TASK_STATE_INPUT_REQUIRED");
    await s.app.fastify.close();
  });

  test("confirm and select stay with the owner: WORKING 'waiting for the owner', and a reply is refused", async () => {
    const s = await setup();
    const task = await start(s, message("go"));
    const runId = await accept(s, await row(s, task.id));
    const requests = [
      { type: "extension_ui_request", id: "c1", method: "confirm", title: "Authorize subagent worker?", message: "spawn" },
      { type: "extension_ui_request", id: "s1", method: "select", title: "Grant subagent spawn budget?", options: ["yes", "no"] },
      { type: "extension_ui_request", id: "m1", method: "confirm", title: "Allow MCP tool github.merge?", message: "" },
      // The api's own card shape (agentlink strips `source` from pi's events).
      { type: "extension_ui_request", id: "admin:x", method: "input", title: "type yes", source: "outfitter" },
    ];
    for (const pendingUiRequest of requests) {
      await s.store.runs.update(runId, { pendingUiRequest });
      const got = await getTask(s, task.id);
      assert.equal(got.status.state, "TASK_STATE_WORKING", pendingUiRequest.id);
      assert.equal(got.status.message.parts[0].text, "waiting for the owner");
      const reply = await rpc(s.app, s.token, "SendMessage", { message: message("yes", { taskId: task.id }), configuration: { returnImmediately: true } });
      assert.equal(reply.json().error.code, -32602, pendingUiRequest.id);
    }
    assert.deepEqual((await s.store.runs.findById(runId))!.pending, [], "nothing was sent to pi");
    await s.app.fastify.close();
  });

  test("an admin approval card: WORKING 'waiting for owner approval'; an answered or expired one is not", async () => {
    const s = await setup();
    const task = await start(s, message("go"));
    const r = await row(s, task.id);
    const runId = await accept(s, r);
    const now = Date.now();
    const approval = {
      id: "ap1",
      runId,
      sessionId: r.sessionId!,
      ownerEmail: OWNER,
      op: "tapes.update",
      title: "Change a tape",
      message: "x",
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };
    await s.store.adminApprovals.claim(approval, new Date(now).toISOString());
    // Even with an input request pending, the approval comes first.
    await s.store.runs.update(runId, { pendingUiRequest: { type: "extension_ui_request", id: "q", method: "input", title: "?" } });
    assert.equal((await getTask(s, task.id)).status.message.parts[0].text, "waiting for owner approval");
    await s.store.adminApprovals.decide(runId, "ap1", "denied", OWNER, new Date().toISOString());
    assert.equal((await getTask(s, task.id)).status.state, "TASK_STATE_INPUT_REQUIRED");
    await s.app.fastify.close();
  });

  test("an input request from another run (the owner's own turn) is not the caller's to answer", async () => {
    const s = await setup();
    const task = await start(s, message("go"));
    const r = await row(s, task.id);
    const run = (await s.store.runs.findActiveForSession(r.sessionId!))!;
    await s.store.runs.update(run.id, { state: "running" });
    await s.app.turns.noteMailAccepted(r.sessionId!, "some-other-run", r.mailId!, 1);
    await s.store.runs.update(run.id, { pendingUiRequest: { type: "extension_ui_request", id: "q", method: "input", title: "owner's question" } });
    const got = await getTask(s, task.id);
    assert.equal(got.status.state, "TASK_STATE_WORKING");
    assert.doesNotMatch(JSON.stringify(got), /owner's question/);
    await s.app.fastify.close();
  });

  test("a reply to a working task is -32602, to a finished one -32004", async () => {
    const s = await setup();
    const task = await start(s, message("go"));
    const r = await row(s, task.id);
    const runId = await accept(s, r);
    const working = await rpc(s.app, s.token, "SendMessage", { message: message("hi", { taskId: task.id }), configuration: { returnImmediately: true } });
    assert.equal(working.json().error.code, -32602);
    await settle(s, r, runId, "done");
    const done = await rpc(s.app, s.token, "SendMessage", { message: message("hi", { taskId: task.id }), configuration: { returnImmediately: true } });
    assert.equal(done.json().error.code, -32004);
    await s.app.fastify.close();
  });
});

describe("checkpoint-gated completion and the result artifact (§5.3 Completion)", () => {
  test("a repo task: WORKING 'pushing the result' and one checkpoint down-frame; COMPLETED once it lands, text + data parts", async () => {
    const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
    const github = fakePulls(calls, () => ({ status: 200, data: [{ number: 12, html_url: "https://github.com/acme/widgets/pull/12" }], headers: {} }));
    const s = await setup({}, { github });
    const task = await start(s, withRepo(message("fix")));
    const r = await row(s, task.id);
    const runId = await accept(s, r);
    // A checkpoint from before the settle doesn't count.
    await checkpoint(s, r.sessionId!, true, "f".repeat(40));
    await new Promise((res) => setTimeout(res, 5));
    await settle(s, r, runId, "Fixed the bug.");
    const pushing = await getTask(s, task.id);
    assert.equal(pushing.status.state, "TASK_STATE_WORKING");
    assert.equal(pushing.status.message.parts[0].text, "pushing the result");
    await getTask(s, task.id);
    const sent = (await s.store.runs.findById(runId))!.pending.filter((m) => m.t === "checkpoint");
    assert.equal(sent.length, 1, "asked once");

    // A frame that didn't land (nothing pushed) doesn't complete it either.
    await checkpoint(s, r.sessionId!, false);
    assert.equal((await getTask(s, task.id)).status.state, "TASK_STATE_WORKING");
    await checkpoint(s, r.sessionId!, true);
    const done = await getTask(s, task.id);
    assert.equal(done.status.state, "TASK_STATE_COMPLETED");
    assert.equal(done.artifacts.length, 1);
    const session = (await s.store.sessions.findById(r.sessionId!))!;
    assert.deepEqual(done.artifacts[0].parts, [
      { text: "Fixed the bug.", mediaType: "text/plain" },
      {
        data: {
          branch: session.branch,
          head: SHA,
          compareUrl: `https://github.com/acme/widgets/compare/main...${session.branch}`,
          prUrl: "https://github.com/acme/widgets/pull/12",
        },
        mediaType: "application/json",
      },
    ]);
    assert.deepEqual(calls.map((c) => [c.route, c.params.head, c.params.state]), [["GET /repos/{owner}/{repo}/pulls", `acme:${session.branch}`, "open"]]);
    await s.app.fastify.close();
  });

  test("no landed checkpoint within the timeout: FAILED 'result not pushed', no artifact", async () => {
    const s = await setup({ A2A_CHECKPOINT_TIMEOUT_MS: "100" });
    const task = await start(s, withRepo(message("fix")));
    const r = await row(s, task.id);
    const runId = await accept(s, r);
    await settle(s, r, runId, "Fixed, I think.");
    assert.equal((await getTask(s, task.id)).status.state, "TASK_STATE_WORKING");
    await new Promise((res) => setTimeout(res, 150));
    const failed = await getTask(s, task.id);
    assert.equal(failed.status.state, "TASK_STATE_FAILED");
    assert.equal(failed.status.message.parts[0].text, "result not pushed");
    assert.equal(failed.artifacts, undefined);
    await s.app.fastify.close();
  });

  test("the stream of a repo task: artifact with both parts, then COMPLETED; no prUrl without an open PR", async () => {
    const github = fakePulls([], () => ({ status: 200, data: [], headers: {} }));
    const s = await setup({}, { github });
    const streaming = s.app.fastify.inject(rpcRequest("SendStreamingMessage", { message: withRepo(message("fix")) }, s.token));
    const r = await row(s);
    const runId = await accept(s, r);
    await settle(s, r, runId, "Done.");
    await waitFor(async () => (await s.store.a2aTasks.findForToken(s.record.id, r.id))?.checkpointRequestedAt);
    await checkpoint(s, r.sessionId!, true);
    const res = await streaming;
    const kinds = shape(res.body);
    assert.ok(kinds.includes("status:TASK_STATE_WORKING"));
    assert.deepEqual(kinds.slice(-2), ["artifact", "status:TASK_STATE_COMPLETED"]);
    const parts = events(res.body).find((e) => e.result?.artifactUpdate)!.result!.artifactUpdate.artifact.parts;
    assert.equal(parts[0].text, "Done.");
    assert.equal(parts[1].data.prUrl, undefined);
    assert.equal(parts[1].data.head, SHA);
    await s.app.fastify.close();
  });

  test("a task without a repo completes on settle with the text part only", async () => {
    const s = await setup();
    const task = await start(s, message("explain"));
    const r = await row(s, task.id);
    await settle(s, r, await accept(s, r), "It works like this.");
    const done = await getTask(s, task.id);
    assert.equal(done.status.state, "TASK_STATE_COMPLETED");
    assert.deepEqual(done.artifacts[0].parts, [{ text: "It works like this.", mediaType: "text/plain" }]);
    assert.equal((await s.store.runs.findActiveForSession(r.sessionId!))!.pending.length, 0, "no checkpoint asked");
    await s.app.fastify.close();
  });
});

describe("GithubBroker.openPullUrl (the result's prUrl)", () => {
  const session = { id: "s1", guruId: "coder", repo: "acme/widgets", ownerEmail: OWNER, status: "open" as const, cost: 0, createdAt: "", updatedAt: "" };

  test("asks for an open PR with head owner:branch and returns its github.com URL", async () => {
    const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
    const broker = fakePulls(calls, () => ({ status: 200, data: [{ html_url: "https://github.com/acme/widgets/pull/3" }], headers: {} }));
    assert.equal(await broker.openPullUrl(session, "outfitter/a2a-12345678"), "https://github.com/acme/widgets/pull/3");
    assert.deepEqual(calls[0].params, { owner: "acme", repo: "widgets", head: "acme:outfitter/a2a-12345678", state: "open", per_page: 1 });
  });

  test("nothing on no PR, an error, a non-GitHub URL, no token or no repo", async () => {
    for (const reply of [
      { status: 200, data: [], headers: {} },
      { status: 403, data: { message: "nope" }, headers: {} },
      { status: 200, data: [{ html_url: "https://evil.example/acme/widgets/pull/3" }], headers: {} },
      { status: 200, data: [{ html_url: "javascript:alert(1)" }], headers: {} },
    ]) {
      assert.equal(await fakePulls([], () => reply).openPullUrl(session, "b"), undefined, JSON.stringify(reply));
    }
    const throwing = new GithubBroker(new MemoryStore(), new MemorySecretsBroker("t"), () => ({
      async request() {
        throw new Error("network");
      },
    }));
    assert.equal(await throwing.openPullUrl(session, "b"), undefined);
    const noToken = new GithubBroker(new MemoryStore(), new MemorySecretsBroker(""), () => {
      throw new Error("must not be called");
    });
    assert.equal(await noToken.openPullUrl(session, "b"), undefined);
    assert.equal(await fakePulls([], () => ({ status: 200, data: [], headers: {} })).openPullUrl({ ...session, repo: null }, "b"), undefined);
  });
});
