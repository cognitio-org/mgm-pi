// Central settings, CA-3 (#392, docs/specs/central-auth.md §3.4): resolves fleet → group → user →
// profile → device into one value per key, each with its source. Owned by task C. CA-6 (run.spec
// settings) and routes/config.ts call resolveConfig; its signature is the contract.
//
// The override rules (§3.1), over the levels a key's declaration allows:
//   - "any": the lowest level that sets the key wins; higher values are defaults.
//   - "none": the highest level that sets it wins; locked when that is fleet or group.
//   - "opt-out": the AND of every level that sets it; locked once false.
// A level "sets" a key only with a value that still fits the declared type, so a value stored
// before a validation change is skipped instead of reaching a Kernal as the wrong type.

import type { Store } from "../store/types.ts";
import { sentryOn, type FleetSettings } from "../fleet-settings.ts";
import { settingsDocId, type SettingsDoc } from "../store/settings.ts";
import { userIdFor } from "./user-id.ts";
import {
  SETTINGS_SCHEMA,
  SETTINGS_SCHEMA_VERSION,
  coerceSettingValue,
  type CoerceOptions,
  type ConfigResponse,
  type ResolvedValue,
  type SettingDecl,
  type SettingValue,
  type ValueSource,
} from "./settings-schema.ts";

export interface ResolveRequest {
  email: string;
  /** Absent: the user's default profile, if any. */
  profile?: string;
  deviceId?: string;
  /** Dev mode only: accept stored http:// URLs. Otherwise a stored http value is skipped. */
  allowHttp?: boolean;
}

/** Thrown for a `profile` the user doesn't have (routes answer 404 unknown_profile). `profiles`
 * lists the ones they do have, for the answer. */
export class UnknownProfileError extends Error {
  readonly profiles: string[];
  constructor(message = "unknown profile", profiles: string[] = []) {
    super(message);
    this.name = "UnknownProfileError";
    this.profiles = profiles;
  }
}

/** Every group is `everyone` until groups exist (§3.1, shared with #378's access-group field). */
export const DEFAULT_GROUP = "everyone";

/** The fleet level's values: `values` plus the three Sentry keys from `telemetry.sentry`. Sentry
 * counts as set only while it is on (with a DSN), the same rule as clientFleetSettings: while it is
 * off, `enabled` falls to its default (false), the DSN is absent and the sample rate is the
 * schema's default. */
export function fleetLevelValues(fleet: FleetSettings): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = { ...(isPlainObject(fleet.values) ? fleet.values : {}) };
  const sentry = fleet.telemetry.sentry;
  if (sentryOn(sentry)) {
    values["telemetry.sentry.enabled"] = true;
    values["telemetry.sentry.dsn"] = sentry.dsn;
    values["telemetry.sentry.tracesSampleRate"] = sentry.tracesSampleRate;
  }
  return values;
}

function isPlainObject(value: unknown): value is Record<string, SettingValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored document's values, or none when the document has no usable `values` object. */
function storedValues(doc: Pick<SettingsDoc, "values">): Record<string, SettingValue> {
  return isPlainObject(doc.values) ? doc.values : {};
}

interface LevelValues {
  source: Exclude<ValueSource, "default">;
  sourceName?: string;
  values: Record<string, SettingValue>;
}

/** One key's value from the levels in authority order (fleet first), or undefined when no level
 * sets it and it has no default. */
export function resolveKey(decl: SettingDecl, levels: readonly LevelValues[], opts: CoerceOptions = {}): ResolvedValue | undefined {
  const set: Array<{ level: LevelValues; value: SettingValue }> = [];
  for (const level of levels) {
    if (!decl.levels.includes(level.source)) continue;
    if (!Object.hasOwn(level.values, decl.key)) continue;
    const value = coerceSettingValue(decl, level.values[decl.key], opts);
    if (value !== undefined) set.push({ level, value });
  }
  const localAllowed = decl.levels.includes("local");
  const answer = (value: SettingValue, from: LevelValues | undefined, locked: boolean): ResolvedValue => ({
    value,
    source: from?.source ?? "default",
    ...(from?.sourceName ? { sourceName: from.sourceName } : {}),
    override: decl.override,
    locked,
    localAllowed,
  });

  if (set.length === 0) {
    if (decl.default === undefined) return undefined;
    return answer(decl.default, undefined, decl.override === "opt-out" && decl.default === false);
  }
  switch (decl.override) {
    case "any": {
      const winner = set[set.length - 1]!;
      return answer(winner.value, winner.level, false);
    }
    case "none": {
      const winner = set[0]!;
      return answer(winner.value, winner.level, winner.level.source === "fleet" || winner.level.source === "group");
    }
    case "opt-out": {
      const off = set.find((s) => s.value === false);
      if (off) return answer(false, off.level, true);
      return answer(true, set[0]!.level, false);
    }
  }
}

export async function resolveConfig(
  store: Pick<Store, "settings">,
  fleet: FleetSettings,
  req: ResolveRequest,
  now: () => Date = () => new Date(),
): Promise<ConfigResponse> {
  const userId = userIdFor(req.email);
  const [group, user, profiles, device] = await Promise.all([
    store.settings.get(settingsDocId("group", DEFAULT_GROUP)),
    store.settings.get(settingsDocId("user", userId)),
    store.settings.listProfiles(userId),
    req.deviceId ? store.settings.get(settingsDocId("device", req.deviceId)) : Promise.resolve(null),
  ]);
  const names = profiles.map((p) => p.name!).sort();

  let profile: SettingsDoc | undefined;
  if (req.profile !== undefined) {
    profile = profiles.find((p) => p.name === req.profile);
    if (!profile) throw new UnknownProfileError(`unknown profile: ${req.profile}`, names);
  } else {
    // At most one default; while a setDefaultProfile is half done, the first by name.
    profile = profiles.find((p) => p.isDefault);
  }

  // A hand-edited or partial document may lack `values`; it then sets nothing.
  const levels: LevelValues[] = [{ source: "fleet", values: fleetLevelValues(fleet) }];
  if (group) levels.push({ source: "group", sourceName: DEFAULT_GROUP, values: storedValues(group) });
  if (user) levels.push({ source: "user", values: storedValues(user) });
  if (profile) levels.push({ source: "profile", sourceName: profile.name, values: storedValues(profile) });
  if (device) levels.push({ source: "device", values: storedValues(device) });

  const values: Record<string, ResolvedValue> = {};
  for (const decl of SETTINGS_SCHEMA) {
    if (decl.secret || decl.retired) continue;
    const resolved = resolveKey(decl, levels, { allowHttp: req.allowHttp === true });
    if (resolved) values[decl.key] = resolved;
  }

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    account: { email: req.email, userId },
    profile: profile?.name ?? null,
    profiles: names,
    deviceId: req.deviceId ?? null,
    values,
    versions: {
      fleet: fleet.version ?? 0,
      user: user?.version ?? 0,
      ...(profile ? { profile: profile.version } : {}),
      ...(req.deviceId ? { device: device?.version ?? 0 } : {}),
    },
    resolvedAt: now().toISOString(),
  };
}
