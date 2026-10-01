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
  RunStartup,
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
  HeldMailScope,
  BrowserShare,
  BrowserSharesCollection,
  Preview,
  PreviewsCollection,
  BrowserRequest,
  BrowserActionResultError,
  BrowserInspectFailure,
  BrowserRequestsCollection,
  BrowserCapture,
  BrowserCaptureFailure,
  BrowserCapturesCollection,
  BrowserCaptureSave,
  FormattedSession,
  FormattedSessionsCollection,
  AdminAuditCollection,
  AdminApproval,
  AdminApprovalsCollection,
  ChunkHit,
  ChunkQuery,
  SessionChunk,
  SessionChunksCollection,
  AdminAuditEntry,
  TurnWaiter,
  TurnWaiterFinish,
  TurnWaitersCollection,
  AeAgent,
  AeAgentsCollection,
  AeSession,
  AeSessionsCollection,
} from "./types.ts";
import type { VoicePrefs } from "../voice.ts";
import { AE_SESSION_EXECUTIONS, BROWSER_CAPTURES_PER_SESSION, entryInsertFields, type EntryInsertOptions } from "./types.ts";
import { TOKEN_TTL_MS } from "../tokens.ts";
import { SearchUnavailableError } from "./types.ts";
import { CHUNKS_COLLECTION, CHUNKS_TEXT_INDEX, CHUNKS_VECTOR_INDEX } from "../search/indexes.ts";

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
    // `null` matches a missing field as well as an explicit null.
    if (filter?.archived === "exclude") query.archivedAt = null;
    else if (filter?.archived === "only") query.archivedAt = { $ne: null };
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

  async setArchivedAt(id: string, archivedAt: string | null): Promise<Session | null> {
    const result = await this.col.findOneAndUpdate(
      archivedAt ? { _id: id } : { _id: id, formattingAt: { $exists: false } },
      archivedAt ? { $set: { archivedAt } } : { $unset: { archivedAt: "" } },
      { returnDocument: "after" },
    );
    return stripId<Session>(result);
  }

  async claimForFormat(id: string, nowIso: string): Promise<Session | null> {
    const result = await this.col.findOneAndUpdate(
      { _id: id, archivedAt: { $type: "string" }, formattingAt: { $exists: false } },
      { $set: { formattingAt: nowIso } },
      { returnDocument: "after" },
    );
    return stripId<Session>(result);
  }

  async releaseFormatClaim(id: string): Promise<void> {
    await this.col.updateOne({ _id: id }, { $unset: { formattingAt: "" } });
  }

  async delete(id: string): Promise<boolean> {
    return (await this.col.deleteOne({ _id: id })).deletedCount > 0;
  }
}

class MongoEntries implements EntriesCollection {
  private readonly col: MongoCollection<Entry & { _id?: unknown }>;

  constructor(col: MongoCollection<Entry & { _id?: unknown }>) {
    this.col = col;
  }

  async insertIfNew(sessionId: string, seq: number, entry: PiEntry, opts: EntryInsertOptions = {}): Promise<boolean> {
    try {
      await this.col.insertOne({ sessionId, seq, entry, ...entryInsertFields(opts) });
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
    // Insertion order (_id), not seq -- see EntriesCollection.listForSession. Served by {sessionId, _id}.
    const filter: Record<string, unknown> = { sessionId };
    if (afterEntryId) {
      const marker = await this.col.findOne({ sessionId, "entry.id": afterEntryId });
      if (marker?._id !== undefined) filter._id = { $gt: marker._id };
    }
    const rows = await this.col.find(filter).sort({ _id: 1 }).toArray();
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

  async deleteForSession(sessionId: string): Promise<number> {
    return (await this.col.deleteMany({ sessionId })).deletedCount;
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

  async listForSession(sessionId: string): Promise<Run[]> {
    // Served by the {sessionId, state} index's sessionId prefix.
    const rows = await this.col.find({ sessionId }).sort({ createdAt: 1 }).toArray();
    return rows.map((r) => stripIdStrict<Run>(r));
  }

  async update(id: string, patch: Partial<Run>): Promise<Run | null> {
    const result = await this.col.findOneAndUpdate(
      { _id: id },
      { $set: patch },
      { returnDocument: "after" },
    );
    return stripId<Run>(result);
  }

  async mergeStartup(id: string, fields: Partial<RunStartup>, unlessSet?: keyof RunStartup): Promise<Run | null> {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) set[`startup.${key}`] = value;
    }
    if (Object.keys(set).length === 0) return null;
    const filter: Record<string, unknown> = { _id: id };
    if (unlessSet) filter[`startup.${unlessSet}`] = { $exists: false };
    const result = await this.col.findOneAndUpdate(filter, { $set: set }, { returnDocument: "after" });
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

  async deleteForSession(sessionId: string): Promise<number> {
    return (await this.col.deleteMany({ sessionId })).deletedCount;
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

  async list(): Promise<User[]> {
    const rows = await this.col.find({}).toArray();
    return rows.map((r) => stripIdStrict<User>(r));
  }

  async setVoicePrefs(email: string, prefs: VoicePrefs): Promise<User> {
    const result = await this.col.findOneAndUpdate(
      { _id: email },
      { $set: { voice: { ...prefs } }, $setOnInsert: { email, createdAt: new Date().toISOString() } },
      { upsert: true, returnDocument: "after" },
    );
    return stripId<User>(result) as User; // upsert:true guarantees a document comes back
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
    // replaceOne, not $set: the optional fields (detail, meta, isDefault) must go away when a new
    // row leaves them out -- $set kept a "down" row's old meta, and would keep an unregistered
    // sandbox row's last capacity and default marker (#169). The filter supplies _id on insert.
    await this.col.replaceOne({ _id: record.id }, record, { upsert: true });
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
      // New mail joins an existing hold with its reason (#172).
      const detail = alreadyHeld ? await this.heldDetail(sessionId) : undefined;
      await this.col.updateMany(deliverable, {
        $set: { status: "held", heldAt: nowIso, ...(detail ? { heldDetail: detail } : {}) },
        $unset: { lockedUntil: "" },
      });
    }
    return this.col.countDocuments({ sessionId, status: "held" });
  }

  async holdSession(sessionId: string, nowIso: string, detail: string): Promise<number> {
    // Whatever its attempts: mail out of attempts but not yet dead-lettered is held too, rather
    // than left for the next sweep to drop without telling anyone.
    await this.col.updateMany(
      { sessionId, $or: [{ status: "queued" as const }, { status: "delivered" as const, lockedUntil: { $lt: nowIso } }] },
      { $set: { status: "held", heldAt: nowIso }, $unset: { lockedUntil: "" } },
    );
    await this.col.updateMany({ sessionId, status: "held" }, { $set: { heldDetail: detail } });
    return this.col.countDocuments({ sessionId, status: "held" });
  }

  async releaseHeld(sessionId?: string, scope: HeldMailScope = "all"): Promise<string[]> {
    const filter = {
      status: "held" as const,
      ...(sessionId ? { sessionId } : {}),
      ...(scope === "deploy-mismatch" ? { heldDetail: { $exists: false } } : {}),
    };
    const sessions = await this.col.distinct("sessionId", filter);
    if (sessions.length === 0) return [];
    await this.col.updateMany(filter, { $set: { status: "queued", attempts: 0 }, $unset: { heldAt: "", heldDetail: "", unvalidatedWakes: "" } });
    return sessions;
  }

  async countHeld(sessionId: string): Promise<number> {
    return this.col.countDocuments({ sessionId, status: "held" });
  }

  async heldDetail(sessionId: string): Promise<string | undefined> {
    const doc = await this.col.findOne({ sessionId, status: "held", heldDetail: { $exists: true } }, { projection: { heldDetail: 1 } });
    return typeof doc?.heldDetail === "string" ? doc.heldDetail : undefined;
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

  async deleteForSession(sessionId: string): Promise<number> {
    return (await this.col.deleteMany({ sessionId })).deletedCount;
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

  async deleteForSession(sessionId: string): Promise<number> {
    return (await this.shares.deleteMany({ sessionId })).deletedCount;
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

  async markActionResult(
    sessionId: string,
    id: string,
    outcome: { ok: true } | { ok: false; error: BrowserActionResultError },
    nowIso: string,
  ): Promise<{ request: BrowserRequest; transitioned: boolean } | null> {
    const filter = { _id: id, sessionId, status: "pending" as const, kind: { $in: ["click", "type"] as const } };
    const updated = outcome.ok
      ? await this.col.findOneAndUpdate(
          filter,
          { $set: { status: "done", updatedAt: nowIso }, $unset: { error: "" } },
          { returnDocument: "after" },
        )
      : await this.col.findOneAndUpdate(
          filter,
          { $set: { status: "failed", error: outcome.error, updatedAt: nowIso } },
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

  async markInspectResult(
    sessionId: string,
    id: string,
    outcome: { ok: true; messages: string[]; element: string | null } | { ok: false; error: BrowserInspectFailure },
    nowIso: string,
  ): Promise<{ request: BrowserRequest; transitioned: boolean } | null> {
    const filter = { _id: id, sessionId, status: "pending" as const, kind: "inspect" as const };
    const updated = outcome.ok
      ? await this.col.findOneAndUpdate(
          filter,
          {
            $set: {
              status: "done",
              inspectMessages: outcome.messages,
              inspectElement: outcome.element,
              updatedAt: nowIso,
            },
            $unset: { error: "" },
          },
          { returnDocument: "after" },
        )
      : await this.col.findOneAndUpdate(
          filter,
          {
            $set: { status: "failed", error: outcome.error, updatedAt: nowIso },
            $unset: { inspectMessages: "", inspectElement: "" },
          },
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

  async deleteForSession(sessionId: string): Promise<number> {
    return (await this.col.deleteMany({ sessionId })).deletedCount;
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

  async deleteForSession(sessionId: string): Promise<number> {
    return (await this.captures.deleteMany({ sessionId })).deletedCount;
  }
}

class MongoFormattedSessions implements FormattedSessionsCollection {
  private readonly col: MongoCollection<FormattedSession & { _id: string }>;

  constructor(col: MongoCollection<FormattedSession & { _id: string }>) {
    this.col = col;
  }

  async insert(record: FormattedSession): Promise<void> {
    await this.col.updateOne({ _id: record.id }, { $setOnInsert: { ...record, _id: record.id } }, { upsert: true });
  }

  async findById(id: string): Promise<FormattedSession | null> {
    return stripId<FormattedSession>(await this.col.findOne({ _id: id }));
  }
}

type ChunkDoc = SessionChunk & { _id: string; at: Date };

/**
 * Session search (Sysop tools, #289) on Atlas: `$search` on chunks_text, `$vectorSearch` on the
 * auto-embedded chunks_vec (Atlas embeds the query text too), and `$rankFusion` of both for hybrid
 * (MongoDB 8.0+). A missing index is a SearchUnavailableError naming the script that makes it.
 */
class MongoSessionChunks implements SessionChunksCollection {
  private readonly col: MongoCollection<ChunkDoc>;
  /** Names of the collection's queryable search indexes, re-read at most once a minute: Atlas
   * answers a search on a missing index with no results, not an error. */
  private ready: { names: Set<string>; at: number } | undefined;

  constructor(col: MongoCollection<ChunkDoc>) {
    this.col = col;
  }

  private async readyIndexes(): Promise<Set<string>> {
    if (this.ready && Date.now() - this.ready.at < 60_000) return this.ready.names;
    let names = new Set<string>();
    try {
      const list = (await this.col.listSearchIndexes().toArray()) as Array<{ name: string; queryable?: boolean; status?: string }>;
      names = new Set(list.filter((i) => i.queryable === true || i.status === "READY").map((i) => i.name));
    } catch {
      // Not Atlas (no search index API): nothing is ready.
    }
    this.ready = { names, at: Date.now() };
    return names;
  }

  async upsertMany(chunks: SessionChunk[]): Promise<void> {
    if (!chunks.length) return;
    await this.col.bulkWrite(
      chunks.map((c) => {
        const doc = { ...c, _id: c.id, at: new Date(c.createdAt) } as ChunkDoc;
        return { replaceOne: { filter: { _id: c.id }, replacement: doc, upsert: true } };
      }),
      { ordered: false },
    );
  }

  async deleteForSession(sessionId: string): Promise<number> {
    return (await this.col.deleteMany({ sessionId })).deletedCount;
  }

  async search(query: ChunkQuery): Promise<ChunkHit[]> {
    const needed = query.mode === "text" ? [CHUNKS_TEXT_INDEX] : query.mode === "semantic" ? [CHUNKS_VECTOR_INDEX] : [CHUNKS_TEXT_INDEX, CHUNKS_VECTOR_INDEX];
    const ready = await this.readyIndexes();
    const missing = needed.filter((n) => !ready.has(n));
    if (missing.length) {
      throw new SearchUnavailableError(`${query.mode} search is not set up on this cluster (${missing.join(", ")} not ready; run deploy/atlas-search.sh)`);
    }
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const f = query.filter;
    const equals = Object.entries({ ownerEmail: f.ownerEmail, guruId: f.guruId, repo: f.repo, role: f.role, sessionId: f.sessionId }).filter(
      (e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0,
    );
    const range = f.since || f.until ? { ...(f.since ? { gte: new Date(f.since) } : {}), ...(f.until ? { lte: new Date(f.until) } : {}) } : undefined;
    const searchStage = {
      $search: {
        index: CHUNKS_TEXT_INDEX,
        compound: {
          must: [{ text: { query: query.text, path: "text" } }],
          filter: [...equals.map(([path, value]) => ({ equals: { path, value } })), ...(range ? [{ range: { path: "at", ...range } }] : [])],
        },
      },
    };
    const vectorFilter: Record<string, unknown> = Object.fromEntries(equals);
    if (range) vectorFilter.at = { ...(range.gte ? { $gte: range.gte } : {}), ...(range.lte ? { $lte: range.lte } : {}) };
    const vectorStage = {
      $vectorSearch: {
        index: CHUNKS_VECTOR_INDEX,
        path: "text",
        query: query.text,
        numCandidates: limit * 10,
        limit,
        ...(Object.keys(vectorFilter).length ? { filter: vectorFilter } : {}),
      },
    };
    let pipeline: Record<string, unknown>[];
    if (query.mode === "text") pipeline = [searchStage, { $limit: limit }, { $addFields: { score: { $meta: "searchScore" } } }];
    else if (query.mode === "semantic") pipeline = [vectorStage, { $addFields: { score: { $meta: "vectorSearchScore" } } }];
    else {
      pipeline = [
        { $rankFusion: { input: { pipelines: { vector: [vectorStage], text: [searchStage, { $limit: limit }] } } } },
        { $limit: limit },
        { $addFields: { score: { $meta: "score" } } },
      ];
    }
    let rows: Array<ChunkDoc & { score?: number }>;
    try {
      rows = (await this.col.aggregate(pipeline).toArray()) as Array<ChunkDoc & { score?: number }>;
    } catch (err) {
      // An older server without $rankFusion, or a stage this deployment doesn't have.
      const message = err instanceof Error ? err.message : String(err);
      if (/Unrecognized pipeline stage name|\$rankFusion is not (allowed|supported)/i.test(message)) {
        throw new SearchUnavailableError(`${query.mode} search is not supported here: ${message.slice(0, 160)}`);
      }
      throw err;
    }
    return rows.map(({ _id: _ignored, at: _at, score, ...chunk }) => ({ chunk: chunk as SessionChunk, ...(typeof score === "number" ? { score } : {}) }));
  }
}

class MongoAdminApprovals implements AdminApprovalsCollection {
  private readonly col: MongoCollection<AdminApproval & { _id: string }>;

  constructor(col: MongoCollection<AdminApproval & { _id: string }>) {
    this.col = col;
  }

  async get(runId: string): Promise<AdminApproval | null> {
    return stripId<AdminApproval>(await this.col.findOne({ _id: runId }));
  }

  async claim(approval: AdminApproval, nowIso: string): Promise<boolean> {
    const doc = { ...approval, _id: approval.runId };
    try {
      await this.col.insertOne(doc);
      return true;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
    // One exists: replace it only if it is answered or expired.
    const replaced = await this.col.findOneAndReplace(
      { _id: approval.runId, $or: [{ decision: { $exists: true } }, { expiresAt: { $lte: nowIso } }] },
      doc,
    );
    return replaced !== null;
  }

  async decide(runId: string, approvalId: string, decision: "approved" | "denied", by: string, nowIso: string): Promise<boolean> {
    const result = await this.col.updateOne(
      { _id: runId, id: approvalId, decision: { $exists: false }, expiresAt: { $gt: nowIso } },
      { $set: { decision, decidedBy: by, decidedAt: nowIso } },
    );
    return result.modifiedCount === 1;
  }

  async clear(runId: string, approvalId: string): Promise<void> {
    await this.col.deleteOne({ _id: runId, id: approvalId });
  }
}

class MongoAdminAudit implements AdminAuditCollection {
  private readonly col: MongoCollection<AdminAuditEntry & { _id: string }>;

  constructor(col: MongoCollection<AdminAuditEntry & { _id: string }>) {
    this.col = col;
  }

  async insert(entry: AdminAuditEntry): Promise<void> {
    // Unset optional fields stay absent instead of being stored as null.
    const row = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)) as AdminAuditEntry;
    await this.col.insertOne({ ...row, _id: entry.id });
  }

  async listRecent(limit: number): Promise<AdminAuditEntry[]> {
    // Ids sort by time, then by order within a process (admin/ops.ts auditId): newest first on _id.
    const rows = await this.col.find({}).sort({ _id: -1 }).limit(limit).toArray();
    return rows.map((r) => stripIdStrict<AdminAuditEntry>(r));
  }
}

class MongoPreviews implements PreviewsCollection {
  private readonly col: MongoCollection<Preview & { _id: string }>;

  constructor(col: MongoCollection<Preview & { _id: string }>) {
    this.col = col;
  }

  async insert(preview: Preview): Promise<void> {
    await this.col.insertOne({ ...preview, _id: preview.id });
  }

  async findOpen(runId: string, port: number, share: boolean): Promise<Preview | null> {
    return stripId<Preview>(await this.col.findOne({ runId, port, share, closedAt: { $exists: false } }));
  }

  async listOpenForRun(runId: string): Promise<Preview[]> {
    return (await this.col.find({ runId, closedAt: { $exists: false } }).toArray()).map((d) => stripId<Preview>(d)!);
  }

  async listOpenForSession(sessionId: string): Promise<Preview[]> {
    return (await this.col.find({ sessionId, closedAt: { $exists: false } }).toArray()).map((d) => stripId<Preview>(d)!);
  }

  async listOpen(): Promise<Preview[]> {
    return (await this.col.find({ closedAt: { $exists: false } }).toArray()).map((d) => stripId<Preview>(d)!);
  }

  async markClosed(id: string, closedAt: string, reason: string): Promise<Preview | null> {
    const doc = await this.col.findOneAndUpdate(
      { _id: id, closedAt: { $exists: false } },
      { $set: { closedAt, closedReason: reason } },
      { returnDocument: "after" },
    );
    return stripId<Preview>(doc);
  }
}

/** A finished turn waiter is kept a week (for the caller to read its outcome), then TTL-deleted. */
const FINISHED_TURN_WAITER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type TurnWaiterDoc = TurnWaiter & { _id: string; expireAt?: Date };

function stripTurnWaiter(doc: TurnWaiterDoc | null): TurnWaiter | null {
  if (!doc) return null;
  const { _id, expireAt, ...rest } = doc;
  return rest;
}

class MongoTurnWaiters implements TurnWaitersCollection {
  private readonly col: MongoCollection<TurnWaiterDoc>;

  constructor(col: MongoCollection<TurnWaiterDoc>) {
    this.col = col;
  }

  async insert(waiter: TurnWaiter): Promise<void> {
    await this.col.insertOne({ ...waiter, _id: waiter.id });
  }

  async findById(id: string): Promise<TurnWaiter | null> {
    return stripTurnWaiter(await this.col.findOne({ _id: id }));
  }

  async markAcked(sessionId: string, mailId: string, runId: string, seq: number, nowIso: string, fromMail = false): Promise<number> {
    const set = { ackRunId: runId, ackSeq: seq, ackedAt: nowIso, updatedAt: nowIso };
    const result = fromMail
      ? await this.col.updateMany(
          { sessionId, mailId, status: "open", ackRunId: { $exists: false } },
          { $set: { ...set, ackFromMail: true } },
        )
      : await this.col.updateMany(
          { sessionId, mailId, status: "open", $or: [{ ackRunId: { $exists: false } }, { ackFromMail: true }] },
          { $set: set, $unset: { ackFromMail: "" } },
        );
    return result.modifiedCount;
  }

  async finish(id: string, outcome: TurnWaiterFinish, nowIso: string): Promise<TurnWaiter | null> {
    // expireAt is Mongo-only, as on mail: the TTL index needs a BSON date.
    const doc = await this.col.findOneAndUpdate(
      { _id: id, status: "open" },
      {
        $set: {
          // Unset optional fields stay absent instead of being stored as null.
          ...Object.fromEntries(Object.entries(outcome).filter(([, v]) => v !== undefined)),
          finishedAt: nowIso,
          updatedAt: nowIso,
          expireAt: new Date(Date.parse(nowIso) + FINISHED_TURN_WAITER_TTL_MS),
        },
      },
      { returnDocument: "after" },
    );
    return stripTurnWaiter(doc);
  }

  async extendDeadline(id: string, deadlineAt: string, nowIso: string): Promise<boolean> {
    const result = await this.col.updateOne(
      { _id: id, status: "open", deadlineAt: { $lt: deadlineAt } },
      { $set: { deadlineAt, updatedAt: nowIso } },
    );
    return result.matchedCount === 1;
  }

  async listOpenForSession(sessionId: string): Promise<TurnWaiter[]> {
    const rows = await this.col.find({ sessionId, status: "open" }).sort({ createdAt: 1 }).toArray();
    return rows.map((d) => stripTurnWaiter(d)!);
  }

  async listOpen(limit: number): Promise<TurnWaiter[]> {
    const rows = await this.col.find({ status: "open" }).sort({ deadlineAt: 1 }).limit(limit).toArray();
    return rows.map((d) => stripTurnWaiter(d)!);
  }

  async deleteForSession(sessionId: string): Promise<number> {
    return (await this.col.deleteMany({ sessionId })).deletedCount;
  }
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

/** Unique on `workspaceId` too (ensureIndexes): one entry per workspace. */
class MongoAeAgents implements AeAgentsCollection {
  private readonly col: MongoCollection<AeAgent & { _id: string }>;

  constructor(col: MongoCollection<AeAgent & { _id: string }>) {
    this.col = col;
  }

  async list(): Promise<AeAgent[]> {
    const rows = await this.col.find({}).sort({ _id: 1 }).toArray();
    return rows.map((r) => stripIdStrict<AeAgent>(r));
  }

  async findById(id: string): Promise<AeAgent | null> {
    return stripId<AeAgent>(await this.col.findOne({ _id: id }));
  }

  async insert(agent: AeAgent): Promise<boolean> {
    try {
      const row = Object.fromEntries(Object.entries(agent).filter(([, v]) => v !== undefined)) as AeAgent;
      await this.col.insertOne({ ...row, _id: agent.id });
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }

  async update(id: string, patch: Partial<Omit<AeAgent, "id" | "createdAt">>): Promise<AeAgent | null | "duplicate"> {
    const set = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "id" && k !== "_id"));
    try {
      return stripId<AeAgent>(await this.col.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: "after" }));
    } catch (err) {
      if (isDuplicateKey(err)) return "duplicate";
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    return (await this.col.deleteOne({ _id: id })).deletedCount === 1;
  }
}

class MongoAeSessions implements AeSessionsCollection {
  private readonly col: MongoCollection<AeSession & { _id: string }>;

  constructor(col: MongoCollection<AeSession & { _id: string }>) {
    this.col = col;
  }

  async recordInvoke(
    row: Pick<AeSession, "outfitterSessionId" | "agentId" | "workspaceId" | "aeSessionId">,
    executionId: string | undefined,
    nowIso: string,
  ): Promise<AeSession> {
    const id = `${row.outfitterSessionId}:${row.agentId}`;
    const doc = await this.col.findOneAndUpdate(
      { _id: id },
      {
        $set: { outfitterSessionId: row.outfitterSessionId, agentId: row.agentId, workspaceId: row.workspaceId, aeSessionId: row.aeSessionId, lastUsedAt: nowIso },
        $unset: { stoppedAt: "", stopAttempts: "", stopError: "" },
        // An insert without an execution still needs the array; with one, $push creates it.
        ...(executionId
          ? { $setOnInsert: { id, openedAt: nowIso }, $push: { executions: { $each: [executionId], $slice: -AE_SESSION_EXECUTIONS } } }
          : { $setOnInsert: { id, openedAt: nowIso, executions: [] } }),
      },
      { upsert: true, returnDocument: "after" },
    );
    return stripIdStrict<AeSession>(doc!);
  }

  async findByExecution(outfitterSessionId: string, executionId: string): Promise<AeSession | null> {
    return stripId<AeSession>(await this.col.findOne({ outfitterSessionId, executions: executionId }));
  }

  async listOpen(limit: number, usedBefore?: string): Promise<AeSession[]> {
    const rows = await this.col.find({ stoppedAt: { $exists: false }, ...(usedBefore !== undefined ? { lastUsedAt: { $lt: usedBefore } } : {}) }).sort({ lastUsedAt: 1 }).limit(limit).toArray();
    return rows.map((r) => stripIdStrict<AeSession>(r));
  }

  async listOpenForSession(outfitterSessionId: string): Promise<AeSession[]> {
    const rows = await this.col.find({ outfitterSessionId, stoppedAt: { $exists: false } }).toArray();
    return rows.map((r) => stripIdStrict<AeSession>(r));
  }

  async markStopped(id: string, lastUsedAt: string, nowIso: string, error?: string): Promise<boolean> {
    const result = await this.col.updateOne(
      { _id: id, lastUsedAt, stoppedAt: { $exists: false } },
      { $set: { stoppedAt: nowIso, ...(error ? { stopError: error } : {}) } },
    );
    return result.matchedCount === 1;
  }

  async recordStopFailure(id: string, lastUsedAt: string, error: string): Promise<number | null> {
    const doc = await this.col.findOneAndUpdate(
      { _id: id, lastUsedAt, stoppedAt: { $exists: false } },
      { $inc: { stopAttempts: 1 }, $set: { stopError: error } },
      { returnDocument: "after" },
    );
    return doc ? (doc.stopAttempts ?? 1) : null;
  }

  async deleteForSession(outfitterSessionId: string): Promise<number> {
    return (await this.col.deleteMany({ outfitterSessionId })).deletedCount;
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
  readonly formattedSessions: FormattedSessionsCollection;
  readonly previews: PreviewsCollection;
  readonly adminAudit: AdminAuditCollection;
  readonly adminApprovals: AdminApprovalsCollection;
  readonly sessionChunks: SessionChunksCollection;
  readonly turnWaiters: TurnWaitersCollection;
  readonly aeAgents: AeAgentsCollection;
  readonly aeSessions: AeSessionsCollection;
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
    this.formattedSessions = new MongoFormattedSessions(db.collection("formattedSessions"));
    this.previews = new MongoPreviews(db.collection("previews"));
    this.adminAudit = new MongoAdminAudit(db.collection("adminAudit"));
    this.adminApprovals = new MongoAdminApprovals(db.collection("adminApprovals"));
    this.sessionChunks = new MongoSessionChunks(db.collection(CHUNKS_COLLECTION));
    this.turnWaiters = new MongoTurnWaiters(db.collection<TurnWaiterDoc>("turnWaiters"));
    this.aeAgents = new MongoAeAgents(db.collection("aeAgents"));
    this.aeSessions = new MongoAeSessions(db.collection("aeSessions"));
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
      db.collection("previews").createIndex({ runId: 1, closedAt: 1 }),
      db.collection("previews").createIndex({ sessionId: 1, closedAt: 1 }),
      db.collection("tokens").createIndex({ hash: 1 }, { unique: true }),
      db.collection("tokens").createIndex({ ownerEmail: 1 }),
      db.collection(CHUNKS_COLLECTION).createIndex({ sessionId: 1 }),
      db.collection("mail").createIndex({ sessionId: 1, status: 1, createdAt: 1 }),
      db.collection("mail").createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection("mail").createIndex({ "from.sessionId": 1, createdAt: 1 }),
      db.collection("browserRequests").createIndex({ sessionId: 1, status: 1, createdAt: 1 }),
      db.collection("browserCaptures").createIndex({ sessionId: 1, requestId: 1 }, { unique: true }),
      db.collection("browserCaptures").createIndex({ sessionId: 1, createdAt: -1 }),
      db.collection("turnWaiters").createIndex({ sessionId: 1, status: 1, createdAt: 1 }),
      db.collection("turnWaiters").createIndex({ status: 1, deadlineAt: 1 }),
      db.collection("turnWaiters").createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      // E9 §4: one allowlist entry per workspace; the session-close sweep; ae.get/ae.resume lookups.
      db.collection("aeAgents").createIndex({ workspaceId: 1 }, { unique: true }),
      db.collection("aeSessions").createIndex({ stoppedAt: 1, lastUsedAt: 1 }),
      db.collection("aeSessions").createIndex({ outfitterSessionId: 1, executions: 1 }),
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
