// #172: held mail with a reason (Mail.heldDetail), on MemoryStore and a real MongoDB alike. Same
// setup as mongo-entry-runs.test.ts (mongodb-memory-server, or OUTFITTER_TEST_MONGODB_URI); the
// scratch database is dropped afterwards.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Mail, Store } from "../src/store/types.ts";

const EXTERNAL_URI = process.env.OUTFITTER_TEST_MONGODB_URI;
const DB_NAME = `outfitter_mailhold_${randomUUID().slice(0, 8)}`;
const NOW = "2026-09-26T05:00:00.000Z";
const MAX = 6;

function mail(sessionId: string, id: string, extra: Partial<Mail> = {}): Mail {
  return {
    id: `${sessionId}-${id}`,
    sessionId,
    from: { kind: "user" },
    text: "hi",
    behavior: "followUp",
    status: "queued",
    attempts: 0,
    createdAt: NOW,
    ...extra,
  };
}

function contract(name: string, getStore: () => Store) {
  describe(`${name}: held mail with a reason (#172)`, () => {
    test("holdSession parks deliverable mail with the reason; acked mail is untouched", async () => {
      const store = getStore();
      const s = `s-${randomUUID().slice(0, 8)}`;
      await store.mail.insertIfNew(mail(s, "a"));
      await store.mail.insertIfNew(mail(s, "b", { status: "acked" }));
      assert.equal(await store.mail.holdSession(s, NOW, MAX, "the App is missing X"), 1);
      assert.equal((await store.mail.findById(`${s}-a`))?.status, "held");
      assert.equal((await store.mail.findById(`${s}-a`))?.heldDetail, "the App is missing X");
      assert.equal((await store.mail.findById(`${s}-b`))?.status, "acked");
      assert.equal(await store.mail.heldDetail(s), "the App is missing X");
      assert.equal(await store.mail.hasDeliverable(s, NOW, MAX), false);
      assert.equal((await store.mail.sessionsWithDeliverable(NOW, MAX)).includes(s), false);
    });

    test("new mail joining the hold takes its reason", async () => {
      const store = getStore();
      const s = `s-${randomUUID().slice(0, 8)}`;
      await store.mail.insertIfNew(mail(s, "a"));
      await store.mail.holdSession(s, NOW, MAX, "reason one");
      await store.mail.insertIfNew(mail(s, "b"));
      assert.equal(await store.mail.holdIfStuck(s, NOW, MAX, 3), 2);
      assert.equal((await store.mail.findById(`${s}-b`))?.heldDetail, "reason one");
    });

    test("a deploy-mismatch release leaves failure holds alone; a session release (Retry) takes both", async () => {
      const store = getStore();
      const failing = `s-${randomUUID().slice(0, 8)}`;
      const skewed = `s-${randomUUID().slice(0, 8)}`;
      await store.mail.insertIfNew(mail(failing, "a"));
      await store.mail.holdSession(failing, NOW, MAX, "reason");
      await store.mail.insertIfNew(mail(skewed, "a", { status: "held", heldAt: NOW, unvalidatedWakes: 3 }));

      const released = await store.mail.releaseHeld(undefined, "deploy-mismatch");
      assert.equal(released.includes(skewed), true);
      assert.equal(released.includes(failing), false);
      assert.equal(await store.mail.countHeld(failing), 1);
      assert.equal(await store.mail.heldDetail(skewed), undefined);

      assert.deepEqual(await store.mail.releaseHeld(failing), [failing]);
      const row = await store.mail.findById(`${failing}-a`);
      assert.equal(row?.status, "queued");
      assert.equal(row?.heldDetail, undefined);
      assert.equal(row?.heldAt, undefined);
      assert.equal(await store.mail.heldDetail(failing), undefined);
    });
  });
}

contract("MemoryStore", (() => {
  const store = new MemoryStore();
  return () => store;
})());

let mongo: MongoStore;
let server: { stop(): Promise<unknown> } | undefined;

describe("MongoStore", () => {
  before(async () => {
    let uri = EXTERNAL_URI;
    if (!uri) {
      const { MongoMemoryServer } = await import("mongodb-memory-server");
      const started = await MongoMemoryServer.create();
      server = started;
      uri = started.getUri();
    }
    mongo = await MongoStore.connect(uri, DB_NAME);
  }, { timeout: 120_000 });

  after(async () => {
    // @ts-expect-error -- reach past the Store interface to drop the scratch database itself.
    await mongo.client?.db(DB_NAME).dropDatabase();
    await mongo.close();
    await server?.stop();
  });

  contract("MongoStore", () => mongo);
});
