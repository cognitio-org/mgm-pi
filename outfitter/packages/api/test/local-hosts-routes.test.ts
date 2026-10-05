// #382/#383 Local Host routes (docs/specs/local-host.md §1.1): which roles register what, the
// device-token-only refusals, the body limit, and the whole flow through Fastify (heartbeat,
// credentials, listing, delete, device revoke) with FakeNgrok standing in for ngrok.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedDongle, type TestApp } from "./helpers.ts";
import { FakeNgrok } from "./fake-ngrok.ts";
import { hashToken, newAccessToken } from "../src/central/device-tokens.ts";
import { userIdFor } from "../src/central/user-id.ts";
import { internalUrl, localHostId } from "../src/local-hosts/naming.ts";
import type { HeartbeatRequest } from "../src/local-hosts/contract.ts";
import type { Device } from "../src/store/devices.ts";

const EMAIL = "mgm@example.com";
const HOST_ID = "h_3f9c0a1b2c3d4e5f60718293";
const LMS = "http://localhost:1234";
const ID = localHostId(userIdFor(EMAIL), HOST_ID);

function heartbeat(overrides: Partial<HeartbeatRequest> = {}): HeartbeatRequest {
  return {
    hostId: HOST_ID,
    hostName: "Matthews-MacBook-Pro",
    kernalVersion: "0.4.1",
    platform: "darwin-arm64",
    shareModels: true,
    discoveryKey: "k1",
    servers: [{ id: LMS, kind: "lmstudio", baseUrl: `${LMS}/v1`, ok: true, endpoints: ["/v1/models"], models: 1 }],
    models: [{ id: "qwen/qwen3-coder-30b", server: LMS, kind: "lmstudio", loaded: true }],
    tunnel: { provider: "ngrok", managed: true, state: "up", url: internalUrl(ID), server: LMS },
    reason: "start",
    ...overrides,
  };
}

/** A device row whose access token works, as the device-code login would leave it. */
async function seedDevice(app: TestApp, email = EMAIL, overrides: Partial<Device> = {}): Promise<{ token: string; device: Device }> {
  const token = newAccessToken();
  const device: Device = {
    id: `dev_${Math.random().toString(36).slice(2, 18).padEnd(16, "a")}`,
    userId: userIdFor(email),
    ownerEmail: email,
    name: "mbp",
    kind: "laptop",
    createdAt: new Date().toISOString(),
    approvedBy: email,
    accessHash: hashToken(token),
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
  await app.store.devices.insert(device);
  return { token, device };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function linkApp(opts: { ngrok?: FakeNgrok; domain?: string } = {}) {
  return buildTestApp(
    { OUTFITTER_ROLE: "link", ...(opts.domain !== undefined ? { LOCAL_HOST_DOMAIN: opts.domain } : {}) },
    opts.ngrok ? { ngrok: opts.ngrok } : {},
  );
}

describe("roles and refusals (§1.1)", () => {
  test("web registers GET and DELETE only; the POST routes are link/all", async () => {
    const web = await buildTestApp({ OUTFITTER_ROLE: "web" });
    assert.equal((await web.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", payload: heartbeat() })).statusCode, 404);
    assert.equal((await web.fastify.inject({ method: "POST", url: "/api/local-hosts/tunnel-credentials", payload: { hostId: HOST_ID } })).statusCode, 404);
    const list = await web.fastify.inject({ method: "GET", url: "/api/local-hosts" });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), { hosts: [] });
    await web.fastify.close();
  });

  test("a person (IAP / dev identity) on a POST route: 403 device_token_required", async () => {
    const all = await buildTestApp({ OUTFITTER_ROLE: "all" });
    for (const url of ["/api/local-hosts/heartbeat", "/api/local-hosts/tunnel-credentials"]) {
      const res = await all.fastify.inject({ method: "POST", url, payload: heartbeat() });
      assert.equal(res.statusCode, 403, url);
      assert.deepEqual(res.json(), { error: "device_token_required" });
    }
    await all.fastify.close();
  });

  test("a Dongle: 403 device_token_required on every route", async () => {
    const app = await linkApp();
    const { token } = await seedDongle(app.store, EMAIL);
    for (const [method, url] of [["POST", "/api/local-hosts/heartbeat"], ["POST", "/api/local-hosts/tunnel-credentials"], ["GET", "/api/local-hosts"], ["DELETE", `/api/local-hosts/${ID}`]] as const) {
      const res = await app.fastify.inject({ method, url, headers: auth(token), ...(method === "POST" ? { payload: heartbeat() } : {}) });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
      assert.deepEqual(res.json(), { error: "device_token_required" });
    }
    await app.fastify.close();
  });

  test("a machine token (CI): 403 machine_token", async () => {
    const app = await linkApp();
    const { token } = await seedDevice(app, EMAIL, { kind: "machine" });
    const res = await app.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", headers: auth(token), payload: heartbeat() });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "machine_token" });
    await app.fastify.close();
  });

  test("no token on link: 401", async () => {
    const app = await linkApp();
    assert.equal((await app.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", payload: heartbeat() })).statusCode, 401);
    await app.fastify.close();
  });

  test("a body over 256 KiB is 413; a bad one 400 with the field", async () => {
    const app = await linkApp();
    const { token } = await seedDevice(app);
    const big = await app.fastify.inject({
      method: "POST",
      url: "/api/local-hosts/heartbeat",
      headers: { ...auth(token), "content-type": "application/json" },
      payload: JSON.stringify({ ...heartbeat(), pad: "x".repeat(256 * 1024) }),
    });
    assert.equal(big.statusCode, 413);
    const bad = await app.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", headers: auth(token), payload: { ...heartbeat(), hostId: "nope" } });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(bad.json(), { error: "invalid_heartbeat", field: "hostId" });
    await app.fastify.close();
  });
});

describe("the flow through the routes", () => {
  test("heartbeat, credentials, listing, delete", async () => {
    const ngrok = new FakeNgrok();
    const app = await linkApp({ ngrok, domain: "kernal.run" });
    const { token, device } = await seedDevice(app);

    const hb = await app.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", headers: auth(token), payload: heartbeat() });
    assert.equal(hb.statusCode, 200, hb.body);
    const answer = hb.json();
    assert.equal(answer.id, ID);
    assert.equal(answer.credentials, "fetch");
    assert.equal(answer.status, "online");
    assert.equal(hb.headers["cache-control"], "no-store");
    assert.equal((await app.store.localHosts.findById(ID))!.deviceId, device.id);

    const cr = await app.fastify.inject({ method: "POST", url: "/api/local-hosts/tunnel-credentials", headers: auth(token), payload: { hostId: HOST_ID } });
    assert.equal(cr.statusCode, 200, cr.body);
    assert.equal(cr.headers["cache-control"], "no-store");
    const creds = cr.json();
    assert.match(creds.bearer, /^lhb_/);
    assert.match(creds.publicUrl, /^https:\/\/lh-[a-z2-7]{26}\.kernal\.run$/);

    const again = await app.fastify.inject({
      method: "POST",
      url: "/api/local-hosts/heartbeat",
      headers: auth(token),
      payload: heartbeat({ reason: "change", tunnel: { ...heartbeat().tunnel, credentialId: creds.credentialId } }),
    });
    assert.equal(again.json().credentials, "current");
    assert.deepEqual(again.json().routerModels, ["local/mgm-matthews-macbook-pro/qwen/qwen3-coder-30b"]);

    const list = await app.fastify.inject({ method: "GET", url: "/api/local-hosts", headers: auth(token) });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().hosts.length, 1);
    assert.equal(list.json().hosts[0].owner.mine, true);
    for (const secret of [creds.bearer, creds.authtoken, creds.credentialId, creds.publicUrl, device.id]) assert.ok(!list.body.includes(secret));

    // Someone else's device can't delete it (404), the owner can (204).
    const other = await seedDevice(app, "ana@example.com");
    assert.equal((await app.fastify.inject({ method: "DELETE", url: `/api/local-hosts/${ID}`, headers: auth(other.token) })).statusCode, 404);
    assert.equal((await app.fastify.inject({ method: "DELETE", url: "/api/local-hosts/not-an-id", headers: auth(token) })).statusCode, 404);
    const del = await app.fastify.inject({ method: "DELETE", url: `/api/local-hosts/${ID}`, headers: auth(token) });
    assert.equal(del.statusCode, 204);
    assert.ok((await app.store.localHosts.findById(ID))!.deletedAt, "a tombstone stays");
    assert.equal(ngrok.endpoints.size, 0);
    assert.equal(ngrok.credentials.size, 0);
    // A tombstone: not listed, DELETE 404, credentials 404 host_unknown.
    assert.deepEqual((await app.fastify.inject({ method: "GET", url: "/api/local-hosts", headers: auth(token) })).json(), { hosts: [] });
    assert.equal((await app.fastify.inject({ method: "DELETE", url: `/api/local-hosts/${ID}`, headers: auth(token) })).statusCode, 404);
    const tombCreds = await app.fastify.inject({ method: "POST", url: "/api/local-hosts/tunnel-credentials", headers: auth(token), payload: { hostId: HOST_ID } });
    assert.equal(tombCreds.statusCode, 404);
    assert.deepEqual(tombCreds.json(), { error: "host_unknown" });
    // The laptop's next heartbeat revives it: same id and prefix, listed again; a new bearer gets
    // a higher version than the one before the delete.
    const revived = await app.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", headers: auth(token), payload: heartbeat() });
    assert.equal(revived.json().routerPrefix, answer.routerPrefix);
    assert.equal((await app.store.localHosts.findById(ID))!.deletedAt, undefined);
    assert.equal((await app.fastify.inject({ method: "GET", url: "/api/local-hosts", headers: auth(token) })).json().hosts.length, 1);
    const re = await app.fastify.inject({ method: "POST", url: "/api/local-hosts/tunnel-credentials", headers: auth(token), payload: { hostId: HOST_ID } });
    assert.equal(re.statusCode, 200);
    assert.equal((await app.store.localHosts.findById(ID))!.managed!.bearerVersion, 2);
    await app.fastify.close();
  });

  test("credentials refusals: unknown host 404, sharing off 409, revoked 403, provisioning off 503, bad body 400", async () => {
    const ngrok = new FakeNgrok();
    const app = await linkApp({ ngrok, domain: "kernal.run" });
    const { token } = await seedDevice(app);
    const creds = () => app.fastify.inject({ method: "POST", url: "/api/local-hosts/tunnel-credentials", headers: auth(token), payload: { hostId: HOST_ID } });
    assert.deepEqual((await creds()).json(), { error: "host_unknown" });
    await app.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", headers: auth(token), payload: heartbeat({ shareModels: false }) });
    const off = await creds();
    assert.equal(off.statusCode, 409);
    assert.deepEqual(off.json(), { error: "sharing_off" });
    await app.store.localHosts.update(ID, { shareModels: true, revokedAt: new Date().toISOString() });
    const revoked = await creds();
    assert.equal(revoked.statusCode, 403);
    assert.deepEqual(revoked.json(), { error: "host_revoked" });
    const bad = await app.fastify.inject({ method: "POST", url: "/api/local-hosts/tunnel-credentials", headers: auth(token), payload: { hostId: "x" } });
    assert.equal(bad.statusCode, 400);
    ngrok.failCreateEndpoint = true;
    await app.store.localHosts.update(ID, { revokedAt: undefined });
    const failed = await creds();
    assert.equal(failed.statusCode, 502);
    assert.deepEqual(failed.json(), { error: "ngrok_failed" });
    await app.fastify.close();

    const noDomain = await linkApp({ ngrok: new FakeNgrok(), domain: "" });
    const d = await seedDevice(noDomain);
    const hb = await noDomain.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", headers: auth(d.token), payload: heartbeat() });
    assert.equal(hb.json().credentials, "unavailable");
    const res = await noDomain.fastify.inject({ method: "POST", url: "/api/local-hosts/tunnel-credentials", headers: auth(d.token), payload: { hostId: HOST_ID } });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: "local_host_tunnels_off" });
    await noDomain.fastify.close();
  });

  test("an operator on web may delete anyone's host; another person may not", async () => {
    const ngrok = new FakeNgrok();
    const link = await linkApp({ ngrok, domain: "kernal.run" });
    const { token } = await seedDevice(link);
    await link.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", headers: auth(token), payload: heartbeat() });
    // Dev mode on web: the caller is dev@localhost, an operator.
    const web = await buildTestApp({ OUTFITTER_ROLE: "web" }, { store: link.store, ngrok });
    const listed = await web.fastify.inject({ method: "GET", url: "/api/local-hosts" });
    assert.equal(listed.json().hosts.length, 1, "dev@localhost sees the shared host");
    assert.equal(listed.json().hosts[0].owner.mine, false);
    const del = await web.fastify.inject({ method: "DELETE", url: `/api/local-hosts/${ID}` });
    assert.equal(del.statusCode, 204);
    assert.ok((await link.store.localHosts.findById(ID))!.deletedAt);
    await web.fastify.close();
    await link.fastify.close();
  });

  test("revoking the device (through the lifecycle) marks its hosts revoked", async () => {
    const ngrok = new FakeNgrok();
    const app = await buildTestApp({ OUTFITTER_ROLE: "all", LOCAL_HOST_DOMAIN: "kernal.run" }, { ngrok });
    const { token, device } = await seedDevice(app);
    await app.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", headers: auth(token), payload: heartbeat() });
    await app.fastify.inject({ method: "POST", url: "/api/local-hosts/tunnel-credentials", headers: auth(token), payload: { hostId: HOST_ID } });
    // RFC 7009 revoke of its own token (kernal logout) fires DeviceLifecycle.revoked.
    const out = await app.fastify.inject({ method: "POST", url: "/api/device/revoke", headers: auth(token), payload: { token } });
    assert.ok(out.statusCode < 300, out.body);
    const rec = (await app.store.localHosts.findById(ID))!;
    assert.ok(rec.revokedAt);
    assert.equal(rec.managed, undefined);
    assert.equal(ngrok.endpoints.size, 0);
    assert.equal(ngrok.credentials.size, 0);
    assert.ok((await app.store.devices.findById(device.id))!.revokedAt);
    await app.fastify.close();
  });

  test("a device revoked while its credentials call runs gets 404 and no working credential", async () => {
    const ngrok = new FakeNgrok();
    const app = await linkApp({ ngrok, domain: "kernal.run" });
    const { token, device } = await seedDevice(app);
    await app.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", headers: auth(token), payload: heartbeat() });
    const realCreate = ngrok.createCloudEndpoint.bind(ngrok);
    ngrok.createCloudEndpoint = async (input) => {
      await app.store.devices.revoke(device.id, "revoked", new Date().toISOString());
      return realCreate(input);
    };
    const res = await app.fastify.inject({ method: "POST", url: "/api/local-hosts/tunnel-credentials", headers: auth(token), payload: { hostId: HOST_ID } });
    assert.equal(res.statusCode, 404);
    assert.ok(!res.body.includes("lhb_"));
    const rec = (await app.store.localHosts.findById(ID))!;
    assert.ok(rec.revokedAt);
    assert.equal(rec.managed, undefined);
    assert.equal(ngrok.credentials.size, 0);
    assert.equal(ngrok.endpoints.size, 0);
    await app.fastify.close();
  });

  test("a revoked device's credentials on a host another device took over: retired, the host not revoked", async () => {
    const ngrok = new FakeNgrok();
    const app = await linkApp({ ngrok, domain: "kernal.run" });
    const { token, device } = await seedDevice(app);
    await app.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", headers: auth(token), payload: heartbeat() });
    const realCreate = ngrok.createCloudEndpoint.bind(ngrok);
    ngrok.createCloudEndpoint = async (input) => {
      await app.store.localHosts.update(ID, { deviceId: "dev_newer_login" });
      await app.store.devices.revoke(device.id, "revoked", new Date().toISOString());
      return realCreate(input);
    };
    const res = await app.fastify.inject({ method: "POST", url: "/api/local-hosts/tunnel-credentials", headers: auth(token), payload: { hostId: HOST_ID } });
    assert.equal(res.statusCode, 404);
    const rec = (await app.store.localHosts.findById(ID))!;
    assert.equal(rec.revokedAt, undefined, "the newer device's host stays");
    assert.equal(rec.managed, undefined, "what the revoked device was handed is gone");
    assert.equal(ngrok.credentials.size, 0);
    assert.equal(ngrok.endpoints.size, 0);
    await app.fastify.close();
  });

  test("a heartbeat racing its device's revoke doesn't un-revoke the host", async () => {
    const ngrok = new FakeNgrok();
    const app = await linkApp({ ngrok, domain: "kernal.run" });
    const { token, device } = await seedDevice(app);
    await app.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", headers: auth(token), payload: heartbeat() });
    // The revoke lands (device row and host record) after the route checked the device but
    // before the heartbeat wrote.
    const realFind = app.store.localHosts.findById.bind(app.store.localHosts);
    let raced = false;
    app.store.localHosts.findById = async (id) => {
      if (!raced) {
        raced = true;
        await app.store.devices.revoke(device.id, "revoked", new Date().toISOString());
        await app.store.localHosts.update(ID, { revokedAt: new Date().toISOString() });
      }
      return realFind(id);
    };
    const res = await app.fastify.inject({ method: "POST", url: "/api/local-hosts/heartbeat", headers: auth(token), payload: heartbeat({ reason: "interval" }) });
    assert.equal(res.statusCode, 404);
    assert.ok((await realFind(ID))!.revokedAt);
    await app.fastify.close();
  });

  test("the tick runs the tunnel listener's sweep", async () => {
    const ngrok = new FakeNgrok();
    const app = await buildTestApp({ OUTFITTER_ROLE: "all", LOCAL_HOST_DOMAIN: "kernal.run" }, { ngrok });
    const counts = await app.localHostEvents.sweep(new Date());
    assert.deepEqual(counts.tunnel, { endpointsIdle: 0, endpointsOrphaned: 0, credentialsOrphaned: 0 });
    await app.fastify.close();
  });
});
