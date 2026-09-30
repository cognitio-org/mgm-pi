// MongoSessionChunks against a real mongod (mongodb-memory-server, or OUTFITTER_TEST_MONGODB_URI):
// upserts, deletes, and the clear error on a cluster without the Atlas indexes (#289).
// mongodb-memory-server has no Atlas Search, so the queries themselves are checked on Atlas by
// deploy/atlas-search.sh's backfill plus the live smoke test in the spec's Verification section.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import { SearchUnavailableError, type SessionChunk } from "../src/store/types.ts";

const EXTERNAL_URI = process.env.OUTFITTER_TEST_MONGODB_URI;
const DB_NAME = `outfitter_chunktest_${randomUUID().slice(0, 8)}`;

describe("MongoSessionChunks", () => {
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
  }, { timeout: 120_000 });

  after(async () => {
    // @ts-expect-error -- reach past the Store interface to drop the scratch database itself.
    await store.client?.db(DB_NAME).dropDatabase();
    await store.close();
    await stop?.();
  });

  const chunk = (sessionId: string, entryId: string, text: string): SessionChunk => ({
    id: `${sessionId}:${entryId}`,
    sessionId,
    entryId,
    guruId: "g",
    role: "user",
    createdAt: "2026-09-30T10:00:00.000Z",
    text,
  });

  test("upsert replaces by id; delete removes one session's chunks", async () => {
    await store.sessionChunks.upsertMany([chunk("a", "1", "first"), chunk("a", "2", "second"), chunk("b", "1", "other")]);
    await store.sessionChunks.upsertMany([chunk("a", "1", "first, edited")]);
    // @ts-expect-error -- read the raw collection to check what was stored.
    const col = store.client.db(DB_NAME).collection<{ _id: string; text: string; at: Date }>("sessionChunks");
    const doc = await col.findOne({ _id: "a:1" });
    assert.equal(doc?.text, "first, edited");
    assert.ok(doc?.at instanceof Date, "createdAt is also kept as a Date for range filters");
    assert.equal(await store.sessionChunks.deleteForSession("a"), 2);
    assert.equal(await col.countDocuments(), 1);
  });

  test("without the Atlas indexes, search says how to set them up", async () => {
    if (EXTERNAL_URI) return; // a real Atlas cluster may have them
    await assert.rejects(store.sessionChunks.search({ text: "x", mode: "text", filter: {}, limit: 5 }), (err: unknown) => {
      assert.ok(err instanceof SearchUnavailableError, String(err));
      assert.match((err as Error).message, /deploy\/atlas-search\.sh/);
      return true;
    });
  });
});
