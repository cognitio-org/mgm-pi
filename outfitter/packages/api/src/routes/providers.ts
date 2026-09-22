// E2.10/E3.6 provider status routes: GET /api/providers (current state), GET /api/providers/stream
// (SSE, same rows pushed on every transition), POST /api/providers/refresh (force a poll -- used by
// the dashboard's manual refresh and by tests). Browser routes only (role "web"/"all"), registered
// alongside sessions/gurus/environments in routes/index.ts.

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";

// Security review #3 (docs/reports/security-review-pr15.md): a manual refresh triggers up to 4
// outbound probes (ngrok, laptop tunnel, LiteLLM, Cloud Run Admin API) with no rate limit, so any
// IAP-authenticated domain user could hammer this route to amplify calls against those third
// parties and the Cloud Run Admin API's own quota. A short global cooldown bounds call volume
// without needing a real per-caller rate limiter for what's otherwise a convenience button.
const REFRESH_COOLDOWN_MS = 10_000;

export async function registerProviderRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  let lastRefreshAt = 0;

  app.get("/api/providers", async () => {
    return { providers: await ctx.providerStatus.getCurrent() };
  });

  app.get("/api/providers/stream", async (req, reply) => {
    ctx.sse.subscribe("providers", reply);
    const providers = await ctx.providerStatus.getCurrent();
    ctx.sse.publish("providers", { type: "status", data: { providers } });
  });

  app.post("/api/providers/refresh", async (req, reply) => {
    const now = Date.now();
    if (now - lastRefreshAt < REFRESH_COOLDOWN_MS) {
      return reply.code(429).send({ error: "refresh already in progress; try again shortly" });
    }
    lastRefreshAt = now;
    return { providers: await ctx.providerStatus.pollOnce() };
  });
}
