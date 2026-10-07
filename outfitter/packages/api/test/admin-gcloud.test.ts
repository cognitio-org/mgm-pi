// GA-4 (#494): the gcloud approval ops. A Drive's mutating gcloud command waits on the owner's web
// card and is audited whichever way it goes; a laptop's TUI decision is recorded by gcloud.note.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { seedGuru } from "./helpers.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { DriveAdmin } from "../src/admin/drive.ts";
import { decideApproval } from "../src/admin/approvals.ts";
import { runAdminOp } from "../src/admin/ops.ts";
import { gcloudArgs } from "../src/admin/gcloud-ops.ts";

const models = { list: async () => [] };
const fast = { pollMs: 5, timeoutMs: 2_000 };
const OWNER = "ops@example.com";
const ARGS = { project: "projects/outfitter-509211", command: "gcloud compute instances delete vm-1 --zone us-central1-a" };

async function fixture(operators: string[] = [OWNER], approval = fast) {
  const store = new MemoryStore();
  const now = new Date().toISOString();
  await seedGuru(store, { id: "t", adminTools: "operator" });
  await store.sessions.insert({ id: "s1", guruId: "t", repo: null, status: "open", cost: 0, ownerEmail: OWNER, createdAt: now, updatedAt: now });
  await store.runs.insert({ id: "r1", sessionId: "s1", state: "running", createdAt: now, updatedAt: now } as never);
  return { store, admin: new DriveAdmin({ store, config: { operators }, models, approval }) };
}

async function pending(store: MemoryStore) {
  for (let i = 0; i < 400; i++) {
    const held = await store.adminApprovals.get("r1");
    if (held && !held.decision) return held;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no approval was requested");
}

describe("gcloud.run from a Drive", () => {
  test("asks the owner with the project and command, then audits the approval", async () => {
    const { store, admin } = await fixture();
    const result = admin.handle("r1", "gcloud.run", ARGS);
    const held = await pending(store);
    assert.match(held.title, /gcloud command/);
    assert.match(held.message, /projects\/outfitter-509211/);
    assert.match(held.message, /instances delete vm-1/);
    assert.deepEqual(await decideApproval(store, "r1", held.id, { email: OWNER }, true), { ok: true });
    assert.deepEqual(await result, { ok: true, text: "approved" });
    const rows = await store.adminAudit.listRecent(5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].op, "gcloud.run");
    assert.equal(rows[0].approved, true);
    assert.equal(rows[0].ok, true);
    assert.equal(rows[0].approvalId, held.id);
    assert.match(rows[0].target ?? "", /projects\/outfitter-509211 :: gcloud compute instances delete vm-1/);
  });

  test("a decline is refused and audited with the command", async () => {
    const { store, admin } = await fixture();
    const result = admin.handle("r1", "gcloud.run", ARGS);
    const held = await pending(store);
    await decideApproval(store, "r1", held.id, { email: OWNER }, false);
    assert.deepEqual(await result, { ok: false, error: "the owner declined", needsApproval: true });
    const [row] = await store.adminAudit.listRecent(5);
    assert.deepEqual([row.op, row.ok, row.approved, row.error], ["gcloud.run", false, false, "the owner declined"]);
    assert.match(row.target ?? "", /instances delete vm-1/);
  });

  test("no answer in time is audited as a refusal", async () => {
    const { store, admin } = await fixture(undefined, { pollMs: 5, timeoutMs: 30 });
    const r = await admin.handle("r1", "gcloud.run", ARGS);
    assert.equal(r.ok, false);
    const [row] = await store.adminAudit.listRecent(5);
    assert.match(row.error ?? "", /did not answer/);
  });

  test("a tape owner who is not an operator is refused before any card", async () => {
    const { store, admin } = await fixture([]);
    assert.deepEqual(await admin.handle("r1", "gcloud.run", ARGS), { ok: false, error: "sysop rights required" });
    assert.equal(await store.adminApprovals.get("r1"), null);
  });

  test("hidden characters in the command are refused without asking", async () => {
    const { store, admin } = await fixture();
    const r = await admin.handle("r1", "gcloud.run", { ...ARGS, command: "gcloud projects list‮ --x" });
    assert.equal(r.ok, false);
    assert.equal(await store.adminApprovals.get("r1"), null);
  });

  test("a missing command is refused", () => {
    assert.deepEqual(gcloudArgs({ project: "p" }), { error: "command is required" });
  });
});

describe("gcloud.note from a laptop", () => {
  const ctx = (store: MemoryStore) => ({ store, models });
  const dongle = { email: OWNER, via: "token" as const, operator: false };

  test("records an allowed decision as approved", async () => {
    const store = new MemoryStore();
    const r = await runAdminOp(ctx(store), { ...dongle, approved: true }, "gcloud.note", { ...ARGS, decision: "allowed" });
    assert.deepEqual(r, { ok: true, text: "noted" });
    const [row] = await store.adminAudit.listRecent(1);
    assert.deepEqual([row.via, row.ok, row.approved], ["token", true, true]);
    assert.match(row.target ?? "", /instances delete vm-1/);
  });

  test("records a denied decision as a failure", async () => {
    const store = new MemoryStore();
    await runAdminOp(ctx(store), dongle, "gcloud.note", { ...ARGS, decision: "denied" });
    const [row] = await store.adminAudit.listRecent(1);
    assert.deepEqual([row.ok, row.approved], [false, false]);
  });

  test("a Drive cannot write its own decisions", async () => {
    const store = new MemoryStore();
    const r = await runAdminOp(ctx(store), { email: OWNER, via: "drive", operator: true, capabilities: ["admin"] }, "gcloud.note", { ...ARGS, decision: "allowed" });
    assert.equal(r.ok, false);
  });
});
