// Central sign-in, CA-5 (#394, docs/specs/central-auth.md §5): per-user, per-device and per-run
// LiteLLM keys, so router spend is tracked per user. The only module that holds the router admin
// key (config.litellmKeyAdminKey, Secret Manager outfitter-litellm-admin-key). Owned by task D; the
// interface below is the contract CA-1 (through device-lifecycle.ts only), CA-6 (run keys) and
// CA-7 (spend) build against.

import type { Config } from "../config.ts";
import type { Store } from "../store/types.ts";
import type { DeviceLifecycle } from "./device-lifecycle.ts";

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

/** The production LiteLLM client, or undefined when OUTFITTER_LITELLM_ADMIN_KEY is unset (no
 * minting: logins carry no router key, runs keep today's shared keys). Tests pass `fetch`. */
export function createLitellmKeys(
  _config: Pick<Config, "litellmBaseUrl" | "litellmKeyAdminKey">,
  _store: Pick<Store, "routerKeys">,
  _opts: { fetch?: typeof fetch; log?: (msg: string, err?: unknown) => void } = {},
): LitellmKeys | undefined {
  // CA-5 implements this. Until then there is no minting anywhere.
  return undefined;
}

/** Registers CA-5's device hooks: mint at login (DeviceDelivery.routerKey), delete at revoke.
 * Called once from server.ts. A no-op without `keys`. */
export function registerLitellmDeviceHooks(_lifecycle: DeviceLifecycle, _keys: LitellmKeys | undefined, _config: Pick<Config, "litellmBaseUrl">): void {
  // CA-5 implements this.
}
