// Central sign-in, CA-1 (#390, docs/specs/central-auth.md §1.4): the device-code flow's pending
// codes and the signed-in devices, with their memory and Mongo implementations. Owned by task A;
// the document shapes and collection interfaces below are the contract other tasks read (CA-5's
// router keys hang off a device id, the Devices page lists these), so a change to them goes
// through the spec.
//
// Every token here is stored as a sha256 hash only (central/device-tokens.ts), like a Dongle.

import type { Collection as MongoCollection, Db } from "mongodb";

export type DeviceCodeStatus = "pending" | "approved" | "denied" | "consumed";

/** One `kernal login` in progress. Lives at most DEVICE_CODE_TTL_MS (10 minutes); Mongo's TTL index
 * removes it soon after, so a code can never be approved late. */
export interface DeviceCode {
  id: string;
  /** sha256 hex of the `kdc_...` device code Kernal polls with. */
  deviceCodeHash: string;
  /** The code the person types or sees, normalized: 8 letters from USER_CODE_ALPHABET, no dash. */
  userCode: string;
  status: DeviceCodeStatus;
  /** What Kernal said about itself; shown on the approve page, never trusted for anything else. */
  deviceName: string;
  platform?: string;
  kernalVersion?: string;
  /** The caller's IP as the link role saw it (last X-Forwarded-For hop on Cloud Run). */
  requestIp?: string;
  createdAt: string;
  expiresAt: string;
  /** Seconds Kernal must wait between polls; raised by 5 on every slow_down. */
  interval: number;
  lastPolledAt?: string;
  /** Set on approve or deny, by the IAP-signed-in person on the web role. */
  decidedBy?: string;
  decidedAt?: string;
  decidedIp?: string;
  /** Set on approve: the device the first successful poll turns this code into. */
  deviceId?: string;
}

export type DeviceKind = "laptop" | "machine";

export type DeviceRevokeReason = "logout" | "revoked" | "operator" | "access-removed" | "refresh-reuse";

/** A signed-in Kernal (one per machine; every Kernal process on it shares the login). Holds the
 * current access/refresh pair as hashes. */
export interface Device {
  /** `dev_` + 16 random base32 characters. */
  id: string;
  /** central/user-id.ts userIdFor(ownerEmail). */
  userId: string;
  ownerEmail: string;
  name: string;
  platform?: string;
  kernalVersion?: string;
  /** "machine": an operator-created CI token (§1.7), no refresh token. */
  kind: DeviceKind;
  createdAt: string;
  approvedBy: string;
  approvedIp?: string;
  /** The device code's request IP: where Kernal was when it asked. */
  loginIp?: string;
  /** Throttled like a Dongle's lastUsedAt (once a minute at most). */
  lastSeenAt?: string;
  lastSeenIp?: string;
  revokedAt?: string;
  revokedReason?: DeviceRevokeReason;
  accessHash: string;
  accessExpiresAt: string;
  /** The access token a rotation replaced, still accepted until its own expiry, so a second Kernal
   * process holding it in memory isn't refused mid-hour (§1.3). */
  prevAccessHash?: string;
  prevAccessExpiresAt?: string;
  /** Absent for kind "machine". */
  refreshHash?: string;
  refreshExpiresAt?: string;
  /** The refresh token this one replaced, accepted until prevRefreshValidUntil (the rotation grace,
   * §1.3) so two Kernal processes refreshing at once, or a crash before the new pair was saved,
   * doesn't sign the machine out. */
  prevRefreshHash?: string;
  prevRefreshValidUntil?: string;
}

/** Lowercased email, or an `@domain` suffix: tokens.ts normalizeOwnerMatch's output. */
export type DeviceOwnerMatch = { email: string } | { domain: string };

export interface DeviceCodesCollection {
  /** Throws DuplicateDeviceCodeError when the userCode (or deviceCodeHash) is taken. */
  insert(code: DeviceCode): Promise<void>;
  findByDeviceCodeHash(hash: string): Promise<DeviceCode | null>;
  /** Only a code still `pending` and not past expiresAt. */
  findPendingByUserCode(userCode: string): Promise<DeviceCode | null>;
  /** Applies `patch` only while the code's status is one of `from` (atomic). Null when it wasn't. */
  transition(id: string, from: readonly DeviceCodeStatus[], patch: Partial<DeviceCode>): Promise<DeviceCode | null>;
  update(id: string, patch: Partial<DeviceCode>): Promise<DeviceCode | null>;
}

export interface DevicesCollection {
  insert(device: Device): Promise<void>;
  findById(id: string): Promise<Device | null>;
  /** Matches accessHash or prevAccessHash; the caller checks the matching expiry and revokedAt. */
  findByAccessHash(hash: string): Promise<Device | null>;
  /** Matches refreshHash or prevRefreshHash, whatever the grace; the caller tells them apart (a
   * replaced token used after its grace is a reuse, which revokes the device, §1.3). */
  findByRefreshHash(hash: string): Promise<Device | null>;
  /** Not revoked, newest first. `ownerEmail` is stored lowercased (user-id.ts normalizeEmail). */
  listActiveForOwner(ownerEmail: string): Promise<Device[]>;
  update(id: string, patch: Partial<Device>): Promise<Device | null>;
  /** Rotation: swaps the pair only if the device's refreshHash is still `expectedRefreshHash`
   * (atomic across instances). Null when another refresh won. */
  rotate(id: string, expectedRefreshHash: string, patch: Partial<Device>): Promise<Device | null>;
  /** Revokes every active device of `ownerEmail`; returns the ones it revoked. */
  revokeAllForOwner(ownerEmail: string, reason: DeviceRevokeReason, revokedAt: string): Promise<Device[]>;
  /** Marks one device revoked only if it isn't yet (atomic). Null when it already was, or doesn't
   * exist, so a revoke's lifecycle hook fires once. */
  revoke(id: string, reason: DeviceRevokeReason, revokedAt: string): Promise<Device | null>;
  /** revokeAllForOwner for an operator's email-or-domain match (POST /api/operator/devices/revoke). */
  revokeAllForOwners(match: DeviceOwnerMatch, reason: DeviceRevokeReason, revokedAt: string): Promise<Device[]>;
}

/** An insert's one expected failure: the userCode (or deviceCodeHash) is taken. POST
 * /api/device/code retries with a new code. Mongo raises it as E11000 on the unique index; the
 * memory store checks the same two fields. */
export class DuplicateDeviceCodeError extends Error {}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function ownerMatchesDevice(ownerEmail: string, match: DeviceOwnerMatch): boolean {
  const owner = ownerEmail.trim().toLowerCase();
  return "email" in match ? owner === match.email : owner.endsWith(match.domain);
}

// ---------- memory (dev/tests) ----------

export class MemoryDeviceCodes implements DeviceCodesCollection {
  private readonly rows = new Map<string, DeviceCode>();

  async insert(code: DeviceCode): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.userCode === code.userCode || row.deviceCodeHash === code.deviceCodeHash) {
        throw new DuplicateDeviceCodeError("device code already exists");
      }
    }
    this.rows.set(code.id, clone(code));
  }
  async findByDeviceCodeHash(hash: string): Promise<DeviceCode | null> {
    for (const row of this.rows.values()) if (row.deviceCodeHash === hash) return clone(row);
    return null;
  }
  async findPendingByUserCode(userCode: string): Promise<DeviceCode | null> {
    const now = new Date().toISOString();
    for (const row of this.rows.values()) {
      if (row.userCode === userCode && row.status === "pending" && row.expiresAt > now) return clone(row);
    }
    return null;
  }
  async transition(id: string, from: readonly DeviceCodeStatus[], patch: Partial<DeviceCode>): Promise<DeviceCode | null> {
    const row = this.rows.get(id);
    if (!row || !from.includes(row.status)) return null;
    return this.update(id, patch);
  }
  async update(id: string, patch: Partial<DeviceCode>): Promise<DeviceCode | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...clone(patch) };
    this.rows.set(id, next);
    return clone(next);
  }
}

export class MemoryDevices implements DevicesCollection {
  private readonly rows = new Map<string, Device>();

  async insert(device: Device): Promise<void> {
    if (this.rows.has(device.id)) throw new Error(`device ${device.id} already exists`);
    this.rows.set(device.id, clone(device));
  }
  async findById(id: string): Promise<Device | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }
  async findByAccessHash(hash: string): Promise<Device | null> {
    for (const row of this.rows.values()) if (row.accessHash === hash || row.prevAccessHash === hash) return clone(row);
    return null;
  }
  async findByRefreshHash(hash: string): Promise<Device | null> {
    for (const row of this.rows.values()) if (row.refreshHash === hash || row.prevRefreshHash === hash) return clone(row);
    return null;
  }
  async listActiveForOwner(ownerEmail: string): Promise<Device[]> {
    return [...this.rows.values()]
      .filter((d) => d.ownerEmail === ownerEmail && !d.revokedAt)
      .map(clone)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async update(id: string, patch: Partial<Device>): Promise<Device | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...clone(patch) };
    this.rows.set(id, next);
    return clone(next);
  }
  async rotate(id: string, expectedRefreshHash: string, patch: Partial<Device>): Promise<Device | null> {
    const row = this.rows.get(id);
    if (!row || row.revokedAt || row.refreshHash !== expectedRefreshHash) return null;
    return this.update(id, patch);
  }
  async revoke(id: string, reason: DeviceRevokeReason, revokedAt: string): Promise<Device | null> {
    const row = this.rows.get(id);
    if (!row || row.revokedAt) return null;
    return this.update(id, { revokedAt, revokedReason: reason });
  }
  async revokeAllForOwner(ownerEmail: string, reason: DeviceRevokeReason, revokedAt: string): Promise<Device[]> {
    return this.revokeAllForOwners({ email: ownerEmail.trim().toLowerCase() }, reason, revokedAt);
  }
  async revokeAllForOwners(match: DeviceOwnerMatch, reason: DeviceRevokeReason, revokedAt: string): Promise<Device[]> {
    const revoked: Device[] = [];
    for (const row of this.rows.values()) {
      if (row.revokedAt || !ownerMatchesDevice(row.ownerEmail, match)) continue;
      row.revokedAt = revokedAt;
      row.revokedReason = reason;
      revoked.push(clone(row));
    }
    return revoked;
  }
}

// ---------- Mongo ----------

/** expireAt is Mongo-only (the TTL index needs a BSON date), like mail and laptop approvals. */
export type DeviceCodeDoc = DeviceCode & { _id: string; expireAt?: Date };
export type DeviceDoc = Device & { _id: string };

/** How long Mongo keeps a code past its own expiry before the TTL index removes it (§1.4), so a
 * late poll still reads `expired_token` for a while rather than `invalid_grant`. */
const DEVICE_CODE_RETENTION_MS = 60 * 60_000;

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

function fromCodeDoc(doc: DeviceCodeDoc | null): DeviceCode | null {
  if (!doc) return null;
  const { _id, expireAt: _expireAt, ...rest } = doc;
  return rest as DeviceCode;
}

function fromDeviceDoc(doc: DeviceDoc | null): Device | null {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest as Device;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mongo form of ownerMatchesDevice: anchored and case-insensitive, like store/mongo.ts's
 * ownerEmailFilter for tokens. */
function ownerRegex(match: DeviceOwnerMatch): RegExp {
  return "email" in match
    ? new RegExp(`^\\s*${escapeRegex(match.email)}\\s*$`, "i")
    : new RegExp(`${escapeRegex(match.domain)}\\s*$`, "i");
}

/** `revokedAt: null` matches a missing field as well as an explicit null. The driver types an
 * optional string field's condition as string | undefined, hence the cast (store/mongo.ts's
 * notRevokedFilter does the same). */
const NOT_REVOKED = { revokedAt: null } as unknown as { revokedAt: string };

export class MongoDeviceCodes implements DeviceCodesCollection {
  private readonly col: MongoCollection<DeviceCodeDoc>;
  constructor(col: MongoCollection<DeviceCodeDoc>) {
    this.col = col;
  }
  async insert(code: DeviceCode): Promise<void> {
    const expireAt = new Date(Date.parse(code.expiresAt) + DEVICE_CODE_RETENTION_MS);
    try {
      await this.col.insertOne({ ...code, _id: code.id, expireAt });
    } catch (err) {
      if (isDuplicateKey(err)) throw new DuplicateDeviceCodeError("device code already exists");
      throw err;
    }
  }
  async findByDeviceCodeHash(hash: string): Promise<DeviceCode | null> {
    return fromCodeDoc(await this.col.findOne({ deviceCodeHash: hash }));
  }
  async findPendingByUserCode(userCode: string): Promise<DeviceCode | null> {
    return fromCodeDoc(await this.col.findOne({ userCode, status: "pending", expiresAt: { $gt: new Date().toISOString() } }));
  }
  async transition(id: string, from: readonly DeviceCodeStatus[], patch: Partial<DeviceCode>): Promise<DeviceCode | null> {
    return fromCodeDoc(
      await this.col.findOneAndUpdate({ _id: id, status: { $in: [...from] } }, { $set: patch }, { returnDocument: "after" }),
    );
  }
  async update(id: string, patch: Partial<DeviceCode>): Promise<DeviceCode | null> {
    return fromCodeDoc(await this.col.findOneAndUpdate({ _id: id }, { $set: patch }, { returnDocument: "after" }));
  }
}

export class MongoDevices implements DevicesCollection {
  private readonly col: MongoCollection<DeviceDoc>;
  constructor(col: MongoCollection<DeviceDoc>) {
    this.col = col;
  }
  async insert(device: Device): Promise<void> {
    await this.col.insertOne({ ...device, _id: device.id });
  }
  async findById(id: string): Promise<Device | null> {
    return fromDeviceDoc(await this.col.findOne({ _id: id }));
  }
  async findByAccessHash(hash: string): Promise<Device | null> {
    return fromDeviceDoc(await this.col.findOne({ $or: [{ accessHash: hash }, { prevAccessHash: hash }] }));
  }
  async findByRefreshHash(hash: string): Promise<Device | null> {
    return fromDeviceDoc(await this.col.findOne({ $or: [{ refreshHash: hash }, { prevRefreshHash: hash }] }));
  }
  async listActiveForOwner(ownerEmail: string): Promise<Device[]> {
    const rows = await this.col.find({ ownerEmail, ...NOT_REVOKED }).sort({ createdAt: -1 }).toArray();
    return rows.map((r) => fromDeviceDoc(r)!);
  }
  async update(id: string, patch: Partial<Device>): Promise<Device | null> {
    return fromDeviceDoc(await this.col.findOneAndUpdate({ _id: id }, { $set: patch }, { returnDocument: "after" }));
  }
  async rotate(id: string, expectedRefreshHash: string, patch: Partial<Device>): Promise<Device | null> {
    return fromDeviceDoc(
      await this.col.findOneAndUpdate(
        { _id: id, refreshHash: expectedRefreshHash, ...NOT_REVOKED },
        { $set: patch },
        { returnDocument: "after" },
      ),
    );
  }
  async revoke(id: string, reason: DeviceRevokeReason, revokedAt: string): Promise<Device | null> {
    return fromDeviceDoc(
      await this.col.findOneAndUpdate(
        { _id: id, ...NOT_REVOKED },
        { $set: { revokedAt, revokedReason: reason } },
        { returnDocument: "after" },
      ),
    );
  }
  async revokeAllForOwner(ownerEmail: string, reason: DeviceRevokeReason, revokedAt: string): Promise<Device[]> {
    return this.revokeAllForOwners({ email: ownerEmail.trim().toLowerCase() }, reason, revokedAt);
  }
  /** Collect, stamp, then read back by those ids at this call's stamp, like
   * MongoTokens.revokeAllForOwners: a device another caller revoked in between keeps its own stamp
   * and drops out of the result, so its lifecycle hook fires once. */
  async revokeAllForOwners(match: DeviceOwnerMatch, reason: DeviceRevokeReason, revokedAt: string): Promise<Device[]> {
    const found = await this.col.find({ ownerEmail: ownerRegex(match), ...NOT_REVOKED }, { projection: { _id: 1 } }).toArray();
    const ids = found.map((r) => r._id);
    if (ids.length === 0) return [];
    await this.col.updateMany({ _id: { $in: ids }, ...NOT_REVOKED }, { $set: { revokedAt, revokedReason: reason } });
    const rows = await this.col.find({ _id: { $in: ids }, revokedAt }).toArray();
    return rows.map((r) => fromDeviceDoc(r)!);
  }
}

/** Called from MongoStore.ensureIndexes (store/mongo.ts). Spec §1.4 lists these. */
export async function ensureDeviceIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection("deviceCodes").createIndex({ deviceCodeHash: 1 }, { unique: true }),
    db.collection("deviceCodes").createIndex({ userCode: 1 }, { unique: true }),
    db.collection("deviceCodes").createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("devices").createIndex({ accessHash: 1 }, { unique: true }),
    db.collection("devices").createIndex({ prevAccessHash: 1 }, { sparse: true }),
    db.collection("devices").createIndex({ refreshHash: 1 }, { unique: true, sparse: true }),
    db.collection("devices").createIndex({ prevRefreshHash: 1 }, { sparse: true }),
    db.collection("devices").createIndex({ ownerEmail: 1, revokedAt: 1, createdAt: -1 }),
  ]);
}
