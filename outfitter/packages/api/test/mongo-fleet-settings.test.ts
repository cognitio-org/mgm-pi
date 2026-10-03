// MongoFleetSettings against a real MongoDB (mongodb-memory-server, or OUTFITTER_TEST_MONGODB_URI --
// see mongo-tokens.test.ts for how to point it at a cluster): the one-document get/put, and
// insertIfAbsent's $setOnInsert upsert, which seeds the defaults once and never overwrites.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import { defaultFleetSettings, ensureFleetSettings } from "../src/fleet-settings.ts";

const EXTERNAL_URI = process.env.OUTFITTER_TEST_MONGODB_URI;
const DB_NAME = `outfitter_fleettest_${randomUUID().slice(0, 8)}`;

describe("MongoFleetSettings", () => {
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

  test("seeds the defaults once, concurrently safe, and never overwrites a saved document", async () => {
    assert.equal(await store.fleetSettings.get(), null);
    const results = await Promise.all([ensureFleetSettings(store), ensureFleetSettings(store), ensureFleetSettings(store)]);
    assert.deepEqual(results.filter(Boolean).length, 1, "exactly one instance writes it");
    assert.deepEqual(await store.fleetSettings.get(), defaultFleetSettings(), "stored as given, no _id");

    const saved = { telemetry: { sentry: { enabled: true, dsn: "https://k@o0.ingest.sentry.io/1", tracesSampleRate: 0.2 } }, updatedBy: "operator@mgms.eu" };
    await store.fleetSettings.put(saved);
    assert.equal(await ensureFleetSettings(store), false);
    assert.deepEqual(await store.fleetSettings.get(), saved);
  });
});
