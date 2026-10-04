// #389 CA-1 web (docs/specs/central-auth.md §1.5, §6): the approve page's and the Devices page's
// API calls. Owned by task B; the types mirror the api's answers in the spec.

import { request } from "./client.ts";

/** GET /api/device/pending?code= */
export interface PendingDevice {
  userCode: string;
  deviceName: string;
  platform?: string;
  kernalVersion?: string;
  requestIp?: string;
  requestedAt: string;
  expiresAt: string;
}

/** GET /api/me/devices rows. */
export interface DeviceRow {
  id: string;
  name: string;
  kind: "laptop" | "machine";
  platform?: string;
  kernalVersion?: string;
  createdAt: string;
  lastSeenAt?: string;
  lastSeenIp?: string;
  loginIp?: string;
  routerKey: { alias: string; createdAt: string } | null;
}

export const devicesApi = {
  pending(code: string): Promise<PendingDevice> {
    return request(`/api/device/pending?code=${encodeURIComponent(code)}`);
  },
  decide(userCode: string, approve: boolean): Promise<{ status: "approved" | "denied"; deviceId?: string }> {
    return request("/api/device/approve", { method: "POST", body: JSON.stringify({ userCode, approve }) });
  },
  list(): Promise<DeviceRow[]> {
    return request("/api/me/devices");
  },
  revoke(id: string): Promise<{ id: string; revokedAt: string }> {
    return request(`/api/me/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  /** The approver's own address for §1.9's warning: `GET /api/me`'s optional `ip` (task A may add
   * it). Undefined when the api doesn't send it or the call fails; the page then skips the check. */
  async myIp(): Promise<string | undefined> {
    try {
      const me = await request<{ ip?: unknown }>("/api/me");
      return typeof me?.ip === "string" && me.ip.trim() ? me.ip.trim() : undefined;
    } catch {
      return undefined;
    }
  },
};
