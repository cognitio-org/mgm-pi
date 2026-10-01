// Agent Engine agents (E9 §4): the agents project's hosted agents, called from a Drive through the
// `ae.*` ops. PR2 has the interface PR4 builds on, with the routes the spike captured (executions,
// runtime sessions); invoke and resume are PR4's and say so.
//
// Rules PR4 keeps (spec §4): invoke streams SSE and takes the execution id from the first frame
// that carries one; it sends X-Session-ID `outf-<session8>-<agent>` and
// X-Mdb-Agent-Engine-Custom-Outfitter-Session `<session8>` only (no email), and never the CLI's
// test-session headers. Results are untrusted text.

import { AgentEngineClient, AgentEngineError } from "./client.ts";

export interface InvokeArgs {
  workspaceId: string;
  message: string;
  /** Reused per Outfitter session and agent, so one session keeps one sandbox pair. */
  sessionId: string;
  /** Outfitter's short session id, for the custom header. */
  outfitterSession: string;
  /** Seconds to wait for the stream to finish (default 120, max 280). */
  waitSeconds?: number;
  signal?: AbortSignal;
}

export interface InvokeResult {
  status: "completed" | "running" | "suspended" | "failed";
  executionId?: string;
  response?: string;
}

export interface Execution {
  execution_id: string;
  status: string;
  /** For an execution suspended for human review. */
  suspend_context?: unknown;
  allowed_decisions?: string[];
  [key: string]: unknown;
}

export interface RuntimeSession {
  session_id: string;
  status: string;
  is_test_session?: boolean;
  last_activity_at?: string;
  scheduled_release_at?: string;
}

export interface AgentsService {
  readonly projectId: string;
  invoke(args: InvokeArgs): Promise<InvokeResult>;
  getExecution(workspaceId: string, executionId: string, opts?: { signal?: AbortSignal }): Promise<Execution>;
  resume(args: { workspaceId: string; executionId: string; decision: string; notes?: string; outfitterSession: string; signal?: AbortSignal }): Promise<Execution>;
  listRuntimeSessions(workspaceId: string, opts?: { signal?: AbortSignal }): Promise<RuntimeSession[]>;
  /** 202 means accepted; history is kept. */
  stopRuntimeSession(workspaceId: string, sessionId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Ids go into paths and queries; anything else is refused before a request is made. */
function checkId(name: string, value: string): string {
  if (!ID.test(value)) throw new AgentEngineError("bad_request", `${name} must be an Agent Engine id`);
  return value;
}

export function createAgentsService(client: AgentEngineClient): AgentsService {
  const notYet = (what: string) => Promise.reject(new AgentEngineError("not_implemented", `Agent Engine ${what} isn't built yet (E9 PR4)`));
  return {
    projectId: client.projectId,
    invoke: () => notYet("invoke"),
    resume: () => notYet("resume"),
    async getExecution(workspaceId, executionId, opts = {}) {
      return client.request<Execution>("GET", `/executions/${encodeURIComponent(checkId("executionId", executionId))}`, {
        query: { workspace_id: checkId("workspaceId", workspaceId) },
        signal: opts.signal,
      });
    },
    async listRuntimeSessions(workspaceId, opts = {}) {
      const body = await client.request<{ sessions?: RuntimeSession[] }>("GET", `/workspaces/${encodeURIComponent(checkId("workspaceId", workspaceId))}/runtime-sessions`, {
        signal: opts.signal,
      });
      return Array.isArray(body?.sessions) ? body.sessions : [];
    },
    async stopRuntimeSession(workspaceId, sessionId, opts = {}) {
      await client.request(
        "POST",
        `/workspaces/${encodeURIComponent(checkId("workspaceId", workspaceId))}/runtime-sessions/${encodeURIComponent(checkId("sessionId", sessionId))}/stop`,
        { signal: opts.signal },
      );
    },
  };
}
