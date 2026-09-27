// MongoSessions' archive filter and setArchivedAt against a real MongoDB, checked against
// MemoryStore (#207). The Mongo side leans on `{archivedAt: null}` matching a missing field and on
// `$unset` for restore, neither of which MemoryStore exercises.
//
// Starts its own mongod (mongodb-memory-server) unless OUTFITTER_TEST_MONGODB_URI points at one;
// see mongo-tokens.test.ts. Either way it uses a scratch `outfitter_sessiontest_<random>` database
// and drops it afterwards.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Session, SessionsCollection } from "../src/store/types.ts";

const EXTERNAL_URI = process.env.OUTFITTER_TEST_MONGODB_URI;
const DB_NAME = `outfitter_sessiontest_${randomUUID().slice(0, 8)}`;

function sessionRow(id: string, overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return { id, guruId: "g", repo: null, status: "open", cost: 0, createdAt: now, updatedAt: now, ...overrides };
}

async function exercise(sessions: SessionsCollection): Promise<Record<string, unknown>> {
  await sessions.insert(sessionRow("live"));
  await sessions.insert(sessionRow("shelved"));
  const archived = await sessions.setArchivedAt("shelved", "2026-09-27T00:00:00.000Z");
  const ids = async (archived?: "exclude" | "only" | "all") => (await sessions.list({ archived })).map((s) => s.id).sort();
  const result: Record<string, unknown> = {
    archivedAt: archived?.archivedAt,
    default: await ids(),
    exclude: await ids("exclude"),
    only: await ids("only"),
    all: await ids("all"),
    missing: await sessions.setArchivedAt("no-such-session", "2026-09-27T00:00:00.000Z"),
  };
  const restored = await sessions.setArchivedAt("shelved", null);
  result.restoredHasField = restored ? "archivedAt" in restored : "missing";
  result.afterRestore = await ids("exclude");
  return result;
}

describe("MongoSessions archive filter against a real MongoDB", () => {
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

  test("list's archived filter and setArchivedAt behave the same as MemoryStore", async () => {
    const mongo = await exercise(store.sessions);
    const memory = await exercise(new MemoryStore().sessions);
    assert.deepEqual(mongo, memory);
    assert.deepEqual(mongo, {
      archivedAt: "2026-09-27T00:00:00.000Z",
      default: ["live", "shelved"],
      exclude: ["live"],
      only: ["shelved"],
      all: ["live", "shelved"],
      missing: null,
      restoredHasField: false,
      afterRestore: ["live", "shelved"],
    });
  });
});
