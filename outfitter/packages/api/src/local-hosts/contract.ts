// Local Host wave 2 (epic #378, docs/specs/local-host.md): the wire shapes between Kernal's
// background service (#381) and the api (#382 heartbeat, #383 tunnel credentials, the GET listing
// #385/#388 read), and the constants every task shares.
//
// Spec-owned (local-host.md §9): change a shape only through the spec, in its own PR, under
// "Contract changes". Kernal keeps its own copy of these types (kernal-local/protocol.ts, task C);
// the spec is the source of truth for both.

/** How often a sharing host heartbeats when nothing changed (§1.4). The server answers it in
 * `nextHeartbeatSeconds`, so it can be changed here without a Kernal release. */
export const HEARTBEAT_INTERVAL_SECONDS = 300;
/** A host whose last heartbeat is older than this many intervals (plus STALE_SLACK_SECONDS) is
 * stale (§1.5). */
export const STALE_AFTER_MISSED = 3;
export const STALE_SLACK_SECONDS = 60;
/** A stale host's ngrok cloud endpoint is deleted after this long (§2.5); the next
 * tunnel-credentials call makes a new one. */
export const ENDPOINT_IDLE_SECONDS = 24 * 60 * 60;
/** Kernal refetches credentials this long after they were issued (advisory; §2.3). */
export const CREDENTIALS_REFETCH_SECONDS = 7 * 24 * 60 * 60;

/** Request limits (§1.2). A body over these is a 400, never truncated. */
export const MAX_SERVERS = 16;
export const MAX_MODELS = 256;
export const MAX_BODY_BYTES = 256 * 1024;

/** The default (and, in wave 2, only) access group (§1.6). */
export const DEFAULT_ACCESS_GROUP = "everyone";
/** The LiteLLM model access group every local model is in (§3.6). */
export const LOCAL_HOST_ACCESS_GROUP = "local-hosts";
/** Stamped on every ngrok resource and router entry this feature makes (`purpose` / metadata). */
export const LOCAL_HOST_PURPOSE = "outfitter-local-host";

/** The paths a shared model server answers through its tunnel (epic #378 "Tighter rules"); the
 * same list as Kernal's DEFAULT_ALLOW_PATHS (_shared/tunnel/types.ts). */
export const LOCAL_HOST_ALLOW_PATHS: readonly string[] = Object.freeze([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
  "/v1/models",
]);
/** Per client IP at the cloud endpoint. All router traffic shares the router's IPs, so this is
 * effectively per host. Same default as Kernal's DEFAULT_RATE_LIMIT. */
export const LOCAL_HOST_RATE_LIMIT = Object.freeze({ requests: 120, windowSeconds: 60 });

// ---------- discovery shapes (copied from kernal/.pi/extensions/_shared/local-discovery.ts) ----------

export type ServerKind = "lmstudio" | "ollama" | "llamacpp" | "mlx-lm" | "vllm" | "openai";

/** One model as Kernal's discovery reports it (LocalModel). Unknown fields are dropped. */
export interface HeartbeatModel {
  id: string;
  server: string;
  kind: ServerKind;
  loaded?: boolean;
  listed?: boolean;
  contextLength?: number;
  maxContextLength?: number;
  loadedContextLength?: number;
  type?: string;
  vision?: boolean;
  toolUse?: boolean;
  quantization?: string;
  sizeBytes?: number;
  digest?: string;
}

/** One server as Kernal's discovery reports it (ServerSnapshot). */
export interface HeartbeatServer {
  id: string;
  kind: ServerKind;
  baseUrl: string;
  ok: boolean;
  error?: string;
  endpoints: string[];
  models: number;
}

// ---------- POST /api/local-hosts/heartbeat (§1.2, task A) ----------

export type TunnelProvider = "ngrok" | "cloudflare";
/** `off`: the service runs no tunnel (sharing off, no server, signed out). */
export type HeartbeatTunnelState = "up" | "down" | "stopped" | "off";

export interface HeartbeatTunnel {
  provider: TunnelProvider;
  /** true: credentials came from POST /api/local-hosts/tunnel-credentials; false: interim `.env`
   * values (interimCredentialsFromEnv). Only managed hosts get router entries (§3.4). */
  managed: boolean;
  state: HeartbeatTunnelState;
  /** The URL the agent bound: `https://<label>.internal` when managed, the reserved domain when not. */
  url?: string;
  /** ServerSnapshot.id of the one model server the tunnel forwards to (§4.6). */
  server?: string;
  /** The ngrok credential id the agent runs with (from the credentials answer; not a secret). */
  credentialId?: string;
  /** Why it is down, when it is. One line, no secrets. */
  reason?: string;
}

export type HeartbeatReason = "start" | "change" | "interval" | "stop";

export interface HeartbeatRequest {
  /** `h_` + 24 lowercase hex: stable per machine (§4.4). */
  hostId: string;
  /** The machine's name as people know it (os.hostname() without `.local`), 1-64 printable chars. */
  hostName: string;
  /** VERSION's first line in a release bundle, "source" in a checkout. */
  kernalVersion: string;
  /** `<process.platform>-<process.arch>`, e.g. darwin-arm64. */
  platform: string;
  /** The resolved `localHost.shareModels` for this device. */
  shareModels: boolean;
  /** DiscoverySnapshot.key. */
  discoveryKey: string;
  servers: HeartbeatServer[];
  models: HeartbeatModel[];
  tunnel: HeartbeatTunnel;
  reason: HeartbeatReason;
}

/**
 * What the service should do about tunnel credentials (§1.3):
 *   current      keep what you have;
 *   fetch        POST /api/local-hosts/tunnel-credentials now (none yet, rotated, endpoint gone);
 *   none         stop the tunnel: sharing is off, or this host may not share;
 *   unavailable  this deployment provisions none (no NGROK_API_KEY or LOCAL_HOST_DOMAIN): use the
 *                interim `.env` credentials if there are any. No router entries then.
 */
export type CredentialsHint = "current" | "fetch" | "none" | "unavailable";

export type LocalHostStatus = "online" | "offline" | "not-sharing" | "stale" | "revoked";

export interface HeartbeatResponse {
  accepted: true;
  /** The api's id for this host (`lh_` + 24 hex), used in DELETE /api/local-hosts/:id. */
  id: string;
  status: LocalHostStatus;
  /** Send the next heartbeat at most this many seconds from now, even if nothing changed. */
  nextHeartbeatSeconds: number;
  credentials: CredentialsHint;
  /** `<userSlug>-<hostSlug>`: the router names are `local/<routerPrefix>/<modelId>`. */
  routerPrefix: string;
  /** The router names this host's models get while it is online (§3.1); [] when it isn't. */
  routerModels: string[];
  /** One line each, never a secret: e.g. "router: LiteLLM did not answer", "model id not routable: …". */
  problems: string[];
}

// ---------- POST /api/local-hosts/tunnel-credentials (§2.3, task A) ----------

export interface TunnelCredentialsRequest {
  hostId: string;
}

export interface TunnelCredentialsResponse {
  provider: "ngrok";
  /** The ngrok agent authtoken: its ACL binds only `url`. Shown once; Kernal keeps it in memory. */
  authtoken: string;
  credentialId: string;
  /** The internal endpoint the agent binds: `https://<label>.internal`. */
  url: string;
  /** The cloud endpoint the router calls: `https://<publicSlug>.<LOCAL_HOST_DOMAIN>`. */
  publicUrl: string;
  /** The internal endpoint's traffic policy (JSON), used as given (NgrokCredentials.trafficPolicy). */
  trafficPolicy: string;
  /** The per-host bearer the router sends; the guard proxy checks it too (NgrokCredentials.bearerToken). */
  bearer: string;
  allowPaths: string[];
  rateLimit: { requests: number; windowSeconds: number };
  issuedAt: string;
  /** Advisory: fetch again before this. The credential keeps working until it is rotated or revoked. */
  expiresAt: string;
}

// ---------- GET /api/local-hosts (§1.7, task A) ----------

export interface LocalHostModelView {
  id: string;
  /** `local/<routerPrefix>/<id>`, or absent when the id can't be routed (§3.1). */
  routerModel?: string;
  kind: ServerKind;
  loaded?: boolean;
  contextLength?: number;
  vision?: boolean;
  toolUse?: boolean;
  type?: string;
  /** Whether the tunnel reaches this model's server (only those get router entries). */
  shared: boolean;
}

export interface LocalHostView {
  id: string;
  hostName: string;
  owner: { email: string; mine: boolean };
  status: LocalHostStatus;
  shareModels: boolean;
  accessGroup: string;
  routerPrefix: string;
  kernalVersion?: string;
  platform?: string;
  lastSeenAt: string;
  tunnel: { provider: TunnelProvider; managed: boolean; state: HeartbeatTunnelState };
  servers: Array<{ id: string; kind: ServerKind; ok: boolean }>;
  models: LocalHostModelView[];
}

export interface LocalHostListResponse {
  hosts: LocalHostView[];
}
