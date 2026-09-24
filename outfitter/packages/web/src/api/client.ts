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
  /** A failed run's own explanation (api routes/sessions.ts). Set only when runState is "failed". */
  runStateReason?: string;
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
  /** Cloud-fixes 13: messages parked because this session's runs never validated the protocol. */
  heldMail?: number;
  /** "Deploy mismatch: messages held until the service is redeployed", when heldMail > 0. */
  mailNotice?: string;
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
  /** Tape option, default off. When true, checkpoint runs a Playwright spec in the Drive. */
  playwrightBeforeCheckpoint?: boolean;
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
  /** When the token stops authenticating (90 days after creation). */
  expiresAt?: string;
}

/** POST /api/operator/tokens/revoke's body: one owner's email, or every owner under an @domain. */
export type TokenOwnerMatch = { email: string } | { domain: string };

export interface RevokeTokensResult {
  /** The match as the server normalized it (lowercased, domain with its leading "@"). */
  match: TokenOwnerMatch;
  revoked: TokenRecord[];
  owners: string[];
}

export interface ModelRow {
  id: string;
  contextWindow?: number;
  maxOutput?: number;
  inputPerM?: number;
  outputPerM?: number;
  auto: boolean;
  local?: boolean;
}

export interface GuruMeta {
  envDenylist: string[];
  thinkingLevels: string[];
}

export type GuruInput = Omit<Guru, "id" | "createdAt" | "updatedAt">;

export interface ProviderRow {
  id: string;
  kind: string;
  name: string;
  status: "up" | "degraded" | "down" | "unknown";
  detail?: string;
  checkedAt: string;
}

/** GET /api/operator/settings's per-secret row (EPIC.md Decisions table / operators.md). Never
 * carries a full value -- `masked` is the last 4 characters, and only past 12 characters. */
export interface OperatorSecretRow {
  id: string;
  secretName: string;
  label: string;
  purpose: string;
  set: boolean;
  masked?: string;
  updatedAt?: string;
  appliesAt: "next run" | "next deploy";
}

export interface OperatorSettings {
  litellmBaseUrl: string;
  sandboxProvider: string;
  cloudRunJob: string;
  tunnelDomain: string;
  operators: string[];
  secrets: OperatorSecretRow[];
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

function authedInit(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  };
}

async function errorMessage(res: Response): Promise<string> {
  let message = res.statusText;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // non-JSON error body -- fall back to statusText
  }
  return message;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, authedInit(init));
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Jpeg bytes. Same cookies and dev bearer as request(); the body is not JSON. */
async function requestBlob(path: string): Promise<Blob> {
  const res = await fetch(path, authedInit());
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return res.blob();
}

export const api = {
  me(): Promise<{ email: string; operator?: boolean; linkOrigin?: string; name?: string }> {
    return request("/api/me");
  },

  operatorSettings(): Promise<OperatorSettings> {
    return request("/api/operator/settings");
  },

  putOperatorSecret(secretName: string, value: string): Promise<OperatorSecretRow> {
    return request(`/api/operator/secrets/${encodeURIComponent(secretName)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  },

  disableOperatorSecret(secretName: string): Promise<OperatorSecretRow> {
    return request(`/api/operator/secrets/${encodeURIComponent(secretName)}`, { method: "DELETE" });
  },

  testOperatorSecret(secretName: string, value?: string): Promise<{ ok: boolean; detail?: string }> {
    return request(`/api/operator/secrets/${encodeURIComponent(secretName)}/test`, {
      method: "POST",
      body: JSON.stringify(value !== undefined ? { value } : {}),
    });
  },

  revokeTokensForOwners(match: TokenOwnerMatch): Promise<RevokeTokensResult> {
    return request("/api/operator/tokens/revoke", { method: "POST", body: JSON.stringify(match) });
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

  guruMeta(): Promise<GuruMeta> {
    return request("/api/gurus/meta");
  },

  createGuru(input: GuruInput): Promise<Guru> {
    return request("/api/gurus", { method: "POST", body: JSON.stringify(input) });
  },

  updateGuru(id: string, patch: Partial<GuruInput>): Promise<Guru> {
    return request(`/api/gurus/${id}`, { method: "PUT", body: JSON.stringify(patch) });
  },

  deleteGuru(id: string): Promise<void> {
    return request(`/api/gurus/${id}`, { method: "DELETE" });
  },

  models(): Promise<ModelRow[]> {
    return request<{ models: ModelRow[] }>("/api/models").then((body) => body.models);
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

  /** `run` is null when the session was stored but its first wake failed; it starts later on its own. */
  createSession(input: NewSessionInput): Promise<{ session: SessionDetail; run: RunLike | null }> {
    return request("/api/sessions", { method: "POST", body: JSON.stringify(input) });
  },

  /** 202 with `run: null` means the message is queued but no run could start yet; don't resend it. */
  sendMessage(id: string, text: string, behavior?: "steer" | "followUp"): Promise<{ run: RunLike | null }> {
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

  /** Cloud-fixes 13: release this session's held mail and wake once. */
  retryMail(id: string): Promise<{ released: boolean; result: string; heldMail: number }> {
    return request(`/api/sessions/${id}/mail/retry`, { method: "POST" });
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

  /** Transcript jpeg for one capture. Any authenticated caller (protocol.md). */
  browserCapture(sessionId: string, captureId: string): Promise<Blob> {
    return requestBlob(`/api/sessions/${sessionId}/browser/captures/${captureId}`);
  },
};
