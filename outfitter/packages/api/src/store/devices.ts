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
  /** The caller's IP as the link role saw it (first X-Forwarded-For hop on Cloud Run). */
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

export interface DeviceCodesCollection {
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
  /** Matches refreshHash or (within its grace) prevRefreshHash; the caller tells them apart. */
  findByRefreshHash(hash: string): Promise<Device | null>;
  /** Not revoked, newest first. */
  listActiveForOwner(ownerEmail: string): Promise<Device[]>;
  update(id: string, patch: Partial<Device>): Promise<Device | null>;
  /** Rotation: swaps the pair only if the device's refreshHash is still `expectedRefreshHash`
   * (atomic across instances). Null when another refresh won. */
  rotate(id: string, expectedRefreshHash: string, patch: Partial<Device>): Promise<Device | null>;
  /** Revokes every active device of `ownerEmail`; returns the ones it revoked. */
  revokeAllForOwner(ownerEmail: string, reason: DeviceRevokeReason, revokedAt: string): Promise<Device[]>;
}

const notImplemented = (what: string): never => {
  throw new Error(`${what}: not implemented yet (CA-1, docs/specs/central-auth.md)`);
};

// ---------- memory (dev/tests) ----------

export class MemoryDeviceCodes implements DeviceCodesCollection {
  async insert(_code: DeviceCode): Promise<void> {
    notImplemented("deviceCodes.insert");
  }
  async findByDeviceCodeHash(_hash: string): Promise<DeviceCode | null> {
    return notImplemented("deviceCodes.findByDeviceCodeHash");
  }
  async findPendingByUserCode(_userCode: string): Promise<DeviceCode | null> {
    return notImplemented("deviceCodes.findPendingByUserCode");
  }
  async transition(_id: string, _from: readonly DeviceCodeStatus[], _patch: Partial<DeviceCode>): Promise<DeviceCode | null> {
    return notImplemented("deviceCodes.transition");
  }
  async update(_id: string, _patch: Partial<DeviceCode>): Promise<DeviceCode | null> {
    return notImplemented("deviceCodes.update");
  }
}

export class MemoryDevices implements DevicesCollection {
  async insert(_device: Device): Promise<void> {
    notImplemented("devices.insert");
  }
  async findById(_id: string): Promise<Device | null> {
    return notImplemented("devices.findById");
  }
  /** Empty until CA-1 lands, so a stray `kda_` bearer is simply unknown. */
  async findByAccessHash(_hash: string): Promise<Device | null> {
    return null;
  }
  async findByRefreshHash(_hash: string): Promise<Device | null> {
    return null;
  }
  async listActiveForOwner(_ownerEmail: string): Promise<Device[]> {
    return [];
  }
  async update(_id: string, _patch: Partial<Device>): Promise<Device | null> {
    return notImplemented("devices.update");
  }
  async rotate(_id: string, _expectedRefreshHash: string, _patch: Partial<Device>): Promise<Device | null> {
    return notImplemented("devices.rotate");
  }
  async revokeAllForOwner(_ownerEmail: string, _reason: DeviceRevokeReason, _revokedAt: string): Promise<Device[]> {
    return [];
  }
}

// ---------- Mongo ----------

/** expireAt is Mongo-only (the TTL index needs a BSON date), like mail and laptop approvals. */
export type DeviceCodeDoc = DeviceCode & { _id: string; expireAt?: Date };
export type DeviceDoc = Device & { _id: string };

export class MongoDeviceCodes implements DeviceCodesCollection {
  private readonly col: MongoCollection<DeviceCodeDoc>;
  constructor(col: MongoCollection<DeviceCodeDoc>) {
    this.col = col;
  }
  async insert(_code: DeviceCode): Promise<void> {
    void this.col;
    notImplemented("deviceCodes.insert");
  }
  async findByDeviceCodeHash(_hash: string): Promise<DeviceCode | null> {
    return notImplemented("deviceCodes.findByDeviceCodeHash");
  }
  async findPendingByUserCode(_userCode: string): Promise<DeviceCode | null> {
    return notImplemented("deviceCodes.findPendingByUserCode");
  }
  async transition(_id: string, _from: readonly DeviceCodeStatus[], _patch: Partial<DeviceCode>): Promise<DeviceCode | null> {
    return notImplemented("deviceCodes.transition");
  }
  async update(_id: string, _patch: Partial<DeviceCode>): Promise<DeviceCode | null> {
    return notImplemented("deviceCodes.update");
  }
}

export class MongoDevices implements DevicesCollection {
  private readonly col: MongoCollection<DeviceDoc>;
  constructor(col: MongoCollection<DeviceDoc>) {
    this.col = col;
  }
  async insert(_device: Device): Promise<void> {
    void this.col;
    notImplemented("devices.insert");
  }
  async findById(_id: string): Promise<Device | null> {
    return notImplemented("devices.findById");
  }
  async findByAccessHash(_hash: string): Promise<Device | null> {
    return null;
  }
  async findByRefreshHash(_hash: string): Promise<Device | null> {
    return null;
  }
  async listActiveForOwner(_ownerEmail: string): Promise<Device[]> {
    return [];
  }
  async update(_id: string, _patch: Partial<Device>): Promise<Device | null> {
    return notImplemented("devices.update");
  }
  async rotate(_id: string, _expectedRefreshHash: string, _patch: Partial<Device>): Promise<Device | null> {
    return notImplemented("devices.rotate");
  }
  async revokeAllForOwner(_ownerEmail: string, _reason: DeviceRevokeReason, _revokedAt: string): Promise<Device[]> {
    return [];
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
