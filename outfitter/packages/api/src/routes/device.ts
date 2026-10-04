// Central sign-in, CA-1 (#390, docs/specs/central-auth.md §1): the device-code flow and the Devices
// page's API. Owned by task A. Registered once from routes/index.ts on every role; this module
// decides per role (§1.5):
//   link, all: POST /api/device/code, /token, /refresh, /revoke (public: central/device-tokens.ts
//              isPublicDevicePath; each checks its own credential).
//   web, all:  GET /api/device/pending, POST /api/device/approve (an IAP person only, never a
//              token), GET /api/me/devices, DELETE /api/me/devices/:id, and the operator routes.

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.ts";

export async function registerDeviceRoutes(_app: FastifyInstance, _ctx: RouteContext): Promise<void> {
  // CA-1 implements this.
}
