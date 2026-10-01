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
  /** #207: set while the floppy is archived (hidden from the default list, read-only). */
  archivedAt?: string;
  /** #209: whether the signed-in user may archive, restore or format it (its owner, or a sysop). */
  canManage?: boolean;
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

/** How long a run took to start, step by step (api src/startup.ts's StartupSummary). */
export interface StartupDetail {
  label: string;
  ms: number;
}

export interface StartupSegment {
  id: "request" | "sandbox" | "workspace" | "pi";
  label: string;
  ms: number;
  details?: StartupDetail[];
}

export interface StartupSummary {
  runId: string;
  /** SandboxProvider name: gke, cloudrun, docker, inprocess. */
  provider?: string;
  /** true adopted a warm sandbox, false cold, absent unknown. */
  warm?: boolean;
  /** Wake -> pi ready when agentd reported it, else wake -> ready. */
  totalMs: number;
  /** false while the total may still grow (pi still loading). */
  complete: boolean;
  segments: StartupSegment[];
}

export interface SessionDetail {
  id: string;
  name?: string;
  /** #253: the floppy's speech engine; absent means "deepgram". */
  voiceEngine?: "deepgram" | "builtin";
  /** #255: whether replies are read aloud on this floppy; absent means off. */
  voiceSpeak?: boolean;
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
  archivedAt?: string;
  canManage?: boolean;
  checkpoint?: { branch?: string; head?: string; snapshotUrl?: string; workspaceUrl?: string };
  /** #132: whether the run's prompt allowed external CSS and JS; HTML previews start from it. */
  allowExternalHtmlResources?: boolean;
  /** #147: each run's own value, by run id. An entry's `outfitterRunId` picks from it; an entry
   * without one, or a run not listed, uses allowExternalHtmlResources. */
  htmlPreviewAccessByRun?: Record<string, boolean>;
  /** Cloud-fixes 13: messages parked because this session's runs never validated the protocol, or
   * (#172) because they're refused for a reason no retry fixes (a GitHub credential problem). */
  heldMail?: number;
  /** The reportable run's start-up timing; null before it has started or for an older run. */
  startup?: StartupSummary | null;
  /** When heldMail > 0: "Deploy mismatch: messages held until the service is redeployed", or
   * "Messages held: <reason>. Press Retry once that's fixed." for a run failure (#172). */
  mailNotice?: string;
  /** Cloud GitHub broker state. Never includes a token. */
  github?: {
    repo: string | null;
    branch: string | null;
    credential: "session" | "default" | "none" | "app";
    /** The GitHub App slug when `credential` is `app` and the slug secret is a login-shaped name. */
    appSlug?: string | null;
    merge: boolean;
    onBehalfOf: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PiEntry {
  id: string;
  parentId?: string | null;
  type: string;
  /** #147: not pi's. The api adds it on the wire for an entry an agentd run sent (entry-wire.ts). */
  outfitterRunId?: string;
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
  /** E9.10: the repos this tape is meant for (lowercased owner/name). A hint: New Floppy pre-selects
   * the first, a laptop warns elsewhere; nothing is restricted. */
  repos?: string[];
  /** Tape option, default off. When true, checkpoint runs a Playwright spec in the Drive. */
  playwrightBeforeCheckpoint?: boolean;
  /** Tape option, default off (#132). Tells the agent external CSS and JS are allowed in HTML it
   * writes, and HTML previews of its runs start with them allowed. */
  allowExternalHtmlResources?: boolean;
  /** Tape option, default off (#241). Its Drives get code-server, so the floppy's owner can open
   * them in VS Code in the browser. */
  browserIde?: boolean;
  /** Branches under this prefix may be pushed besides the session branch. Absent means outfitter/. */
  branchPrefix?: string;
  /** When true, this tape's cloud runs may merge pull requests. */
  mergeFromCloud?: boolean;
  /** Tape option, default off (Sysop tools, #290). Whether its runs get the admin tools; "operator"
   * also allows sysop actions for a sysop's own sessions. Only a person sets it here; only a sysop
   * may choose operator. */
  adminTools?: "off" | "manage" | "operator";
  /** Tape option, default off (E9). Agent Engine memory for its Drives: "tool" gives the agent a
   * memory tool, "auto" also recalls before each prompt and records turns. Only a person sets it. */
  memory?: "off" | "tool" | "auto";
  /** Tape option, default off (E9). Its Drives may call the listed Agent Engine agents. Only a
   * person sets it. */
  agentEngine?: boolean;
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
  /** E9: a Dongle (laptop teleport, /api/*) or an A2A key (the link origin's /a2a only). */
  kind?: TokenKind;
  /** On an A2A key: the tapes and repositories its tasks may use. */
  a2a?: A2AKeyScope;
}

export type TokenKind = "dongle" | "a2a";

export interface A2AKeyScope {
  tapes: string[];
  repos: string[];
  maxConcurrent: number;
}

/** E9 §4: one Agent Engine agent Drives may call (Settings → Agent Engine agents, sysops only). */
export interface AeAgent {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

export type AeAgentInput = Pick<AeAgent, "workspaceId" | "name" | "description" | "enabled">;

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
  /** Sandbox rows only: the provider new runs launch on. Other registered sandbox providers (kept
   * so their in-flight runs stay stoppable) have a row without it. */
  isDefault?: boolean;
  /** Sandbox rows only, from the capacity probe (api providers-status.ts probeSandbox). */
  meta?: {
    active?: number;
    limit?: number;
    /** GKE: warm, unclaimed pods ready right now. */
    warmReady?: number;
    /** GKE: the warm pool's desired size (0 outside its scheduled hours). */
    warmDesired?: number;
    /** GKE: how new runs claim a sandbox. */
    launchMode?: "warm" | "cold";
  };
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

/** How a run's sandbox ended (api provider-local SandboxExit). */
export interface SandboxExit {
  /** Kubernetes' own word: OOMKilled, Error, Completed, ... */
  reason: string;
  exitCode?: number;
  finishedAt?: string;
}

/** The provider's live view of a sandbox, while the run is active (api SandboxInfo). */
export interface SandboxInfo {
  name?: string;
  node?: string;
  image?: string;
  phase?: string;
  startedAt?: string;
  resources?: { cpu?: string; memory?: string; ephemeralStorage?: string };
  exit?: SandboxExit;
}

/** GET /api/version: what's deployed (deploy/service.sh's OUTFITTER_BUILD_COMMIT / OUTFITTER_RELEASE). */
export interface AppVersion {
  commit: string | null;
  release: string | null;
}

/** One open Drive preview (#217, api routes/previews.ts). */
export interface PreviewRow {
  id: string;
  port: number;
  /** A public, time-limited link (made on this page), or signed-in session viewers only. */
  share: boolean;
  url: string;
  createdAt: string;
  expiresAt?: string;
}

/** GET /api/sessions/:id/previews. */
export interface PreviewsState {
  enabled: boolean;
  /** The floppy's owner or a sysop: may make public links and close previews. */
  canShare: boolean;
  shareMaxSeconds: number;
  shareDefaultSeconds: number;
  previews: PreviewRow[];
}

/** Browser IDE (#242/#243, api routes/ide.ts): the Drive's VS Code in the browser. */
export type IdeStateName = "none" | "requested" | "installing" | "starting" | "ready" | "error" | "stopped" | "closed";
export interface IdeState {
  /** The Drive has the IDE (its Tape asked for it, previews are on) and is live. */
  available: boolean;
  state: IdeStateName;
  /** Only when ready: the owner-and-sysops address, behind Google sign-in. */
  url?: string;
  detail?: string;
  updatedAt?: string;
}

/** GET /api/sessions/:id/sandbox (api routes/sandbox.ts, #197). */
export interface SandboxDetail {
  run: { id: string; state: string; provider: string; createdAt: string; lastSeenAt?: string; reason?: string };
  /** From agentd's heartbeats (#192). */
  memory: { lastMb?: number; peakMb?: number; limitMb?: number };
  exit?: SandboxExit;
  live?: SandboxInfo;
  /** The session's runs, newest first. */
  runs: { id: string; state: string; createdAt: string }[];
}

export interface SandboxLogLine {
  time: string;
  severity: string;
  message: string;
}

/** GET .../sandbox/logs. `untrusted`: the sandbox wrote these lines; show them as plain text. */
export interface SandboxLogPage {
  runId: string;
  untrusted: true;
  /** Oldest first within the page. */
  lines: SandboxLogLine[];
  /** The next, older page. */
  nextPageToken?: string;
}

/** [ISO time, value] points, oldest first. */
export type SandboxSeries = [string, number][];

/** GET .../sandbox/metrics (GKE only). */
export interface SandboxMetrics {
  runId: string;
  podName?: string;
  series: { memoryMb: SandboxSeries; cpuCores: SandboxSeries; diskMb: SandboxSeries };
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
    const body = (await res.json()) as { error?: any };
    if (body?.error) {
      message = typeof body.error === 'object' && body.error !== null 
        ? (body.error.message || JSON.stringify(body.error)) 
        : String(body.error);
    }
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

/** #252/#253 web voice: GET /api/me/voice. */
export interface VoiceConfig {
  /** Whether the server can mint Deepgram tokens; without it only the built-in engine works. */
  deepgram: boolean;
  model: string;
  language: string;
  prefs: { afterSpeaking: "send" | "review"; ttsVoice?: string; handsFree?: boolean };
}

export interface VoiceTokenResponse {
  token: string;
  expiresAt: string;
  model: string;
  language: string;
  tag: string;
}

/** #257: GET /api/me/voice/spend. */
export interface SpendFigure {
  minutes: number;
  ttsCharacters: number;
  usd: number;
}

export type VoiceSpend =
  | { available: false }
  | { available: true; currency: "USD"; today: SpendFigure; week: SpendFigure; month: SpendFigure; asOf: string; capUsd?: number };

/** #257: GET /api/operator/voice/spend (sysops). */
export type ProjectVoiceSpend =
  | { available: false }
  | {
      available: true;
      currency: "USD";
      users: Array<SpendFigure & { tag: string; email?: string }>;
      untagged: SpendFigure;
      total: SpendFigure;
      asOf: string;
      rates: { sttUsdPerMinute: number; ttsUsdPer1kChars: number };
    };

/** One account the GitHub App is installed on. Installation ids stay on the server. */
export interface GithubAccount {
  login: string;
  type: "Organization" | "User";
}

export interface GithubRepoSummary {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string | null;
  pushedAt: string | null;
  htmlUrl: string;
  language: string | null;
  account: string;
  accountType: "Organization" | "User";
}

export interface GithubCatalogSnapshot {
  configured: boolean;
  reason?: "not-configured" | "misconfigured" | "unavailable";
  truncated: boolean;
  accounts: GithubAccount[];
  repos: GithubRepoSummary[];
}

export interface GithubPull {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  author: string | null;
  updatedAt: string | null;
  head: string;
  base: string;
  additions: number | null;
  deletions: number | null;
}

export interface GithubRepoDetail extends GithubRepoSummary {
  openPulls: GithubPull[];
  lastCommit: { sha: string; url: string; message: string; author: string | null; date: string | null } | null;
  contributions: { weeks: number[] } | { pending: true } | null;
}

export interface GithubSessionStatus {
  connected: boolean;
  reason?: string;
  repo: string | null;
  branch: string | null;
  baseBranch: string | null;
  pulls: GithubPull[];
  branchPull: GithubPull | null;
  diff: {
    additions: number;
    deletions: number;
    ahead?: number;
    behind?: number;
    source: "pull" | "compare";
    partial?: boolean;
  } | null;
}

export const api = {
  version(): Promise<AppVersion> {
    return request("/api/version");
  },

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

  /** E9 §4: the Agent Engine agents Drives may call (sysops). */
  listAeAgents(): Promise<{ agents: AeAgent[] }> {
    return request("/api/operator/agent-engine/agents");
  },

  createAeAgent(agent: AeAgentInput & { id: string }): Promise<{ agent: AeAgent }> {
    return request("/api/operator/agent-engine/agents", { method: "POST", body: JSON.stringify(agent) });
  },

  updateAeAgent(id: string, patch: Partial<AeAgentInput>): Promise<{ agent: AeAgent }> {
    return request(`/api/operator/agent-engine/agents/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(patch) });
  },

  deleteAeAgent(id: string): Promise<void> {
    return request(`/api/operator/agent-engine/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  listTokens(): Promise<TokenRecord[]> {
    return request("/api/me/tokens");
  },

  /** A Dongle by default; `a2a` makes an A2A key scoped to those tapes and repositories. */
  createToken(name: string, a2a?: Partial<A2AKeyScope> & { tapes: string[] }): Promise<{ token: string; record: TokenRecord }> {
    const body = a2a ? { name, kind: "a2a", a2a } : { name };
    return request("/api/me/tokens", { method: "POST", body: JSON.stringify(body) });
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

  /** Archived floppies are left out unless `archived` asks for them (#207). */
  sessions(
    filter: { status?: string; guru?: string; runState?: string; archived?: "only" | "all" } = {},
  ): Promise<SessionSummary[]> {
    const params = new URLSearchParams();
    if (filter.archived) params.set("archived", filter.archived);
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
  voiceConfig(): Promise<VoiceConfig> {
    return request("/api/me/voice");
  },

  /** Any of the preferences; the rest stay as they are. */
  setVoicePrefs(prefs: Partial<VoiceConfig["prefs"]>): Promise<{ prefs: VoiceConfig["prefs"] }> {
    return request("/api/me/voice", { method: "PUT", body: JSON.stringify(prefs) });
  },

  /** A 30 s Deepgram token: 404 when voice is off here, 429 past the per-person limit. */
  voiceToken(): Promise<VoiceTokenResponse> {
    return request("/api/voice/token", { method: "POST" });
  },

  voiceSpend(): Promise<VoiceSpend> {
    return request("/api/me/voice/spend");
  },

  operatorVoiceSpend(): Promise<ProjectVoiceSpend> {
    return request("/api/operator/voice/spend");
  },

  setSessionVoiceEngine(id: string, engine: "deepgram" | "builtin"): Promise<{ voiceEngine: "deepgram" | "builtin" }> {
    return request(`/api/sessions/${id}/voice`, { method: "PUT", body: JSON.stringify({ engine }) });
  },

  /** #255: whether replies on this floppy are read aloud. */
  setSessionVoiceSpeak(id: string, speak: boolean): Promise<{ voiceSpeak: boolean }> {
    return request(`/api/sessions/${id}/voice`, { method: "PUT", body: JSON.stringify({ speak }) });
  },

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

  /** #207: hide the floppy and make it read-only; stops its drive. */
  archiveSession(id: string): Promise<{ session: SessionDetail }> {
    return request(`/api/sessions/${id}/archive`, { method: "POST" });
  },

  restoreSession(id: string): Promise<{ session: SessionDetail }> {
    return request(`/api/sessions/${id}/restore`, { method: "POST" });
  },

  /** #208: permanently erase an archived floppy. No undo. */
  formatSession(id: string): Promise<void> {
    return request(`/api/sessions/${id}`, { method: "DELETE" });
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

  previews(sessionId: string): Promise<PreviewsState> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/previews`);
  },

  sharePreview(sessionId: string, port: number, ttlSeconds: number): Promise<PreviewRow> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/previews/${port}/share`, {
      method: "POST",
      body: JSON.stringify({ ttlSeconds }),
    });
  },

  /** #243: the Drive's IDE state. 403 for anyone but the floppy's owner or a sysop. */
  ide(sessionId: string): Promise<IdeState> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/ide`);
  },

  /** #243: ask the Drive to start its IDE (202 while it starts, 200 when it's already open). */
  openIde(sessionId: string): Promise<IdeState> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/ide`, { method: "POST" });
  },

  /** #243: close the IDE's public address (code-server keeps running in the Drive). */
  closeIde(sessionId: string): Promise<void> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/ide`, { method: "DELETE" });
  },

  closePreview(sessionId: string, previewId: string): Promise<void> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(previewId)}`, { method: "DELETE" });
  },

  /** #197: a run's sandbox. Without `runId`, the active run, else the latest. */
  sandbox(id: string, runId?: string): Promise<SandboxDetail> {
    const qs = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    return request(`/api/sessions/${id}/sandbox${qs}`);
  },

  /** Newest page first; `pageToken` fetches the next, older one. 503 until access is granted. */
  sandboxLogs(id: string, runId: string, pageToken?: string): Promise<SandboxLogPage> {
    const params = new URLSearchParams({ runId });
    if (pageToken) params.set("pageToken", pageToken);
    return request(`/api/sessions/${id}/sandbox/logs?${params}`);
  },

  /** Per-minute history over the run's lifetime. 501 for a provider other than GKE. */
  sandboxMetrics(id: string, runId: string): Promise<SandboxMetrics> {
    return request(`/api/sessions/${id}/sandbox/metrics?runId=${encodeURIComponent(runId)}`);
  },

  /** Repositories the GitHub App can reach. `fresh` skips the short server cache. */
  githubRepos(fresh = false): Promise<GithubCatalogSnapshot> {
    return request(`/api/github/repos${fresh ? "?fresh=1" : ""}`);
  },

  /** One repository: open pull requests, the latest commit, and weekly commit counts. */
  githubRepo(owner: string, name: string): Promise<GithubRepoDetail> {
    return request(`/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  },

  /** Create a repository on an account the App is installed on. Private unless `private` is false. */
  createGithubRepo(input: { owner: string; name: string; private?: boolean; description?: string }): Promise<{ repo: GithubRepoSummary }> {
    return request("/api/github/repos", { method: "POST", body: JSON.stringify(input) });
  },

  /** Branch, open pull requests, and line counts for a Floppy whose repository the App can see. */
  githubStatus(sessionId: string): Promise<GithubSessionStatus> {
    return request(`/api/sessions/${encodeURIComponent(sessionId)}/github-status`);
  },

  streamUrl(id: string): string {
    return `/api/sessions/${id}/stream`;
  },

  /** Transcript jpeg for one capture. Any authenticated caller (protocol.md). */
  browserCapture(sessionId: string, captureId: string): Promise<Blob> {
    return requestBlob(`/api/sessions/${sessionId}/browser/captures/${captureId}`);
  },

  /** E9.9: the signed-in person's pending asks from their laptops (the approval widget). */
  laptopApprovals(): Promise<{ approvals: LaptopApproval[] }> {
    return request("/api/laptop-approvals");
  },

  decideLaptopApproval(id: string, approve: boolean): Promise<{ ok: true; state: string }> {
    return request(`/api/laptop-approvals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ approve }) });
  },
};

/** E9.9: one ask from a laptop, as the api's widget route shows it (admin/laptop-approvals.ts). */
export interface LaptopApproval {
  id: string;
  op: string;
  title: string;
  /** The api's own facts (type, label, who sees it). */
  facts?: Array<{ label: string; value: string }>;
  /** The content the laptop's agent sent, exactly as it would be used. */
  summary: string;
  origin: { laptopSessionId: string; repo?: string };
  createdAt: string;
  expiresAt: string;
}
