/**
 * Central settings on Kernal (#397 CA-8, outfitter/docs/specs/central-auth.md §3, §2.6): what
 * Outfitter resolved for this account and profile, layered with this machine's own overrides,
 * .env and the shell. Owned by task F; the exports below are the contract /admin (CA-9), the
 * migration (CA-10) and the extensions that read settings build against.
 *
 * Start-up never waits on the network: `resolve` answers from the cache at once, and
 * `refreshConfig` fetches in the background (the fleet-settings rule). Until CA-8 lands nothing is
 * central: every value comes from the local layers or is absent.
 */

export type SettingValue = string | number | boolean;
export type OverrideRule = "none" | "opt-out" | "any";

/** Server sources (GET /api/config), then the local ones Kernal adds, lowest authority last. */
export type ConfigSource = "fleet" | "group" | "user" | "profile" | "device" | "default" | "local" | "dotenv" | "env";

export interface ConfigValue {
  value: SettingValue;
  source: ConfigSource;
  /** The profile's name for source "profile"; the env var's name for "dotenv" and "env". */
  sourceName?: string;
  override: OverrideRule;
  /** A local value can't change it (/admin shows it read-only). */
  locked: boolean;
}

export interface ResolvedConfig {
  /** Null when signed out: local layers only. */
  api: string | null;
  account: string | null;
  profile: string | null;
  schemaVersion: number;
  values: Record<string, ConfigValue>;
  /** When the central part was fetched; null when there is none. */
  fetchedAt: string | null;
  fromCache: boolean;
}

/** --profile <name> / KERNAL_PROFILE (bin/kernal turns the flag into the env var). */
export function activeProfile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.KERNAL_PROFILE?.trim() || undefined;
}

/** Sync: the cache plus local layers, for this process's profile. Resolved once per process and
 * kept (a process never switches profile); `/config reload` calls refreshConfig. */
export function resolve(_profile: string | undefined = activeProfile()): ResolvedConfig {
  return { api: null, account: null, profile: null, schemaVersion: 0, values: {}, fetchedAt: null, fromCache: false };
}

/** One value, or undefined. */
export function getValue<T extends SettingValue = SettingValue>(key: string): T | undefined {
  return resolve().values[key]?.value as T | undefined;
}

/** Fetches GET /api/config with the session's token, rewrites the cache, and returns the new
 * resolution. Undefined when signed out or offline; never throws. */
export async function refreshConfig(_opts: { profile?: string; fetch?: typeof fetch } = {}): Promise<ResolvedConfig | undefined> {
  return undefined;
}

/** This machine's own overrides (the "local" level), `~/.kernal/config.local.json`. */
export function setLocalOverride(_key: string, _value: SettingValue | undefined): void {
  throw new Error("central settings are not available yet (CA-8)");
}

/** Personal provider keys delivered at start-up (CA-4), held in memory only, never in the cache. */
export function providerKey(_provider: string): string | undefined {
  return undefined;
}
