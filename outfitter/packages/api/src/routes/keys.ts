// Central sign-in, CA-4 + CA-5 (#393, #394, docs/specs/central-auth.md §4, §5.5, §8): personal
// provider keys (write-only), a device's router key re-mint, and spend. Owned by task D.
// Registered once from routes/index.ts on every role; this module decides per role:
//   every role: GET/PUT/DELETE /api/me/provider-keys[/:provider] (a person on web; a device token
//              anywhere, so /admin can write from Kernal on link; never a Dongle).
//   web, all:   GET /api/me/spend, GET /api/operator/spend.
//   link, all:  POST /api/device/provider-keys, POST /api/device/router-key (device tokens only).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.ts";
import { requireOperator } from "../auth.ts";
import { userIdFor } from "../central/user-id.ts";
import {
  deleteProviderKey,
  deliverProviderKeys,
  isProviderKeyProvider,
  isValidProviderKeyValue,
  listProviderKeys,
  setProviderKey,
  type ProviderKeyDeps,
} from "../central/provider-keys.ts";
import { currentSpendMonth, isSpendMonth, mintDeviceRouterKey } from "../central/litellm-keys.ts";

/** A Dongle (an `outf_` token: viaToken without a device) never reads or writes keys (§3.5, decision
 * 12); a person under IAP or a signed-in Kernal may. */
function refuseDongle(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.identity?.viaToken && !req.identity.deviceId) {
    reply.code(403).send({ error: "device_login_required" });
    return true;
  }
  return false;
}

/** Key delivery and re-mint answer only a device token (§4, §5.5). */
function refuseNonDevice(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.identity?.deviceId) {
    reply.code(403).send({ error: "device_token_required" });
    return true;
  }
  return false;
}

export async function registerKeyRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const role = ctx.config.role;
  const deps = (req: FastifyRequest): ProviderKeyDeps => ({
    providerKeys: ctx.store.providerKeys,
    secrets: ctx.secretAdmin,
    log: (msg, err) => req.log.warn({ err }, msg),
  });

  // ---------- personal provider keys (§4): write-only ----------

  app.get("/api/me/provider-keys", async (req, reply) => {
    if (refuseDongle(req, reply)) return;
    return listProviderKeys(deps(req), userIdFor(req.identity!.email));
  });

  app.put<{ Params: { provider: string } }>("/api/me/provider-keys/:provider", async (req, reply) => {
    if (refuseDongle(req, reply)) return;
    const { provider } = req.params;
    if (!isProviderKeyProvider(provider)) return reply.code(400).send({ error: "unknown_provider" });
    const value = (req.body as { value?: unknown } | undefined)?.value;
    if (!isValidProviderKeyValue(value)) return reply.code(400).send({ error: "invalid_value" });
    const email = req.identity!.email;
    const view = await setProviderKey(deps(req), { userId: userIdFor(email), provider, value, setBy: email });
    req.log.info({ provider, deviceId: req.identity!.deviceId }, "provider key set");
    return view;
  });

  app.delete<{ Params: { provider: string } }>("/api/me/provider-keys/:provider", async (req, reply) => {
    if (refuseDongle(req, reply)) return;
    const { provider } = req.params;
    if (!isProviderKeyProvider(provider)) return reply.code(400).send({ error: "unknown_provider" });
    await deleteProviderKey(deps(req), { userId: userIdFor(req.identity!.email), provider });
    req.log.info({ provider, deviceId: req.identity!.deviceId }, "provider key removed");
    return reply.code(204).send();
  });

  // ---------- spend (§8) ----------

  if (role !== "link") {
    app.get<{ Querystring: { month?: string } }>("/api/me/spend", async (req, reply) => {
      const month = req.query.month ?? currentSpendMonth();
      if (!isSpendMonth(month)) return reply.code(400).send({ error: "invalid_month" });
      if (!ctx.litellmKeys) return reply.code(503).send({ error: "spend_unavailable" });
      try {
        return await ctx.litellmKeys.userSpend(userIdFor(req.identity!.email), month);
      } catch (err) {
        req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "spend read failed");
        return reply.code(502).send({ error: "spend_upstream" });
      }
    });

    app.get<{ Querystring: { month?: string } }>("/api/operator/spend", { preHandler: requireOperator }, async (req, reply) => {
      const month = req.query.month ?? currentSpendMonth();
      if (!isSpendMonth(month)) return reply.code(400).send({ error: "invalid_month" });
      if (!ctx.litellmKeys) return reply.code(503).send({ error: "spend_unavailable" });
      try {
        const users = await ctx.litellmKeys.allUsersSpend(month);
        const total = Math.round(users.reduce((sum, u) => sum + u.total, 0) * 1e6) / 1e6;
        return { month, total, users };
      } catch (err) {
        req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "operator spend read failed");
        return reply.code(502).send({ error: "spend_upstream" });
      }
    });
  }

  // ---------- delivery to a signed-in Kernal (§4, §5.5) ----------

  if (role !== "web") {
    // POST, not GET: the answer carries secrets and must never be cached or replayed by a proxy.
    app.post("/api/device/provider-keys", async (req, reply) => {
      if (refuseNonDevice(req, reply)) return;
      reply.header("cache-control", "no-store");
      const keys = await deliverProviderKeys(deps(req), userIdFor(req.identity!.email));
      req.log.info({ deviceId: req.identity!.deviceId, providers: Object.keys(keys) }, "provider keys delivered");
      return { keys };
    });

    app.post("/api/device/router-key", async (req, reply) => {
      if (refuseNonDevice(req, reply)) return;
      if (!ctx.litellmKeys) return reply.code(503).send({ error: "router_keys_unavailable" });
      const deviceId = req.identity!.deviceId!;
      const device = await ctx.store.devices.findById(deviceId);
      if (!device || device.revokedAt) return reply.code(404).send({ error: "device not found" });
      // §1.7: a machine token (CI) never gets a router key.
      if (device.kind === "machine") return reply.code(403).send({ error: "machine_token" });
      reply.header("cache-control", "no-store");
      try {
        const routerKey = await mintDeviceRouterKey(ctx.litellmKeys, { id: device.id, userId: device.userId, ownerEmail: device.ownerEmail, name: device.name }, ctx.config);
        req.log.info({ deviceId, alias: routerKey.alias }, "router key re-minted");
        return { routerKey };
      } catch (err) {
        req.log.warn({ deviceId, err: err instanceof Error ? err.message : String(err) }, "router key re-mint failed");
        return reply.code(502).send({ error: "router_key_failed", detail: err instanceof Error ? err.message : "failed" });
      }
    });
  }
}
