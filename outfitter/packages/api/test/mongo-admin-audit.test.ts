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

  test("laptopApprovals (E9.9): find, list, decide and consume are conditional; the TTL index exists", async () => {
    const t = (ms: number) => new Date(Date.parse("2026-10-01T12:00:00.000Z") + ms).toISOString();
    const match = { ownerEmail: "ada@example.com", op: "memory.save", argsDigest: "d1", laptopSessionId: "laptop:abcdefgh-1", repo: "acme/widgets" };
    const base = {
      ownerEmail: match.ownerEmail,
      op: match.op,
      argsDigest: match.argsDigest,
      title: "Share a memory with the team",
      summary: "s",
      origin: { laptopSessionId: match.laptopSessionId, repo: match.repo },
      state: "pending" as const,
      createdAt: t(0),
      expiresAt: t(600_000),
    };
    await store.laptopApprovals.insert({ ...base, id: "la1" });
    await store.laptopApprovals.insert({ ...base, id: "la2", argsDigest: "d2", createdAt: t(1) });
    await store.laptopApprovals.insert({ ...base, id: "la3", ownerEmail: "eve@example.com" });
    assert.equal((await store.laptopApprovals.get("la1"))!.state, "pending");
    assert.equal((await store.laptopApprovals.get("la1") as { _id?: unknown; expireAt?: unknown })._id, undefined);
    assert.deepEqual((await store.laptopApprovals.listPending("ada@example.com", t(0), 10)).map((a) => a.id), ["la1", "la2"]);
    assert.equal((await store.laptopApprovals.findPending(match, t(0)))!.id, "la1");
    assert.equal(await store.laptopApprovals.findPending({ ...match, repo: undefined }, t(0)), null, "a repo-less ask is another ask");
    assert.equal(await store.laptopApprovals.findPending(match, t(600_000)), null, "expired");
    assert.equal(await store.laptopApprovals.consume("la1", match, t(0)), false, "pending can't be used");
    assert.equal(await store.laptopApprovals.decide("la1", "eve@example.com", "approved", t(0), t(600_000)), false, "not hers");
    assert.equal(await store.laptopApprovals.decide("la1", "ada@example.com", "approved", t(700_000), t(600_000)), false, "after expiry");
    assert.equal(await store.laptopApprovals.decide("la1", "ada@example.com", "approved", t(0), t(600_000)), true);
    assert.equal(await store.laptopApprovals.decide("la1", "ada@example.com", "denied", t(0), t(600_000)), false, "final");
    assert.equal(await store.laptopApprovals.consume("la1", { ...match, argsDigest: "d2" }, t(0)), false, "digest");
    assert.equal(await store.laptopApprovals.consume("la1", { ...match, laptopSessionId: "laptop:other-session" }, t(0)), false, "origin");
    assert.equal(await store.laptopApprovals.consume("la1", match, t(600_000)), false, "expired");
    const both = await Promise.all([store.laptopApprovals.consume("la1", match, t(0)), store.laptopApprovals.consume("la1", match, t(0))]);
    assert.deepEqual(both.sort(), [false, true], "used once");
    assert.equal((await store.laptopApprovals.get("la1"))!.state, "used");
    // @ts-expect-error -- reach past the Store interface for the index list.
    const indexes = await store.client.db(DB_NAME).collection("laptopApprovals").indexes();
    assert.ok(indexes.some((i: { key: Record<string, unknown>; expireAfterSeconds?: number }) => i.key.expireAt === 1 && i.expireAfterSeconds === 0));
  });

  test("adminTools round-trips on a tape", async () => {
    const now = new Date().toISOString();
    await store.gurus.insert({ id: "sysop", name: "Sysop", model: "a/b", adminTools: "manage", createdAt: now, updatedAt: now });
    assert.equal((await store.gurus.findById("sysop"))!.adminTools, "manage");
  });
});
