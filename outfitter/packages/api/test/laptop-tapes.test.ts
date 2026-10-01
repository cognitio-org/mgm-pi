// E9.10 (#354, docs/specs/atlas-agent-engine-and-a2a.md §7.1): tapes played on a laptop. The data
// form of tapes.get/tapes.list a Dongle reads to pin a tape (env names only, never values), and
// Agent Engine from a laptop: only for a tape with it on, every invoke and resume on the web yes.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedGuru, type TestApp } from "./helpers.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { hashToken } from "../src/tokens.ts";
import { FakeAgentEngine } from "./fake-agent-engine.ts";
import { createAgentEngine } from "../src/agentengine/index.ts";
import { AeSessions } from "../src/ae-sessions.ts";
import { createGuru, updateGuru } from "../src/gurus-service.ts";
import { aeSessionId, aeSessionKey } from "../src/admin/ae-ops.ts";
import { memoryUserHash } from "../src/agentengine/identity.ts";

const ADA = "ada@example.com";
const ADA_TOKEN = "outf_laptop-tapes-ada";

async function linkApp(store = new MemoryStore()): Promise<TestApp> {
  await store.tokens.insert({ id: "tok-ada", ownerEmail: ADA, name: "laptop", prefix: ADA_TOKEN.slice(0, 8), hash: hashToken(ADA_TOKEN), createdAt: new Date().toISOString() });
  return buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_DEV: "0" }, { store });
}

async function op(a: TestApp, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const res = await a.fastify.inject({ method: "POST", url: "/api/admin/ops", headers: { authorization: `Bearer ${ADA_TOKEN}` }, payload: { op: name, args, ...extra } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { ok: boolean; text?: string; error?: string; needsApproval?: boolean; approvalId?: string };
}

const SECRET = "sk-live-0123456789abcdef-never-leaves";

describe("tapes as data for a laptop", () => {
  test("tapes.get format json: every field a Drive reads, env names only, the values never", async () => {
    const store = new MemoryStore();
    await seedGuru(store, {
      id: "foreman",
      name: "Foreman",
      model: "litellm/claude-auto-llm",
      fallbackModel: "litellm/claude-sonnet-5",
      thinking: "high",
      systemPrompt: "Plan.\nDelegate.",
      appendSystemPrompt: "Be brief.",
      tools: ["read", "subagent"],
      excludeTools: ["write"],
      packages: ["npm:pi-foo@1.2.3"],
      env: { ZED_KEY: SECRET, ALPHA: "a-value" },
      memory: "auto",
      agentEngine: true,
      mergeFromCloud: true,
      branchPrefix: "team/",
      browserIde: true,
      updatedAt: "2026-10-01T10:00:00.000Z",
    });
    const app = await linkApp(store);
    const got = await op(app, "tapes.get", { id: "foreman", format: "json" });
    assert.equal(got.ok, true);
    assert.ok(!got.text!.includes(SECRET) && !got.text!.includes("a-value"), "no env value, ever");
    const tape = JSON.parse(got.text!);
    assert.deepEqual(tape, {
      kind: "tape",
      format: 1,
      id: "foreman",
      name: "Foreman",
      model: "litellm/claude-auto-llm",
      fallbackModel: "litellm/claude-sonnet-5",
      thinking: "high",
      systemPrompt: "Plan.\nDelegate.",
      appendSystemPrompt: "Be brief.",
      tools: ["read", "subagent"],
      excludeTools: ["write"],
      packages: ["npm:pi-foo@1.2.3"],
      envNames: ["ALPHA", "ZED_KEY"],
      memory: "auto",
      agentEngine: true,
      mergeFromCloud: true,
      branchPrefix: "team/",
      browserIde: true,
      updatedAt: "2026-10-01T10:00:00.000Z",
    });
    // The text form is unchanged: names, "(values hidden)".
    const text = await op(app, "tapes.get", { id: "foreman" });
    assert.match(text.text!, /env: ZED_KEY, ALPHA \(values hidden\)/);
    assert.ok(!text.text!.includes(SECRET));
    await app.fastify.close();
  });

  test("a long prompt comes whole in the json form (the text form clips)", async () => {
    const store = new MemoryStore();
    await seedGuru(store, { id: "long", systemPrompt: "x".repeat(20_000) });
    const app = await linkApp(store);
    const tape = JSON.parse((await op(app, "tapes.get", { id: "long", format: "json" })).text!);
    assert.equal(tape.systemPrompt.length, 20_000);
    await app.fastify.close();
  });

  test("tapes.list format json: one row per tape with its capability flags and updatedAt", async () => {
    const store = new MemoryStore();
    await seedGuru(store, { id: "a", name: "A", memory: "tool", updatedAt: "2026-10-01T09:00:00.000Z", env: { K: SECRET } });
    await seedGuru(store, { id: "b", name: "B", agentEngine: true, updatedAt: "2026-10-01T10:00:00.000Z" });
    const app = await linkApp(store);
    const got = await op(app, "tapes.list", { format: "json" });
    assert.ok(!got.text!.includes(SECRET));
    const list = JSON.parse(got.text!);
    assert.equal(list.kind, "tapes");
    assert.deepEqual(list.tapes.map((t: { id: string }) => t.id), ["b", "a"]);
    assert.equal(list.tapes[0].agentEngine, true);
    assert.equal(list.tapes[1].memory, "tool");
    assert.equal(list.tapes[1].updatedAt, "2026-10-01T09:00:00.000Z");
    assert.equal(list.more, 0);
    await app.fastify.close();
  });
});

// ---------- laptop ae.* (E9.10): a tape with Agent Engine, the web yes on every invoke and resume ----------

const OWNER = "dev@localhost";
const OWNER_TOKEN = "outf_laptop-tapes-owner";
const EVE_TOKEN = "outf_laptop-tapes-eve";
const PI = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const LAPTOP_AE = { sessionId: `laptop:${PI}`, repo: "acme/widgets", tape: "foreman" };

async function aeApps(opts: { agentEngine?: boolean } = {}) {
  const fake = new FakeAgentEngine();
  const agentEngine = createAgentEngine(fake.config(["agents"]), { fetch: fake.fetch });
  const store = new MemoryStore();
  for (const [id, email, token] of [["tok-owner", OWNER, OWNER_TOKEN], ["tok-eve", "eve@example.com", EVE_TOKEN]] as const) {
    await store.tokens.insert({ id, ownerEmail: email, name: "laptop", prefix: token.slice(0, 8), hash: hashToken(token), createdAt: new Date().toISOString() });
  }
  await seedGuru(store, { id: "foreman", agentEngine: opts.agentEngine ?? true });
  await seedGuru(store, { id: "plain" });
  const now = new Date().toISOString();
  await store.aeAgents.insert({ id: "researcher", workspaceId: "ws-research", name: "Researcher", description: "Finds papers", enabled: true, createdAt: now, updatedAt: now });
  const link = await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_DEV: "0" }, { store, agentEngine });
  const web = await buildTestApp({ OUTFITTER_ROLE: "web" }, { store, agentEngine });
  const call = async (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}, token = OWNER_TOKEN) => {
    const res = await link.fastify.inject({ method: "POST", url: "/api/admin/ops", headers: { authorization: `Bearer ${token}` }, payload: { op: name, args, laptop: LAPTOP_AE, ...extra } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { ok: boolean; text?: string; error?: string; needsApproval?: boolean; approvalId?: string; state?: string };
  };
  const widget = async () => (await web.fastify.inject({ method: "GET", url: "/api/laptop-approvals" })).json().approvals as Array<{ id: string; op: string; title: string; summary: string; facts?: Array<{ label: string; value: string }> }>;
  const decide = (id: string, approve: boolean) => web.fastify.inject({ method: "POST", url: `/api/laptop-approvals/${id}`, payload: { approve } });
  const close = async () => {
    await link.fastify.close();
    await web.fastify.close();
  };
  return { fake, store, call, widget, decide, close };
}

const resumes = (fake: FakeAgentEngine) => fake.requests.filter((r) => r.path.endsWith("/resume"));
const invokes = (fake: FakeAgentEngine) => fake.requests.filter((r) => r.path.endsWith("/invokeStream"));

describe("laptop ae.*: only for a tape with Agent Engine on, read on every call", () => {
  test("refused without a tape, for a tape without Agent Engine, and for an unknown tape", async () => {
    const a = await aeApps();
    assert.match((await a.call("ae.list", {}, { laptop: { sessionId: LAPTOP_AE.sessionId } })).error!, /needs a tape with Agent Engine on \(kernal --tape <id>\)/);
    assert.match((await a.call("ae.list", {}, { laptop: { ...LAPTOP_AE, tape: "plain" } })).error!, /tape plain doesn't have it/);
    assert.match((await a.call("ae.list", {}, { laptop: { ...LAPTOP_AE, tape: "ghost" } })).error!, /tape ghost doesn't have it/);
    assert.match((await a.call("ae.list", {}, { laptop: { ...LAPTOP_AE, tape: "../x" } })).error!, /laptop.tape must be a tape id/);
    assert.equal((await a.call("ae.list", {})).ok, true);
    await a.close();
  });

  test("turning Agent Engine off on the tape cuts the laptop off at once", async () => {
    const a = await aeApps();
    assert.equal((await a.call("ae.list", {})).ok, true);
    await a.store.gurus.update("foreman", { agentEngine: false });
    assert.match((await a.call("ae.list", {})).error!, /tape foreman doesn't have it/);
    await a.close();
  });
});

describe("laptop ae.invoke: the owner's yes in the web app, never `confirmed`", () => {
  test("confirmed counts for nothing; the widget shows the agent and the message; approve, rerun, once", async () => {
    const a = await aeApps();
    a.fake.invokeScripts.push({ frames: [{ chunk_type: "text", content: "found 3 papers", execution_id: "exec-1" }, { chunk_type: "done", execution_id: "exec-1" }] });
    const args = { agent: "researcher", message: `find papers on tapes; key ${"sk-" + "a".repeat(40)}` };
    const asked = await a.call("ae.invoke", args, { confirmed: true });
    assert.equal(asked.needsApproval, true);
    assert.equal(invokes(a.fake).length, 0, "nothing sent before the yes");
    const [card] = await a.widget();
    assert.equal(card.op, "ae.invoke");
    assert.match(card.title, /Send a message to Agent Engine agent researcher from your laptop\?/);
    assert.match(card.summary, /find papers on tapes/);
    assert.doesNotMatch(card.summary, /sk-a{40}/, "secrets masked on the stored card");
    assert.deepEqual(card.facts, [{ label: "Agent", value: "researcher" }]);
    // A call the op would refuse anyway is refused before anyone is asked.
    assert.match((await a.call("ae.invoke", { agent: "researcher", message: " " })).error!, /message is required/);
    assert.match((await a.call("ae.invoke", { agent: "nobody", message: "hi" })).error!, /no enabled Agent Engine agent "nobody"/);
    assert.equal((await a.widget()).length, 1);
    // The rerun before the yes, or with other args, or from another owner, runs nothing.
    assert.match((await a.call("ae.invoke", args, { approvalId: asked.approvalId })).error!, /not approved yet/);
    assert.equal((await a.decide(asked.approvalId!, true)).statusCode, 200);
    assert.match((await a.call("ae.invoke", { ...args, message: "something else" }, { approvalId: asked.approvalId })).error!, /different request/);
    assert.match((await a.call("ae.invoke", args, { approvalId: asked.approvalId }, EVE_TOKEN)).error!, /no such approval|needs a tape/);
    const ran = await a.call("ae.invoke", args, { approvalId: asked.approvalId });
    assert.equal(ran.ok, true, JSON.stringify(ran));
    assert.match(ran.text!, /execution: exec-1/);
    assert.equal(invokes(a.fake).length, 1);
    // X-Session-ID keeps the Drives' shape, from a digest of the owner-bound key (not the pi id's tail).
    const sid = invokes(a.fake)[0].headers["x-session-id"];
    assert.equal(sid, aeSessionId(`laptop:${memoryUserHash(OWNER)}:${PI}`, "researcher"));
    assert.match(sid, /^outf-L[A-Za-z0-9_-]{7}-researcher$/);
    // Single use.
    assert.match((await a.call("ae.invoke", args, { approvalId: asked.approvalId })).error!, /already used/);
    assert.equal(invokes(a.fake).length, 1);
    const row = (await a.store.adminAudit.listRecent(10)).find((r) => r.ok)!;
    assert.deepEqual([row.op, row.via, row.approved, row.sessionId], ["ae.invoke", "token", true, LAPTOP_AE.sessionId]);
    await a.close();
  });

  test("denied in the web app: nothing is sent", async () => {
    const a = await aeApps();
    const args = { agent: "researcher", message: "hi" };
    const asked = await a.call("ae.invoke", args);
    await a.decide(asked.approvalId!, false);
    assert.match((await a.call("ae.invoke", args, { approvalId: asked.approvalId })).error!, /denied/);
    assert.equal(invokes(a.fake).length, 0);
    await a.close();
  });
});

describe("laptop ae.get / ae.resume: only this owner's laptop session's executions", () => {
  async function invoked(a: Awaited<ReturnType<typeof aeApps>>, exec = "exec-p") {
    a.fake.invokeScripts.push({ frames: [{ chunk_type: "done", execution_id: exec }] });
    const args = { agent: "researcher", message: "refund" };
    const asked = await a.call("ae.invoke", args);
    await a.decide(asked.approvalId!, true);
    assert.equal((await a.call("ae.invoke", args, { approvalId: asked.approvalId })).ok, true);
  }

  test("ae.get reads this laptop session's execution; another owner with the same pi session id reaches nothing", async () => {
    const a = await aeApps();
    await invoked(a);
    a.fake.executions.set("exec-p", { execution_id: "exec-p", status: "completed", response: "refunded" });
    assert.match((await a.call("ae.get", { executionId: "exec-p" })).text!, /refunded/);
    assert.match((await a.call("ae.get", { executionId: "exec-p" }, {}, EVE_TOKEN)).error!, /no execution "exec-p" started from this session/);
    assert.match((await a.call("ae.get", { executionId: "exec-p" }, { laptop: { ...LAPTOP_AE, sessionId: "laptop:0199a1b2-ffff-7e5f-8a9b-0c1d2e3f4a5b" } })).error!, /no execution/);
    await a.close();
  });

  test("ae.resume: the card shows the pause; the yes answers only that pause", async () => {
    const a = await aeApps();
    await invoked(a);
    a.fake.executions.set("exec-p", { execution_id: "exec-p", status: "suspended", suspend_reason: "refund", suspend_context: { step: 1 }, allowed_decisions: ["approve", "reject"] });
    const args = { executionId: "exec-p", decision: "approve" };
    const asked = await a.call("ae.resume", args, { confirmed: true });
    assert.equal(asked.needsApproval, true);
    const card = (await a.widget()).find((c) => c.op === "ae.resume")!;
    assert.match(card.title, /Answer an Agent Engine review with "approve"\?/);
    assert.match(card.summary, /Your laptop's agent asked to answer a paused review/);
    assert.match(card.summary, /its own words, unverified/);
    assert.deepEqual(card.facts, [{ label: "Execution", value: "exec-p" }, { label: "Decision", value: "approve" }]);
    await a.decide(asked.approvalId!, true);
    // The pause changed after the card was shown: the yes doesn't carry over.
    a.fake.executions.set("exec-p", { execution_id: "exec-p", status: "suspended", suspend_reason: "wire", suspend_context: { step: 2, wire: "$1M" }, allowed_decisions: ["approve", "reject"] });
    assert.match((await a.call("ae.resume", args, { approvalId: asked.approvalId })).error!, /different request/);
    assert.equal(resumes(a.fake).length, 0);
    // Asked again for the new pause, approved, answered once.
    const again = await a.call("ae.resume", args);
    await a.decide(again.approvalId!, true);
    const done = await a.call("ae.resume", args, { approvalId: again.approvalId });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(resumes(a.fake).length, 1);
    await a.close();
  });

  test("ae.close stops this laptop session's Agent Engine sessions; idle ones are swept, and their rows kept for get", async () => {
    const a = await aeApps();
    await invoked(a);
    const sid = aeSessionId(`laptop:${memoryUserHash(OWNER)}:${PI}`, "researcher");
    a.fake.runtimeSessions.set("ws-research", [{ session_id: sid, status: "active" } as never]);
    const closed = await a.call("ae.close", {});
    assert.equal(closed.ok, true);
    assert.match(closed.text!, /stopped 1 of 1/);
    const stops = a.fake.requests.filter((r) => r.path.endsWith("/stop"));
    assert.equal(stops.length, 1);
    assert.ok(stops[0].path.endsWith(`runtime-sessions/${sid}/stop`), stops[0].path);
    assert.match((await a.call("ae.close", {})).text!, /no Agent Engine sessions to stop/);
    await a.close();
  });
});

describe("the sweep and a laptop's Agent Engine sessions", () => {
  test("open while used in the last 15 minutes; then stopped, and the row kept for get", async () => {
    const fake = new FakeAgentEngine();
    const agentEngine = createAgentEngine(fake.config(["agents"]), { fetch: fake.fetch });
    const store = new MemoryStore();
    const key = { outfitterSessionId: `laptop:abc:${PI}`, agentId: "researcher", workspaceId: "ws-research", aeSessionId: "outf-2e3f4a5b-researcher" };
    let now = Date.parse("2026-10-01T10:00:00.000Z");
    await store.aeSessions.recordInvoke(key, "exec-1", new Date(now).toISOString());
    fake.runtimeSessions.set("ws-research", [{ session_id: key.aeSessionId, status: "active" } as never]);
    const sweeper = new AeSessions({ store, agents: agentEngine.agents, now: () => now });
    now += 5 * 60_000;
    assert.equal(await sweeper.sweep(), undefined, "used 5 minutes ago: left alone");
    now += 11 * 60_000;
    assert.deepEqual(await sweeper.sweep(), { stopped: 1, failed: 0 });
    assert.ok(await store.aeSessions.findByExecution(key.outfitterSessionId, "exec-1"), "kept for ae.get");
  });
});

describe("a tape's repos hint (E9.10)", () => {
  test("lowercased owner/name, deduplicated; anything else refused; agents may set it; it reaches the data form", async () => {
    const store = new MemoryStore();
    const human = { kind: "human" as const, operator: false };
    const made = await createGuru(store, { name: "T", model: "litellm/x", repos: ["Acme/Widgets", "acme/widgets", "acme/gears"] } as never, human);
    assert.ok(made.ok);
    assert.deepEqual(made.guru.repos, ["acme/widgets", "acme/gears"]);
    for (const bad of [["acme"], ["a/b/c"], [7], "acme/widgets", ["acme/wid:gets"]]) {
      const r = await createGuru(store, { name: "T", model: "litellm/x", repos: bad } as never, human);
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    const agent = await updateGuru(store, made.guru.id, { repos: ["acme/new"] } as never, { kind: "agent" });
    assert.ok(agent.ok, "not a capability field: an agent may set it");
    const app = await linkApp(store);
    const tape = JSON.parse((await op(app, "tapes.get", { id: made.guru.id, format: "json" })).text!);
    assert.deepEqual(tape.repos, ["acme/new"]);
    const viaOp = await op(app, "tapes.update", { id: made.guru.id, repos: ["acme/op"] });
    assert.equal(viaOp.ok, true, JSON.stringify(viaOp));
    assert.match(viaOp.text!, /repos/);
    await app.fastify.close();
  });
});

describe("review fixes (E9.10)", () => {
  test("the Agent Engine session id is bound to the owner: same pi id, different owners, different ids; never a Drive's", () => {
    const ada = aeSessionKey({ email: "ada@example.com", via: "token", operator: false, laptop: { sessionId: `laptop:${PI}`, tape: "t" } })!;
    const eve = aeSessionKey({ email: "eve@example.com", via: "token", operator: false, laptop: { sessionId: `laptop:${PI}`, tape: "t" } })!;
    assert.notEqual(aeSessionId(ada, "r"), aeSessionId(eve, "r"));
    // A Drive session whose short id is the pi id's tail doesn't collide either.
    assert.notEqual(aeSessionId(ada, "r"), aeSessionId("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "r"));
    assert.equal(aeSessionId("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "r"), "outf-2e3f4a5b-r", "a Drive's id is unchanged");
  });

  test("a laptop message the card can't show in full is refused before asking", async () => {
    const a = await aeApps();
    assert.match((await a.call("ae.invoke", { agent: "researcher", message: "x".repeat(5_001) })).error!, /limited to 5000 characters/);
    assert.equal((await a.widget()).length, 0);
    await a.close();
  });

  test("ae.close still works after the tape lost Agent Engine; get counts as use", async () => {
    const a = await aeApps();
    a.fake.invokeScripts.push({ frames: [{ chunk_type: "done", execution_id: "exec-c" }] });
    const args = { agent: "researcher", message: "go" };
    const asked = await a.call("ae.invoke", args);
    await a.decide(asked.approvalId!, true);
    await a.call("ae.invoke", args, { approvalId: asked.approvalId });
    const key = `laptop:${memoryUserHash(OWNER)}:${PI}`;
    const before = (await a.store.aeSessions.listOpenForSession(key))[0].lastUsedAt;
    await new Promise((r) => setTimeout(r, 5));
    a.fake.executions.set("exec-c", { execution_id: "exec-c", status: "running" });
    await a.call("ae.get", { executionId: "exec-c" });
    assert.ok((await a.store.aeSessions.listOpenForSession(key))[0].lastUsedAt > before, "lastUsedAt moved");
    await a.store.gurus.update("foreman", { agentEngine: false });
    assert.match((await a.call("ae.list", {})).error!, /doesn't have it/);
    assert.equal((await a.call("ae.close", {})).ok, true);
    await a.close();
  });

  test("control characters in a tape's text are refused; package credentials never reach a laptop", async () => {
    const store = new MemoryStore();
    const human = { kind: "human" as const, operator: false };
    for (const bad of [{ systemPrompt: "ok\u0000--extension\u0000/x" }, { tools: ["read\u001b[8m"] }, { name: "a\u202eb" }]) {
      const r = await createGuru(store, { name: "T", model: "litellm/x", ...bad } as never, human);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.match((r as { error: string }).error, /control characters/);
    }
    assert.equal((await createGuru(store, { name: "T", model: "litellm/x", systemPrompt: "line 1\n\tline 2" } as never, human)).ok, true);
    await seedGuru(store, { id: "pk", packages: ["npm:pi-foo", "git+https://x-access-token:ghp_secret123@github.com/a/b"] });
    const app = await linkApp(store);
    const got = await op(app, "tapes.get", { id: "pk", format: "json" });
    assert.ok(!got.text!.includes("ghp_secret123"));
    assert.deepEqual(JSON.parse(got.text!).packages, ["npm:pi-foo", "git+https://***@github.com/a/b"]);
    await app.fastify.close();
  });
});
