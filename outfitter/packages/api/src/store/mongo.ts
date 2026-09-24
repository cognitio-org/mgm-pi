// Mongo-backed Store. Connects lazily (connectMongoStore) so importing this module never dials
// out; only MONGODB_URI values other than "memory" reach it (see index.ts).

import { Binary, MongoClient, type Collection as MongoCollection, type Db, type Filter } from "mongodb";
import type {
  Store,
  Session,
  SessionListFilter,
  SessionsCollection,
  Entry,
  EntriesCollection,
  PiEntry,
  Run,
  GithubIdempotencyRecord,
  RunState,
  RunsCollection,
  DownMessage,
  Guru,
  GurusCollection,
  Environment,
  EnvironmentsCollection,
  User,
  UsersCollection,
  ProviderRecord,
  ProvidersCollection,
  ApiToken,
  TokensCollection,
  TokenOwnerMatch,
  Mail,
  MailCollection,
  BrowserShare,
  BrowserSharesCollection,
  BrowserRequest,
  BrowserRequestsCollection,
  BrowserCapture,
  BrowserCaptureFailure,
  BrowserCapturesCollection,
  BrowserCaptureSave,
} from "./types.ts";
import { BROWSER_CAPTURES_PER_SESSION } from "./types.ts";
import { TOKEN_TTL_MS } from "../tokens.ts";

// Typed as RunState[], not inferred as string[]: used in a Mongo `$in` filter against Run.state,
// which the mongodb driver's Filter<T> types as a union of the literal RunState strings.
const ACTIVE_RUN_STATES: RunState[] = ["queued", "provisioning", "running", "idle", "stopping"];

// Every collection here stores its own `id` field as Mongo's `_id` (see each class's `insert`) so
// reads need to drop `_id` before returning the document as its public type T. Not every T has an
// `id` field of its own (Entry keys off `sessionId`+`seq`, User off `email`), so this is
// deliberately unconstrained; callers pin T down with an explicit type argument (`stripId<Session>`
// etc.) rather than relying on inference, which is what let `T` silently default to the wrong type
// in practice before this fix.
function stripId<T>(doc: (T & { _id?: unknown }) | null): T | null {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest as T;
}

/** Same as stripId, for a result already known to exist (e.g. mapping a find().toArray()). */
function stripIdStrict<T>(doc: T & { _id?: unknown }): T {
  const { _id, ...rest } = doc;
  return rest as T;
}

class MongoSessions implements SessionsCollection {
  private readonly col: MongoCollection<Session & { _id: string }>;

  constructor(col: MongoCollection<Session & { _id: string }>) {
    this.col = col;
  }

  async insert(session: Session): Promise<void> {
    await this.col.insertOne({ ...session, _id: session.id });
  }

  async findById(id: string): Promise<Session | null> {
    return stripId<Session>(await this.col.findOne({ _id: id }));
  }

  async list(filter?: SessionListFilter): Promise<Session[]> {
    const query: Record<string, unknown> = {};
    if (filter?.status) query.status = filter.status;
    if (filter?.guruId) query.guruId = filter.guruId;
    const rows = await this.col.find(query).sort({ updatedAt: -1 }).toArray();
    return rows.map((r) => stripIdStrict<Session>(r));
  }

  async update(id: string, patch: Partial<Session>): Promise<Session | null> {
    const result = await this.col.findOneAndUpdate(
      { _id: id },
      { $set: patch },
      { returnDocument: "after" },
    );
    return stripId<Session>(result);
  }
}

class MongoEntries implements EntriesCollection {
  private readonly col: MongoCollection<Entry & { _id?: unknown }>;

  constructor(col: MongoCollection<Entry & { _id?: unknown }>) {
    this.col = col;
  }

  async insertIfNew(sessionId: string, seq: number, entry: PiEntry, blobRef?: string): Promise<boolean> {
    try {
      await this.col.insertOne({ sessionId, seq, entry, blobRef });
      return true;
    } catch (err) {
      // duplicate key on the unique {sessionId, "entry.id"} index: already persisted, ignore.
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  }

  async findByEntryId(sessionId: string, entryId: string): Promise<Entry | null> {
    const row = await this.col.findOne({ sessionId, "entry.id": entryId });
    return row ? stripIdStrict<Entry>(row) : null;
  }

  async listForSession(sessionId: string, afterEntryId?: string): Promise<Entry[]> {
    let afterSeq = -1;
    if (afterEntryId) {
      const marker = await this.col.findOne({ sessionId, "entry.id": afterEntryId });
      afterSeq = marker?.seq ?? -1;
    }
    const rows = await this.col
      .find({ sessionId, seq: { $gt: afterSeq } })
      .sort({ seq: 1 })
      .toArray();
    return rows.map((r) => stripIdStrict<Entry>(r));
  }

  async listRecent(sessionId: string, limit: number): Promise<Entry[]> {
    // _id is the driver-generated ObjectId (time + counter), i.e. insertion order -- see
    // EntriesCollection.listRecent for why seq can't be used here. Served by {sessionId, _id}.
    const rows = await this.col.find({ sessionId }).sort({ _id: -1 }).limit(limit).toArray();
    return rows.reverse().map((r) => stripIdStrict<Entry>(r));
  }

  async maxSeq(sessionId: string): Promise<number> {
    const row = await this.col.find({ sessionId }).sort({ seq: -1 }).limit(1).next();
    return row?.seq ?? 0;
  }
}

class MongoRuns implements RunsCollection {
  private readonly col: MongoCollection<Run & { _id: string }>;

  constructor(col: MongoCollection<Run & { _id: string }>) {
    this.col = col;
  }

  async insert(run: Run): Promise<void> {
    await this.col.insertOne({ ...run, _id: run.id });
  }

  async insertIfNoActive(run: Run): Promise<{ run: Run; inserted: boolean }> {
    // Relies on the partial unique index over active runs per session (ensureIndexes). The loser of
    // a race gets a duplicate-key error and returns the winner; the retry covers the winner having
    // already left the active states between our insert and our read.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.insert(run);
        return { run, inserted: true };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const existing = await this.findActiveForSession(run.sessionId);
        if (existing) return { run: existing, inserted: false };
      }
    }
    throw new Error(`could not start or find an active run for session ${run.sessionId}`);
  }

  async findById(id: string): Promise<Run | null> {
    return stripId<Run>(await this.col.findOne({ _id: id }));
  }

  async findActiveForSession(sessionId: string): Promise<Run | null> {
    return stripId<Run>(await this.col.findOne({ sessionId, state: { $in: ACTIVE_RUN_STATES } }));
  }

  async findLatestForSession(sessionId: string): Promise<Run | null> {
    const rows = await this.col.find({ sessionId }).sort({ updatedAt: -1 }).limit(1).toArray();
    return stripId<Run>(rows[0] ?? null);
  }

  async update(id: string, patch: Partial<Run>): Promise<Run | null> {
    const result = await this.col.findOneAndUpdate(
      { _id: id },
      { $set: patch },
      { returnDocument: "after" },
    );
    return stripId<Run>(result);
  }

  async claimGithubIdempotency(id: string, key: string, pending: GithubIdempotencyRecord) {
    const path = `githubIdempotency.${key}`;
    const won = await this.col.findOneAndUpdate(
      { _id: id, [path]: { $exists: false } },
      { $set: { [path]: pending } },
      { returnDocument: "after" },
    );
    if (won) return { status: "claimed" as const };
    const run = await this.findById(id);
    if (!run) return { status: "missing" as const };
    const record = run.githubIdempotency?.[key];
    if (!record) return { status: "missing" as const };
    return { status: "existing" as const, record };
  }

  async finishGithubIdempotency(id: string, key: string, result: GithubIdempotencyRecord): Promise<void> {
    await this.col.updateOne({ _id: id }, { $set: { [`githubIdempotency.${key}`]: result } });
  }

  async listStale(cutoffIso: string): Promise<Run[]> {
    const rows = await this.col
      .find({
        state: { $in: ACTIVE_RUN_STATES },
        $or: [{ lastSeenAt: { $lt: cutoffIso } }, { lastSeenAt: { $exists: false }, createdAt: { $lt: cutoffIso } }],
      })
      .toArray();
    return rows.map((r) => stripIdStrict<Run>(r));
  }

  async listStopping(cutoffIso: string): Promise<Run[]> {
    const rows = await this.col.find({ state: "stopping", updatedAt: { $lt: cutoffIso } }).toArray();
    return rows.map((r) => stripIdStrict<Run>(r));
  }

  async enqueueDownMessage(id: string, message: DownMessage): Promise<void> {
    await this.col.updateOne({ _id: id }, { $push: { pending: message } });
  }

  async drainDownMessages(id: string): Promise<DownMessage[]> {
    const result = await this.col.findOneAndUpdate(
      { _id: id },
      { $set: { pending: [] } },
      { returnDocument: "before" },
    );
    return result?.pending ?? [];
  }
}

class MongoGurus implements GurusCollection {
  private readonly col: MongoCollection<Guru & { _id: string }>;

  constructor(col: MongoCollection<Guru & { _id: string }>) {
    this.col = col;
  }

  async insert(guru: Guru): Promise<void> {
    await this.col.insertOne({ ...guru, _id: guru.id });
  }

  async findById(id: string): Promise<Guru | null> {
    return stripId<Guru>(await this.col.findOne({ _id: id }));
  }

  async list(): Promise<Guru[]> {
    const rows = await this.col.find({}).toArray();
    return rows.map((r) => stripIdStrict<Guru>(r));
  }

  async update(id: string, patch: Partial<Guru>): Promise<Guru | null> {
    const result = await this.col.findOneAndUpdate(
      { _id: id },
      { $set: patch },
      { returnDocument: "after" },
    );
    return stripId<Guru>(result);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.col.deleteOne({ _id: id });
    return (result.deletedCount ?? 0) > 0;
  }
}

class MongoEnvironments implements EnvironmentsCollection {
  private readonly col: MongoCollection<Environment & { _id: string }>;

  constructor(col: MongoCollection<Environment & { _id: string }>) {
    this.col = col;
  }

  async insert(environment: Environment): Promise<void> {
    await this.col.insertOne({ ...environment, _id: environment.id });
  }

  async findById(id: string): Promise<Environment | null> {
    return stripId<Environment>(await this.col.findOne({ _id: id }));
  }

  async list(): Promise<Environment[]> {
    const rows = await this.col.find({}).toArray();
    return rows.map((r) => stripIdStrict<Environment>(r));
  }

  async update(id: string, patch: Partial<Environment>): Promise<Environment | null> {
    const result = await this.col.findOneAndUpdate(
      { _id: id },
      { $set: patch },
      { returnDocument: "after" },
    );
    return stripId<Environment>(result);
  }
}

class MongoUsers implements UsersCollection {
  private readonly col: MongoCollection<User & { _id: string }>;

  constructor(col: MongoCollection<User & { _id: string }>) {
    this.col = col;
  }

  async upsertSeen(email: string): Promise<User> {
    const now = new Date().toISOString();
    const result = await this.col.findOneAndUpdate(
      { _id: email },
      { $set: { lastSeenAt: now }, $setOnInsert: { email, createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    return stripId<User>(result) as User; // upsert:true guarantees a document comes back
  }

  async findByEmail(email: string): Promise<User | null> {
    return stripId<User>(await this.col.findOne({ _id: email }));
  }
}

class MongoProviders implements ProvidersCollection {
  private readonly col: MongoCollection<ProviderRecord & { _id: string }>;

  constructor(col: MongoCollection<ProviderRecord & { _id: string }>) {
    this.col = col;
  }

  async findById(id: string): Promise<ProviderRecord | null> {
    return stripId<ProviderRecord>(await this.col.findOne({ _id: id }));
  }

  async list(): Promise<ProviderRecord[]> {
    const rows = await this.col.find({}).sort({ _id: 1 }).toArray();
    return rows.map((r) => stripIdStrict<ProviderRecord>(r));
  }

  async upsert(record: ProviderRecord): Promise<void> {
    // $set (not replaceOne) so TypeScript's WithoutId<T> replacement typing (which excludes _id)
    // doesn't need a cast here; upsert:true still gives whole-record-replace semantics in practice
    // since every field on ProviderRecord is set every time.
    await this.col.updateOne({ _id: record.id }, { $set: record }, { upsert: true });
  }
}

class MongoTokens implements TokensCollection {
  private readonly col: MongoCollection<ApiToken & { _id: string }>;

  constructor(col: MongoCollection<ApiToken & { _id: string }>) {
    this.col = col;
  }

  async insert(token: ApiToken): Promise<void> {
    await this.col.insertOne({ ...token, _id: token.id });
  }

  async findById(id: string): Promise<ApiToken | null> {
    return stripId<ApiToken>(await this.col.findOne({ _id: id }));
  }

  async findByHash(hash: string): Promise<ApiToken | null> {
    return stripId<ApiToken>(await this.col.findOne({ hash }));
  }

  async listActiveForOwner(ownerEmail: string): Promise<ApiToken[]> {
    const rows = await this.col
      .find({ ownerEmail, ...activeTokenFilter(Date.now()) })
      .sort({ createdAt: -1 })
      .toArray();
    return rows.map((r) => stripIdStrict<ApiToken>(r));
  }

  async countActiveForOwner(ownerEmail: string): Promise<number> {
    return this.col.countDocuments({ ownerEmail, ...activeTokenFilter(Date.now()) });
  }

  async update(id: string, patch: Partial<ApiToken>): Promise<ApiToken | null> {
    const result = await this.col.findOneAndUpdate(
      { _id: id },
      { $set: patch },
      { returnDocument: "after" },
    );
    return stripId<ApiToken>(result);
  }

  /** Three steps, no transaction: collect the active matching tokens' ids, stamp this call's
   * `revokedAt` on them, then read those same ids back at that stamp. Anything another caller
   * revoked in between keeps its own timestamp and is left out of the result, and a concurrent
   * revoke can't have its tokens reported here even if it used the same millisecond. */
  async revokeAllForOwners(match: TokenOwnerMatch, revokedAt: string): Promise<ApiToken[]> {
    const owner = ownerEmailFilter(match);
    const ids = (await this.col.find({ ownerEmail: owner, ...activeTokenFilter(Date.now()) }, { projection: { _id: 1 } }).toArray())
      .map((r) => r._id);
    if (ids.length === 0) return [];
    await this.col.updateMany({ _id: { $in: ids }, ...notRevokedFilter() }, { $set: { revokedAt } });
    // Read back by the ids this call selected, not by `revokedAt` alone: two revokes landing in the
    // same millisecond (two operators, or one call matching overlapping sets) would otherwise each
    // report the other's tokens. A token another caller revoked in between keeps its own timestamp,
    // so it drops out here -- which is the point.
    const rows = await this.col.find({ _id: { $in: ids }, revokedAt }).toArray();
    return rows.map((r) => stripIdStrict<ApiToken>(r));
  }
}

/** Mongo form of tokens.ts's isTokenActive. `null` matches a missing field as well as an explicit
 * null, and ISO-8601 strings in the same format compare correctly as strings. A token minted
 * before expiresAt existed is live while its createdAt is within TOKEN_TTL_MS. */
function activeTokenFilter(nowMs: number): Filter<ApiToken & { _id: string }> {
  // The cast is for `null`: the driver types an optional field's condition as string | undefined,
  // but Mongo's own `field: null` is the one filter that matches both absent and null.
  return {
    revokedAt: null,
    $or: [
      { expiresAt: { $gt: new Date(nowMs).toISOString() } },
      { expiresAt: null, createdAt: { $gt: new Date(nowMs - TOKEN_TTL_MS).toISOString() } },
    ],
  } as unknown as Filter<ApiToken & { _id: string }>;
}

/** `revokedAt` absent or null -- the same "not revoked" test activeTokenFilter makes, for a filter
 * that has already narrowed to specific ids. Cast for the same reason as activeTokenFilter. */
function notRevokedFilter(): Filter<ApiToken & { _id: string }> {
  return { revokedAt: null } as unknown as Filter<ApiToken & { _id: string }>;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive, anchored ownerEmail match for a normalized TokenOwnerMatch -- the Mongo
 * equivalent of tokens.ts's ownerMatches, which trims the stored email first; the `\s*` on each end
 * does the same here (and also absorbs the trailing newline PCRE's `$` would otherwise let through
 * on its own). A regex can't use the ownerEmail index, which is fine for a rare operator action
 * over a small collection. */
export function ownerEmailFilter(match: TokenOwnerMatch): RegExp {
  return "email" in match
    ? new RegExp(`^\\s*${escapeRegex(match.email)}\\s*$`, "i")
    : new RegExp(`${escapeRegex(match.domain)}\\s*$`, "i");
}

const ACKED_MAIL_TTL_MS = 7 * 24 * 60 * 60_000;

type MailDoc = Mail & { _id: string; expireAt?: Date };

function deliverableFilter(nowIso: string, maxAttempts: number) {
  return {
    attempts: { $lt: maxAttempts },
    $or: [{ status: "queued" as const }, { status: "delivered" as const, lockedUntil: { $lt: nowIso } }],
  };
}

class MongoMail implements MailCollection {
  private readonly col: MongoCollection<MailDoc>;

  constructor(col: MongoCollection<MailDoc>) {
    this.col = col;
  }

  async insertIfNew(mail: Mail): Promise<boolean> {
    try {
      await this.col.insertOne({ ...mail, _id: mail.id });
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  }

  async claimNext(
    sessionId: string,
    runId: string,
    nowIso: string,
    leaseUntilIso: string,
    maxAttempts: number,
  ): Promise<Mail | null> {
    const result = await this.col.findOneAndUpdate(
      { sessionId, ...deliverableFilter(nowIso, maxAttempts) },
      {
        $set: { status: "delivered", deliveredRunId: runId, deliveredAt: nowIso, lockedUntil: leaseUntilIso },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
    return stripMail(result);
  }

  async ack(id: string, runId: string, nowIso: string): Promise<void> {
    // expireAt is Mongo-only: the TTL index needs a BSON date, and every other timestamp here is an
    // ISO string shared with MemoryStore.
    await this.col.updateOne(
      { _id: id, status: "delivered", deliveredRunId: runId },
      { $set: { status: "acked", ackedAt: nowIso, expireAt: new Date(Date.parse(nowIso) + ACKED_MAIL_TTL_MS) } },
    );
  }

  async chargeWake(sessionId: string, nowIso: string, maxAttempts: number): Promise<void> {
    await this.col.updateMany({ sessionId, ...deliverableFilter(nowIso, maxAttempts) }, { $inc: { attempts: 1 } });
  }

  async releaseRun(runId: string): Promise<void> {
    await this.col.updateMany(
      { status: "delivered", deliveredRunId: runId },
      { $set: { status: "queued" }, $unset: { lockedUntil: "" } },
    );
  }

  async noteWake(sessionId: string, nowIso: string, maxAttempts: number): Promise<void> {
    await this.col.updateMany({ sessionId, ...deliverableFilter(nowIso, maxAttempts) }, { $inc: { unvalidatedWakes: 1 } });
  }

  async markValidated(sessionId: string): Promise<void> {
    await this.col.updateMany(
      { sessionId, status: { $ne: "held" as const }, unvalidatedWakes: { $exists: true } },
      { $unset: { unvalidatedWakes: "" } },
    );
  }

  async holdIfStuck(sessionId: string, nowIso: string, maxAttempts: number, maxUnvalidatedWakes: number): Promise<number> {
    const deliverable = { sessionId, ...deliverableFilter(nowIso, maxAttempts) };
    const alreadyHeld = (await this.col.countDocuments({ sessionId, status: "held" }, { limit: 1 })) > 0;
    const stuck =
      alreadyHeld ||
      (await this.col.countDocuments({ ...deliverable, unvalidatedWakes: { $gte: maxUnvalidatedWakes } }, { limit: 1 })) > 0;
    if (stuck) {
      await this.col.updateMany(deliverable, { $set: { status: "held", heldAt: nowIso }, $unset: { lockedUntil: "" } });
    }
    return this.col.countDocuments({ sessionId, status: "held" });
  }

  async releaseHeld(sessionId?: string): Promise<string[]> {
    const filter = { status: "held" as const, ...(sessionId ? { sessionId } : {}) };
    const sessions = await this.col.distinct("sessionId", filter);
    if (sessions.length === 0) return [];
    await this.col.updateMany(filter, { $set: { status: "queued" }, $unset: { heldAt: "", unvalidatedWakes: "" } });
    return sessions;
  }

  async countHeld(sessionId: string): Promise<number> {
    return this.col.countDocuments({ sessionId, status: "held" });
  }

  async expireExhausted(nowIso: string, maxAttempts: number): Promise<Mail[]> {
    const idleExhausted = {
      attempts: { $gte: maxAttempts },
      $or: [{ status: "queued" as const }, { status: "delivered" as const, lockedUntil: { $lt: nowIso } }],
    };
    const dead: Mail[] = [];
    // One findOneAndUpdate per mail so each is returned exactly once even with two sweeps racing.
    for (;;) {
      const doc = await this.col.findOneAndUpdate(
        idleExhausted,
        { $set: { status: "dead", deadAt: nowIso, expireAt: new Date(Date.parse(nowIso) + ACKED_MAIL_TTL_MS) } },
        { returnDocument: "after" },
      );
      const mail = stripMail(doc);
      if (!mail) return dead;
      dead.push(mail);
    }
  }

  async countSentSince(fromSessionId: string, sinceIso: string): Promise<number> {
    return this.col.countDocuments({ "from.sessionId": fromSessionId, createdAt: { $gte: sinceIso } });
  }

  async hasDeliverable(sessionId: string, nowIso: string, maxAttempts: number): Promise<boolean> {
    return (await this.col.countDocuments({ sessionId, ...deliverableFilter(nowIso, maxAttempts) }, { limit: 1 })) > 0;
  }

  async sessionsWithDeliverable(nowIso: string, maxAttempts: number): Promise<string[]> {
    return this.col.distinct("sessionId", deliverableFilter(nowIso, maxAttempts));
  }

  async findById(id: string): Promise<Mail | null> {
    return stripMail(await this.col.findOne({ _id: id }));
  }
}

function stripMail(doc: MailDoc | null): Mail | null {
  if (!doc) return null;
  const { _id, expireAt, ...rest } = doc;
  return rest;
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: number }).code === 11000;
}

type BrowserShareDoc = BrowserShare & { _id: string };
type BrowserRequestDoc = BrowserRequest & { _id: string };
type BrowserCaptureDoc = BrowserCapture & { _id: string };

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Binary) return Buffer.from(value.value());
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.alloc(0);
}

function stripCapture(doc: BrowserCaptureDoc | null): BrowserCapture | null {
  const row = stripId<BrowserCapture>(doc);
  if (!row) return null;
  return { ...row, bytes: toBuffer(row.bytes) };
}

/** Drops `_id` and the internal `_rev` bump insertPendingIfShared uses to conflict with revoke. */
function shareView(doc: (BrowserShareDoc & { _rev?: number }) | null): BrowserShare | null {
  if (!doc) return null;
  return {
    sessionId: doc.sessionId,
    tabTitle: doc.tabTitle,
    tabUrl: doc.tabUrl,
    ownerEmail: doc.ownerEmail,
    createdAt: doc.createdAt,
  };
}

class MongoBrowserShares implements BrowserSharesCollection {
  private readonly shares: MongoCollection<BrowserShareDoc>;
  private readonly requests: MongoCollection<BrowserRequestDoc>;
  private readonly client: MongoClient;

  constructor(shares: MongoCollection<BrowserShareDoc>, requests: MongoCollection<BrowserRequestDoc>, client: MongoClient) {
    this.shares = shares;
    this.requests = requests;
    this.client = client;
  }

  async findBySession(sessionId: string): Promise<BrowserShare | null> {
    return shareView(await this.shares.findOne({ _id: sessionId }));
  }

  async put(share: BrowserShare): Promise<{ conflict: false; share: BrowserShare } | { conflict: true; share: BrowserShare }> {
    try {
      await this.shares.insertOne({ ...share, _id: share.sessionId });
      return { conflict: false, share };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
    const existing = await this.findBySession(share.sessionId);
    if (!existing) {
      await this.shares.insertOne({ ...share, _id: share.sessionId });
      return { conflict: false, share };
    }
    if (existing.ownerEmail !== share.ownerEmail) return { conflict: true, share: existing };
    const updated = await this.shares.findOneAndUpdate(
      { _id: share.sessionId, ownerEmail: share.ownerEmail },
      { $set: { tabTitle: share.tabTitle, tabUrl: share.tabUrl, createdAt: share.createdAt } },
      { returnDocument: "after" },
    );
    return { conflict: false, share: shareView(updated) ?? share };
  }

  async deleteIfOwner(
    sessionId: string,
    ownerEmail: string,
    nowIso: string,
  ): Promise<{ outcome: "deleted" | "missing" | "forbidden"; skippedIds: string[] }> {
    // One transaction with the share-document delete and the pending-request skip. insertPendingIfShared
    // writes that same share document, so the two cannot commit an insert against a share this deleted.
    const tx = this.client.startSession();
    try {
      let outcome: "deleted" | "missing" | "forbidden" = "missing";
      let skippedIds: string[] = [];
      await tx.withTransaction(async () => {
        skippedIds = [];
        const deleted = await this.shares.findOneAndDelete({ _id: sessionId, ownerEmail }, { session: tx });
        if (!deleted) {
          const still = await this.shares.findOne({ _id: sessionId }, { session: tx });
          outcome = still ? "forbidden" : "missing";
          return;
        }
        // A share inserted after the delete belongs to someone else. Only skip requests that
        // predate it; with no replacement, every pending request was for the share just removed.
        const replacement = await this.shares.findOne({ _id: sessionId }, { session: tx });
        const filter: Filter<BrowserRequestDoc> = replacement
          ? { sessionId, status: "pending", createdAt: { $lt: replacement.createdAt } }
          : { sessionId, status: "pending" };
        const pending = await this.requests.find(filter, { session: tx }).toArray();
        skippedIds = pending.map((row) => row._id);
        if (skippedIds.length > 0) {
          await this.requests.updateMany(
            { _id: { $in: skippedIds } },
            { $set: { status: "skipped", updatedAt: nowIso } },
            { session: tx },
          );
        }
        outcome = "deleted";
      });
      // skippedIds is emptied at the start of every attempt and filled only on delete.
      return { outcome, skippedIds };
    } finally {
      await tx.endSession();
    }
  }
}

class MongoBrowserRequests implements BrowserRequestsCollection {
  private readonly col: MongoCollection<BrowserRequestDoc>;
  private readonly shares: MongoCollection<BrowserShareDoc>;
  private readonly client: MongoClient;

  constructor(col: MongoCollection<BrowserRequestDoc>, shares: MongoCollection<BrowserShareDoc>, client: MongoClient) {
    this.col = col;
    this.shares = shares;
    this.client = client;
  }

  async insert(request: BrowserRequest): Promise<void> {
    await this.col.insertOne({ ...request, _id: request.id });
  }

  async insertPendingIfShared(sessionId: string, request: BrowserRequest): Promise<BrowserRequest | "no_share"> {
    // `$inc` on the share document is the write that conflicts with deleteIfOwner's delete of that
    // same document. A transaction that only read the share could still commit after the revoke.
    // An id that already exists is that same row: a repeated requestId does not insert another and
    // does not bump a skipped or done request back to pending.
    const tx = this.client.startSession();
    try {
      let outcome: BrowserRequest | "no_share" = "no_share";
      await tx.withTransaction(async () => {
        const existing = await this.col.findOne({ _id: request.id }, { session: tx });
        if (existing) {
          outcome = existing.sessionId === sessionId ? (stripId(existing) ?? "no_share") : "no_share";
          return;
        }
        const share = await this.shares.findOneAndUpdate(
          { _id: sessionId },
          { $inc: { _rev: 1 } },
          { session: tx, returnDocument: "after" },
        );
        if (!share) {
          outcome = "no_share";
          return;
        }
        await this.col.insertOne({ ...request, _id: request.id }, { session: tx });
        outcome = request;
      });
      return outcome;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const existing = await this.findById(sessionId, request.id);
      return existing ?? "no_share";
    } finally {
      await tx.endSession();
    }
  }

  async findById(sessionId: string, id: string): Promise<BrowserRequest | null> {
    return stripId<BrowserRequest>(await this.col.findOne({ _id: id, sessionId }));
  }

  async listPending(sessionId: string): Promise<BrowserRequest[]> {
    const rows = await this.col.find({ sessionId, status: "pending" }).sort({ createdAt: 1, _id: 1 }).toArray();
    return rows.map((row) => stripIdStrict<BrowserRequest>(row));
  }

  async markSkipped(sessionId: string, id: string, nowIso: string): Promise<BrowserRequest | null> {
    const updated = await this.col.findOneAndUpdate(
      { _id: id, sessionId, status: "pending" },
      { $set: { status: "skipped", updatedAt: nowIso } },
      { returnDocument: "after" },
    );
    if (updated) return stripId<BrowserRequest>(updated);
    const existing = await this.findById(sessionId, id);
    if (existing?.status === "skipped") {
      await this.col.updateOne({ _id: id, sessionId, status: "skipped" }, { $set: { updatedAt: nowIso } });
      return { ...existing, updatedAt: nowIso };
    }
    return existing;
  }

  async markFailed(
    sessionId: string,
    id: string,
    error: BrowserCaptureFailure,
    nowIso: string,
  ): Promise<{ request: BrowserRequest; transitioned: boolean } | null> {
    const updated = await this.col.findOneAndUpdate(
      { _id: id, sessionId, status: "pending" },
      { $set: { status: "failed", error, updatedAt: nowIso } },
      { returnDocument: "after" },
    );
    if (updated) {
      const request = stripId<BrowserRequest>(updated);
      if (!request) return null;
      return { request, transitioned: true };
    }
    const existing = await this.findById(sessionId, id);
    if (!existing) return null;
    return { request: existing, transitioned: false };
  }
}

class MongoBrowserCaptures implements BrowserCapturesCollection {
  private readonly captures: MongoCollection<BrowserCaptureDoc>;
  private readonly requests: MongoCollection<BrowserRequestDoc>;

  constructor(captures: MongoCollection<BrowserCaptureDoc>, requests: MongoCollection<BrowserRequestDoc>) {
    this.captures = captures;
    this.requests = requests;
  }

  async save(capture: BrowserCapture, nowIso: string): Promise<BrowserCaptureSave> {
    const request = await this.requests.findOne({ _id: capture.requestId, sessionId: capture.sessionId });
    if (!request) return { ok: false, reason: "missing" };
    const existing = await this.captures.findOne({ sessionId: capture.sessionId, requestId: capture.requestId });
    if (existing) {
      if (request.status === "skipped") {
        await this.captures.deleteOne({ _id: existing._id });
        return { ok: false, reason: "not_pending" };
      }
      if (request.status === "pending") {
        await this.requests.updateOne(
          { _id: request._id, status: "pending" },
          { $set: { status: "done", captureId: existing._id, updatedAt: nowIso } },
        );
      }
      return { ok: true, capture: stripCapture(existing)!, inserted: false };
    }
    if (request.status !== "pending") return { ok: false, reason: "not_pending" };
    try {
      await this.captures.insertOne({ ...capture, _id: capture.id });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const winner = await this.captures.findOne({ sessionId: capture.sessionId, requestId: capture.requestId });
      if (!winner) throw err;
      return { ok: true, capture: stripCapture(winner)!, inserted: false };
    }
    await this.trim(capture.sessionId);
    const marked = await this.requests.updateOne(
      { _id: capture.requestId, sessionId: capture.sessionId, status: "pending" },
      { $set: { status: "done", captureId: capture.id, updatedAt: nowIso } },
    );
    if (marked.matchedCount === 0) {
      const again = await this.requests.findOne({ _id: capture.requestId, sessionId: capture.sessionId });
      if (again?.status === "done" && again.captureId === capture.id) {
        return { ok: true, capture: { ...capture, bytes: Buffer.from(capture.bytes) }, inserted: true };
      }
      await this.captures.deleteOne({ _id: capture.id });
      return { ok: false, reason: "not_pending" };
    }
    return { ok: true, capture: { ...capture, bytes: Buffer.from(capture.bytes) }, inserted: true };
  }

  async findById(sessionId: string, id: string): Promise<BrowserCapture | null> {
    return stripCapture(await this.captures.findOne({ _id: id, sessionId }));
  }

  async findByRequestId(sessionId: string, requestId: string): Promise<BrowserCapture | null> {
    return stripCapture(await this.captures.findOne({ sessionId, requestId }));
  }

  private async trim(sessionId: string): Promise<void> {
    const stale = await this.captures
      .find({ sessionId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(BROWSER_CAPTURES_PER_SESSION)
      .project<{ _id: string }>({ _id: 1 })
      .toArray();
    if (stale.length === 0) return;
    await this.captures.deleteMany({ _id: { $in: stale.map((row) => row._id) } });
  }
}

export class MongoStore implements Store {
  readonly sessions: SessionsCollection;
  readonly entries: EntriesCollection;
  readonly runs: RunsCollection;
  readonly gurus: GurusCollection;
  readonly environments: EnvironmentsCollection;
  readonly users: UsersCollection;
  readonly providers: ProvidersCollection;
  readonly tokens: TokensCollection;
  readonly mail: MailCollection;
  readonly browserShares: BrowserSharesCollection;
  readonly browserRequests: BrowserRequestsCollection;
  readonly browserCaptures: BrowserCapturesCollection;
  private readonly client: MongoClient;

  private constructor(client: MongoClient, db: Db) {
    this.client = client;
    this.sessions = new MongoSessions(db.collection("sessions"));
    this.entries = new MongoEntries(db.collection("entries"));
    this.runs = new MongoRuns(db.collection("runs"));
    this.gurus = new MongoGurus(db.collection("gurus"));
    this.environments = new MongoEnvironments(db.collection("environments"));
    this.users = new MongoUsers(db.collection("users"));
    this.providers = new MongoProviders(db.collection("providers"));
    this.tokens = new MongoTokens(db.collection("tokens"));
    this.mail = new MongoMail(db.collection("mail"));
    const requestCol = db.collection<BrowserRequestDoc>("browserRequests");
    const shareCol = db.collection<BrowserShareDoc>("browserShares");
    this.browserShares = new MongoBrowserShares(shareCol, requestCol, client);
    this.browserRequests = new MongoBrowserRequests(requestCol, shareCol, client);
    this.browserCaptures = new MongoBrowserCaptures(db.collection<BrowserCaptureDoc>("browserCaptures"), requestCol);
  }

  /** `dbName` wins over the database in the URI; the stored URI has none, so the default keeps
   * us out of the driver's implicit `test` database. */
  static async connect(uri: string, dbName = "outfitter"): Promise<MongoStore> {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(dbName);
    const store = new MongoStore(client, db);
    await store.ensureIndexes(db);
    return store;
  }

  private async ensureIndexes(db: Db): Promise<void> {
    await Promise.all([
      db.collection("entries").createIndex({ sessionId: 1, "entry.id": 1 }, { unique: true }),
      db.collection("entries").createIndex({ sessionId: 1, seq: 1 }),
      db.collection("entries").createIndex({ sessionId: 1, _id: -1 }),
      db.collection("sessions").createIndex({ updatedAt: -1 }),
      db.collection("runs").createIndex({ sessionId: 1, state: 1 }),
      db.collection("tokens").createIndex({ hash: 1 }, { unique: true }),
      db.collection("tokens").createIndex({ ownerEmail: 1 }),
      db.collection("mail").createIndex({ sessionId: 1, status: 1, createdAt: 1 }),
      db.collection("mail").createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection("mail").createIndex({ "from.sessionId": 1, createdAt: 1 }),
      db.collection("browserRequests").createIndex({ sessionId: 1, status: 1, createdAt: 1 }),
      db.collection("browserCaptures").createIndex({ sessionId: 1, requestId: 1 }, { unique: true }),
      db.collection("browserCaptures").createIndex({ sessionId: 1, createdAt: -1 }),
    ]);
    // Non-fatal: a deployment that already holds two active runs for one session (the race this
    // index closes) would otherwise fail every boot. Until the duplicates are cleaned up,
    // insertIfNoActive degrades to the old check-then-insert behaviour.
    try {
      await db.collection("runs").createIndex(
        { sessionId: 1 },
        { name: "one_active_run_per_session", unique: true, partialFilterExpression: { state: { $in: ACTIVE_RUN_STATES } } },
      );
    } catch (err) {
      console.warn(`runs index one_active_run_per_session not created: ${err instanceof Error ? err.message : err}`);
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
