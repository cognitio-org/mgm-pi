// Environment-driven config, read once at startup. Every field has a safe dev default so the
// package runs with `MONGODB_URI=memory OUTFITTER_DEV=1 SANDBOX_PROVIDER=inprocess npm run dev`.

export type SandboxProviderName = "inprocess" | "docker" | "cloudrun";

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
  /** Seconds of no user activity before a run checkpoints and stops itself. */
  idleStopSeconds: number;
  /** Domain the laptop's LM Studio is tunneled on (ngrok), e.g. kernal-lmstudio.ngrok.app. */
  tunnelDomainLmstudio: string;
  /** Bearer token tunnel.sh's traffic policy requires on requests to the laptop tunnel. */
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
  /** LITELLM_BASE_URL: the LiteLLM proxy's OpenAI-compatible base URL (a trailing /v1 is stripped
   * before appending management endpoints like /model/info). Same var name as kernal's .env.example. */
  litellmBaseUrl: string;
  /** LITELLM_ADMIN_KEY: key used by the provider status service to call LiteLLM's management
   * endpoints (/health, /model/info, /key/info). Falls back to SecretsBroker.defaultLitellmKey()
   * (the same default key runs get) when unset. */
  litellmAdminKey: string;
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
  /** CLOUD_TASKS_QUEUE: Cloud Tasks queue (in gcpProject/gcpRegion) that schedules a durable wake
   * per posted mail (E5.5, src/mail.ts). Empty disables it; the inline wake and /tick still run. */
  cloudTasksQueue: string;
  /** TASKS_SA_EMAIL: service account Cloud Tasks and Cloud Scheduler mint OIDC tokens as when they
   * call /api/hooks/tasks/wake and /api/hooks/tick; those hooks accept no other caller. */
  tasksSaEmail: string;
}

const OUTFITTER_ROLES: readonly OutfitterRole[] = ["all", "web", "link"];
const SANDBOX_PROVIDERS: readonly SandboxProviderName[] = ["inprocess", "docker", "cloudrun"];

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

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envList(name: string, fallback: string[], env: NodeJS.ProcessEnv): string[] {
  const raw = env[name];
  if (!raw) return fallback;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

/** OUTFITTER_OPERATORS parser: splits on `;`, `,` or any whitespace run (see Config.operators'
 * doc comment for why more than one separator is accepted), trims each entry, drops empties. */
function envOperators(name: string, env: NodeJS.ProcessEnv): string[] {
  const raw = env[name];
  if (!raw) return [];
  return raw
    .split(/[;,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The origin a sandbox dials for its WebSocket (agentd's OUTFITTER_API). With separate roles the
 * sockets live on the "link" service; the "web" service sits behind IAP, which turns a sandbox's
 * handshake away before it reaches the app (a WebSocket close 1006, and nothing in the link logs:
 * the first Floppy woken from the deployed web role on 2026-09-22 hit exactly this). Role "all"
 * serves both, so its own origin is right. */
export function sandboxOrigin(config: Pick<Config, "role" | "origin" | "linkOrigin">): string {
  return config.role === "web" && config.linkOrigin ? config.linkOrigin : config.origin;
}

/** Startup check: a web role that wakes Cloud Run sandboxes cannot work without the link origin
 * (see sandboxOrigin). Throws with the fix instead of failing silently at the first wake. */
export function assertSandboxOrigin(config: Pick<Config, "role" | "linkOrigin" | "sandboxProvider">): void {
  if (config.role === "web" && config.sandboxProvider === "cloudrun" && !config.linkOrigin) {
    throw new Error(
      "OUTFITTER_LINK_ORIGIN is required for OUTFITTER_ROLE=web with SANDBOX_PROVIDER=cloudrun: sandboxes " +
        "connect to the link service, not to this IAP-protected service. deploy/service.sh sets it.",
    );
  }
}

/** Startup check for E5.5: returns a warning when this role's half of the mailbox is off in a real
 * deployment. Not fatal (mail is still stored and delivered inline), but without TASKS_SA_EMAIL the
 * link role 401s every Cloud Scheduler tick and Cloud Task, which is easy to miss. */
export function mailboxWarning(
  config: Pick<Config, "role" | "devMode" | "sandboxProvider" | "cloudTasksQueue" | "tasksSaEmail">,
): string | undefined {
  if (config.devMode || config.sandboxProvider !== "cloudrun") return undefined;
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
    role: envRole(env),
    agentSaEmail: env.AGENT_SA_EMAIL ?? "",
    iapAudience: env.IAP_AUDIENCE ?? "",
    sandboxProvider: envEnum("SANDBOX_PROVIDER", SANDBOX_PROVIDERS, "inprocess", env),
    cloudRunJob: env.CLOUDRUN_JOB ?? "outfitter-agent",
    gcpProject: env.GCP_PROJECT ?? "",
    gcpRegion: env.GCP_REGION ?? "us-central1",
    idleStopSeconds: envInt("IDLE_STOP_SECONDS", 600),
    tunnelDomainLmstudio: env.TUNNEL_DOMAIN_LMSTUDIO ?? "",
    localTunnelToken: env.LOCAL_TUNNEL_TOKEN ?? "",
    mongodbDb: env.MONGODB_DB ?? "outfitter",
    localModels: envList("LOCAL_MODELS", ["litellm/local-qwen-mlx"], env),
    defaultCloudModel: env.DEFAULT_CLOUD_MODEL ?? "litellm/claude-auto-llm",
    ngrokWebhookSecret: env.NGROK_WEBHOOK_SECRET ?? "",
    provisioningGraceMs: envInt("PROVISIONING_GRACE_MS", 10 * 60_000),
    stopGraceMs: envInt("STOP_GRACE_MS", 60_000),
    downQueuePollMs: envInt("DOWN_QUEUE_POLL_MS", 1500),
    ngrokApiKey: env.NGROK_API_KEY ?? "",
    litellmBaseUrl: env.LITELLM_BASE_URL ?? "https://litellm.augment-code.support/v1",
    litellmAdminKey: env.LITELLM_ADMIN_KEY ?? "",
    providerPollMs: envInt("PROVIDER_POLL_MS", 5 * 60_000),
    linkOrigin: env.OUTFITTER_LINK_ORIGIN ?? "",
    operators: envOperators("OUTFITTER_OPERATORS", env),
    cloudTasksQueue: env.CLOUD_TASKS_QUEUE ?? "",
    tasksSaEmail: env.TASKS_SA_EMAIL ?? "",
  };
}
