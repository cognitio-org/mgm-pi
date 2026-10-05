/**
 * `kernal local run`: the Local Host loop (#381, local-host.md §1.4, §4.6, §4.8). Every POLL it
 * looks at what the laptop serves (discovery, localhost only), keeps one tunnel to one model server
 * open while sharing is on and a server answers, and tells Outfitter when something changed (or
 * every `nextHeartbeatSeconds` while sharing). The clock, fetch, discovery, tunnel, session and
 * settings are injected, so tests drive tick() with fakes and nothing real is contacted.
 *
 * Credentials: signed in, from POST /api/local-hosts/tunnel-credentials (kept in memory only, never
 * on disk); signed out, or when Outfitter provisions none, the interim `.env` ones
 * (interimCredentialsFromEnv), which run a tunnel but get no router entries.
 *
 * Built-ins and relative imports only (§4.3).
 */
import { serverRoot, type DiscoverySnapshot, type ServerKind, type ServerSnapshot } from "../_shared/local-discovery.ts";
import { DEFAULT_ALLOW_PATHS, DEFAULT_RATE_LIMIT, TunnelError, interimCredentialsFromEnv, parseTunnelChoice, type LocalHostTunnel, type NgrokCredentials, type OpenTunnelOptions } from "../_shared/tunnel/tunnel.ts";
import {
  CREDENTIALS_REFETCH_MARGIN_SECONDS, HEARTBEAT_INTERVAL_SECONDS, MAX_MODELS, MAX_SERVERS,
  parseCredentialsResponse, parseHeartbeatResponse, toNgrokCredentials,
  type CredentialsHint, type HeartbeatReason, type HeartbeatRequest, type HeartbeatResponse, type HeartbeatTunnel, type HeartbeatTunnelState, type TunnelCredentialsResponse, type TunnelProvider,
} from "./protocol.ts";
import type { Logger, ServiceState } from "./state.ts";

export const POLL_MS = 15_000;
/** Changes inside this window are folded into one heartbeat (§1.4). */
export const MIN_HEARTBEAT_GAP_MS = 10_000;
export const CONFIG_REFRESH_MS = 10 * 60_000;
export const STOP_HEARTBEAT_TIMEOUT_MS = 3_000;
export const REQUEST_TIMEOUT_MS = 15_000;
/** After a 403/404 from §1.1 (or a token refused twice): try again this much later. */
export const BLOCKED_RETRY_MS = 15 * 60_000;
export const BACKOFF_START_MS = 5_000;
export const BACKOFF_MAX_MS = 300_000;
/** A tunnel that stayed up this long has its restart backoff reset. */
export const TUNNEL_STABLE_MS = 60_000;
/** The tunnel's server when KERNAL_LOCAL_HOST_SERVER doesn't name one that answers (§4.6). */
export const SERVER_ORDER: readonly ServerKind[] = ["lmstudio", "ollama", "llamacpp", "mlx-lm", "vllm", "openai"];

/** 5 s, 10 s, 20 s ... capped at 5 min, for the `n`th consecutive failure (0-based). */
export function backoffMs(n: number): number {
  return Math.min(BACKOFF_START_MS * 2 ** Math.max(0, n), BACKOFF_MAX_MS);
}

/** The one model server the tunnel forwards to: `preferred` (a root URL) if it answers, else the
 * first answering server in SERVER_ORDER. */
export function pickServer(snap: DiscoverySnapshot | undefined, preferred?: string): ServerSnapshot | undefined {
  const ok = (snap?.servers ?? []).filter((s) => s.ok);
  const want = preferred?.trim() ? serverRoot(preferred) : undefined;
  if (want) {
    const s = ok.find((x) => x.id === want);
    if (s) return s;
  }
  for (const kind of SERVER_ORDER) {
    const s = ok.find((x) => x.kind === kind);
    if (s) return s;
  }
  return undefined;
}

export interface Account {
  api: string;
  email: string;
  deviceId: string;
}

export interface LoopDeps {
  env: Readonly<Record<string, string | undefined>>;
  now: () => number;
  /** Requests to Outfitter. */
  fetch: typeof fetch;
  discover: () => Promise<DiscoverySnapshot>;
  openTunnel: (opts: OpenTunnelOptions) => Promise<LocalHostTunnel>;
  session: {
    /** Sync, a file read: who is signed in to outfitterApi(), if anyone. */
    account: () => Account | undefined;
    /** A valid access token; `rejected` after a 401 (outfitter-session.ts getAccessToken). */
    token: (account: Account, rejected?: string) => Promise<string | undefined>;
  };
  config: {
    /** refreshConfig(): fetch the account's settings (signed in only). */
    refresh: () => Promise<void>;
    /** The resolved localHost.shareModels, re-read from disk (works signed out too). */
    shareModels: () => { value: boolean; source: string };
  };
  host: { hostId: string; hostName: string; kernalVersion: string; platform: string; runtime: string; pid: number };
  log: Logger;
  saveState: (s: ServiceState) => void;
  pollMs?: number;
}

type Fields = Pick<HeartbeatRequest, "discoveryKey" | "shareModels"> & Pick<HeartbeatTunnel, "state" | "url" | "server" | "credentialId">;
const sameFields = (a: Fields, b: Fields) =>
  a.discoveryKey === b.discoveryKey && a.shareModels === b.shareModels && a.state === b.state && a.url === b.url && a.server === b.server && a.credentialId === b.credentialId;

interface Running {
  handle: LocalHostTunnel;
  server: string;
  key: string;
  managed: boolean;
  url: string;
  credentialId?: string;
  openedAt: number;
}

interface TunnelView {
  provider: TunnelProvider | null;
  managed: boolean;
  state: HeartbeatTunnelState;
  url: string | null;
  publicUrl: string | null;
  server: string | null;
  credentialId: string | null;
  since: number;
  reason: string | null;
}

const credKey = (c: NgrokCredentials) => JSON.stringify([c.authtoken, c.url ?? "", c.bearerToken ?? "", c.trafficPolicy ?? ""]);
const errText = (e: any) => String(e?.message ?? e).split("\n")[0].slice(0, 300);

export class LocalHostLoop {
  private readonly d: LoopDeps;
  private readonly pollMs: number;
  private readonly startedAt: number;
  private kickFn: () => void = () => {};

  private lastTickAt: number | undefined;
  private account: Account | undefined;
  private authRejected: { deviceId: string; until: number } | undefined;
  private lastConfigAt: number | undefined;
  private configWanted = true;
  private share: { value: boolean; source: string } = { value: false, source: "default" };
  private snap: DiscoverySnapshot | undefined;
  private server: ServerSnapshot | undefined;

  private hint: CredentialsHint | undefined;
  private creds: TunnelCredentialsResponse | undefined;
  private credsStale = false;
  private credsFailures = 0;
  private credsRetryAt = 0;
  private credsError: string | undefined;

  private running: Running | undefined;
  private downReason: string | undefined;
  private tunnelFailures = 0;
  private tunnelRetryAt = 0;
  private view: TunnelView;

  private hb = {
    lastSentAt: undefined as number | undefined,
    acked: undefined as Fields | undefined,
    startAcked: false,
    nextIntervalAt: undefined as number | undefined,
    failures: 0,
    retryAt: 0,
    blockedUntil: 0,
    lastAt: undefined as number | undefined,
    ok: null as boolean | null,
    answer: undefined as HeartbeatResponse | undefined,
    error: null as string | null,
  };
  private forceHeartbeat = false;
  private savedJson = "";

  constructor(d: LoopDeps) {
    this.d = d;
    this.pollMs = d.pollMs ?? POLL_MS;
    this.startedAt = d.now();
    this.view = { provider: null, managed: false, state: "off", url: null, publicUrl: null, server: null, credentialId: null, since: this.startedAt, reason: "starting" };
  }

  /** Called when a tick should run soon (the tunnel went down). */
  setKick(fn: () => void): void {
    this.kickFn = fn;
  }

  /** SIGHUP: fetch the settings again on the next tick. */
  requestConfigRefresh(): void {
    this.configWanted = true;
  }

  nextDelayMs(): number {
    return this.pollMs;
  }

  // ---------- one poll ----------

  async tick(): Promise<void> {
    try {
      await this.tickOnce();
    } finally {
      // Measured from the end of a tick, so a slow one (a 15 s request timeout, a tunnel start)
      // never looks like a wake on the next.
      this.lastTickAt = this.d.now();
    }
  }

  private async tickOnce(): Promise<void> {
    const now = this.d.now();
    const late = this.lastTickAt === undefined ? 0 : now - this.lastTickAt;
    const wake = late > 2 * this.pollMs;
    if (wake) {
      this.d.log("info", `woke up (a poll ${Math.round(late / 1000)} s after the last): restarting the tunnel`);
      if (this.running) await this.closeTunnel();
      this.tunnelFailures = 0;
      this.tunnelRetryAt = 0;
      this.credsRetryAt = 0;
      this.hb.retryAt = 0;
      this.forceHeartbeat = true;
    }

    this.updateAccount(now);
    if (this.account && (this.configWanted || this.lastConfigAt === undefined || now - this.lastConfigAt >= CONFIG_REFRESH_MS)) {
      this.configWanted = false;
      this.lastConfigAt = now;
      try { await this.d.config.refresh(); } catch (e) { this.d.log("warn", `settings refresh failed: ${errText(e)}`); }
    }
    let share = this.share;
    try { share = this.d.config.shareModels(); } catch (e) { this.d.log("warn", `could not read localHost.shareModels: ${errText(e)}`); }
    if (share.value !== this.share.value) this.d.log("info", `sharing ${share.value ? "on" : "off"} (${share.source})`);
    this.share = share;

    try {
      this.snap = await this.d.discover();
    } catch (e) {
      this.d.log("warn", `discovery failed: ${errText(e)}`);
    }
    const server = pickServer(this.snap, this.d.env.KERNAL_LOCAL_HOST_SERVER);
    if (server?.id !== this.server?.id) this.d.log("info", server ? `model server: ${server.kind} at ${server.id}` : "no model server answers");
    this.server = server;

    await this.tunnelStep();
    const before = { hint: this.hint, blocked: this.hb.blockedUntil, account: this.account };
    await this.heartbeatStep(this.forceHeartbeat);
    this.forceHeartbeat = false;
    if (before.hint !== this.hint || before.blocked !== this.hb.blockedUntil || before.account !== this.account) await this.tunnelStep();
    this.persist();
  }

  private updateAccount(now: number): void {
    let a: Account | undefined;
    try { a = this.d.session.account(); } catch { a = undefined; }
    if (a && this.authRejected && this.authRejected.deviceId === a.deviceId && now < this.authRejected.until) a = undefined;
    const key = (x?: Account) => (x ? `${x.api}|${x.email}|${x.deviceId}` : "");
    if (key(a) === key(this.account)) return;
    this.d.log("info", a ? `signed in as ${a.email}` : "signed out: no heartbeats, interim credentials only");
    this.account = a;
    // A new login starts over: its own hint, its own credentials (the old ones were the old account's).
    this.hint = undefined;
    this.creds = undefined;
    this.credsStale = false;
    this.credsFailures = 0;
    this.credsRetryAt = 0;
    this.credsError = undefined;
    this.hb.acked = undefined;
    this.hb.startAcked = false;
    this.hb.nextIntervalAt = undefined;
    this.hb.failures = 0;
    this.hb.retryAt = 0;
    this.hb.blockedUntil = 0;
    this.hb.answer = undefined;
    this.hb.error = null;
    this.configWanted = true;
  }

  // ---------- the tunnel ----------

  /** Managed credentials apply: signed in, and Outfitter didn't say it provisions none. */
  private managedPath(): boolean {
    return !!this.account && this.hint !== "unavailable";
  }

  private async tunnelStep(): Promise<void> {
    const now = this.d.now();
    const blocked = !!this.account && now < this.hb.blockedUntil;
    const why =
      !this.share.value ? "sharing is off" :
      !this.server ? "no model server answers" :
      this.account && this.hint === "none" ? "Outfitter says this host is not sharing" :
      blocked ? this.hb.error ?? "Outfitter refused this device" :
      undefined;
    if (why) return this.setOff(why);

    let creds: NgrokCredentials | undefined;
    if (this.managedPath()) {
      if (this.hint === undefined) return this.setOff("waiting for Outfitter's answer");
      const expiring = !!this.creds && Date.parse(this.creds.expiresAt) - now < CREDENTIALS_REFETCH_MARGIN_SECONDS * 1000;
      const need = !this.creds || this.hint === "fetch" || this.credsStale || expiring;
      if (need && now >= this.credsRetryAt) await this.fetchCredentials();
      if (this.hint === "none" || now < this.hb.blockedUntil) return this.setOff(this.credsError ?? "Outfitter refused tunnel credentials");
    }
    // fetchCredentials may have learned that this deployment provisions none (503).
    const managed = this.managedPath();
    if (managed) {
      if (!this.creds) return this.setOff(this.credsError ?? "no tunnel credentials");
      creds = toNgrokCredentials(this.creds);
    } else {
      creds = interimCredentialsFromEnv(this.d.env);
      if (!creds) return this.setOff("no tunnel credentials");
    }

    const server = this.server!;
    const key = credKey(creds);
    const r = this.running;
    const healthy = !!r && !this.downReason && r.handle.health().state === "up";
    if (r && healthy && r.server === server.id && r.key === key) {
      if (now - r.openedAt >= TUNNEL_STABLE_MS) this.tunnelFailures = 0;
      return;
    }
    if (now < this.tunnelRetryAt) return;
    if (r) await this.closeTunnel();

    const choice = parseTunnelChoice(this.d.env.KERNAL_LOCAL_TUNNEL);
    const allowPaths = managed && this.creds!.allowPaths.length ? this.creds!.allowPaths : DEFAULT_ALLOW_PATHS;
    const rateLimit = managed ? this.creds!.rateLimit : DEFAULT_RATE_LIMIT;
    const provider: TunnelProvider = choice === "cloudflare" ? "cloudflare" : "ngrok";
    let handle: LocalHostTunnel;
    try {
      handle = await this.d.openTunnel({
        choice,
        credentials: [creds],
        localUrl: server.id,
        allowPaths,
        rateLimit,
        onDown: (reason) => this.tunnelWentDown(handle, reason),
        onLog: (line) => this.d.log("info", line),
      });
    } catch (e: any) {
      this.tunnelRetryAt = now + backoffMs(this.tunnelFailures);
      this.tunnelFailures++;
      if (managed && e instanceof TunnelError && e.kind === "credentials") this.credsStale = true;
      const reason = errText(e);
      this.d.log("warn", `tunnel failed: ${reason} (next try in ${Math.round((this.tunnelRetryAt - now) / 1000)} s)`);
      this.setView({ provider, managed, state: "down", url: creds.url ?? null, publicUrl: managed ? this.creds!.publicUrl : null, server: server.id, credentialId: managed ? this.creds!.credentialId : null, reason });
      return;
    }
    const url = managed ? this.creds!.url : handle.publicUrl;
    this.running = { handle, server: server.id, key, managed, url, credentialId: managed ? this.creds!.credentialId : undefined, openedAt: now };
    this.downReason = undefined;
    this.d.log("info", `tunnel up: ${handle.provider} ${managed ? "(managed)" : "(interim credentials)"} ${managed ? this.creds!.publicUrl : handle.publicUrl} -> ${server.id}`);
    this.setView({ provider: handle.provider, managed, state: "up", url, publicUrl: managed ? this.creds!.publicUrl : handle.publicUrl, server: server.id, credentialId: managed ? this.creds!.credentialId : null, reason: null });
  }

  private tunnelWentDown(handle: LocalHostTunnel | undefined, reason: string): void {
    const r = this.running;
    if (!r || (handle && r.handle !== handle)) return; // an old tunnel we already replaced
    const now = this.d.now();
    this.downReason = reason;
    this.tunnelRetryAt = now + backoffMs(this.tunnelFailures);
    this.tunnelFailures++;
    if (r.managed && /credential|authtoken|ERR_NGROK_10[0-9]/i.test(reason)) this.credsStale = true;
    this.d.log("warn", `tunnel down: ${reason}`);
    this.setView({ ...this.view, state: "down", reason });
    this.persist();
    this.kickFn();
  }

  private async closeTunnel(): Promise<void> {
    const r = this.running;
    this.running = undefined;
    this.downReason = undefined;
    if (!r) return;
    try { await r.handle.stop(); } catch (e) { this.d.log("warn", `stopping the tunnel: ${errText(e)}`); }
    this.d.log("info", "tunnel stopped");
  }

  private async setOff(reason: string): Promise<void> {
    if (this.running) await this.closeTunnel();
    const managed = this.managedPath();
    this.setView({ provider: this.view.provider, managed, state: "off", url: null, publicUrl: null, server: null, credentialId: managed && this.creds ? this.creds.credentialId : null, reason });
  }

  private setView(v: Omit<TunnelView, "since">): void {
    const same = this.view.state === v.state && this.view.reason === v.reason;
    this.view = { ...v, since: same ? this.view.since : this.d.now() };
  }

  // ---------- Outfitter ----------

  /** One authenticated request; a 401 asks the session once more and retries once (§1.4). */
  private async send(path: string, body: unknown, timeoutMs: number): Promise<Response | undefined> {
    const account = this.account!;
    const go = (token: string) => this.d.fetch(`${account.api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const token = await this.d.session.token(account);
    if (!token) return undefined;
    const res = await go(token);
    if (res.status !== 401) return res;
    const again = await this.d.session.token(account, token);
    if (!again || again === token) return res;
    return go(again);
  }

  private async fetchCredentials(): Promise<void> {
    const now = this.d.now();
    let res: Response | undefined;
    try {
      res = await this.send("/api/local-hosts/tunnel-credentials", { hostId: this.d.host.hostId }, REQUEST_TIMEOUT_MS);
    } catch (e) {
      return this.credsFailed(now, `tunnel credentials: ${errText(e)}`);
    }
    if (!res) return this.credsFailed(now, "tunnel credentials: not signed in");
    const json: any = await res.json().catch(() => undefined);
    if (res.ok) {
      const c = parseCredentialsResponse(json);
      if (!c) return this.credsFailed(now, "tunnel credentials: Outfitter's answer is incomplete");
      this.creds = c;
      this.credsStale = false;
      this.credsFailures = 0;
      this.credsRetryAt = 0;
      this.credsError = undefined;
      // The next heartbeat reports the new credential id; until it answers, these are current.
      if (this.hint === "fetch") this.hint = "current";
      this.d.log("info", `tunnel credentials issued (${c.credentialId}, until ${c.expiresAt})`);
      return;
    }
    const code = typeof json?.error === "string" ? json.error : `HTTP ${res.status}`;
    if (res.status === 409) { this.hint = "none"; return this.credsFailed(now, "tunnel credentials: sharing is off for this host", false); }
    if (res.status === 503) { this.hint = "unavailable"; this.creds = undefined; this.d.log("info", "Outfitter provisions no tunnels here; using interim credentials if any"); return; }
    if (res.status === 404 && code === "host_unknown") { this.forceHeartbeat = true; return this.credsFailed(now, "tunnel credentials: Outfitter doesn't know this host yet"); }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      this.hb.blockedUntil = now + BLOCKED_RETRY_MS;
      this.hb.error = `tunnel credentials refused: ${code}`;
      this.creds = undefined;
      return this.credsFailed(now, this.hb.error, false);
    }
    return this.credsFailed(now, `tunnel credentials: ${code}`);
  }

  private credsFailed(now: number, error: string, retry = true): void {
    this.credsError = error;
    if (retry) {
      this.credsRetryAt = now + backoffMs(this.credsFailures);
      this.credsFailures++;
    }
    this.d.log("warn", error);
  }

  private tunnelForHeartbeat(state?: HeartbeatTunnelState): HeartbeatTunnel {
    const v = this.view;
    const live = v.state === "up" || v.state === "down";
    return {
      provider: v.provider ?? "ngrok",
      managed: v.managed,
      state: state ?? v.state,
      ...(live && v.url ? { url: v.url } : {}),
      ...(live && v.server ? { server: v.server } : {}),
      ...(v.managed && v.credentialId ? { credentialId: v.credentialId } : {}),
      ...(v.reason ? { reason: v.reason.slice(0, 200) } : {}),
    };
  }

  private fields(t: HeartbeatTunnel): Fields {
    return { discoveryKey: this.snap?.key ?? "", shareModels: this.share.value, state: t.state, url: t.url, server: t.server, credentialId: t.credentialId };
  }

  private request(reason: HeartbeatReason, tunnel: HeartbeatTunnel): HeartbeatRequest {
    const h = this.d.host;
    return {
      hostId: h.hostId,
      hostName: h.hostName,
      kernalVersion: h.kernalVersion.slice(0, 32),
      platform: h.platform.slice(0, 32),
      shareModels: this.share.value,
      discoveryKey: this.snap?.key ?? "",
      servers: (this.snap?.servers ?? []).slice(0, MAX_SERVERS),
      models: (this.snap?.models ?? []).slice(0, MAX_MODELS),
      tunnel,
      reason,
    };
  }

  private async heartbeatStep(force: boolean): Promise<void> {
    if (!this.account) return;
    const now = this.d.now();
    if (now < this.hb.blockedUntil) return;
    const tunnel = this.tunnelForHeartbeat();
    const fields = this.fields(tunnel);
    const changed = !this.hb.acked || !sameFields(fields, this.hb.acked);
    let due: boolean;
    if (force) due = true;
    else if (now < this.hb.retryAt) due = false;
    else if (this.hb.failures > 0) due = true; // the backoff, not the fold window, spaces retries
    else if (changed) due = this.hb.lastSentAt === undefined || now - this.hb.lastSentAt >= MIN_HEARTBEAT_GAP_MS;
    else due = this.share.value && this.hb.nextIntervalAt !== undefined && now >= this.hb.nextIntervalAt;
    if (!due) return;
    const reason: HeartbeatReason = !this.hb.startAcked ? "start" : changed ? "change" : "interval";
    this.hb.lastSentAt = now;
    let res: Response | undefined;
    try {
      res = await this.send("/api/local-hosts/heartbeat", this.request(reason, tunnel), REQUEST_TIMEOUT_MS);
    } catch (e) {
      return this.heartbeatFailed(now, errText(e));
    }
    if (!res) return; // signed out meanwhile (the refresh was refused): the next tick sees it
    const json: any = await res.json().catch(() => undefined);
    this.hb.lastAt = now;
    if (res.ok) {
      const answer = parseHeartbeatResponse(json);
      if (!answer) return this.heartbeatFailed(now, "Outfitter's heartbeat answer is not one");
      this.hb.acked = fields;
      this.hb.startAcked = true;
      this.hb.failures = 0;
      this.hb.retryAt = 0;
      this.hb.blockedUntil = 0;
      this.hb.nextIntervalAt = now + answer.nextHeartbeatSeconds * 1000;
      this.hb.ok = true;
      this.hb.error = null;
      if (answer.credentials !== this.hint) this.d.log("info", `Outfitter: ${answer.status}, credentials ${answer.credentials}`);
      if (answer.problems.length) this.d.log("warn", `Outfitter: ${answer.problems.join("; ")}`);
      this.hb.answer = answer;
      this.hint = answer.credentials;
      return;
    }
    const code = typeof json?.error === "string" ? json.error : `HTTP ${res.status}`;
    if (res.status === 401) {
      // Refused twice (send() already asked the session once more): signed out, as §4.8.
      this.authRejected = { deviceId: this.account.deviceId, until: now + BLOCKED_RETRY_MS };
      this.hb.ok = false;
      this.hb.error = "Outfitter refused this login; run kernal login";
      this.d.log("warn", this.hb.error);
      this.updateAccount(now);
      return;
    }
    if (res.status === 403 || res.status === 404) {
      this.hb.blockedUntil = now + BLOCKED_RETRY_MS;
      this.hb.ok = false;
      this.hb.error = `Outfitter refused the heartbeat: ${code}`;
      this.d.log("warn", `${this.hb.error}; trying again in 15 minutes`);
      return;
    }
    if (res.status === 429) {
      const after = Number(json?.retryAfterSeconds);
      this.hb.retryAt = now + (Number.isFinite(after) && after > 0 ? after * 1000 : MIN_HEARTBEAT_GAP_MS);
      this.hb.ok = false;
      this.hb.error = code;
      return;
    }
    return this.heartbeatFailed(now, res.status === 400 && json?.field ? `${code} (${json.field})` : code);
  }

  private heartbeatFailed(now: number, error: string): void {
    this.hb.retryAt = now + backoffMs(this.hb.failures);
    this.hb.failures++;
    this.hb.ok = false;
    this.hb.error = error;
    this.d.log("warn", `heartbeat failed: ${error} (next try in ${Math.round((this.hb.retryAt - now) / 1000)} s)`);
  }

  // ---------- stop ----------

  /** SIGTERM/SIGINT and `kernal local disable`: the "stop" heartbeat (3 s, best effort), then the tunnel. */
  async stop(): Promise<void> {
    const now = this.d.now();
    if (this.account && this.hb.startAcked && now >= this.hb.blockedUntil) {
      try {
        const res = await this.send("/api/local-hosts/heartbeat", this.request("stop", this.tunnelForHeartbeat("stopped")), STOP_HEARTBEAT_TIMEOUT_MS);
        this.d.log(res?.ok ? "info" : "warn", `stop heartbeat: ${res ? res.status : "not signed in"}`);
      } catch (e) {
        this.d.log("warn", `stop heartbeat failed: ${errText(e)}`);
      }
    }
    await this.closeTunnel();
    this.setView({ ...this.view, state: "stopped", reason: "the service stopped" });
    this.persist();
  }

  // ---------- state.json ----------

  state(): ServiceState {
    const iso = (t: number | undefined) => (t === undefined ? null : new Date(t).toISOString());
    const models = this.snap?.models ?? [];
    const a = this.hb.answer;
    const v = this.view;
    return {
      version: 1,
      pid: this.d.host.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      runtime: this.d.host.runtime,
      hostId: this.d.host.hostId,
      signedIn: this.account ? { email: this.account.email } : null,
      shareModels: { value: this.share.value, source: this.share.source },
      server: this.server?.id ?? null,
      discoveryKey: this.snap?.key ?? null,
      models: { total: models.length, loaded: models.filter((m) => m.loaded).length },
      tunnel: { provider: v.provider, managed: v.managed, state: v.state, url: v.url, publicUrl: v.publicUrl, since: new Date(v.since).toISOString(), reason: v.reason },
      heartbeat: {
        lastAt: iso(this.hb.lastAt),
        ok: this.hb.ok,
        status: a?.status ?? null,
        nextAt: this.account ? iso(this.hb.retryAt || this.hb.blockedUntil || (this.share.value ? this.hb.nextIntervalAt : undefined)) : null,
        routerModels: a?.routerModels ?? [],
        problems: a?.problems ?? [],
        error: this.hb.error,
      },
      updatedAt: new Date(this.d.now()).toISOString(),
    };
  }

  /** Written on every change, not every poll. */
  private persist(): void {
    const s = this.state();
    const { updatedAt: _u, ...rest } = s;
    const json = JSON.stringify(rest);
    if (json === this.savedJson) return;
    this.savedJson = json;
    try { this.d.saveState(s); } catch (e) { this.d.log("warn", `could not write the state file: ${errText(e)}`); }
  }
}

// ---------- the service process ----------

export type SignalName = "SIGTERM" | "SIGINT" | "SIGHUP";

export interface ServeOptions {
  onSignal: (signal: SignalName, handler: () => void) => void;
  log: Logger;
}

/** Ticks until SIGTERM/SIGINT, then stop(). SIGHUP refreshes the settings now. */
export async function serve(loop: LocalHostLoop, opts: ServeOptions): Promise<void> {
  let stopping = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    if (timer) clearTimeout(timer);
    const w = wake;
    wake = undefined;
    w?.();
  };
  loop.setKick(kick);
  const stop = () => {
    if (!stopping) opts.log("info", "stopping");
    stopping = true;
    kick();
  };
  opts.onSignal("SIGTERM", stop);
  opts.onSignal("SIGINT", stop);
  opts.onSignal("SIGHUP", () => { loop.requestConfigRefresh(); kick(); });
  while (!stopping) {
    try {
      await loop.tick();
    } catch (e) {
      opts.log("error", `tick failed: ${errText(e)}`);
    }
    if (stopping) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, loop.nextDelayMs());
    });
  }
  await loop.stop();
}

export { HEARTBEAT_INTERVAL_SECONDS };
