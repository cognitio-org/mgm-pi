// E9.9: owner-scoped web approvals for a laptop's shared memory saves (admin/laptop-approvals.ts):
// create -> poll approvals.get -> rerun with approvalId; the widget's list and answer routes; and
// every way around it (the agent's own `confirmed`, a Dongle deciding, replay, digest, owner and
// origin mismatch, expiry).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./helpers.ts";
import { FakeAgentEngine } from "./fake-agent-engine.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { hashToken } from "../src/tokens.ts";
import { createAgentEngine } from "../src/agentengine/index.ts";
import { registerAdminOp } from "../src/admin/ops.ts";
import {
  argsDigest,
  canonicalJson,
  consumeLaptopApproval,
  createLaptopApproval,
  decideLaptopApproval,
  LAPTOP_APPROVAL_TTL_MS,
  MAX_PENDING_PER_OWNER,
} from "../src/admin/laptop-approvals.ts";

// Dev mode's web identity is dev@localhost, so that is the owner whose widget the web app shows.
const OWNER = "dev@localhost";
const OTHER = "eve@example.com";
const OWNER_TOKEN = "outf_laptop-approvals-owner";
const OTHER_TOKEN = "outf_laptop-approvals-other";
const SID = "laptop:0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const LAPTOP = { sessionId: SID, repo: "acme/widgets" };
const SHARED = { type: "semantic", text: "deploys go through tag-release.sh", label: "deploy", shared: true };

type Reply = { ok: boolean; text?: string; error?: string; needsApproval?: boolean; approvalId?: string; state?: string };

async function apps(): Promise<{ link: TestApp; web: TestApp; webIap: TestApp; fake: FakeAgentEngine; store: MemoryStore; close: () => Promise<void> }> {
  const fake = new FakeAgentEngine();
  const agentEngine = createAgentEngine(fake.config(["memory"]), { fetch: fake.fetch });
  const store = new MemoryStore();
  for (const [id, email, token] of [["tok-owner", OWNER, OWNER_TOKEN], ["tok-other", OTHER, OTHER_TOKEN]] as const) {
    await store.tokens.insert({ id, ownerEmail: email, name: "laptop", prefix: token.slice(0, 8), hash: hashToken(token), createdAt: new Date().toISOString() });
  }
  const link = await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_DEV: "0" }, { store, agentEngine });
  // The web role as a person (dev mode stands in for IAP) and as a non-dev web role, where a
  // Dongle presented as a bearer token is a token identity.
  const web = await buildTestApp({ OUTFITTER_ROLE: "web" }, { store, agentEngine });
  const webIap = await buildTestApp({ OUTFITTER_ROLE: "web", OUTFITTER_DEV: "0", IAP_AUDIENCE: "/projects/1/global/backendServices/2" }, { store, agentEngine });
  return {
    link,
    web,
    webIap,
    fake,
    store,
    close: async () => {
      await link.fastify.close();
      await web.fastify.close();
      await webIap.fastify.close();
    },
  };
}

async function op(a: TestApp, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}, token = OWNER_TOKEN): Promise<Reply> {
  const res = await a.fastify.inject({ method: "POST", url: "/api/admin/ops", headers: { authorization: `Bearer ${token}` }, payload: { op: name, args, laptop: LAPTOP, ...extra } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Reply;
}

async function decide(a: TestApp, id: string, approve: boolean, headers: Record<string, string> = {}) {
  return a.fastify.inject({ method: "POST", url: `/api/laptop-approvals/${id}`, headers, payload: { approve } });
}

describe("laptop approvals: the digest", () => {
  test("canonical JSON sorts keys at every level and drops undefined", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
    assert.equal(argsDigest("memory.save", { a: 1, b: 2 }), argsDigest("memory.save", { b: 2, a: 1 }));
    assert.notEqual(argsDigest("memory.save", { a: 1 }), argsDigest("memory.save", { a: "1" }));
    assert.notEqual(argsDigest("memory.save", { a: 1 }), argsDigest("memory.search", { a: 1 }));
  });
});

describe("laptop approvals: create -> approve -> poll -> run once", () => {
  test("the whole flow, audited, single use", async () => {
    const { link, web, fake, store, close } = await apps();
    const asked = await op(link, "memory.save", SHARED);
    assert.equal(asked.needsApproval, true);
    assert.match(asked.error!, /Outfitter web app/);
    const id = asked.approvalId!;

    // The widget lists it, with the exact text and where it came from.
    const list = await web.fastify.inject({ method: "GET", url: "/api/laptop-approvals" });
    assert.equal(list.statusCode, 200);
    const [card] = list.json().approvals;
    assert.equal(card.id, id);
    assert.equal(card.title, "Share a memory with the team");
    assert.match(card.summary, /Type: semantic/);
    assert.match(card.summary, /Label: deploy/);
    assert.match(card.summary, /deploys go through tag-release\.sh/);
    assert.deepEqual(card.origin, { laptopSessionId: SID, repo: "acme/widgets" });
    assert.equal(Date.parse(card.expiresAt) - Date.parse(card.createdAt), LAPTOP_APPROVAL_TTL_MS);
    assert.equal(card.ownerEmail, undefined, "the view carries no owner or digest");
    assert.equal(card.argsDigest, undefined);

    assert.deepEqual(await op(link, "approvals.get", { id }), { ok: true, text: `approval ${id}: pending`, state: "pending" });
    const early = await op(link, "memory.save", SHARED, { approvalId: id });
    assert.match(early.error!, /not approved yet/);

    const yes = await decide(web, id, true);
    assert.equal(yes.statusCode, 200, yes.body);
    assert.deepEqual(yes.json(), { ok: true, state: "approved" });
    assert.equal((await web.fastify.inject({ method: "GET", url: "/api/laptop-approvals" })).json().approvals.length, 0, "answered ones leave the widget");
    assert.equal((await op(link, "approvals.get", { id })).state, "approved");

    const ran = await op(link, "memory.save", SHARED, { approvalId: id });
    assert.deepEqual(ran, { ok: true, text: 'saved semantic memory "deploy" (shared)' });
    assert.equal(fake.semantic.length, 1);
    assert.equal(fake.semantic[0].visibility, "org");
    assert.equal((await op(link, "approvals.get", { id })).state, "used");

    const replay = await op(link, "memory.save", SHARED, { approvalId: id });
    assert.match(replay.error!, /already used/);
    assert.equal(fake.semantic.length, 1, "a replay runs nothing");

    const rows = await store.adminAudit.listRecent(10);
    const decided = rows.find((r) => r.op === "approvals.approve")!;
    assert.deepEqual([decided.via, decided.actor, decided.target, decided.sessionId, decided.approved], ["web", OWNER, id, SID, true]);
    const saved = rows.find((r) => r.op === "memory.save" && r.ok)!;
    assert.deepEqual([saved.via, saved.approved, saved.approvalId], ["token", true, id]);
    await close();
  });

  test("deny: the rerun is refused and nothing is saved", async () => {
    const { link, web, fake, store, close } = await apps();
    const id = (await op(link, "memory.save", SHARED)).approvalId!;
    assert.equal((await decide(web, id, false)).statusCode, 200);
    assert.equal((await op(link, "approvals.get", { id })).state, "denied");
    assert.match((await op(link, "memory.save", SHARED, { approvalId: id })).error!, /denied/);
    assert.equal((await decide(web, id, true)).statusCode, 409, "a decision is final");
    assert.equal(fake.semantic.length, 0);
    assert.ok((await store.adminAudit.listRecent(10)).some((r) => r.op === "approvals.deny"));
    await close();
  });

  test("expiry: unanswered or unused past 10 minutes reads expired and can't be decided or used", async () => {
    const store = new MemoryStore();
    const t0 = Date.parse("2026-10-01T12:00:00.000Z");
    const ask = { ownerEmail: OWNER, op: "memory.save", args: SHARED, laptop: LAPTOP, title: "t", summary: "s" };
    const a = await createLaptopApproval(store, { ...ask, now: t0 });
    assert.ok(a.ok);
    const late = t0 + LAPTOP_APPROVAL_TTL_MS;
    assert.deepEqual(await decideLaptopApproval(store, a.approval.id, { email: OWNER }, true, late), { ok: false, status: 409, error: "that approval is no longer pending" });
    const b = await createLaptopApproval(store, { ...ask, now: late });
    assert.ok(b.ok);
    assert.notEqual(b.approval.id, a.approval.id, "an expired ask isn't reused");
    assert.equal((await decideLaptopApproval(store, b.approval.id, { email: OWNER }, true, late + 1000)).ok, true);
    const used = await consumeLaptopApproval(store, { ...ask, approvalId: b.approval.id, now: late + LAPTOP_APPROVAL_TTL_MS });
    assert.deepEqual(used, { ok: false, error: "that approval expired; ask again", state: "expired" });
  });

  test("a different op, args or laptop origin can't use the yes (and doesn't burn it)", async () => {
    const { link, web, fake, close } = await apps();
    const id = (await op(link, "memory.save", SHARED)).approvalId!;
    await decide(web, id, true);
    const swapped = await op(link, "memory.save", { ...SHARED, text: "rm -rf is the deploy step" }, { approvalId: id });
    assert.match(swapped.error!, /different request/);
    const taxonomic = await op(link, "memory.save", { type: "taxonomic", text: "x", label: "a:b", shared: true }, { approvalId: id });
    assert.match(taxonomic.error!, /different request/);
    const otherSession = await op(link, "memory.save", SHARED, { approvalId: id, laptop: { sessionId: "laptop:another-session-id", repo: "acme/widgets" } });
    assert.match(otherSession.error!, /different request/);
    const otherRepo = await op(link, "memory.save", SHARED, { approvalId: id, laptop: { sessionId: SID, repo: "acme/other" } });
    assert.match(otherRepo.error!, /different request/);
    const noRepo = await op(link, "memory.save", SHARED, { approvalId: id, laptop: { sessionId: SID } });
    assert.match(noRepo.error!, /different request/);
    assert.equal(fake.semantic.length, 0);
    assert.equal((await op(link, "memory.save", SHARED, { approvalId: id })).ok, true, "the real rerun still works");
    await close();
  });

  test("a bad approvalId is refused, and it never makes a private save need anything", async () => {
    const { link, close } = await apps();
    for (const bad of ["x", 7, null, "../../etc", { $ne: null }]) {
      const r = await op(link, "memory.save", SHARED, { approvalId: bad });
      assert.equal(r.ok, false);
      assert.equal(r.needsApproval, undefined, JSON.stringify(bad));
    }
    assert.equal((await op(link, "memory.save", { type: "semantic", text: "mine", label: "p" }, { approvalId: "x" })).ok, true);
    await close();
  });
});

describe("laptop approvals: who may see and answer", () => {
  test("another owner can neither poll, use, list nor decide it", async () => {
    const { link, web, store, close } = await apps();
    const id = (await op(link, "memory.save", SHARED)).approvalId!;
    assert.deepEqual(await op(link, "approvals.get", { id }, {}, OTHER_TOKEN), { ok: false, error: "no such approval" });
    // Approved by the owner, then Eve tries to ride on it with her own Dongle.
    await decide(web, id, true);
    assert.deepEqual(await op(link, "memory.save", SHARED, { approvalId: id }, OTHER_TOKEN), { ok: false, error: "no such approval" });
    // Eve's own ask doesn't show in the owner's widget, and the owner can't answer it.
    const eves = (await op(link, "memory.save", SHARED, {}, OTHER_TOKEN)).approvalId!;
    const list = (await web.fastify.inject({ method: "GET", url: "/api/laptop-approvals" })).json().approvals;
    assert.ok(!list.some((c: { id: string }) => c.id === eves));
    assert.equal((await decide(web, eves, true)).statusCode, 404);
    assert.equal((await store.laptopApprovals.get(eves))!.state, "pending");
    await close();
  });

  test("a Dongle can't list or decide, on any role: the laptop's agent can't approve itself", async () => {
    const { link, web, webIap, store, close } = await apps();
    const id = (await op(link, "memory.save", SHARED)).approvalId!;
    const auth = { authorization: `Bearer ${OWNER_TOKEN}` };
    // The web role, not in dev mode: a bearer Dongle is a token identity.
    assert.equal((await webIap.fastify.inject({ method: "GET", url: "/api/laptop-approvals", headers: auth })).statusCode, 403);
    assert.equal((await decide(webIap, id, true, auth)).statusCode, 403);
    // The link role has no such routes at all.
    assert.equal((await decide(link, id, true, auth)).statusCode, 404);
    assert.equal((await link.fastify.inject({ method: "GET", url: "/api/laptop-approvals", headers: auth })).statusCode, 404);
    // And no op answers it: there is no approve op a Dongle could call.
    assert.match((await op(link, "approvals.decide", { id, approve: true })).error!, /unknown op/);
    assert.equal((await store.laptopApprovals.get(id))!.state, "pending");
    // decideLaptopApproval itself refuses a token identity, whatever the route.
    assert.equal((await decideLaptopApproval(store, id, { email: OWNER, viaToken: true }, true)).ok, false);
    assert.equal((await web.fastify.inject({ method: "POST", url: `/api/laptop-approvals/${id}`, payload: { approve: "yes" } })).statusCode, 400);
    await close();
  });

  test("a Drive can't poll laptop approvals", async () => {
    const store = new MemoryStore();
    const { runAdminOp } = await import("../src/admin/ops.ts");
    const r = await runAdminOp({ store, models: { list: async () => [] } }, { email: OWNER, via: "drive", operator: false, capabilities: ["admin"] }, "approvals.get", { id: "x" });
    assert.match((r as { error: string }).error, /for a laptop/);
  });

  test("at most ten pending per owner; the same ask reuses its approval", async () => {
    const store = new MemoryStore();
    const base = { ownerEmail: OWNER, op: "memory.save", laptop: LAPTOP, title: "t", summary: "s" };
    const first = await createLaptopApproval(store, { ...base, args: { n: 0 } });
    const again = await createLaptopApproval(store, { ...base, args: { n: 0 } });
    assert.ok(first.ok && again.ok);
    assert.equal(again.approval.id, first.approval.id);
    for (let n = 1; n < MAX_PENDING_PER_OWNER; n++) assert.equal((await createLaptopApproval(store, { ...base, args: { n } })).ok, true);
    const full = await createLaptopApproval(store, { ...base, args: { n: 99 } });
    assert.equal(full.ok, false);
    assert.equal((await createLaptopApproval(store, { ...base, ownerEmail: OTHER, args: { n: 99 } })).ok, true, "per owner");
  });

  test("the card text loses control characters and bidi overrides, and is capped", async () => {
    const store = new MemoryStore();
    const r = await createLaptopApproval(store, {
      ownerEmail: OWNER,
      op: "memory.save",
      args: {},
      laptop: LAPTOP,
      title: "Share\u001b[2J a memory",
      summary: `safe\u202etxt.exe\u0007\r\nnext line ${"x".repeat(10_000)}`,
    });
    assert.ok(r.ok);
    assert.doesNotMatch(r.approval.title, /\u001b/);
    assert.doesNotMatch(r.approval.summary, /[\u202e\u0007\r]/);
    assert.match(r.approval.summary, /\nnext line/);
    assert.ok(r.approval.summary.length <= 6_000);
  });
});

describe("laptop approvals: registration", () => {
  test("webApproval needs laptop; with it, a non-memory or approve op may be laptop-callable", () => {
    const run = async () => ({ ok: true as const, text: "" });
    assert.throws(() => registerAdminOp("wtest.write", { kind: "write", capability: "memory", webApproval: true, run }), /webApproval is for laptop-callable/);
    const off = registerAdminOp("wtest.invoke", { kind: "write", capability: "agentEngine", laptop: true, webApproval: true, run });
    off();
    const off2 = registerAdminOp("wtest.resume", { kind: "approve", capability: "agentEngine", laptop: true, webApproval: true, card: () => ({ title: "t", message: "m" }), run });
    off2();
    assert.throws(() => registerAdminOp("wtest.resume", { kind: "approve", capability: "agentEngine", laptop: true, card: () => ({ title: "t", message: "m" }), run }), /approve op/);
  });

  test("a generic webApproval op: a Dongle's `confirmed` never runs it; the web yes does, once", async () => {
    const { link, web, close } = await apps();
    let runs = 0;
    const off = registerAdminOp("wtest.fire", {
      kind: "write",
      capability: "agentEngine",
      laptop: true,
      webApproval: true,
      asks: async () => true,
      async run(_ctx, caller) {
        runs += 1;
        return { ok: true, text: `ran approved=${caller.approved}` };
      },
    });
    try {
      const asked = await op(link, "wtest.fire", { target: "x" }, { confirmed: true });
      assert.equal(asked.needsApproval, true);
      assert.equal(runs, 0);
      const card = (await web.fastify.inject({ method: "GET", url: "/api/laptop-approvals" })).json().approvals[0];
      assert.equal(card.title, "Allow wtest.fire from your laptop?");
      assert.equal(card.summary, '{"target":"x"}');
      await decide(web, asked.approvalId!, true);
      assert.deepEqual(await op(link, "wtest.fire", { target: "x" }, { approvalId: asked.approvalId }), { ok: true, text: "ran approved=true" });
      assert.equal(runs, 1);
    } finally {
      off();
      await close();
    }
  });
});
