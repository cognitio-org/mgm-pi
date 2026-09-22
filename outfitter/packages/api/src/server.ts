// Builds the Fastify app: REST + SSE for browsers (IAP or dev identity), WebSocket ingress for
// agentd, and the run reconciler. Kept separate from main.ts so tests can build an app in-process
// (light-my-request) without binding a port.

import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type { Store } from "./store/types.ts";
import type { Config } from "./config.ts";
import type { SandboxProvider } from "@outfitter/provider-local";
import type { SecretsBroker } from "./secrets.ts";
import { identityFromRequest, identityFromLinkRequest } from "./auth.ts";
import { RunManager } from "./runs.ts";
import { AgentLink } from "./agentlink.ts";
import { SseHub } from "./sse.ts";
import { LaptopProbe } from "./laptop.ts";
import { ProviderStatusService } from "./providers-status.ts";
import { CloudRunProvider } from "./providers/cloudrun.ts";
import { registerRoutes } from "./routes/index.ts";

export interface BuildAppOptions {
  store: Store;
  config: Config;
  provider: SandboxProvider;
  secretsBroker: SecretsBroker;
}

export interface App {
  fastify: FastifyInstance;
  runs: RunManager;
  agentLink: AgentLink;
  sse: SseHub;
  laptopProbe: LaptopProbe;
  providerStatus: ProviderStatusService;
  /** Stops the run reconciler interval, (role link/all) the down-queue poller, and (role web/all)
   * the provider status poller; call from tests and from main.ts on shutdown. */
  stopBackgroundTasks: () => void;
}

export async function buildApp(opts: BuildAppOptions): Promise<App> {
  const { store, config, provider, secretsBroker } = opts;
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
  const runs = new RunManager(store, provider, config);
  const laptopProbe = new LaptopProbe({
    tunnelDomain: config.tunnelDomainLmstudio,
    token: config.localTunnelToken,
  });
  const agentLink = new AgentLink(store, config, secretsBroker, sse, laptopProbe);

  // Cloud Run job capacity probe (E2.10): only meaningful when the configured SandboxProvider
  // actually is a CloudRunProvider. Importing the class here is safe even for other providers --
  // it only lazily imports @google-cloud/run inside its own methods, never at module load.
  const cloudRunCount =
    config.sandboxProvider === "cloudrun" && provider instanceof CloudRunProvider
      ? () => (provider as CloudRunProvider).countRunningExecutions()
      : undefined;
  const providerStatus = new ProviderStatusService({
    store,
    sse,
    laptopProbe,
    config,
    litellmKey: async () => config.litellmAdminKey || secretsBroker.defaultLitellmKey(),
    cloudRunCount,
  });

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
    try {
      req.identity =
        config.role === "link" ? await identityFromLinkRequest(req, store) : await identityFromRequest(req, config, store);
    } catch (err) {
      reply.code(401).send({ error: err instanceof Error ? err.message : "unauthorized" });
    }
  });

  await registerRoutes(fastify, { store, config, runs, agentLink, sse, laptopProbe, providerStatus });
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
  };

  return { fastify, runs, agentLink, sse, laptopProbe, providerStatus, stopBackgroundTasks };
}
