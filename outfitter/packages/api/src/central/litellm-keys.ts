// Central sign-in, CA-5 (#394, docs/specs/central-auth.md §5): per-user, per-device and per-run
// LiteLLM keys, so router spend is tracked per user. The only module that holds the router admin
// key (config.litellmKeyAdminKey, Secret Manager outfitter-litellm-admin-key). Owned by task D; the
// interface below is the contract CA-1 (through device-lifecycle.ts only), CA-6 (run keys) and
// CA-7 (spend) build against.
//
// LiteLLM's management API, as used here (https://docs.litellm.ai/docs/proxy/virtual_keys,
// /docs/proxy/users, /docs/proxy/cost_tracking):
//   GET  /user/info?user_id=        the user and its keys (`keys[].token` is the key's hashed id)
//   POST /user/new                  { user_id, user_email, auto_create_key: false }
//   POST /key/generate              { key_alias, user_id, duration, max_budget, budget_duration,
//                                     rpm_limit, models?, metadata } -> { key, token, expires }
//   POST /key/delete                { keys: [token] } or { key_aliases: [alias] }
//   GET  /team/list, POST /team/new { team_alias } -> { team_id }
//   GET  /spend/logs?start_date=&end_date=[&user_id=&summarize=false]
// Every test runs against a fake fetch; nothing here is called without OUTFITTER_LITELLM_ADMIN_KEY.
//
// A minted key's value is returned to the caller and never stored or logged. Error messages are
// what a login's `problems` line shows the device, so they never carry an upstream body that could
// echo a key (§5.3).

import type { Config } from "../config.ts";
import type { RouterKey, RouterKeysCollection } from "../store/keys.ts";
import type { Store } from "../store/types.ts";
import type { DeviceDelivery, DeviceLifecycle, LifecycleDevice } from "./device-lifecycle.ts";

/** A key LiteLLM just minted. `key` is the only copy Outfitter ever holds, in memory, on its way to
 * the device or run.spec. */
export interface MintedKey {
  key: string;
  alias: string;
  /** LiteLLM's id for the key (the `token` field of /key/generate), what /key/delete takes. */
  tokenId?: string;
  expiresAt?: string;
}

export interface KeyLimits {
  /** LiteLLM model names; absent means the defaults of §5.2. */
  models?: string[];
  maxBudget?: number;
  budgetDuration?: string;
  rpmLimit?: number;
}

export interface SpendRow {
  spend: number;
}

/** GET /api/me/spend's body (§8). */
export interface UserSpend {
  /** `YYYY-MM`, UTC. */
  month: string;
  currency: "USD";
  total: number;
  byDevice: Array<SpendRow & { alias: string; deviceId?: string; deviceName?: string; kind: "device" | "run" }>;
  byModel: Array<SpendRow & { model: string }>;
  /** When LiteLLM was read (answers are cached a few minutes). */
  fetchedAt: string;
}

export interface LitellmKeys {
  /** Creates the LiteLLM user `userId` (user_email = email) if missing. Idempotent. */
  ensureLitellmUser(user: { userId: string; email: string }): Promise<void>;
  /** /key/generate with key_alias `kernal-device-<deviceId>`, user_id, limits, and metadata
   * {outfitter: "device", deviceId, deviceName}. Records a RouterKey (store/keys.ts). Deletes the
   * device's previous key first, if any. */
  mintDeviceKey(args: { userId: string; email: string; deviceId: string; deviceName: string } & KeyLimits): Promise<MintedKey>;
  /** /key/delete by alias (or LiteLLM token id); marks the RouterKey deleted. A key LiteLLM no longer
   * has counts as deleted. On failure records deleteFailedAt and throws; the sweep retries. */
  deleteKey(ref: { alias: string } | { tokenId: string }): Promise<void>;
  /** A short-lived key for one Drive run (CA-6): key_alias `outfitter-run-<runId>`, `duration`
   * (LiteLLM's own expiry, so a missed delete still dies), user_id of the session owner. */
  mintRunKey(args: { userId: string; email: string; runId: string; sessionId: string; durationSeconds: number } & KeyLimits): Promise<MintedKey>;
  /** Creates the LiteLLM team `team_alias` if missing (CA-6's `system` team) and returns its id. */
  ensureTeam(teamAlias: string): Promise<string>;
  /** This month's spend for a user (§8), from /user/info and /spend/logs. */
  userSpend(userId: string, month: string): Promise<UserSpend>;
  /** Every user's total for the month, for operators (§8). */
  allUsersSpend(month: string): Promise<Array<{ userId: string; email?: string; total: number }>>;
}

// §5.2 / decision 5: a device key lives 90 days (Kernal re-mints before then), 50 USD per 30 days,
// 120 requests a minute. A run key gets 20 USD and LiteLLM's `duration` as the backstop.
export const DEVICE_KEY_DURATION = "90d";
export const DEVICE_KEY_MAX_BUDGET_USD = 50;
export const DEVICE_KEY_BUDGET_DURATION = "30d";
export const DEVICE_KEY_RPM_LIMIT = 120;
export const RUN_KEY_MAX_BUDGET_USD = 20;
/** §8: spend answers are cached per user and month on each instance. */
export const SPEND_CACHE_MS = 5 * 60_000;
/** One management call; a login waits on two or three of these. */
export const LITELLM_TIMEOUT_MS = 10_000;
/** §5.5: how many owed deletes one tick retries. */
export const SWEEP_BATCH = 50;

export const DEVICE_KEY_PREFIX = "kernal-device-";
export const RUN_KEY_PREFIX = "outfitter-run-";

export function deviceKeyAlias(deviceId: string): string {
  return `${DEVICE_KEY_PREFIX}${deviceId}`;
}

export function runKeyAlias(runId: string): string {
  return `${RUN_KEY_PREFIX}${runId}`;
}

/** `YYYY-MM` with a real month. */
export function isSpendMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** The current UTC month, `YYYY-MM`. */
export function currentSpendMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** /spend/logs' date range for a month: its first day up to the first day of the next. LiteLLM
 * compares startTime against midnight of end_date, so the next month's first day is what includes
 * all of the month's last day. */
export function monthRange(month: string): { start: string; end: string } {
  const [year, mon] = month.split("-").map((n) => Number.parseInt(n, 10));
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
  return { start: `${month}-01`, end: `${next}-01` };
}

/** A LiteLLM management call that failed. `message` is safe to show the device (no upstream body
 * beyond a scrubbed, shortened detail). */
export class LitellmError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LitellmError";
    this.status = status;
  }
}

/** Anything key-shaped out of an upstream detail before it reaches a message: LiteLLM's auth errors
 * quote part of the key they were given. */
function scrub(detail: string): string {
  return detail
    .replace(/\bsk-[A-Za-z0-9._\-]*/g, "sk-…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** LiteLLM's error bodies: `{ error: { message } }`, `{ detail: string | { error } }`, or text. */
function errorDetail(body: unknown): string {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  const b = body as { error?: unknown; detail?: unknown; message?: unknown };
  for (const candidate of [b.error, b.detail, b.message]) {
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object") {
      const inner = candidate as { message?: unknown; error?: unknown };
      if (typeof inner.message === "string") return inner.message;
      if (typeof inner.error === "string") return inner.error;
    }
  }
  return "";
}

/** /key/delete's ways of saying the key is already gone. */
function isKeyGone(status: number, detail: string): boolean {
  return status === 404 || /not found|does not exist|keys deleted: 0/i.test(detail);
}

function isUserExists(detail: string): boolean {
  return /already exists|unique constraint/i.test(detail);
}

function toIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Rounded the way LiteLLM shows spend, so sums of many small floats read cleanly. */
function money(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

interface LitellmKeyInfo {
  token?: string;
  key_alias?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface SpendLogRow {
  api_key?: string;
  spend?: number;
  model?: string;
  model_group?: string;
  user?: string;
  metadata?: Record<string, unknown> | null;
  /** The summarized shape (dates without summarize=false on older LiteLLMs): per-day maps. */
  models?: Record<string, number>;
  users?: Record<string, number>;
}

type Fetch = typeof fetch;

export interface LitellmKeysOptions {
  fetch?: Fetch;
  log?: (msg: string, err?: unknown) => void;
  now?: () => Date;
}

class HttpLitellmKeys implements LitellmKeys {
  private readonly root: string;
  private readonly adminKey: string;
  private readonly routerKeys: RouterKeysCollection;
  private readonly fetch: Fetch;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly now: () => Date;
  /** Users this instance has already seen in LiteLLM: a login skips the lookup. */
  private readonly knownUsers = new Set<string>();
  private readonly teams = new Map<string, string>();
  private readonly spendCache = new Map<string, { at: number; value: UserSpend }>();

  constructor(baseUrl: string, adminKey: string, routerKeys: RouterKeysCollection, opts: LitellmKeysOptions) {
    // config.litellmBaseUrl is the OpenAI-style base (…/v1); the management routes sit at the root.
    this.root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.adminKey = adminKey;
    this.routerKeys = routerKeys;
    this.fetch = opts.fetch ?? fetch;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  /** One management call. Resolves with the status and parsed body (also for an error status, so
   * callers can tell "gone" or "exists" apart); throws a LitellmError only when nothing came back. */
  private async call(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; ok: boolean; body: unknown }> {
    const url = new URL(this.root + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.adminKey}`,
          accept: "application/json",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(LITELLM_TIMEOUT_MS),
      });
    } catch (err) {
      this.log(`litellm: ${method} ${path} did not answer`, err instanceof Error ? err.message : String(err));
      throw new LitellmError("LiteLLM did not answer");
    }
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // A proxy in front of LiteLLM may answer HTML; the status still says enough.
    }
    return { status: res.status, ok: res.ok, body };
  }

  /** The call's body when it succeeded, else a LitellmError naming the route. */
  private async ok(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<unknown> {
    const res = await this.call(method, path, opts);
    if (res.ok) return res.body;
    throw this.failure(path, res.status, res.body);
  }

  private failure(path: string, status: number, body: unknown): LitellmError {
    if (status === 401 || status === 403) return new LitellmError(`LiteLLM refused the admin key on ${path} (${status})`, status);
    const detail = scrub(errorDetail(body));
    return new LitellmError(`LiteLLM ${path} answered ${status}${detail ? `: ${detail}` : ""}`, status);
  }

  async ensureLitellmUser(user: { userId: string; email: string }): Promise<void> {
    if (this.knownUsers.has(user.userId)) return;
    // /user/info for an unknown id: 404 on current LiteLLM, 200 with `user_info: null` on older ones.
    const info = await this.call("GET", "/user/info", { query: { user_id: user.userId } });
    const existing = info.ok && (info.body as { user_info?: unknown } | undefined)?.user_info;
    if (!existing) {
      const created = await this.call("POST", "/user/new", {
        body: { user_id: user.userId, user_email: user.email, auto_create_key: false },
      });
      // Another instance may have created it a moment ago.
      if (!created.ok && !isUserExists(errorDetail(created.body))) throw this.failure("/user/new", created.status, created.body);
    }
    this.knownUsers.add(user.userId);
  }

  /** /key/generate, then the RouterKey record. If the record can't be written, the fresh key is
   * deleted again: a key Outfitter doesn't know about is one nobody can revoke. */
  private async generate(body: Record<string, unknown>, record: Omit<RouterKey, "litellmTokenId" | "expiresAt" | "createdAt">, fallbackExpiry?: string): Promise<MintedKey> {
    const res = (await this.ok("POST", "/key/generate", { body })) as { key?: unknown; token?: unknown; token_id?: unknown; expires?: unknown } | undefined;
    const key = typeof res?.key === "string" ? res.key : "";
    if (!key) throw new LitellmError("LiteLLM /key/generate answered without a key");
    const tokenId = typeof res?.token === "string" ? res.token : typeof res?.token_id === "string" ? res.token_id : undefined;
    const expiresAt = toIso(res?.expires) ?? fallbackExpiry;
    try {
      await this.routerKeys.insert({
        ...record,
        ...(tokenId ? { litellmTokenId: tokenId } : {}),
        createdAt: this.now().toISOString(),
        ...(expiresAt ? { expiresAt } : {}),
      });
    } catch (err) {
      this.log(`litellm: could not record ${record.alias}; deleting the new key`, err);
      await this.call("POST", "/key/delete", { body: tokenId ? { keys: [tokenId] } : { key_aliases: [record.alias] } }).catch(() => undefined);
      throw new LitellmError("could not record the new router key");
    }
    return { key, alias: record.alias, ...(tokenId ? { tokenId } : {}), ...(expiresAt ? { expiresAt } : {}) };
  }

  async mintDeviceKey(args: { userId: string; email: string; deviceId: string; deviceName: string } & KeyLimits): Promise<MintedKey> {
    const alias = deviceKeyAlias(args.deviceId);
    // One live key per device: the old one goes first (LiteLLM keeps aliases unique, too).
    // A failed delete here is not owed to the sweep: the previous key is still the device's live
    // key and the mint is abandoned, so the device keeps using it.
    const previous = await this.routerKeys.findActiveForDevice(args.deviceId);
    if (previous) await this.removeKey({ alias: previous.alias }, false);
    const maxBudget = args.maxBudget ?? DEVICE_KEY_MAX_BUDGET_USD;
    const budgetDuration = args.budgetDuration ?? DEVICE_KEY_BUDGET_DURATION;
    return this.generate(
      {
        key_alias: alias,
        user_id: args.userId,
        duration: DEVICE_KEY_DURATION,
        max_budget: maxBudget,
        budget_duration: budgetDuration,
        rpm_limit: args.rpmLimit ?? DEVICE_KEY_RPM_LIMIT,
        ...(args.models ? { models: args.models } : {}),
        metadata: { outfitter: "device", deviceId: args.deviceId, deviceName: args.deviceName },
      },
      {
        alias,
        kind: "device",
        userId: args.userId,
        ownerEmail: args.email,
        deviceId: args.deviceId,
        ...(args.models ? { models: args.models } : {}),
        maxBudget,
        budgetDuration,
      },
    );
  }

  async mintRunKey(args: { userId: string; email: string; runId: string; sessionId: string; durationSeconds: number } & KeyLimits): Promise<MintedKey> {
    const alias = runKeyAlias(args.runId);
    const seconds = Math.max(1, Math.ceil(args.durationSeconds));
    const maxBudget = args.maxBudget ?? RUN_KEY_MAX_BUDGET_USD;
    const fallbackExpiry = new Date(this.now().getTime() + seconds * 1000).toISOString();
    return this.generate(
      {
        key_alias: alias,
        user_id: args.userId,
        duration: `${seconds}s`,
        max_budget: maxBudget,
        ...(args.budgetDuration ? { budget_duration: args.budgetDuration } : {}),
        ...(args.rpmLimit ? { rpm_limit: args.rpmLimit } : {}),
        ...(args.models ? { models: args.models } : {}),
        metadata: { outfitter: "run", runId: args.runId, sessionId: args.sessionId },
      },
      {
        alias,
        kind: "run",
        userId: args.userId,
        ownerEmail: args.email,
        runId: args.runId,
        ...(args.models ? { models: args.models } : {}),
        maxBudget,
        ...(args.budgetDuration ? { budgetDuration: args.budgetDuration } : {}),
      },
      fallbackExpiry,
    );
  }

  async deleteKey(ref: { alias: string } | { tokenId: string }): Promise<void> {
    return this.removeKey(ref, true);
  }

  /** deleteKey; with `owed` false a failure is not recorded (deleteFailedAt is what the sweep retries). */
  private async removeKey(ref: { alias: string } | { tokenId: string }, owed: boolean): Promise<void> {
    const record = "alias" in ref ? await this.routerKeys.findByAlias(ref.alias) : null;
    if (record?.deletedAt) return;
    const tokenId = "tokenId" in ref ? ref.tokenId : record?.litellmTokenId;
    const body = tokenId ? { keys: [tokenId] } : { key_aliases: [(ref as { alias: string }).alias] };
    const res = await this.call("POST", "/key/delete", { body }).catch((err: unknown) => err as LitellmError);
    const gone = !(res instanceof Error) && (res.ok || isKeyGone(res.status, errorDetail(res.body)));
    const now = this.now().toISOString();
    if (gone) {
      if (record) await this.routerKeys.update(record.alias, { deletedAt: now, deleteFailedAt: undefined });
      return;
    }
    if (record && owed) await this.routerKeys.update(record.alias, { deleteFailedAt: now });
    throw res instanceof Error ? res : this.failure("/key/delete", res.status, res.body);
  }

  async ensureTeam(teamAlias: string): Promise<string> {
    const cached = this.teams.get(teamAlias);
    if (cached) return cached;
    const list = await this.ok("GET", "/team/list");
    const teams = (Array.isArray(list) ? list : ((list as { teams?: unknown[] } | undefined)?.teams ?? [])) as Array<{ team_alias?: string; team_id?: string }>;
    let teamId = teams.find((t) => t.team_alias === teamAlias)?.team_id;
    if (!teamId) {
      const created = (await this.ok("POST", "/team/new", { body: { team_alias: teamAlias } })) as { team_id?: unknown } | undefined;
      if (typeof created?.team_id !== "string") throw new LitellmError("LiteLLM /team/new answered without a team_id");
      teamId = created.team_id;
    }
    this.teams.set(teamAlias, teamId);
    return teamId;
  }

  async userSpend(userId: string, month: string): Promise<UserSpend> {
    const cacheKey = `${userId}|${month}`;
    const cached = this.spendCache.get(cacheKey);
    if (cached && this.now().getTime() - cached.at < SPEND_CACHE_MS) return cached.value;

    const { start, end } = monthRange(month);
    const [info, logs] = await Promise.all([
      this.call("GET", "/user/info", { query: { user_id: userId } }),
      this.ok("GET", "/spend/logs", { query: { user_id: userId, start_date: start, end_date: end, summarize: "false" } }),
    ]);
    // A user LiteLLM has never seen (nobody minted for them yet) has no keys and zero spend: 404 on
    // current LiteLLM, 200 with `user_info: null` on older ones (as in ensureLitellmUser).
    const unknownUser = info.status === 404 || (info.ok && !(info.body as { user_info?: unknown } | undefined)?.user_info);
    if (!info.ok && !unknownUser) throw this.failure("/user/info", info.status, info.body);
    // The user's live keys by hashed token: an alias for a log row whose metadata lacks one, and
    // the device name from the key's metadata.
    const byToken = new Map<string, LitellmKeyInfo>();
    for (const k of (unknownUser ? [] : ((info.body as { keys?: LitellmKeyInfo[] } | undefined)?.keys ?? []))) {
      if (k?.token) byToken.set(k.token, k);
    }
    const devices = new Map<string, UserSpend["byDevice"][number]>();
    const models = new Map<string, number>();
    let total = 0;
    for (const row of (Array.isArray(logs) ? logs : []) as SpendLogRow[]) {
      const spend = num(row.spend);
      total += spend;
      if (row.models && typeof row.models === "object") {
        // Summarized day row: models only, no per-key breakdown.
        for (const [model, value] of Object.entries(row.models)) models.set(model, (models.get(model) ?? 0) + num(value));
        continue;
      }
      const model = row.model_group || row.model || "unknown";
      models.set(model, (models.get(model) ?? 0) + spend);
      const key = row.api_key ? byToken.get(row.api_key) : undefined;
      const alias = (typeof row.metadata?.user_api_key_alias === "string" && row.metadata.user_api_key_alias) || key?.key_alias || "unknown";
      const entry = devices.get(alias) ?? describeAlias(alias, key);
      entry.spend += spend;
      devices.set(alias, entry);
    }
    const value: UserSpend = {
      month,
      currency: "USD",
      total: money(total),
      byDevice: [...devices.values()].map((d) => ({ ...d, spend: money(d.spend) })).sort((a, b) => b.spend - a.spend),
      byModel: [...models.entries()].map(([model, spend]) => ({ model, spend: money(spend) })).sort((a, b) => b.spend - a.spend),
      fetchedAt: this.now().toISOString(),
    };
    this.spendCache.set(cacheKey, { at: this.now().getTime(), value });
    return value;
  }

  async allUsersSpend(month: string): Promise<Array<{ userId: string; email?: string; total: number }>> {
    const { start, end } = monthRange(month);
    const [logs, users] = await Promise.all([
      this.ok("GET", "/spend/logs", { query: { start_date: start, end_date: end } }),
      // Emails are a nicety: a failed list leaves them out.
      this.ok("GET", "/user/list", { query: { page: "1", page_size: "100" } }).catch((err: unknown) => {
        this.log("litellm: /user/list failed; operator spend without emails", err instanceof Error ? err.message : String(err));
        return undefined;
      }),
    ]);
    const totals = new Map<string, number>();
    for (const row of (Array.isArray(logs) ? logs : []) as SpendLogRow[]) {
      if (row.users && typeof row.users === "object") {
        for (const [userId, value] of Object.entries(row.users)) totals.set(userId, (totals.get(userId) ?? 0) + num(value));
      } else if (row.user) {
        totals.set(row.user, (totals.get(row.user) ?? 0) + num(row.spend));
      }
    }
    const emails = new Map<string, string>();
    const userRows = (Array.isArray(users) ? users : ((users as { users?: unknown[] } | undefined)?.users ?? [])) as Array<{ user_id?: string; user_email?: string | null }>;
    for (const u of userRows) if (u.user_id && u.user_email) emails.set(u.user_id, u.user_email);
    return [...totals.entries()]
      .filter(([userId]) => userId)
      .map(([userId, total]) => ({ userId, ...(emails.has(userId) ? { email: emails.get(userId) } : {}), total: money(total) }))
      .sort((a, b) => b.total - a.total);
  }
}

/** A byDevice row for an alias: a device key's id from its alias and its name from the key's
 * metadata; a run key is kind "run". */
function describeAlias(alias: string, key: LitellmKeyInfo | undefined): UserSpend["byDevice"][number] {
  const deviceName = typeof key?.metadata?.deviceName === "string" ? key.metadata.deviceName : undefined;
  if (alias.startsWith(RUN_KEY_PREFIX)) return { alias, kind: "run", spend: 0 };
  return {
    alias,
    kind: "device",
    ...(alias.startsWith(DEVICE_KEY_PREFIX) ? { deviceId: alias.slice(DEVICE_KEY_PREFIX.length) } : {}),
    ...(deviceName ? { deviceName } : {}),
    spend: 0,
  };
}

/** The production LiteLLM client, or undefined when OUTFITTER_LITELLM_ADMIN_KEY is unset (no
 * minting: logins carry no router key, runs keep today's shared keys). Tests pass `fetch`. */
export function createLitellmKeys(
  config: Pick<Config, "litellmBaseUrl" | "litellmKeyAdminKey">,
  store: Pick<Store, "routerKeys">,
  opts: LitellmKeysOptions = {},
): LitellmKeys | undefined {
  if (!config.litellmKeyAdminKey || !config.litellmBaseUrl) return undefined;
  return new HttpLitellmKeys(config.litellmBaseUrl, config.litellmKeyAdminKey, store.routerKeys, opts);
}

/** A device's router key, freshly minted (the user first, then the key, which replaces the old one),
 * in the shape the device receives (§1.3 `delivery.routerKey`, §5.5). */
export async function mintDeviceRouterKey(
  keys: LitellmKeys,
  device: Pick<LifecycleDevice, "id" | "userId" | "ownerEmail" | "name">,
  config: Pick<Config, "litellmBaseUrl">,
): Promise<NonNullable<DeviceDelivery["routerKey"]>> {
  await keys.ensureLitellmUser({ userId: device.userId, email: device.ownerEmail });
  const minted = await keys.mintDeviceKey({ userId: device.userId, email: device.ownerEmail, deviceId: device.id, deviceName: device.name });
  return { key: minted.key, baseUrl: config.litellmBaseUrl, alias: minted.alias, ...(minted.expiresAt ? { expiresAt: minted.expiresAt } : {}) };
}

/** Registers CA-5's device hooks: mint at login (DeviceDelivery.routerKey), delete at revoke.
 * Called once from server.ts. A no-op without `keys`. */
export function registerLitellmDeviceHooks(lifecycle: DeviceLifecycle, keys: LitellmKeys | undefined, config: Pick<Config, "litellmBaseUrl">): void {
  if (!keys) return;
  lifecycle.register({
    name: "router key",
    onLogin: async ({ device }) => ({ routerKey: await mintDeviceRouterKey(keys, device, config) }),
    // A failed delete is recorded (deleteFailedAt) and retried by the tick's sweep.
    onRevoked: async ({ device }) => keys.deleteKey({ alias: deviceKeyAlias(device.id) }),
  });
}

/** §5.5: retries the deletes still owed (failed ones, run keys past their expiry). Called from the
 * link role's /api/hooks/tick; never throws. Undefined when minting is off. */
export async function sweepRouterKeys(
  keys: LitellmKeys | undefined,
  store: Pick<Store, "routerKeys">,
  limit: number = SWEEP_BATCH,
): Promise<{ deleted: number; failed: number } | undefined> {
  if (!keys) return undefined;
  const result = { deleted: 0, failed: 0 };
  let pending: RouterKey[];
  try {
    pending = await store.routerKeys.listPendingDelete(limit);
  } catch {
    return undefined;
  }
  for (const key of pending) {
    try {
      await keys.deleteKey({ alias: key.alias });
      result.deleted++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
