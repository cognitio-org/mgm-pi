// Environment-driven config, read once at startup. Every field has a safe dev default so the
// package runs with `MONGODB_URI=memory OUTFITTER_DEV=1 SANDBOX_PROVIDER=inprocess npm run dev`.

export type SandboxProviderName = "inprocess" | "docker" | "cloudrun" | "gke";

/** GKE_LAUNCH_MODE (config below): cold uses SandboxClaim.spec.env; warm (PR4) adopts a pod from
 * the warm pool via claim annotations instead. See docs/specs/gke-sandbox-provider.md §3.5. */
export type GkeLaunchMode = "cold" | "warm";

/**
 * Which routes this process registers (see server.ts). IAP on a Cloud Run *service* is
 * service-wide: it can't carve out just the browser routes and let agentd's WebSocket or the
 * unauthenticated ngrok webhook through. So the API is split into two Cloud Run services from the
 * same image and this env var picks which routes each one runs:
 * - "web": browser REST/SSE only, behind IAP (deploy/api.sh, service `outfitter-api`).
 * - "link": `/agent/ws` and `/api/hooks/*` only, each with its own per-request auth, no IAP
 *   (deploy/link.sh, service `outfitter-link`, `--allow-unauthenticated`).
 * - "all" (default): both, for local/dev where there's one process and no IAP anyway.
 * Both roles share the same store. See docs/protocol.md "Two origins".
 */
export type OutfitterRole = "all" | "web" | "link";

export interface Config {
  /** "memory" selects the in-memory store; anything else is a mongodb:// connection string. */
  mongodbUri: string;
  /** 1 = skip IAP verification, identify every browser request as dev@localhost. */
  devMode: boolean;
  /** Bearer token accepted from agentd in dev mode, in place of a Google ID token. */
  devToken: string;
  /** Origin of this API, e.g. https://outfitter-api-xyz.run.app. Also the agentd token audience. */
  origin: string;
  /** OUTFITTER_ORIGIN_ALIASES: other origins this service also answers on (e.g. its run.app URL
   * once OUTFITTER_ORIGIN is a custom domain), accepted as token audiences alongside `origin` so a
   * hostname change doesn't strand a running sandbox or a queued Cloud Task minted for the old one.
   * Separated like OUTFITTER_OPERATORS (`;` in deploy/service.sh). See tokenAudiences. */
  originAliases: string[];
  /** OUTFITTER_ROLE: which routes this process registers. See OutfitterRole. */
  role: OutfitterRole;
  /** Service account email agentd authenticates as (audience-verified in verifyAgentToken). */
  agentSaEmail: string;
  /** Audience for IAP-signed JWTs presented by browsers (the IAP resource's OAuth client id). */
  iapAudience: string;
  sandboxProvider: SandboxProviderName;
  /** Cloud Run Job name used by the cloudrun provider. */
  cloudRunJob: string;
  gcpProject: string;
  gcpRegion: string;
  /** GKE_CLUSTER: the GKE Agent Sandbox cluster's name. Empty means the gke provider isn't
   * configured here (registry.ts's createProviders skips registering it); SANDBOX_PROVIDER=gke
   * with this unset fails at boot (see assertGkeConfigured below). */
  gkeCluster: string;
  /** GKE_LOCATION: the cluster's region, default gcpRegion (docs/specs/gke-sandbox-provider.md
   * §3.1: Autopilot clusters are regional). */
  gkeLocation: string;
  /** GKE_NAMESPACE: the namespace SandboxClaims/SandboxWarmPools live in. */
  gkeNamespace: string;
  /** GKE_WARM_POOL: the SandboxWarmPool (and SandboxTemplate) name claims reference. */
  gkeWarmPool: string;
  /** GKE_ENDPOINT: optional override of the cluster's DNS-based control-plane endpoint host
   * (bare host, no scheme, no trailing slash -- see envGkeEndpoint); empty resolves it from one
   * `clusters.get` call (`gke.ts`'s `resolveGkeEndpoint`), memoized per provider instance. */
  gkeEndpoint: string;
  /** GKE_LAUNCH_MODE: cold (claim env, PR2) or warm (claim annotations onto a pre-started pod,
   * PR4). Default cold until PR4's warm-pool image is deployed. */
  gkeLaunchMode: GkeLaunchMode;
  /** GKE_MAX_ACTIVE: hard cap on concurrently active gke sandboxes; start() refuses above it. */
  gkeMaxActive: number;
  /** Seconds of no user activity before a run checkpoints and stops itself. */
  idleStopSeconds: number;
  /** Domain the laptop's LM Studio is tunneled on (ngrok), e.g. kernal-lmstudio.ngrok.app. */
  tunnelDomainLmstudio: string;
  /** Bearer token the legacy single-laptop tunnel requires. `local/...` names do not use it. */
  localTunnelToken: string;
  /** MONGODB_DB: database name, default outfitter (the URI in Secret Manager names none). */
  mongodbDb: string;
  /** Model ids that only exist on the laptop; requires the E2.8 preflight before use in the cloud. */
  localModels: string[];
  /** Model substituted in when a run wants a local model and the laptop preflight is offline, and
   * the guru itself has no fallbackModel. */
  defaultCloudModel: string;
  /** Shared secret verifying POST /api/hooks/ngrok deliveries (HMAC-SHA256 over the raw body). */
  ngrokWebhookSecret: string;
  /** A stale run younger than this is never reconciler-failed for missing heartbeats: it may
   * simply still be provisioning (Cloud Run Job cold start). Default 10 minutes. */
  provisioningGraceMs: number;
  /** STOP_GRACE_MS: how long a run may sit in `stopping` (waiting for agentd's graceful `stop` ->
   * checkpoint -> `bye`) before RunManager.reconcileStoppingOnce cancels its provider execution
   * directly and marks it `stopped`. Default 60s. */
  stopGraceMs: number;
  /** DOWN_QUEUE_POLL_MS: how often the "link" role polls the store for down-messages queued by a
   * sibling process (web role, or another link instance) for a run whose socket lives in *this*
   * process. Needed because AgentLink keeps sockets in memory and outfitter-api / outfitter-link
   * are separate Cloud Run services (see agentlink.ts's poller and docs/protocol.md "Two
   * origins"). Default 1500ms. */
  downQueuePollMs: number;
  /** NGROK_API_KEY: bearer token for the ngrok API (GET /endpoints, /tunnels), used by the E2.10
   * provider status service to reconcile which tunnels are online. Empty means the ngrok probe
   * reports "unknown"/"not configured" rather than failing. */
  ngrokApiKey: string;
  /** PREVIEW_DOMAIN: the registrable domain Drive previews are served on, e.g. kernal.run (#217,
   * docs/specs/drive-previews.md). Never under the app's own domain: a preview is model-written code
   * in the person's browser. Previews are on when this and NGROK_API_KEY are both set. */
  previewDomain: string;
  /** PREVIEW_ALLOW: who may open a secure (non-share) preview, the same people IAP lets into
   * Outfitter: `user:a@b`, bare emails and `domain:example.com` entries, `;` or `,` separated
   * (deploy/service.sh passes IAP_MEMBERS plus the operators). `group:` entries can't be checked
   * at ngrok's edge and are ignored. */
  previewAllow: string[];
  /** PREVIEW_SHARE_TTL_SECONDS (default 24 h) and PREVIEW_SHARE_MAX_SECONDS (default 7 days): how
   * long a public share link lives, at most. It always ends with its job or run anyway. */
  previewShareTtlSeconds: number;
  previewShareMaxSeconds: number;
  /** PREVIEW_ENV (default: GCP_PROJECT, else "local"): stamped into every preview endpoint and
   * credential's metadata, so the sweep only ever removes this deployment's own, not another
   * environment's sharing the ngrok account and PREVIEW_DOMAIN. */
  previewEnv: string;
  /** LOCAL_HOST_DOMAIN (unset or empty: PREVIEW_DOMAIN; both unset: provisioning off): the domain
   * Local Host cloud endpoints are made on, `https://lh-<random>.<domain>` (#383,
   * docs/specs/local-host.md §2.1). Per-host tunnel credentials are provisioned when this and
   * NGROK_API_KEY are both set. Endpoints carry purpose outfitter-local-host in their metadata, so
   * the preview sweep never touches them. */
  localHostDomain: string;
  /** Browser IDE (#241, docs/specs/browser-ide.md §2): the code-server release IDE Drives download,
   * and its SHA-256 per architecture (the release publishes none; we compute them when we bump the
   * pin). IDE_CODE_SERVER_VERSION / IDE_CODE_SERVER_SHA256_AMD64 / IDE_CODE_SERVER_SHA256_ARM64
   * override the defaults below. A bump is an api deploy, not an image rebuild. */
  ideCodeServer: { version: string; artifacts: { amd64: string; arm64: string } };
  /** OUTFITTER_BUILD_COMMIT / OUTFITTER_RELEASE (deploy/service.sh): the commit this deploy ships
   * and, for a tagged release, its outfitter-v* tag. GET /api/version; empty in dev. */
  buildCommit: string;
  release: string;
  /** A2A_BLOCKING_CAP_MS: how long a blocking A2A SendMessage (no returnImmediately) waits for a
   * terminal or interrupted state before returning the task as it is (E9 §5.3, owner decision
   * 2026-10-01: 25 s, under the TCK client's 30 s read timeout). Tests shorten it. */
  a2aBlockingCapMs: number;
  /** A2A_REQUESTS_PER_MINUTE: per A2A key, across instances (E9 §5.2, default 60). A local TCK run
   * raises it; the TCK sends far more than a real client. */
  a2aRequestsPerMinute: number;
  /** A2A_STREAM_POLL_MS: how often a SendStreamingMessage/SubscribeToTask stream re-reads its task
   * row (E9 §5.3, 2 s; the row is the truth across link instances). Tests and the TCK build shorten it. */
  a2aStreamPollMs: number;
  /** A2A_STREAM_MAX_MS: the longest one stream stays open (default 10 min, at most 55 min, under the
   * link service's 1 h request timeout). The client resubscribes for more. */
  a2aStreamMaxMs: number;
  /** A2A_STREAMS_PER_KEY: open streams one key may hold, across instances (default 4). */
  a2aStreamsPerKey: number;
  /** A2A_CHECKPOINT_TIMEOUT_MS: how long a settled repo task waits for its checkpoint to report the
   * branch pushed before it is FAILED "result not pushed" (E9 §5.3, 2 min). Tests shorten it. */
  a2aCheckpointTimeoutMs: number;
  /** NGROK_GOOGLE_OAUTH (Secret Manager outfitter-ngrok-google-oauth): our Google OAuth client for
   * ngrok's sign-in on secure previews, JSON {client_id, client_secret}. Absent or unparseable:
   * ngrok's managed Google app is used instead. */
  ngrokGoogleOauth?: { clientId: string; clientSecret: string };
  /** LITELLM_BASE_URL: the LiteLLM proxy's OpenAI-compatible base URL (a trailing /v1 is stripped
   * before appending management endpoints like /model/info). Same var name as kernal's .env.example. */
  litellmBaseUrl: string;
  /** LITELLM_ADMIN_KEY (Secret Manager outfitter-litellm-admin, minted by deploy/litellm-admin.sh,
   * mounted on both api roles, never a Drive): the LiteLLM management key. The provider status
   * service probes /health, /model/info and /key/info with it (falling back to
   * SecretsBroker.defaultLitellmKey() when unset), and central/litellm-keys.ts creates users and
   * mints and deletes per-device and per-run keys with it (#389 CA-5; unset: no key minting, device
   * login still works without a router key). Its allowed routes are litellm-admin.sh's
   * ALLOWED_ROUTES. */
  litellmAdminKey: string;
  /** LOCAL_HOST_ROUTER_KEY (Secret Manager outfitter-litellm-admin-key, minted by
   * `KEY=local-hosts deploy/litellm-admin.sh`, mounted on the link role only): a separate LiteLLM
   * key whose allowed routes are only /model/info, /model/new, /model/update and /model/delete.
   * Local Host router reconciliation (#384, docs/specs/local-host.md §3.5) writes the `local/...`
   * deployments with it, and runs only on a role that has it (link, or "all" in dev). Unset: no
   * router entries; heartbeats still answer `routerModels`. */
  localHostRouterKey: string;
  /** PROVIDER_POLL_MS: the maximum age of provider status before a read of GET /api/providers
   * re-polls every probe (in the request; there is no background poller). Default 5 minutes. */
  providerPollMs: number;
  /** OUTFITTER_LINK_ORIGIN: the "link" role's own origin (e.g. https://outfitter-link-xyz.run.app),
   * surfaced on GET /api/me so the web UI's Tokens page can print the exact OUTFITTER_API value a
   * laptop needs. Not knowable from inside the "web" process itself (it's a different Cloud Run
   * service) so it's a separate env var, set once the link role's own URL is known (see
   * deploy/service.sh). Empty by default -- the UI then says "ask your operator for the link URL". */
  linkOrigin: string;
  /** OUTFITTER_OPERATORS: emails allowed to manage secrets and deploy-level settings (the operator
   * role, EPIC.md Decisions table). Separated by `;`, `,` or whitespace -- `;` is what
   * deploy/service.sh actually uses, since `gcloud run deploy --set-env-vars` splits its value on
   * commas, but the parser accepts any of the three so a locally-set env var in dev doesn't need to
   * match that convention. Compared case-insensitively after trimming (auth.ts's isOperator).
   * Empty by default: no one is an operator until this is set, except the dev identity (see
   * auth.ts's identityFromRequest). */
  operators: string[];
  /** OUTFITTER_GOOGLE_CLOUD_TOOLSET_ID: the router's `google_cloud` toolset id (a UUID, printed by the
   * GB-2 router script). Operator keys get it in `object_permission.mcp_toolsets` (GB-3, #539). Empty
   * (the default) grants no toolset and leaves every key as before. */
  googleCloudToolsetId: string;
  /** CLOUD_TASKS_QUEUE: Cloud Tasks queue (in gcpProject/gcpRegion) that schedules a durable wake
   * per posted mail (E5.5, src/mail.ts). Empty disables it; the inline wake and /tick still run. */
  cloudTasksQueue: string;
  /** TASKS_SA_EMAIL: service account Cloud Tasks and Cloud Scheduler mint OIDC tokens as when they
   * call /api/hooks/tasks/wake and /api/hooks/tick; those hooks accept no other caller. */
  tasksSaEmail: string;
  /** AGENT_SOCKET_GRACE_MS: how long an agent socket that has sent nothing counts as still live
   * when a *second* connection arrives for the same run (agentlink.ts's single-live-connection
   * rule). agentd heartbeats every 15s while pi is up, so the default 60s is four missed
   * heartbeats; below that a newcomer is refused (4429), above it the silent socket is treated as
   * a dead half-open connection and replaced. 0 disables the rule (every valid hello takes the run
   * over, the pre-fix behaviour) -- tests use that to exercise the replacement path. */
  agentSocketGraceMs: number;
  /** DEEPGRAM_API_KEY (Secret Manager outfitter-deepgram-key, web role): the Member key POST
   * /api/voice/token mints short-lived browser tokens with (#252, src/voice.ts). Empty turns
   * Deepgram voice off; the web then offers only the browser's built-in engine. */
  deepgramApiKey: string;
  /** DEEPGRAM_PROJECT_ID (deploy/config.env, not secret): the Deepgram project that key belongs to,
   * for reading per-person usage (#257). */
  deepgramProjectId: string;
  /** VOICE_MODEL (default nova-3) and VOICE_LANGUAGE (default en): what the browser streams with. */
  voiceModel: string;
  voiceLanguage: string;
  /** VOICE_TOKEN_TTL_SECONDS (default 30): how long a minted token may open a socket. */
  voiceTokenTtlSeconds: number;
  /** VOICE_TOKENS_PER_MINUTE (default 20): tokens one person may mint per minute, per instance. */
  voiceTokensPerMinute: number;
  /** #257: rates that turn Deepgram's usage (audio minutes, TTS characters) into dollars. The owner
   * set nova-3 streaming to Pay As You Go's current price, $0.0048/min (2026-09-28). That's a
   * promotion: the regular price is $0.0077, so raise it when the promotion ends
   * (deepgram.com/pricing, "Nova-3 Monolingual"). Aura-2 is $0.030 per 1,000 characters. */
  voiceSttUsdPerMinute: number;
  voiceTtsUsdPer1kChars: number;
  /** VOICE_MONTHLY_CAP_USD: a person's Deepgram spend this month at which POST /api/voice/token
   * refuses (voice_cap_reached) and the mic uses the browser's built-in speech. 0 (default): no cap.
   * Soft: checked when a stream starts, against usage up to a minute or two old, so one long session
   * can run past it. Plain dollars ("5", not "$5"). */
  voiceMonthlyCapUsd: number;
  /** Atlas Agent Engine (E9, docs/specs/atlas-agent-engine-and-a2a.md §2). See AgentEngineConfig. */
  agentEngine: AgentEngineConfig;
  /** Central sign-in (#389, docs/specs/central-auth.md §1.6). OUTFITTER_LOGIN_ALLOW: who may sign a
   * Kernal in with the device-code flow and keep using a token, in PREVIEW_ALLOW's format (`user:`,
   * bare emails, `domain:`; `group:` is ignored). deploy/service.sh passes IAP_MEMBERS plus the
   * operators. Empty outside dev mode: no device login at all, and Dongles keep today's behaviour. */
  loginAllow: string[];
  /** OUTFITTER_WEB_ORIGIN: the web role's origin (https://app.kernal.one), where a person approves
   * a device code. The link role prints it in POST /api/device/code's `verification_uri`. Empty:
   * `origin` (role "all" serves both). */
  webOrigin: string;
  /** CA-6 (#395, central-auth.md §9): OUTFITTER_RUN_KEY_FALLBACK, on unless "0". While minting is
   * on, a Drive run whose own key can't be minted gets the shared outfitter-litellm-key-* instead
   * of failing (central/run-keys.ts). CA-10 turns it off. */
  runKeyFallback: boolean;
}

/** One Agent Engine project and the service account that acts in it. */
export interface AgentEngineProjectConfig {
  /** The Atlas project id (Agent Engine projects are Atlas projects). */
  projectId: string;
  clientId: string;
  /** Never logged, never sent anywhere but the token endpoint (agentengine/client.ts). */
  clientSecret: string;
  /** AGENT_ENGINE_*_SA_EXPIRES_AT: the service account secret's expiry, recorded by the owner from
   * the create or rotate response (a service account can't read its own). Absent: unknown. */
  expiresAt?: string;
}

/**
 * E9 §2. Two projects with a service account each, since a service account acts only on its own
 * project and agents read every secret of theirs:
 * - memory: AGENT_ENGINE_MEMORY_PROJECT_ID plus AGENT_ENGINE_MEMORY_SA (Secret Manager
 *   outfitter-agentengine-memory-sa, JSON {client_id, client_secret}). Memory only; no agent is
 *   ever deployed there.
 * - agents: AGENT_ENGINE_AGENTS_PROJECT_ID plus AGENT_ENGINE_AGENTS_SA (outfitter-agentengine-agents-sa).
 * Each part is off (undefined) while its project id is unset, so dev and CI need no account, and
 * also while its credentials are missing or unreadable (agentEngineWarnings says so at boot).
 */
export interface AgentEngineConfig {
  /** AGENT_ENGINE_BASE_URL, default https://agentengine.mongodb.com. https only, except a loopback
   * host for local fakes. */
  baseUrl: string;
  memory?: AgentEngineProjectConfig;
  agents?: AgentEngineProjectConfig;
}

export const AGENT_ENGINE_DEFAULT_BASE_URL = "https://agentengine.mongodb.com";
/** How long before a service account secret expires the api starts warning (E9 §2 rotation). */
export const AGENT_ENGINE_EXPIRY_WARNING_MS = 14 * 24 * 60 * 60_000;

/** The code-server release IDE Drives download (browser IDE, #241). The scheduled check in
 * .github/workflows/code-server-release.yml reads this version and opens an issue when coder/code-server
 * publishes a newer one. SHA-256s computed from the release assets (docs/reports/browser-ide-spike.md). */
export const IDE_CODE_SERVER_PIN = {
  version: "4.139.1",
  artifacts: {
    amd64: "53029be6c5781b7bca49b815fcc9a2a3fc111813ad8c9965b2c0f0d2985a0674",
    arm64: "0edb4b60d9c4744b2dd14b0911e3c2e6dd8c6f3c13bd58bda23ae744e59e7df1",
  },
} as const;

const OUTFITTER_ROLES: readonly OutfitterRole[] = ["all", "web", "link"];
const SANDBOX_PROVIDERS: readonly SandboxProviderName[] = ["inprocess", "docker", "cloudrun", "gke"];
const GKE_LAUNCH_MODES: readonly GkeLaunchMode[] = ["cold", "warm"];

/** True for a provider whose sandboxes run on GCP compute this API dials out to over a network
 * (as opposed to a local dev provider): both `assertSandboxOrigin` (sandboxes must reach the link
 * origin, not this IAP-protected one) and `mailboxWarning` (Cloud Tasks/Scheduler need their SA
 * configured) special-cased `=== "cloudrun"` before gke existed. */
export function isCloudProvider(name: SandboxProviderName): boolean {
  return name === "cloudrun" || name === "gke";
}

/** Validates an env var against a fixed set of literal values, failing loudly at boot (rather than
 * silently defaulting, or failing later the first time the bad value is actually used — see
 * docs/reports/maintainability-review-pr1.md's "SANDBOX_PROVIDER doesn't type-check" finding). An
 * unset var falls back to `fallback`; a set-but-unrecognized value throws. */
function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T, env: NodeJS.ProcessEnv): T {
  const raw = env[name];
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`invalid ${name}: ${JSON.stringify(raw)} (expected one of ${allowed.join(", ")})`);
}

function envRole(env: NodeJS.ProcessEnv): OutfitterRole {
  return envEnum("OUTFITTER_ROLE", OUTFITTER_ROLES, "all", env);
}

function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** A non-negative decimal (a price, a cap); anything else falls back. */
function envNonNegative(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  // Loud, because for VOICE_MONTHLY_CAP_USD the fallback (0) means "no cap".
  console.warn(`[config] ${name}=${JSON.stringify(raw)} isn't a non-negative number; using ${fallback}`);
  return fallback;
}

function envList(name: string, fallback: string[], env: NodeJS.ProcessEnv): string[] {
  const raw = env[name];
  if (!raw) return fallback;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

/** Review finding L3: `gke.ts`'s `HttpKubeClient` builds request URLs as `https://${endpoint}${path}`
 * and `resolveGkeEndpoint`'s own `clusters.get` result is a bare host too -- a `GKE_ENDPOINT` set
 * with a scheme or a trailing slash would silently produce a malformed URL (`https://https://...`
 * or a double slash) that fails opaquely at request time instead of at boot. Normalize rather than
 * reject: an operator pasting the value straight from `gcloud container clusters describe` (which
 * prints the bare host) gets no error either way, and one copied with `https://` or a trailing `/`
 * still works instead of breaking every gke call until someone notices. */
function envGkeEndpoint(env: NodeJS.ProcessEnv): string {
  const raw = env.GKE_ENDPOINT ?? "";
  return raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** OUTFITTER_OPERATORS / OUTFITTER_ORIGIN_ALIASES parser: splits on `;`, `,` or any whitespace run
 * (see Config.operators' doc comment for why more than one separator is accepted), trims each
 * entry, drops empties. */
function envGoogleOauth(raw: string | undefined): { clientId: string; clientSecret: string } | undefined {
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw);
    const clientId = typeof j?.client_id === "string" ? j.client_id.trim() : "";
    const clientSecret = typeof j?.client_secret === "string" ? j.client_secret.trim() : "";
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  } catch {
    return undefined;
  }
}

/** AGENT_ENGINE_BASE_URL: credentials and bearer tokens go there, so it must be https (a loopback
 * http URL is allowed for a local fake). Throws at boot otherwise, like envEnum. */
function envAgentEngineBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = (env.AGENT_ENGINE_BASE_URL ?? "").trim() || AGENT_ENGINE_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid AGENT_ENGINE_BASE_URL: ${JSON.stringify(raw)}`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`AGENT_ENGINE_BASE_URL must be https: ${JSON.stringify(raw)}`);
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("AGENT_ENGINE_BASE_URL must be a bare origin and path");
  return url.toString().replace(/\/+$/, "");
}

/** A service account secret as Secret Manager holds it: JSON {client_id, client_secret}. */
export function parseAgentEngineCredentials(raw: string | undefined): { clientId: string; clientSecret: string } | undefined {
  // Same shape as NGROK_GOOGLE_OAUTH.
  return envGoogleOauth(raw);
}

function envAgentEngineProject(env: NodeJS.ProcessEnv, part: "MEMORY" | "AGENTS"): AgentEngineProjectConfig | undefined {
  const projectId = (env[`AGENT_ENGINE_${part}_PROJECT_ID`] ?? "").trim();
  if (!projectId) return undefined;
  const creds = parseAgentEngineCredentials(env[`AGENT_ENGINE_${part}_SA`]);
  if (!creds) return undefined;
  const expiresAt = (env[`AGENT_ENGINE_${part}_SA_EXPIRES_AT`] ?? "").trim();
  return { projectId, ...creds, ...(expiresAt ? { expiresAt } : {}) };
}

function envAgentEngine(env: NodeJS.ProcessEnv): AgentEngineConfig {
  const memory = envAgentEngineProject(env, "MEMORY");
  const agents = envAgentEngineProject(env, "AGENTS");
  return { baseUrl: envAgentEngineBaseUrl(env), ...(memory ? { memory } : {}), ...(agents ? { agents } : {}) };
}

/** The rotation warning for one service account, or undefined (E9 §2: 14 days before). */
export function agentEngineExpiryWarning(part: "memory" | "agents", expiresAt: string | undefined, nowMs: number): string | undefined {
  if (!expiresAt) return undefined;
  const at = Date.parse(expiresAt);
  const name = `outfitter-agentengine-${part}-sa`;
  if (!Number.isFinite(at)) return `AGENT_ENGINE_${part.toUpperCase()}_SA_EXPIRES_AT isn't a date (${JSON.stringify(expiresAt)}); can't warn before ${name} expires`;
  const left = at - nowMs;
  if (left <= 0) return `Agent Engine ${part} service account secret (${name}) expired at ${expiresAt}; rotate it (deploy/agent-engine.md)`;
  if (left <= AGENT_ENGINE_EXPIRY_WARNING_MS) {
    const days = Math.ceil(left / (24 * 60 * 60_000));
    return `Agent Engine ${part} service account secret (${name}) expires in ${days} day${days === 1 ? "" : "s"} (${expiresAt}); rotate it (deploy/agent-engine.md)`;
  }
  return undefined;
}

/** Startup warnings for E9's config: a project id set without readable credentials (that part
 * stays off), and secrets close to expiry. Never includes a credential. */
export function agentEngineWarnings(config: Pick<Config, "agentEngine">, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): string[] {
  const out: string[] = [];
  for (const part of ["memory", "agents"] as const) {
    const upper = part.toUpperCase();
    const project = config.agentEngine[part];
    if (!project) {
      if ((env[`AGENT_ENGINE_${upper}_PROJECT_ID`] ?? "").trim()) {
        out.push(`AGENT_ENGINE_${upper}_PROJECT_ID is set but AGENT_ENGINE_${upper}_SA is missing or isn't JSON {client_id, client_secret}; Agent Engine ${part} is off`);
      }
      continue;
    }
    const expiry = agentEngineExpiryWarning(part, project.expiresAt, nowMs);
    if (expiry) out.push(expiry);
  }
  return out;
}

function envOperators(name: string, env: NodeJS.ProcessEnv): string[] {
  const raw = env[name];
  if (!raw) return [];
  return raw
    .split(/[;,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Audiences an incoming Google ID token (agentd, Cloud Tasks, Cloud Scheduler) may carry: this
 * service's origin plus its aliases, de-duplicated, no trailing slashes. */
export function tokenAudiences(config: Pick<Config, "origin" | "originAliases">): string[] {
  const strip = (o: string) => o.replace(/\/+$/, "");
  return [...new Set([config.origin, ...config.originAliases].map(strip).filter(Boolean))];
}

/** The origin a sandbox dials for its WebSocket (agentd's OUTFITTER_API). With separate roles the
 * sockets live on the "link" service; the "web" service sits behind IAP, which turns a sandbox's
 * handshake away before it reaches the app (a WebSocket close 1006, and nothing in the link logs:
 * the first Floppy woken from the deployed web role on 2026-09-22 hit exactly this). Role "all"
 * serves both, so its own origin is right. */
export function sandboxOrigin(config: Pick<Config, "role" | "origin" | "linkOrigin">): string {
  return config.role === "web" && config.linkOrigin ? config.linkOrigin : config.origin;
}

/** Startup check: a web role that wakes cloud sandboxes (cloudrun, gke) cannot work without the
 * link origin (see sandboxOrigin). Throws with the fix instead of failing silently at the first
 * wake. */
export function assertSandboxOrigin(config: Pick<Config, "role" | "linkOrigin" | "sandboxProvider">): void {
  if (config.role === "web" && isCloudProvider(config.sandboxProvider) && !config.linkOrigin) {
    throw new Error(
      `OUTFITTER_LINK_ORIGIN is required for OUTFITTER_ROLE=web with SANDBOX_PROVIDER=${config.sandboxProvider}: sandboxes ` +
        "connect to the link service, not to this IAP-protected service. deploy/service.sh sets it.",
    );
  }
}

/** Startup check: SANDBOX_PROVIDER=gke with no GKE_CLUSTER can never construct a working
 * provider (registry.ts's createProviders would simply not register one), so fail loudly at boot
 * instead of at the first wake -- same pattern as assertSandboxOrigin above. */
export function assertGkeConfigured(config: Pick<Config, "sandboxProvider" | "gkeCluster">): void {
  if (config.sandboxProvider === "gke" && !config.gkeCluster) {
    throw new Error("GKE_CLUSTER is required for SANDBOX_PROVIDER=gke.");
  }
}

/** Startup check for E5.5: returns a warning when this role's half of the mailbox is off in a real
 * deployment. Not fatal (mail is still stored and delivered inline), but without TASKS_SA_EMAIL the
 * link role 401s every Cloud Scheduler tick and Cloud Task, which is easy to miss. */
export function mailboxWarning(
  config: Pick<Config, "role" | "devMode" | "sandboxProvider" | "cloudTasksQueue" | "tasksSaEmail">,
): string | undefined {
  if (config.devMode || !isCloudProvider(config.sandboxProvider)) return undefined;
  if (config.role !== "web" && !config.tasksSaEmail) {
    return "TASKS_SA_EMAIL is unset: /api/hooks/tick and /api/hooks/tasks/wake will reject every call (deploy/service.sh sets it once deploy/mailbox.sh has run)";
  }
  if (config.role !== "link" && !(config.cloudTasksQueue && config.tasksSaEmail)) {
    return "CLOUD_TASKS_QUEUE/TASKS_SA_EMAIL unset: mail wakes won't be retried by Cloud Tasks (deploy/service.sh sets them once deploy/mailbox.sh has run)";
  }
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    mongodbUri: env.MONGODB_URI ?? "memory",
    devMode: env.OUTFITTER_DEV === "1",
    devToken: env.OUTFITTER_DEV_TOKEN ?? "dev-agent-token",
    origin: env.OUTFITTER_ORIGIN ?? "http://localhost:8080",
    originAliases: envOperators("OUTFITTER_ORIGIN_ALIASES", env),
    role: envRole(env),
    agentSaEmail: env.AGENT_SA_EMAIL ?? "",
    iapAudience: env.IAP_AUDIENCE ?? "",
    sandboxProvider: envEnum("SANDBOX_PROVIDER", SANDBOX_PROVIDERS, "inprocess", env),
    cloudRunJob: env.CLOUDRUN_JOB ?? "outfitter-agent",
    gcpProject: env.GCP_PROJECT ?? "",
    gcpRegion: env.GCP_REGION ?? "us-central1",
    gkeCluster: env.GKE_CLUSTER ?? "",
    gkeLocation: env.GKE_LOCATION ?? env.GCP_REGION ?? "us-central1",
    gkeNamespace: env.GKE_NAMESPACE ?? "outfitter-sandboxes",
    gkeWarmPool: env.GKE_WARM_POOL ?? "outfitter-agent",
    gkeEndpoint: envGkeEndpoint(env),
    gkeLaunchMode: envEnum("GKE_LAUNCH_MODE", GKE_LAUNCH_MODES, "cold", env),
    gkeMaxActive: envInt("GKE_MAX_ACTIVE", 3, env),
    idleStopSeconds: envInt("IDLE_STOP_SECONDS", 600, env),
    tunnelDomainLmstudio: env.TUNNEL_DOMAIN_LMSTUDIO ?? "",
    localTunnelToken: env.LOCAL_TUNNEL_TOKEN ?? "",
    mongodbDb: env.MONGODB_DB ?? "outfitter",
    localModels: envList("LOCAL_MODELS", ["litellm/local-qwen-mlx"], env),
    defaultCloudModel: env.DEFAULT_CLOUD_MODEL ?? "litellm/claude-auto-llm",
    ngrokWebhookSecret: env.NGROK_WEBHOOK_SECRET ?? "",
    provisioningGraceMs: envInt("PROVISIONING_GRACE_MS", 10 * 60_000, env),
    stopGraceMs: envInt("STOP_GRACE_MS", 60_000, env),
    downQueuePollMs: envInt("DOWN_QUEUE_POLL_MS", 1500, env),
    ngrokApiKey: env.NGROK_API_KEY ?? "",
    previewDomain: (env.PREVIEW_DOMAIN ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, ""),
    previewAllow: envOperators("PREVIEW_ALLOW", env),
    previewShareTtlSeconds: envInt("PREVIEW_SHARE_TTL_SECONDS", 24 * 60 * 60, env),
    previewShareMaxSeconds: envInt("PREVIEW_SHARE_MAX_SECONDS", 7 * 24 * 60 * 60, env),
    previewEnv: (env.PREVIEW_ENV || env.GCP_PROJECT || "local").trim(),
    localHostDomain: (env.LOCAL_HOST_DOMAIN?.trim() || env.PREVIEW_DOMAIN || "").trim().toLowerCase().replace(/^\.+|\.+$/g, ""),
    ideCodeServer: {
      version: (env.IDE_CODE_SERVER_VERSION || IDE_CODE_SERVER_PIN.version).trim(),
      artifacts: {
        amd64: (env.IDE_CODE_SERVER_SHA256_AMD64 || IDE_CODE_SERVER_PIN.artifacts.amd64).trim().toLowerCase(),
        arm64: (env.IDE_CODE_SERVER_SHA256_ARM64 || IDE_CODE_SERVER_PIN.artifacts.arm64).trim().toLowerCase(),
      },
    },
    buildCommit: (env.OUTFITTER_BUILD_COMMIT ?? "").trim(),
    release: (env.OUTFITTER_RELEASE ?? "").trim(),
    a2aBlockingCapMs: Math.max(0, Math.min(25_000, envInt("A2A_BLOCKING_CAP_MS", 25_000, env))),
    a2aRequestsPerMinute: Math.max(1, envInt("A2A_REQUESTS_PER_MINUTE", 60, env)),
    a2aStreamPollMs: Math.max(20, Math.min(10_000, envInt("A2A_STREAM_POLL_MS", 2_000, env))),
    a2aStreamMaxMs: Math.max(1_000, Math.min(55 * 60_000, envInt("A2A_STREAM_MAX_MS", 10 * 60_000, env))),
    a2aStreamsPerKey: Math.max(1, Math.min(50, envInt("A2A_STREAMS_PER_KEY", 4, env))),
    a2aCheckpointTimeoutMs: Math.max(100, Math.min(30 * 60_000, envInt("A2A_CHECKPOINT_TIMEOUT_MS", 2 * 60_000, env))),
    ...(envGoogleOauth(env.NGROK_GOOGLE_OAUTH) ? { ngrokGoogleOauth: envGoogleOauth(env.NGROK_GOOGLE_OAUTH) } : {}),
    litellmBaseUrl: env.LITELLM_BASE_URL ?? "https://router.kernal.one/v1",
    litellmAdminKey: (env.LITELLM_ADMIN_KEY ?? "").trim(),
    localHostRouterKey: (env.LOCAL_HOST_ROUTER_KEY ?? "").trim(),
    providerPollMs: envInt("PROVIDER_POLL_MS", 5 * 60_000, env),
    linkOrigin: env.OUTFITTER_LINK_ORIGIN ?? "",
    operators: envOperators("OUTFITTER_OPERATORS", env),
    googleCloudToolsetId: (env.OUTFITTER_GOOGLE_CLOUD_TOOLSET_ID ?? "").trim(),
    cloudTasksQueue: env.CLOUD_TASKS_QUEUE ?? "",
    tasksSaEmail: env.TASKS_SA_EMAIL ?? "",
    agentSocketGraceMs: envInt("AGENT_SOCKET_GRACE_MS", 60_000, env),
    deepgramApiKey: (env.DEEPGRAM_API_KEY ?? "").trim(),
    deepgramProjectId: (env.DEEPGRAM_PROJECT_ID ?? "").trim(),
    voiceModel: env.VOICE_MODEL || "nova-3",
    voiceLanguage: env.VOICE_LANGUAGE || "en",
    // Deepgram accepts 1..3600 s; a limit below 1 would refuse everyone with a meaningless retry-after.
    voiceTokenTtlSeconds: Math.min(3600, Math.max(1, envInt("VOICE_TOKEN_TTL_SECONDS", 30, env))),
    voiceTokensPerMinute: Math.max(1, envInt("VOICE_TOKENS_PER_MINUTE", 20, env)),
    voiceSttUsdPerMinute: envNonNegative("VOICE_STT_USD_PER_MINUTE", 0.0048, env),
    voiceTtsUsdPer1kChars: envNonNegative("VOICE_TTS_USD_PER_1K_CHARS", 0.03, env),
    voiceMonthlyCapUsd: envNonNegative("VOICE_MONTHLY_CAP_USD", 0, env),
    agentEngine: envAgentEngine(env),
    loginAllow: envOperators("OUTFITTER_LOGIN_ALLOW", env),
    webOrigin: (env.OUTFITTER_WEB_ORIGIN ?? "").trim().replace(/\/+$/, ""),
    runKeyFallback: (env.OUTFITTER_RUN_KEY_FALLBACK ?? "").trim() !== "0",
  };
}
