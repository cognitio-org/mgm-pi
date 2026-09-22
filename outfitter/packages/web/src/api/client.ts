// Thin fetch wrapper for outfitter-api's browser REST routes (see outfitter/docs/protocol.md
// "browser <-> api (REST)"). Production auth is IAP (cookies), so every request goes out with
// credentials: "same-origin"; a bearer header is added only when a dev token is stashed in
// localStorage (see README / report for how to set it in local dev, where OUTFITTER_DEV=1
// disables the IAP check anyway but the API happily accepts either).

export interface SessionSummary {
  id: string;
  name?: string;
  status: "open" | "closed";
  runState?: string;
  guru: string;
  repo: string | null;
  branch?: string;
  parentId?: string;
  cost: number;
  updatedAt: string;
}

export interface RunLike {
  id: string;
  sessionId: string;
  state: string;
  reason?: string;
  pendingUiRequest?: unknown;
  modelFallback?: { wanted: string; used: string };
  cost?: number;
  costEstimate?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail {
  id: string;
  name?: string;
  ownerEmail?: string;
  guruId: string;
  repo: string | null;
  baseBranch?: string;
  branch?: string;
  prompt?: string;
  modelOverride?: string;
  parentId?: string;
  status: "open" | "closed";
  leafId?: string;
  cost: number;
  checkpoint?: { branch?: string; head?: string; snapshotUrl?: string; workspaceUrl?: string };
  createdAt: string;
  updatedAt: string;
}

export interface PiEntry {
  id: string;
  parentId?: string | null;
  type: string;
  [key: string]: unknown;
}

export interface Guru {
  id: string;
  name: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  model: string;
  fallbackModel?: string;
  thinking?: string;
  tools?: string[];
  excludeTools?: string[];
  packages?: string[];
  env?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface TokenRecord {
  id: string;
  ownerEmail: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface ProviderRow {
  id: string;
  kind: string;
  name: string;
  status: "up" | "degraded" | "down" | "unknown";
  detail?: string;
  checkedAt: string;
}

export interface NewSessionInput {
  guruId: string;
  repo?: string;
  baseBranch?: string;
  branch?: string;
  prompt: string;
  name?: string;
  model?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function authHeaders(): Record<string, string> {
  let token: string | null = null;
  try {
    token = localStorage.getItem("outfitterDevToken");
  } catch {
    // localStorage unavailable (private browsing, or a test environment without DOM storage) -- no bearer.
  }
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body -- fall back to statusText
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  me(): Promise<{ email: string; linkOrigin?: string }> {
    return request("/api/me");
  },

  listTokens(): Promise<TokenRecord[]> {
    return request("/api/me/tokens");
  },

  createToken(name: string): Promise<{ token: string; record: TokenRecord }> {
    return request("/api/me/tokens", { method: "POST", body: JSON.stringify({ name }) });
  },

  revokeToken(id: string): Promise<{ record: TokenRecord }> {
    return request(`/api/me/tokens/${id}`, { method: "DELETE" });
  },

  gurus(): Promise<Guru[]> {
    return request("/api/gurus");
  },

  /** Resolves to [] on a 404 -- the /api/providers endpoint is built by another workstream and may
   * not exist yet in a given deployment. */
  async providers(): Promise<ProviderRow[]> {
    try {
      const body = await request<{ providers: ProviderRow[] }>("/api/providers");
      return body.providers;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return [];
      throw err;
    }
  },

  sessions(filter: { status?: string; guru?: string; runState?: string } = {}): Promise<SessionSummary[]> {
    const params = new URLSearchParams();
    if (filter.status) params.set("status", filter.status);
    if (filter.guru) params.set("guru", filter.guru);
    // Code review M1 (docs/reports/code-review-pr15.md): the fleet filter offers run states
    // (queued/running/idle/...), which the API filters post-hoc via `runState`, distinct from
    // `status` (open/closed).
    if (filter.runState) params.set("runState", filter.runState);
    const qs = params.toString();
    return request(`/api/sessions${qs ? `?${qs}` : ""}`);
  },

  session(id: string): Promise<SessionDetail> {
    return request(`/api/sessions/${id}`);
  },

  entries(id: string, after?: string): Promise<PiEntry[]> {
    const qs = after ? `?after=${encodeURIComponent(after)}` : "";
    return request(`/api/sessions/${id}/entries${qs}`);
  },

  createSession(input: NewSessionInput): Promise<{ session: SessionDetail; run: RunLike }> {
    return request("/api/sessions", { method: "POST", body: JSON.stringify(input) });
  },

  sendMessage(id: string, text: string, behavior?: "steer" | "followUp"): Promise<{ run: RunLike }> {
    return request(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text, behavior }) });
  },

  abort(id: string): Promise<{ run: RunLike }> {
    return request(`/api/sessions/${id}/abort`, { method: "POST" });
  },

  stop(id: string): Promise<{ run: RunLike }> {
    return request(`/api/sessions/${id}/stop`, { method: "POST" });
  },

  wake(id: string): Promise<{ run: RunLike }> {
    return request(`/api/sessions/${id}/wake`, { method: "POST" });
  },

  uiResponse(id: string, requestId: string, value: unknown): Promise<{ run: RunLike }> {
    return request(`/api/sessions/${id}/ui-response`, {
      method: "POST",
      body: JSON.stringify({ id: requestId, value }),
    });
  },

  diff(id: string): Promise<{ base: string; patch: string }> {
    return request(`/api/sessions/${id}/diff`);
  },

  streamUrl(id: string): string {
    return `/api/sessions/${id}/stream`;
  },
};
