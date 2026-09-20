// Builds the Fastify app: REST + SSE for browsers (IAP or dev identity), WebSocket ingress for
// agentd, and the run reconciler. Kept separate from main.ts so tests can build an app in-process
// (light-my-request) without binding a port.

import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type { Store } from "./store/types.ts";
import type { Config } from "./config.ts";
import type { SandboxProvider } from "./providers/types.ts";
import type { SecretsBroker } from "./secrets.ts";
import { identityFromRequest } from "./auth.ts";
import { RunManager } from "./runs.ts";
import { AgentLink } from "./agentlink.ts";
import { SseHub } from "./sse.ts";
import { LaptopProbe } from "./laptop.ts";
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
  /** Stops the run reconciler interval; call from tests and from main.ts on shutdown. */
  stopReconciler: () => void;
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

  fastify.addHook("preHandler", async (req, reply) => {
    // /api/hooks/* (currently just POST /api/hooks/ngrok) is called by an external service with no
    // IAP session and no agentd identity token; it authenticates itself via its own HMAC signature
    // instead (routes/hooks.ts), so it's carved out of the IAP check here.
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/hooks/")) return;
    try {
      req.identity = await identityFromRequest(req, config);
    } catch (err) {
      reply.code(401).send({ error: err instanceof Error ? err.message : "unauthorized" });
    }
  });

  await registerRoutes(fastify, { store, config, runs, agentLink, sse, laptopProbe });
  agentLink.register(fastify);

  const stopReconciler = runs.startReconciler();

  return { fastify, runs, agentLink, sse, laptopProbe, stopReconciler };
}
