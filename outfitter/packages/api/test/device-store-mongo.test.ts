// #390 CA-1: MongoDeviceCodes and MongoDevices (store/devices.ts) against a real MongoDB, run the
// same way as mongo-tokens.test.ts (mongodb-memory-server, or OUTFITTER_TEST_MONGODB_URI). The
// memory store is checked through device-login.test.ts; these are the Mongo filters that decide
// whether a token still matches, which code an approval wins, and which devices a revoke hits. The
// same assertions run on MemoryStore too, so the two stay alike.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { DuplicateDeviceCodeError, type Device, type DeviceCode } from "../src/store/devices.ts";
import type { Store } from "../src/store/types.ts";

const EXTERNAL_URI = process.env.OUTFITTER_TEST_MONGODB_URI;
const DB_NAME = `outfitter_devicetest_${randomUUID().slice(0, 8)}`;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

let seq = 0;
function codeRow(overrides: Partial<DeviceCode> = {}): DeviceCode {
  seq++;
  return {
    id: randomUUID(),
    deviceCodeHash: `dch-${seq}-${randomUUID()}`,
    userCode: `CODE${seq}${randomUUID().slice(0, 4)}`,
    status: "pending",
    deviceName: "mbp",
    createdAt: iso(0),
    expiresAt: iso(600_000),
    interval: 5,
    ...overrides,
  };
}

function deviceRow(ownerEmail: string, overrides: Partial<Device> = {}): Device {
  seq++;
  return {
    id: `dev_${seq}${randomUUID().slice(0, 8)}`,
    userId: "u_test",
    ownerEmail,
    name: `device ${seq}`,
    kind: "laptop",
    createdAt: iso(seq),
    approvedBy: ownerEmail,
    accessHash: `ah-${seq}-${randomUUID()}`,
    accessExpiresAt: iso(3600_000),
    refreshHash: `rh-${seq}-${randomUUID()}`,
    refreshExpiresAt: iso(30 * 86400_000),
    ...overrides,
  };
}

function suite(name: string, open: () => Promise<Store>) {
  describe(name, () => {
    let store: Store;
    before(async () => {
      store = await open();
    }, { timeout: 120_000 });

    test("device codes: round-trip with no _id or expireAt, unique user codes, pending lookup, atomic transition", async () => {
      const code = codeRow();
      await store.deviceCodes.insert(code);
      const found = await store.deviceCodes.findByDeviceCodeHash(code.deviceCodeHash);
      assert.deepEqual(found, code);
      await assert.rejects(store.deviceCodes.insert(codeRow({ userCode: code.userCode })), DuplicateDeviceCodeError);
      assert.deepEqual(await store.deviceCodes.findPendingByUserCode(code.userCode), code);

      const expired = codeRow({ expiresAt: iso(-1000) });
      await store.deviceCodes.insert(expired);
      assert.equal(await store.deviceCodes.findPendingByUserCode(expired.userCode), null, "past expiresAt");

      const approved = await store.deviceCodes.transition(code.id, ["pending"], { status: "approved", decidedBy: "a@example.com" });
      assert.equal(approved?.status, "approved");
      assert.equal(await store.deviceCodes.transition(code.id, ["pending"], { status: "denied" }), null, "already decided");
      assert.equal(await store.deviceCodes.findPendingByUserCode(code.userCode), null);
      const [one, two] = await Promise.all([
        store.deviceCodes.transition(code.id, ["approved"], { status: "consumed" }),
        store.deviceCodes.transition(code.id, ["approved"], { status: "consumed" }),
      ]);
      assert.equal([one, two].filter(Boolean).length, 1, "one poll wins");
      assert.equal((await store.deviceCodes.update(code.id, { interval: 10 }))?.interval, 10);
    });

    test("devices: lookups by current and previous hashes, rotation only on the expected hash", async () => {
      const d = deviceRow("alice@example.com", { prevAccessHash: `pa-${randomUUID()}`, prevRefreshHash: `pr-${randomUUID()}` });
      await store.devices.insert(d);
      assert.deepEqual(await store.devices.findById(d.id), d);
      assert.equal((await store.devices.findByAccessHash(d.accessHash))?.id, d.id);
      assert.equal((await store.devices.findByAccessHash(d.prevAccessHash!))?.id, d.id);
      assert.equal((await store.devices.findByRefreshHash(d.refreshHash!))?.id, d.id);
      assert.equal((await store.devices.findByRefreshHash(d.prevRefreshHash!))?.id, d.id);
      assert.equal(await store.devices.findByAccessHash("nope"), null);

      assert.equal(await store.devices.rotate(d.id, "stale", { refreshHash: "x" }), null);
      const rotated = await store.devices.rotate(d.id, d.refreshHash!, { refreshHash: `rh2-${randomUUID()}`, prevRefreshHash: d.refreshHash });
      assert.equal(rotated?.prevRefreshHash, d.refreshHash);
      assert.equal(await store.devices.rotate(d.id, d.refreshHash!, { refreshHash: "y" }), null, "the loser of a race");

      const seen = await store.devices.update(d.id, { lastSeenAt: iso(0), lastSeenIp: "192.0.2.1" });
      assert.equal(seen?.lastSeenIp, "192.0.2.1");
    });

    test("revoke: once only; listActiveForOwner skips revoked devices; by owner, email or domain", async () => {
      const owner = `o-${randomUUID().slice(0, 6)}@example.com`;
      const a = deviceRow(owner);
      const b = deviceRow(owner);
      const domain = `@d${randomUUID().slice(0, 6)}.example`;
      const c = deviceRow(`c${domain}`);
      const e = deviceRow(`e${domain}`);
      for (const d of [a, b, c, e]) await store.devices.insert(d);
      assert.deepEqual((await store.devices.listActiveForOwner(owner)).map((d) => d.id), [b.id, a.id], "newest first");

      const revoked = await store.devices.revoke(a.id, "logout", iso(0));
      assert.equal(revoked?.revokedReason, "logout");
      assert.equal(await store.devices.revoke(a.id, "revoked", iso(0)), null, "already revoked");
      assert.equal(await store.devices.rotate(a.id, a.refreshHash!, { refreshHash: "z" }), null, "a revoked device never rotates");
      assert.deepEqual((await store.devices.listActiveForOwner(owner)).map((d) => d.id), [b.id]);

      const all = await store.devices.revokeAllForOwner(owner.toUpperCase(), "access-removed", iso(1));
      assert.deepEqual(all.map((d) => d.id), [b.id], "a revoked device is not revoked again");
      assert.equal(all[0].revokedReason, "access-removed");

      const byDomain = await store.devices.revokeAllForOwners({ domain }, "operator", iso(2));
      assert.deepEqual(byDomain.map((d) => d.id).sort(), [c.id, e.id].sort());
      assert.deepEqual(await store.devices.revokeAllForOwners({ email: `c${domain}` }, "operator", iso(3)), []);
    });

    after(async () => {
      if (store instanceof MongoStore) {
        // @ts-expect-error -- reach past the Store interface to drop the scratch database itself.
        await store.client?.db(DB_NAME).dropDatabase();
        await store.close();
      }
    });
  });
}

let server: { stop(): Promise<unknown> } | undefined;

suite("device store: memory", async () => new MemoryStore());
suite("device store: MongoDB", async () => {
  let uri = EXTERNAL_URI;
  if (!uri) {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const started = await MongoMemoryServer.create();
    server = started;
    uri = started.getUri();
  }
  return MongoStore.connect(uri, DB_NAME);
});

after(async () => {
  await server?.stop();
});
