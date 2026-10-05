// Local Host (epic #378, docs/specs/local-host.md §1): the host registry (#382). Owned by task A.
//
// A signed-in Kernal's background service heartbeats here with its discovery snapshot and tunnel
// state; the api keeps one `localHosts` record per person per machine, works out its status, says
// what to do about tunnel credentials, and announces anything the router's entries depend on to
// LocalHostEvents (task B listens). Server URLs in a heartbeat are stored as text and never fetched.

import { userIdFor } from "../central/user-id.ts";
import type { DeviceLifecycleHook } from "../central/device-lifecycle.ts";
import {
  DEFAULT_ACCESS_GROUP,
  HEARTBEAT_INTERVAL_SECONDS,
  MAX_MODELS,
  MAX_SERVERS,
  OTHERS_STALE_LISTED_SECONDS,
  type CredentialsHint,
  type HeartbeatModel,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type HeartbeatServer,
  type HeartbeatTunnel,
  type LocalHostListResponse,
  type LocalHostView,
  type ServerKind,
} from "./contract.ts";
import { HOST_ID_RE, localHostId, routableModelId, routerModelName, routerPrefixCandidates } from "./naming.ts";
import {
  LocalHostPrefixTakenError,
  hostStatus,
  routerFingerprint,
  sharedModels,
  type LocalHost,
} from "../store/local-hosts.ts";
import { deleteHostNgrok, dropCloudEndpoint, provisioningOn, retireBearer, type LocalHostTunnelDeps } from "./tunnel-credentials.ts";

export type LocalHostDeps = LocalHostTunnelDeps & { events: NonNullable<LocalHostTunnelDeps["events"]> };

// ---------- validation (§1.2) ----------

const SERVER_KINDS: readonly ServerKind[] = ["lmstudio", "ollama", "llamacpp", "mlx-lm", "vllm", "openai"];
const TUNNEL_STATES = ["up", "down", "stopped", "off"] as const;
const PROVIDERS = ["ngrok", "cloudflare"] as const;
const REASONS = ["start", "change", "interval", "stop"] as const;
const MAX_STRING = 512;
/** Endpoint paths one server reports (discovery probes a handful). */
const MAX_ENDPOINTS = 32;
/** Lines of "model id not routable" in one answer; the rest are counted. */
const MAX_ROUTABLE_PROBLEMS = 10;
// C0 and C1 control characters and bidi overrides/isolates: never in text people read (every string
// of a heartbeat can reach someone's listing).
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export class HeartbeatInvalid extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`invalid heartbeat: ${field}`);
    this.field = field;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(o: Obj, key: string, path: string, opts: { optional?: boolean; max?: number; min?: number } = {}): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (opts.optional) return undefined;
    throw new HeartbeatInvalid(path + key);
  }
  if (typeof v !== "string" || v.length > (opts.max ?? MAX_STRING) || v.length < (opts.min ?? 0) || CONTROL.test(v)) throw new HeartbeatInvalid(path + key);
  return v;
}

function num(o: Obj, key: string, path: string, optional = true): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new HeartbeatInvalid(path + key);
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new HeartbeatInvalid(path + key);
  return v;
}

function bool(o: Obj, key: string, path: string, optional = true): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new HeartbeatInvalid(path + key);
  }
  if (typeof v !== "boolean") throw new HeartbeatInvalid(path + key);
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, path: string, values: readonly T[]): T {
  const v = o[key];
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw new HeartbeatInvalid(path + key);
  return v as T;
}

/** A short label people read: trimmed, no control characters. */
function label(o: Obj, key: string, max: number, min: number): string {
  const raw = o[key];
  if (typeof raw !== "string" || CONTROL.test(raw)) throw new HeartbeatInvalid(key);
  const v = raw.trim();
  if (v.length < min || v.length > max) throw new HeartbeatInvalid(key);
  return v;
}

/** Drops undefined fields, so a record holds only what was reported. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function parseServer(raw: unknown, i: number): HeartbeatServer {
  const p = `servers[${i}].`;
  if (!isObj(raw)) throw new HeartbeatInvalid(`servers[${i}]`);
  const endpoints = raw.endpoints ?? [];
  if (!Array.isArray(endpoints) || endpoints.length > MAX_ENDPOINTS) throw new HeartbeatInvalid(p + "endpoints");
  endpoints.forEach((e, j) => {
    if (typeof e !== "string" || e.length > MAX_STRING || CONTROL.test(e)) throw new HeartbeatInvalid(`${p}endpoints[${j}]`);
  });
  return compact({
    id: str(raw, "id", p, { min: 1 })!,
    kind: oneOf(raw, "kind", p, SERVER_KINDS),
    baseUrl: str(raw, "baseUrl", p)!,
    ok: bool(raw, "ok", p, false)!,
    error: str(raw, "error", p, { optional: true }),
    endpoints: endpoints as string[],
    models: num(raw, "models", p) ?? 0,
  });
}

function parseModel(raw: unknown, i: number): HeartbeatModel {
  const p = `models[${i}].`;
  if (!isObj(raw)) throw new HeartbeatInvalid(`models[${i}]`);
  return compact({
    id: str(raw, "id", p, { min: 1 })!,
    server: str(raw, "server", p)!,
    kind: oneOf(raw, "kind", p, SERVER_KINDS),
    loaded: bool(raw, "loaded", p),
    listed: bool(raw, "listed", p),
    contextLength: num(raw, "contextLength", p),
    maxContextLength: num(raw, "maxContextLength", p),
    loadedContextLength: num(raw, "loadedContextLength", p),
    type: str(raw, "type", p, { optional: true }),
    vision: bool(raw, "vision", p),
    toolUse: bool(raw, "toolUse", p),
    quantization: str(raw, "quantization", p, { optional: true }),
    sizeBytes: num(raw, "sizeBytes", p),
    digest: str(raw, "digest", p, { optional: true }),
  });
}

function parseTunnel(raw: unknown): HeartbeatTunnel {
  const p = "tunnel.";
  if (!isObj(raw)) throw new HeartbeatInvalid("tunnel");
  return compact({
    provider: oneOf(raw, "provider", p, PROVIDERS),
    managed: bool(raw, "managed", p, false)!,
    state: oneOf(raw, "state", p, TUNNEL_STATES),
    url: str(raw, "url", p, { optional: true }),
    server: str(raw, "server", p, { optional: true }),
    credentialId: str(raw, "credentialId", p, { optional: true }),
    reason: str(raw, "reason", p, { optional: true }),
  });
}

/** The heartbeat body as the api keeps it: the fields of HeartbeatRequest, nothing else. Throws
 * HeartbeatInvalid with the first failing field's path. */
export function parseHeartbeat(body: unknown): HeartbeatRequest {
  if (!isObj(body)) throw new HeartbeatInvalid("body");
  const hostId = body.hostId;
  if (typeof hostId !== "string" || !HOST_ID_RE.test(hostId)) throw new HeartbeatInvalid("hostId");
  const hostName = label(body, "hostName", 64, 1);
  const kernalVersion = label(body, "kernalVersion", 32, 0);
  const platform = label(body, "platform", 32, 0);
  const shareModels = bool(body, "shareModels", "", false)!;
  const discoveryKey = str(body, "discoveryKey", "")!;
  if (!Array.isArray(body.servers) || body.servers.length > MAX_SERVERS) throw new HeartbeatInvalid("servers");
  if (!Array.isArray(body.models) || body.models.length > MAX_MODELS) throw new HeartbeatInvalid("models");
  const servers = body.servers.map(parseServer);
  const models = body.models.map(parseModel);
  const tunnel = parseTunnel(body.tunnel);
  const reason = oneOf(body, "reason", "", REASONS);
  return { hostId, hostName, kernalVersion, platform, shareModels, discoveryKey, servers, models, tunnel, reason };
}

// ---------- the answer's pieces (§1.3) ----------

/** What the service should do about tunnel credentials; first match wins. Only sharing decides
 * `none`: the heartbeat clears revokedAt before it answers (an accepted token is a newer login),
 * so a revoked record never reaches this. */
export function credentialsHint(host: LocalHost, provisioning: boolean): CredentialsHint {
  if (!host.shareModels) return "none";
  if (!provisioning) return "unavailable";
  if (!host.managed?.endpointId) return "fetch";
  if (host.tunnel.managed && host.tunnel.credentialId !== host.managed.credentialId) return "fetch";
  return "current";
}

/** The router names task B registers for this host right now (§1.3): [] unless online and managed. */
export function routerModelsFor(host: LocalHost, now: Date): string[] {
  if (hostStatus(host, now) !== "online" || !host.tunnel.managed) return [];
  const names: string[] = [];
  for (const m of sharedModels(host)) {
    const name = routerModelName(host.routerPrefix, m.id);
    if (name) names.push(name);
  }
  return names;
}

function routableProblems(models: HeartbeatModel[]): string[] {
  const bad = models.filter((m) => !routableModelId(m.id));
  const lines = bad.slice(0, MAX_ROUTABLE_PROBLEMS).map((m) => `model id not routable: ${m.id.slice(0, 60)}`);
  if (bad.length > MAX_ROUTABLE_PROBLEMS) lines.push(`model id not routable: ${bad.length - MAX_ROUTABLE_PROBLEMS} more`);
  return lines;
}

// ---------- POST /api/local-hosts/heartbeat ----------

export class RouterPrefixUnavailable extends Error {}

/**
 * One heartbeat (§1.3), from the device `deviceId` of `email`. Creates or takes over the record,
 * stores the report, drops the cloud endpoint when sharing went off, and announces a change of
 * routerFingerprint to the listeners.
 */
export async function recordHeartbeat(
  deps: LocalHostDeps,
  caller: { email: string; deviceId: string },
  hb: HeartbeatRequest,
): Promise<HeartbeatResponse> {
  const now = (deps.now ?? (() => new Date()))();
  const iso = now.toISOString();
  const userId = userIdFor(caller.email);
  const id = localHostId(userId, hb.hostId);
  const hosts = deps.store.localHosts;
  const previous = await hosts.findById(id);
  const reported = {
    deviceId: caller.deviceId,
    hostName: hb.hostName,
    kernalVersion: hb.kernalVersion || undefined,
    platform: hb.platform || undefined,
    shareModels: hb.shareModels,
    discoveryKey: hb.discoveryKey,
    servers: hb.servers,
    models: hb.models,
    tunnel: hb.tunnel,
    updatedAt: iso,
    lastSeenAt: iso,
  };

  let next: LocalHost | null;
  if (previous) {
    // Only the reported fields: routerPrefix, accessGroup, managed, lastBearerVersion and createdAt
    // stay as they are (and a credentials call writing `managed` at the same moment isn't
    // overwritten). A newer login on the same machine takes the record over and clears a
    // revocation; a heartbeat revives a tombstone (§1.8). Cleared fields are unset, never null.
    next = await hosts.update(id, { ...reported, ownerEmail: caller.email, revokedAt: undefined, deletedAt: undefined });
    if (!next) throw new Error("the host record vanished during the heartbeat");
  } else {
    next = await createRecord(deps, { id, userId, email: caller.email, hostId: hb.hostId, createdAt: iso, reported });
  }

  // §1.3 step 5: sharing off drops the public endpoint (the credential stays, harmless).
  if (!next.shareModels && next.managed?.endpointId) {
    next = (await dropCloudEndpoint(deps, next)) ?? (await hosts.findById(id)) ?? next;
  }

  const problems = routableProblems(next.models);
  if (!previous || routerFingerprint(previous, now) !== routerFingerprint(next, now)) {
    const result = await deps.events.changed({ reason: "heartbeat", host: next, ...(previous ? { previous } : {}) });
    problems.push(...result.problems);
  }

  return {
    accepted: true,
    id,
    status: hostStatus(next, now),
    nextHeartbeatSeconds: HEARTBEAT_INTERVAL_SECONDS,
    credentials: credentialsHint(next, provisioningOn(deps)),
    routerPrefix: next.routerPrefix,
    routerModels: routerModelsFor(next, now),
    problems,
  };
}

async function createRecord(
  deps: LocalHostDeps,
  a: { id: string; userId: string; email: string; hostId: string; createdAt: string; reported: Omit<LocalHost, "id" | "userId" | "ownerEmail" | "hostId" | "accessGroup" | "routerPrefix" | "createdAt"> },
): Promise<LocalHost> {
  const hosts = deps.store.localHosts;
  for (const routerPrefix of routerPrefixCandidates(a.email, a.reported.hostName, a.id)) {
    // §3.1: free when nobody holds it, or only a tombstone of the same person (removed first, so
    // the prefix moves to this record). Another person's record, live or tombstone, never yields.
    const holder = await hosts.findByRouterPrefix(routerPrefix);
    if (holder && holder.id !== a.id) {
      if (holder.userId !== a.userId || !holder.deletedAt) continue;
      await hosts.delete(holder.id);
    }
    const record: LocalHost = compact({
      id: a.id,
      userId: a.userId,
      ownerEmail: a.email,
      hostId: a.hostId,
      accessGroup: DEFAULT_ACCESS_GROUP,
      routerPrefix,
      createdAt: a.createdAt,
      ...a.reported,
    });
    try {
      await hosts.upsert(record);
      return record;
    } catch (err) {
      if (err instanceof LocalHostPrefixTakenError) continue; // a race: try the next candidate
      throw err;
    }
  }
  throw new RouterPrefixUnavailable(`no router prefix free for ${a.id}`);
}

// ---------- GET /api/local-hosts (§1.7) ----------

/** The listing's shape of one host: never the credential, endpoint, bearer, internal URL, device,
 * user id or discovery key. */
export function hostView(host: LocalHost, mine: boolean, now: Date): LocalHostView {
  return compact({
    id: host.id,
    hostName: host.hostName,
    owner: { email: host.ownerEmail, mine },
    status: hostStatus(host, now),
    shareModels: host.shareModels,
    accessGroup: host.accessGroup,
    routerPrefix: host.routerPrefix,
    kernalVersion: host.kernalVersion,
    platform: host.platform,
    lastSeenAt: host.lastSeenAt,
    tunnel: { provider: host.tunnel.provider, managed: host.tunnel.managed, state: host.tunnel.state },
    servers: host.servers.map((s) => ({ id: s.id, kind: s.kind, ok: s.ok })),
    models: host.models.map((m) => compact({
      id: m.id,
      routerModel: routerModelName(host.routerPrefix, m.id),
      kind: m.kind,
      loaded: m.loaded,
      contextLength: m.contextLength,
      vision: m.vision,
      toolUse: m.toolUse,
      type: m.type,
      shared: Boolean(host.tunnel.server) && m.server === host.tunnel.server,
    })),
  });
}

/** The caller's own hosts (any status, no tombstones), then everyone else's that share, aren't
 * revoked, and are online, offline, or stale for under OTHERS_STALE_LISTED_SECONDS; each part
 * newest first. */
export async function listLocalHosts(deps: Pick<LocalHostDeps, "store" | "now">, email: string): Promise<LocalHostListResponse> {
  const now = (deps.now ?? (() => new Date()))();
  const userId = userIdFor(email);
  const own = (await deps.store.localHosts.listForUser(userId)).filter((h) => !h.deletedAt);
  const others = (await deps.store.localHosts.listSharing()).filter((h) => {
    if (h.userId === userId || h.deletedAt) return false;
    const status = hostStatus(h, now);
    if (status === "stale") return now.getTime() - Date.parse(h.lastSeenAt) < OTHERS_STALE_LISTED_SECONDS * 1000;
    return status === "online" || status === "offline";
  });
  return { hosts: [...own.map((h) => hostView(h, true, now)), ...others.map((h) => hostView(h, false, now))] };
}

// ---------- DELETE /api/local-hosts/:id (§1.8) ----------

/** Removes the host's ngrok resources and bearer, turns the record into a tombstone (§1.8: it keeps
 * routerPrefix, userId and lastBearerVersion, so the prefix never passes to another person), then
 * tells the listeners. */
export async function deleteLocalHost(deps: LocalHostDeps, host: LocalHost): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  await deleteHostNgrok(deps, host);
  await retireBearer(deps, host);
  await deps.store.localHosts.update(host.id, {
    deletedAt: now.toISOString(),
    shareModels: false,
    servers: [],
    models: [],
    tunnel: { provider: host.tunnel.provider, managed: host.tunnel.managed, state: "off" },
    managed: undefined,
    issuingUntil: undefined,
  });
  const { problems } = await deps.events.changed({ reason: "deleted", host });
  if (problems.length) deps.log?.("local hosts: listeners reported problems on delete", { id: host.id, problems });
}

// ---------- device revoked (§2.5) ----------

/** The device lifecycle hook: a revoked device's hosts lose their ngrok resources and bearer, are
 * marked revoked, and the listeners hear of it. Registered in server.ts. */
export function localHostDeviceHook(deps: LocalHostDeps): DeviceLifecycleHook {
  return {
    name: "local hosts",
    async onRevoked({ device }) {
      for (const host of await deps.store.localHosts.listForDevice(device.id)) {
        if (host.revokedAt || host.deletedAt) continue;
        // One host failing must not leave the others' credentials alive.
        try {
          await revokeLocalHost(deps, host);
        } catch (err) {
          deps.log?.("local hosts: revoking a host failed", { id: host.id, err: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        }
      }
    },
  };
}

/** One host of a revoked device (§2.5): ngrok resources and bearer go, `revokedAt` is set, `managed`
 * unset (lastBearerVersion stays), and the listeners hear of it. Also used by the routes when a
 * device turns out to be revoked while its own request ran. */
export async function revokeLocalHost(deps: LocalHostDeps, host: LocalHost): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  await deleteHostNgrok(deps, host);
  await retireBearer(deps, host);
  const next = await deps.store.localHosts.update(host.id, { revokedAt: now.toISOString(), managed: undefined });
  if (!next) return;
  const { problems } = await deps.events.changed({ reason: "device-revoked", host: next, previous: host });
  if (problems.length) deps.log?.("local hosts: listeners reported problems on revoke", { id: host.id, problems });
}
