// E9 security review of the A2A server (PR #325): in-sandbox credentials a remote caller could
// reach (the org-default LiteLLM key, tape env, unredacted result text), the A2A tape tool
// allowlist, the admin socket trusting the tape as it stands now, revocation stopping work, the
// A2A branch (teleport import, entropy, fail-closed), and the /a2a negative bearer cache.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildTestApp, seedGuru, type TestApp } from "./helpers.ts";
import { openAgentSocket, runTokenFor, sendHello } from "./agent-socket.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { GcpSecretsBroker, MemorySecretsBroker, isA2ASession } from "../src/secrets.ts";
import type { A2AKeyScope, A2ATask, ApiToken, Guru, Session, Store } from "../src/store/types.ts";
import { generateToken, hashToken, tokenPrefix, TOKEN_TTL_MS } from "../src/tokens.ts";
import { A2A_NO_DEDICATED_KEY, A2A_TAPE_TOOLS, a2aTapeProblem } from "../src/a2a/keys.ts";
import { a2aBranchFor } from "../src/a2a/tasks.ts";
import { toWireTask } from "../src/a2a/handler.ts";
import { A2A_BRANCH_RE, branchAllowed, branchPrefixForSession } from "../src/branch-policy.ts";
import { DriveAdmin } from "../src/admin/drive.ts";
import { registerAdminOp, type AdminOp } from "../src/admin/ops.ts";
import { FailedBearerCache } from "../src/routes/a2a.ts";
import { OUTFITTER_TASK_EXTENSION } from "../src/a2a/card.ts";

const OWNER = "dev@localhost";
const TOOLS = ["read", "bash", "edit", "write"];

async function seedTape(store: Store, id: string, extra: Partial<Guru> = {}): Promise<Guru> {
  return seedGuru(store, { id, name: `Tape ${id}`, tools: TOOLS, ...extra });
}

async function mintKey(store: Store, scope: Partial<A2AKeyScope> = {}, extra: Partial<ApiToken> = {}): Promise<{ token: string; record: ApiToken }> {
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
    a2a: { tapes: ["coder"], repos: ["acme/widgets"], maxConcurrent: 2, ...scope },
    ...extra,
  };
  await store.tokens.insert(record);
  return { token, record };
}

async function send(app: TestApp, token: string, text: string, ext?: Record<string, unknown>) {
  const message: Record<string, unknown> = { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text }] };
  if (ext) {
    message.metadata = { [OUTFITTER_TASK_EXTENSION]: ext };
    message.extensions = [OUTFITTER_TASK_EXTENSION];
  }
  return app.fastify.inject({
    method: "POST",
    url: "/a2a",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "a2a-version": "1.0" },
    payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message, configuration: { returnImmediately: true } } }),
  });
}

describe("A2A tapes: a2aTapeProblem (env, tool allowlist)", () => {
  test("refuses a tape with no tools list, an empty one, or env", () => {
    assert.match(a2aTapeProblem({ id: "t" }) ?? "", /no tools list/);
    assert.match(a2aTapeProblem({ id: "t", tools: [] }) ?? "", /no tools list/);
    assert.match(a2aTapeProblem({ id: "t", tools: ["read"], env: { API_TOKEN: "x" } }) ?? "", /environment variables/);
    assert.equal(a2aTapeProblem({ id: "t", tools: ["read"], env: {} }), undefined);
  });

  test("refuses subagent, agent_engine, github_issue and anything off the allowlist; allows the list itself", () => {
    for (const tool of ["subagent", "subagents_enable", "subagent_supervisor", "agent_engine", "github_issue", "web_fetch", "something_new"]) {
      assert.match(a2aTapeProblem({ id: "t", tools: ["read", tool] }) ?? "", /not allowed over A2A/, tool);
    }
    assert.equal(a2aTapeProblem({ id: "t", tools: [...A2A_TAPE_TOOLS] }), undefined);
  });

  test("key creation refuses a tape with no tools list and one with subagent", async () => {
    const app = await buildTestApp();
    await seedTape(app.store, "coder");
    await seedGuru(app.store, { id: "bare", name: "Bare" });
    await seedTape(app.store, "spawner", { tools: ["read", "subagent"] });
    const create = (tapes: string[]) => app.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: { name: "k", kind: "a2a", a2a: { tapes } } });
    const bare = await create(["bare"]);
    assert.equal(bare.statusCode, 400);
    assert.match(bare.json().error, /no tools list/);
    const spawner = await create(["spawner"]);
    assert.equal(spawner.statusCode, 400);
    assert.match(spawner.json().error, /subagent/);
    assert.equal((await create(["coder"])).statusCode, 201);
    await app.fastify.close();
  });
});

describe("A2A credentials: the tape's own LiteLLM key only", () => {
  test("GcpSecretsBroker never falls back to the org-default key for an A2A session", async () => {
    const secrets: Record<string, string> = { "outfitter-litellm-key-default": "sk-org-default", "outfitter-litellm-key-own": "sk-own" };
    const absent = Object.assign(new Error("not found"), { status: 404, code: 404 });
    const broker = new GcpSecretsBroker("p", async (id) => {
      if (id in secrets) return secrets[id];
      throw absent;
    });
    const session = (extra: Partial<Session> = {}): Session => ({ id: "s1", guruId: "x", repo: null, status: "open", cost: 0, createdAt: "", updatedAt: "", ...extra });
    const guru = (id: string) => ({ id, name: id, model: "m", createdAt: "", updatedAt: "" }) as Guru;
    const plain = await broker.secretsForRun(session(), guru("other"));
    assert.equal(plain.litellmKey, "sk-org-default");
    assert.equal(plain.litellmKeySource, "default");
    const a2a = await broker.secretsForRun(session({ origin: "a2a", a2aTokenId: "k1" }), guru("other"));
    assert.equal(a2a.litellmKey, "");
    assert.equal(a2a.litellmKeySource, "none");
    const own = await broker.secretsForRun(session({ origin: "a2a", a2aTokenId: "k1" }), guru("own"));
    assert.equal(own.litellmKey, "sk-own");
    assert.equal(own.litellmKeySource, "guru");
    assert.equal(await broker.hasDedicatedLitellmKey("own"), true);
    assert.equal(await broker.hasDedicatedLitellmKey("other"), false);
  });

  test("key creation and task start refuse a tape with no dedicated key", async () => {
    const store = new MemoryStore();
    const secretsBroker = new MemorySecretsBroker("", "llm", new Set(["coder"]));
    await seedTape(store, "coder");
    await seedTape(store, "shared");
    const web = await buildTestApp({}, { store, secretsBroker });
    const res = await web.fastify.inject({ method: "POST", url: "/api/me/tokens", payload: { name: "k", kind: "a2a", a2a: { tapes: ["coder", "shared"] } } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, new RegExp(A2A_NO_DEDICATED_KEY));
    await web.fastify.close();

    // A key made before the secret went away: the task is REJECTED with the one-line reason.
    const link = await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_ORIGIN: "https://link.example" }, { store, secretsBroker });
    const { token } = await mintKey(store, { tapes: ["shared", "coder"] });
    const task = (await send(link, token, "go")).json().result.task;
    assert.equal(task.status.state, "TASK_STATE_REJECTED");
    assert.equal(task.status.message.parts[0].text, A2A_NO_DEDICATED_KEY);
    const ok = (await send(link, token, "go", { skill: "coder" })).json().result.task;
    assert.equal(ok.status.state, "TASK_STATE_SUBMITTED");
    await link.fastify.close();
  });
});

/** An A2A session with a run, as a task would leave it, and agentd's socket on it. */
async function a2aRun(opts: { tape?: Partial<Guru>; session?: Partial<Session>; dedicated?: string[] } = {}) {
  const store = new MemoryStore();
  const secretsBroker = new MemorySecretsBroker("", "sk-test-llm", opts.dedicated ? new Set(opts.dedicated) : undefined);
  const app = await buildTestApp({}, { store, secretsBroker });
  await seedTape(store, "coder", opts.tape);
  const now = new Date().toISOString();
  const session: Session = {
    id: "s1",
    guruId: "coder",
    repo: "acme/widgets",
    branch: a2aBranchFor(randomUUID()),
    baseBranch: "main",
    origin: "a2a",
    a2aTokenId: "k1",
    ownerEmail: OWNER,
    status: "open",
    cost: 0,
    createdAt: now,
    updatedAt: now,
    ...opts.session,
  };
  await store.sessions.insert(session);
  const run = await app.runs.wake(session.id);
  const agent = await openAgentSocket(app, run.id);
  sendHello(agent, run.id, session.id, runTokenFor(app, run.id));
  return { app, store, session, runId: run.id, agent };
}

describe("A2A runs: agentlink.ts refuses at spec time", () => {
  test("the spec of an A2A session carries no tape env, and pins the session branch", async () => {
    const { app, session, agent } = await a2aRun();
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    assert.equal(spec.guru.env, undefined);
    assert.equal(spec.repo.branch, session.branch);
    assert.equal(spec.repo.branchPrefix, `${session.branch}/`);
    assert.equal(spec.secrets.litellmKey, "sk-test-llm");
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  for (const [name, opts, reason] of [
    ["no dedicated LiteLLM key", { dedicated: ["someone-else"] }, /no dedicated LiteLLM key/],
    ["a tape that gained agentEngine", { tape: { agentEngine: true } }, /tape refused/],
    ["a tape with env", { tape: { env: { TOKEN: "x" } } }, /tape refused/],
    ["a branch moved off outfitter/a2a-*", { session: { branch: "main" } }, /bad branch/],
    ["an 8-character A2A branch", { session: { branch: "outfitter/a2a-12345678" } }, /bad branch/],
  ] as const) {
    test(`a run is refused (4412) for ${name}`, async () => {
      const { app, store, runId, agent } = await a2aRun(opts as never);
      const close = await agent.nextClose();
      assert.equal(close.code, 4412);
      assert.match(close.reason, reason);
      assert.equal(agent.messageCount(), 0, "no run.spec was sent");
      assert.equal((await store.runs.findById(runId))?.state, "failed");
      app.stopBackgroundTasks();
      await app.fastify.close();
    });
  }
});

describe("A2A results: redacted on the way out", () => {
  test("result text and status text go through redact()", () => {
    const now = new Date().toISOString();
    const task: A2ATask = {
      id: randomUUID(),
      contextId: "c1",
      tokenId: "k1",
      ownerEmail: OWNER,
      state: "completed",
      statusText: "done with ghp_abcdefghijklmnopqrstuvwxyz0123",
      result: { text: "Here is the key: sk-abcdefghijklmnopqrstuvwxyz and LITELLM_API_KEY=supersecretvalue1" },
      createdAt: now,
      updatedAt: now,
    };
    const wire = JSON.stringify(toWireTask(task));
    assert.doesNotMatch(wire, /sk-abcdefghijklmnop/);
    assert.doesNotMatch(wire, /supersecretvalue1/);
    assert.doesNotMatch(wire, /ghp_abcdefghij/);
    assert.match(wire, /\[redacted\]/);
  });

  test("the stored result is redacted at completion", async () => {
    const store = new MemoryStore();
    await seedTape(store, "coder");
    const app = await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_ORIGIN: "https://link.example" }, { store });
    const { token, record } = await mintKey(store);
    const task = (await send(app, token, "go")).json().result.task;
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    const run = await store.runs.findActiveForSession(row.sessionId!);
    const runId = run?.id ?? "r-test";
    let seq = (await store.entries.maxSeq(row.sessionId!)) + 1;
    await store.turnWaiters.markAcked(row.sessionId!, row.mailId!, runId, seq, new Date().toISOString());
    seq++;
    const entryId = `e-${randomUUID()}`;
    const text = "printenv says LITELLM_API_KEY=sk-abcdefghijklmnopqrstuvwxyz";
    await store.entries.insertIfNew(row.sessionId!, seq, { id: entryId, parentId: null, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }, { runId });
    await store.turnWaiters.finish(row.waiterId!, { status: "settled", settledEntryId: entryId }, new Date().toISOString());
    const done = await app.a2a.get({ id: record.id, name: record.name, ownerEmail: OWNER, scope: record.a2a! }, task.id);
    assert.equal(done.state, "completed");
    assert.doesNotMatch(done.result?.text ?? "", /sk-abcdefghij/);
    assert.match(done.result?.text ?? "", /redacted/);
    await app.fastify.close();
  });
});

// Test-only ops standing in for PR3/PR4's memory.* and ae.*.
const secCalls: string[] = [];
const secOps: Record<string, AdminOp> = {
  "secmem.context": { kind: "read", capability: "memory", async run() { secCalls.push("memory"); return { ok: true, text: "ok" }; } },
  "secae.list": { kind: "read", capability: "agentEngine", async run() { secCalls.push("ae"); return { ok: true, text: "ok" }; } },
};
const unregister = Object.entries(secOps).map(([name, op]) => registerAdminOp(name, op));
after(() => unregister.forEach((u) => u()));

describe("A2A Drives: the admin socket doesn't trust the tape as it stands now", () => {
  async function drive(tape: Partial<Guru>, session: Partial<Session> = { origin: "a2a", a2aTokenId: "k1" }) {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    await seedTape(store, "t", tape);
    await store.sessions.insert({ id: "s1", guruId: "t", repo: null, status: "open", cost: 0, ownerEmail: OWNER, createdAt: now, updatedAt: now, ...session });
    await store.runs.insert({ id: "r1", sessionId: "s1", state: "running", createdAt: now, updatedAt: now } as never);
    const admin = new DriveAdmin({ store, config: { operators: [OWNER] }, models: { list: async () => [] }, approval: { pollMs: 5, timeoutMs: 200 } });
    return { store, admin };
  }

  test("a tape that gained agentEngine or admin tools after the start reaches nothing", async () => {
    secCalls.length = 0;
    for (const tape of [{ agentEngine: true, memory: "tool" as const }, { adminTools: "operator" as const, memory: "tool" as const }]) {
      const { admin } = await drive(tape);
      for (const op of ["secae.list", "secmem.context", "tapes.list", "tapes.update"]) {
        const res = await admin.handle("r1", op, { id: "t", tools: ["subagent"] });
        assert.equal(res.ok, false, `${JSON.stringify(tape)} ${op}`);
        assert.match((res as { error: string }).error, /not permitted/);
      }
    }
    assert.deepEqual(secCalls, []);
  });

  test("a passing tape reaches memory only; the same tape outside A2A is unchanged", async () => {
    secCalls.length = 0;
    const a2a = await drive({ memory: "tool" });
    assert.equal((await a2a.admin.handle("r1", "secmem.context", {})).ok, true);
    assert.equal((await a2a.admin.handle("r1", "tapes.list", {})).ok, false);
    // A session with only a2aTokenId set counts as A2A too.
    const tokenOnly = await drive({ memory: "tool", agentEngine: true }, { a2aTokenId: "k1" });
    assert.equal((await tokenOnly.admin.handle("r1", "secae.list", {})).ok, false);
    const owner = await drive({ memory: "tool", agentEngine: true }, {});
    assert.equal((await owner.admin.handle("r1", "secae.list", {})).ok, true);
    assert.deepEqual(secCalls, ["memory", "ae"]);
  });
});

describe("A2A revocation stops work", () => {
  async function setup() {
    const store = new MemoryStore();
    await seedTape(store, "coder");
    const app = await buildTestApp({ OUTFITTER_ROLE: "all", OUTFITTER_ORIGIN: "https://link.example" }, { store });
    const key = await mintKey(store);
    return { store, app, ...key };
  }

  test("DELETE /api/me/tokens/:id cancels open tasks, kills their mail and stops their Drives", async () => {
    const { store, app, token, record } = await setup();
    const task = (await send(app, token, "go", { repo: "acme/widgets" })).json().result.task;
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    const run = (await store.runs.findActiveForSession(row.sessionId!))!;
    assert.ok(run);
    const res = await app.fastify.inject({ method: "DELETE", url: `/api/me/tokens/${record.id}` });
    assert.equal(res.statusCode, 200, res.body);
    const after = (await store.a2aTasks.findForToken(record.id, task.id))!;
    assert.equal(after.state, "canceled");
    assert.equal(after.statusText, "the A2A key was revoked");
    assert.equal((await store.mail.findById(row.mailId!))?.status, "dead");
    const stopped = await store.runs.findById(run.id);
    assert.notEqual(stopped?.state, "running");
    assert.ok(stopped?.state === "stopping" || stopped?.state === "stopped" || stopped?.state === "failed", stopped?.state);
    await app.fastify.close();
  });

  test("an idle Drive of a finished task is stopped on revocation too", async () => {
    const { store, app, token, record } = await setup();
    const task = (await send(app, token, "go")).json().result.task;
    const row = (await store.a2aTasks.findForToken(record.id, task.id))!;
    await store.a2aTasks.transition(row.id, ["submitted", "working"], { state: "completed", statusText: "done" });
    const run = (await store.runs.findActiveForSession(row.sessionId!))!;
    await app.a2a.endForKey(record.id, "canceled", "the A2A key was revoked");
    assert.equal((await store.a2aTasks.findForToken(record.id, task.id))!.state, "completed", "a finished task stays as it was");
    assert.notEqual((await store.runs.findById(run.id))?.state, run.state);
    await app.fastify.close();
  });

  test("the tick sweep ends tasks of a key revoked behind its back, or expired", async () => {
    const { store, app, token, record } = await setup();
    const revoked = (await send(app, token, "one")).json().result.task;
    const other = await mintKey(store);
    const expired = (await send(app, other.token, "two")).json().result.task;
    await store.tokens.update(record.id, { revokedAt: new Date().toISOString() });
    await store.tokens.update(other.record.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const tick = await app.fastify.inject({ method: "POST", url: "/api/hooks/tick", headers: { authorization: "Bearer test-agent-token" } });
    assert.equal(tick.statusCode, 200, tick.body);
    const a = (await store.a2aTasks.findForToken(record.id, revoked.id))!;
    const b = (await store.a2aTasks.findForToken(other.record.id, expired.id))!;
    assert.deepEqual([a.state, a.statusText], ["canceled", "the A2A key was revoked"]);
    assert.deepEqual([b.state, b.statusText], ["failed", "the A2A key has expired"]);
    await app.fastify.close();
  });
});

describe("A2A branch", () => {
  test("a2aBranchFor uses 12 hex characters, and A2A_BRANCH_RE agrees", () => {
    const id = randomUUID();
    const branch = a2aBranchFor(id);
    assert.equal(branch, `outfitter/a2a-${id.replaceAll("-", "").slice(0, 12)}`);
    assert.match(branch, A2A_BRANCH_RE);
    assert.doesNotMatch("outfitter/a2a-12345678", A2A_BRANCH_RE);
    assert.doesNotMatch("outfitter/a2a-0123456789ab/x", A2A_BRANCH_RE);
  });

  test("branchPrefixForSession fails closed for an A2A session without an A2A branch", () => {
    for (const session of [{ origin: "a2a", branch: "main" }, { origin: "a2a" }, { a2aTokenId: "k1", branch: "outfitter/x" }]) {
      const prefix = branchPrefixForSession(session, "outfitter/");
      assert.equal(branchAllowed("outfitter/y", session.branch ?? "", prefix), false, JSON.stringify(session));
      assert.equal(branchAllowed("main/x", session.branch ?? "", prefix), false);
      assert.equal(branchAllowed("outfitter/a2a-0123456789ab", session.branch ?? "", prefix), false);
    }
    assert.equal(isA2ASession({ a2aTokenId: "k1" }), true);
    assert.equal(isA2ASession({}), false);
  });

  test("PUT /api/sessions/:id/import is 409 for an A2A task's session", async () => {
    const app = await buildTestApp();
    const now = new Date().toISOString();
    const branch = a2aBranchFor(randomUUID());
    await app.store.sessions.insert({ id: "s-a2a", guruId: "coder", repo: "acme/widgets", branch, origin: "a2a", a2aTokenId: "k1", ownerEmail: OWNER, status: "open", cost: 0, createdAt: now, updatedAt: now });
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/api/sessions/s-a2a/import",
      headers: {
        "content-type": "application/x-ndjson",
        "x-outfitter-repo": "acme/widgets",
        "x-outfitter-branch": "main",
        "x-outfitter-base": "main",
        "x-outfitter-head": "a".repeat(40),
      },
      payload: `${JSON.stringify({ type: "session", id: "s-a2a", timestamp: now })}\n`,
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((await app.store.sessions.findById("s-a2a"))?.branch, branch);
    await app.fastify.close();
  });
});

describe("/a2a negative bearer cache", () => {
  test("FailedBearerCache: TTL and LRU bound", () => {
    let now = 0;
    const cache = new FailedBearerCache(1000, 2, () => now);
    cache.add("a");
    cache.add("b");
    assert.equal(cache.has("a"), true);
    cache.add("c");
    assert.equal(cache.size, 2);
    assert.equal(cache.has("a"), false, "oldest dropped");
    now = 1000;
    assert.equal(cache.has("b"), false, "expired");
  });

  test("a repeated bad bearer skips the store; a valid key is never cached", async () => {
    const store = new MemoryStore();
    await seedTape(store, "coder");
    const app = await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_ORIGIN: "https://link.example" }, { store });
    let lookups = 0;
    const findByHash = store.tokens.findByHash.bind(store.tokens);
    store.tokens.findByHash = async (hash: string) => {
      lookups++;
      return findByHash(hash);
    };
    const bad = generateToken();
    const call = (token: string) =>
      app.fastify.inject({
        method: "POST",
        url: "/a2a",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "a2a-version": "1.0" },
        payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "x" } }),
      });
    assert.equal((await call(bad)).statusCode, 401);
    assert.equal((await call(bad)).statusCode, 401);
    assert.equal(lookups, 1);
    const { token } = await mintKey(store);
    assert.equal((await call(token)).statusCode, 200);
    assert.equal((await call(token)).statusCode, 200);
    assert.equal(lookups, 3);
    await app.fastify.close();
  });
});
