// #147: Entry.runId and RunsCollection.listForSession, on MemoryStore and a real MongoDB alike.
// Same setup as mongo-tokens.test.ts (mongodb-memory-server, or OUTFITTER_TEST_MONGODB_URI); the
// scratch database is dropped afterwards.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Run, Store } from "../src/store/types.ts";

const EXTERNAL_URI = process.env.OUTFITTER_TEST_MONGODB_URI;
const DB_NAME = `outfitter_entryruns_${randomUUID().slice(0, 8)}`;

function run(sessionId: string, id: string, createdAt: string, extra: Partial<Run> = {}): Run {
  return { id, sessionId, state: "stopped", lastAckedSeq: 0, pending: [], createdAt, updatedAt: createdAt, ...extra };
}

function contract(name: string, getStore: () => Store) {
  describe(`${name}: entry runId and runs.listForSession (#147)`, () => {
    test("insertIfNew keeps runId when given, and writes no runId field when not", async () => {
      const store = getStore();
      const sessionId = `s-${randomUUID().slice(0, 8)}`;
      assert.equal(await store.entries.insertIfNew(sessionId, 1, { id: "e1", type: "message" }, { runId: "r1" }), true);
      assert.equal(await store.entries.insertIfNew(sessionId, 2, { id: "e2", type: "custom" }), true);
      const rows = await store.entries.listForSession(sessionId);
      assert.equal(rows[0]!.runId, "r1");
      assert.equal("runId" in rows[1]!, false, "absent, not null or undefined");
      assert.equal((await store.entries.listRecent(sessionId, 10))[0]!.runId, "r1");
      assert.equal((await store.entries.findByEntryId(sessionId, "e1"))!.runId, "r1");
    });

    test("listForSession returns every run of the session, oldest first, and only that session's", async () => {
      const store = getStore();
      const sessionId = `s-${randomUUID().slice(0, 8)}`;
      await store.runs.insert(run(sessionId, `${sessionId}-b`, "2026-09-24T02:00:00.000Z", { allowExternalHtmlResources: true }));
      await store.runs.insert(run(sessionId, `${sessionId}-a`, "2026-09-24T01:00:00.000Z", { allowExternalHtmlResources: false }));
      await store.runs.insert(run(`other-${sessionId}`, `${sessionId}-x`, "2026-09-24T00:00:00.000Z"));
      const runs = await store.runs.listForSession(sessionId);
      assert.deepEqual(runs.map((r) => r.id), [`${sessionId}-a`, `${sessionId}-b`]);
      assert.deepEqual(runs.map((r) => r.allowExternalHtmlResources), [false, true]);
      assert.equal((runs[0] as { _id?: unknown })._id, undefined);
      assert.deepEqual(await store.runs.listForSession("no-such-session"), []);
    });

    test("mergeStartup sets fields inside Run.startup without rewriting the rest, and unlessSet writes once", async () => {
      const store = getStore();
      const sessionId = `s-${randomUUID().slice(0, 8)}`;
      const id = `${sessionId}-r`;
      await store.runs.insert(run(sessionId, id, "2026-09-26T01:00:00.000Z", { state: "provisioning", startup: { wakeAt: "2026-09-26T01:00:00.000Z", provider: "gke" } }));

      const first = await store.runs.mergeStartup(id, { helloAt: "2026-09-26T01:00:05.000Z", agentd: { bootMs: 900 } }, "helloAt");
      assert.equal(first?.startup?.helloAt, "2026-09-26T01:00:05.000Z");
      assert.equal(first?.startup?.wakeAt, "2026-09-26T01:00:00.000Z", "other startup fields survive");
      assert.equal(first?.startup?.provider, "gke");

      assert.equal(await store.runs.mergeStartup(id, { helloAt: "2026-09-26T02:00:00.000Z" }, "helloAt"), null, "already set: not written");
      // Without unlessSet it merges; undefined values are not written.
      const merged = await store.runs.mergeStartup(id, { providerReturnedAt: "2026-09-26T01:00:02.000Z", warm: undefined });
      assert.equal(merged?.startup?.providerReturnedAt, "2026-09-26T01:00:02.000Z");
      assert.equal("warm" in (merged?.startup ?? {}), false);

      const row = await store.runs.findById(id);
      assert.deepEqual(row?.startup, {
        wakeAt: "2026-09-26T01:00:00.000Z",
        provider: "gke",
        helloAt: "2026-09-26T01:00:05.000Z",
        agentd: { bootMs: 900 },
        providerReturnedAt: "2026-09-26T01:00:02.000Z",
      });
      assert.equal(await store.runs.mergeStartup("no-such-run", { readyAt: "x" }), null);
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
