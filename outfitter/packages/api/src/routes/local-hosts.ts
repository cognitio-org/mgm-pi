// Local Host (epic #378, docs/specs/local-host.md §1-§2): the host registry and tunnel credentials
// routes. Owned by task A (#382, #383). Registered once from routes/index.ts on every role; this
// module decides per role:
//   link, all:  POST /api/local-hosts/heartbeat, POST /api/local-hosts/tunnel-credentials
//               (device tokens only: 403 device_token_required otherwise, 403 machine_token for CI)
//   every role: GET /api/local-hosts (a person under IAP on web; a device token on link),
//               DELETE /api/local-hosts/:id (the owner, or an operator on web)
//
// (stub) Task A replaces the body and keeps the exported name and signature.

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";

export async function registerLocalHostRoutes(_app: FastifyInstance, _ctx: RouteContext): Promise<void> {
  // Task A (#382, #383).
}
