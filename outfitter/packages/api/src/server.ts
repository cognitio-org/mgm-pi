// Builds the Fastify app: REST + SSE for browsers (IAP or dev identity), WebSocket ingress for
// agentd, and the run reconciler. Kept separate from main.ts so tests can build an app in-process
// (light-my-request) without binding a port.

import { SessionIndexer } from "./search/service.ts";
import { DriveAdmin } from "./admin/drive.ts";
// E9 PR4: registers the ae.* admin ops.
import "./admin/ae-ops.ts";
import { AeSessions } from "./ae-sessions.ts";
import { createNgrokApi, type NgrokApi } from "./ngrok-api.ts";
import { PreviewService } from "./previews.ts";
import { TurnWaiters } from "./turns.ts";
import { A2ATasks } from "./a2a/tasks.ts";
import { VoiceService } from "./voice.ts";
import { VoiceUsage } from "./voice-usage.ts";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type { Store } from "./store/types.ts";
import type { Config, SandboxProviderName } from "./config.ts";
import type { SandboxProvider } from "@outfitter/provider-local";
import { SandboxProviders } from "./providers/registry.ts";
import type { SecretsBroker, SecretAdmin } from "./secrets.ts";
import { identityFromRequest, identityFromLinkRequest, verifyAgentToken, bearerFromHeader } from "./auth.ts";
import { RunManager } from "./runs.ts";
import { AgentLink, type GithubRefreshTiming } from "./agentlink.ts";
import { SseHub, SsePoller } from "./sse.ts";
import { LaptopProbe } from "./laptop.ts";
import { ProviderStatusService } from "./providers-status.ts";
import { ModelsService } from "./models.ts";
import { registerRoutes } from "./routes/index.ts";
import { MailService, CloudTasksWakeScheduler, NoopWakeScheduler, type WakeScheduler } from "./mail.ts";
import { GithubBroker } from "./github-broker.ts";
import type { A2AHandlerFactory } from "./a2a/handler.ts";
import { GithubCatalog } from "./github-catalog.ts";
import { createAgentEngine, type AgentEngine } from "./agentengine/index.ts";
import { MemoryRecorder } from "./agentengine/recorder.ts";
import { memoryUsage } from "./agentengine/usage.ts";
// E9 PR3: registers the memory.* admin ops (side effect only).
import "./admin/memory-ops.ts";
import { CachedSandboxTelemetry, GcpSandboxTelemetry, NoSandboxTelemetry, type SandboxTelemetry } from "./sandbox-telemetry.ts";

export interface BuildAppOptions {
  store: Store;
  config: Config;
  /** The full registry in production (main.ts's createProviders(config)), so a run started under
   * a since-abandoned SANDBOX_PROVIDER default can still be stopped/reconciled through its own
   * provider. Tests may still pass a bare SandboxProvider (wrapped as the registry's sole,
   * default entry -- same source-compat rule as RunManager's constructor, runs.ts). */
  provider: SandboxProvider | SandboxProviders;
  secretsBroker: SecretsBroker;
  /** Operator settings routes only (routes/operator.ts): Secret Manager admin access behind an
   * interface, same shape as secretsBroker (see secrets.ts's "SecretAdmin" section). */
  secretAdmin: SecretAdmin;
  /** GitHub broker for github.request frames. Tests inject a fake transport; production omits this. */
  github?: GithubBroker;
  /** Shortens installation-token refresh waits. Production omits this. */
  githubRefresh?: GithubRefreshTiming;
  /** E9 PR6: the A2A request handler, for the TCK build's scripted executor (test/tck/sut.ts).
   * Production omits it and gets OutfitterA2AHandler. */
  a2aHandler?: A2AHandlerFactory;
  /** #197: sandbox logs and stats. Tests inject a fake; production omits it and gets Cloud
   * Logging/Monitoring (or nothing, in dev or without GCP_PROJECT). */
  telemetry?: SandboxTelemetry;
  /** #217 Drive previews' ngrok API. Tests inject a fake; production builds one from NGROK_API_KEY
   * when PREVIEW_DOMAIN is set. */
  ngrok?: NgrokApi;
  /** E9 Agent Engine. Tests inject one on a FakeAgentEngine; production builds one from config
   * (each part off while its project id is unset). */
  agentEngine?: AgentEngine;
  /** #252 web voice. Tests inject one with a fake fetch; production builds one from config. */
  voice?: VoiceService;
  /** #257. Tests inject one with a fake fetch; production builds one from config. */
  voiceUsage?: VoiceUsage;
  /** Repository catalog for the browser. Tests inject one with a scripted fetch; production
   * reads the GitHub App id and key. Omitted installation id is fine: the catalog discovers
   * every installation itself. */
  githubCatalog?: GithubCatalog;
}

export interface App {
  fastify: FastifyInstance;
  runs: RunManager;
  agentLink: AgentLink;
  sse: SseHub;
  laptopProbe: LaptopProbe;
  providerStatus: ProviderStatusService;
  mail: MailService;
  previews: PreviewService;
  turns: TurnWaiters;
  /** E9 §4: stops the Agent Engine sessions of closed Outfitter sessions. */
  aeSessions: AeSessions;
  /** E9 §5.3 A2A tasks (tests reach endForKey and get through it). */
  a2a: A2ATasks;
  /** Stops the run reconciler interval, (role link/all) the down-queue poller, and (role web/all)
   * the provider status poller; call from tests and from main.ts on shutdown. */
  stopBackgroundTasks: () => void;
}

export async function buildApp(opts: BuildAppOptions): Promise<App> {
  const { store, config, secretsBroker, secretAdmin } = opts;
  const providers =
    opts.provider instanceof SandboxProviders ? opts.provider : SandboxProviders.single(config.sandboxProvider, opts.provider);
  // forceCloseConnections: idle keep-alive/websocket sockets otherwise stall fastify.close() for
  // as long as they're open (observed in tests: ~30s before a lingering ws finally times out).
  const fastify = Fastify({ logger: true, forceCloseConnections: true });
  await fastify.register(fastifyWebsocket);

  // PUT /import sends a raw JSONL body; treat it as text instead of trying to JSON-parse it whole.
  fastify.addContentTypeParser(
    ["application/x-ndjson", "application/jsonl"],
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  const sse = new SseHub();
  const ssePoller = new SsePoller(sse, store);
  const runs = new RunManager(store, providers, config);
  const laptopProbe = new LaptopProbe({
    tunnelDomain: config.tunnelDomainLmstudio,
    token: config.localTunnelToken,
  });
  const mail = new MailService(store, runs, wakeSchedulerFor(config), (msg, err) => fastify.log.warn({ err }, msg));
  // One broker for agentd's github.request frames and the A2A result's pull request lookup.
  const github = opts.github ?? new GithubBroker(store, secretsBroker);
  const agentLink = new AgentLink(store, config, secretsBroker, sse, laptopProbe, mail, github, opts.githubRefresh);
  // Session search (#289): chunks follow entries as they arrive, and imports and formats.
  const indexer = new SessionIndexer(store, (msg) => fastify.log.warn(msg));
  agentLink.setIndexer(indexer);
  // #217 Drive previews: on when PREVIEW_DOMAIN and NGROK_API_KEY are set (tests inject opts.ngrok).
  const ngrok = opts.ngrok ?? (config.ngrokApiKey && config.previewDomain ? createNgrokApi(config.ngrokApiKey) : undefined);
  const previews = new PreviewService({ store, config, ngrok, log: (msg, detail) => fastify.log.warn(detail ?? {}, msg) });
  agentLink.setPreviews(previews);
  // E9 §1: turn waiters (settle, run end, deadline) for A2A tasks and delegation.
  const turns = new TurnWaiters(store, runs, (msg, err) => fastify.log.warn({ err }, msg));
  agentLink.setTurnWaiters(turns);
  // E9 §5.3: A2A tasks, on the store, read through their sessions' runs and turn waiters.
  const a2a = new A2ATasks({
    store,
    runs,
    turns,
    mail,
    agentLink,
    secrets: secretsBroker,
    pulls: github,
    checkpointTimeoutMs: config.a2aCheckpointTimeoutMs,
    log: (msg, err) => fastify.log.warn({ err }, msg),
  });
  // #193: a run whose agent vanished without a bye gets its sandbox's exit reason read promptly.
  agentLink.onAgentLost((runId) => runs.noteAgentLost(runId));

  // Sandbox capacity probes (E2.10, gke-sandbox-provider.md §2.4 gap G3, #169): one per
  // *registered* provider, not just the default, so Cloud Run's row stays live while it's still
  // registered after the GKE switch. Duck-typed on each provider's optional capacity() rather than
  // `instanceof`, and resolved through the registry lazily inside the probe (and its timeout), so
  // a non-default provider that fails to build reports "down" instead of failing boot. The default
  // is still built here, as before, so a broken default provider fails boot loudly.
  await providers.get(providers.defaultName);
  const sandboxes = {
    names: providers.names(),
    capacity: async (name: SandboxProviderName) => {
      const provider = await providers.get(name);
      return provider.capacity ? provider.capacity() : undefined;
    },
  };
  const litellmKey = async () => config.litellmAdminKey || secretsBroker.defaultLitellmKey();
  const providerStatus = new ProviderStatusService({
    store,
    sse,
    laptopProbe,
    config,
    litellmKey,
    sandboxes,
  });
  // E3.7: GET /api/models' backing service, sharing the same key resolver as the provider status
  // service above so both agree on which key probes LiteLLM's /model/info.
  const modelsService = new ModelsService({
    litellmBaseUrl: config.litellmBaseUrl,
    litellmKey,
    localModels: config.localModels,
  });
  // Sysop tools (#287): admin.request frames from a Drive run through the admin op registry.
  // E9: the Agent Engine clients the memory and ae ops use (PR3/PR4); token caches live here, one
  // per project per instance.
  const agentEngine = opts.agentEngine ?? createAgentEngine(config.agentEngine, { log: (msg) => fastify.log.warn(msg) });
  agentLink.setDriveAdmin(new DriveAdmin({ store, config, models: modelsService, agentEngine, log: (msg) => fastify.log.warn(msg) }));
  const aeSessions = new AeSessions({ store, agents: agentEngine.agents, log: (msg) => fastify.log.warn(msg) });
  // E9 §3.3: `memory: auto` tapes record user prompts as they arrive and each settled turn's final
  // assistant message (the settle comes after agentd flushed the turn's entries).
  if (agentEngine.memory) {
    const recorder = new MemoryRecorder({ store, memory: () => agentEngine.memory, usage: memoryUsage, log: (msg) => fastify.log.warn(msg) });
    agentLink.setMemoryRecorder(recorder);
    turns.onSettled((sessionId, lastEntryId) => void recorder.noteSettled(sessionId, lastEntryId));
    // The usage counts this instance still holds go out with it (agentengine/usage.ts).
    fastify.addHook("onClose", async () => memoryUsage.flush());
  }

  // Auth guards every /api/* route except /api/hooks/* (called by an external service with no IAP
  // session and no agentd identity token; it authenticates itself via its own HMAC signature
  // instead, routes/hooks.ts) and never sits in front of /agent/ws (agentd's own token, verified
  // separately in agentlink.ts) — see config.ts's OutfitterRole doc.
  //
  // "web"/"all": IAP session or a personal API token (identityFromRequest). "link": a personal API
  // token only (identityFromLinkRequest) — that role is never behind IAP (IAP is enforced
  // service-wide by Cloud Run, so it would also block agentd's WebSocket and the ngrok webhook),
  // and personal tokens (E4.1b) are the only credential a laptop teleport client can present here.
  fastify.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/hooks/")) return;
    // The Drive downloads a jpeg with the same credential as its socket (agent id token + run
    // token), not a user Dongle. Any other caller, and a run token that isn't this session's,
    // falls through to IAP / outf_ below.
    const capture = agentCaptureTarget(req.method, req.url);
    const runTokenHeader = req.headers["x-outfitter-run-token"];
    const runToken = Array.isArray(runTokenHeader) ? runTokenHeader[0] : runTokenHeader;
    if (capture && runToken) {
      try {
        await verifyAgentToken(bearerFromHeader(req), config);
        if (await agentLink.runMayDownloadCapture(capture.sessionId, runToken)) {
          req.identity = { email: config.agentSaEmail || "agent@dev.local", operator: false };
          return;
        }
      } catch {
        // Not an agent token. User auth below still applies.
      }
    }
    try {
      req.identity =
        config.role === "link" ? await identityFromLinkRequest(req, store) : await identityFromRequest(req, config, store);
    } catch (err) {
      reply.code(401).send({ error: err instanceof Error ? err.message : "unauthorized" });
    }
  });

  await registerRoutes(fastify, {
    store,
    indexer,
    config,
    runs,
    agentLink,
    sse,
    ssePoller,
    laptopProbe,
    providerStatus,
    modelsService,
    secretAdmin,
    mail,
    previews,
    turns,
    aeSessions,
    agentEngine,
    a2a,
    ...(opts.a2aHandler ? { a2aHandler: opts.a2aHandler } : {}),
    providers,
    voice:
      opts.voice ??
      new VoiceService({
        apiKey: config.deepgramApiKey,
        model: config.voiceModel,
        language: config.voiceLanguage,
        ttlSeconds: config.voiceTokenTtlSeconds,
        perMinute: config.voiceTokensPerMinute,
      }),
    voiceUsage:
      opts.voiceUsage ??
      new VoiceUsage({
        apiKey: config.deepgramApiKey,
        projectId: config.deepgramProjectId,
        rates: { sttUsdPerMinute: config.voiceSttUsdPerMinute, ttsUsdPer1kChars: config.voiceTtsUsdPer1kChars },
      }),
    telemetry:
      opts.telemetry ??
      (config.devMode || !config.gcpProject
        ? new NoSandboxTelemetry()
        : new CachedSandboxTelemetry(new GcpSandboxTelemetry(config.gcpProject, config.gkeNamespace))),
    githubCatalog:
      opts.githubCatalog ?? new GithubCatalog(async (name) => (await secretAdmin.accessLatest(name)) ?? ""),
  });
  // The down-queue poller only makes sense where AgentLink sockets actually live (role "link" or
  // "all", same condition as registering /agent/ws itself) — see agentLink.startDownQueuePoller's
  // doc comment. The web role never holds a socket for any run, so it's never started there.
  let stopDownQueuePoller: (() => void) | undefined;
  if (config.role !== "web") {
    agentLink.register(fastify);
    stopDownQueuePoller = agentLink.startDownQueuePoller();
  }

  const stopRunReconciler = runs.startReconciler();

  // No provider status poller: GET /api/providers refreshes on read when stale
  // (ProviderStatusService.refreshIfStale), because Cloud Run only gives CPU during requests.

  const stopBackgroundTasks = () => {
    stopRunReconciler();
    stopDownQueuePoller?.();
    ssePoller.stop();
  };

  return { fastify, runs, agentLink, sse, laptopProbe, providerStatus, mail, previews, turns, aeSessions, a2a, stopBackgroundTasks };
}

/** GET /api/sessions/:id/browser/captures/:captureId, or undefined. Query strings are ignored. */
function agentCaptureTarget(method: string, url: string): { sessionId: string; captureId: string } | undefined {
  if (method !== "GET") return undefined;
  const path = url.split("?")[0] ?? "";
  const match = path.match(/^\/api\/sessions\/([^/]+)\/browser\/captures\/([^/]+)$/);
  if (!match) return undefined;
  try {
    return { sessionId: decodeURIComponent(match[1]), captureId: decodeURIComponent(match[2]) };
  } catch {
    return undefined;
  }
}

/** Cloud Tasks targets the link role: the web role sits behind IAP, which would reject the task's
 * OIDC token. Role "all" (dev) has no separate link origin and targets itself. */
function wakeSchedulerFor(config: Config): WakeScheduler {
  if (!config.cloudTasksQueue || !config.gcpProject || !config.tasksSaEmail) return new NoopWakeScheduler();
  return new CloudTasksWakeScheduler({
    project: config.gcpProject,
    region: config.gcpRegion,
    queue: config.cloudTasksQueue,
    targetUrl: `${config.linkOrigin || config.origin}/api/hooks/tasks/wake`,
    serviceAccountEmail: config.tasksSaEmail,
  });
}
