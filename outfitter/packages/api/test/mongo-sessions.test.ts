// MongoSessions' archive filter and setArchivedAt (#207), and format's per-session deletes and
// formattedSessions record (#208), against a real MongoDB, checked against MemoryStore. The Mongo
// side leans on `{archivedAt: null}` matching a missing field and on `$unset` for restore, neither
// of which MemoryStore exercises.
//
// Starts its own mongod (mongodb-memory-server) unless OUTFITTER_TEST_MONGODB_URI points at one;
// see mongo-tokens.test.ts. Either way it uses a scratch `outfitter_sessiontest_<random>` database
// and drops it afterwards.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoStore } from "../src/store/mongo.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Session, SessionsCollection, Store } from "../src/store/types.ts";

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
  result.claim = Boolean(await sessions.claimForFormat("shelved", "2026-09-27T01:00:00.000Z"));
  result.secondClaim = await sessions.claimForFormat("shelved", "2026-09-27T02:00:00.000Z");
  result.claimLive = await sessions.claimForFormat("live", "2026-09-27T01:00:00.000Z");
  result.restoreWhileClaimed = await sessions.setArchivedAt("shelved", null);
  await sessions.releaseFormatClaim("shelved");
  result.releasedHasField = "formattingAt" in ((await sessions.findById("shelved")) ?? {});
  const restored = await sessions.setArchivedAt("shelved", null);
  result.restoredHasField = restored ? "archivedAt" in restored : "missing";
  result.afterRestore = await ids("exclude");
  // The floppy's model switch: set, then cleared with $unset (not left as null).
  result.modelSet = (await sessions.setModelOverride("live", "litellm/gpt-5-mini", "2026-10-05T00:00:00.000Z"))?.modelOverride;
  const cleared = await sessions.setModelOverride("live", null, "2026-10-05T00:01:00.000Z");
  result.modelClearedHasField = cleared ? "modelOverride" in cleared : "missing";
  result.modelClearedUpdatedAt = cleared?.updatedAt;
  result.modelMissing = await sessions.setModelOverride("no-such-session", "litellm/x", "2026-10-05T00:00:00.000Z");
  // #501: the poller's projected read.
  await sessions.update("live", { ownerEmail: "ada@example.com", checkpoint: { head: "a".repeat(40), pushedAt: "2026-10-07T00:00:00.000Z" } });
  result.streamFacts = await sessions.findStreamFacts("live");
  result.streamFactsBare = await sessions.findStreamFacts("shelved");
  result.streamFactsMissing = await sessions.findStreamFacts("no-such-session");
  return result;
}

/** #503: Auto-fix CI's switch and conditional writes. The Mongo side leans on `"autofix.rev": null`
 * matching a missing field, $inc creating it, and the $unset of the cap on switching on. */
async function exerciseAutofix(sessions: SessionsCollection): Promise<Record<string, unknown>> {
  const tag = randomUUID().slice(0, 8);
  const id = `af-${tag}`;
  const since = "2026-10-01T00:00:00.000Z";
  await sessions.insert(sessionRow(id, { ownerEmail: `${tag}@example.com`, repo: "acme/widgets", branch: "feature", updatedAt: "2026-10-07T00:00:00.000Z" }));
  await sessions.insert(sessionRow(`chat-${tag}`, { autofixCi: true, updatedAt: "2026-10-07T00:00:00.000Z" }));
  await sessions.insert(sessionRow(`old-${tag}`, { autofixCi: true, repo: "acme/widgets", branch: "x", updatedAt: "2026-09-01T00:00:00.000Z" }));
  const listed = async () => (await sessions.listAutofix(since)).filter((s) => s.id.endsWith(tag)).map((s) => s.id.slice(0, 2));
  const result: Record<string, unknown> = { offList: await listed(), offCas: await sessions.casAutofix(id, 0, { rev: 1 }) };
  const on = await sessions.setAutofixCi(id, true);
  result.onRev = on?.autofix?.rev;
  result.onList = await listed();
  result.staleCas = await sessions.casAutofix(id, 0, { rev: 1, polledAt: "x" });
  result.cas = await sessions.casAutofix(id, 1, { rev: 2, polledAt: "p", lastSha: "a".repeat(40), sends: ["s1", "s2", "s3"], cappedAt: "c", cappedSha: "b".repeat(40), capDays: { last: "2026-10-07", count: 2 }, offNotice: "n", nextPollAt: "z", failSeen: { sha: "f", at: "t" } });
  result.again = await sessions.casAutofix(id, 1, { rev: 2 });
  const reOn = await sessions.setAutofixCi(id, true, "2026-10-08T00:00:00.000Z");
  result.reOnUpdatedAt = reOn?.updatedAt;
  result.count = await sessions.countAutofixForOwner(`${tag}@example.com`);
  result.reOn = reOn?.autofix;
  const off = await sessions.setAutofixCi(id, false);
  result.off = { autofixCi: off?.autofixCi, rev: off?.autofix?.rev };
  result.offCasAfter = await sessions.casAutofix(id, 4, { rev: 5 });
  await sessions.setAutofixCi(id, true);
  await sessions.setArchivedAt(id, "2026-10-07T00:00:00.000Z");
  result.archivedCas = await sessions.casAutofix(id, 5, { rev: 6 });
  result.archivedList = await listed();
  result.countAfter = await sessions.countAutofixForOwner(`${tag}@example.com`);
  result.missing = await sessions.setAutofixCi("no-such-session", true);
  return result;
}

/** #208: format's deletes. Rows of the formatted session go; another session's rows, and mail the
 * formatted session sent (keyed by the recipient), stay. */
async function exerciseFormat(store: Store): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const tag = randomUUID().slice(0, 8);
  const gone = `gone-${tag}`;
  const kept = `kept-${tag}`;
  for (const id of [gone, kept]) {
    await store.sessions.insert(sessionRow(id));
    await store.entries.insertIfNew(id, 1, { id: `e-${id}`, type: "message" });
    await store.runs.insert({ id: `r-${id}`, sessionId: id, state: "stopped", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now });
    await store.mail.insertIfNew({ id: `m-${id}`, sessionId: id, from: { kind: "user" }, text: "hi", behavior: "followUp", status: "queued", attempts: 0, createdAt: now });
    await store.browserShares.put({ sessionId: id, tabTitle: "t", tabUrl: "https://example.com", ownerEmail: "a@example.com", createdAt: now });
    await store.browserRequests.insert({ id: `q-${id}`, sessionId: id, requesterEmail: "a@example.com", status: "pending", createdAt: now, updatedAt: now });
    await store.browserCaptures.save(
      { id: `c-${id}`, sessionId: id, requestId: `q-${id}`, ownerEmail: "a@example.com", requesterEmail: "a@example.com", title: "t", url: "https://example.com", bytes: Buffer.from([1]), createdAt: now },
      now,
    );
  }
  await store.mail.insertIfNew({ id: `sent-${tag}`, sessionId: kept, from: { kind: "session", sessionId: gone }, text: "hi", behavior: "followUp", status: "queued", attempts: 0, createdAt: now });

  const deleted = {
    entries: await store.entries.deleteForSession(gone),
    runs: await store.runs.deleteForSession(gone),
    mail: await store.mail.deleteForSession(gone),
    shares: await store.browserShares.deleteForSession(gone),
    requests: await store.browserRequests.deleteForSession(gone),
    captures: await store.browserCaptures.deleteForSession(gone),
    session: await store.sessions.delete(gone),
    sessionAgain: await store.sessions.delete(gone),
  };
  await store.formattedSessions.insert({ id: gone, formattedAt: "2026-09-27T00:00:00.000Z", formattedBy: "first@example.com" });
  await store.formattedSessions.insert({ id: gone, formattedAt: "2026-09-28T00:00:00.000Z", formattedBy: "second@example.com" });
  return {
    deleted,
    kept: {
      session: Boolean(await store.sessions.findById(kept)),
      entries: (await store.entries.listForSession(kept)).length,
      runs: (await store.runs.listForSession(kept)).length,
      mail: Boolean(await store.mail.findById(`m-${kept}`)),
      sentByGone: Boolean(await store.mail.findById(`sent-${tag}`)),
      share: Boolean(await store.browserShares.findBySession(kept)),
      request: Boolean(await store.browserRequests.findById(kept, `q-${kept}`)),
      capture: Boolean(await store.browserCaptures.findById(kept, `c-${kept}`)),
    },
    formattedBy: (await store.formattedSessions.findById(gone))?.formattedBy,
    notFormatted: await store.formattedSessions.findById(kept),
  };
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
      claim: true,
      secondClaim: null,
      claimLive: null,
      restoreWhileClaimed: null,
      releasedHasField: false,
      restoredHasField: false,
      afterRestore: ["live", "shelved"],
      modelSet: "litellm/gpt-5-mini",
      modelClearedHasField: false,
      modelClearedUpdatedAt: "2026-10-05T00:01:00.000Z",
      modelMissing: null,
      streamFacts: { checkpoint: { head: "a".repeat(40), pushedAt: "2026-10-07T00:00:00.000Z" }, ownerEmail: "ada@example.com" },
      streamFactsBare: {},
      streamFactsMissing: null,
    });
  });

  test("#503 Auto-fix's switch, list and conditional writes behave the same as MemoryStore", async () => {
    const mongo = await exerciseAutofix(store.sessions);
    const memory = await exerciseAutofix(new MemoryStore().sessions);
    assert.deepEqual(mongo, memory);
    assert.deepEqual(mongo, {
      offList: [],
      offCas: false,
      onRev: 1,
      onList: ["af"],
      staleCas: false,
      cas: true,
      again: false,
      reOn: { rev: 3, polledAt: "p", lastSha: "a".repeat(40), failSeen: { sha: "f", at: "t" } },
      reOnUpdatedAt: "2026-10-08T00:00:00.000Z",
      count: 1,
      countAfter: 0,
      off: { autofixCi: false, rev: 4 },
      offCasAfter: false,
      archivedCas: false,
      archivedList: [],
      missing: null,
    });
  });

  test("format's deletes and the formattedSessions record behave the same as MemoryStore", async () => {
    const mongo = await exerciseFormat(store);
    const memory = await exerciseFormat(new MemoryStore());
    assert.deepEqual(mongo, memory);
    assert.deepEqual(mongo, {
      deleted: { entries: 1, runs: 1, mail: 1, shares: 1, requests: 1, captures: 1, session: true, sessionAgain: false },
      kept: { session: true, entries: 1, runs: 1, mail: true, sentByGone: true, share: true, request: true, capture: true },
      formattedBy: "first@example.com",
      notFormatted: null,
    });
  });
});
