// Environment-driven config, read once at startup. Every field has a safe dev default so the
// package runs with `MONGODB_URI=memory OUTFITTER_DEV=1 SANDBOX_PROVIDER=inprocess npm run dev`.

export type SandboxProviderName = "inprocess" | "docker" | "cloudrun";

export interface Config {
  /** "memory" selects the in-memory store; anything else is a mongodb:// connection string. */
  mongodbUri: string;
  /** 1 = skip IAP verification, identify every browser request as dev@localhost. */
  devMode: boolean;
  /** Bearer token accepted from agentd in dev mode, in place of a Google ID token. */
  devToken: string;
  /** Origin of this API, e.g. https://outfitter-api-xyz.run.app. Also the agentd token audience. */
  origin: string;
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
  /** Model ids that only exist on the laptop; requires the E2.8 preflight before use in the cloud. */
  localModels: string[];
  /** Model substituted in when a run wants a local model and the laptop preflight is offline, and
   * the guru itself has no fallbackModel. */
  defaultCloudModel: string;
  /** Shared secret verifying POST /api/hooks/ngrok deliveries (HMAC-SHA256 over the raw body). */
  ngrokWebhookSecret: string;
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
    agentSaEmail: env.AGENT_SA_EMAIL ?? "",
    iapAudience: env.IAP_AUDIENCE ?? "",
    sandboxProvider: (env.SANDBOX_PROVIDER as SandboxProviderName) ?? "inprocess",
    cloudRunJob: env.CLOUDRUN_JOB ?? "outfitter-agent",
    gcpProject: env.GCP_PROJECT ?? "",
    gcpRegion: env.GCP_REGION ?? "us-central1",
    idleStopSeconds: envInt("IDLE_STOP_SECONDS", 600),
    tunnelDomainLmstudio: env.TUNNEL_DOMAIN_LMSTUDIO ?? "",
    localTunnelToken: env.LOCAL_TUNNEL_TOKEN ?? "",
    localModels: envList("LOCAL_MODELS", ["litellm/local-qwen-mlx"], env),
    defaultCloudModel: env.DEFAULT_CLOUD_MODEL ?? "litellm/claude-auto-llm",
    ngrokWebhookSecret: env.NGROK_WEBHOOK_SECRET ?? "",
  };
}
