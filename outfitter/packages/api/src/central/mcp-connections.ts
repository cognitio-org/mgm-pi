// MO-5 / MO-6 (#487, #488, docs/specs/mcp-connections.md): the person's OAuth grants for the router's
// gateway MCP servers. The router runs the OAuth dance and keeps the tokens; Outfitter only reads the
// state (with the admin key, on the person's behalf) and can disconnect.

import { isOperator } from "../auth.ts";
import { GCLOUD_MCP_SERVER } from "./gcloud-mcp.ts";
import type { LitellmKeys, McpUserCredential } from "./litellm-keys.ts";
import { userIdFor } from "./user-id.ts";

export interface ConnectableServer {
  /** The router's MCP server name (also the key in kernal/.pi/mcp.json). */
  name: string;
  label: string;
  /** Shown only to operators: the same rule as deviceKeyMcpServers (gcloud-mcp.ts). */
  operatorOnly: boolean;
}

/** §1. test/mcp-connections.test.ts keeps this equal to the gateway OAuth servers in kernal/.pi/mcp.json. */
export const CONNECTABLE_MCP_SERVERS: readonly ConnectableServer[] = [
  { name: "sentry", label: "Sentry", operatorOnly: false },
  { name: GCLOUD_MCP_SERVER, label: "Google Cloud", operatorOnly: true },
];

export type ConnectionState = "connected" | "reconnect_required" | "not_connected";

/** GET /api/me/connections' `connections[]` (§3). */
export interface Connection {
  name: string;
  label: string;
  state: ConnectionState;
  connectedAt?: string;
  reconnectRequiredAt?: string;
  reconnectReason?: string;
}

export const CONNECTIONS_CACHE_MS = 60_000;
/** The Drive notice never holds GET /api/sessions/:id longer than this (§5). */
export const NOTICE_BUDGET_MS = 1_500;

/** The router's own connect page (§3): the router root, not the OpenAI-style /v1 base. */
export function connectUrl(litellmBaseUrl: string): string {
  return `${litellmBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/ui/connect`;
}

export function visibleServers(email: string, operators: readonly string[]): readonly ConnectableServer[] {
  return CONNECTABLE_MCP_SERVERS.filter((s) => !s.operatorOnly || isOperator(email, operators));
}

function credentialFor(name: string, rows: readonly McpUserCredential[]): McpUserCredential | undefined {
  return rows.find((r) => r.serverName === name || r.alias === name);
}

function toConnection(server: ConnectableServer, row: McpUserCredential | undefined): Connection {
  if (!row) return { name: server.name, label: server.label, state: "not_connected" };
  return {
    name: server.name,
    label: server.label,
    state: row.reconnectRequired ? "reconnect_required" : "connected",
    ...(row.connectedAt ? { connectedAt: row.connectedAt } : {}),
    ...(row.reconnectRequiredAt ? { reconnectRequiredAt: row.reconnectRequiredAt } : {}),
    ...(row.reconnectReason ? { reconnectReason: row.reconnectReason } : {}),
  };
}

export class McpConnections {
  private readonly cache = new Map<string, { at: number; rows: McpUserCredential[] } | { at: number; error: unknown }>();
  private readonly keys: LitellmKeys;
  private readonly operators: readonly string[];
  private readonly now: () => number;

  constructor(keys: LitellmKeys, operators: readonly string[], now: () => number = Date.now) {
    this.keys = keys;
    this.operators = operators;
    this.now = now;
  }

  /** A failure is cached too, so a router that is down costs one timeout a minute per person, not one
   * per session page load. `fresh` (the Connections page) always asks the router. */
  private async rows(email: string, fresh: boolean): Promise<McpUserCredential[]> {
    const userId = userIdFor(email);
    const cached = this.cache.get(userId);
    if (!fresh && cached && this.now() - cached.at < CONNECTIONS_CACHE_MS) {
      if ("error" in cached) throw cached.error;
      return cached.rows;
    }
    try {
      const rows = await this.keys.mcpUserCredentials(userId);
      this.cache.set(userId, { at: this.now(), rows });
      return rows;
    } catch (error) {
      this.cache.set(userId, { at: this.now(), error });
      throw error;
    }
  }

  /** The servers this person may use, with their grant state. Throws when the router fails. */
  async list(email: string, opts: { fresh?: boolean } = {}): Promise<Connection[]> {
    const rows = await this.rows(email, opts.fresh === true);
    return visibleServers(email, this.operators).map((server) => toConnection(server, credentialFor(server.name, rows)));
  }

  /** MO-6: the Drive notice, or undefined when everything used is connected, the router fails, or it
   * doesn't answer within `budgetMs` (the lookup keeps going and fills the cache for the next load). */
  async noticeFor(email: string, used: readonly string[], budgetMs = NOTICE_BUDGET_MS): Promise<ReturnType<typeof connectionNotice>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), budgetMs);
    });
    const lookup = this.list(email).then((connections) => connectionNotice(connections, used), () => undefined);
    try {
      return await Promise.race([lookup, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Disconnects one server by name. "unknown" for a name this person can't see. */
  async disconnect(email: string, name: string): Promise<"done" | "unknown"> {
    if (!visibleServers(email, this.operators).some((s) => s.name === name)) return "unknown";
    const userId = userIdFor(email);
    this.cache.delete(userId);
    const row = credentialFor(name, await this.keys.mcpUserCredentials(userId));
    if (row) await this.keys.deleteMcpUserCredential(userId, row.serverId);
    this.cache.delete(userId);
    return "done";
  }
}

/** MO-6 (§5): one line for a Drive whose servers aren't all connected, or undefined. */
export function connectionNotice(connections: readonly Connection[], used: readonly string[]): { text: string; href: "/connections" } | undefined {
  const broken = connections.filter((c) => used.includes(c.name) && c.state !== "connected");
  if (broken.length === 0) return undefined;
  const names = joinNames(broken.map((c) => c.label));
  const plural = broken.length > 1;
  const text = broken.every((c) => c.state === "reconnect_required")
    ? `${names} ${plural ? "need" : "needs"} reconnecting: reconnect ${plural ? "them" : "it"} in Connections.`
    : `${names} ${plural ? "aren't" : "isn't"} connected: connect ${plural ? "them" : "it"} in Connections.`;
  return { text, href: "/connections" };
}

function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
