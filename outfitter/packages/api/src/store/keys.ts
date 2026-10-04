// Central sign-in, CA-4 + CA-5 (#393, #394, docs/specs/central-auth.md §4-§5): what Outfitter keeps
// about keys. Never a key value: a router key's alias and LiteLLM token id (to delete it later), and
// which personal provider keys a user has stored (the values live in Secret Manager). Owned by task
// D; the shapes and interfaces are the contract the Devices page (CA-1 web), account settings
// (CA-7) and run keys (CA-6) read.

import type { Collection as MongoCollection, Db } from "mongodb";

export type RouterKeyKind = "device" | "run" | "system";

export interface RouterKey {
  /** The LiteLLM key_alias, also the id here: `kernal-device-<deviceId>`, `outfitter-run-<runId>`,
   * or `outfitter-system-<name>`. */
  alias: string;
  kind: RouterKeyKind;
  /** LiteLLM user_id (central/user-id.ts). Absent for kind "system". */
  userId?: string;
  ownerEmail?: string;
  deviceId?: string;
  runId?: string;
  /** LiteLLM's id for the key (`token` in /key/generate's answer), the hash it deletes by. */
  litellmTokenId?: string;
  models?: string[];
  maxBudget?: number;
  budgetDuration?: string;
  createdAt: string;
  /** LiteLLM's own expiry (run keys always have one). */
  expiresAt?: string;
  /** Set once /key/delete succeeded (or LiteLLM said the key was gone). */
  deletedAt?: string;
  /** Set when a delete failed; the sweep retries it. */
  deleteFailedAt?: string;
}

export interface RouterKeysCollection {
  insert(key: RouterKey): Promise<void>;
  findByAlias(alias: string): Promise<RouterKey | null>;
  /** The live (not deleted) key of a device, if any. */
  findActiveForDevice(deviceId: string): Promise<RouterKey | null>;
  listActiveForUser(userId: string): Promise<RouterKey[]>;
  /** Keys whose delete is still owed: deleteFailedAt set, or kind "run" past expiresAt. */
  listPendingDelete(limit: number): Promise<RouterKey[]>;
  update(alias: string, patch: Partial<RouterKey>): Promise<RouterKey | null>;
}

/** A personal provider key's metadata (CA-4). The value is the latest version of the Secret
 * Manager secret `secretName`; the API never reads it back except to deliver it to a device. */
export interface ProviderKeyMeta {
  /** `<userId>:<provider>`. */
  id: string;
  userId: string;
  provider: string;
  secretName: string;
  /** Last 4 characters, for "sk-…a1b2" in the UI. Never more. */
  last4: string;
  setAt: string;
  setBy: string;
}

export interface ProviderKeysCollection {
  listForUser(userId: string): Promise<ProviderKeyMeta[]>;
  upsert(meta: ProviderKeyMeta): Promise<void>;
  delete(id: string): Promise<boolean>;
}

const notImplemented = (what: string): never => {
  throw new Error(`${what}: not implemented yet (CA-4/CA-5, docs/specs/central-auth.md)`);
};

export class MemoryRouterKeys implements RouterKeysCollection {
  async insert(_key: RouterKey): Promise<void> {
    notImplemented("routerKeys.insert");
  }
  async findByAlias(_alias: string): Promise<RouterKey | null> {
    return null;
  }
  async findActiveForDevice(_deviceId: string): Promise<RouterKey | null> {
    return null;
  }
  async listActiveForUser(_userId: string): Promise<RouterKey[]> {
    return [];
  }
  async listPendingDelete(_limit: number): Promise<RouterKey[]> {
    return [];
  }
  async update(_alias: string, _patch: Partial<RouterKey>): Promise<RouterKey | null> {
    return notImplemented("routerKeys.update");
  }
}

export class MemoryProviderKeys implements ProviderKeysCollection {
  async listForUser(_userId: string): Promise<ProviderKeyMeta[]> {
    return [];
  }
  async upsert(_meta: ProviderKeyMeta): Promise<void> {
    notImplemented("providerKeys.upsert");
  }
  async delete(_id: string): Promise<boolean> {
    return notImplemented("providerKeys.delete");
  }
}

export type RouterKeyDoc = RouterKey & { _id: string };
export type ProviderKeyDoc = ProviderKeyMeta & { _id: string };

export class MongoRouterKeys implements RouterKeysCollection {
  private readonly col: MongoCollection<RouterKeyDoc>;
  constructor(col: MongoCollection<RouterKeyDoc>) {
    this.col = col;
  }
  async insert(_key: RouterKey): Promise<void> {
    void this.col;
    notImplemented("routerKeys.insert");
  }
  async findByAlias(_alias: string): Promise<RouterKey | null> {
    return null;
  }
  async findActiveForDevice(_deviceId: string): Promise<RouterKey | null> {
    return null;
  }
  async listActiveForUser(_userId: string): Promise<RouterKey[]> {
    return [];
  }
  async listPendingDelete(_limit: number): Promise<RouterKey[]> {
    return [];
  }
  async update(_alias: string, _patch: Partial<RouterKey>): Promise<RouterKey | null> {
    return notImplemented("routerKeys.update");
  }
}

export class MongoProviderKeys implements ProviderKeysCollection {
  private readonly col: MongoCollection<ProviderKeyDoc>;
  constructor(col: MongoCollection<ProviderKeyDoc>) {
    this.col = col;
  }
  async listForUser(_userId: string): Promise<ProviderKeyMeta[]> {
    void this.col;
    return [];
  }
  async upsert(_meta: ProviderKeyMeta): Promise<void> {
    notImplemented("providerKeys.upsert");
  }
  async delete(_id: string): Promise<boolean> {
    return notImplemented("providerKeys.delete");
  }
}

/** Called from MongoStore.ensureIndexes (store/mongo.ts). */
export async function ensureKeyIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection("routerKeys").createIndex({ deviceId: 1, deletedAt: 1 }),
    db.collection("routerKeys").createIndex({ userId: 1, deletedAt: 1 }),
    db.collection("routerKeys").createIndex({ deletedAt: 1, deleteFailedAt: 1, expiresAt: 1 }),
    db.collection("providerKeys").createIndex({ userId: 1 }),
  ]);
}
