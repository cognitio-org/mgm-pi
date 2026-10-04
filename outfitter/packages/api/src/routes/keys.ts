// Central sign-in, CA-4 + CA-5 (#393, #394, docs/specs/central-auth.md §4, §5.5, §8): personal
// provider keys (write-only), a device's router key re-mint, and spend. Owned by task D.
// Registered once from routes/index.ts on every role; this module decides per role:
//   web, all:  GET/PUT/DELETE /api/me/provider-keys[/:provider], GET /api/me/spend,
//              GET /api/operator/spend.
//   link, all: POST /api/device/provider-keys, POST /api/device/router-key (device tokens only).

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";

export async function registerKeyRoutes(_app: FastifyInstance, _ctx: RouteContext): Promise<void> {
  // CA-4/CA-5 implement this.
}
