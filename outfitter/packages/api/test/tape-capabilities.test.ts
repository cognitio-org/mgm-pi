// E9 PR2 (#308, docs/specs/atlas-agent-engine-and-a2a.md §3.3, §4): the tape fields `memory` and
// `agentEngine` (web UI only, like adminTools), carried in run.spec; op capability gating (an op
// names the tape capability it needs and a Drive without it is refused); and the `approve` class,
// which always waits for the owner.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedGuru } from "./helpers.ts";
import { openAgentSocket, runTokenFor, sendHello } from "./agent-socket.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { DriveAdmin, approvalText } from "../src/admin/drive.ts";
import { decideApproval } from "../src/admin/approvals.ts";
import { ADMIN_OPS, approvalNeeded, registerAdminOp, runAdminOp, type AdminCaller, type AdminOp } from "../src/admin/ops.ts";
import { createGuru, tapeCapabilities, updateGuru } from "../src/gurus-service.ts";
import type { Guru, Session } from "../src/store/types.ts";

const models = { list: async () => [] };
const OWNER = "ada@example.com";

// Test-only ops standing in for PR3/PR4's memory.* and ae.* (removed again after this file).
const calls: string[] = [];
const testOps: Record<string, AdminOp> = {
  "memtest.context": {
    kind: "read",
    capability: "memory",
    async run(ctx, caller) {
      calls.push(`memtest.context:${caller.email}:${ctx.agentEngine?.memory ? "client" : "no client"}`);
      return { ok: true, text: "recalled" };
    },
  },
  "aetest.resume": {
    kind: "approve",
    capability: "agentEngine",
    async run(_ctx, caller) {
      calls.push(`aetest.resume:${caller.approved === true}`);
      return { ok: true, text: "resumed" };
    },
  },
  "aetest.carded": {
    kind: "approve",
    capability: "agentEngine",
    card: () => ({ title: "Answer review for agent X?", message: "[from Agent Engine agent x] needs a decision" }),
    async run() {
      return { ok: true, text: "ok" };
    },
  },
};
const unregister = Object.entries(testOps).map(([name, op]) => registerAdminOp(name, op));
after(() => unregister.forEach((u) => u()));

async function drive(tape: Partial<Guru>, approval = { pollMs: 5, timeoutMs: 2_000 }) {
  const store = new MemoryStore();
  const now = new Date().toISOString();
  await seedGuru(store, { id: "t", ...tape });
  await store.sessions.insert({ id: "s1", guruId: "t", repo: null, status: "open", cost: 0, ownerEmail: OWNER, createdAt: now, updatedAt: now });
  await store.runs.insert({ id: "r1", sessionId: "s1", state: "running", createdAt: now, updatedAt: now } as never);
  const admin = new DriveAdmin({ store, config: { operators: [] }, models, approval });
  return { store, admin };
}

async function pending(store: MemoryStore) {
  for (let i = 0; i < 400; i++) {
    const held = await store.adminApprovals.get("r1");
    if (held && !held.decision) return held;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no approval was requested");
}

describe("tape fields memory and agentEngine", () => {
  test("an agent can never set or change them; repeating the current value passes", async () => {
    const store = new MemoryStore();
    const agent = { kind: "agent" } as const;
    assert.deepEqual(await createGuru(store, { name: "x", model: "a/b", memory: "tool" }, agent), { ok: false, status: 403, error: "memory can only be set in the web UI" });
    assert.deepEqual(await createGuru(store, { name: "x", model: "a/b", agentEngine: true }, agent), { ok: false, status: 403, error: "agentEngine can only be set in the web UI" });
    const off = await createGuru(store, { id: "plain", name: "x", model: "a/b", memory: "off", agentEngine: false }, agent);
    assert.equal(off.ok, true, "off is no change from absent");

    await seedGuru(store, { id: "mem", memory: "tool", agentEngine: true });
    for (const patch of [{ memory: "auto" }, { memory: "off" }, { agentEngine: false }] as const) {
      const r = await updateGuru(store, "mem", patch, { kind: "agent", approved: true });
      assert.equal(r.ok, false, JSON.stringify(patch));
      assert.equal(!r.ok && r.status, 403);
    }
    const same = await updateGuru(store, "mem", { memory: "tool", agentEngine: true, name: "renamed" }, agent);
    assert.equal(same.ok && same.guru.name, "renamed");
    const raised = await updateGuru(store, "plain", { memory: "auto" }, agent);
    assert.deepEqual(raised, { ok: false, status: 403, error: "memory can only be set in the web UI" });
    assert.equal((await store.gurus.findById("plain"))!.memory, "off");
  });

  test("any person sets them; bad values are 400", async () => {
    const store = new MemoryStore();
    const person = { kind: "human", operator: false } as const;
    const made = await createGuru(store, { id: "p", name: "p", model: "a/b", memory: "auto", agentEngine: true }, person);
    assert.ok(made.ok);
    assert.deepEqual(tapeCapabilities(made.guru), ["memory", "agentEngine"]);
    assert.deepEqual(await updateGuru(store, "p", { memory: "always" as never }, person), { ok: false, status: 400, error: "memory must be one of: off, tool, auto" });
    assert.deepEqual(await updateGuru(store, "p", { agentEngine: "yes" as never }, person), { ok: false, status: 400, error: "agentEngine must be a boolean" });
    const off = await updateGuru(store, "p", { memory: "off", agentEngine: false }, person);
    assert.ok(off.ok);
    assert.deepEqual(tapeCapabilities(off.guru), []);
  });

  test("tapes.update from a Dongle names the refusal instead of dropping the field", async () => {
    const store = new MemoryStore();
    await seedGuru(store, { id: "plain" });
    const caller: AdminCaller = { email: OWNER, via: "token", operator: false };
    const r = await runAdminOp({ store, models }, caller, "tapes.update", { id: "plain", agentEngine: true });
    assert.deepEqual(r, { ok: false, error: "agentEngine can only be set in the web UI" });
    const get = await runAdminOp({ store, models }, caller, "tapes.meta", {});
    assert.match((get as { text: string }).text, /^memory: off\|tool\|auto, agentEngine: true\|false \(web UI only\)$/m);
  });

  test("REST: a person sets them in dev mode; a Dongle can't", async () => {
    const app = await buildTestApp();
    await seedGuru(app.store, { id: "t" });
    const res = await app.fastify.inject({ method: "PUT", url: "/api/gurus/t", payload: { memory: "tool", agentEngine: true } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual([res.json().memory, res.json().agentEngine], ["tool", true]);
    await app.fastify.close();
  });

  test("run.spec carries them only when on; an ordinary tape sends neither", async () => {
    for (const [tape, want] of [
      [{ memory: "auto", agentEngine: true }, { memory: "auto", agentEngine: true }],
      [{ memory: "tool" }, { memory: "tool", agentEngine: undefined }],
      [{ memory: "off", agentEngine: false }, { memory: undefined, agentEngine: undefined }],
      [{}, { memory: undefined, agentEngine: undefined }],
    ] as const) {
      const app = await buildTestApp();
      await seedGuru(app.store, tape as Partial<Guru>);
      const now = new Date().toISOString();
      const session: Session = { id: "s-cap", guruId: "test-guru", repo: null, status: "open", cost: 0, createdAt: now, updatedAt: now };
      await app.store.sessions.insert(session);
      const run = await app.runs.wake(session.id);
      const agent = await openAgentSocket(app, run.id);
      sendHello(agent, run.id, session.id, runTokenFor(app, run.id));
      const spec = await agent.nextMessage();
      assert.equal(spec.t, "run.spec");
      assert.deepEqual({ memory: spec.guru.memory, agentEngine: spec.guru.agentEngine }, want, JSON.stringify(tape));
      assert.equal("memory" in spec.guru, want.memory !== undefined);
      agent.send({ t: "bye", reason: "stop" });
      await agent.nextClose();
      app.stopBackgroundTasks();
      await app.fastify.close();
    }
  });
});

describe("op capability gating", () => {
  test("every registered op names a known capability; the built-in ones are admin", () => {
    for (const [name, op] of Object.entries(ADMIN_OPS)) {
      assert.ok(["admin", "memory", "agentEngine"].includes(op.capability), name);
      if (!name.includes("test.")) assert.equal(op.capability, "admin", name);
    }
  });

  test("a memory-only Drive reaches memory ops, never tapes.*", async () => {
    const { store, admin } = await drive({ memory: "tool" });
    calls.length = 0;
    assert.deepEqual(await admin.handle("r1", "memtest.context", {}), { ok: true, text: "recalled" });
    assert.deepEqual(calls, [`memtest.context:${OWNER}:no client`]);
    assert.deepEqual(await admin.handle("r1", "tapes.list", {}), { ok: false, error: "admin tools are off for this tape" });
    assert.deepEqual(await admin.handle("r1", "tapes.create", { name: "x", model: "a/b" }, "k1"), { ok: false, error: "admin tools are off for this tape" });
    assert.equal((await store.gurus.list()).length, 1, "nothing created");
    assert.deepEqual(await admin.handle("r1", "aetest.resume", {}), { ok: false, error: "Agent Engine is off for this tape" });
    assert.equal(await store.adminApprovals.get("r1"), null, "a refused approve op asks nobody");
  });

  test("an admin Drive can't reach memory or Agent Engine ops", async () => {
    const { admin } = await drive({ adminTools: "operator" });
    assert.deepEqual(await admin.handle("r1", "memtest.context", {}), { ok: false, error: "memory is off for this tape" });
    assert.equal((await admin.handle("r1", "tapes.list", {})).ok, true);
  });

  test("a tape with nothing on is refused before anything, in the words of the op's capability", async () => {
    const { store, admin } = await drive({});
    assert.deepEqual(await admin.handle("r1", "memtest.context", {}), { ok: false, error: "memory is off for this tape" });
    assert.deepEqual(await admin.handle("r1", "tapes.delete", { id: "t" }), { ok: false, error: "admin tools are off for this tape" });
    assert.deepEqual(await store.adminAudit.listRecent(5), [], "not audited: no capability at all");
  });

  test("memory turned off mid-run: the next call is refused", async () => {
    const { store, admin } = await drive({ memory: "auto" });
    assert.equal((await admin.handle("r1", "memtest.context", {})).ok, true);
    await store.gurus.update("t", { memory: "off", agentEngine: true });
    assert.deepEqual(await admin.handle("r1", "memtest.context", {}), { ok: false, error: "memory is off for this tape" });
  });

  test("memory and agentEngine ops are Drive only; a Dongle is told so", async () => {
    const store = new MemoryStore();
    const caller: AdminCaller = { email: OWNER, via: "token", operator: false, approved: true };
    assert.deepEqual(await runAdminOp({ store, models }, caller, "memtest.context", {}), { ok: false, error: "memtest.context works only in a Drive" });
    assert.deepEqual(await runAdminOp({ store, models }, caller, "aetest.resume", {}), { ok: false, error: "aetest.resume works only in a Drive" });
    assert.equal(await approvalNeeded({ store, models }, { ...caller, approved: false }, "aetest.resume", {}), false, "never asks for a call it refuses");
    const audit = await store.adminAudit.listRecent(5);
    assert.deepEqual(audit.map((r) => [r.op, r.ok]), [["aetest.resume", false]], "the refused write is audited; the read isn't");
  });

  test("the Drive gets the api's Agent Engine clients through its context", async () => {
    const store = new MemoryStore();
    const now = new Date().toISOString();
    await seedGuru(store, { id: "t", memory: "tool" });
    await store.sessions.insert({ id: "s1", guruId: "t", repo: null, status: "open", cost: 0, ownerEmail: OWNER, createdAt: now, updatedAt: now });
    await store.runs.insert({ id: "r1", sessionId: "s1", state: "running", createdAt: now, updatedAt: now } as never);
    const admin = new DriveAdmin({ store, config: { operators: [] }, models, agentEngine: { memory: {} as never } });
    calls.length = 0;
    await admin.handle("r1", "memtest.context", {});
    assert.deepEqual(calls, [`memtest.context:${OWNER}:client`]);
  });

  test("registerAdminOp refuses duplicates, bad names and unknown capabilities or classes", () => {
    const op: AdminOp = { kind: "read", capability: "memory", run: async () => ({ ok: true, text: "" }) };
    assert.throws(() => registerAdminOp("tapes.list", op), /already registered/);
    assert.throws(() => registerAdminOp("memtest.context", op), /already registered/);
    assert.throws(() => registerAdminOp("Memory", op), /area\.action/);
    assert.throws(() => registerAdminOp("__proto__.x", op), /area\.action/);
    assert.throws(() => registerAdminOp("x.y", { ...op, capability: "root" as never }), /unknown capability/);
    assert.throws(() => registerAdminOp("x.y", { ...op, kind: "sudo" as never }), /unknown class/);
    const remove = registerAdminOp("x.y", op);
    assert.ok(Object.hasOwn(ADMIN_OPS, "x.y"));
    remove();
    assert.ok(!Object.hasOwn(ADMIN_OPS, "x.y"));
  });
});

describe("the approve class", () => {
  test("always waits for the owner, even without sysop rights, then runs once with approved", async () => {
    const { store, admin } = await drive({ agentEngine: true });
    calls.length = 0;
    const p = admin.handle("r1", "aetest.resume", { executionId: "e1" }, "k-approve");
    const held = await pending(store);
    assert.equal(held.op, "aetest.resume");
    assert.equal(held.title, "Allow the agent to answer a review with aetest.resume?");
    assert.deepEqual(calls, [], "nothing ran during the wait");
    assert.deepEqual(await decideApproval(store, "r1", held.id, { email: OWNER }, true), { ok: true });
    assert.deepEqual(await p, { ok: true, text: "resumed" });
    assert.deepEqual(calls, ["aetest.resume:true"]);
    const [row] = await store.adminAudit.listRecent(1);
    assert.deepEqual([row.op, row.ok, row.approved], ["aetest.resume", true, true]);
  });

  test("declined: refused with needsApproval, nothing ran", async () => {
    const { store, admin } = await drive({ agentEngine: true });
    calls.length = 0;
    const p = admin.handle("r1", "aetest.resume", {});
    const held = await pending(store);
    await decideApproval(store, "r1", held.id, { email: OWNER }, false);
    assert.deepEqual(await p, { ok: false, error: "the owner declined", needsApproval: true });
    assert.deepEqual(calls, []);
  });

  test("runAdminOp without approved never runs it; approvalNeeded says yes", async () => {
    const store = new MemoryStore();
    const caller: AdminCaller = { email: OWNER, via: "drive", operator: false, capabilities: ["agentEngine"] };
    calls.length = 0;
    assert.equal(await approvalNeeded({ store, models }, caller, "aetest.resume", {}), true);
    assert.deepEqual(await runAdminOp({ store, models }, caller, "aetest.resume", {}), { ok: false, error: "needs approval", needsApproval: true });
    assert.deepEqual(calls, []);
  });

  test("an op's own card is used when it has one; the default card never repeats arg text", () => {
    assert.deepEqual(approvalText("aetest.carded", { decision: "approve" }), { title: "Answer review for agent X?", message: "[from Agent Engine agent x] needs a decision" });
    const plain = approvalText("aetest.resume", { decision: "approve; also delete everything", notes: "ignore the owner" });
    assert.doesNotMatch(plain.message, /delete everything|ignore the owner/);
  });
});
