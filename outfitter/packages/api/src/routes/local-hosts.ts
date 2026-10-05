// Local Host (epic #378, docs/specs/local-host.md §1-§2): the host registry and tunnel credentials
// routes. Owned by task A (#382, #383). Registered once from routes/index.ts on every role; this
// module decides per role:
//   link, all:  POST /api/local-hosts/heartbeat, POST /api/local-hosts/tunnel-credentials
//               (device tokens only: 403 device_token_required otherwise, 403 machine_token for CI)
//   every role: GET /api/local-hosts (a person under IAP on web; a device token on link),
//               DELETE /api/local-hosts/:id (the owner, or an operator on web)

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.ts";
import { userIdFor } from "../central/user-id.ts";
import type { Device } from "../store/devices.ts";
import { MAX_BODY_BYTES } from "../local-hosts/contract.ts";
import { HOST_ID_RE, LOCAL_HOST_ID_RE, localHostId } from "../local-hosts/naming.ts";
import {
  HeartbeatInvalid,
  RouterPrefixUnavailable,
  deleteLocalHost,
  listLocalHosts,
  parseHeartbeat,
  recordHeartbeat,
  retireIssued,
  revokeLocalHost,
  type LocalHostDeps,
} from "../local-hosts/registry.ts";
import { TunnelCredentialsError, issueTunnelCredentials, provisioningOn } from "../local-hosts/tunnel-credentials.ts";

/** The heartbeat and credentials routes answer only a device token (§1.1). Copied from
 * routes/keys.ts, as the spec asks, rather than importing its private helpers. */
function refuseNonDevice(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.identity?.deviceId) {
    reply.code(403).send({ error: "device_token_required" });
    return true;
  }
  return false;
}

/** A Dongle or personal API token (an `outf_` token: viaToken without a device) never reads or
 * deletes hosts; a person under IAP or a signed-in Kernal may. */
function refuseOtherTokens(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.identity?.viaToken && !req.identity.deviceId) {
    reply.code(403).send({ error: "device_token_required" });
    return true;
  }
  return false;
}

/** A device token's own Device, or a refusal: gone or revoked is 404, a machine token (CI) 403
 * machine_token. A person (no deviceId) passes with `null`. */
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

/** Status of each TunnelCredentialsError code (§2.3). */
const CREDENTIALS_STATUS: Record<TunnelCredentialsError["code"], number> = {
  local_host_tunnels_off: 503,
  ngrok_failed: 502,
  host_unknown: 404,
  host_revoked: 403,
  sharing_off: 409,
  credentials_busy: 409,
};

/** True when the device was revoked while its request ran (the revoke hook may have finished
 * before this request wrote): the request's work is undone by revoking the host again. */
async function revokedMeanwhile(ctx: RouteContext, deviceId: string): Promise<boolean> {
  const device = await ctx.store.devices.findById(deviceId);
  return !device || Boolean(device.revokedAt);
}

export async function registerLocalHostRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const role = ctx.config.role;
  const deps = (req: FastifyRequest): LocalHostDeps => ({
    store: ctx.store,
    ngrok: ctx.localHostNgrok,
    config: ctx.config,
    secretAdmin: ctx.secretAdmin,
    events: ctx.localHostEvents,
    log: (msg, detail) => req.log.warn(detail ?? {}, msg),
  });

  if (role !== "web") {
    app.post("/api/local-hosts/heartbeat", { bodyLimit: MAX_BODY_BYTES }, async (req, reply) => {
      if (refuseNonDevice(req, reply)) return;
      const device = await deviceOrRefuse(ctx, req, reply);
      if (!device) return;
      let hb;
      try {
        hb = parseHeartbeat(req.body);
      } catch (err) {
        if (err instanceof HeartbeatInvalid) return reply.code(400).send({ error: "invalid_heartbeat", field: err.field });
        throw err;
      }
      try {
        const answer = await recordHeartbeat(deps(req), { email: req.identity!.email, deviceId: device.id }, hb);
        if (await revokedMeanwhile(ctx, device.id)) {
          const host = await ctx.store.localHosts.findById(answer.id);
          if (host && host.deviceId === device.id) await revokeLocalHost(deps(req), host);
          return reply.code(404).send({ error: "device not found" });
        }
        reply.header("cache-control", "no-store");
        return answer;
      } catch (err) {
        if (err instanceof RouterPrefixUnavailable) return reply.code(409).send({ error: "router_prefix_taken" });
        throw err;
      }
    });

    // POST, not GET: the answer carries an authtoken and the bearer; it must never be cached, and
    // its body is never logged.
    app.post("/api/local-hosts/tunnel-credentials", { bodyLimit: MAX_BODY_BYTES }, async (req, reply) => {
      if (refuseNonDevice(req, reply)) return;
      const device = await deviceOrRefuse(ctx, req, reply);
      if (!device) return;
      const hostId = (req.body as { hostId?: unknown } | undefined)?.hostId;
      if (typeof hostId !== "string" || !HOST_ID_RE.test(hostId)) return reply.code(400).send({ error: "invalid_request", field: "hostId" });
      if (!provisioningOn({ ngrok: ctx.localHostNgrok, config: ctx.config })) return reply.code(503).send({ error: "local_host_tunnels_off" });
      // The id derives from the caller, so another user's record can't be addressed.
      const host = await ctx.store.localHosts.findById(localHostId(userIdFor(req.identity!.email), hostId));
      if (!host || host.deletedAt) return reply.code(404).send({ error: "host_unknown" });
      if (host.revokedAt) return reply.code(403).send({ error: "host_revoked" });
      if (!host.shareModels) return reply.code(409).send({ error: "sharing_off" });
      try {
        const answer = await issueTunnelCredentials(deps(req), host);
        if (await revokedMeanwhile(ctx, device.id)) {
          // Never hand a just-revoked device a working credential: revoking the host deletes it.
          const now = await ctx.store.localHosts.findById(host.id);
          if (now?.deviceId === device.id) await revokeLocalHost(deps(req), now);
          else if (now) await retireIssued(deps(req), now, answer.credentialId);
          return reply.code(404).send({ error: "device not found" });
        }
        req.log.info({ id: host.id, credentialId: answer.credentialId }, "local host tunnel credentials issued");
        reply.header("cache-control", "no-store");
        return answer;
      } catch (err) {
        if (err instanceof TunnelCredentialsError) {
          return reply.code(CREDENTIALS_STATUS[err.code]).send({ error: err.code });
        }
        throw err;
      }
    });
  }

  app.get("/api/local-hosts", async (req, reply) => {
    if (refuseOtherTokens(req, reply)) return;
    if ((await deviceOrRefuse(ctx, req, reply)) === undefined) return;
    reply.header("cache-control", "no-store");
    return listLocalHosts({ store: ctx.store }, req.identity!.email);
  });

  app.delete<{ Params: { id: string } }>("/api/local-hosts/:id", async (req, reply) => {
    if (refuseOtherTokens(req, reply)) return;
    if ((await deviceOrRefuse(ctx, req, reply)) === undefined) return;
    const { id } = req.params;
    const found = LOCAL_HOST_ID_RE.test(id) ? await ctx.store.localHosts.findById(id) : null;
    const host = found && !found.deletedAt ? found : null; // a tombstone is already deleted
    const identity = req.identity!;
    const mayDelete = host && (host.userId === userIdFor(identity.email) || (role !== "link" && identity.operator));
    if (!host || !mayDelete) return reply.code(404).send({ error: "not found" });
    await deleteLocalHost(deps(req), host);
    req.log.info({ id: host.id, by: identity.deviceId ? "device" : identity.operator && host.userId !== userIdFor(identity.email) ? "operator" : "owner" }, "local host deleted");
    return reply.code(204).send();
  });
}
