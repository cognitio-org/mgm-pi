// MongoPreviews (#217, Drive previews) against a real MongoDB, checked against MemoryStore: the open
// filters rely on `closedAt: {$exists: false}` and markClosed on findOneAndUpdate's returned
// document, neither of which MemoryStore exercises.
//
// Starts its own mongod (mongodb-memory-server) unless OUTFITTER_TEST_MONGODB_URI points at one;
// see mongo-tokens.test.ts. Either way it uses a scratch `outfitter_previewtest_<random>` database
// and drops it afterwards.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Preview, PreviewsCollection } from "../src/store/types.ts";

const EXTERNAL_URI = process.env.OUTFITTER_TEST_MONGODB_URI;
const DB_NAME = `outfitter_previewtest_${randomUUID().slice(0, 8)}`;

function preview(id: string, overrides: Partial<Preview> = {}): Preview {
  return {
    id, runId: "r1", sessionId: "s1", port: 3000, share: false, url: `https://${id}.kernal.run`, endpointId: `ep_${id}`,
    internalUrl: "https://p3000.rr1.internal", createdAt: "2026-09-28T10:00:00.000Z", ...overrides,
  };
}

async function exercise(previews: PreviewsCollection): Promise<Record<string, unknown>> {
  await previews.insert(preview("a"));
  await previews.insert(preview("b", { share: true, expiresAt: "2026-09-29T10:00:00.000Z" }));
  await previews.insert(preview("c", { port: 4000 }));
  await previews.insert(preview("d", { runId: "r2", sessionId: "s2" }));
  const ids = (ps: Preview[]) => ps.map((p) => p.id).sort();
  const result: Record<string, unknown> = {
    findSecure: (await previews.findOpen("r1", 3000, false))?.id,
    findShare: (await previews.findOpen("r1", 3000, true))?.expiresAt,
    findNone: await previews.findOpen("r1", 5000, false),
    run: ids(await previews.listOpenForRun("r1")),
    session: ids(await previews.listOpenForSession("s2")),
  };
  result.closed = await previews.markClosed("a", "2026-09-28T11:00:00.000Z", "closed");
  result.closeAgain = await previews.markClosed("a", "2026-09-28T12:00:00.000Z", "closed");
  result.closeMissing = await previews.markClosed("nope", "2026-09-28T12:00:00.000Z", "closed");
  result.afterClose = ids(await previews.listOpenForRun("r1"));
  result.findClosed = await previews.findOpen("r1", 3000, false);
  result.open = ids(await previews.listOpen());
  return result;
}

describe("MongoPreviews against a real MongoDB", () => {
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

  test("open filters and markClosed behave the same as MemoryStore", async () => {
    const mongo = await exercise(store.previews);
    const memory = await exercise(new MemoryStore().previews);
    assert.deepEqual(mongo, memory);
    assert.equal((mongo.closed as Preview).closedReason, "closed");
    assert.equal(mongo.closeAgain, null);
    assert.deepEqual(mongo.afterClose, ["b", "c"]);
  });
});
