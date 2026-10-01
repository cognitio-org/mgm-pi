// Agent Engine memory (E9 §2, §3): a thin wrapper over @mongodb-js/agent-engine-sdk-memory (pinned
// exactly in package.json; preview API) in HTTP-direct mode on the memory project.
//
// The SDK's token is a fixed header per instance, so we give it no token and our client's `fetch`
// as its fetchImpl (called on every attempt): that sets Authorization from the cache and refreshes
// once on a 401, which the SDK doesn't retry. A token failure (rate-limited, refused) becomes a
// synthetic reply with the same status, so the SDK raises its typed error for that status rather
// than a "connection error", and toAgentEngineError maps it back to one kind.
//
// Routes the facade lacks but the gateway serves (verified live 2026-10-01) go through the client
// directly: soft DELETE of a memory, and retrieval/context-from-sources (per-source filters).
//
// PR3 builds the ops on this: identity binding (sha256(ownerEmail)[:16]), the own+org two-call
// reads, key namespacing and redaction live there, not here.

import { Memory, MemoryAPIError, MemoryConnectionError } from "@mongodb-js/agent-engine-sdk-memory";
import { AgentEngineClient, AgentEngineError, clipRemote, kindForStatus, type FetchFn } from "./client.ts";
import { checkId } from "./agents.ts";

const MEMORY_TYPES: ReadonlySet<string> = new Set(["semantic", "episodic", "procedural", "taxonomic"]);

/** The SDK facade, as PR3 uses it. `bind` returns a handle scoped to one identity. */
export type MemoryFacade = Pick<Memory, "bind" | "buildContext" | "recordTurn" | "saveSemantic" | "saveEpisode" | "saveProcedure" | "saveTaxonomic" | "search">;

export type MemoryType = "semantic" | "episodic" | "procedural" | "taxonomic";

export interface ContextSource {
  source: MemoryType;
  /** On `metadata.<name>`: $eq, $in, $exists, $and, $or, ... (E9 §3.1). */
  metadata_filter?: Record<string, unknown>;
  top_k?: number;
}

export interface MemoryService {
  readonly projectId: string;
  /** Unbound facade (org-visibility reads); `sdk.bind({userId, sessionId})` for everything else. */
  readonly sdk: MemoryFacade;
  bind(identity: { userId: string; sessionId?: string }): MemoryFacade;
  /** POST …/memory/retrieval/context-from-sources. Snake case, as the gateway takes it. */
  contextFromSources(body: {
    query: string;
    sources: ContextSource[];
    user_id?: string;
    session_id?: string;
    visibility?: string;
    max_tokens?: number;
    include_memories?: boolean;
  }, opts?: { signal?: AbortSignal }): Promise<unknown>;
  /** Soft DELETE …/memory/{type}/{id}?soft=true&user_id=… */
  softDelete(type: MemoryType, id: string, userId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

/** The SDK's fetchImpl: our client's fetch, with token failures turned into replies (see above). */
export function sdkFetch(client: Pick<AgentEngineClient, "fetch">): FetchFn {
  return async (url, init) => {
    try {
      return await client.fetch(url, init);
    } catch (err) {
      if (err instanceof AgentEngineError && err.status !== undefined) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (err.retryAfterMs !== undefined) headers["retry-after"] = String(Math.ceil(err.retryAfterMs / 1000));
        return new Response(JSON.stringify({ error: err.message }), { status: err.status, headers });
      }
      throw err;
    }
  };
}

export function createMemoryService(client: AgentEngineClient): MemoryService {
  const sdk = new Memory({
    baseUrl: client.baseUrl,
    projectId: client.projectId,
    // No serviceAccountToken: Authorization comes from sdkFetch. (Were AGENTIC_MEMORY_SERVICE_ACCOUNT_TOKEN
    // ever set in the api's env, the SDK's fixed header would be overwritten by ours anyway.)
    fetchImpl: sdkFetch(client),
  });
  return {
    projectId: client.projectId,
    sdk,
    bind: ({ userId, sessionId }) => sdk.bind({ userId, ...(sessionId ? { sessionId } : {}) }),
    contextFromSources: (body, opts = {}) => client.request("POST", "/memory/retrieval/context-from-sources", { body, signal: opts.signal }),
    async softDelete(type, id, userId, opts = {}) {
      // Model-chosen values reach this path in PR3: checked at runtime, not only by the type.
      if (!MEMORY_TYPES.has(type)) throw new AgentEngineError("bad_request", "unknown memory type");
      checkId("memory id", id);
      await client.request("DELETE", `/memory/${type}/${encodeURIComponent(id)}`, { query: { soft: "true", user_id: userId }, signal: opts.signal });
    },
  };
}

/** Any failure from the SDK or the client as one AgentEngineError (never throws itself). */
export function toAgentEngineError(err: unknown): AgentEngineError {
  if (err instanceof AgentEngineError) return err;
  if (err instanceof MemoryAPIError && typeof err.status === "number") {
    return new AgentEngineError(kindForStatus(err.status), `Agent Engine memory answered ${err.status}: ${clipRemote(err.message)}`, { status: err.status, cause: err });
  }
  if (err instanceof MemoryConnectionError) return new AgentEngineError("network", `Agent Engine memory unreachable: ${clipRemote(err.message)}`, { cause: err });
  if (err instanceof MemoryAPIError) return new AgentEngineError("server", `Agent Engine memory: ${clipRemote(err.message)}`, { cause: err });
  const message = err instanceof Error ? err.message : String(err);
  return new AgentEngineError("server", `Agent Engine memory: ${clipRemote(message)}`, { cause: err });
}
