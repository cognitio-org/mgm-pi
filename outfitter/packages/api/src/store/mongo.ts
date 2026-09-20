// Mongo-backed Store. Connects lazily (connectMongoStore) so importing this module never dials
// out; only MONGODB_URI values other than "memory" reach it (see index.ts).

import { MongoClient, type Collection as MongoCollection, type Db } from "mongodb";
import type {
  Store,
  Session,
  SessionListFilter,
  SessionsCollection,
  Entry,
  EntriesCollection,
  PiEntry,
  Run,
  RunState,
  RunsCollection,
  DownMessage,
  Guru,
  GurusCollection,
  Environment,
  EnvironmentsCollection,
  User,
  UsersCollection,
} from "./types.ts";

// Typed as RunState[], not inferred as string[]: used in a Mongo `$in` filter against Run.state,
// which the mongodb driver's Filter<T> types as a union of the literal RunState strings.
const ACTIVE_RUN_STATES: RunState[] = ["queued", "provisioning", "running", "idle"];

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

  async findById(id: string): Promise<Run | null> {
    return stripId<Run>(await this.col.findOne({ _id: id }));
  }

  async findActiveForSession(sessionId: string): Promise<Run | null> {
    return stripId<Run>(await this.col.findOne({ sessionId, state: { $in: ACTIVE_RUN_STATES } }));
  }

  async update(id: string, patch: Partial<Run>): Promise<Run | null> {
    const result = await this.col.findOneAndUpdate(
      { _id: id },
      { $set: patch },
      { returnDocument: "after" },
    );
    return stripId<Run>(result);
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

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: number }).code === 11000;
}

export class MongoStore implements Store {
  readonly sessions: SessionsCollection;
  readonly entries: EntriesCollection;
  readonly runs: RunsCollection;
  readonly gurus: GurusCollection;
  readonly environments: EnvironmentsCollection;
  readonly users: UsersCollection;
  private readonly client: MongoClient;

  private constructor(client: MongoClient, db: Db) {
    this.client = client;
    this.sessions = new MongoSessions(db.collection("sessions"));
    this.entries = new MongoEntries(db.collection("entries"));
    this.runs = new MongoRuns(db.collection("runs"));
    this.gurus = new MongoGurus(db.collection("gurus"));
    this.environments = new MongoEnvironments(db.collection("environments"));
    this.users = new MongoUsers(db.collection("users"));
  }

  static async connect(uri: string): Promise<MongoStore> {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db();
    const store = new MongoStore(client, db);
    await store.ensureIndexes(db);
    return store;
  }

  private async ensureIndexes(db: Db): Promise<void> {
    await Promise.all([
      db.collection("entries").createIndex({ sessionId: 1, "entry.id": 1 }, { unique: true }),
      db.collection("entries").createIndex({ sessionId: 1, seq: 1 }),
      db.collection("sessions").createIndex({ updatedAt: -1 }),
      db.collection("runs").createIndex({ sessionId: 1, state: 1 }),
    ]);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
