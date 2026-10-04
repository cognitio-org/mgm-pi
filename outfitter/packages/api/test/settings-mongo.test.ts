// Central settings, CA-3 (#392): MongoSettings and MongoFleetSettings.replaceAtVersion against a
// real MongoDB (mongodb-memory-server, or OUTFITTER_TEST_MONGODB_URI -- see mongo-tokens.test.ts):
// versioned put/delete stay atomic across concurrent writers, and one default profile per user.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import { ensureFleetSettings, updateFleetSettings } from "../src/fleet-settings.ts";
import type { SettingsDoc } from "../src/store/settings.ts";

const EXTERNAL_URI = process.env.OUTFITTER_TEST_MONGODB_URI;
const DB_NAME = `outfitter_settingstest_${randomUUID().slice(0, 8)}`;
const NOW = "2026-10-04T10:00:00.000Z";

function doc(id: string, extra: Partial<SettingsDoc> = {}): SettingsDoc {
  return { id, level: "profile", userId: "u_1", values: {}, version: 0, createdAt: NOW, updatedAt: NOW, updatedBy: "a@example.com", ...extra };
}

describe("MongoSettings", () => {
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

  test("put: one of several concurrent creates and one of several writers at a version win", async () => {
    const id = "profile:u_1:work";
    const creates = await Promise.all([1, 2, 3].map((n) => store.settings.put(doc(id, { name: "work", values: { "model.default": `m${n}` } }), 0)));
    assert.equal(creates.filter((r) => r.ok).length, 1);
    const loser = creates.find((r) => !r.ok);
    assert.ok(loser && !loser.ok && loser.current?.version === 1);

    const writes = await Promise.all([1, 2, 3].map((n) => store.settings.put(doc(id, { name: "work", values: { "model.default": `w${n}` } }), 1)));
    assert.equal(writes.filter((r) => r.ok).length, 1);
    const got = await store.settings.get(id);
    assert.equal(got?.version, 2);
    assert.equal((got as unknown as { _id?: string })._id, undefined, "no _id leaks out");
  });

  test("listProfiles by name, setDefaultProfile leaves one default and bumps versions, delete at version", async () => {
    await store.settings.put(doc("profile:u_2:b", { userId: "u_2", name: "b", isDefault: true }), 0);
    await store.settings.put(doc("profile:u_2:a", { userId: "u_2", name: "a" }), 0);
    await store.settings.put(doc("user:u_2", { level: "user", userId: "u_2" }), 0);
    assert.deepEqual((await store.settings.listProfiles("u_2")).map((p) => p.name), ["a", "b"]);
    await store.settings.setDefaultProfile("u_2", "a");
    const [a, b] = await store.settings.listProfiles("u_2");
    assert.equal(a!.isDefault, true);
    assert.equal(a!.version, 2);
    assert.equal(b!.isDefault, undefined);
    assert.equal(b!.version, 2);

    const stale = await store.settings.delete("profile:u_2:a", 1);
    assert.ok(!stale.ok && stale.current?.version === 2);
    assert.deepEqual(await store.settings.delete("profile:u_2:a", 2), { ok: true, doc: null });
    assert.deepEqual(await store.settings.delete("profile:u_2:a", 2), { ok: false, current: null });
  });

  test("fleet replaceAtVersion: a document from before versions counts as 0; concurrent writers each bump once", async () => {
    await ensureFleetSettings(store);
    assert.equal((await store.fleetSettings.get())?.version, undefined);
    const results = await Promise.all([1, 2, 3].map((n) => updateFleetSettings(store, (cur) => ({ ...cur, values: { "model.default": `m${n}` } }), 0)));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal((await store.fleetSettings.get())?.version, 1);
    // Without an expected version (the operator PUT) every writer gets its bump.
    await Promise.all([1, 2, 3].map(() => updateFleetSettings(store, (cur) => ({ ...cur }))));
    assert.equal((await store.fleetSettings.get())?.version, 4);
  });
});
