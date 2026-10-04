// Central settings, CA-3 (#392, docs/specs/central-auth.md §3.3): the group, user, profile and
// device levels' documents, with their memory and Mongo implementations. The fleet level stays the
// one `fleetSettings` document (fleet-settings.ts), extended with `values` and `version`. Owned by
// task C; the shapes and the interface are the contract the web (CA-7) and Drives (CA-6) read.

import type { Collection as MongoCollection, Db } from "mongodb";
import type { SettingValue } from "../central/settings-schema.ts";

export type SettingsDocLevel = "group" | "user" | "profile" | "device";

/** One level's values for one owner. `id` is `group:<groupId>`, `user:<userId>`,
 * `profile:<userId>:<name>` or `device:<deviceId>` (settingsDocId below). */
export interface SettingsDoc {
  id: string;
  level: SettingsDocLevel;
  /** Absent only for a group document. */
  userId?: string;
  /** Profile name (`[a-z0-9][a-z0-9-]{0,31}`), for level "profile". */
  name?: string;
  /** Level "profile": the one a Kernal without --profile resolves. At most one per user. */
  isDefault?: boolean;
  /** Level "device": the device it belongs to. */
  deviceId?: string;
  /** Only keys the schema declares for this level; a key absent here is unset at this level. */
  values: Record<string, SettingValue>;
  /** Starts at 1, +1 on every write; the ETag (`W/"<version>"`) compares against it (§3.5). */
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export function settingsDocId(level: "group", groupId: string): string;
export function settingsDocId(level: "user", userId: string): string;
export function settingsDocId(level: "profile", userId: string, name: string): string;
export function settingsDocId(level: "device", deviceId: string): string;
export function settingsDocId(level: SettingsDocLevel, a: string, b?: string): string {
  return level === "profile" ? `profile:${a}:${b}` : `${level}:${a}`;
}

/** What a versioned write returns: the stored document, or the current one when `expectedVersion`
 * didn't match (null current: the document doesn't exist). */
export type SettingsWriteResult = { ok: true; doc: SettingsDoc } | { ok: false; current: SettingsDoc | null };

export interface SettingsCollection {
  get(id: string): Promise<SettingsDoc | null>;
  /** A user's profiles, by name. */
  listProfiles(userId: string): Promise<SettingsDoc[]>;
  /** Writes `doc` (its `version` is ignored and set to expectedVersion + 1) only if the stored
   * version is `expectedVersion`; `expectedVersion` 0 means "must not exist yet". Atomic. */
  put(doc: SettingsDoc, expectedVersion: number): Promise<SettingsWriteResult>;
  /** Deletes only at `expectedVersion`. */
  delete(id: string, expectedVersion: number): Promise<SettingsWriteResult | { ok: true; doc: null }>;
  /** Makes `name` the user's only default profile (atomic enough: clears the others first). Every
   * document it changes gets a new version, so a write holding the old one is refused rather than
   * putting a second default back. */
  setDefaultProfile(userId: string, name: string): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function byName(a: SettingsDoc, b: SettingsDoc): number {
  return (a.name ?? "").localeCompare(b.name ?? "");
}

// ---------- memory (dev/tests) ----------

export class MemorySettings implements SettingsCollection {
  private readonly docs = new Map<string, SettingsDoc>();

  async get(id: string): Promise<SettingsDoc | null> {
    const doc = this.docs.get(id);
    return doc ? clone(doc) : null;
  }

  async listProfiles(userId: string): Promise<SettingsDoc[]> {
    return [...this.docs.values()].filter((d) => d.level === "profile" && d.userId === userId).sort(byName).map(clone);
  }

  async put(doc: SettingsDoc, expectedVersion: number): Promise<SettingsWriteResult> {
    const current = this.docs.get(doc.id);
    if ((current?.version ?? 0) !== expectedVersion) return { ok: false, current: current ? clone(current) : null };
    const stored = { ...clone(doc), version: expectedVersion + 1 };
    this.docs.set(doc.id, stored);
    return { ok: true, doc: clone(stored) };
  }

  async delete(id: string, expectedVersion: number): Promise<SettingsWriteResult | { ok: true; doc: null }> {
    const current = this.docs.get(id);
    if (!current || current.version !== expectedVersion) return { ok: false, current: current ? clone(current) : null };
    this.docs.delete(id);
    return { ok: true, doc: null };
  }

  async setDefaultProfile(userId: string, name: string): Promise<void> {
    const now = new Date().toISOString();
    for (const doc of this.docs.values()) {
      if (doc.level !== "profile" || doc.userId !== userId) continue;
      const want = doc.name === name;
      if ((doc.isDefault === true) === want) continue;
      if (want) doc.isDefault = true;
      else delete doc.isDefault;
      doc.version += 1;
      doc.updatedAt = now;
    }
  }
}

// ---------- Mongo ----------

export type SettingsDocMongo = SettingsDoc & { _id: string };

function fromMongo(doc: SettingsDocMongo | null): SettingsDoc | null {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

export class MongoSettings implements SettingsCollection {
  private readonly col: MongoCollection<SettingsDocMongo>;
  constructor(col: MongoCollection<SettingsDocMongo>) {
    this.col = col;
  }

  async get(id: string): Promise<SettingsDoc | null> {
    return fromMongo(await this.col.findOne({ _id: id }));
  }

  async listProfiles(userId: string): Promise<SettingsDoc[]> {
    const docs = await this.col.find({ level: "profile", userId }).sort({ name: 1 }).toArray();
    return docs.map((d) => fromMongo(d)!);
  }

  async put(doc: SettingsDoc, expectedVersion: number): Promise<SettingsWriteResult> {
    const stored: SettingsDocMongo = { ...doc, _id: doc.id, version: expectedVersion + 1 };
    if (expectedVersion === 0) {
      try {
        await this.col.insertOne(stored);
        return { ok: true, doc: fromMongo(stored)! };
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        return { ok: false, current: await this.get(doc.id) };
      }
    }
    const res = await this.col.replaceOne({ _id: doc.id, version: expectedVersion }, stored);
    if (res.matchedCount === 1) return { ok: true, doc: fromMongo(stored)! };
    return { ok: false, current: await this.get(doc.id) };
  }

  async delete(id: string, expectedVersion: number): Promise<SettingsWriteResult | { ok: true; doc: null }> {
    const res = await this.col.deleteOne({ _id: id, version: expectedVersion });
    if (res.deletedCount === 1) return { ok: true, doc: null };
    return { ok: false, current: await this.get(id) };
  }

  async setDefaultProfile(userId: string, name: string): Promise<void> {
    const now = new Date().toISOString();
    await this.col.updateMany(
      { level: "profile", userId, name: { $ne: name }, isDefault: true },
      { $unset: { isDefault: "" }, $inc: { version: 1 }, $set: { updatedAt: now } },
    );
    await this.col.updateOne(
      { level: "profile", userId, name, isDefault: { $ne: true } },
      { $set: { isDefault: true, updatedAt: now }, $inc: { version: 1 } },
    );
  }
}

/** Called from MongoStore.ensureIndexes (store/mongo.ts). */
export async function ensureSettingsIndexes(db: Db): Promise<void> {
  await db.collection("settings").createIndex({ level: 1, userId: 1, name: 1 });
}
