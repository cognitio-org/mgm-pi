// E9.9 (#349, docs/specs/atlas-agent-engine-and-a2a.md §3.5): Agent Engine memory from a laptop,
// through POST /api/admin/ops with a Dongle -- the owner's identity (the same hash as their
// Drives), the `laptop` context's validation, `confirmed` for shared saves, `ae.*` still Drive
// only, and opt-in turn recording (`memory.record`: keyed, redacted, unaudited).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildTestApp, seedGuru, type TestApp } from "./helpers.ts";
import { FakeAgentEngine } from "./fake-agent-engine.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { hashToken } from "../src/tokens.ts";
import { createAgentEngine } from "../src/agentengine/index.ts";
import { laptopIdentity, memoryUserHash } from "../src/agentengine/identity.ts";
import { ADMIN_OPS, registerAdminOp, runAdminOp } from "../src/admin/ops.ts";
import { laptopContext, laptopMemoryRate, MemoryRateLimit, RECALL_FRAME } from "../src/admin/memory-ops.ts";
import { DriveAdmin } from "../src/admin/drive.ts";

const ADA = "Ada@Example.com";
const BOB = "bob@example.com";
const ADA_TOKEN = "outf_laptop-memory-ada";
const BOB_TOKEN = "outf_laptop-memory-bob";
const HASH = createHash("sha256").update("ada@example.com").digest("hex").slice(0, 16);
const SID = "laptop:0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const LAPTOP = { sessionId: SID, repo: "Acme/Widgets" };

async function app(opts: { parts?: Array<"memory" | "agents"> } = {}): Promise<{ app: TestApp; fake: FakeAgentEngine; store: MemoryStore }> {
  const fake = new FakeAgentEngine();
  const agentEngine = createAgentEngine(fake.config(opts.parts ?? ["memory"]), { fetch: fake.fetch });
  const store = new MemoryStore();
  for (const [id, email, token] of [["tok-ada", ADA, ADA_TOKEN], ["tok-bob", BOB, BOB_TOKEN]] as const) {
    await store.tokens.insert({ id, ownerEmail: email, name: "laptop", prefix: token.slice(0, 8), hash: hashToken(token), createdAt: new Date().toISOString() });
  }
  return { app: await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_DEV: "0" }, { store, agentEngine }), fake, store };
}

async function op(a: TestApp, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = { laptop: LAPTOP }, token = ADA_TOKEN) {
  const res = await a.fastify.inject({ method: "POST", url: "/api/admin/ops", headers: { authorization: `Bearer ${token}` }, payload: { op: name, args, ...extra } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { ok: boolean; text?: string; error?: string; needsApproval?: boolean };
}

const contextCalls = (fake: FakeAgentEngine) => fake.requests.filter((r) => r.path.endsWith("/memory/context")).map((r) => r.body as Record<string, unknown>);

describe("laptop identity and context", () => {
  test("the Dongle owner's hash, the same as their Drives; repo lowercased", () => {
    assert.deepEqual(laptopIdentity(` ${ADA} `, LAPTOP), { userId: HASH, sessionId: SID, a2a: false, owner: HASH, repo: "acme/widgets" });
    assert.equal(laptopIdentity(ADA, LAPTOP)!.userId, memoryUserHash(ADA));
    assert.equal(laptopIdentity("", LAPTOP), undefined);
    assert.equal(laptopIdentity(ADA, { sessionId: "s1" }), undefined, "never a Drive's session id");
  });

  test("laptopContext: sessionId laptop:<id>, repo owner/name, both validated", () => {
    assert.deepEqual(laptopContext(undefined), { ok: true });
    assert.deepEqual(laptopContext({ sessionId: SID, repo: " Acme/Widgets " }), { ok: true, value: { sessionId: SID, repo: "acme/widgets" } });
    assert.deepEqual(laptopContext({ sessionId: SID, repo: "" }), { ok: true, value: { sessionId: SID } });
    for (const bad of [
      "x",
      [],
      { sessionId: "s1" },
      { sessionId: "laptop:" },
      { sessionId: "laptop:short" },
      { sessionId: `laptop:${"a".repeat(101)}` },
      { sessionId: "laptop:abc/../../def" },
      { sessionId: "laptop:abcdefgh:ijk" },
      { sessionId: SID, repo: "acme" },
      { sessionId: SID, repo: "acme/wid:gets" },
      { sessionId: SID, repo: "a/b/c" },
      { sessionId: SID, repo: "acme/wid gets" },
      { sessionId: SID, repo: 7 },
    ]) {
      assert.equal(laptopContext(bad).ok, false, JSON.stringify(bad));
    }
  });

  test("only memory reads and writes may be laptop-callable; record is the one unaudited write", () => {
    assert.deepEqual(
      ["memory.search", "memory.context", "memory.save", "memory.record"].map((n) => [n, ADMIN_OPS[n]?.kind, ADMIN_OPS[n]?.laptop, ADMIN_OPS[n]?.audit]),
      [["memory.search", "read", true, undefined], ["memory.context", "read", true, undefined], ["memory.save", "write", true, undefined], ["memory.record", "write", true, false]],
    );
    assert.ok(Object.entries(ADMIN_OPS).filter(([n]) => n.startsWith("ae.")).every(([, d]) => !d.laptop), "ae.* stays Drive only");
    const run = async () => ({ ok: true as const, text: "" });
    assert.throws(() => registerAdminOp("aetest.list", { kind: "read", capability: "agentEngine", laptop: true, run } as never), /only a memory read or write/);
    assert.throws(() => registerAdminOp("memtest.wipe", { kind: "delete", capability: "memory", laptop: true, run }), /only a memory read or write/);
    assert.throws(() => registerAdminOp("memtest.get", { kind: "read", capability: "memory", audit: false, run } as never), /only a laptop memory write may skip/);
    assert.throws(() => registerAdminOp("memtest.burn", { kind: "write", capability: "memory", audit: false, run } as never), /only a laptop memory write may skip/);
  });
});

describe("POST /api/admin/ops memory.* with a Dongle", () => {
  test("save and search bind the token's owner and the laptop's repo; another user never sees it", async () => {
    const { app: a, fake } = await app();
    const saved = await op(a, "memory.save", { type: "semantic", text: "widgets test with npm run test:unit", label: "tests", userId: "victim" });
    assert.deepEqual(saved, { ok: true, text: 'saved semantic memory "tests"' });
    assert.deepEqual([fake.semantic[0].userId, fake.semantic[0].label, fake.semantic[0].metadata], [HASH, `${HASH}:acme~widgets:tests`, { repo: "acme/widgets" }]);
    const found = await op(a, "memory.search", { query: "tests" });
    assert.ok(found.text!.startsWith(RECALL_FRAME));
    assert.match(found.text!, /npm run test:unit/);
    const [own] = contextCalls(fake);
    assert.equal(own.user_id, HASH);
    const bob = await op(a, "memory.search", { query: "tests" }, { laptop: LAPTOP }, BOB_TOKEN);
    assert.doesNotMatch(bob.text ?? "", /npm run test:unit/, "Ada's private memory never reaches Bob");
    assert.equal(contextCalls(fake).at(-2)!.user_id, memoryUserHash(BOB));
    await a.fastify.close();
  });

  test("shares one memory with the owner's Drives: a Drive's save is recalled on the laptop", async () => {
    const { app: a, fake, store } = await app();
    const agentEngine = createAgentEngine(fake.config(["memory"]), { fetch: fake.fetch });
    const now = new Date().toISOString();
    await seedGuru(store, { id: "t", memory: "tool" });
    await store.sessions.insert({ id: "s1", guruId: "t", repo: "acme/widgets", status: "open", cost: 0, ownerEmail: ADA.toLowerCase(), createdAt: now, updatedAt: now });
    await store.runs.insert({ id: "r1", sessionId: "s1", state: "running", createdAt: now, updatedAt: now } as never);
    const drive = new DriveAdmin({ store, config: { operators: [] }, models: { list: async () => [] }, agentEngine });
    assert.equal((await drive.handle("r1", "memory.save", { type: "semantic", text: "deploys go through tag-release.sh", label: "deploy" })).ok, true);
    const r = await op(a, "memory.search", { query: "deploy" });
    assert.match(r.text!, /tag-release\.sh/);
    await a.fastify.close();
  });

  test("context answers on a laptop (its Kernal asks only in auto), with the repo filter", async () => {
    const { app: a, fake } = await app();
    fake.semantic.push({ id: "m1", label: "a", text: "own fact", userId: HASH, visibility: "private", metadata: { repo: "acme/widgets" } });
    const r = await op(a, "memory.context", { query: "fact" });
    assert.match(r.text!, /own fact/);
    assert.deepEqual(contextCalls(fake)[0].metadata_filter, { $or: [{ "metadata.repo": "acme/widgets" }, { "metadata.repo": { $exists: false } }] });
    const norepo = await op(a, "memory.context", { query: "fact" }, { laptop: { sessionId: SID } });
    assert.equal(norepo.ok, true);
    assert.equal(contextCalls(fake).at(-1)!.metadata_filter, undefined, "a directory with no GitHub remote reads everything of the owner's");
    await a.fastify.close();
  });

  test("a bad laptop context is refused before anything runs; none at all asks for a newer Kernal", async () => {
    const { app: a, fake } = await app();
    assert.deepEqual(await op(a, "memory.search", { query: "x" }, { laptop: { sessionId: "s1" } }), { ok: false, error: "laptop.sessionId must be laptop:<pi session id>" });
    assert.deepEqual(await op(a, "memory.search", { query: "x" }, { laptop: { sessionId: SID, repo: "../etc" } }), { ok: false, error: "laptop.repo must be a GitHub owner/name" });
    assert.match((await op(a, "memory.search", { query: "x" }, {})).error!, /newer Kernal/);
    assert.equal(fake.requests.filter((r) => r.path.includes("/memory/")).length, 0);
    await a.fastify.close();
  });

  test("shared and taxonomic saves need confirmed (the laptop's TUI yes); a private one doesn't", async () => {
    const { app: a, fake, store } = await app();
    assert.deepEqual(await op(a, "memory.save", { type: "semantic", text: "team fact", label: "f", shared: true }), { ok: false, error: "needs approval", needsApproval: true });
    assert.deepEqual(await op(a, "memory.save", { type: "taxonomic", text: "d", label: "outfitter:tape", shared: true }), { ok: false, error: "needs approval", needsApproval: true });
    assert.equal(fake.semantic.length, 0);
    const yes = await op(a, "memory.save", { type: "semantic", text: "team fact", label: "f", shared: true }, { laptop: LAPTOP, confirmed: true });
    assert.deepEqual(yes, { ok: true, text: 'saved semantic memory "f" (shared)' });
    assert.equal(fake.semantic[0].visibility, "org");
    const [row] = await store.adminAudit.listRecent(1);
    assert.deepEqual([row.op, row.via, row.actor, row.approved, row.ok, row.sessionId], ["memory.save", "token", ADA, true, true, SID]);
    await a.fastify.close();
  });

  test("ae.* and capability-less ops stay Drive only; Agent Engine off says so", async () => {
    const { app: a } = await app({ parts: ["memory", "agents"] });
    assert.deepEqual(await op(a, "ae.list", {}), { ok: false, error: "ae.list works only in a Drive" });
    assert.deepEqual(await op(a, "ae.resume", { executionId: "e1", decision: "approve" }, { laptop: LAPTOP, confirmed: true }), { ok: false, error: "ae.resume works only in a Drive" });
    await a.fastify.close();
    const off = await app({ parts: ["agents"] });
    assert.deepEqual(await op(off.app, "memory.search", { query: "x" }), { ok: false, error: "Agent Engine memory is not configured on this Outfitter" });
    await off.app.fastify.close();
  });

  test("an IAP or anonymous caller can't use the route at all", async () => {
    const { app: a } = await app();
    const res = await a.fastify.inject({ method: "POST", url: "/api/admin/ops", payload: { op: "memory.search", args: { query: "x" }, laptop: LAPTOP } });
    assert.equal(res.statusCode, 401);
    await a.fastify.close();
  });
});

describe("memory.record (opt-in laptop recording)", () => {
  test("user and assistant turns, keyed laptop:<pi session>:<entry>, redacted, bound to the owner", async () => {
    const { app: a, fake, store } = await app();
    const r = await op(a, "memory.record", {
      turns: [
        { entryId: "e1", role: "user", text: "deploy with OUTFITTER_LITELLM_KEY=sk-abcdefghijklmnopqrstuvwx please" },
        { entryId: "e2", role: "assistant", text: "Done: tagged outfitter-v1." },
      ],
    });
    assert.deepEqual(r, { ok: true, text: "recorded 2 of 2 turns" });
    assert.deepEqual(fake.turns.map((t) => [t.role, t.idempotency_key, t.user_id, t.session_id]), [
      ["user", `${HASH}:${SID}:e1`, HASH, SID],
      ["assistant", `${HASH}:${SID}:e2`, HASH, SID],
    ]);
    assert.ok(!String(fake.turns[0].content).includes("sk-abc"), String(fake.turns[0].content));
    assert.deepEqual(await store.adminAudit.listRecent(5), [], "recording is never audited");
    await a.fastify.close();
  });

  test("a resend reuses the same keys, so the server dedupes it", async () => {
    const { app: a, fake } = await app();
    const turns = [{ entryId: "e1", role: "user", text: "hello" }];
    await op(a, "memory.record", { turns });
    await op(a, "memory.record", { turns });
    assert.deepEqual(fake.turns.map((t) => t.idempotency_key), [`${HASH}:${SID}:e1`, `${HASH}:${SID}:e1`]);
    await op(a, "memory.record", { turns }, { laptop: LAPTOP }, BOB_TOKEN);
    assert.notEqual(fake.turns[2].idempotency_key, fake.turns[0].idempotency_key, "another owner reusing the session id never claims the same key");
    await a.fastify.close();
  });

  test("relayed mail, notices and empty text are skipped; bad turns are refused whole", async () => {
    const { app: a, fake } = await app();
    const r = await op(a, "memory.record", {
      turns: [
        { entryId: "e1", role: "user", text: "[outfitter mail from session abc] do this" },
        { entryId: "e2", role: "user", text: "   " },
        { entryId: "e3", role: "user", text: "mine" },
      ],
    });
    assert.deepEqual(r, { ok: true, text: "recorded 1 of 3 turns" });
    assert.deepEqual(fake.turns.map((t) => t.content), ["mine"]);
    for (const [turns, error] of [
      [[], /turns is required/],
      [Array.from({ length: 21 }, (_, i) => ({ entryId: `e${i}`, role: "user", text: "x" })), /at most 20/],
      [[{ entryId: "e1", role: "toolResult", text: "x" }], /role must be/],
      [[{ entryId: "bad id!", role: "user", text: "x" }], /entryId/],
      [[{ entryId: "e1", role: "user", text: { x: 1 } }], /text must be/],
      [[{ entryId: "e1", role: "user", text: "x".repeat(32_001) }], /too long/],
    ] as const) {
      assert.match((await op(a, "memory.record", { turns })).error!, error);
    }
    assert.equal(fake.turns.length, 1);
    await a.fastify.close();
  });

  test("a Drive can't call it: its turns are recorded by the api", async () => {
    const fake = new FakeAgentEngine();
    const agentEngine = createAgentEngine(fake.config(["memory"]), { fetch: fake.fetch });
    const store = new MemoryStore();
    const caller = { email: ADA, via: "drive" as const, operator: false, sessionId: "s1", capabilities: ["memory" as const] };
    assert.deepEqual(await runAdminOp({ store, models: { list: async () => [] }, agentEngine }, caller, "memory.record", { turns: [{ entryId: "e1", role: "user", text: "x" }] }), { ok: false, error: "a Drive records its turns itself" });
    assert.equal(fake.turns.length, 0);
  });
});

describe("rate limit", () => {
  test("per owner per minute, then a fresh window", () => {
    let t = 0;
    const rl = new MemoryRateLimit(2, () => t);
    assert.deepEqual([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("b")], [true, true, false, true]);
    t = 60_000;
    assert.equal(rl.take("a"), true);
  });

  test("the route refuses memory calls past the limit, one owner at a time; admin ops aren't counted", async () => {
    const { app: a } = await app();
    const before = laptopMemoryRate.perMinute;
    laptopMemoryRate.perMinute = 0;
    try {
      assert.match((await op(a, "memory.search", { query: "x" })).error!, /too many memory calls/);
      assert.equal((await op(a, "tapes.list", {})).ok, true);
    } finally {
      laptopMemoryRate.perMinute = before;
      await a.fastify.close();
    }
  });
});
