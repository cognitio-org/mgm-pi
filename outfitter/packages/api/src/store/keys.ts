// Central sign-in, CA-4 + CA-5 (#393, #394, docs/specs/central-auth.md §4-§5): what Outfitter keeps
// about keys. Never a key value: a router key's alias and LiteLLM token id (to delete it later), and
// which personal provider keys a user has stored (the values live in Secret Manager). Owned by task
// D; the shapes and interfaces are the contract the Devices page (CA-1 web), account settings
// (CA-7) and run keys (CA-6) read.
//
// Subscription secrets (docs/specs/subscriptions.md §3) are a sibling collection, not a provider id:
// Grok and Codex auth files do not fit a provider key. The value stays in Secret Manager.

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
  /** The MCP servers the key was minted with in `object_permission.mcp_servers` (GA-2); absent for a
   * key with no list. What reconcileOperatorKeys reads to revoke a former operator's gcloud access. */
  mcpServers?: string[];
  /** The router toolset ids the key was minted with in `object_permission.mcp_toolsets` (GB-3); absent
   * for a key with none. reconcileOperatorKeys treats these like `gcloud`. */
  mcpToolsets?: string[];
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
  /** Stores a new record, replacing one with the same alias: a re-mint reuses its device's alias
   * (`mintDeviceKey` deletes the old key in LiteLLM first). */
  insert(key: RouterKey): Promise<void>;
  findByAlias(alias: string): Promise<RouterKey | null>;
  /** The live (not deleted) key of a device, if any. */
  findActiveForDevice(deviceId: string): Promise<RouterKey | null>;
  listActiveForUser(userId: string): Promise<RouterKey[]>;
  /** Live device keys minted with `server` in their MCP list, at most `limit`. */
  listActiveDeviceKeysWithMcpServer(server: string, limit: number): Promise<RouterKey[]>;
  /** Live device keys minted with any toolset grant (GB-3). */
  listActiveDeviceKeysWithMcpToolsets(limit: number): Promise<RouterKey[]>;
  /** Keys whose delete is still owed: deleteFailedAt set, or kind "run" past expiresAt. */
  listPendingDelete(limit: number): Promise<RouterKey[]>;
  /** Merges `patch`; a field set to undefined is removed (deleteFailedAt once a retry worked). */
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
  /** Sorted by provider. */
  listForUser(userId: string): Promise<ProviderKeyMeta[]>;
  upsert(meta: ProviderKeyMeta): Promise<void>;
  delete(id: string): Promise<boolean>;
}

/** listPendingDelete's rule, shared by both stores: a failed delete, or a run key whose LiteLLM
 * `duration` has already ended (deleting it then only tidies LiteLLM's key list). */
function deleteOwed(key: RouterKey, now: string): boolean {
  if (key.deletedAt) return false;
  if (key.deleteFailedAt) return true;
  return key.kind === "run" && !!key.expiresAt && key.expiresAt <= now;
}

/** `patch` applied to `key`, with undefined fields removed rather than kept as undefined. */
function applyPatch(key: RouterKey, patch: Partial<RouterKey>): RouterKey {
  const next: Record<string, unknown> = { ...key };
  for (const [field, value] of Object.entries(patch)) {
    if (field === "alias") continue;
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  return next as unknown as RouterKey;
}

// ---------- memory (dev/tests) ----------

export class MemoryRouterKeys implements RouterKeysCollection {
  private readonly keys = new Map<string, RouterKey>();

  async insert(key: RouterKey): Promise<void> {
    this.keys.set(key.alias, { ...key });
  }
  async findByAlias(alias: string): Promise<RouterKey | null> {
    const key = this.keys.get(alias);
    return key ? { ...key } : null;
  }
  async findActiveForDevice(deviceId: string): Promise<RouterKey | null> {
    for (const key of this.keys.values()) {
      if (key.deviceId === deviceId && !key.deletedAt) return { ...key };
    }
    return null;
  }
  async listActiveForUser(userId: string): Promise<RouterKey[]> {
    return [...this.keys.values()].filter((k) => k.userId === userId && !k.deletedAt).map((k) => ({ ...k }));
  }
  async listActiveDeviceKeysWithMcpServer(server: string, limit: number): Promise<RouterKey[]> {
    return [...this.keys.values()]
      .filter((k) => k.kind === "device" && !k.deletedAt && k.mcpServers?.includes(server))
      .slice(0, limit)
      .map((k) => ({ ...k }));
  }
  async listActiveDeviceKeysWithMcpToolsets(limit: number): Promise<RouterKey[]> {
    return [...this.keys.values()]
      .filter((k) => k.kind === "device" && !k.deletedAt && (k.mcpToolsets?.length ?? 0) > 0)
      .slice(0, limit)
      .map((k) => ({ ...k }));
  }
  async listPendingDelete(limit: number): Promise<RouterKey[]> {
    const now = new Date().toISOString();
    return [...this.keys.values()]
      .filter((k) => deleteOwed(k, now))
      .slice(0, limit)
      .map((k) => ({ ...k }));
  }
  async update(alias: string, patch: Partial<RouterKey>): Promise<RouterKey | null> {
    const key = this.keys.get(alias);
    if (!key) return null;
    const next = applyPatch(key, patch);
    this.keys.set(alias, next);
    return { ...next };
  }
}

export class MemoryProviderKeys implements ProviderKeysCollection {
  private readonly metas = new Map<string, ProviderKeyMeta>();

  async listForUser(userId: string): Promise<ProviderKeyMeta[]> {
    return [...this.metas.values()]
      .filter((m) => m.userId === userId)
      .sort((a, b) => a.provider.localeCompare(b.provider))
      .map((m) => ({ ...m }));
  }
  async upsert(meta: ProviderKeyMeta): Promise<void> {
    this.metas.set(meta.id, { ...meta });
  }
  async delete(id: string): Promise<boolean> {
    return this.metas.delete(id);
  }
}

/** A personal subscription secret's metadata (docs/specs/subscriptions.md §3). The value is the
 * Secret Manager version `version` of `secretName`. */
export interface SubscriptionSecretMeta {
  /** `<userId>:subscription:<vendor>`. */
  id: string;
  userId: string;
  vendor: string;
  secretName: string;
  /** The Secret Manager version just written. */
  version: number;
  /** Last 4 hex digits of sha256 of the exact stored bytes. */
  last4: string;
  setAt: string;
  setBy: string;
}

export interface SubscriptionSecretsCollection {
  /** Sorted by vendor. */
  listForUser(userId: string): Promise<SubscriptionSecretMeta[]>;
  get(id: string): Promise<SubscriptionSecretMeta | null>;
  upsert(meta: SubscriptionSecretMeta): Promise<void>;
  /** Writes `meta` only when the stored version is still `expectedVersion`. `null` means no
   * document yet: success only if this call inserts, and a concurrent insert loses. Never stores
   * a version number lower than or equal to the one already stored. */
  compareAndSwap(meta: SubscriptionSecretMeta, expectedVersion: number | null): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

export class MemorySubscriptionSecrets implements SubscriptionSecretsCollection {
  private readonly metas = new Map<string, SubscriptionSecretMeta>();

  async listForUser(userId: string): Promise<SubscriptionSecretMeta[]> {
    return [...this.metas.values()]
      .filter((m) => m.userId === userId)
      .sort((a, b) => a.vendor.localeCompare(b.vendor))
      .map((m) => ({ ...m }));
  }
  async get(id: string): Promise<SubscriptionSecretMeta | null> {
    const meta = this.metas.get(id);
    return meta ? { ...meta } : null;
  }
  async upsert(meta: SubscriptionSecretMeta): Promise<void> {
    this.metas.set(meta.id, { ...meta });
  }
  async compareAndSwap(meta: SubscriptionSecretMeta, expectedVersion: number | null): Promise<boolean> {
    const current = this.metas.get(meta.id);
    if (expectedVersion === null) {
      if (current) return false;
      this.metas.set(meta.id, { ...meta });
      return true;
    }
    if (!current || current.version !== expectedVersion || meta.version <= current.version) return false;
    this.metas.set(meta.id, { ...meta });
    return true;
  }
  async delete(id: string): Promise<boolean> {
    return this.metas.delete(id);
  }
}

// ---------- Mongo ----------

export type RouterKeyDoc = RouterKey & { _id: string };
/** `_id` is the meta's `id`, not stored twice. */
export type ProviderKeyDoc = Omit<ProviderKeyMeta, "id"> & { _id: string };

function routerKeyFromDoc(doc: RouterKeyDoc | null): RouterKey | null {
  if (!doc) return null;
  const { _id, ...key } = doc;
  return { ...key, alias: key.alias ?? _id };
}

function providerKeyFromDoc(doc: ProviderKeyDoc): ProviderKeyMeta {
  const { _id, ...meta } = doc;
  return { id: _id, ...meta };
}

export class MongoRouterKeys implements RouterKeysCollection {
  private readonly col: MongoCollection<RouterKeyDoc>;
  constructor(col: MongoCollection<RouterKeyDoc>) {
    this.col = col;
  }
  async insert(key: RouterKey): Promise<void> {
    // replaceOne, not insertOne: a re-mint keeps the alias, and the old record's deletedAt and
    // deleteFailedAt must not carry over to the new key.
    await this.col.replaceOne({ _id: key.alias }, { ...key }, { upsert: true });
  }
  async findByAlias(alias: string): Promise<RouterKey | null> {
    return routerKeyFromDoc(await this.col.findOne({ _id: alias }));
  }
  async findActiveForDevice(deviceId: string): Promise<RouterKey | null> {
    return routerKeyFromDoc(await this.col.findOne({ deviceId, deletedAt: { $exists: false } }));
  }
  async listActiveForUser(userId: string): Promise<RouterKey[]> {
    const rows = await this.col.find({ userId, deletedAt: { $exists: false } }).toArray();
    return rows.map((r) => routerKeyFromDoc(r)!);
  }
  async listActiveDeviceKeysWithMcpServer(server: string, limit: number): Promise<RouterKey[]> {
    const rows = await this.col.find({ kind: "device", mcpServers: server, deletedAt: { $exists: false } }).limit(limit).toArray();
    return rows.map((r) => routerKeyFromDoc(r)!);
  }
  async listActiveDeviceKeysWithMcpToolsets(limit: number): Promise<RouterKey[]> {
    const rows = await this.col.find({ kind: "device", "mcpToolsets.0": { $exists: true }, deletedAt: { $exists: false } }).limit(limit).toArray();
    return rows.map((r) => routerKeyFromDoc(r)!);
  }
  async listPendingDelete(limit: number): Promise<RouterKey[]> {
    const now = new Date().toISOString();
    const rows = await this.col
      .find({
        deletedAt: { $exists: false },
        $or: [{ deleteFailedAt: { $exists: true } }, { kind: "run", expiresAt: { $lte: now } }],
      })
      .limit(limit)
      .toArray();
    return rows.map((r) => routerKeyFromDoc(r)!);
  }
  async update(alias: string, patch: Partial<RouterKey>): Promise<RouterKey | null> {
    const set: Record<string, unknown> = {};
    const unset: Record<string, ""> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (field === "alias") continue;
      if (value === undefined) unset[field] = "";
      else set[field] = value;
    }
    if (!Object.keys(set).length && !Object.keys(unset).length) return this.findByAlias(alias);
    const doc = await this.col.findOneAndUpdate(
      { _id: alias },
      { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: "after" },
    );
    return routerKeyFromDoc(doc);
  }
}

export class MongoProviderKeys implements ProviderKeysCollection {
  private readonly col: MongoCollection<ProviderKeyDoc>;
  constructor(col: MongoCollection<ProviderKeyDoc>) {
    this.col = col;
  }
  async listForUser(userId: string): Promise<ProviderKeyMeta[]> {
    const rows = await this.col.find({ userId }).sort({ provider: 1 }).toArray();
    return rows.map(providerKeyFromDoc);
  }
  async upsert(meta: ProviderKeyMeta): Promise<void> {
    const { id, ...rest } = meta;
    await this.col.replaceOne({ _id: id }, rest, { upsert: true });
  }
  async delete(id: string): Promise<boolean> {
    const result = await this.col.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }
}

/** `_id` is the meta's `id`, not stored twice. */
export type SubscriptionSecretDoc = Omit<SubscriptionSecretMeta, "id"> & { _id: string };

function subscriptionSecretFromDoc(doc: SubscriptionSecretDoc): SubscriptionSecretMeta {
  const { _id, ...meta } = doc;
  return { id: _id, ...meta };
}

export class MongoSubscriptionSecrets implements SubscriptionSecretsCollection {
  private readonly col: MongoCollection<SubscriptionSecretDoc>;
  constructor(col: MongoCollection<SubscriptionSecretDoc>) {
    this.col = col;
  }
  async listForUser(userId: string): Promise<SubscriptionSecretMeta[]> {
    const rows = await this.col.find({ userId }).sort({ vendor: 1 }).toArray();
    return rows.map(subscriptionSecretFromDoc);
  }
  async get(id: string): Promise<SubscriptionSecretMeta | null> {
    const doc = await this.col.findOne({ _id: id });
    return doc ? subscriptionSecretFromDoc(doc) : null;
  }
  async upsert(meta: SubscriptionSecretMeta): Promise<void> {
    const { id, ...rest } = meta;
    await this.col.replaceOne({ _id: id }, rest, { upsert: true });
  }
  async compareAndSwap(meta: SubscriptionSecretMeta, expectedVersion: number | null): Promise<boolean> {
    const { id, ...rest } = meta;
    if (expectedVersion === null) {
      try {
        await this.col.insertOne({ _id: id, ...rest });
        return true;
      } catch (err) {
        if (typeof err === "object" && err !== null && (err as { code?: number }).code === 11000) return false;
        throw err;
      }
    }
    // Filter on `_id` and `version`, not an unconditional replace: a stale writer must not move
    // the stored version backward. `version <= expected` loses even when the filter would match.
    if (meta.version <= expectedVersion) return false;
    const result = await this.col.replaceOne({ _id: id, version: expectedVersion }, rest);
    return result.matchedCount === 1;
  }
  async delete(id: string): Promise<boolean> {
    const result = await this.col.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }
}

/** Called from MongoStore.ensureIndexes (store/mongo.ts). */
export async function ensureKeyIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection("routerKeys").createIndex({ deviceId: 1, deletedAt: 1 }),
    db.collection("routerKeys").createIndex({ userId: 1, deletedAt: 1 }),
    db.collection("routerKeys").createIndex({ deletedAt: 1, deleteFailedAt: 1, expiresAt: 1 }),
    db.collection("providerKeys").createIndex({ userId: 1 }),
    db.collection("subscriptionSecrets").createIndex({ userId: 1 }),
  ]);
}
