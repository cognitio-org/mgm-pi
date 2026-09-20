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
  /** Domain the laptop's LM Studio is tunneled on (ngrok), e.g. mgm-lmstudio.ngrok.app. */
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
}

function envRole(env: NodeJS.ProcessEnv): OutfitterRole {
  const raw = env.OUTFITTER_ROLE;
  return raw === "web" || raw === "link" ? raw : "all";
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    mongodbUri: env.MONGODB_URI ?? "memory",
    devMode: env.OUTFITTER_DEV === "1",
    devToken: env.OUTFITTER_DEV_TOKEN ?? "dev-agent-token",
    origin: env.OUTFITTER_ORIGIN ?? "http://localhost:8080",
    role: envRole(env),
    agentSaEmail: env.AGENT_SA_EMAIL ?? "",
    iapAudience: env.IAP_AUDIENCE ?? "",
    sandboxProvider: (env.SANDBOX_PROVIDER as SandboxProviderName) ?? "inprocess",
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
  };
}
