// #389 CA-7 (docs/specs/central-auth.md §3-§4, §7-§8): account settings' API calls. Owned by task
// H; the types mirror the api's answers in the spec (api src/central/settings-schema.ts).

import { request } from "./client.ts";

export type SettingLevel = "fleet" | "group" | "user" | "profile" | "device" | "local";
export type OverrideRule = "none" | "opt-out" | "any";
export type SettingValue = string | number | boolean;

export interface SettingDecl {
  key: string;
  type: "string" | "boolean" | "number" | "enum" | "url";
  values?: string[];
  min?: number;
  max?: number;
  /** For type "number": whole numbers only. */
  integer?: boolean;
  secret: boolean;
  levels: SettingLevel[];
  override: OverrideRule;
  default?: SettingValue;
  since: number;
  retired?: boolean;
  description: string;
}

export interface ResolvedValue {
  value: SettingValue;
  source: "fleet" | "group" | "user" | "profile" | "device" | "default";
  sourceName?: string;
  override: OverrideRule;
  locked: boolean;
  localAllowed: boolean;
}

export interface ConfigResponse {
  schemaVersion: number;
  account: { email: string; userId: string };
  profile: string | null;
  profiles: string[];
  deviceId: string | null;
  values: Record<string, ResolvedValue>;
  versions: { fleet: number; user: number; profile?: number; device?: number };
  resolvedAt: string;
}

/** GET /api/config/docs/... : one level's own values, for editing. */
export interface SettingsDocView {
  id: string;
  level: "user" | "profile" | "device";
  name?: string;
  isDefault?: boolean;
  values: Record<string, SettingValue>;
  version: number;
  updatedAt?: string;
}

export interface ProviderKeyRow {
  provider: string;
  last4: string;
  setAt: string;
}

export interface UserSpend {
  month: string;
  currency: "USD";
  total: number;
  byDevice: Array<{ alias: string; deviceId?: string; deviceName?: string; kind: "device" | "run"; spend: number }>;
  byModel: Array<{ model: string; spend: number }>;
  fetchedAt: string;
}

/** A write's 409: the document changed since it was read. */
export interface StaleWrite {
  error: "stale_version";
  current: SettingsDocView | null;
}

const ifMatch = (version: number) => ({ "If-Match": `W/"${version}"` });

export const accountApi = {
  schema(): Promise<{ schemaVersion: number; settings: SettingDecl[] }> {
    return request("/api/config/schema");
  },
  config(profile?: string): Promise<ConfigResponse> {
    return request(`/api/config${profile ? `?profile=${encodeURIComponent(profile)}` : ""}`);
  },
  userDoc(): Promise<SettingsDocView> {
    return request("/api/config/user");
  },
  putUserDoc(values: Record<string, SettingValue | null>, version: number): Promise<SettingsDocView> {
    return request("/api/config/user", { method: "PUT", headers: ifMatch(version), body: JSON.stringify({ values }) });
  },
  profiles(): Promise<SettingsDocView[]> {
    return request("/api/config/profiles");
  },
  profileDoc(name: string): Promise<SettingsDocView> {
    return request(`/api/config/profiles/${encodeURIComponent(name)}`);
  },
  createProfile(name: string, copyFrom?: string): Promise<SettingsDocView> {
    return request("/api/config/profiles", { method: "POST", body: JSON.stringify({ name, ...(copyFrom ? { copyFrom } : {}) }) });
  },
  putProfileDoc(name: string, values: Record<string, SettingValue | null>, version: number): Promise<SettingsDocView> {
    return request(`/api/config/profiles/${encodeURIComponent(name)}`, { method: "PUT", headers: ifMatch(version), body: JSON.stringify({ values }) });
  },
  patchProfile(name: string, patch: { rename?: string; isDefault?: true }, version: number): Promise<SettingsDocView> {
    return request(`/api/config/profiles/${encodeURIComponent(name)}`, { method: "PATCH", headers: ifMatch(version), body: JSON.stringify(patch) });
  },
  deleteProfile(name: string, version: number): Promise<void> {
    return request(`/api/config/profiles/${encodeURIComponent(name)}`, { method: "DELETE", headers: ifMatch(version) });
  },
  deviceDoc(deviceId: string): Promise<SettingsDocView> {
    return request(`/api/config/devices/${encodeURIComponent(deviceId)}`);
  },
  putDeviceDoc(deviceId: string, values: Record<string, SettingValue | null>, version: number): Promise<SettingsDocView> {
    return request(`/api/config/devices/${encodeURIComponent(deviceId)}`, { method: "PUT", headers: ifMatch(version), body: JSON.stringify({ values }) });
  },
  providerKeys(): Promise<ProviderKeyRow[]> {
    return request("/api/me/provider-keys");
  },
  setProviderKey(provider: string, value: string): Promise<ProviderKeyRow> {
    return request(`/api/me/provider-keys/${encodeURIComponent(provider)}`, { method: "PUT", body: JSON.stringify({ value }) });
  },
  deleteProviderKey(provider: string): Promise<void> {
    return request(`/api/me/provider-keys/${encodeURIComponent(provider)}`, { method: "DELETE" });
  },
  spend(month?: string): Promise<UserSpend> {
    return request(`/api/me/spend${month ? `?month=${encodeURIComponent(month)}` : ""}`);
  },
  allSpend(month?: string): Promise<{ month: string; total: number; users: Array<{ userId: string; email?: string; total: number }> }> {
    return request(`/api/operator/spend${month ? `?month=${encodeURIComponent(month)}` : ""}`);
  },
};
