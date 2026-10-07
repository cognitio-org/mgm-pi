/**
 * The Local Host wire shapes (#381, outfitter/docs/specs/local-host.md §1-§2): Kernal's copy of
 * outfitter/packages/api/src/local-hosts/contract.ts. A copy, not an import: Kernal ships without
 * Outfitter's code. The spec is the source of truth for both; change one only with the other.
 *
 * Built-ins and relative imports only (§4.3): this runs under Node and under the bundle's pi as Bun.
 */
import type { LocalModel, ServerKind, ServerSnapshot } from "../_shared/local-discovery.ts";
import type { NgrokCredentials, RateLimit } from "../_shared/tunnel/types.ts";

export type { ServerKind };

/** The default heartbeat interval; the server's `nextHeartbeatSeconds` overrides it (§1.4). */
export const HEARTBEAT_INTERVAL_SECONDS = 300;
/** Kernal refetches credentials when `expiresAt` is closer than this (§2.3). */
export const CREDENTIALS_REFETCH_MARGIN_SECONDS = 24 * 60 * 60;
/** The api refuses more than these (§1.2); the service sends at most this many. */
export const MAX_SERVERS = 16;
export const MAX_MODELS = 256;

export type HeartbeatServer = ServerSnapshot;
export type HeartbeatModel = LocalModel;

export type TunnelProvider = "ngrok" | "cloudflare";
/** `off`: the service runs no tunnel (sharing off, no server, signed out, no credentials). */
export type HeartbeatTunnelState = "up" | "down" | "stopped" | "off";

export interface HeartbeatTunnel {
  provider: TunnelProvider;
  /** Credentials from POST /api/local-hosts/tunnel-credentials (true) or interim `.env` ones. */
  managed: boolean;
  state: HeartbeatTunnelState;
  url?: string;
  /** ServerSnapshot.id of the one model server the tunnel forwards to. */
  server?: string;
  credentialId?: string;
  /** Why it is down or off. One line, no secrets. */
  reason?: string;
}

export type HeartbeatReason = "start" | "change" | "interval" | "stop";

export interface HeartbeatRequest {
  hostId: string;
  hostName: string;
  kernalVersion: string;
  platform: string;
  shareModels: boolean;
  discoveryKey: string;
  servers: HeartbeatServer[];
  models: HeartbeatModel[];
  tunnel: HeartbeatTunnel;
  reason: HeartbeatReason;
}

export type CredentialsHint = "current" | "fetch" | "none" | "unavailable";
export type LocalHostStatus = "online" | "offline" | "not-sharing" | "stale" | "revoked";

export interface HeartbeatResponse {
  accepted: true;
  id: string;
  status: LocalHostStatus;
  nextHeartbeatSeconds: number;
  credentials: CredentialsHint;
  routerPrefix: string;
  routerModels: string[];
  problems: string[];
}

export interface TunnelCredentialsResponse {
  provider: "ngrok";
  authtoken: string;
  credentialId: string;
  url: string;
  publicUrl: string;
  trafficPolicy: string;
  bearer: string;
  allowPaths: string[];
  rateLimit: RateLimit;
  issuedAt: string;
  expiresAt: string;
}

const HINTS: readonly string[] = ["current", "fetch", "none", "unavailable"];
const STATUSES: readonly string[] = ["online", "offline", "not-sharing", "stale", "revoked"];
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A 200 heartbeat answer, or undefined when it isn't one (then the call counts as failed). */
export function parseHeartbeatResponse(json: unknown): HeartbeatResponse | undefined {
  const j = json as Partial<HeartbeatResponse> | null;
  if (!j || typeof j !== "object" || j.accepted !== true || typeof j.id !== "string") return undefined;
  const next = typeof j.nextHeartbeatSeconds === "number" && Number.isFinite(j.nextHeartbeatSeconds) && j.nextHeartbeatSeconds > 0 ? j.nextHeartbeatSeconds : HEARTBEAT_INTERVAL_SECONDS;
  return {
    accepted: true,
    id: j.id,
    status: (STATUSES.includes(j.status as string) ? j.status : "offline") as LocalHostStatus,
    nextHeartbeatSeconds: next,
    // An answer from a newer api with a hint this Kernal doesn't know: keep what we have.
    credentials: (HINTS.includes(j.credentials as string) ? j.credentials : "current") as CredentialsHint,
    routerPrefix: typeof j.routerPrefix === "string" ? j.routerPrefix : "",
    routerModels: strings(j.routerModels),
    problems: strings(j.problems),
  };
}

/** A 200 credentials answer, or undefined when a field the tunnel needs is missing. */
export function parseCredentialsResponse(json: unknown): TunnelCredentialsResponse | undefined {
  const j = json as Partial<TunnelCredentialsResponse> | null;
  if (!j || typeof j !== "object" || j.provider !== "ngrok") return undefined;
  for (const k of ["authtoken", "credentialId", "url", "publicUrl", "bearer", "issuedAt", "expiresAt"] as const) {
    if (typeof j[k] !== "string" || !j[k]) return undefined;
  }
  const rl = j.rateLimit;
  return {
    provider: "ngrok",
    authtoken: j.authtoken!,
    credentialId: j.credentialId!,
    url: j.url!,
    publicUrl: j.publicUrl!,
    trafficPolicy: typeof j.trafficPolicy === "string" ? j.trafficPolicy : "",
    bearer: j.bearer!,
    allowPaths: strings(j.allowPaths),
    rateLimit: rl && typeof rl.requests === "number" && typeof rl.windowSeconds === "number" ? { requests: rl.requests, windowSeconds: rl.windowSeconds } : { requests: 120, windowSeconds: 60 },
    issuedAt: j.issuedAt!,
    expiresAt: j.expiresAt!,
  };
}

/** The credentials answer as the ngrok provider takes it (§2.3). */
export function toNgrokCredentials(c: TunnelCredentialsResponse): NgrokCredentials {
  return { provider: "ngrok", authtoken: c.authtoken, url: c.url, ...(c.trafficPolicy ? { trafficPolicy: c.trafficPolicy } : {}), bearerToken: c.bearer };
}
