/**
 * Kernal's sign-in to Outfitter (#391 CA-2, outfitter/docs/specs/central-auth.md §2): `kernal login`
 * runs the device-code flow against the link origin and keeps the tokens in the OS keychain, one
 * login per machine, shared by every Kernal process. Owned by task E; the exports below are the
 * contract central-config.ts (CA-8), /admin (CA-9), the migration (CA-10) and outfitter-env.ts
 * build against.
 *
 * Two halves (§2.3): `accounts.json` under KERNAL_AUTH_DIR (default ~/.kernal/auth) says who is
 * signed in where and holds no secret, so loginState() stays a file read; the tokens and the
 * router key sit in one keychain item per account (keychain.ts). The newest pair in the keychain
 * is the only truth: a refresh re-reads it inside a cross-process lock (§2.4), so several Kernals
 * rotating the same refresh token never sign the machine out.
 */
import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { backendNamed, chooseBackend, fileBackend, itemHash, type Runner } from "./keychain.ts";

/** Baked into releases (spec §2.1); OUTFITTER_API overrides it, for dev. */
export const DEFAULT_OUTFITTER_API = "https://link.kernal.one";

/** An access token with less than this left is refreshed before use (§2.4). */
export const REFRESH_MARGIN_MS = 2 * 60_000;
/** A refresh lock older than this belongs to a process that died holding it. */
export const LOCK_STALE_MS = 30_000;
/** `kernal logout` never waits longer than this for the server (§2.5). */
export const REVOKE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface SessionAccount {
  /** The link origin this login belongs to, no trailing slash. */
  api: string;
  email: string;
  /** Outfitter's user id (`u_...`). */
  userId: string;
  deviceId: string;
  deviceName: string;
}

/** The secret half of a login, one keychain item per account (spec §2.3). */
export interface SessionSecrets {
  accessToken: string;
  /** ISO time. */
  accessExpiresAt: string;
  refreshToken: string;
  /** CA-5: this device's router key, delivered once at login. */
  routerKey?: { key: string; baseUrl: string; alias: string; expiresAt?: string };
}

export type LoginState = { signedIn: false } | { signedIn: true; account: SessionAccount };

/** Where the secret half lives. Synchronous on purpose: start-up reads it before any await. */
export interface SecretBackend {
  name: "keychain" | "secret-service" | "file";
  get(account: string): string | undefined;
  set(account: string, value: string): void;
  delete(account: string): void;
}

/**
 * Options every function takes beyond the contract's `api`/`email`: where the login lives. Unset,
 * KERNAL_AUTH_DIR and KERNAL_AUTH_BACKEND of `env` (default process.env) decide; tests pass a
 * temporary directory and a fake backend.
 */
export interface SessionStorage {
  env?: NodeJS.ProcessEnv;
  authDir?: string;
  backend?: SecretBackend;
  /** Runs `security` / `secret-tool` for the default backends; tests pass a fake. */
  runner?: Runner;
  /** Where the one-time "using a file" notice goes. Default stderr. */
  notice?: (line: string) => void;
}

type Which = { api?: string; email?: string } & SessionStorage;

/** The API this process talks to: OUTFITTER_API, else DEFAULT_OUTFITTER_API. */
export function outfitterApi(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OUTFITTER_API?.trim() || DEFAULT_OUTFITTER_API).replace(/\/+$/, "");
}

/** `${KERNAL_AUTH_DIR:-~/.kernal/auth}`: the same for a release and a source checkout. */
export function authDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.KERNAL_AUTH_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".kernal", "auth");
}

// ---- the index: who is signed in where, no secrets ----

interface IndexEntry extends SessionAccount {
  accessExpiresAt: string;
  /** Which backend holds this account's secrets, so a read goes where the write went. */
  backend?: SecretBackend["name"];
}
interface IndexFile {
  version: 1;
  accounts: IndexEntry[];
  defaults: Record<string, string>;
}

const dirOf = (o: SessionStorage) => o.authDir ?? authDir(o.env ?? process.env);
const indexPath = (dir: string) => join(dir, "accounts.json");
const itemName = (a: { api: string; email: string }) => `${a.api}|${a.email}`;
const normApi = (api: string) => api.trim().replace(/\/+$/, "");

function readIndex(dir: string): IndexFile {
  try {
    const raw = JSON.parse(readFileSync(indexPath(dir), "utf8")) as Partial<IndexFile>;
    const accounts = Array.isArray(raw.accounts)
      ? raw.accounts.filter((a): a is IndexEntry => !!a && typeof a.api === "string" && typeof a.email === "string" && typeof a.deviceId === "string")
      : [];
    const defaults = raw.defaults && typeof raw.defaults === "object" ? raw.defaults : {};
    return { version: 1, accounts, defaults };
  } catch {
    return { version: 1, accounts: [], defaults: {} };
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Someone else's directory (KERNAL_AUTH_DIR pointed somewhere shared): the files are 0600 anyway.
  }
}

/** Written whole and renamed, mode 0600; an empty index is removed, so bin/kernal's "is there a
 * login" test (the file exists) stays true only while one is. */
function writeIndex(dir: string, index: IndexFile): void {
  if (!index.accounts.length) {
    rmSync(indexPath(dir), { force: true });
    return;
  }
  ensureDir(dir);
  const tmp = `${indexPath(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, indexPath(dir));
}

/** `email` names the account; else the api's default; else the api's only account. */
function pickEntry(index: IndexFile, api: string, email?: string): IndexEntry | undefined {
  const here = index.accounts.filter((a) => a.api === api);
  if (email) return here.find((a) => a.email.toLowerCase() === email.trim().toLowerCase());
  const def = index.defaults[api];
  return here.find((a) => a.email === def) ?? (here.length === 1 ? here[0] : undefined);
}

function toAccount(e: IndexEntry): SessionAccount {
  return { api: e.api, email: e.email, userId: e.userId, deviceId: e.deviceId, deviceName: e.deviceName };
}

// ---- the secret half ----

const NOTICE = Symbol.for("kernal.outfitterSession.fileNotice");

/** Kernal says once per process that the login is in a file (§2.3). */
function noteFile(o: SessionStorage, dir: string): void {
  const g = globalThis as { [NOTICE]?: boolean };
  if (g[NOTICE]) return;
  g[NOTICE] = true;
  (o.notice ?? ((l: string) => process.stderr.write(`${l}\n`)))(
    `kernal: no keychain available; keeping the Outfitter login in a private file under ${dir}`,
  );
}

function backendFor(entry: IndexEntry, o: SessionStorage): SecretBackend {
  const dir = dirOf(o);
  return o.backend ?? backendNamed(entry.backend ?? chooseBackend(dir, o.env ?? process.env, o.runner).name, dir, o.runner);
}

function parseSecrets(raw: string | undefined): SessionSecrets | undefined {
  if (!raw) return undefined;
  try {
    const s = JSON.parse(raw) as SessionSecrets;
    return typeof s.accessToken === "string" && typeof s.refreshToken === "string" && typeof s.accessExpiresAt === "string" ? s : undefined;
  } catch {
    return undefined;
  }
}

function readSecrets(entry: IndexEntry, o: SessionStorage): SessionSecrets | undefined {
  try {
    return parseSecrets(backendFor(entry, o).get(itemName(entry)));
  } catch {
    return undefined;
  }
}

/** Writes the secrets where this entry's backend says, or (a new login) the first backend that
 * works: a keychain that refuses the write gives way to the file. Returns the backend used. */
function writeSecrets(entry: IndexEntry, secrets: SessionSecrets, o: SessionStorage): SecretBackend["name"] {
  const dir = dirOf(o);
  const value = JSON.stringify(secrets);
  const first = o.backend ?? (entry.backend ? backendNamed(entry.backend, dir, o.runner) : chooseBackend(dir, o.env ?? process.env, o.runner));
  try {
    first.set(itemName(entry), value);
    if (first.name === "file" && !o.backend && (o.env ?? process.env).KERNAL_AUTH_BACKEND?.trim() !== "file") noteFile(o, dir);
    return first.name;
  } catch (err) {
    if (first.name === "file" || o.backend) throw err;
    fileBackend(dir).set(itemName(entry), value);
    noteFile(o, dir);
    return "file";
  }
}

/** Removes one login from this machine: its secrets, its index entry, its lock. */
function forget(entry: IndexEntry, o: SessionStorage): void {
  const dir = dirOf(o);
  try {
    backendFor(entry, o).delete(itemName(entry));
  } catch {
    // Already gone, or the keychain is locked: the index entry goes either way.
  }
  const index = readIndex(dir);
  index.accounts = index.accounts.filter((a) => !(a.api === entry.api && a.email === entry.email));
  if (index.defaults[entry.api] === entry.email) {
    const next = index.accounts.find((a) => a.api === entry.api);
    if (next) index.defaults[entry.api] = next.email;
    else delete index.defaults[entry.api];
  }
  writeIndex(dir, index);
  rmSync(join(dir, `${itemHash(itemName(entry))}.lock`), { force: true });
}

function lookup(opts: Which): { entry?: IndexEntry; api: string } {
  const api = normApi(opts.api ?? outfitterApi(opts.env ?? process.env));
  return { api, entry: pickEntry(readIndex(dirOf(opts)), api, opts.email) };
}

// ---- reads ----

/** Sync, no network: whether this machine is signed in to `api` (default outfitterApi()), and as
 * whom. `email` picks one of several accounts (a profile names its account, spec §2.3). */
export function loginState(opts: Which = {}): LoginState {
  const { entry } = lookup(opts);
  return entry ? { signedIn: true, account: toAccount(entry) } : { signedIn: false };
}

/** Sync: the stored access token as it is, maybe stale (outfitter-env.ts's `token`). Use
 * getAccessToken() for a request. */
export function currentAccessToken(opts: Which = {}): string | undefined {
  const { entry } = lookup(opts);
  return entry ? readSecrets(entry, opts)?.accessToken : undefined;
}

/** CA-5's router key for this device, from the keychain. Sync. */
export function getRouterKey(opts: Which = {}): SessionSecrets["routerKey"] | undefined {
  const { entry } = lookup(opts);
  return entry ? readSecrets(entry, opts)?.routerKey : undefined;
}

/** Replaces the stored router key (after POST /api/device/router-key re-minted it). */
export function setRouterKey(key: NonNullable<SessionSecrets["routerKey"]>, opts: Which = {}): void {
  const { api, entry } = lookup(opts);
  const secrets = entry && readSecrets(entry, opts);
  if (!entry || !secrets) throw new Error(`not signed in to ${api}`);
  writeSecrets(entry, { ...secrets, routerKey: key }, opts);
}

// ---- refresh (§2.4) ----

type TokenAnswer = {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  device?: { id?: string; name?: string };
  account?: { email?: string; userId?: string };
  delivery?: { routerKey?: SessionSecrets["routerKey"] };
  problems?: unknown[];
};

function isTokenAnswer(v: unknown): v is TokenAnswer {
  const t = v as TokenAnswer;
  return !!t && typeof t.access_token === "string" && typeof t.refresh_token === "string" && typeof t.expires_in === "number";
}

async function postJson(fetchFn: typeof fetch, url: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; body: any }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: "manual",
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed };
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** An exclusive lock file (O_EXCL), broken when stale. Runs `fn` without the lock if it can't be
 * had in time: a second refresh then costs at most one rotation, which the server's grace absorbs. */
async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  // The wall clock, never an injected one: the lock file's mtime is wall-clock time.
  const now = Date.now;
  const deadline = now() + LOCK_STALE_MS + 5_000;
  let held = false;
  while (!held) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      held = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") break;
      try {
        if (now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (now() > deadline) break;
      await sleepMs(100);
    }
  }
  try {
    return await fn();
  } finally {
    if (held) rmSync(path, { force: true });
  }
}

async function refresh(entry: IndexEntry, secrets: SessionSecrets, o: Which & { fetch?: typeof fetch; now?: () => number }): Promise<string | undefined> {
  const now = o.now ?? Date.now;
  const stillValid = () => (Date.parse(secrets.accessExpiresAt) > now() ? secrets.accessToken : undefined);
  let res: { status: number; body: any };
  try {
    res = await postJson(o.fetch ?? fetch, `${entry.api}/api/device/refresh`, { grant_type: "refresh_token", refresh_token: secrets.refreshToken }, REQUEST_TIMEOUT_MS);
  } catch {
    return stillValid(); // offline: the old token while it lasts
  }
  if (res.status === 200 && isTokenAnswer(res.body)) {
    const next: SessionSecrets = {
      accessToken: res.body.access_token,
      accessExpiresAt: new Date(now() + res.body.expires_in * 1000).toISOString(),
      refreshToken: res.body.refresh_token,
      ...(secrets.routerKey ? { routerKey: secrets.routerKey } : {}),
    };
    writeSecrets(entry, next, o);
    const dir = dirOf(o);
    const index = readIndex(dir);
    const e = index.accounts.find((a) => a.api === entry.api && a.email === entry.email);
    if (e) {
      e.accessExpiresAt = next.accessExpiresAt;
      if (typeof res.body.device?.name === "string") e.deviceName = res.body.device.name;
      writeIndex(dir, index);
    }
    return next.accessToken;
  }
  // The server said no for good (revoked, reused, removed from the allow-list): forget the login.
  if (res.status === 400 && (res.body?.error === "invalid_grant" || res.body?.error === "access_denied")) {
    forget(entry, o);
    return undefined;
  }
  return stillValid();
}

/** A valid access token, refreshed first when it has under 2 minutes left (single-flight across
 * processes, spec §2.4). Undefined when signed out or when the refresh was refused (then the
 * login is cleared). Never throws.
 *
 * `rejected`: the token a request just got a 401 for. The keychain is re-read once: a newer token
 * (another process refreshed) comes back, the same one does not, so the caller retries once (§2.4). */
export async function getAccessToken(
  opts: { api?: string; email?: string; fetch?: typeof fetch; rejected?: string; now?: () => number } & SessionStorage = {},
): Promise<string | undefined> {
  try {
    const now = opts.now ?? Date.now;
    const { entry } = lookup(opts);
    if (!entry) return undefined;
    const fresh = (s: SessionSecrets | undefined) => !!s && Date.parse(s.accessExpiresAt) - now() > REFRESH_MARGIN_MS;
    const first = readSecrets(entry, opts);
    if (!first) return undefined;
    if (opts.rejected) return first.accessToken !== opts.rejected ? first.accessToken : undefined;
    if (fresh(first)) return first.accessToken;
    const dir = dirOf(opts);
    ensureDir(dir);
    return await withLock(join(dir, `${itemHash(itemName(entry))}.lock`), async () => {
      // Inside the lock: the stored pair, never the one read before it; another process may have
      // rotated it already.
      const current = readSecrets(entry, opts);
      if (!current) return undefined;
      if (fresh(current)) return current.accessToken;
      return refresh(entry, current, opts);
    });
  } catch {
    return undefined;
  }
}

// ---- login and logout ----

export interface LoginOptions {
  api?: string;
  /** Default: the machine's hostname. */
  deviceName?: string;
  /** False with KERNAL_NO_BROWSER or no display: print the URL and code instead. */
  openBrowser?: boolean;
  /** Where the URL, the code and progress go (the CLI passes a stderr writer). */
  print: (line: string) => void;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Opens a URL in the browser. Default: `open` / `xdg-open` / `start`. */
  openUrl?: (url: string) => void;
  /** Waits between polls; tests skip the wait. Rejects when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Sent as `kernalVersion`. Default: this checkout's package.json version. */
  kernalVersion?: string;
}

/** The hostname without `.local`, cut to the 64 characters the server allows. */
export function defaultDeviceName(): string {
  return (hostname().replace(/\.local$/i, "").trim() || "kernal").slice(0, 64);
}

function installedVersion(): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function refusal(api: string, status: number, body: any): string {
  const error = typeof body?.error === "string" ? body.error : undefined;
  if (error === "rate_limited") return `too many sign-in attempts from this address; try again in ${Number(body.retryAfter) || 60} s`;
  if (error === "login_unavailable") return `sign-in is not enabled on ${api}`;
  if (status === 404) return `${api} has no device sign-in yet (needs a newer Outfitter)`;
  return `${api} answered ${status}${error ? `: ${error.slice(0, 200)}` : ""}`;
}

/** Runs the whole device-code flow and stores the result. Throws with a one-line reason. */
export async function login(opts: LoginOptions & SessionStorage): Promise<SessionAccount> {
  const api = normApi(opts.api ?? outfitterApi(opts.env ?? process.env));
  const fetchFn = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? abortableSleep;
  const now = opts.now ?? Date.now;
  const deviceName = (opts.deviceName?.trim() || defaultDeviceName()).slice(0, 64);
  const kernalVersion = opts.kernalVersion ?? installedVersion();
  const cancelled = () => opts.signal?.aborted;

  let code: { status: number; body: any };
  try {
    code = await postJson(fetchFn, `${api}/api/device/code`, { deviceName, platform: `${process.platform}-${process.arch}`, ...(kernalVersion ? { kernalVersion } : {}) }, REQUEST_TIMEOUT_MS, opts.signal);
  } catch (err) {
    if (cancelled()) throw new Error("cancelled");
    throw new Error(`could not reach ${api}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (code.status !== 200) throw new Error(refusal(api, code.status, code.body));
  const c = code.body as { device_code?: unknown; user_code?: unknown; verification_uri?: unknown; verification_uri_complete?: unknown; expires_in?: unknown; interval?: unknown };
  if (typeof c?.device_code !== "string" || typeof c.user_code !== "string" || typeof c.verification_uri !== "string") {
    throw new Error(`${api} sent an invalid answer; is OUTFITTER_API the link origin?`);
  }

  opts.print(`To sign in, open ${c.verification_uri} and enter the code ${c.user_code}`);
  if (opts.openBrowser !== false) {
    try {
      (opts.openUrl ?? openInBrowser)(typeof c.verification_uri_complete === "string" ? c.verification_uri_complete : c.verification_uri);
    } catch {
      // The URL is printed above.
    }
  }
  opts.print("Waiting for approval in the browser (Ctrl-C to stop)...");

  let interval = typeof c.interval === "number" && c.interval >= 0 ? c.interval : 5;
  const deadline = now() + (typeof c.expires_in === "number" ? c.expires_in : 600) * 1000;
  let answer: TokenAnswer | undefined;
  while (!answer) {
    await sleep(interval * 1000, opts.signal);
    if (now() > deadline) throw new Error("the code expired before it was approved; run kernal login again");
    let res: { status: number; body: any };
    try {
      res = await postJson(fetchFn, `${api}/api/device/token`, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: c.device_code }, REQUEST_TIMEOUT_MS, opts.signal);
    } catch {
      if (cancelled()) throw new Error("cancelled");
      continue; // a dropped poll is retried at the next interval
    }
    if (res.status === 200) {
      if (!isTokenAnswer(res.body) || typeof res.body.account?.email !== "string" || typeof res.body.device?.id !== "string") {
        throw new Error(`${api} sent an invalid token answer`);
      }
      answer = res.body;
      break;
    }
    const error = res.body?.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval = typeof res.body.interval === "number" ? res.body.interval : interval + 5;
      continue;
    }
    if (error === "access_denied") throw new Error("the sign-in was denied (or this account may not use Kernal)");
    if (error === "expired_token") throw new Error("the code expired before it was approved; run kernal login again");
    if (error === "invalid_grant") throw new Error("the code is no longer valid; run kernal login again");
    throw new Error(refusal(api, res.status, res.body));
  }

  const account: SessionAccount = {
    api,
    email: answer.account!.email!,
    userId: answer.account?.userId ?? "",
    deviceId: answer.device!.id!,
    deviceName: answer.device?.name ?? deviceName,
  };
  const rk = answer.delivery?.routerKey;
  const secrets: SessionSecrets = {
    accessToken: answer.access_token,
    accessExpiresAt: new Date(now() + answer.expires_in * 1000).toISOString(),
    refreshToken: answer.refresh_token,
    ...(rk && typeof rk.key === "string" && typeof rk.baseUrl === "string" && typeof rk.alias === "string" ? { routerKey: rk } : {}),
  };

  // Signing in again as the same person replaces the old device: revoke it so its router key goes.
  const dir = dirOf(opts);
  const previous = pickEntry(readIndex(dir), api, account.email);
  if (previous && previous.deviceId !== account.deviceId) await revokeQuietly(previous, opts, fetchFn);

  const entry: IndexEntry = { ...account, accessExpiresAt: secrets.accessExpiresAt };
  entry.backend = writeSecrets({ ...entry, backend: previous?.backend }, secrets, opts);
  const index = readIndex(dir);
  index.accounts = [...index.accounts.filter((a) => !(a.api === api && a.email === account.email)), entry];
  index.defaults[api] = account.email;
  writeIndex(dir, index);

  for (const p of answer.problems ?? []) if (typeof p === "string") opts.print(`warning: ${p}`);
  return account;
}

/** POST /api/device/revoke with the refresh token, best-effort (§2.5): never throws, never waits
 * more than REVOKE_TIMEOUT_MS. */
async function revokeQuietly(entry: IndexEntry, o: SessionStorage, fetchFn: typeof fetch): Promise<void> {
  const secrets = readSecrets(entry, o);
  if (!secrets) return;
  try {
    await postJson(fetchFn, `${entry.api}/api/device/revoke`, { token: secrets.refreshToken }, REVOKE_TIMEOUT_MS);
  } catch {
    // Offline: the device stays listed on the Devices page until someone signs it out there.
  }
}

/** Revokes this device on the server (best-effort) and forgets the login locally. */
export async function logout(opts: { api?: string; email?: string; fetch?: typeof fetch } & SessionStorage = {}): Promise<void> {
  const { entry } = lookup(opts);
  if (!entry) return;
  await revokeQuietly(entry, opts, opts.fetch ?? fetch);
  forget(entry, opts);
}
