// Central settings, CA-3 (#392, docs/specs/central-auth.md §3.4-§3.5): GET /api/config, the schema,
// profiles and versioned writes. Owned by task C. Registered once from routes/index.ts on every
// role (web: IAP people; link: device tokens and, until CA-10, Dongles); the fleet write
// (PUT /api/operator/config/fleet) only where operators exist (web, all).

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";

export async function registerConfigRoutes(_app: FastifyInstance, _ctx: RouteContext): Promise<void> {
  // CA-3 implements this.
}
