// Central settings, CA-3 (#392, docs/specs/central-auth.md §3.4): resolves fleet → group → user →
// profile → device into one value per key, each with its source. Owned by task C. CA-6 (run.spec
// settings) and routes/config.ts call resolveConfig; its signature is the contract.
//
// Until CA-3 lands this resolves schema defaults only, so callers can be built against it now.

import type { Store } from "../store/types.ts";
import type { FleetSettings } from "../fleet-settings.ts";
import { userIdFor } from "./user-id.ts";
import { SETTINGS_SCHEMA, SETTINGS_SCHEMA_VERSION, type ConfigResponse, type ResolvedValue } from "./settings-schema.ts";

export interface ResolveRequest {
  email: string;
  /** Absent: the user's default profile, if any. */
  profile?: string;
  deviceId?: string;
}

/** Thrown for a `profile` the user doesn't have (routes answer 404 unknown_profile). */
export class UnknownProfileError extends Error {}

export async function resolveConfig(
  _store: Pick<Store, "settings">,
  _fleet: FleetSettings,
  req: ResolveRequest,
  now: () => Date = () => new Date(),
): Promise<ConfigResponse> {
  const values: Record<string, ResolvedValue> = {};
  for (const decl of SETTINGS_SCHEMA) {
    if (decl.secret || decl.retired || decl.default === undefined) continue;
    values[decl.key] = {
      value: decl.default,
      source: "default",
      override: decl.override,
      locked: false,
      localAllowed: decl.levels.includes("local"),
    };
  }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    account: { email: req.email, userId: userIdFor(req.email) },
    profile: null,
    profiles: [],
    deviceId: req.deviceId ?? null,
    values,
    versions: { fleet: 0, user: 0 },
    resolvedAt: now().toISOString(),
  };
}
