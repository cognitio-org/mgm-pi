// E9 PR4: aeAgents (the allowlist) and aeSessions (Agent Engine sessions to stop) against a real
// MongoDB (mongodb-memory-server, or OUTFITTER_TEST_MONGODB_URI -- see mongo-tokens.test.ts).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import { AE_SESSION_EXECUTIONS, type AeAgent } from "../src/store/types.ts";

const EXTERNAL_URI = process.env.OUTFITTER_TEST_MONGODB_URI;
const DB_NAME = `outfitter_aetest_${randomUUID().slice(0, 8)}`;

describe("Mongo aeAgents and aeSessions", () => {
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

  const at = "2026-10-01T00:00:00.000Z";
  const agent = (id: string, workspaceId: string): AeAgent => ({ id, workspaceId, name: id, description: "", enabled: true, createdAt: at, updatedAt: at });

  test("aeAgents: one per id and per workspace; update, list (ISO dates, no _id), delete", async () => {
    assert.equal(await store.aeAgents.insert(agent("researcher", "ws-1")), true);
    assert.equal(await store.aeAgents.insert(agent("researcher", "ws-2")), false, "same id");
    assert.equal(await store.aeAgents.insert(agent("other", "ws-1")), false, "same workspace");
    assert.equal(await store.aeAgents.insert(agent("writer", "ws-2")), true);
    assert.equal(await store.aeAgents.update("writer", { workspaceId: "ws-1" }), "duplicate");
    const updated = await store.aeAgents.update("writer", { enabled: false, updatedAt: "2026-10-01T01:00:00.000Z" });
    assert.ok(updated && updated !== "duplicate");
    assert.equal(updated.enabled, false);
    assert.equal(await store.aeAgents.update("missing", { enabled: true }), null);
    const list = await store.aeAgents.list();
    assert.deepEqual(list.map((a) => [a.id, a.enabled, typeof a.createdAt]), [["researcher", true, "string"], ["writer", false, "string"]]);
    assert.equal((list[0] as { _id?: unknown })._id, undefined);
    assert.equal(await store.aeAgents.delete("writer"), true);
    assert.equal(await store.aeAgents.delete("writer"), false);
  });

  test("aeSessions: record, find by execution, conditional stop, reopen, cap, delete", async () => {
    const key = { outfitterSessionId: "s1", agentId: "researcher", workspaceId: "ws-1", aeSessionId: "outf-s1-researcher" };
    const first = await store.aeSessions.recordInvoke(key, undefined, at);
    assert.deepEqual([first.id, first.executions, first.openedAt], ["s1:researcher", [], at]);
    const second = await store.aeSessions.recordInvoke(key, "e1", "2026-10-01T00:01:00.000Z");
    assert.deepEqual([second.executions, second.openedAt, second.lastUsedAt], [["e1"], at, "2026-10-01T00:01:00.000Z"]);
    assert.equal((await store.aeSessions.findByExecution("s1", "e1"))?.id, "s1:researcher");
    assert.equal(await store.aeSessions.findByExecution("s2", "e1"), null, "another session's execution");
    assert.equal(await store.aeSessions.markStopped("s1:researcher", at, "2026-10-01T00:02:00.000Z"), false, "used since");
    assert.equal(await store.aeSessions.recordStopFailure("s1:researcher", second.lastUsedAt, "boom"), 1);
    assert.equal(await store.aeSessions.recordStopFailure("s1:researcher", second.lastUsedAt, "boom"), 2);
    assert.equal(await store.aeSessions.markStopped("s1:researcher", second.lastUsedAt, "2026-10-01T00:02:00.000Z", "gave up"), true);
    assert.deepEqual(await store.aeSessions.listOpen(10), []);
    const reopened = await store.aeSessions.recordInvoke(key, "e2", "2026-10-01T00:03:00.000Z");
    assert.deepEqual([reopened.stoppedAt, reopened.stopAttempts, reopened.stopError, reopened.executions], [undefined, undefined, undefined, ["e1", "e2"]]);
    for (let i = 0; i < AE_SESSION_EXECUTIONS + 5; i++) await store.aeSessions.recordInvoke(key, `x${i}`, "2026-10-01T00:04:00.000Z");
    const [open] = await store.aeSessions.listOpenForSession("s1");
    assert.equal(open.executions.length, AE_SESSION_EXECUTIONS);
    assert.equal(open.executions.at(-1), `x${AE_SESSION_EXECUTIONS + 4}`);
    assert.equal((open as { _id?: unknown })._id, undefined);
    // touch (E9.10: a laptop's get counts as use): lastUsedAt moves, the row reopens, executions stay.
    assert.equal(await store.aeSessions.markStopped("s1:researcher", open.lastUsedAt, "2026-10-01T00:05:00.000Z"), true);
    await store.aeSessions.touch("s1:researcher", "2026-10-01T00:06:00.000Z");
    await store.aeSessions.touch("s9:nobody", "2026-10-01T00:06:00.000Z");
    const [touched] = await store.aeSessions.listOpenForSession("s1");
    assert.deepEqual([touched.lastUsedAt, touched.stoppedAt, touched.executions.length], ["2026-10-01T00:06:00.000Z", undefined, AE_SESSION_EXECUTIONS]);
    assert.equal((await store.aeSessions.listOpen(10)).length, 1, "no row made for an unknown id");
    assert.equal(await store.aeSessions.deleteForSession("s1"), 1);
    assert.deepEqual(await store.aeSessions.listOpen(10), []);
  });
});
