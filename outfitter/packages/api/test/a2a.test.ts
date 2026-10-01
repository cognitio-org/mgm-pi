// E9 PR5: the A2A v1.0 server core (docs/specs/atlas-agent-engine-and-a2a.md §5, §8): A2A keys and
// their kind separation, the Agent Cards, JSON-RPC at /a2a on the link role, task state, scope,
// limits and the a2aTasks store contract on MemoryStore and a real MongoDB.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildTestApp, seedGuru, type TestApp } from "./helpers.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { MongoStore } from "../src/store/mongo.ts";
import type { A2AKeyScope, A2ATask, ApiToken, Guru, Store } from "../src/store/types.ts";
import { generateToken, hashToken, tokenPrefix, TOKEN_TTL_MS } from "../src/tokens.ts";
import { OUTFITTER_TASK_EXTENSION } from "../src/a2a/card.ts";
// PR3's agentengine/identity.ts is the one memory identity (it also fails closed on a token id
// without the origin marker); PR5's src/a2a/memory-identity.ts copy was removed.
import { memoryIdentity, memoryUserHash } from "../src/agentengine/identity.ts";
import { branchAllowed, branchPrefixForSession } from "../src/branch-policy.ts";
import { a2aTapeProblem } from "../src/a2a/keys.ts";
import { loadConfig } from "../src/config.ts";

const OWNER = "owner@mgms.eu";
const LINK = "https://link.example";

async function linkApp(env: Record<string, string> = {}, store?: Store): Promise<TestApp> {
  return buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_ORIGIN: LINK, A2A_BLOCKING_CAP_MS: "300", ...env }, store ? { store } : {});
}

async function seedTape(store: Store, id: string, extra: Partial<Guru> = {}): Promise<Guru> {
  // An A2A tape needs an explicit tools list inside A2A_TAPE_TOOLS (a2aTapeProblem).
  return seedGuru(store, { id, name: `Tape ${id}`, tools: ["read", "bash", "edit", "write"], ...extra });
}

/** Stores a token and returns its plaintext. */
async function mintToken(store: Store, extra: Partial<ApiToken> = {}): Promise<{ token: string; record: ApiToken }> {
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
    ...extra,
  };
  await store.tokens.insert(record);
  return { token, record };
}

async function mintKey(store: Store, scope: Partial<A2AKeyScope> = {}): Promise<{ token: string; record: ApiToken }> {
  return mintToken(store, { kind: "a2a", a2a: { tapes: ["coder"], repos: ["acme/widgets"], maxConcurrent: 2, ...scope } });
}

interface RpcOptions {
  token?: string;
  headers?: Record<string, string>;
  url?: string;
  version?: string | null;
}

async function rpc(app: TestApp, method: string, params: unknown, opts: RpcOptions = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.version !== null) headers["a2a-version"] = opts.version ?? "1.0";
  return app.fastify.inject({
    method: "POST",
    url: opts.url ?? "/a2a",
    headers,
    payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

function message(text: string, extra: Record<string, unknown> = {}) {
  return { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text }], ...extra };
}

function withExt(params: Record<string, unknown>, ext: Record<string, unknown>) {
  return { ...params, metadata: { [OUTFITTER_TASK_EXTENSION]: ext }, extensions: [OUTFITTER_TASK_EXTENSION] };
}

async function send(app: TestApp, token: string, msg: Record<string, unknown>, configuration: Record<string, unknown> = { returnImmediately: true }) {
  return rpc(app, "SendMessage", { message: msg, configuration }, { token });
}

describe("A2A keys: kind separation (auth.ts)", () => {
  test("an A2A key gets 401 on /api/* (link role and the web role out of dev mode)", async () => {
    const store = new MemoryStore();
    await seedTape(store, "coder");
    const { token } = await mintKey(store);
    const link = await linkApp({}, store);
    const onLink = await link.fastify.inject({ method: "GET", url: "/api/sessions/x/entries", headers: { authorization: `Bearer ${token}` } });
    assert.equal(onLink.statusCode, 401);
    const web = await buildTestApp({ OUTFITTER_ROLE: "web", OUTFITTER_DEV: "0" }, { store });
    const onWeb = await web.fastify.inject({ method: "GET", url: "/api/sessions", headers: { authorization: `Bearer ${token}` } });
    assert.equal(onWeb.statusCode, 401);
    await link.fastify.close();
    await web.fastify.close();
  });

  test("a Dongle, a missing, revoked, expired or unknown-kind key all get HTTP 401 on /a2a", async () => {
    const store = new MemoryStore();
    await seedTape(store, "coder");
    const app = await linkApp({}, store);
    const dongle = await mintToken(store);
    const explicitDongle = await mintToken(store, { kind: "dongle" });
    const revoked = await mintKey(store);
    await store.tokens.update(revoked.record.id, { revokedAt: new Date().toISOString() });
    const expired = await mintKey(store);
    await store.tokens.update(expired.record.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const odd = await mintToken(store, { kind: "admin" as never, a2a: { tapes: ["coder"], repos: [], maxConcurrent: 2 } });
    const noScope = await mintToken(store, { kind: "a2a" });
    for (const token of [undefined, dongle.token, explicitDongle.token, revoked.token, expired.token, odd.token, noScope.token, "outf_nope"]) {
      const res = await rpc(app, "GetTask", { id: "x" }, { token });
      assert.equal(res.statusCode, 401, `token ${token?.slice(0, 8)}`);
      assert.match(String(res.headers["www-authenticate"]), /Bearer/);
    }
    await app.fastify.close();
  });

  test("a Dongle keeps working on the link role's /api/*", async () => {
    const store = new MemoryStore();
    const app = await linkApp({}, store);
    const { token } = await mintToken(store);
    const res = await app.fastify.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 200);
    await app.fastify.close();
  });
});

describe("A2A keys: creation (routes/tokens.ts)", () => {
  test("creates an A2A key with its scope, and lists every token's kind", async () => {
    const app = await buildTestApp();
    await seedTape(app.store, "coder");
    await seedTape(app.store, "reviewer");
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/me/tokens",
      payload: { name: "ae", kind: "a2a", a2a: { tapes: ["coder", "reviewer", "coder"], repos: ["Acme/Widgets", "acme/widgets"] } },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.match(body.token, /^outf_/);
    assert.equal(body.record.kind, "a2a");
    assert.deepEqual(body.record.a2a, { tapes: ["coder", "reviewer"], repos: ["Acme/Widgets"], maxConcurrent: 2 });
    assert.equal(body.record.hash, undefined);
    await app.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: { name: "laptop" } });
    const list = (await app.fastify.inject({ method: "GET", url: "/api/me/tokens" })).json() as Array<{ name: string; kind: string }>;
    assert.deepEqual(list.map((t) => [t.name, t.kind]).sort(), [["ae", "a2a"], ["laptop", "dongle"]]);
    await app.fastify.close();
  });

  test("refuses tapes with admin tools, agentEngine, memory auto or mergeFromCloud, unknown tapes and bad repos", async () => {
    const app = await buildTestApp();
    await seedTape(app.store, "coder");
    await seedTape(app.store, "admin", { adminTools: "manage" });
    await seedTape(app.store, "ae", { agentEngine: true });
    await seedTape(app.store, "mem", { memory: "auto" });
    await seedTape(app.store, "merger", { mergeFromCloud: true });
    await seedTape(app.store, "memtool", { memory: "tool" });
    const create = (a2a: unknown) => app.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: { name: "k", kind: "a2a", a2a } });
    for (const tape of ["admin", "ae", "mem", "merger", "ghost"]) {
      const res = await create({ tapes: ["coder", tape], repos: [] });
      assert.equal(res.statusCode, 400, tape);
    }
    for (const a2a of [{ tapes: [] }, { tapes: ["coder"], repos: ["not-a-repo"] }, { tapes: ["coder"], repos: ["a/.."] }, { tapes: ["coder"], maxConcurrent: 0 }, { tapes: ["coder"], maxConcurrent: 11 }, undefined]) {
      assert.equal((await create(a2a)).statusCode, 400, JSON.stringify(a2a));
    }
    assert.equal((await create({ tapes: ["memtool"], maxConcurrent: 3 })).statusCode, 201);
    assert.equal((await app.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: { name: "k", kind: "root" } })).statusCode, 400);
    assert.equal((await app.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: { name: "k", a2a: { tapes: ["coder"] } } })).statusCode, 400);
    await app.fastify.close();
  });

  test("a Dongle can't mint an A2A key (only the owner in the web UI)", async () => {
    const store = new MemoryStore();
    await seedTape(store, "coder");
    const { token } = await mintToken(store);
    const app = await buildTestApp({ OUTFITTER_ROLE: "web", OUTFITTER_DEV: "0" }, { store });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/me/tokens",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "k", kind: "a2a", a2a: { tapes: ["coder"] } },
    });
    assert.equal(res.statusCode, 403);
    await app.fastify.close();
  });
});

describe("Agent Card", () => {
  test("public, cacheable, CORS *, one generic skill and no tape names; a Bearer is ignored", async () => {
    const store = new MemoryStore();
    await seedTape(store, "coder", { name: "Secret Coder" });
    const { token } = await mintKey(store);
    const app = await linkApp({}, store);
    const res = await app.fastify.inject({ method: "GET", url: "/.well-known/agent-card.json", headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.match(String(res.headers["cache-control"]), /max-age/);
    assert.ok(res.headers.etag && res.headers["last-modified"]);
    const card = res.json();
    assert.deepEqual(card.supportedInterfaces, [{ url: `${LINK}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
    assert.notEqual(card.capabilities.streaming, true, "streaming stays off until PR6");
    assert.equal(card.capabilities.extendedAgentCard, true);
    assert.deepEqual(card.skills.map((s: { id: string }) => s.id), ["coding"]);
    assert.doesNotMatch(res.body, /Secret Coder|"coder"/);
    const again = await app.fastify.inject({ method: "GET", url: "/.well-known/agent-card.json", headers: { "if-none-match": String(res.headers.etag) } });
    assert.equal(again.statusCode, 304);
    await app.fastify.close();
  });

  test("the extended card lists only the key's tapes that are still usable", async () => {
    const store = new MemoryStore();
    await seedTape(store, "coder", { name: "Coder" });
    await seedTape(store, "helper", { name: "Helper" });
    await seedTape(store, "other", { name: "Other" });
    const { token } = await mintKey(store, { tapes: ["coder", "helper"] });
    await store.gurus.update("helper", { adminTools: "manage" });
    const app = await linkApp({}, store);
    const res = await rpc(app, "GetExtendedAgentCard", {}, { token });
    assert.equal(res.statusCode, 200);
    const card = res.json().result;
    assert.deepEqual(card.skills.map((s: { id: string }) => s.id), ["coder"]);
    assert.doesNotMatch(JSON.stringify(card), /Other|Helper/);
    await app.fastify.close();
  });

  test("not on the web role", async () => {
    const app = await buildTestApp({ OUTFITTER_ROLE: "web" });
    assert.equal(app.fastify.hasRoute({ method: "POST", url: "/a2a" }), false);
    assert.equal(app.fastify.hasRoute({ method: "GET", url: "/.well-known/agent-card.json" }), false);
    await app.fastify.close();
  });
});

describe("JSON-RPC transport", () => {
  async function setup() {
    const store = new MemoryStore();
    await seedTape(store, "coder");
    const { token, record } = await mintKey(store);
    const app = await linkApp({}, store);
    return { store, app, token, record };
  }

  test("a missing version is VersionNotSupported (-32009); the header or the query parameter works", async () => {
    const { app, token } = await setup();
    const missing = await rpc(app, "GetTask", { id: "x" }, { token, version: null });
    assert.equal(missing.json().error.code, -32009);
    const old = await rpc(app, "GetTask", { id: "x" }, { token, version: "0.3" });
    assert.equal(old.json().error.code, -32009);
    const viaQuery = await rpc(app, "GetTask", { id: "x" }, { token, version: null, url: "/a2a?A2A-Version=1.0" });
    assert.equal(viaQuery.json().error.code, -32001);
    const trailing = await rpc(app, "GetTask", { id: "x" }, { token, url: "/a2a/" });
    assert.equal(trailing.json().error.code, -32001);
    await app.fastify.close();
  });

  test("without a key, even a malformed request is HTTP 401", async () => {
    const { app } = await setup();
    const res = await app.fastify.inject({ method: "POST", url: "/a2a", headers: { "content-type": "application/json", "a2a-version": "1.0" }, payload: "{not json" });
    assert.equal(res.statusCode, 401);
    const typed = await app.fastify.inject({ method: "POST", url: "/a2a", headers: { "content-type": "text/plain" }, payload: "x" });
    assert.equal(typed.statusCode, 401);
    await app.fastify.close();
  });

  test("wrong content type -32005, bad JSON -32700, over 64 KB 413, raw/url parts -32005, a long prompt -32602", async () => {
    const { app, token } = await setup();
    const auth = { authorization: `Bearer ${token}`, "a2a-version": "1.0" };
    const text = await app.fastify.inject({ method: "POST", url: "/a2a", headers: { ...auth, "content-type": "text/plain" }, payload: "{}" });
    assert.equal(text.statusCode, 200);
    assert.equal(text.json().error.code, -32005);
    const bad = await app.fastify.inject({ method: "POST", url: "/a2a", headers: { ...auth, "content-type": "application/json" }, payload: "{not json" });
    assert.equal(bad.json().error.code, -32700);
    const proto = await app.fastify.inject({ method: "POST", url: "/a2a", headers: { ...auth, "content-type": "application/json" }, payload: '{"__proto__":{"x":1}}' });
    assert.equal(proto.json().error.code, -32700);
    const big = await app.fastify.inject({
      method: "POST",
      url: "/a2a",
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: message("x".repeat(70_000)) } }),
    });
    assert.equal(big.statusCode, 413);
    const url = await send(app, token, { messageId: "m-url", role: "ROLE_USER", parts: [{ url: "https://example.com/x" }] });
    assert.equal(url.json().error.code, -32005);
    const raw = await send(app, token, { messageId: "m-raw", role: "ROLE_USER", parts: [{ raw: Buffer.from("x").toString("base64") }] });
    assert.equal(raw.json().error.code, -32005);
    const long = await send(app, token, message("y".repeat(32_001)));
    assert.equal(long.json().error.code, -32602);
    const empty = await send(app, token, message("   "));
    assert.equal(empty.json().error.code, -32602);
    await app.fastify.close();
  });

  test("push methods -32003; streaming -32004 (PR6); unknown methods -32601", async () => {
    const { app, token } = await setup();
    const push = await rpc(app, "CreateTaskPushNotificationConfig", { taskId: "x", url: "https://example.com" }, { token });
    assert.equal(push.json().error.code, -32003);
    const getPush = await rpc(app, "GetTaskPushNotificationConfig", { taskId: "x", id: "y" }, { token });
    assert.equal(getPush.json().error.code, -32003);
    const stream = await rpc(app, "SendStreamingMessage", { message: message("hi") }, { token });
    assert.equal(stream.statusCode, 200);
    assert.equal(stream.json().error.code, -32004);
    const sub = await rpc(app, "SubscribeToTask", { id: "x" }, { token });
    assert.equal(sub.json().error.code, -32004);
    const unknown = await rpc(app, "Frobnicate", {}, { token });
    assert.equal(unknown.json().error.code, -32601);
    await app.fastify.close();
  });

  test("60 requests a minute per key by default, then HTTP 429; another key is unaffected", async () => {
    const { app, token, store } = await setup();
    assert.equal(loadConfig({ MONGODB_URI: "memory" } as NodeJS.ProcessEnv).a2aRequestsPerMinute, 60);
    const other = await mintKey(store);
    // The window is the wall-clock minute: don't start within 3 s of its end.
    const intoMinute = Date.now() % 60_000;
    if (intoMinute > 57_000) await new Promise((r) => setTimeout(r, 60_500 - intoMinute));
    for (let i = 0; i < 60; i++) {
      assert.equal((await rpc(app, "GetTask", { id: "x" }, { token })).statusCode, 200);
    }
    const limited = await rpc(app, "GetTask", { id: "x" }, { token });
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
    assert.equal((await rpc(app, "GetTask", { id: "x" }, { token: other.token })).statusCode, 200);
    await app.fastify.close();
  });
});

describe("SendMessage and tasks", () => {
  async function setup(scope: Partial<A2AKeyScope> = {}) {
    const store = new MemoryStore();
    await seedTape(store, "coder");
    await seedTape(store, "second");
    const key = await mintKey(store, scope);
    const app = await linkApp({}, store);
    return { store, app, ...key };
  }

  test("a new task: SUBMITTED, an opaque contextId, a session as the owner on the forced branch", async () => {
    const { store, app, token, record } = await setup();
    const res = await send(app, token, withExt(message("Fix the flaky test\nmore detail"), { repo: "ACME/widgets", baseBranch: "develop", branch: "main" }), {
      returnImmediately: true,
      historyLength: 0,
    });
    assert.equal(res.statusCode, 200, res.body);
    const task = res.json().result.task;
    assert.equal(task.status.state, "TASK_STATE_SUBMITTED");
    assert.equal(task.history, undefined);
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    assert.ok(row.sessionId);
    assert.notEqual(task.contextId, row.sessionId);
    const session = (await store.sessions.findById(row.sessionId))!;
    assert.equal(session.ownerEmail, OWNER);
    assert.equal(session.origin, "a2a");
    assert.equal(session.a2aTokenId, record.id);
    assert.equal(session.guruId, "coder");
    assert.equal(session.repo, "acme/widgets", "the key's spelling of the repo");
    assert.equal(session.baseBranch, "develop");
    assert.equal(session.branch, `outfitter/a2a-${task.id.replaceAll("-", "").slice(0, 12)}`);
    assert.equal(session.name, "A2A: Fix the flaky test");
    assert.match(session.prompt!, /remote A2A caller/);
    assert.match(session.prompt!, /Fix the flaky test/);
    const mail = (await store.mail.findById(row.mailId!))!;
    assert.equal(mail.sessionId, session.id);
    assert.equal(mail.from.email, OWNER);
    const waiter = (await store.turnWaiters.findById(row.waiterId!))!;
    assert.equal(waiter.owner, "a2a");
    assert.equal(waiter.mailId, row.mailId);
    await app.fastify.close();
  });

  test("the branch: a client's `main` never reaches the session, and the session pushes only its own branch", async () => {
    const { store, app, token, record } = await setup();
    const res = await send(app, token, withExt(message("go"), { repo: "acme/widgets", branch: "main", baseBranch: "main" }));
    const row = (await store.a2aTasks.findForToken(record.id, res.json().result.task.id))!;
    const session = (await store.sessions.findById(row.sessionId!))!;
    assert.match(session.branch!, /^outfitter\/a2a-[0-9a-f]{12}$/);
    const prefix = branchPrefixForSession(session, "outfitter/");
    assert.equal(branchAllowed(session.branch!, session.branch!, prefix), true);
    assert.equal(branchAllowed("main", session.branch!, prefix), false);
    assert.equal(branchAllowed("outfitter/other", session.branch!, prefix), false);
    assert.equal(branchAllowed("outfitter/a2a-ffffffffffff", session.branch!, prefix), false);
    assert.equal(branchPrefixForSession({ branch: "outfitter/x" }, undefined), "outfitter/");
    await app.fastify.close();
  });

  test("the extension is echoed when requested in A2A-Extensions; bad parameters are -32602", async () => {
    const { app, token } = await setup();
    const res = await rpc(
      app,
      "SendMessage",
      { message: withExt(message("hi"), { skill: "coder" }), configuration: { returnImmediately: true } },
      { token, headers: { "a2a-extensions": OUTFITTER_TASK_EXTENSION } },
    );
    assert.equal(res.headers["a2a-extensions"], OUTFITTER_TASK_EXTENSION);
    for (const ext of [{ skill: "bad id!" }, { repo: "nope" }, { baseBranch: "../x" }, { baseBranch: "-x" }, { skill: 3 }]) {
      const bad = await send(app, token, withExt(message("hi"), ext));
      assert.equal(bad.json().error.code, -32602, JSON.stringify(ext));
    }
    const notObject = await send(app, token, message("hi", { metadata: { [OUTFITTER_TASK_EXTENSION]: "coder" } }));
    assert.equal(notObject.json().error.code, -32602);
    await app.fastify.close();
  });

  test("scope: another tape or repo is REJECTED with the reason in status.message, as a result", async () => {
    const { app, token } = await setup();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ skill: "second" }, /tape "second" is not allowed/],
      [{ repo: "acme/other" }, /repository acme\/other is not allowed/],
    ];
    for (const [ext, reason] of cases) {
      const res = await send(app, token, withExt(message("hi"), ext));
      const task = res.json().result.task;
      assert.equal(task.status.state, "TASK_STATE_REJECTED");
      assert.match(task.status.message.parts[0].text, reason);
    }
    await app.fastify.close();
  });

  test("a tape changed after the key was made is refused at task start", async () => {
    const { store, app, token } = await setup();
    for (const patch of [{ adminTools: "operator" as const }, { agentEngine: true }, { memory: "auto" as const }, { mergeFromCloud: true }]) {
      await store.gurus.update("coder", { adminTools: "off", agentEngine: false, memory: "off", mergeFromCloud: false, ...patch });
      const task = (await send(app, token, message("hi"))).json().result.task;
      assert.equal(task.status.state, "TASK_STATE_REJECTED", JSON.stringify(patch));
      assert.match(task.status.message.parts[0].text, /can't be used over A2A/);
    }
    await store.gurus.delete("coder");
    const gone = (await send(app, token, message("hi"))).json().result.task;
    assert.match(gone.status.message.parts[0].text, /no longer exists/);
    assert.equal((await store.sessions.list()).length, 0);
    await app.fastify.close();
  });

  test("no repo: a repo-less session with no branch", async () => {
    const { store, app, token, record } = await setup();
    const task = (await send(app, token, message("explain monads"))).json().result.task;
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    const session = (await store.sessions.findById(row.sessionId!))!;
    assert.equal(session.repo, null);
    assert.equal(session.branch, undefined);
    await app.fastify.close();
  });

  test("data parts become fenced JSON that can't close its fence early", async () => {
    const { store, app, token, record } = await setup();
    const msg = { messageId: "m-data", role: "ROLE_USER", parts: [{ text: "look" }, { data: { note: "```\nevil" } }] };
    const task = (await send(app, token, msg)).json().result.task;
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    const prompt = (await store.sessions.findById(row.sessionId!))!.prompt!;
    assert.match(prompt, /````json\n/);
    await app.fastify.close();
  });

  test("a repeated messageId returns the same task and makes one session", async () => {
    const { store, app, token } = await setup();
    const msg = message("once");
    const [a, b] = await Promise.all([send(app, token, msg), send(app, token, msg)]);
    const c = await send(app, token, msg);
    assert.equal(a.json().result.task.id, b.json().result.task.id);
    assert.equal(a.json().result.task.id, c.json().result.task.id);
    assert.equal((await store.sessions.list()).length, 1);
    await app.fastify.close();
  });

  test("maxConcurrent: a key over its limit gets REJECTED; a finished task frees its slot", async () => {
    const { app, token } = await setup({ maxConcurrent: 1 });
    const first = (await send(app, token, message("one"))).json().result.task;
    const second = (await send(app, token, message("two"))).json().result.task;
    assert.equal(second.status.state, "TASK_STATE_REJECTED");
    assert.match(second.status.message.parts[0].text, /1 task or Drive in progress/);
    assert.equal((await rpc(app, "CancelTask", { id: first.id }, { token })).json().result.status.state, "TASK_STATE_CANCELED");
    const third = (await send(app, token, message("three"))).json().result.task;
    assert.equal(third.status.state, "TASK_STATE_SUBMITTED");
    await app.fastify.close();
  });

  test("another key's task or context, and a session id as contextId, are not found", async () => {
    const { store, app, token, record } = await setup();
    const other = await mintKey(store);
    const task = (await send(app, token, message("mine"))).json().result.task;
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    for (const [method, params] of [
      ["GetTask", { id: task.id }],
      ["CancelTask", { id: task.id }],
    ] as const) {
      assert.equal((await rpc(app, method, params, { token: other.token })).json().error.code, -32001, method);
    }
    const viaContext = await send(app, other.token, message("hijack", { contextId: task.contextId }));
    assert.equal(viaContext.json().error.code, -32001);
    const viaTask = await send(app, other.token, message("hijack", { taskId: task.id }));
    assert.equal(viaTask.json().error.code, -32001);
    const viaSession = await send(app, token, message("hijack", { contextId: row.sessionId }));
    assert.equal(viaSession.json().error.code, -32001);
    const list = (await rpc(app, "ListTasks", {}, { token: other.token })).json().result;
    assert.deepEqual(list.tasks ?? [], []);
    assert.equal(await store.a2aTasks.findForToken(other.record.id, task.id), null);
    await app.fastify.close();
  });

  test("messages to an existing task: working -32602, mismatched context -32602, terminal -32004", async () => {
    const { app, token } = await setup();
    const task = (await send(app, token, message("one"))).json().result.task;
    assert.equal((await send(app, token, message("more", { taskId: task.id }))).json().error.code, -32602);
    assert.equal((await send(app, token, message("more", { taskId: task.id, contextId: randomUUID() }))).json().error.code, -32602);
    await rpc(app, "CancelTask", { id: task.id }, { token });
    assert.equal((await send(app, token, message("more", { taskId: task.id }))).json().error.code, -32004);
    await app.fastify.close();
  });

  test("a follow-up in a context: REJECTED while its task works, then a new task on the same session", async () => {
    const { store, app, token, record } = await setup();
    const first = (await send(app, token, withExt(message("one"), { repo: "acme/widgets" }))).json().result.task;
    const busy = (await send(app, token, message("two", { contextId: first.contextId }))).json().result.task;
    assert.equal(busy.status.state, "TASK_STATE_REJECTED");
    assert.equal(busy.contextId, first.contextId);
    assert.match(busy.status.message.parts[0].text, /one task at a time per context/);
    await settle(store, record.id, first.id, "first answer");
    const next = (await send(app, token, message("two", { contextId: first.contextId }))).json().result.task;
    assert.equal(next.status.state, "TASK_STATE_SUBMITTED");
    assert.equal(next.contextId, first.contextId);
    const a = (await store.a2aTasks.findForToken(record.id, first.id))!;
    const b = (await store.a2aTasks.findForToken(record.id, next.id))!;
    assert.equal(a.sessionId, b.sessionId);
    const otherRepo = (await send(app, token, withExt(message("three", { contextId: first.contextId }), { repo: "acme/other" }))).json().result.task;
    assert.equal(otherRepo.status.state, "TASK_STATE_REJECTED");
    await app.fastify.close();
  });

  test("COMPLETED on settle, with the turn's final text; the slot is held until its Drive stops", async () => {
    const { store, app, token, record } = await setup({ maxConcurrent: 1 });
    const task = (await send(app, token, message("one"))).json().result.task;
    await settle(store, record.id, task.id, "All fixed.");
    const got = (await rpc(app, "GetTask", { id: task.id, historyLength: 0 }, { token })).json().result;
    assert.equal(got.status.state, "TASK_STATE_COMPLETED");
    assert.equal(got.artifacts[0].parts[0].text, "All fixed.");
    // The finished task's Drive is still up (idle): it still counts against maxConcurrent.
    assert.deepEqual(await store.a2aTasks.listSlots(record.id), [task.id]);
    const blocked = (await send(app, token, message("two"))).json().result.task;
    assert.equal(blocked.status.state, "TASK_STATE_REJECTED");
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    const run = (await store.runs.findActiveForSession(row.sessionId!))!;
    await store.runs.update(run.id, { state: "stopped" });
    await rpc(app, "ListTasks", {}, { token });
    assert.deepEqual(await store.a2aTasks.listSlots(record.id), []);
    const withHistory = (await rpc(app, "GetTask", { id: task.id }, { token })).json().result;
    assert.equal(withHistory.history[0].parts[0].text, "one");
    await app.fastify.close();
  });

  test("a follow-up's result never carries the previous task's answer", async () => {
    const { store, app, token, record } = await setup();
    const first = (await send(app, token, message("one"))).json().result.task;
    await settle(store, record.id, first.id, "the secret first answer");
    const next = (await send(app, token, message("two", { contextId: first.contextId }))).json().result.task;
    await settle(store, record.id, next.id, undefined);
    const got = (await rpc(app, "GetTask", { id: next.id }, { token })).json().result;
    assert.equal(got.status.state, "TASK_STATE_COMPLETED");
    assert.doesNotMatch(JSON.stringify(got), /secret first answer/);
    await app.fastify.close();
  });

  test("two follow-ups at once in one context: only one runs", async () => {
    const { store, app, token, record } = await setup({ maxConcurrent: 5 });
    const first = (await send(app, token, message("one"))).json().result.task;
    await settle(store, record.id, first.id, "done");
    const [a, b] = await Promise.all([
      send(app, token, message("two", { contextId: first.contextId })),
      send(app, token, message("three", { contextId: first.contextId })),
    ]);
    const states = [a.json().result.task.status.state, b.json().result.task.status.state].sort();
    assert.deepEqual(states, ["TASK_STATE_REJECTED", "TASK_STATE_SUBMITTED"]);
    await app.fastify.close();
  });

  test("a rejected task keeps no copy of the message; a messageId over 128 characters is -32602", async () => {
    const { store, app, token, record } = await setup();
    const task = (await send(app, token, withExt(message("secret payload"), { skill: "second" }))).json().result.task;
    assert.equal((await store.a2aTasks.findForToken(record.id, task.id))!.message, undefined);
    assert.equal((await send(app, token, { ...message("x"), messageId: "m".repeat(129) })).json().error.code, -32602);
    await app.fastify.close();
  });

  test("a blocking retry of a messageId returns at once", async () => {
    const { app, token } = await setup();
    const msg = message("slow");
    await send(app, token, msg);
    const started = Date.now();
    const again = await send(app, token, msg, {});
    assert.ok(Date.now() - started < 250, "no second wait");
    assert.ok(again.json().result.task.id);
    await app.fastify.close();
  });

  test("an internal error reaches the caller as 'Internal error' only", async () => {
    const { store, app, token } = await setup();
    store.a2aTasks.findForToken = async () => {
      throw new Error("connection to cluster0-shard-00-01.example.mongodb.net:27017 closed");
    };
    const res = await rpc(app, "GetTask", { id: "x" }, { token });
    assert.equal(res.json().error.code, -32603);
    assert.equal(res.json().error.message, "Internal error");
    assert.doesNotMatch(res.body, /mongodb\.net/);
    await app.fastify.close();
  });

  test("FAILED when the turn ends unsettled, with no run notes passed to the caller", async () => {
    const { store, app, token, record } = await setup();
    const task = (await send(app, token, message("one"))).json().result.task;
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    await store.turnWaiters.finish(row.waiterId!, { status: "ended", endReason: "run_failed", detail: "secret internal note" }, new Date().toISOString());
    const got = (await rpc(app, "GetTask", { id: task.id }, { token })).json().result;
    assert.equal(got.status.state, "TASK_STATE_FAILED");
    assert.doesNotMatch(JSON.stringify(got), /secret internal note/);
    await app.fastify.close();
  });

  test("WORKING while its run works, with a useful status; waiting for the owner on a pending request", async () => {
    const { store, app, token, record } = await setup();
    const task = (await send(app, token, message("one"))).json().result.task;
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    const run = await store.runs.findActiveForSession(row.sessionId!);
    assert.ok(run, "the inline wake started a run");
    await store.runs.update(run.id, { state: "running", pendingUiRequest: { method: "confirm", id: "u1" } });
    const got = (await rpc(app, "GetTask", { id: task.id }, { token })).json().result;
    assert.equal(got.status.state, "TASK_STATE_WORKING");
    assert.equal(got.status.message.parts[0].text, "waiting for the owner");
    await app.fastify.close();
  });

  test("CancelTask: CANCELED, the unsent mail dead, the waiter canceled, never overwritten; again -32002", async () => {
    const { store, app, token, record } = await setup();
    const task = (await send(app, token, message("one"))).json().result.task;
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    const res = await rpc(app, "CancelTask", { id: task.id }, { token });
    assert.equal(res.json().result.status.state, "TASK_STATE_CANCELED");
    assert.equal((await store.mail.findById(row.mailId!))!.status, "dead");
    const waiter = (await store.turnWaiters.findById(row.waiterId!))!;
    assert.equal(waiter.endReason, "canceled");
    // A settle that arrives after can't move it.
    await store.turnWaiters.finish(row.waiterId!, { status: "settled" }, new Date().toISOString());
    assert.equal((await rpc(app, "GetTask", { id: task.id }, { token })).json().result.status.state, "TASK_STATE_CANCELED");
    assert.equal((await rpc(app, "CancelTask", { id: task.id }, { token })).json().error.code, -32002);
    assert.equal((await rpc(app, "CancelTask", { id: "nope" }, { token })).json().error.code, -32001);
    await app.fastify.close();
  });

  test("CancelTask stops the session's Drive even before it took the mail, and frees the slot", async () => {
    const { store, app, token, record } = await setup({ maxConcurrent: 1 });
    const task = (await send(app, token, message("one"))).json().result.task;
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    const run = (await store.runs.findActiveForSession(row.sessionId!))!;
    await rpc(app, "CancelTask", { id: task.id }, { token });
    assert.equal((await store.runs.findById(run.id))!.state, "stopped");
    assert.deepEqual(await store.a2aTasks.listSlots(record.id), []);
    await app.fastify.close();
  });

  test("CancelTask stops the run that took the task's mail", async () => {
    const { store, app, token, record } = await setup();
    const task = (await send(app, token, message("one"))).json().result.task;
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    const run = (await store.runs.findActiveForSession(row.sessionId!))!;
    await store.turnWaiters.markAcked(row.sessionId!, row.mailId!, run.id, 3, new Date().toISOString());
    await rpc(app, "CancelTask", { id: task.id }, { token });
    const after = (await store.runs.findById(run.id))!;
    assert.equal(after.state, "stopped");
    assert.equal(after.reason, "a2a");
    await app.fastify.close();
  });

  test("blocking SendMessage returns at the cap with the task still open", async () => {
    const { app, token } = await setup();
    const started = Date.now();
    const res = await send(app, token, message("slow"), {});
    const elapsed = Date.now() - started;
    const task = res.json().result.task;
    assert.ok(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"].includes(task.status.state), task.status.state);
    assert.ok(elapsed >= 250 && elapsed < 5000, `took ${elapsed} ms`);
    await app.fastify.close();
  });

  test("ListTasks: newest first, cursor pages, filters, the key's own only; a bad pageToken -32602", async () => {
    const { app, token } = await setup({ maxConcurrent: 5 });
    const ids: string[] = [];
    for (const t of ["a", "b", "c"]) ids.push((await send(app, token, message(t))).json().result.task.id);
    const first = (await rpc(app, "ListTasks", { pageSize: 2 }, { token })).json().result;
    assert.equal(first.tasks.length, 2);
    assert.equal(first.totalSize, 3);
    assert.ok(first.nextPageToken);
    const second = (await rpc(app, "ListTasks", { pageSize: 2, pageToken: first.nextPageToken }, { token })).json().result;
    assert.equal(second.tasks.length, 1);
    assert.equal(second.nextPageToken ?? "", "");
    assert.deepEqual([...first.tasks, ...second.tasks].map((t: { id: string }) => t.id).sort(), [...ids].sort());
    await rpc(app, "CancelTask", { id: ids[0] }, { token });
    const canceled = (await rpc(app, "ListTasks", { status: "TASK_STATE_CANCELED" }, { token })).json().result;
    assert.deepEqual(canceled.tasks.map((t: { id: string }) => t.id), [ids[0]]);
    assert.equal((await rpc(app, "ListTasks", { pageToken: "garbage" }, { token })).json().error.code, -32602);
    assert.equal((await rpc(app, "ListTasks", { pageSize: 500 }, { token })).json().error.code, -32602);
    await app.fastify.close();
  });

  test("the tick sweep finishes tasks nobody polls", async () => {
    const store = new MemoryStore();
    await seedTape(store, "coder");
    const { token, record } = await mintKey(store);
    const app = await linkApp({}, store);
    const task = (await send(app, token, message("one"))).json().result.task;
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    await store.turnWaiters.finish(row.waiterId!, { status: "settled" }, new Date().toISOString());
    const tick = await app.fastify.inject({ method: "POST", url: "/api/hooks/tick", headers: { authorization: "Bearer test-agent-token" } });
    assert.equal(tick.statusCode, 200, tick.body);
    assert.equal((await store.a2aTasks.findForToken(record.id, task.id))!.state, "completed");
    await app.fastify.close();
  });
});

/** Finishes a task's turn the way agentd would: pi accepts the mail on the session's run, then
 * replies (`reply`, or tool calls only when undefined), then settles. */
async function settle(store: Store, tokenId: string, taskId: string, reply: string | undefined): Promise<void> {
  const row = (await store.a2aTasks.findForToken(tokenId, taskId))!;
  const sessionId = row.sessionId!;
  const run = await store.runs.findActiveForSession(sessionId);
  const runId = run?.id ?? "r-test";
  let seq = (await store.entries.maxSeq(sessionId)) + 1;
  await store.turnWaiters.markAcked(sessionId, row.mailId!, runId, seq, new Date().toISOString());
  seq++;
  const entryId = `e-${randomUUID()}`;
  const content = reply === undefined ? [{ type: "toolCall", name: "bash" }] : [{ type: "text", text: reply }];
  await store.entries.insertIfNew(sessionId, seq, { id: entryId, parentId: null, type: "message", message: { role: "assistant", content } }, { runId });
  await store.turnWaiters.finish(row.waiterId!, { status: "settled", settledEntryId: entryId }, new Date().toISOString());
}

describe("A2A memory identity (§5.4)", () => {
  test("an A2A session uses a2a:<tokenId>, never its owner's hash", () => {
    const userId = (s: { origin?: "a2a"; a2aTokenId?: string; ownerEmail?: string }) => memoryIdentity({ id: "s1", repo: null, ...s })?.userId;
    assert.equal(userId({ origin: "a2a", a2aTokenId: "k1", ownerEmail: OWNER }), "a2a:k1");
    assert.equal(userId({ origin: "a2a", ownerEmail: OWNER }), undefined);
    assert.equal(userId({ a2aTokenId: "k1", ownerEmail: OWNER }), undefined, "a token id without the marker never falls back to the owner");
    assert.equal(userId({ ownerEmail: " Owner@MGMS.eu " }), memoryUserHash(OWNER));
    assert.match(memoryUserHash(OWNER), /^[0-9a-f]{16}$/);
    assert.equal(userId({}), undefined);
  });

  test("a2aTapeProblem allows memory: tool, refuses auto", () => {
    assert.equal(a2aTapeProblem({ id: "t", memory: "tool", tools: ["read", "memory"] }), undefined);
    assert.ok(a2aTapeProblem({ id: "t", memory: "auto", tools: ["read"] }));
  });
});

function contract(name: string, getStore: () => Store) {
  describe(`${name}: a2aTasks collection`, () => {
    const now = () => new Date().toISOString();
    const row = (extra: Partial<A2ATask> = {}): A2ATask => ({
      id: randomUUID(),
      contextId: "c1",
      tokenId: "k1",
      ownerEmail: OWNER,
      state: "submitted",
      createdAt: now(),
      updatedAt: now(),
      ...extra,
    });

    test("dedupes by messageId per key, and every read is per key", async () => {
      const store = getStore();
      const a = row({ messageId: "m1" });
      assert.equal(await store.a2aTasks.insert(a), true);
      assert.equal(await store.a2aTasks.insert(row({ messageId: "m1" })), false);
      assert.equal(await store.a2aTasks.insert(row({ messageId: "m1", tokenId: "k2" })), true);
      assert.equal(await store.a2aTasks.insert(row()), true, "no messageId never collides");
      assert.equal(await store.a2aTasks.insert(row()), true);
      assert.equal((await store.a2aTasks.findByMessageId("k1", "m1"))?.id, a.id);
      assert.equal(await store.a2aTasks.findForToken("k2", a.id), null);
      assert.equal((await store.a2aTasks.findForToken("k1", a.id))?.id, a.id);
    });

    test("transition never leaves a terminal state; contexts and lists are per key", async () => {
      const store = getStore();
      const t = row({ tokenId: "k3", contextId: "ctx", sessionId: "s1" });
      await store.a2aTasks.insert(t);
      const done = await store.a2aTasks.transition(t.id, ["submitted", "working"], { state: "canceled", updatedAt: now() });
      assert.equal(done?.state, "canceled");
      assert.equal(await store.a2aTasks.transition(t.id, ["submitted", "working"], { state: "completed" }), null);
      assert.equal((await store.a2aTasks.latestInContext("k3", "ctx"))?.id, t.id);
      assert.equal(await store.a2aTasks.latestInContext("k4", "ctx"), null);
      assert.equal(await store.a2aTasks.sessionForContext("k3", "ctx"), "s1");
      assert.equal(await store.a2aTasks.sessionForContext("k4", "ctx"), undefined);
      const later = row({ tokenId: "k3", contextId: "ctx", createdAt: new Date(Date.now() + 1000).toISOString() });
      await store.a2aTasks.insert(later);
      const listed = await store.a2aTasks.list("k3", { limit: 1 });
      assert.equal(listed.total, 2);
      assert.equal(listed.tasks[0].id, later.id);
      const page2 = await store.a2aTasks.list("k3", { limit: 5, before: { createdAt: later.createdAt, id: later.id } });
      assert.deepEqual(page2.tasks.map((x) => x.id), [t.id]);
      assert.deepEqual((await store.a2aTasks.listOpen(10, "k3")).map((x) => x.id), [later.id]);
    });

    test("slots: at most max per key, idempotent per task, released", async () => {
      const store = getStore();
      assert.equal(await store.a2aTasks.claimSlot("k5", "t1", 2), true);
      assert.equal(await store.a2aTasks.claimSlot("k5", "t1", 2), true);
      const results = await Promise.all(["t2", "t3", "t4"].map((id) => store.a2aTasks.claimSlot("k5", id, 2)));
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal((await store.a2aTasks.listSlots("k5")).length, 2);
      await store.a2aTasks.releaseSlot("k5", "t1");
      assert.equal(await store.a2aTasks.claimSlot("k5", "t9", 2), true);
      assert.equal(await store.a2aTasks.claimSlot("k6", "t1", 1), true);
    });

    test("countRequest counts per key and window", async () => {
      const store = getStore();
      const exp = new Date(Date.now() + 120_000).toISOString();
      assert.equal(await store.a2aTasks.countRequest("k7", "1", exp), 1);
      assert.equal(await store.a2aTasks.countRequest("k7", "1", exp), 2);
      assert.equal(await store.a2aTasks.countRequest("k7", "2", exp), 1);
      assert.equal(await store.a2aTasks.countRequest("k8", "1", exp), 1);
    });

    test("mail.markDead marks unsent mail only", async () => {
      const store = getStore();
      const base = { sessionId: "s", from: { kind: "user" as const }, text: "x", behavior: "followUp" as const, attempts: 0, createdAt: now() };
      await store.mail.insertIfNew({ ...base, id: `q-${name}`, status: "queued" });
      await store.mail.insertIfNew({ ...base, id: `a-${name}`, status: "acked" });
      assert.equal(await store.mail.markDead(`q-${name}`, now()), true);
      assert.equal((await store.mail.findById(`q-${name}`))?.status, "dead");
      assert.equal(await store.mail.markDead(`q-${name}`, now()), false);
      assert.equal(await store.mail.markDead(`a-${name}`, now()), false);
    });
  });
}

contract("MemoryStore", (() => {
  const store = new MemoryStore();
  return () => store;
})());

describe("MongoStore", () => {
  const DB_NAME = `outfitter_a2a_${randomUUID().slice(0, 8)}`;
  let mongo: MongoStore;
  let server: { stop(): Promise<unknown> } | undefined;

  before(async () => {
    let uri = process.env.OUTFITTER_TEST_MONGODB_URI;
    if (!uri) {
      const { MongoMemoryServer } = await import("mongodb-memory-server");
      const started = await MongoMemoryServer.create();
      server = started;
      uri = started.getUri();
    }
    mongo = await MongoStore.connect(uri, DB_NAME);
  });

  after(async () => {
    // @ts-expect-error -- reach past the Store interface to drop the scratch database itself.
    await mongo.client?.db(DB_NAME).dropDatabase();
    await mongo.close();
    await server?.stop();
  });

  contract("MongoStore", () => mongo);
});
