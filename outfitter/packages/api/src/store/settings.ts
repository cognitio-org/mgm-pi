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
  /** Makes `name` the user's only default profile (atomic enough: clears the others first). */
  setDefaultProfile(userId: string, name: string): Promise<void>;
}

const notImplemented = (what: string): never => {
  throw new Error(`${what}: not implemented yet (CA-3, docs/specs/central-auth.md)`);
};

export class MemorySettings implements SettingsCollection {
  /** Nothing is stored until CA-3 lands: every level reads as unset. */
  async get(_id: string): Promise<SettingsDoc | null> {
    return null;
  }
  async listProfiles(_userId: string): Promise<SettingsDoc[]> {
    return [];
  }
  async put(_doc: SettingsDoc, _expectedVersion: number): Promise<SettingsWriteResult> {
    return notImplemented("settings.put");
  }
  async delete(_id: string, _expectedVersion: number): Promise<SettingsWriteResult | { ok: true; doc: null }> {
    return notImplemented("settings.delete");
  }
  async setDefaultProfile(_userId: string, _name: string): Promise<void> {
    notImplemented("settings.setDefaultProfile");
  }
}

export type SettingsDocMongo = SettingsDoc & { _id: string };

export class MongoSettings implements SettingsCollection {
  private readonly col: MongoCollection<SettingsDocMongo>;
  constructor(col: MongoCollection<SettingsDocMongo>) {
    this.col = col;
  }
  async get(_id: string): Promise<SettingsDoc | null> {
    void this.col;
    return null;
  }
  async listProfiles(_userId: string): Promise<SettingsDoc[]> {
    return [];
  }
  async put(_doc: SettingsDoc, _expectedVersion: number): Promise<SettingsWriteResult> {
    return notImplemented("settings.put");
  }
  async delete(_id: string, _expectedVersion: number): Promise<SettingsWriteResult | { ok: true; doc: null }> {
    return notImplemented("settings.delete");
  }
  async setDefaultProfile(_userId: string, _name: string): Promise<void> {
    notImplemented("settings.setDefaultProfile");
  }
}

/** Called from MongoStore.ensureIndexes (store/mongo.ts). */
export async function ensureSettingsIndexes(db: Db): Promise<void> {
  await db.collection("settings").createIndex({ level: 1, userId: 1, name: 1 });
}
