// #385 / #388: GET /api/local-hosts and DELETE /api/local-hosts/:id. Types mirror
// api/src/local-hosts/contract.ts (LocalHostListResponse). No write API beyond DELETE.

import { request } from "./client.ts";

export type LocalHostStatus = "online" | "offline" | "not-sharing" | "stale" | "revoked";

export interface LocalHostModelView {
  id: string;
  /** `local/<routerPrefix>/<id>`, absent when the id can't be routed. */
  routerModel?: string;
  kind: string;
  loaded?: boolean;
  contextLength?: number;
  vision?: boolean;
  toolUse?: boolean;
  type?: string;
  /** On the tunnel's server. Only those get router entries. */
  shared: boolean;
}

export interface LocalHostView {
  id: string;
  hostName: string;
  owner: { email: string; mine: boolean };
  status: LocalHostStatus;
  shareModels: boolean;
  accessGroup: string;
  routerPrefix: string;
  kernalVersion?: string;
  platform?: string;
  lastSeenAt: string;
  tunnel: { provider: "ngrok" | "cloudflare"; managed: boolean; state: string };
  servers: Array<{ id: string; kind: string; ok: boolean }>;
  models: LocalHostModelView[];
}

export interface LocalHostListResponse {
  hosts: LocalHostView[];
}

export const localHostsApi = {
  async list(): Promise<LocalHostListResponse> {
    const body = await request<LocalHostListResponse>("/api/local-hosts");
    return { hosts: Array.isArray(body?.hosts) ? body.hosts : [] };
  },
  remove(id: string): Promise<void> {
    return request(`/api/local-hosts/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};
