/**
 * The tunnel-provider contract for Local Host (#380 LH-2, epic #378): one interface, so the
 * transport that carries a laptop's model server to the LiteLLM router is pluggable (ngrok first,
 * Cloudflare Tunnel later, #386). The background service (#381) is the caller; it gets credentials
 * from Outfitter (#383) and never decides access itself.
 *
 * A provider only moves bytes from a public (or Outfitter-internal) endpoint to `localUrl`. The
 * access rules travel with the credentials (Outfitter's traffic policy) and are enforced a second
 * time by the guard proxy in front of the model server (proxy.ts), whatever the provider.
 */

export type TunnelProviderId = "ngrok" | "cloudflare";
/** The `localHost.tunnel` choice: one provider, or `auto` (registry.ts selectProvider). */
export type TunnelChoice = TunnelProviderId | "auto";

/** The only paths a shared model server answers through a tunnel (epic #378, "Tighter rules"). */
export const DEFAULT_ALLOW_PATHS: readonly string[] = Object.freeze([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
  "/v1/models",
]);

/** At most `requests` requests in any `windowSeconds`-long window (a sliding window). */
export interface RateLimit {
  requests: number;
  windowSeconds: number;
}

/** Interim default until Outfitter sends one (#383): generous for one person's agent, and a hard
 * stop for a leaked URL being hammered. */
export const DEFAULT_RATE_LIMIT: RateLimit = Object.freeze({ requests: 120, windowSeconds: 60 });

/** What Outfitter hands a host for ngrok (#383), or the interim `.env` values. */
export interface NgrokCredentials {
  provider: "ngrok";
  /** The agent authtoken. Outfitter's per-host credential can only bind this host's endpoint. */
  authtoken: string;
  /** The endpoint to bind: a reserved domain (`https://name.ngrok.app`) or an internal endpoint
   * (`https://<user>-<host>.internal`) behind Outfitter's cloud endpoint. Absent: ngrok assigns a
   * random URL, which is only useful for trying it out. */
  url?: string;
  /** A traffic policy (YAML or JSON) from Outfitter. Present, it is used as given; absent, the
   * built-in one (policy.ts) applies the allow-list, the rate limit and `bearerToken`. */
  trafficPolicy?: string;
  /** Interim gate (today's LOCAL_TUNNEL_TOKEN): requests without `Authorization: Bearer <it>` are
   * refused at ngrok's edge and again by the guard proxy. */
  bearerToken?: string;
}

/** Cloudflare Tunnel (#386); the shape is a placeholder until that provider exists. */
export interface CloudflareCredentials {
  provider: "cloudflare";
  tunnelToken: string;
  hostname?: string;
}

export type TunnelCredentials = NgrokCredentials | CloudflareCredentials;

export interface TunnelStartOptions {
  /** Where the tunnel delivers traffic, e.g. `http://127.0.0.1:41234` (the guard proxy). */
  localUrl: string;
  credentials: TunnelCredentials;
  /** Paths the endpoint answers; everything else is refused. Defaults to DEFAULT_ALLOW_PATHS. */
  allowPaths?: readonly string[];
  rateLimit?: RateLimit;
  /** Called once if the tunnel goes down by itself (not after stop()), so the service can restart it. */
  onDown?: (reason: string) => void;
  onLog?: (line: string) => void;
}

export type TunnelState = "up" | "down" | "stopped";

export interface TunnelHealth {
  state: TunnelState;
  /** Why it is down, when it is. */
  reason?: string;
  /** ISO time of the last state change. */
  since: string;
}

export interface Tunnel {
  readonly provider: TunnelProviderId;
  /** Where the router reaches this host. */
  readonly publicUrl: string;
  health(): TunnelHealth;
  /** Idempotent; resolves once the tunnel is torn down. */
  stop(): Promise<void>;
}

/**
 * Whether a provider can run here. Never throws: a missing runtime or missing credentials is a
 * state, reported with a reason a person can act on.
 */
export interface ProviderStatus {
  provider: TunnelProviderId;
  available: boolean;
  /** Why not, when `available` is false. */
  reason?: string;
  /** The runtime is missing but Kernal can fetch it (ngrok: a checksum-pinned agent binary). */
  installable?: boolean;
  /** What would run, e.g. `ngrok 3.39.11 (/Users/x/.kernal/bin/ngrok)`. */
  runtime?: string;
}

export interface TunnelProvider {
  readonly id: TunnelProviderId;
  /** Runtime present (and, given credentials, usable). Never throws. */
  status(credentials?: TunnelCredentials): Promise<ProviderStatus>;
  /** Opens the tunnel; throws TunnelError (kind "unavailable" when the runtime is missing). */
  start(opts: TunnelStartOptions): Promise<Tunnel>;
}

export type TunnelErrorKind = "unavailable" | "credentials" | "timeout" | "failed";

export class TunnelError extends Error {
  readonly kind: TunnelErrorKind;
  constructor(kind: TunnelErrorKind, message: string) {
    super(message);
    this.name = "TunnelError";
    this.kind = kind;
  }
}
