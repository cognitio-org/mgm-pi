// Central sign-in, CA-1 (#390, docs/specs/central-auth.md §1): the device-code flow and the Devices
// page's API. Owned by task A. Registered once from routes/index.ts on every role; this module
// decides per role (§1.5):
//   link, all: POST /api/device/code, /token, /refresh, /revoke (public: central/device-tokens.ts
//              isPublicDevicePath; each checks its own credential).
//   web, all:  GET /api/device/pending, POST /api/device/approve (an IAP person only, never a
//              token), GET /api/me/devices, DELETE /api/me/devices/:id, and the operator routes.
//
// The flow's logic is central/device-login.ts; this file is the HTTP around it.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.ts";
import { requireOperator } from "../auth.ts";
import { normalizeOwnerMatch } from "../tokens.ts";
import { normalizeEmail } from "../central/user-id.ts";
import { DEVICE_CODE_GRANT_TYPE, formatUserCode, normalizeUserCode } from "../central/device-tokens.ts";
import {
  clientIp,
  createMachineToken,
  decideDeviceCode,
  deviceRateLimits,
  deviceRow,
  exchangeDeviceCode,
  isLoginAllowed,
  loginAvailable,
  parseDeviceCodeRequest,
  refreshDevice,
  revokeByToken,
  revokeDevice,
  revokeDevicesMatching,
  startDeviceCode,
  type DeviceRateLimits,
} from "../central/device-login.ts";

export interface DeviceRouteOptions {
  /** Tests pass their own (a fake clock, a fresh count). */
  limits?: DeviceRateLimits;
}

function rateLimited(reply: FastifyReply, retryAfter: number) {
  return reply.code(429).header("retry-after", String(retryAfter)).send({ error: "rate_limited", retryAfter });
}

/** §1.5: the web-role endpoints need a person signed in through IAP (or dev mode). A token never
 * approves, lists or revokes devices, so no signed-in Kernal can approve another. */
function refuseToken(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.identity?.viaToken) return false;
  reply.code(403).send({ error: "a person must approve this in the web app" });
  return true;
}

export async function registerDeviceRoutes(app: FastifyInstance, ctx: RouteContext, opts: DeviceRouteOptions = {}): Promise<void> {
  const limits = opts.limits ?? deviceRateLimits();
  const deps = { store: ctx.store, config: ctx.config, deviceLifecycle: ctx.deviceLifecycle };
  const role = ctx.config.role;

  if (role === "link" || role === "all") {
    app.post("/api/device/code", async (req, reply) => {
      const ip = clientIp(req);
      const wait = limits.code.take(ip ?? "unknown");
      if (wait) return rateLimited(reply, wait);
      if (!loginAvailable(ctx.config)) return reply.code(503).send({ error: "login_unavailable" });
      const body = parseDeviceCodeRequest(req.body);
      if (!body) return reply.code(400).send({ error: "invalid_request" });
      return startDeviceCode(deps, body, ip);
    });

    app.post("/api/device/token", async (req, reply) => {
      const wait = limits.token.take(clientIp(req) ?? "unknown");
      if (wait) return rateLimited(reply, wait);
      const body = (req.body ?? {}) as { grant_type?: unknown; device_code?: unknown };
      if (body.grant_type !== DEVICE_CODE_GRANT_TYPE || typeof body.device_code !== "string") {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const result = await exchangeDeviceCode(deps, body.device_code);
      if (!result.ok) return reply.code(400).send(result.error);
      return result.answer;
    });

    app.post("/api/device/refresh", async (req, reply) => {
      const body = (req.body ?? {}) as { grant_type?: unknown; refresh_token?: unknown };
      if (body.grant_type !== "refresh_token" || typeof body.refresh_token !== "string") {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const result = await refreshDevice(deps, body.refresh_token);
      if (!result.ok) return reply.code(400).send(result.error);
      return result.answer;
    });

    // RFC 7009: the same 200 for an unknown token, so it confirms nothing.
    app.post("/api/device/revoke", async (req, reply) => {
      const body = (req.body ?? {}) as { token?: unknown };
      if (typeof body.token !== "string") return reply.code(400).send({ error: "invalid_request" });
      await revokeByToken(deps, body.token);
      return {};
    });
  }

  if (role === "web" || role === "all") {
    app.get("/api/device/pending", async (req, reply) => {
      if (refuseToken(req, reply)) return reply;
      const wait = limits.approve.take(normalizeEmail(req.identity!.email));
      if (wait) return rateLimited(reply, wait);
      const userCode = normalizeUserCode((req.query as { code?: unknown }).code);
      const code = userCode ? await ctx.store.deviceCodes.findPendingByUserCode(userCode) : null;
      if (!code) return reply.code(404).send({ error: "unknown_code" });
      return {
        userCode: formatUserCode(code.userCode),
        deviceName: code.deviceName,
        ...(code.platform ? { platform: code.platform } : {}),
        ...(code.kernalVersion ? { kernalVersion: code.kernalVersion } : {}),
        ...(code.requestIp ? { requestIp: code.requestIp } : {}),
        requestedAt: code.createdAt,
        expiresAt: code.expiresAt,
      };
    });

    app.post("/api/device/approve", async (req, reply) => {
      if (refuseToken(req, reply)) return reply;
      const identity = req.identity!;
      const wait = limits.approve.take(normalizeEmail(identity.email));
      if (wait) return rateLimited(reply, wait);
      const body = (req.body ?? {}) as { userCode?: unknown; approve?: unknown };
      const userCode = normalizeUserCode(body.userCode);
      if (!userCode || typeof body.approve !== "boolean") return reply.code(400).send({ error: "invalid_request" });
      // The person approving becomes the device's owner, so they must be someone who may sign in.
      // Denying needs no such check: it only ends someone's attempt.
      if (body.approve && !isLoginAllowed(identity.email, ctx.config)) {
        return reply.code(403).send({ error: "access_denied" });
      }
      const code = await ctx.store.deviceCodes.findPendingByUserCode(userCode);
      if (!code) return reply.code(409).send({ error: "not_pending" });
      const result = await decideDeviceCode(deps, code, body.approve, { email: identity.email, ip: clientIp(req) });
      if ("error" in result) return reply.code(409).send(result);
      req.log.info({ approver: identity.email, status: result.status, deviceId: result.deviceId }, "device code decided");
      return result;
    });

    app.get("/api/me/devices", async (req, reply) => {
      if (refuseToken(req, reply)) return reply;
      const devices = await ctx.store.devices.listActiveForOwner(normalizeEmail(req.identity!.email));
      return Promise.all(devices.map((d) => deviceRow(ctx.store, d)));
    });

    app.delete("/api/me/devices/:id", async (req, reply) => {
      if (refuseToken(req, reply)) return reply;
      const { id } = req.params as { id: string };
      const device = await ctx.store.devices.findById(id);
      // Same 404 for someone else's device as for an unknown one.
      if (!device || device.revokedAt || device.ownerEmail !== normalizeEmail(req.identity!.email)) {
        return reply.code(404).send({ error: "device not found" });
      }
      const revoked = await revokeDevice(deps, device, "revoked");
      if (!revoked) return reply.code(404).send({ error: "device not found" });
      return { id: revoked.id, revokedAt: revoked.revokedAt };
    });

    app.post("/api/operator/devices/revoke", { preHandler: requireOperator }, async (req, reply) => {
      const match = normalizeOwnerMatch((req.body ?? {}) as { email?: unknown; domain?: unknown });
      if ("error" in match) return reply.code(400).send({ error: match.error });
      const revoked = await revokeDevicesMatching(deps, match, "operator");
      req.log.info({ operator: req.identity!.email, match, count: revoked.length }, "operator device revoke");
      return { revoked: await Promise.all(revoked.map((d) => deviceRow(ctx.store, d))) };
    });

    // §1.7: a CI machine's token, made by an operator in the web app. A Device of kind "machine",
    // listed on the operator's own Devices page and revoked the same way. No router key.
    app.post("/api/operator/machine-tokens", { preHandler: requireOperator }, async (req, reply) => {
      if (refuseToken(req, reply)) return reply;
      const raw = (req.body as { name?: unknown } | undefined)?.name;
      const name = typeof raw === "string" ? raw.trim() : "";
      if (!name || name.length > 64 || !/^[^\p{C}]+$/u.test(name)) return reply.code(400).send({ error: "invalid_request" });
      const { token, device } = await createMachineToken(deps, { email: req.identity!.email, ip: clientIp(req) }, name);
      req.log.info({ operator: req.identity!.email, deviceId: device.id }, "machine token created");
      return reply.code(201).send({ token, device: await deviceRow(ctx.store, device) });
    });
  }
}
