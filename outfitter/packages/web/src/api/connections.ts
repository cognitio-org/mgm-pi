// MO-5 (#487, docs/specs/mcp-connections.md §3): the Connections page's API calls. The types mirror
// the api's answers in the spec.

import { request } from "./client.ts";

export type ConnectionState = "connected" | "reconnect_required" | "not_connected";

export interface Connection {
  name: string;
  label: string;
  state: ConnectionState;
  connectedAt?: string;
  reconnectRequiredAt?: string;
  reconnectReason?: string;
}

export interface ConnectionsResponse {
  connectUrl: string;
  connections: Connection[];
}

export const connectionsApi = {
  list: () => request<ConnectionsResponse>("/api/me/connections"),
  disconnect: (name: string) => request<void>(`/api/me/connections/${encodeURIComponent(name)}`, { method: "DELETE" }),
};
