// MongoAdminAudit and the tape adminTools field against a real MongoDB (mongodb-memory-server, or
// OUTFITTER_TEST_MONGODB_URI -- see mongo-tokens.test.ts for how to point it at a cluster).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import { runAdminOp } from "../src/admin/ops.ts";

const EXTERNAL_URI = process.env.OUTFITTER_TEST_MONGODB_URI;
const DB_NAME = `outfitter_audittest_${randomUUID().slice(0, 8)}`;

describe("MongoAdminAudit", () => {
  let store: MongoStore;
  let stop: (() => Promise<unknown>) | undefined;

  before(async () => {
    let uri = EXTERNAL_URI;
    if (!uri) {
      const { MongoMemoryServer } = await import("mongodb-memory-server");
      const started = await MongoMemoryServer.create();
      uri = started.getUri();
      stop = () => started.stop();
    }
    store = await MongoStore.connect(uri, DB_NAME);
  }, { timeout: 120_000 }); // first run downloads the mongod binary

  after(async () => {
    // @ts-expect-error -- reach past the Store interface to drop the scratch database itself.
    await store.client?.db(DB_NAME).dropDatabase();
    await store.close();
    await stop?.();
  });

  test("ops write audit rows, newest first", async () => {
    const ctx = { store, models: { list: async () => [] } };
    const caller = { email: "ada@example.com", via: "token" as const, operator: false };
    const created = await runAdminOp(ctx, caller, "tapes.create", { id: "reviewer", name: "Reviewer", model: "a/b" });
    assert.equal(created.ok, true);
    const bad = await runAdminOp(ctx, caller, "tapes.update", { id: "reviewer", model: "nope" });
    assert.equal(bad.ok, false);
    const rows = await store.adminAudit.listRecent(5);
    assert.deepEqual(
      rows.map((r) => [r.op, r.target, r.ok, r.error]),
      [
        ["tapes.update", "reviewer", false, "model must look like provider/id, got: nope"],
        ["tapes.create", "reviewer", true, undefined],
      ],
    );
    assert.equal((rows[0] as { _id?: unknown })._id, undefined);
  });

  test("adminApprovals: claim, decide and clear are conditional", async () => {
    const t = (ms: number) => new Date(Date.now() + ms).toISOString();
    const base = { runId: "run-a", sessionId: "s", ownerEmail: "ada@example.com", op: "tapes.delete", title: "t", message: "m", requestedAt: t(0) };
    assert.equal(await store.adminApprovals.claim({ ...base, id: "a1", expiresAt: t(60_000) }, t(0)), true);
    assert.equal(await store.adminApprovals.claim({ ...base, id: "a2", expiresAt: t(60_000) }, t(0)), false, "busy while a1 is pending");
    assert.equal(await store.adminApprovals.decide("run-a", "a2", "approved", "ada@example.com", t(0)), false, "wrong id");
    assert.equal(await store.adminApprovals.decide("run-a", "a1", "approved", "ada@example.com", t(120_000)), false, "after expiry");
    assert.equal(await store.adminApprovals.decide("run-a", "a1", "denied", "ada@example.com", t(0)), true);
    assert.equal(await store.adminApprovals.decide("run-a", "a1", "approved", "ada@example.com", t(0)), false, "already decided");
    assert.equal((await store.adminApprovals.get("run-a"))!.decision, "denied");
    assert.equal(await store.adminApprovals.claim({ ...base, id: "a3", expiresAt: t(60_000) }, t(0)), true, "a decided one can be replaced");
    await store.adminApprovals.clear("run-a", "a1");
    assert.equal((await store.adminApprovals.get("run-a"))!.id, "a3", "clear only removes its own");
    await store.adminApprovals.clear("run-a", "a3");
    assert.equal(await store.adminApprovals.get("run-a"), null);
  });

  test("adminTools round-trips on a tape", async () => {
    const now = new Date().toISOString();
    await store.gurus.insert({ id: "sysop", name: "Sysop", model: "a/b", adminTools: "manage", createdAt: now, updatedAt: now });
    assert.equal((await store.gurus.findById("sysop"))!.adminTools, "manage");
  });
});
