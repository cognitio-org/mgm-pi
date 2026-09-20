import type { Identity } from "../auth.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the /api/* auth preHandler in server.ts; undefined for unauthenticated routes. */
    identity?: Identity;
  }
}
