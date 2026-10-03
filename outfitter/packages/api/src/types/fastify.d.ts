import type { Identity } from "../auth.ts";
import type { Span } from "@sentry/node";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the /api/* auth preHandler in server.ts; undefined for unauthenticated routes. */
    identity?: Identity;
    /** Set by the request-tracing onRequest hook in server.ts (sentry.ts); undefined while the
     * fleet settings have Sentry off. */
    sentrySpan?: Span;
  }
}
