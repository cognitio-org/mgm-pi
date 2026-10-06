// Central sign-in, CA-4 + CA-5 (#393, #394, docs/specs/central-auth.md §4, §5.5, §8): personal
// provider keys (write-only), a device's router key re-mint, and spend. Owned by task D.
// Subscription secrets (docs/specs/subscriptions.md §3) use the same auth, on their own routes.
// Registered once from routes/index.ts on every role; this module decides per role:
//   every role: GET/PUT/DELETE /api/me/provider-keys[/:provider] and
//              /api/me/subscription-secrets[/:vendor] (a person on web; a device token anywhere,
//              so /admin can write from Kernal on link; never a Dongle or machine token).
//   web, all:   GET /api/me/spend, GET /api/operator/spend.
//   link, all:  POST /api/device/provider-keys, POST /api/device/subscription-secrets,
//              POST /api/device/router-key (device tokens only).

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
import {
  deleteSubscriptionSecret,
  deliverSubscriptionSecrets,
  isSubscriptionVendor,
  isValidSubscriptionValue,
  listSubscriptionSecrets,
  setSubscriptionSecret,
  type SubscriptionSecretDeps,
} from "../central/subscription-secrets.ts";
import { currentSpendMonth, deviceKeyAlias, isSpendMonth, mintDeviceRouterKey, routerKeyLimits } from "../central/litellm-keys.ts";
import type { Device } from "../store/devices.ts";
import { metrics } from "../sentry.ts";

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

/** `ifVersion` omitted, a positive integer, or null when the field is present but not one. */
function subscriptionIfVersion(body: unknown): number | undefined | null {
  const raw = (body as { ifVersion?: unknown } | null | undefined)?.ifVersion;
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return null;
  return raw;
}

/** A device token's own Device, or a refusal: gone or revoked is 404, and a machine token (CI, §1.7)
 * never reads, writes or receives personal keys or a router key (403 machine_token). A person (no
 * deviceId) passes with `null`. */
async function deviceOrRefuse(ctx: RouteContext, req: FastifyRequest, reply: FastifyReply): Promise<Device | null | undefined> {
  const deviceId = req.identity?.deviceId;
  if (!deviceId) return null;
  const device = await ctx.store.devices.findById(deviceId);
  if (!device || device.revokedAt) {
    reply.code(404).send({ error: "device not found" });
    return undefined;
  }
  if (device.kind === "machine") {
    reply.code(403).send({ error: "machine_token" });
    return undefined;
  }
  return device;
}

export async function registerKeyRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const role = ctx.config.role;
  const deps = (req: FastifyRequest): ProviderKeyDeps => ({
    providerKeys: ctx.store.providerKeys,
    secrets: ctx.secretAdmin,
    log: (msg, err) => req.log.warn({ err }, msg),
  });
  const subscriptionDeps = (req: FastifyRequest): SubscriptionSecretDeps => ({
    subscriptionSecrets: ctx.store.subscriptionSecrets,
    secrets: ctx.secretAdmin,
    log: (msg, err) => req.log.warn({ err }, msg),
  });

  // ---------- personal provider keys (§4): write-only ----------

  app.get("/api/me/provider-keys", async (req, reply) => {
    if (refuseDongle(req, reply)) return;
    if ((await deviceOrRefuse(ctx, req, reply)) === undefined) return;
    return listProviderKeys(deps(req), userIdFor(req.identity!.email));
  });

  app.put<{ Params: { provider: string } }>("/api/me/provider-keys/:provider", async (req, reply) => {
    if (refuseDongle(req, reply)) return;
    if ((await deviceOrRefuse(ctx, req, reply)) === undefined) return;
    const { provider } = req.params;
    if (!isProviderKeyProvider(provider)) return reply.code(400).send({ error: "unknown_provider" });
    const value = (req.body as { value?: unknown } | undefined)?.value;
    if (!isValidProviderKeyValue(value)) return reply.code(400).send({ error: "invalid_value" });
    const email = req.identity!.email;
    let view;
    try {
      view = await setProviderKey(deps(req), { userId: userIdFor(email), provider, value, setBy: email });
    } catch (err) {
      // Never the error object itself: a Secret Manager (Gaxios) error carries the request, and so
      // the key, in its config.
      const status = (err as { response?: { status?: unknown } } | undefined)?.response?.status;
      req.log.warn({ provider, status, message: err instanceof Error ? err.message : String(err) }, "provider key write failed");
      metrics.count("provider_key.write", { provider, op: "set", outcome: "failed" });
      return reply.code(502).send({ error: "secret_write_failed" });
    }
    metrics.count("provider_key.write", { provider, op: "set", outcome: "ok" });
    req.log.info({ provider, deviceId: req.identity!.deviceId }, "provider key set");
    return view;
  });

  app.delete<{ Params: { provider: string } }>("/api/me/provider-keys/:provider", async (req, reply) => {
    if (refuseDongle(req, reply)) return;
    if ((await deviceOrRefuse(ctx, req, reply)) === undefined) return;
    const { provider } = req.params;
    if (!isProviderKeyProvider(provider)) return reply.code(400).send({ error: "unknown_provider" });
    await deleteProviderKey(deps(req), { userId: userIdFor(req.identity!.email), provider });
    metrics.count("provider_key.write", { provider, op: "delete", outcome: "ok" });
    req.log.info({ provider, deviceId: req.identity!.deviceId }, "provider key removed");
    return reply.code(204).send();
  });

  // ---------- subscription secrets (docs/specs/subscriptions.md §3): write-only ----------

  app.get("/api/me/subscription-secrets", async (req, reply) => {
    if (refuseDongle(req, reply)) return;
    if ((await deviceOrRefuse(ctx, req, reply)) === undefined) return;
    return listSubscriptionSecrets(subscriptionDeps(req), userIdFor(req.identity!.email));
  });

  app.put<{ Params: { vendor: string } }>("/api/me/subscription-secrets/:vendor", async (req, reply) => {
    if (refuseDongle(req, reply)) return;
    if ((await deviceOrRefuse(ctx, req, reply)) === undefined) return;
    const { vendor } = req.params;
    if (!isSubscriptionVendor(vendor)) return reply.code(400).send({ error: "unknown_vendor" });
    const value = (req.body as { value?: unknown } | undefined)?.value;
    if (!isValidSubscriptionValue(vendor, value)) return reply.code(400).send({ error: "invalid_value" });
    const ifVersion = subscriptionIfVersion(req.body);
    if (ifVersion === null) return reply.code(400).send({ error: "invalid_request" });
    const email = req.identity!.email;
    let result;
    try {
      result = await setSubscriptionSecret(subscriptionDeps(req), { userId: userIdFor(email), vendor, value, setBy: email, ...(ifVersion !== undefined ? { ifVersion } : {}) });
    } catch (err) {
      // Never the error object itself: a Secret Manager (Gaxios) error carries the request, and so
      // the secret, in its config.
      const status = (err as { response?: { status?: unknown } } | undefined)?.response?.status;
      req.log.warn({ vendor, status, message: err instanceof Error ? err.message : String(err) }, "subscription secret write failed");
      metrics.count("subscription_secret.write", { vendor, op: "set", outcome: "failed" });
      return reply.code(502).send({ error: "secret_write_failed" });
    }
    if (!result.ok) return reply.code(409).send({ error: result.error, version: result.version });
    metrics.count("subscription_secret.write", { vendor, op: "set", outcome: "ok" });
    req.log.info({ vendor, deviceId: req.identity!.deviceId }, "subscription secret set");
    return result.view;
  });

  app.delete<{ Params: { vendor: string } }>("/api/me/subscription-secrets/:vendor", async (req, reply) => {
    if (refuseDongle(req, reply)) return;
    if ((await deviceOrRefuse(ctx, req, reply)) === undefined) return;
    const { vendor } = req.params;
    if (!isSubscriptionVendor(vendor)) return reply.code(400).send({ error: "unknown_vendor" });
    await deleteSubscriptionSecret(subscriptionDeps(req), { userId: userIdFor(req.identity!.email), vendor });
    metrics.count("subscription_secret.write", { vendor, op: "delete", outcome: "ok" });
    req.log.info({ vendor, deviceId: req.identity!.deviceId }, "subscription secret removed");
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
      if ((await deviceOrRefuse(ctx, req, reply)) === undefined) return;
      reply.header("cache-control", "no-store");
      const keys = await deliverProviderKeys(deps(req), userIdFor(req.identity!.email));
      req.log.info({ deviceId: req.identity!.deviceId, providers: Object.keys(keys) }, "provider keys delivered");
      return { keys };
    });

    app.post("/api/device/subscription-secrets", async (req, reply) => {
      if (refuseNonDevice(req, reply)) return;
      if ((await deviceOrRefuse(ctx, req, reply)) === undefined) return;
      reply.header("cache-control", "no-store");
      const secrets = await deliverSubscriptionSecrets(subscriptionDeps(req), userIdFor(req.identity!.email));
      req.log.info({ deviceId: req.identity!.deviceId, vendors: Object.keys(secrets) }, "subscription secrets delivered");
      return { secrets };
    });

    app.post("/api/device/router-key", async (req, reply) => {
      if (refuseNonDevice(req, reply)) return;
      if (!ctx.litellmKeys) return reply.code(503).send({ error: "router_keys_unavailable" });
      const deviceId = req.identity!.deviceId!;
      // §1.7: a machine token (CI) never gets a router key.
      const device = await deviceOrRefuse(ctx, req, reply);
      if (!device) return;
      reply.header("cache-control", "no-store");
      try {
        const limits = routerKeyLimits(await ctx.fleetSettings.get()).device;
        const routerKey = await mintDeviceRouterKey(ctx.litellmKeys, { id: device.id, userId: device.userId, ownerEmail: device.ownerEmail, name: device.name }, ctx.config, limits);
        // A revoke that ran while minting deleted the previous key, not this one (its RouterKey
        // record was written after). Revoke marks the device first, so a re-read catches it; a
        // failed delete here is recorded and swept.
        const after = await ctx.store.devices.findById(deviceId);
        if (!after || after.revokedAt) {
          await ctx.litellmKeys.deleteKey({ alias: deviceKeyAlias(deviceId) }).catch(() => undefined);
          req.log.warn({ deviceId }, "device revoked during a router key re-mint; new key deleted");
          return reply.code(404).send({ error: "device not found" });
        }
        req.log.info({ deviceId, alias: routerKey.alias }, "router key re-minted");
        return { routerKey };
      } catch (err) {
        req.log.warn({ deviceId, err: err instanceof Error ? err.message : String(err) }, "router key re-mint failed");
        return reply.code(502).send({ error: "router_key_failed", detail: err instanceof Error ? err.message : "failed" });
      }
    });
  }
}
