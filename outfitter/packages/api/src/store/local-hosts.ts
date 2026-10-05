// Local Host (epic #378, docs/specs/local-host.md §1.5): the `localHosts` collection, one record per
// person per machine that shares (or once shared) its local models. Owned by task A (#382/#383):
// the shapes, the interface and hostStatus/routerFingerprint are the contract task B (#384) and the
// web pages (#385/#388) read; A may add optional fields and methods.
//
// Never a secret here: the per-host bearer lives in Secret Manager (`bearerSecretName`), the ngrok
// authtoken only in the one answer that hands it out. Mongo holds ids and a bearer hash.

import { createHash } from "node:crypto";
import type { Collection as MongoCollection, Db, Filter } from "mongodb";
import {
  HEARTBEAT_INTERVAL_SECONDS,
  STALE_AFTER_MISSED,
  STALE_SLACK_SECONDS,
  type HeartbeatModel,
  type HeartbeatServer,
  type HeartbeatTunnel,
  type LocalHostStatus,
} from "../local-hosts/contract.ts";

/** The api-side ngrok resources and bearer of a managed host (task A, §2). */
export interface LocalHostManaged {
  /** The ngrok credential the laptop's agent runs with. */
  credentialId: string;
  credentialIssuedAt: string;
  /** The cloud endpoint (absent after the idle sweep deleted it; the next credentials call makes one). */
  endpointId?: string;
  /** `https://<publicSlug>.<LOCAL_HOST_DOMAIN>`, the router's api_base without /v1. */
  publicUrl?: string;
  /** Secret Manager name holding the bearer (naming.ts bearerSecretName). */
  bearerSecret: string;
  /** Bumped on every new bearer, so the router entries are updated (it is in routerFingerprint). */
  bearerVersion: number;
  /** sha256 hex of the bearer (naming.ts bearerHash). */
  bearerHash: string;
}

export interface LocalHost {
  /** `lh_` + 24 hex (naming.ts localHostId(userId, hostId)); the Mongo `_id`. */
  id: string;
  userId: string;
  ownerEmail: string;
  /** Kernal's `h_...` id. */
  hostId: string;
  /** The device whose token sent the last heartbeat. */
  deviceId: string;
  hostName: string;
  kernalVersion?: string;
  platform?: string;
  /** Reserved (owner decision 2026-10-04): "everyone" in wave 2; later issues narrow it. */
  accessGroup: string;
  /** Fixed at creation (naming.ts routerPrefixCandidates); unique. */
  routerPrefix: string;
  shareModels: boolean;
  discoveryKey: string;
  servers: HeartbeatServer[];
  models: HeartbeatModel[];
  /** As the laptop last reported it. */
  tunnel: HeartbeatTunnel;
  managed?: LocalHostManaged;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  /** Set when the device that owned it was revoked; the next accepted heartbeat (a newer login) clears it. */
  revokedAt?: string;
  /** The highest bearerVersion ever minted for this record; revoke, the idle sweep and DELETE never
   * clear it, so the next bearer is always that + 1 (§2.3). */
  lastBearerVersion?: number;
  /** Tombstone of a DELETE (§1.8): sharing off, no models, no `managed`; keeps routerPrefix for the
   * same user. The next heartbeat revives it. */
  deletedAt?: string;
  /** A credentials call holds the host until this time (ISO), so two never interleave. Task A's
   * (additive). */
  issuingUntil?: string;
}

/** What updateIf requires of the stored record; every given condition must hold. Task A's
 * (additive). */
export interface LocalHostExpect {
  /** revokedAt absent (or null). */
  notRevoked?: true;
  /** deletedAt absent (or null): not a tombstone. */
  notDeleted?: true;
  shareModels?: boolean;
  /** managed.credentialId equals this; null: no `managed` at all. */
  credentialId?: string | null;
  /** managed.endpointId equals this. */
  endpointId?: string;
  /** No credentials call holds the record at this ISO time (issuingUntil absent or earlier). */
  freeAt?: string;
  /** issuingUntil equals this (a call releasing its own hold). */
  issuingUntil?: string;
}

export interface LocalHostsCollection {
  findById(id: string): Promise<LocalHost | null>;
  findByRouterPrefix(routerPrefix: string): Promise<LocalHost | null>;
  /** Newest lastSeenAt first. */
  listForUser(userId: string): Promise<LocalHost[]>;
  listForDevice(deviceId: string): Promise<LocalHost[]>;
  /** shareModels true and not revoked, newest lastSeenAt first: the router's and the listing's input. */
  listSharing(): Promise<LocalHost[]>;
  /** Every record, for the sweeps; at most `limit`. */
  listAll(limit: number): Promise<LocalHost[]>;
  /** Insert or replace by id. Rejects (throws LocalHostPrefixTakenError) when another record holds
   * the same routerPrefix. */
  upsert(host: LocalHost): Promise<void>;
  /** Merges `patch` (a field set to undefined is removed); null when there is no such record. */
  update(id: string, patch: Partial<Omit<LocalHost, "id">>): Promise<LocalHost | null>;
  /** update, only when the stored record meets `expect`; null when it doesn't (or is gone). */
  updateIf(id: string, expect: LocalHostExpect, patch: Partial<Omit<LocalHost, "id">>): Promise<LocalHost | null>;
  delete(id: string): Promise<boolean>;
}

function meets(h: LocalHost, e: LocalHostExpect): boolean {
  if (e.notRevoked && h.revokedAt) return false;
  if (e.notDeleted && h.deletedAt) return false;
  if (e.shareModels !== undefined && h.shareModels !== e.shareModels) return false;
  if (e.credentialId === null && h.managed) return false;
  if (typeof e.credentialId === "string" && h.managed?.credentialId !== e.credentialId) return false;
  if (e.endpointId !== undefined && h.managed?.endpointId !== e.endpointId) return false;
  if (e.freeAt !== undefined && h.issuingUntil && h.issuingUntil >= e.freeAt) return false;
  if (e.issuingUntil !== undefined && h.issuingUntil !== e.issuingUntil) return false;
  return true;
}

export class LocalHostPrefixTakenError extends Error {
  constructor(prefix: string) {
    super(`router prefix ${prefix} is taken`);
  }
}

// ---------- the rules both tasks share (spec-owned) ----------

/** Seconds after the last heartbeat at which a host counts as stale. */
export function staleAfterSeconds(intervalSeconds: number = HEARTBEAT_INTERVAL_SECONDS): number {
  return STALE_AFTER_MISSED * intervalSeconds + STALE_SLACK_SECONDS;
}

/**
 * The host's status (§1.5), in this order: revoked; stale (no heartbeat for staleAfterSeconds);
 * not-sharing; offline (tunnel not up, or the server it forwards to didn't answer); online.
 */
export function hostStatus(host: LocalHost, now: Date = new Date()): LocalHostStatus {
  if (host.revokedAt) return "revoked";
  if (now.getTime() - Date.parse(host.lastSeenAt) > staleAfterSeconds() * 1000) return "stale";
  if (!host.shareModels) return "not-sharing";
  const server = host.servers.find((s) => s.id === host.tunnel.server);
  if (host.tunnel.state !== "up" || !server?.ok) return "offline";
  return "online";
}

/** The models the tunnel actually reaches: those on the one server it forwards to (§4.6). */
export function sharedModels(host: LocalHost): HeartbeatModel[] {
  return host.tunnel.server ? host.models.filter((m) => m.server === host.tunnel.server) : [];
}

/**
 * Everything the router entries are derived from (§3.4), as one hash: a change means task B must
 * reconcile this host. The registry calls LocalHostEvents.changed when it differs between the
 * stored record and the new one, and B stamps it on each entry it writes.
 */
export function routerFingerprint(host: LocalHost, now: Date = new Date()): string {
  const status = hostStatus(host, now);
  const canon = JSON.stringify({
    status,
    managed: host.tunnel.managed,
    publicUrl: host.managed?.publicUrl ?? null,
    bearerVersion: host.managed?.bearerVersion ?? null,
    accessGroup: host.accessGroup,
    routerPrefix: host.routerPrefix,
    hostName: host.hostName,
    models: sharedModels(host).map((m) => [m.id, m.kind, m.loaded ?? null, m.contextLength ?? null, m.type ?? null, m.vision ?? null, m.toolUse ?? null]),
  });
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

// ---------- memory (dev/tests) ----------

const byLastSeen = (a: LocalHost, b: LocalHost) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0);
const copy = (h: LocalHost): LocalHost => structuredClone(h);

function applyPatch(host: LocalHost, patch: Partial<Omit<LocalHost, "id">>): LocalHost {
  const next: Record<string, unknown> = { ...host };
  for (const [field, value] of Object.entries(patch)) {
    if (field === "id") continue;
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  return next as unknown as LocalHost;
}

export class MemoryLocalHosts implements LocalHostsCollection {
  private readonly hosts = new Map<string, LocalHost>();

  async findById(id: string): Promise<LocalHost | null> {
    const h = this.hosts.get(id);
    return h ? copy(h) : null;
  }
  async findByRouterPrefix(routerPrefix: string): Promise<LocalHost | null> {
    for (const h of this.hosts.values()) if (h.routerPrefix === routerPrefix) return copy(h);
    return null;
  }
  async listForUser(userId: string): Promise<LocalHost[]> {
    return [...this.hosts.values()].filter((h) => h.userId === userId).sort(byLastSeen).map(copy);
  }
  async listForDevice(deviceId: string): Promise<LocalHost[]> {
    return [...this.hosts.values()].filter((h) => h.deviceId === deviceId).sort(byLastSeen).map(copy);
  }
  async listSharing(): Promise<LocalHost[]> {
    return [...this.hosts.values()].filter((h) => h.shareModels && !h.revokedAt).sort(byLastSeen).map(copy);
  }
  async listAll(limit: number): Promise<LocalHost[]> {
    return [...this.hosts.values()].sort(byLastSeen).slice(0, limit).map(copy);
  }
  async upsert(host: LocalHost): Promise<void> {
    for (const h of this.hosts.values()) {
      if (h.routerPrefix === host.routerPrefix && h.id !== host.id) throw new LocalHostPrefixTakenError(host.routerPrefix);
    }
    this.hosts.set(host.id, copy(host));
  }
  async update(id: string, patch: Partial<Omit<LocalHost, "id">>): Promise<LocalHost | null> {
    const h = this.hosts.get(id);
    if (!h) return null;
    const next = applyPatch(h, patch);
    this.hosts.set(id, next);
    return copy(next);
  }
  async updateIf(id: string, expect: LocalHostExpect, patch: Partial<Omit<LocalHost, "id">>): Promise<LocalHost | null> {
    const h = this.hosts.get(id);
    if (!h || !meets(h, expect)) return null;
    return this.update(id, patch);
  }
  async delete(id: string): Promise<boolean> {
    return this.hosts.delete(id);
  }
}

// ---------- Mongo ----------

/** `_id` is the host's `id`, not stored twice. */
export type LocalHostDoc = Omit<LocalHost, "id"> & { _id: string };

function fromDoc(doc: LocalHostDoc | null): LocalHost | null {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

const isDuplicateKey = (err: unknown) => (err as { code?: number })?.code === 11000;

/** A copy without undefined fields, at any depth. The MongoClient has no `ignoreUndefined`, so an
 * undefined field would be stored as null (and `revokedAt: null` would read as revoked to a filter
 * that only checks existence). */
function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutUndefined) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, withoutUndefined(v)]),
    ) as T;
  }
  return value;
}

export class MongoLocalHosts implements LocalHostsCollection {
  private readonly col: MongoCollection<LocalHostDoc>;
  constructor(col: MongoCollection<LocalHostDoc>) {
    this.col = col;
  }
  async findById(id: string): Promise<LocalHost | null> {
    return fromDoc(await this.col.findOne({ _id: id }));
  }
  async findByRouterPrefix(routerPrefix: string): Promise<LocalHost | null> {
    return fromDoc(await this.col.findOne({ routerPrefix }));
  }
  async listForUser(userId: string): Promise<LocalHost[]> {
    return (await this.col.find({ userId }).sort({ lastSeenAt: -1 }).toArray()).map((d) => fromDoc(d)!);
  }
  async listForDevice(deviceId: string): Promise<LocalHost[]> {
    return (await this.col.find({ deviceId }).sort({ lastSeenAt: -1 }).toArray()).map((d) => fromDoc(d)!);
  }
  async listSharing(): Promise<LocalHost[]> {
    // A stored null (an older write's leftover) counts as not revoked, like a missing field.
    const notRevoked = { $or: [{ revokedAt: { $exists: false } }, { revokedAt: { $type: "null" as const } }] };
    return (await this.col.find({ shareModels: true, ...notRevoked }).sort({ lastSeenAt: -1 }).toArray()).map((d) => fromDoc(d)!);
  }
  async listAll(limit: number): Promise<LocalHost[]> {
    return (await this.col.find({}).sort({ lastSeenAt: -1 }).limit(limit).toArray()).map((d) => fromDoc(d)!);
  }
  async upsert(host: LocalHost): Promise<void> {
    const { id, ...rest } = host;
    try {
      // A replace: a field left out (or undefined, stripped here) is gone from the stored document.
      await this.col.replaceOne({ _id: id }, withoutUndefined(rest), { upsert: true });
    } catch (err) {
      if (isDuplicateKey(err)) throw new LocalHostPrefixTakenError(host.routerPrefix);
      throw err;
    }
  }
  async update(id: string, patch: Partial<Omit<LocalHost, "id">>): Promise<LocalHost | null> {
    return this.updateWhere({ _id: id }, patch);
  }
  async updateIf(id: string, expect: LocalHostExpect, patch: Partial<Omit<LocalHost, "id">>): Promise<LocalHost | null> {
    const and: Filter<LocalHostDoc>[] = [{ _id: id }];
    if (expect.notRevoked) and.push({ $or: [{ revokedAt: { $exists: false } }, { revokedAt: { $type: "null" } }] });
    if (expect.notDeleted) and.push({ $or: [{ deletedAt: { $exists: false } }, { deletedAt: { $type: "null" } }] });
    if (expect.shareModels !== undefined) and.push({ shareModels: expect.shareModels });
    if (expect.credentialId === null) and.push({ $or: [{ managed: { $exists: false } }, { managed: { $type: "null" } }] });
    if (typeof expect.credentialId === "string") and.push({ "managed.credentialId": expect.credentialId });
    if (expect.endpointId !== undefined) and.push({ "managed.endpointId": expect.endpointId });
    if (expect.freeAt !== undefined) and.push({ $or: [{ issuingUntil: { $exists: false } }, { issuingUntil: { $type: "null" } }, { issuingUntil: { $lt: expect.freeAt } }] });
    if (expect.issuingUntil !== undefined) and.push({ issuingUntil: expect.issuingUntil });
    return this.updateWhere({ $and: and }, patch);
  }
  private async updateWhere(filter: Filter<LocalHostDoc>, patch: Partial<Omit<LocalHost, "id">>): Promise<LocalHost | null> {
    const set: Record<string, unknown> = {};
    const unset: Record<string, ""> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (field === "id") continue;
      if (value === undefined) unset[field] = "";
      else set[field] = withoutUndefined(value);
    }
    if (!Object.keys(set).length && !Object.keys(unset).length) return fromDoc(await this.col.findOne(filter));
    const doc = await this.col.findOneAndUpdate(
      filter,
      { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: "after" },
    );
    return fromDoc(doc);
  }
  async delete(id: string): Promise<boolean> {
    return (await this.col.deleteOne({ _id: id })).deletedCount > 0;
  }
}

/** Called from MongoStore.ensureIndexes (store/mongo.ts). */
export async function ensureLocalHostIndexes(db: Db): Promise<void> {
  const col = db.collection("localHosts");
  await Promise.all([
    col.createIndex({ routerPrefix: 1 }, { unique: true }),
    col.createIndex({ userId: 1, lastSeenAt: -1 }),
    col.createIndex({ deviceId: 1 }),
    col.createIndex({ shareModels: 1, lastSeenAt: -1 }),
  ]);
}
