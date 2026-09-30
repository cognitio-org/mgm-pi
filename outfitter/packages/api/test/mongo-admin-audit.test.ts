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

  test("adminTools round-trips on a tape", async () => {
    const now = new Date().toISOString();
    await store.gurus.insert({ id: "sysop", name: "Sysop", model: "a/b", adminTools: "manage", createdAt: now, updatedAt: now });
    assert.equal((await store.gurus.findById("sysop"))!.adminTools, "manage");
  });
});
