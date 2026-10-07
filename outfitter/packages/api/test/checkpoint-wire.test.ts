// #501: the checkpoint the browser sees: git facts only, and a push time only when one was recorded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp } from "./helpers.ts";
import { checkpointEvent, lastPush, sessionForWire } from "../src/checkpoint-wire.ts";
import { MemoryStore } from "../src/store/memory.ts";

const head = "a".repeat(40);
const landedAt = "2026-10-07T10:05:00.000Z";
const checkpoint = {
  branch: "outfitter/s1",
  head,
  at: landedAt,
  landed: true,
  landedAt,
  snapshotUrl: "https://storage.googleapis.com/bucket/s1/snapshot.tar.gz",
  workspaceUrl: "https://storage.googleapis.com/bucket/s1/workspace.tar.gz",
};

test("GET /api/sessions/:id carries no snapshot or workspace URL, and no push time it didn't record", async () => {
  const app = await buildTestApp();
  try {
    const now = new Date().toISOString();
    await app.store.sessions.insert({
      id: "s1",
      guruId: "g",
      repo: "acme/widget",
      branch: "outfitter/s1",
      status: "open",
      cost: 0,
      createdAt: now,
      updatedAt: now,
      checkpoint,
    });
    const res = await app.fastify.inject({ method: "GET", url: "/api/sessions/s1" });
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /snapshotUrl|workspaceUrl|storage\.googleapis/);
    const body = res.json();
    // Teleport (kernal's OutfitterStore) reads checkpoint.head.
    assert.equal(body.checkpoint.head, head);
    // A row from before pushedAt: the sha, with no time (landedAt moves on no-op re-lands).
    assert.deepEqual(body.lastPush, { sha: head, branch: "outfitter/s1", pushed: false });
  } finally {
    app.stopBackgroundTasks();
    await app.fastify.close();
  }
});

test("sessionForWire and checkpointEvent drop the URLs; lastPush uses pushedAt only", () => {
  const withCheckpoint: { id: string; checkpoint?: typeof checkpoint } = { id: "s1", checkpoint };
  assert.deepEqual(sessionForWire(withCheckpoint), { id: "s1", checkpoint: { branch: "outfitter/s1", head, at: landedAt, landed: true, landedAt } });
  const bare: { id: string; checkpoint?: typeof checkpoint } = { id: "s2" };
  assert.deepEqual(sessionForWire(bare), { id: "s2" });
  assert.equal("snapshotUrl" in checkpointEvent(checkpoint), false);
  const pushedAt = "2026-10-07T10:00:00.000Z";
  assert.deepEqual(lastPush({ ...checkpoint, pushed: true, pushedAt }), { sha: head, branch: "outfitter/s1", at: pushedAt, pushed: true });
  assert.equal(lastPush({ branch: "x" }), null);
  assert.equal(lastPush(undefined), null);
});

test("findStreamFacts reads just the checkpoint and owner", async () => {
  const store = new MemoryStore();
  const now = new Date().toISOString();
  await store.sessions.insert({
    id: "s1",
    guruId: "g",
    repo: null,
    status: "open",
    cost: 0,
    createdAt: now,
    updatedAt: now,
    ownerEmail: "ada@example.com",
    checkpoint: { head },
  });
  assert.deepEqual(await store.sessions.findStreamFacts("s1"), { checkpoint: { head }, ownerEmail: "ada@example.com" });
  assert.equal(await store.sessions.findStreamFacts("missing"), null);
});
