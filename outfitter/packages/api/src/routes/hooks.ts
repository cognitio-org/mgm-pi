// POST /api/hooks/ngrok: the optional push path for the E2.8 laptop model preflight (EPIC.md
// "Optional push path"). An ngrok event subscription can deliver `agent_session_start.v0` /
// `agent_session_stop.v0` for the laptop's tunnel agent; on stop we flip LaptopProbe to offline
// immediately instead of waiting out its 60s cache, on start back to online. The same event also
// feeds the E2.10 provider status service (ProviderStatusService.noteLaptopTransition) so the
// "laptop" row and its history update immediately too, instead of waiting for the next 5-minute
// poll -- both consumers read off this one signal.
//
// Caveat (see docs/reports/api.md "deviations"): ngrok's Event Destinations API
// (https://ngrok.com/docs/api/resources/event-destinations/) only documents kinesis/firehose/
// cloudwatch_logs/s3/datadog/azure_logs_ingestion targets, not a generic HTTPS webhook target, so
// the exact delivery shape and signature header for a raw event-subscription-to-our-endpoint push
// isn't published the way GitHub/Stripe-style webhook signatures are. This route implements the
// conventional HMAC-SHA256-over-the-raw-body scheme (verified via the `ngrok-signature` header,
// the name given in the design doc for this story) so the endpoint is ready the moment a delivery
// path (direct, or relayed from one of the supported targets) is wired up; ngrok's own inbound
// webhook-verification feature (https://ngrok.com/docs/traffic-policy/actions/verify-webhook)
// documents the same HMAC-SHA256 shared-secret pattern for the providers it does support.
//
// Never trusted without a valid signature: this endpoint is reachable without IAP (see the
// preHandler carve-out in server.ts), so the shared secret is the only thing standing between it
// and an attacker toggling laptopOnline.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.ts";
import { verifyTasksToken, bearerFromHeader } from "../auth.ts";
import { GkeEndpointError, GkeProvider, KubeError, WARM_POOL_MAX_REPLICAS, WARM_POOL_MIN_REPLICAS } from "../providers/gke.ts";
// Review finding L4: gke.ts itself is imported statically here (it's cheap -- no
// google-auth-library or network at module load, only inside GkeProvider's methods), unlike
// registry.ts's buildGke, which lazy-imports it so a deployment that never configures gke doesn't
// pay even the class definitions. hooks.ts needs the real export (GkeProvider/KubeError/
// GkeEndpointError) to tell the provider and its errors apart, so a lazy import here would just
// move the same cost to first request instead of avoiding it.

/** Constant-time HMAC-SHA256 verification of `ngrok-signature` (hex digest) over the raw body. */
export function verifyNgrokSignature(rawBody: string, headerValue: string | undefined, secret: string): boolean {
  if (!headerValue || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(headerValue.trim(), "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

interface NgrokEventPayload {
  // ngrok's own event-subscription payloads use `event_type_id`; kept loose (`type` too) since the
  // exact envelope for this delivery path is unconfirmed (see the module comment above).
  event_type_id?: string;
  type?: string;
}

export async function registerHookRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  // Encapsulated sub-plugin: the raw-string content-type parser below must not affect the JSON
  // parsing every other /api/* route relies on (Fastify scopes addContentTypeParser to the
  // register() context it's called in).
  await app.register(async (scoped) => {
    scoped.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      done(null, body); // keep the raw bytes so the HMAC signature can be verified before parsing
    });

    scoped.post("/api/hooks/ngrok", async (req, reply) => {
      const raw = typeof req.body === "string" ? req.body : "";
      const signature = req.headers["ngrok-signature"];
      const signatureValue = Array.isArray(signature) ? signature[0] : signature;
      if (!verifyNgrokSignature(raw, signatureValue, ctx.config.ngrokWebhookSecret)) {
        return reply.code(401).send({ error: "invalid signature" });
      }

      let payload: NgrokEventPayload;
      try {
        payload = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        return reply.code(400).send({ error: "invalid JSON" });
      }

      const eventType = payload.event_type_id ?? payload.type;
      if (eventType === "agent_session_stop.v0") {
        ctx.laptopProbe.setOnline(false);
        await ctx.providerStatus.noteLaptopTransition(false);
      } else if (eventType === "agent_session_start.v0") {
        ctx.laptopProbe.setOnline(true);
        await ctx.providerStatus.noteLaptopTransition(true);
      }
      return reply.code(204).send();
    });
  });

  // E5.5 durable wake: one Cloud Task per posted mail (src/mail.ts). A non-2xx makes Cloud Tasks
  // retry with backoff, so a failed provisioning is retried without anyone holding the API open.
  app.post("/api/hooks/tasks/wake", async (req, reply) => {
    if (!(await tasksCallerOk(req, reply, ctx))) return;
    const sessionId = (req.body as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) return reply.code(400).send({ error: "sessionId is required" });
    // 200 once any run exists: retrying a wake that already happened would only stack executions.
    // A throw (provider failure) is a 500, which Cloud Tasks retries; each retry is charged as an
    // attempt on the mail, so a persistently failing session stops being retried.
    const result = await ctx.mail.wakeForMail(sessionId);
    if (result === "active") await ctx.agentLink.deliverMailForSession(sessionId);
    return { result };
  });

  // Cloud Scheduler tick: the in-process setInterval loops only run while a request keeps a
  // min-instances-0 container alive, so this is what guarantees reconciliation and the mail sweep.
  app.post("/api/hooks/tick", async (req, reply) => {
    if (!(await tasksCallerOk(req, reply, ctx))) return;
    await ctx.runs.reconcileOnce();
    await ctx.runs.reconcileStoppingOnce();
    const woken = await ctx.mail.sweep();
    // #217: share links past their deadline, previews of runs that ended without a bye, and what a
    // crash left on ngrok's side. Never fails the tick.
    const previews = await ctx.previews.sweep().catch(() => undefined);
    // E9 §1: turn waiters whose run ended without a bye, whose mail can't be delivered, or whose
    // deadline passed. Never fails the tick.
    const turns = await ctx.turns.sweep().catch(() => undefined);
    // E9 §4: Agent Engine sessions whose Outfitter session closed. Never fails the tick.
    const agentEngine = await ctx.aeSessions.sweep().catch(() => undefined);
    return { woken, ...(previews ? { previews } : {}), ...(turns ? { turns } : {}), ...(agentEngine ? { agentEngine } : {}) };
  });

  // §5.3 guardrail 1 (gke-sandbox-provider.md): two Cloud Scheduler HTTP jobs (warm-up/warm-down)
  // call this to resize the warm pool, authenticated exactly like /api/hooks/tick. Reuses the
  // scheduler's existing SA and hook-auth code so the api stays the only thing that talks to the
  // cluster. Clamped to 0..2 (guardrail 3): going higher needs a code change, not a schedule change.
  app.post("/api/hooks/warm-pool", async (req, reply) => {
    if (!(await tasksCallerOk(req, reply, ctx))) return;

    const raw = (req.body as { replicas?: unknown } | undefined)?.replicas;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return reply.code(400).send({ error: "replicas must be a number" });
    }
    const replicas = Math.min(WARM_POOL_MAX_REPLICAS, Math.max(WARM_POOL_MIN_REPLICAS, Math.trunc(raw)));

    let provider: Awaited<ReturnType<RouteContext["providers"]["get"]>>;
    try {
      provider = await ctx.providers.get("gke");
    } catch {
      return reply.code(404).send({ error: "SANDBOX_PROVIDER=gke is not configured here" });
    }
    if (!(provider instanceof GkeProvider)) {
      // Should not happen (the registry only ever builds a GkeProvider for the "gke" name), but
      // guard against a stub/test provider standing in without crashing the request.
      return reply.code(404).send({ error: "SANDBOX_PROVIDER=gke is not configured here" });
    }

    try {
      await provider.setWarmPoolReplicas(replicas);
    } catch (err) {
      // L6: an endpoint-resolution failure (wrong cluster/location, clusters.get itself failing)
      // is not "the warm pool object is missing" -- check it first so a misconfigured GKE_CLUSTER
      // doesn't get reported to Cloud Scheduler as a 404 that looks fixable by re-applying YAML.
      if (err instanceof GkeEndpointError) {
        return reply.code(502).send({ error: "gke: could not resolve the cluster's control-plane endpoint" });
      }
      if (err instanceof KubeError && err.status === 404) {
        return reply.code(404).send({ error: "warm pool not found" });
      }
      if (err instanceof KubeError && err.status === 409) {
        return reply.code(409).send({ error: "warm pool patch conflict" });
      }
      // M2: never let a raw error (which could echo Kubernetes response detail, even after
      // gke.ts's own redaction) reach the caller through Fastify's default error handler.
      req.log.error({ err }, "gke: warm pool patch failed");
      return reply.code(502).send({ error: "gke: warm pool patch failed" });
    }
    return { replicas };
  });
}

async function tasksCallerOk(
  req: FastifyRequest,
  reply: { code: (n: number) => { send: (body: unknown) => unknown } },
  ctx: RouteContext,
): Promise<boolean> {
  try {
    await verifyTasksToken(bearerFromHeader(req), ctx.config);
    return true;
  } catch {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
}
