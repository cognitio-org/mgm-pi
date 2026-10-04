// Central sign-in, CA-1 (#390, docs/specs/central-auth.md §1): the device-code flow's logic, apart
// from HTTP. Owned by task A. routes/device.ts turns these results into answers; auth.ts uses the
// allow-list and the access-token check.
//
// The flow (RFC 8628's shape): Kernal asks for a code on the public link origin (startDeviceCode),
// a person approves it on the web role under IAP (decideDeviceCode), and Kernal's next poll trades
// the approved code for a device and its first tokens (exchangeDeviceCode). From then on Kernal
// rotates its refresh token (refreshDevice) and signs out with revokeByToken.
//
// Who may sign in is the login allow-list (isLoginAllowed), checked at approve, at the exchange and
// at every refresh, so removing someone from IAP_MEMBERS signs their Kernals out within the hour.

import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { isOperator } from "../auth.ts";
import { parseAllowlist } from "../previews.ts";
import type { Store } from "../store/types.ts";
import type { Device, DeviceCode, DeviceOwnerMatch, DeviceRevokeReason } from "../store/devices.ts";
import { DuplicateDeviceCodeError } from "../store/devices.ts";
import type { DeviceDelivery, DeviceLifecycle, LifecycleDevice } from "./device-lifecycle.ts";
import { normalizeEmail, userIdFor } from "./user-id.ts";
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_TTL_MS,
  DEVICE_CODE_PREFIX,
  DEVICE_CODE_TTL_MS,
  DEVICE_POLL_INTERVAL_S,
  MACHINE_TOKEN_TTL_MS,
  REFRESH_ROTATION_GRACE_MS,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_MS,
  formatUserCode,
  hashToken,
  newAccessToken,
  newDeviceCode,
  newDeviceId,
  newRefreshToken,
  newUserCode,
} from "./device-tokens.ts";

// ---------- allow-list (§1.6) ----------

/** Whether a device login can happen at all: outside dev mode an empty OUTFITTER_LOGIN_ALLOW
 * refuses every login (`login_unavailable`), so a deploy without it changes nothing. */
export function loginAvailable(config: Pick<Config, "devMode" | "loginAllow">): boolean {
  return config.devMode || config.loginAllow.length > 0;
}

/** Whether `email` may sign a Kernal in and keep using a token: on OUTFITTER_LOGIN_ALLOW (PREVIEW_ALLOW's
 * format, previews.ts parseAllowlist: emails exact, `domain:` by `@domain` suffix, `group:` ignored)
 * or an operator. Dev mode with an empty list allows everyone. Case-insensitive. */
export function isLoginAllowed(email: string, config: Pick<Config, "devMode" | "loginAllow" | "operators">): boolean {
  if (config.devMode && config.loginAllow.length === 0) return true;
  if (isOperator(email, config.operators)) return true;
  const needle = normalizeEmail(email);
  const allow = parseAllowlist(config.loginAllow);
  return allow.emails.includes(needle) || allow.domains.some((d) => needle.endsWith(`@${d}`));
}

/** The Dongle fix of §1.6: a Dongle whose owner is no longer allowed stops working, but only once a
 * list is configured, so Dongles keep today's behaviour until it is. */
export function dongleOwnerAllowed(email: string, config: Pick<Config, "devMode" | "loginAllow" | "operators">): boolean {
  return config.loginAllow.length === 0 || isLoginAllowed(email, config);
}

// ---------- rate limits (§1.9) ----------

/** A sliding-window count per key, per instance and in memory (like voice.ts's per-minute mint
 * limit). Cloud Run may run a few instances; that only loosens it. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Counts one hit for `key`. Undefined when allowed, else the seconds until the next one is. */
  take(key: string): number | undefined {
    const now = this.now();
    const times = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (times.length >= this.limit) {
      this.hits.set(key, times);
      return Math.max(1, Math.ceil((times[0] + this.windowMs - now) / 1000));
    }
    times.push(now);
    this.hits.set(key, times);
    // Keeps the map from growing without bound on a busy public endpoint.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    return undefined;
  }
}

export interface DeviceRateLimits {
  /** POST /api/device/code: 10 per IP per 10 minutes. */
  code: RateLimiter;
  /** POST /api/device/token: 120 per IP per minute (plus slow_down). */
  token: RateLimiter;
  /** GET /api/device/pending and POST /api/device/approve together: 20 per person per 10 minutes. */
  approve: RateLimiter;
}

export function deviceRateLimits(now?: () => number): DeviceRateLimits {
  return {
    code: new RateLimiter(10, 10 * 60_000, now),
    token: new RateLimiter(120, 60_000, now),
    approve: new RateLimiter(20, 10 * 60_000, now),
  };
}

// ---------- shapes ----------

/** The caller's IP: the last X-Forwarded-For hop, else the socket. Cloud Run's front end keeps any
 * X-Forwarded-For the caller sent and appends the address it saw, so only the last hop is not the
 * caller's to choose. The first is, and trusting it would let a caller dodge the per-IP rate limits
 * or pick the requestIp the approve page compares against. Both roles are served by Cloud Run
 * directly, with no load balancer adding a hop after it (deploy/access.sh). */
export function clientIp(req: { headers: Record<string, string | string[] | undefined>; ip?: string }): string | undefined {
  const raw = req.headers["x-forwarded-for"];
  const joined = Array.isArray(raw) ? raw.join(",") : raw;
  const last = joined?.split(",").map((hop) => hop.trim()).filter(Boolean).at(-1);
  return last || req.ip || undefined;
}

export function lifecycleDevice(d: Device): LifecycleDevice {
  return {
    id: d.id,
    userId: d.userId,
    ownerEmail: d.ownerEmail,
    name: d.name,
    ...(d.platform ? { platform: d.platform } : {}),
    ...(d.kernalVersion ? { kernalVersion: d.kernalVersion } : {}),
  };
}

/** GET /api/me/devices's row (§1.5). Never a hash. */
export interface DeviceRow {
  id: string;
  name: string;
  kind: Device["kind"];
  platform?: string;
  kernalVersion?: string;
  createdAt: string;
  lastSeenAt?: string;
  lastSeenIp?: string;
  loginIp?: string;
  routerKey: { alias: string; createdAt: string } | null;
}

export async function deviceRow(store: Pick<Store, "routerKeys">, d: Device): Promise<DeviceRow> {
  // CA-5's collection, read-only here. A failed lookup shows "no key" rather than failing the list.
  const key = await store.routerKeys.findActiveForDevice(d.id).catch(() => null);
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    ...(d.platform ? { platform: d.platform } : {}),
    ...(d.kernalVersion ? { kernalVersion: d.kernalVersion } : {}),
    createdAt: d.createdAt,
    ...(d.lastSeenAt ? { lastSeenAt: d.lastSeenAt } : {}),
    ...(d.lastSeenIp ? { lastSeenIp: d.lastSeenIp } : {}),
    ...(d.loginIp ? { loginIp: d.loginIp } : {}),
    routerKey: key ? { alias: key.alias, createdAt: key.createdAt } : null,
  };
}

/** The token answer of §1.3, without `delivery`/`problems` (the exchange adds those). */
export interface TokenAnswer {
  token_type: "Bearer";
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  device: { id: string; name: string };
  account: { email: string; userId: string };
}

function tokenAnswer(d: Device, access: string, refresh: string): TokenAnswer {
  return {
    token_type: "Bearer",
    access_token: access,
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: refresh,
    refresh_expires_in: REFRESH_TOKEN_TTL_MS / 1000,
    device: { id: d.id, name: d.name },
    account: { email: d.ownerEmail, userId: d.userId },
  };
}

/** The OAuth error answers (400 unless noted). */
export type FlowError = { error: string; interval?: number };

interface FlowDeps {
  store: Store;
  config: Config;
  deviceLifecycle: DeviceLifecycle;
  now?: () => number;
}

const iso = (ms: number) => new Date(ms).toISOString();

// ---------- revoke ----------

/** Revokes one device and fires DeviceLifecycle.revoked. Null when it was already revoked. */
export async function revokeDevice(deps: FlowDeps, d: Device, reason: DeviceRevokeReason): Promise<Device | null> {
  const revoked = await deps.store.devices.revoke(d.id, reason, iso((deps.now ?? Date.now)()));
  if (!revoked) return null;
  await deps.deviceLifecycle.revoked({ device: lifecycleDevice(revoked), reason });
  return revoked;
}

/** Every active device of the matching owners, each announced. */
export async function revokeDevicesMatching(deps: FlowDeps, match: DeviceOwnerMatch, reason: DeviceRevokeReason): Promise<Device[]> {
  const revoked = await deps.store.devices.revokeAllForOwners(match, reason, iso((deps.now ?? Date.now)()));
  for (const d of revoked) await deps.deviceLifecycle.revoked({ device: lifecycleDevice(d), reason });
  return revoked;
}

// ---------- POST /api/device/code ----------

export interface DeviceCodeRequest {
  deviceName: string;
  platform?: string;
  kernalVersion?: string;
}

/** Printable: no control or format characters (so a name can't hide text on the approve page). */
const PRINTABLE = /^[^\p{C}]+$/u;

function optionalField(v: unknown): string | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return undefined;
  return t.length <= 64 && PRINTABLE.test(t) ? t : null;
}

/** The body of POST /api/device/code, or undefined when it's malformed (`invalid_request`). */
export function parseDeviceCodeRequest(body: unknown): DeviceCodeRequest | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const name = typeof b.deviceName === "string" ? b.deviceName.trim() : "";
  if (!name || name.length > 64 || !PRINTABLE.test(name)) return undefined;
  const platform = optionalField(b.platform);
  const kernalVersion = optionalField(b.kernalVersion);
  if (platform === null || kernalVersion === null) return undefined;
  return { deviceName: name, ...(platform ? { platform } : {}), ...(kernalVersion ? { kernalVersion } : {}) };
}

export interface DeviceCodeAnswer {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function startDeviceCode(deps: FlowDeps, req: DeviceCodeRequest, requestIp: string | undefined): Promise<DeviceCodeAnswer> {
  const nowMs = (deps.now ?? Date.now)();
  const deviceCode = newDeviceCode();
  // A user-code collision (20^8 codes, a handful live at once) retries with a new one.
  for (let attempt = 0; ; attempt++) {
    const record: DeviceCode = {
      id: randomUUID(),
      deviceCodeHash: hashToken(deviceCode),
      userCode: newUserCode(),
      status: "pending",
      deviceName: req.deviceName,
      ...(req.platform ? { platform: req.platform } : {}),
      ...(req.kernalVersion ? { kernalVersion: req.kernalVersion } : {}),
      ...(requestIp ? { requestIp } : {}),
      createdAt: iso(nowMs),
      expiresAt: iso(nowMs + DEVICE_CODE_TTL_MS),
      interval: DEVICE_POLL_INTERVAL_S,
    };
    try {
      await deps.store.deviceCodes.insert(record);
    } catch (err) {
      if (err instanceof DuplicateDeviceCodeError && attempt < 5) continue;
      throw err;
    }
    const base = `${deps.config.webOrigin || deps.config.origin.replace(/\/+$/, "")}/device`;
    const shown = formatUserCode(record.userCode);
    return {
      device_code: deviceCode,
      user_code: shown,
      verification_uri: base,
      verification_uri_complete: `${base}?code=${shown}`,
      expires_in: DEVICE_CODE_TTL_MS / 1000,
      interval: DEVICE_POLL_INTERVAL_S,
    };
  }
}

// ---------- POST /api/device/approve ----------

export type DecideResult = { status: "approved" | "denied"; deviceId?: string } | { error: "not_pending" };

/** Records a person's decision on a pending code. The caller has checked the person (never a token)
 * and, for an approval, the allow-list. The approver becomes the device's owner. */
export async function decideDeviceCode(
  deps: FlowDeps,
  code: DeviceCode,
  approve: boolean,
  approver: { email: string; ip?: string },
): Promise<DecideResult> {
  const deviceId = approve ? newDeviceId() : undefined;
  const decided = await deps.store.deviceCodes.transition(code.id, ["pending"], {
    status: approve ? "approved" : "denied",
    decidedBy: normalizeEmail(approver.email),
    decidedAt: iso((deps.now ?? Date.now)()),
    ...(approver.ip ? { decidedIp: approver.ip } : {}),
    ...(deviceId ? { deviceId } : {}),
  });
  if (!decided) return { error: "not_pending" };
  return approve ? { status: "approved", deviceId } : { status: "denied" };
}

// ---------- POST /api/device/token ----------

export type ExchangeResult =
  | { ok: true; answer: TokenAnswer & { delivery: DeviceDelivery; problems: string[] } }
  | { ok: false; error: FlowError };

export async function exchangeDeviceCode(deps: FlowDeps, deviceCode: string): Promise<ExchangeResult> {
  const fail = (error: string, interval?: number): ExchangeResult => ({ ok: false, error: { error, ...(interval ? { interval } : {}) } });
  if (!deviceCode.startsWith(DEVICE_CODE_PREFIX)) return fail("invalid_grant");
  const nowMs = (deps.now ?? Date.now)();
  const code = await deps.store.deviceCodes.findByDeviceCodeHash(hashToken(deviceCode));
  if (!code || code.status === "consumed") return fail("invalid_grant");
  if (!(nowMs < Date.parse(code.expiresAt))) return fail("expired_token");
  if (code.status === "denied") return fail("access_denied");

  if (code.status === "pending") {
    const last = code.lastPolledAt ? Date.parse(code.lastPolledAt) : Number.NaN;
    if (Number.isFinite(last) && nowMs - last < code.interval * 1000) {
      const interval = code.interval + 5;
      await deps.store.deviceCodes.update(code.id, { interval, lastPolledAt: iso(nowMs) });
      return fail("slow_down", interval);
    }
    await deps.store.deviceCodes.update(code.id, { lastPolledAt: iso(nowMs) });
    return fail("authorization_pending");
  }

  // Approved: exactly one poll wins the code.
  const consumed = await deps.store.deviceCodes.transition(code.id, ["approved"], { status: "consumed", lastPolledAt: iso(nowMs) });
  if (!consumed || !consumed.decidedBy || !consumed.deviceId) return fail("invalid_grant");
  if (!isLoginAllowed(consumed.decidedBy, deps.config)) return fail("access_denied");

  const access = newAccessToken();
  const refresh = newRefreshToken();
  const owner = normalizeEmail(consumed.decidedBy);
  const device: Device = {
    id: consumed.deviceId,
    userId: userIdFor(owner),
    ownerEmail: owner,
    name: consumed.deviceName,
    ...(consumed.platform ? { platform: consumed.platform } : {}),
    ...(consumed.kernalVersion ? { kernalVersion: consumed.kernalVersion } : {}),
    kind: "laptop",
    createdAt: iso(nowMs),
    approvedBy: owner,
    ...(consumed.decidedIp ? { approvedIp: consumed.decidedIp } : {}),
    ...(consumed.requestIp ? { loginIp: consumed.requestIp } : {}),
    accessHash: hashToken(access),
    accessExpiresAt: iso(nowMs + ACCESS_TOKEN_TTL_MS),
    refreshHash: hashToken(refresh),
    refreshExpiresAt: iso(nowMs + REFRESH_TOKEN_TTL_MS),
  };
  await deps.store.devices.insert(device);
  const { delivery, problems } = await deps.deviceLifecycle.login({ device: lifecycleDevice(device) });
  return { ok: true, answer: { ...tokenAnswer(device, access, refresh), delivery, problems } };
}

// ---------- POST /api/device/refresh ----------

export type RefreshResult = { ok: true; answer: TokenAnswer } | { ok: false; error: FlowError };

/** Rotation with the grace and reuse rules of §1.3, and the allow-list re-check. A few attempts,
 * since a concurrent refresh of the same device can win the atomic swap in between. */
export async function refreshDevice(deps: FlowDeps, refreshToken: string): Promise<RefreshResult> {
  const fail = (error: string): RefreshResult => ({ ok: false, error: { error } });
  if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return fail("invalid_grant");
  const hash = hashToken(refreshToken);

  for (let attempt = 0; attempt < 3; attempt++) {
    const nowMs = (deps.now ?? Date.now)();
    const d = await deps.store.devices.findByRefreshHash(hash);
    if (!d || d.revokedAt || !d.refreshHash) return fail("invalid_grant");
    if (d.refreshHash === hash) {
      if (!(nowMs < Date.parse(d.refreshExpiresAt ?? ""))) return fail("invalid_grant");
    } else if (!(nowMs < Date.parse(d.prevRefreshValidUntil ?? ""))) {
      // A replaced refresh token after its grace: someone else holds a copy (theft signal).
      await revokeDevice(deps, d, "refresh-reuse");
      return fail("invalid_grant");
    }

    if (!isLoginAllowed(d.ownerEmail, deps.config)) {
      await revokeDevicesMatching(deps, { email: d.ownerEmail }, "access-removed");
      return fail("access_denied");
    }

    // Rotate from the current pair, whichever of the two the caller presented.
    const access = newAccessToken();
    const refresh = newRefreshToken();
    const rotated = await deps.store.devices.rotate(d.id, d.refreshHash, {
      accessHash: hashToken(access),
      accessExpiresAt: iso(nowMs + ACCESS_TOKEN_TTL_MS),
      prevAccessHash: d.accessHash,
      prevAccessExpiresAt: d.accessExpiresAt,
      refreshHash: hashToken(refresh),
      refreshExpiresAt: iso(nowMs + REFRESH_TOKEN_TTL_MS),
      prevRefreshHash: d.refreshHash,
      prevRefreshValidUntil: iso(nowMs + REFRESH_ROTATION_GRACE_MS),
    });
    if (rotated) return { ok: true, answer: tokenAnswer(rotated, access, refresh) };
    // Another refresh won: re-read; the token may now be a grace token.
  }
  return fail("invalid_grant");
}

// ---------- POST /api/device/revoke ----------

/** `kernal logout`: revokes the device a refresh or access token belongs to. Unknown tokens are
 * ignored (RFC 7009 answers 200 regardless). */
export async function revokeByToken(deps: FlowDeps, token: string): Promise<void> {
  const hash = hashToken(token);
  const d = token.startsWith(REFRESH_TOKEN_PREFIX)
    ? await deps.store.devices.findByRefreshHash(hash)
    : token.startsWith(ACCESS_TOKEN_PREFIX)
      ? await deps.store.devices.findByAccessHash(hash)
      : null;
  if (d && !d.revokedAt) await revokeDevice(deps, d, "logout");
}

// ---------- access tokens (auth.ts) ----------

/** The device an access token belongs to, when it is still valid: not revoked, and the hash is the
 * current one before accessExpiresAt or the previous one before prevAccessExpiresAt. */
export async function deviceForAccessToken(store: Pick<Store, "devices">, bearer: string, nowMs = Date.now()): Promise<Device | null> {
  if (!bearer.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  const hash = hashToken(bearer);
  const d = await store.devices.findByAccessHash(hash);
  if (!d || d.revokedAt) return null;
  if (d.accessHash === hash && nowMs < Date.parse(d.accessExpiresAt)) return d;
  if (d.prevAccessHash === hash && nowMs < Date.parse(d.prevAccessExpiresAt ?? "")) return d;
  return null;
}

// ---------- machine tokens (§1.7) ----------

export async function createMachineToken(
  deps: FlowDeps,
  operator: { email: string; ip?: string },
  name: string,
): Promise<{ token: string; device: Device }> {
  const nowMs = (deps.now ?? Date.now)();
  const token = newAccessToken();
  const owner = normalizeEmail(operator.email);
  const device: Device = {
    id: newDeviceId(),
    userId: userIdFor(owner),
    ownerEmail: owner,
    name,
    kind: "machine",
    createdAt: iso(nowMs),
    approvedBy: owner,
    ...(operator.ip ? { approvedIp: operator.ip } : {}),
    accessHash: hashToken(token),
    accessExpiresAt: iso(nowMs + MACHINE_TOKEN_TTL_MS),
  };
  await deps.store.devices.insert(device);
  return { token, device };
}
