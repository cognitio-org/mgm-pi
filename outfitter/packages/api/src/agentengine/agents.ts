// Agent Engine agents (E9 §4): the agents project's hosted agents, called from a Drive through the
// `ae.*` ops (admin/ae-ops.ts).
//
// - invoke streams: POST …/workspaces/{w}/invokeStream answers SSE `data: {chunk_type, content,
//   metadata, execution_id}` frames until `done` or `error`. The execution id comes from the first
//   frame that carries one (it is only there "when available", so not always on frame 1). After
//   `wait` seconds (default 120, max 280) we close our side and report the execution as running; it
//   keeps going on Agent Engine, and `getExecution` reads it later. A stream that ends without
//   `done`, or stops waiting, is checked once with getExecution, so a suspended execution says so.
// - Headers: X-Session-ID `outf-<session8>-<agent>` (plus `session_id` in the body, as the CLI
//   sends it), so one Outfitter session reuses one Agent Engine session and its sandbox pair; and
//   X-Mdb-Agent-Engine-Custom-Outfitter-Session `<session8>` only, never an email. Never the CLI's
//   X-Agent-Engine-Test-Session/X-Agentic-Test-Session, which mark a session as a test.
// - resume answers a review pause: the decision must be one of the execution's allowed_decisions
//   (compared without case, as Agent Engine does, and sent as Agent Engine spelled it). The body is
//   `{decision, reviewer_notes}`, and the custom header is sent again (Agent Engine keeps none).
//
// Everything that comes back is the remote agent's text: callers clip and label it.

import { createHash } from "node:crypto";
import { AgentEngineClient, AgentEngineError, clipRemote, kindForStatus } from "./client.ts";

/** Seconds invoke waits for the stream by default, and at most (the Drive socket's 11-minute write
 * timeout leaves room above this). */
export const INVOKE_WAIT_DEFAULT_S = 120;
export const INVOKE_WAIT_MAX_S = 280;
/** How much of the agent's streamed text we keep (callers clip further). */
const MAX_RESPONSE_CHARS = 64 * 1024;
/** How much of the stream we read before giving up on it. */
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
/** The status check after a stream that didn't say how it ended. */
const STATUS_CHECK_TIMEOUT_MS = 10_000;

/** The custom header Agent Engine forwards to the agent as `outfitter-session`. */
export const OUTFITTER_SESSION_HEADER = "X-Mdb-Agent-Engine-Custom-Outfitter-Session";
/** The CLI's test-session markers: never sent (spec §4). */
export const TEST_SESSION_HEADERS = ["X-Agent-Engine-Test-Session", "X-Agentic-Test-Session"] as const;

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
  /** The agent's text so far (text chunks), or the error frame's message. Remote text. */
  response?: string;
  /** The Agent Engine session id the gateway answered with (X-Session-ID). */
  sessionId?: string;
  /** The execution as getExecution read it, when the stream didn't say how it ended. */
  execution?: Execution;
  /** The text was cut at MAX_RESPONSE_CHARS. */
  truncated?: boolean;
}

export interface Execution {
  execution_id: string;
  status: string;
  /** For an execution suspended for human review. */
  suspend_reason?: unknown;
  suspend_context?: unknown;
  allowed_decisions?: string[];
  response?: unknown;
  [key: string]: unknown;
}

export interface RuntimeSession {
  session_id: string;
  status: string;
  is_test_session?: boolean;
  last_activity_at?: string;
  scheduled_release_at?: string;
}

export interface ResumeArgs {
  workspaceId: string;
  executionId: string;
  decision: string;
  notes?: string;
  outfitterSession: string;
  /** pauseFingerprint of the pause the person approved; resume refuses if it changed since. */
  fingerprint?: string;
  signal?: AbortSignal;
}

export const MAX_DECISION_CHARS = 100;

/** Identifies one review pause: its status, reason, context and decisions. */
export function pauseFingerprint(execution: Pick<Execution, "status" | "suspend_reason" | "suspend_context" | "allowed_decisions">): string {
  const canon = JSON.stringify([execution.status ?? null, execution.suspend_reason ?? null, execution.suspend_context ?? null, execution.allowed_decisions ?? null]);
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

export interface AgentsService {
  readonly projectId: string;
  invoke(args: InvokeArgs): Promise<InvokeResult>;
  getExecution(workspaceId: string, executionId: string, opts?: { signal?: AbortSignal }): Promise<Execution>;
  /** Checks the execution is suspended and the decision allowed, then resumes it. Resolves to the
   * resume reply (or the execution marked resuming, when the reply was empty). */
  resume(args: ResumeArgs): Promise<Execution>;
  listRuntimeSessions(workspaceId: string, opts?: { signal?: AbortSignal }): Promise<RuntimeSession[]>;
  /** 202 means accepted; history is kept. */
  stopRuntimeSession(workspaceId: string, sessionId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

/** Starts with a letter or digit, so `.` and `..` (which URL parsing would resolve away, moving the
 * request to another route) can never be one. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Agent Engine's session id rule: 1-128 letters, digits, `_` and `-`. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A custom header value of ours: a short token, nothing that could end the header. */
const HEADER_VALUE = /^[A-Za-z0-9_-]{1,64}$/;

export function isAgentEngineId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

/** Ids go into paths and queries; anything else is refused before a request is made. */
export function checkId(name: string, value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new AgentEngineError("bad_request", `${name} must be an Agent Engine id`);
  return value;
}

function checkSessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID.test(value)) throw new AgentEngineError("bad_request", "sessionId must be 1-128 letters, digits, _ or -");
  return value;
}

function checkHeader(name: string, value: unknown): string {
  if (typeof value !== "string" || !HEADER_VALUE.test(value)) throw new AgentEngineError("bad_request", `${name} must be a short id`);
  return value;
}

/** The decisions an execution allows: top-level `allowed_decisions`, or inside `suspend_context`
 * (where the human-in-the-loop docs put it). Strings only. */
export function allowedDecisions(execution: Pick<Execution, "allowed_decisions" | "suspend_context">): string[] {
  const ctx = execution.suspend_context as { allowed_decisions?: unknown } | null | undefined;
  const raw: unknown[] = Array.isArray(execution.allowed_decisions)
    ? execution.allowed_decisions
    : ctx && typeof ctx === "object" && Array.isArray(ctx.allowed_decisions)
      ? ctx.allowed_decisions
      : [];
  return raw.filter((d): d is string => typeof d === "string" && d.length > 0 && d.length <= 100);
}

/** How long invoke waits: the default when unset, at least 0.05 s, at most INVOKE_WAIT_MAX_S. */
export function waitSecondsOf(wait: unknown): number {
  const wanted = typeof wait === "number" && Number.isFinite(wait) ? wait : INVOKE_WAIT_DEFAULT_S;
  return Math.min(Math.max(wanted, 0.05), INVOKE_WAIT_MAX_S);
}

/** Agent Engine's execution status as ours. */
export function invokeStatus(status: unknown): InvokeResult["status"] {
  const s = typeof status === "string" ? status.toLowerCase() : "";
  if (s === "completed") return "completed";
  if (s === "suspended") return "suspended";
  if (s === "error" || s === "failed" || s === "cancelled" || s === "canceled") return "failed";
  return "running";
}

export interface StreamFrame {
  chunk_type?: unknown;
  content?: unknown;
  metadata?: unknown;
  execution_id?: unknown;
}

/**
 * Splits an SSE byte stream into the JSON objects of its `data:` events. Lines may end in \n, \r\n
 * or \r; an event's `data:` lines join with \n; comments and other fields are skipped, and so is an
 * event whose data isn't a JSON object. Throws past `maxBytes`.
 */
export async function* sseFrames(body: ReadableStream<Uint8Array>, opts: { maxBytes?: number } = {}): AsyncGenerator<StreamFrame> {
  const decoder = new TextDecoder();
  const maxBytes = opts.maxBytes ?? MAX_STREAM_BYTES;
  let buf = "";
  let data: string[] = [];
  let bytes = 0;
  const flush = (): StreamFrame | undefined => {
    if (!data.length) return undefined;
    const text = data.join("\n");
    data = [];
    try {
      const v = JSON.parse(text) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as StreamFrame) : undefined;
    } catch {
      return undefined;
    }
  };
  const line = (l: string): StreamFrame | undefined => {
    if (l === "") return flush();
    if (l.startsWith(":")) return undefined;
    const colon = l.indexOf(":");
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? "" : l.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    return undefined;
  };
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new AgentEngineError("server", "Agent Engine agents: the stream was too large to read");
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const m = /\r\n|\r|\n/.exec(buf);
        if (!m) break;
        // A lone \r at the very end may be the first half of \r\n: wait for the next chunk.
        if (m[0] === "\r" && m.index === buf.length - 1) break;
        const l = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const frame = line(l);
        if (frame) yield frame;
      }
    }
    buf += decoder.decode();
    if (buf) {
      const frame = line(buf.replace(/\r$/, ""));
      if (frame) yield frame;
    }
    const last = flush();
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

/** FastAPI's `detail`, or `error`/`message`, else the raw text. */
function errorDetail(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    for (const key of ["detail", "error", "message"]) if (typeof j?.[key] === "string") return j[key] as string;
  } catch {
    // not JSON
  }
  return text;
}

export function createAgentsService(client: AgentEngineClient): AgentsService {
  const customHeaders = (outfitterSession: string) => ({ [OUTFITTER_SESSION_HEADER]: checkHeader("outfitterSession", outfitterSession) });

  const getExecution: AgentsService["getExecution"] = async (workspaceId, executionId, opts = {}) =>
    client.request<Execution>("GET", `/executions/${encodeURIComponent(checkId("executionId", executionId))}`, {
      query: { workspace_id: checkId("workspaceId", workspaceId) },
      signal: opts.signal,
    });

  return {
    projectId: client.projectId,
    getExecution,

    async invoke(args) {
      const workspaceId = checkId("workspaceId", args.workspaceId);
      const sessionId = checkSessionId(args.sessionId);
      if (typeof args.message !== "string" || !args.message.trim()) throw new AgentEngineError("bad_request", "message is required");
      const waitS = waitSecondsOf(args.waitSeconds);
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "X-Session-ID": sessionId,
        ...customHeaders(args.outfitterSession),
      };
      const waited = new AbortController();
      const timer = setTimeout(() => waited.abort(new DOMException("wait over", "TimeoutError")), waitS * 1000);
      const signal = args.signal ? AbortSignal.any([args.signal, waited.signal]) : waited.signal;
      const path = `/workspaces/${encodeURIComponent(workspaceId)}/invokeStream`;
      const cancelled = () => new AgentEngineError("timeout", "Agent Engine agents: invoke was cancelled");

      let executionId: string | undefined;
      let response = "";
      let truncated = false;
      let ended: "done" | "error" | "eof" | "wait" = "eof";
      let answeredSession: string | undefined;
      try {
        let res: Response;
        try {
          res = await client.fetch(client.projectUrl(path), {
            method: "POST",
            headers,
            body: JSON.stringify({ message: args.message, session_id: sessionId }),
            signal,
          });
        } catch (err) {
          if (err instanceof AgentEngineError) throw err;
          if (args.signal?.aborted) throw cancelled();
          if (waited.signal.aborted) throw new AgentEngineError("timeout", `Agent Engine agents: no reply to invoke in ${waitS}s`);
          throw new AgentEngineError("network", `Agent Engine agents: invoke failed: ${clipRemote(err instanceof Error ? err.message : String(err))}`);
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new AgentEngineError(kindForStatus(res.status), `Agent Engine agents: invoke answered ${res.status}${text ? `: ${clipRemote(errorDetail(text))}` : ""}`, {
            status: res.status,
          });
        }
        const sid = res.headers.get("x-session-id");
        if (sid && SESSION_ID.test(sid)) answeredSession = sid;
        if (!res.body) throw new AgentEngineError("server", "Agent Engine agents: invoke answered without a stream");
        try {
          for await (const frame of sseFrames(res.body)) {
            if (executionId === undefined && typeof frame.execution_id === "string" && ID.test(frame.execution_id)) executionId = frame.execution_id;
            const type = typeof frame.chunk_type === "string" ? frame.chunk_type : "";
            if (type === "text") {
              if (response.length >= MAX_RESPONSE_CHARS) truncated = true;
              else {
                response += textOf(frame.content);
                if (response.length > MAX_RESPONSE_CHARS) {
                  response = response.slice(0, MAX_RESPONSE_CHARS);
                  truncated = true;
                }
              }
            } else if (type === "done") {
              ended = "done";
              break;
            } else if (type === "error") {
              ended = "error";
              response = textOf(frame.content) || textOf(frame.metadata) || "the agent's run failed";
              break;
            }
          }
        } catch (err) {
          if (args.signal?.aborted) throw cancelled();
          if (waited.signal.aborted) ended = "wait";
          // Once we know the execution, a broken or oversized stream still leaves it running on
          // Agent Engine: report it (the status check below) so get and resume can reach it.
          else if (!executionId) {
            if (err instanceof AgentEngineError) throw err;
            throw new AgentEngineError("network", `Agent Engine agents: the stream broke: ${clipRemote(err instanceof Error ? err.message : String(err))}`);
          }
        }
      } finally {
        clearTimeout(timer);
        // Closes our side only; the execution goes on (that's what `running` means).
        waited.abort();
      }

      const base: InvokeResult = {
        status: ended === "done" ? "completed" : ended === "error" ? "failed" : "running",
        ...(executionId ? { executionId } : {}),
        ...(response ? { response } : {}),
        ...(answeredSession ? { sessionId: answeredSession } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
      // The stream didn't say how it ended (or we stopped waiting): ask once, so a review pause
      // shows as suspended. Best effort; the stream's own answer stands if this fails.
      if ((ended === "eof" || ended === "wait") && executionId && !args.signal?.aborted) {
        try {
          const execution = await getExecution(workspaceId, executionId, { signal: AbortSignal.timeout(STATUS_CHECK_TIMEOUT_MS) });
          return { ...base, status: invokeStatus(execution.status), execution };
        } catch {
          return base;
        }
      }
      return base;
    },

    async resume(args) {
      const workspaceId = checkId("workspaceId", args.workspaceId);
      const executionId = checkId("executionId", args.executionId);
      const headers = customHeaders(args.outfitterSession);
      if (typeof args.decision !== "string" || !args.decision.trim()) throw new AgentEngineError("bad_request", "decision is required");
      if (args.decision.trim().length > MAX_DECISION_CHARS) throw new AgentEngineError("bad_request", `decision is over ${MAX_DECISION_CHARS} characters`);
      const execution = await getExecution(workspaceId, executionId, { signal: args.signal });
      // The pause the owner approved must still be the one waiting (it may have resumed elsewhere
      // and paused again at another step).
      if (args.fingerprint !== undefined && pauseFingerprint(execution) !== args.fingerprint) {
        throw new AgentEngineError("bad_request", `execution ${executionId} changed since the approval card was shown; ask again`);
      }
      if (invokeStatus(execution.status) !== "suspended") {
        throw new AgentEngineError("bad_request", `execution ${executionId} is not suspended for review (check it with get)`);
      }
      const allowed = allowedDecisions(execution);
      const wanted = args.decision.trim().toLowerCase();
      const decision = allowed.length ? allowed.find((d) => d.toLowerCase() === wanted) : args.decision.trim();
      if (!decision) throw new AgentEngineError("bad_request", "decision is not one of the pause's allowed decisions (they are listed by get)");
      const notes = typeof args.notes === "string" && args.notes.trim() ? args.notes.trim().slice(0, 4000) : undefined;
      const reply = await client.request<Execution | undefined>("POST", `/executions/${encodeURIComponent(executionId)}/resume`, {
        query: { workspace_id: workspaceId },
        body: { decision, ...(notes ? { reviewer_notes: notes } : {}) },
        headers,
        signal: args.signal,
      });
      return reply && typeof reply === "object" ? { ...reply, execution_id: typeof reply.execution_id === "string" ? reply.execution_id : executionId } : { ...execution, status: "resuming" };
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
