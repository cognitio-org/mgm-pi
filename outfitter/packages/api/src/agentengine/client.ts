// Atlas Agent Engine connection (E9, docs/specs/atlas-agent-engine-and-a2a.md §2): one client per
// Agent Engine project, holding that project's service-account token.
//
// - Token: POST {base}/api/v1/oauth/token, form grant_type=client_credentials, the client id and
//   secret as HTTP Basic. Reply {access_token, token_type, expires_in: 3600}. Cached and refreshed
//   5 minutes before it expires. Token requests are rate-limited (429), so there is one refresh in
//   flight per client, and after a 429 the client waits out Retry-After (or 30 s) before asking
//   again instead of hammering the endpoint from every caller.
// - Calls: `fetch` sets Authorization from the cache on every attempt, and on a 401 forces one
//   refresh and retries once (the token may have been revoked or rotated early). The memory SDK
//   gets this `fetch` as its fetchImpl (memory.ts), since its own token is a fixed header.
// - Errors: one AgentEngineError type with a `kind`, so callers branch on what happened rather than
//   on status codes. Messages never carry a credential or a token, and remote text is clipped.
// - Redirects are refused: a bearer token or Basic credentials must never follow one.
//
// Every Agent Engine type stays inside src/agentengine/ (preview API, breaking changes expected).

import { agentEngineExpiryWarning, type AgentEngineProjectConfig } from "../config.ts";

export type AgentEngineErrorKind =
  /** The feature is off here (no project id or credentials). */
  | "off"
  /** 401/403: credentials or token refused. */
  | "auth"
  /** 429, from the token endpoint or an API route. */
  | "rate_limited"
  | "not_found"
  | "bad_request"
  /** 5xx, or a reply we couldn't read. */
  | "server"
  /** The request never got a reply. */
  | "network"
  | "timeout"
  /** Not built yet (E9 PR4 completes agents.ts). */
  | "not_implemented";

export class AgentEngineError extends Error {
  readonly kind: AgentEngineErrorKind;
  readonly status?: number;
  /** For rate_limited: how long to wait before asking again. */
  readonly retryAfterMs?: number;

  constructor(kind: AgentEngineErrorKind, message: string, opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AgentEngineError";
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface AgentEngineClientOptions {
  /** Which part this is, for messages and the rotation warning. */
  part: "memory" | "agents";
  baseUrl: string;
  project: AgentEngineProjectConfig;
  fetch?: FetchFn;
  now?: () => number;
  /** Refresh this long before expiry. Default 5 min. */
  refreshSkewMs?: number;
  /** Per token request. Default 10 s. */
  tokenTimeoutMs?: number;
  /** Per `request` call (the SDK sets its own). Default 30 s. */
  requestTimeoutMs?: number;
  /** After a 429 without Retry-After. Default 30 s. */
  rateLimitBackoffMs?: number;
  log?: (message: string) => void;
}

const MAX_REMOTE_TEXT = 300;

/** Remote text for an error message: one line, clipped. */
export function clipRemote(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_REMOTE_TEXT ? `${one.slice(0, MAX_REMOTE_TEXT)}…` : one;
}

/** Retry-After as milliseconds: delta seconds or an HTTP date. */
function retryAfterMs(res: Response, now: number): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** The error kind for a non-2xx status. */
export function kindForStatus(status: number): AgentEngineErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "bad_request";
  return "server";
}

function isAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

interface CachedToken {
  value: string;
  /** When to stop using it (expiry minus the skew). */
  refreshAt: number;
}

export class AgentEngineClient {
  readonly part: "memory" | "agents";
  readonly baseUrl: string;
  readonly projectId: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly expiresAt?: string;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly skewMs: number;
  private readonly tokenTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly backoffMs: number;
  private readonly log: (message: string) => void;
  private cached?: CachedToken;
  private inflight?: Promise<CachedToken>;
  private cooldownUntil = 0;
  private lastExpiryWarning = Number.NEGATIVE_INFINITY;
  /** Token requests made, for tests and the daily usage log (PR3). */
  tokenRequests = 0;

  constructor(opts: AgentEngineClientOptions) {
    this.part = opts.part;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.projectId = opts.project.projectId;
    this.clientId = opts.project.clientId;
    this.clientSecret = opts.project.clientSecret;
    this.expiresAt = opts.project.expiresAt;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.skewMs = opts.refreshSkewMs ?? 5 * 60_000;
    this.tokenTimeoutMs = opts.tokenTimeoutMs ?? 10_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.backoffMs = opts.rateLimitBackoffMs ?? 30_000;
    this.log = opts.log ?? (() => {});
    // `fetch` is handed to the SDK as a bare function.
    this.fetch = this.fetch.bind(this);
  }

  /** `/api/v1/projects/{p}` on this client's base URL; `path` starts with `/`. */
  projectUrl(path: string): string {
    return `${this.baseUrl}/api/v1/projects/${encodeURIComponent(this.projectId)}${path}`;
  }

  /**
   * A bearer token for this project: the cached one while it is fresh, else one refresh shared by
   * every caller waiting at the time. `force` drops the cached token first, but only if it is still
   * `stale` (the one a 401 came back for), so a burst of 401s costs one refresh, not one each.
   */
  async token(opts: { force?: boolean; stale?: string } = {}): Promise<string> {
    if (opts.force && this.cached && (opts.stale === undefined || this.cached.value === opts.stale)) this.cached = undefined;
    if (this.cached && this.now() < this.cached.refreshAt) return this.cached.value;
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = undefined;
      });
    }
    return (await this.inflight).value;
  }

  private async refresh(): Promise<CachedToken> {
    const now = this.now();
    if (now < this.cooldownUntil) {
      const wait = this.cooldownUntil - now;
      throw new AgentEngineError("rate_limited", `Agent Engine ${this.part}: token requests are rate-limited; retry in ${Math.ceil(wait / 1000)}s`, {
        status: 429,
        retryAfterMs: wait,
      });
    }
    this.warnIfExpiring(now);
    this.tokenRequests++;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`, "utf8").toString("base64");
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/v1/oauth/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
        redirect: "error",
        signal: AbortSignal.timeout(this.tokenTimeoutMs),
      });
    } catch (err) {
      if (isAbort(err)) throw new AgentEngineError("timeout", `Agent Engine ${this.part}: no token reply in ${Math.round(this.tokenTimeoutMs / 1000)}s`);
      throw new AgentEngineError("network", `Agent Engine ${this.part}: token request failed: ${clipRemote(err instanceof Error ? err.message : String(err))}`);
    }
    if (!res.ok) {
      // The body isn't quoted: a token endpoint's error text is no help to a caller, and we keep
      // anything near the credentials out of logs.
      await res.body?.cancel().catch(() => {});
      if (res.status === 429) {
        const wait = retryAfterMs(res, this.now()) ?? this.backoffMs;
        this.cooldownUntil = this.now() + wait;
        throw new AgentEngineError("rate_limited", `Agent Engine ${this.part}: token requests are rate-limited; retry in ${Math.ceil(wait / 1000)}s`, {
          status: 429,
          retryAfterMs: wait,
        });
      }
      const kind = kindForStatus(res.status);
      const hint = kind === "auth" ? " (check the service account secret, outfitter-agentengine-" + this.part + "-sa)" : "";
      throw new AgentEngineError(kind, `Agent Engine ${this.part}: token request answered ${res.status}${hint}`, { status: res.status });
    }
    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new AgentEngineError("server", `Agent Engine ${this.part}: token reply wasn't JSON`);
    }
    const value = typeof body?.access_token === "string" ? body.access_token.trim() : "";
    if (!value || /\s/.test(value)) throw new AgentEngineError("server", `Agent Engine ${this.part}: token reply had no access_token`);
    const lifetimeMs = (typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0 ? body.expires_in : 3600) * 1000;
    // A short-lived token (shorter than twice the skew) is used for half its life instead.
    const skew = lifetimeMs > 2 * this.skewMs ? this.skewMs : lifetimeMs / 2;
    const token = { value, refreshAt: this.now() + lifetimeMs - skew };
    this.cached = token;
    return token;
  }

  /** The 14-day rotation warning (E9 §2), at most once a day per client. */
  private warnIfExpiring(now: number): void {
    if (now - this.lastExpiryWarning < 24 * 60 * 60_000) return;
    const warning = agentEngineExpiryWarning(this.part, this.expiresAt, now);
    if (!warning) return;
    this.lastExpiryWarning = now;
    this.log(warning);
  }

  /**
   * fetch with this project's bearer token, for the SDK and for `request`. On a 401 it refreshes
   * once and retries once; the body must be replayable (a string, as the SDK and `request` send).
   * A token failure throws AgentEngineError; a network failure is rethrown as is (the SDK retries
   * those).
   */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    // The token is for Agent Engine only, whatever URL the SDK builds.
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new AgentEngineError("bad_request", `Agent Engine ${this.part}: not a URL`);
    }
    if (target.origin !== new URL(this.baseUrl).origin) throw new AgentEngineError("bad_request", `Agent Engine ${this.part}: refusing to send the token to another origin`);
    const signal = init.signal ?? undefined;
    const send = async (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return this.fetchFn(url, { ...init, headers, redirect: "error" });
    };
    const first = await this.waitFor(this.token(), signal);
    const res = await send(first);
    if (res.status !== 401) return res;
    await res.body?.cancel().catch(() => {});
    return send(await this.waitFor(this.token({ force: true, stale: first }), signal));
  }

  /** A shared token wait that this caller can abandon: its abort or timeout ends its own wait,
   * never the refresh other callers are waiting on. */
  private waitFor<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return p;
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  /**
   * A JSON call on this project (`path` under /api/v1/projects/{p}), for the routes the SDK doesn't
   * cover. Resolves to the parsed body (undefined for an empty one); rejects with AgentEngineError.
   */
  async request<T = unknown>(method: string, path: string, opts: { body?: unknown; query?: Record<string, string | undefined>; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<T> {
    const url = new URL(this.projectUrl(path));
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetch(url.toString(), {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal,
      });
    } catch (err) {
      if (err instanceof AgentEngineError) throw err;
      if (isAbort(err)) throw new AgentEngineError("timeout", `Agent Engine ${this.part}: ${method} ${path} got no reply in time`);
      throw new AgentEngineError("network", `Agent Engine ${this.part}: ${method} ${path} failed: ${clipRemote(err instanceof Error ? err.message : String(err))}`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new AgentEngineError(kindForStatus(res.status), `Agent Engine ${this.part}: ${method} ${path} answered ${res.status}${text ? `: ${clipRemote(errorText(text))}` : ""}`, {
        status: res.status,
        ...(res.status === 429 ? { retryAfterMs: retryAfterMs(res, this.now()) } : {}),
      });
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AgentEngineError("server", `Agent Engine ${this.part}: ${method} ${path} reply wasn't JSON`);
    }
  }
}

/** The useful part of an error body: FastAPI's `detail`, or `error`/`message`, else the raw text. */
function errorText(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    for (const key of ["detail", "error", "message"]) if (typeof j?.[key] === "string") return j[key] as string;
  } catch {
    // not JSON
  }
  return text;
}

