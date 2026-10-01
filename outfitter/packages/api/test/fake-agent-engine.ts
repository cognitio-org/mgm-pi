// A fake Agent Engine for tests (E9; under test/, so it never ships): a `fetch` that answers the
// routes Outfitter uses, with no network. It checks credentials and tokens the way the real gateway does, so the
// client's refresh, 429 and 401 paths can be driven from a test, and it records every request
// (Authorization included) for asserts.
//
//   const fake = new FakeAgentEngine();
//   const ae = createAgentEngine(fake.config(), { fetch: fake.fetch });
//
// Routes: POST /api/v1/oauth/token; under /api/v1/projects/{p}/: memory/turns, memory/context,
// memory/semantic (POST, DELETE /{id}), memory/retrieval/context-from-sources,
// executions/{id}, workspaces/{w}/runtime-sessions (GET, POST /{id}/stop). Anything else is 404.

import { randomUUID } from "node:crypto";
import type { AgentEngineConfig, AgentEngineProjectConfig } from "../src/config.ts";
import type { FetchFn } from "../src/agentengine/client.ts";

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization?: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface FakeSemantic {
  id: string;
  label: string;
  text: string;
  userId?: string;
  visibility?: string;
  metadata?: Record<string, unknown>;
  deleted?: boolean;
}

interface Issued {
  projectClient: string;
  expiresAt: number;
}

export interface FakeAgentEngineOptions {
  baseUrl?: string;
  /** Seconds in each token's `expires_in`. Default 3600. */
  tokenLifetimeSec?: number;
  now?: () => number;
}

export const FAKE_PROJECTS = {
  memory: { projectId: "fake-memory-project", clientId: "ae_sa_id_memory", clientSecret: "ae_sa_sk_memory" },
  agents: { projectId: "fake-agents-project", clientId: "ae_sa_id_agents", clientSecret: "ae_sa_sk_agents" },
} as const satisfies Record<string, AgentEngineProjectConfig>;

export class FakeAgentEngine {
  readonly baseUrl: string;
  tokenLifetimeSec: number;
  private readonly now: () => number;
  readonly requests: FakeRequest[] = [];
  /** Replies the token endpoint gives before issuing tokens again, e.g. `[{status: 429, retryAfter: 2}]`. */
  readonly tokenFailures: Array<{ status: number; retryAfter?: number }> = [];
  /** Delay before each token reply, to make concurrent refreshes overlap. */
  tokenDelayMs = 0;
  readonly semantic: FakeSemantic[] = [];
  readonly turns: Array<Record<string, unknown>> = [];
  readonly executions = new Map<string, Record<string, unknown>>();
  readonly runtimeSessions = new Map<string, Array<{ session_id: string; status: string }>>();
  private readonly tokens = new Map<string, Issued>();
  private readonly projects: Record<string, AgentEngineProjectConfig>;

  constructor(opts: FakeAgentEngineOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://agentengine.fake").replace(/\/+$/, "");
    this.tokenLifetimeSec = opts.tokenLifetimeSec ?? 3600;
    this.now = opts.now ?? Date.now;
    this.projects = { [FAKE_PROJECTS.memory.clientId]: FAKE_PROJECTS.memory, [FAKE_PROJECTS.agents.clientId]: FAKE_PROJECTS.agents };
    this.fetch = this.fetch.bind(this);
  }

  /** An AgentEngineConfig with both parts pointing at this fake. */
  config(parts: Array<"memory" | "agents"> = ["memory", "agents"]): AgentEngineConfig {
    return {
      baseUrl: this.baseUrl,
      ...(parts.includes("memory") ? { memory: { ...FAKE_PROJECTS.memory } } : {}),
      ...(parts.includes("agents") ? { agents: { ...FAKE_PROJECTS.agents } } : {}),
    };
  }

  /** Every token issued so far stops working (401), as after a rotation. */
  revokeTokens(): void {
    this.tokens.clear();
  }

  tokenRequests(): number {
    return this.requests.filter((r) => r.path === "/api/v1/oauth/token").length;
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    if (`${u.protocol}//${u.host}` !== new URL(this.baseUrl).origin) throw new TypeError(`fetch failed: unknown host ${u.host}`);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const raw = typeof init.body === "string" ? init.body : undefined;
    let body: unknown = raw;
    if (raw && headers["content-type"]?.includes("json")) body = JSON.parse(raw);
    const req: FakeRequest = {
      method: (init.method ?? "GET").toUpperCase(),
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      authorization: headers.authorization,
      headers,
      body,
    };
    this.requests.push(req);
    if (req.path === "/api/v1/oauth/token") return this.token(req, raw);
    const m = /^\/api\/v1\/projects\/([^/]+)(\/.*)$/.exec(req.path);
    if (!m) return json(404, { detail: "not found" });
    const projectId = decodeURIComponent(m[1]);
    const bearer = /^Bearer (.+)$/.exec(req.authorization ?? "")?.[1];
    const issued = bearer ? this.tokens.get(bearer) : undefined;
    if (!issued || issued.expiresAt <= this.now()) return json(401, { detail: "invalid or expired token" });
    // A service account acts only on its own project.
    if (this.projects[issued.projectClient]?.projectId !== projectId) return json(403, { detail: "forbidden" });
    return this.route(req, m[2]);
  }

  private async token(req: FakeRequest, raw: string | undefined): Promise<Response> {
    if (this.tokenDelayMs) await new Promise((r) => setTimeout(r, this.tokenDelayMs));
    const failure = this.tokenFailures.shift();
    if (failure) {
      return json(failure.status, { detail: "token request refused" }, failure.retryAfter !== undefined ? { "retry-after": String(failure.retryAfter) } : {});
    }
    if (req.method !== "POST" || new URLSearchParams(raw ?? "").get("grant_type") !== "client_credentials") return json(400, { detail: "unsupported grant" });
    const basic = /^Basic (.+)$/.exec(req.authorization ?? "")?.[1];
    const [id, secret] = basic ? Buffer.from(basic, "base64").toString("utf8").split(":") : [];
    const project = id ? this.projects[id] : undefined;
    if (!project || project.clientSecret !== secret) return json(401, { detail: "invalid client" });
    const accessToken = `fake_at_${randomUUID()}`;
    this.tokens.set(accessToken, { projectClient: id, expiresAt: this.now() + this.tokenLifetimeSec * 1000 });
    return json(200, { access_token: accessToken, token_type: "Bearer", expires_in: this.tokenLifetimeSec });
  }

  private route(req: FakeRequest, rest: string): Response {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (req.method === "POST" && rest === "/memory/turns") {
      this.turns.push(b);
      return json(200, { id: randomUUID(), session_id: String(b.session_id ?? ""), turn_seq: this.turns.length, acknowledged: true, has_embedding: false });
    }
    if (req.method === "POST" && rest === "/memory/semantic") {
      const label = String(b.label ?? "");
      const existing = this.semantic.find((s) => s.label === label && !s.deleted);
      const item: FakeSemantic = existing ?? { id: randomUUID(), label, text: "" };
      Object.assign(item, { text: String(b.text ?? b.content ?? ""), userId: b.user_id as string | undefined, visibility: b.visibility as string | undefined, metadata: b.metadata as Record<string, unknown> | undefined });
      if (!existing) this.semantic.push(item);
      return json(200, { id: item.id, label: item.label, has_embedding: false, acknowledged: true });
    }
    const del = /^\/memory\/semantic\/([^/]+)$/.exec(rest);
    if (req.method === "DELETE" && del) {
      const item = this.semantic.find((s) => s.id === decodeURIComponent(del[1]) && s.userId === req.query.user_id);
      if (!item) return json(404, { detail: "not found" });
      item.deleted = true;
      return json(200, { deleted: true, soft: req.query.soft === "true" });
    }
    if (req.method === "POST" && rest === "/memory/context") {
      const hits = this.visible(b.user_id as string | undefined, b.visibility as string | undefined);
      return json(200, { formatted_context: hits.map((s) => `- ${s.text}`).join("\n"), metadata: { token_count: 0, memory_counts: { semantic: hits.length }, timing: {} } });
    }
    if (req.method === "POST" && rest === "/memory/retrieval/context-from-sources") {
      const hits = this.visible(b.user_id as string | undefined, b.visibility as string | undefined);
      return json(200, { formatted_context: hits.map((s) => `- ${s.text}`).join("\n"), memories: hits.map((s) => ({ id: s.id, content: s.text, source: "semantic" })) });
    }
    const exec = /^\/executions\/([^/]+)$/.exec(rest);
    if (req.method === "GET" && exec) {
      const found = this.executions.get(decodeURIComponent(exec[1]));
      return found ? json(200, found) : json(404, { detail: "execution not found" });
    }
    const sessions = /^\/workspaces\/([^/]+)\/runtime-sessions$/.exec(rest);
    if (req.method === "GET" && sessions) return json(200, { sessions: this.runtimeSessions.get(decodeURIComponent(sessions[1])) ?? [] });
    const stop = /^\/workspaces\/([^/]+)\/runtime-sessions\/([^/]+)\/stop$/.exec(rest);
    if (req.method === "POST" && stop) {
      const list = this.runtimeSessions.get(decodeURIComponent(stop[1])) ?? [];
      const s = list.find((x) => x.session_id === decodeURIComponent(stop[2]));
      if (!s) return json(404, { detail: "session not found" });
      s.status = "stopping";
      return new Response(null, { status: 202 });
    }
    return json(404, { detail: `no route ${req.method} ${rest}` });
  }

  /** Reads AND userId with visibility, as the real service does (E9 §3.2). */
  private visible(userId: string | undefined, visibility: string | undefined): FakeSemantic[] {
    return this.semantic.filter((s) => !s.deleted && (userId === undefined || userId === null || s.userId === userId) && (!visibility || s.visibility === visibility));
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
