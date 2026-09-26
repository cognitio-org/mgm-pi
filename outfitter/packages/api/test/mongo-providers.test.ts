// MongoProviders.upsert against a real MongoDB (#169): a row that leaves out an optional field
// (detail, meta, isDefault) must clear it. The old `$set` upsert kept whatever the previous row had,
// so a sandbox row that stopped being the default (or stopped being registered) kept its default
// marker and last live capacity. Same setup as mongo-tokens.test.ts: a mongod this test starts
// itself (mongodb-memory-server), or OUTFITTER_TEST_MONGODB_URI, in a scratch database it drops.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import type { ProviderRecord } from "../src/store/types.ts";

const EXTERNAL_URI = process.env.OUTFITTER_TEST_MONGODB_URI;
const DB_NAME = `outfitter_providertest_${randomUUID().slice(0, 8)}`;

describe("MongoProviders against a real MongoDB", () => {
  let store: MongoStore;
  let server: { stop(): Promise<unknown> } | undefined;

  before(async () => {
    let uri = EXTERNAL_URI;
    if (!uri) {
      const { MongoMemoryServer } = await import("mongodb-memory-server");
      const started = await MongoMemoryServer.create();
      server = started;
      uri = started.getUri();
    }
    store = await MongoStore.connect(uri, DB_NAME);
  }, { timeout: 120_000 }); // first run downloads the mongod binary

  after(async () => {
    // @ts-expect-error -- reach past the Store interface to drop the scratch database itself.
    await store.client?.db(DB_NAME).dropDatabase();
    await store.close();
    await server?.stop();
  });

  test("upsert replaces the whole record: optional fields a new row leaves out are gone", async () => {
    const first: ProviderRecord = {
      id: "cloudrun",
      kind: "cloudrun",
      name: "Cloud Run agent job",
      status: "up",
      checkedAt: "2026-09-25T00:00:00.000Z",
      isDefault: true,
      meta: { active: 2, runningExecutions: 2 },
      history: [{ status: "up", at: "2026-09-25T00:00:00.000Z" }],
    };
    await store.providers.upsert(first);
    assert.deepEqual(await store.providers.findById("cloudrun"), first);

    const second: ProviderRecord = {
      id: "cloudrun",
      kind: "cloudrun",
      name: "Cloud Run agent job",
      status: "unknown",
      detail: "not registered on this deployment",
      checkedAt: "2026-09-26T00:00:00.000Z",
      history: [...first.history, { status: "unknown", at: "2026-09-26T00:00:00.000Z" }],
    };
    await store.providers.upsert(second);
    const stored = await store.providers.findById("cloudrun");
    assert.deepEqual(stored, second);
    assert.equal((stored as { _id?: unknown })._id, undefined);
    assert.equal((await store.providers.list()).length, 1);
  });
});
