// #383 Local Host tunnel credentials (docs/specs/local-host.md §2) against FakeNgrok: the credential
// ACL, the cloud endpoint's URL and metadata, both traffic policies, the bearer (stable across
// refetches, in Secret Manager only), clean-up on revoke/delete/sharing off, the sweep's idle and
// orphan rules, rollback on failure, and the off switch.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { userIdFor } from "../src/central/user-id.ts";
import { LocalHostEvents, type LocalHostChange } from "../src/local-hosts/events.ts";
import { bearerHash, bearerSecretName, internalUrl, localHostId } from "../src/local-hosts/naming.ts";
import { LOCAL_HOST_ALLOW_PATHS, type HeartbeatRequest } from "../src/local-hosts/contract.ts";
import { localHostDeviceHook, recordHeartbeat, deleteLocalHost, type LocalHostDeps } from "../src/local-hosts/registry.ts";
import {
  TunnelCredentialsError,
  cloudPolicy,
  internalPolicy,
  issueTunnelCredentials,
  localHostTunnelListener,
} from "../src/local-hosts/tunnel-credentials.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { MemorySecretAdmin } from "../src/secrets.ts";
import { NgrokApiError } from "../src/ngrok-api.ts";
import { FakeNgrok } from "./fake-ngrok.ts";

const EMAIL = "mgm@example.com";
const HOST_ID = "h_3f9c0a1b2c3d4e5f60718293";
const LMS = "http://localhost:1234";
const T0 = new Date("2026-10-05T12:00:00.000Z");
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
    reason: "change",
    ...overrides,
  };
}

function harness(opts: { domain?: string; ngrok?: boolean } = {}) {
  const store = new MemoryStore();
  const events = new LocalHostEvents();
  const changes: LocalHostChange[] = [];
  events.register({ name: "spy", async onChange(c) { changes.push(c); } });
  const ngrok = new FakeNgrok();
  const secrets = new MemorySecretAdmin();
  const clock = { now: T0 };
  const logs: string[] = [];
  const deps: LocalHostDeps = {
    store,
    ngrok: opts.ngrok === false ? undefined : ngrok,
    config: { localHostDomain: opts.domain ?? "kernal.run", previewEnv: "test" },
    secretAdmin: secrets,
    events,
    log: (msg, detail) => logs.push(`${msg} ${JSON.stringify(detail ?? {})}`),
    now: () => clock.now,
  };
  const host = async () => (await store.localHosts.findById(ID))!;
  return { deps, store, ngrok, secrets, changes, clock, logs, host };
}

async function registered(h: ReturnType<typeof harness>, o: Partial<HeartbeatRequest> = {}) {
  await recordHeartbeat(h.deps, { email: EMAIL, deviceId: "dev_a" }, heartbeat(o));
  return h.host();
}

const meta = (raw: string | undefined) => JSON.parse(raw ?? "{}");

describe("issueTunnelCredentials (§2.3)", () => {
  test("mints a credential bound to the host's internal endpoint and an api-owned cloud endpoint", async () => {
    const h = harness();
    const answer = await issueTunnelCredentials(h.deps, await registered(h));

    const [cred] = [...h.ngrok.credentials.values()];
    assert.deepEqual(cred.acl, [`bind:${ID.replace("lh_", "lh")}.internal`]);
    assert.equal(cred.description, `outfitter local host ${ID}`);
    assert.deepEqual(meta(cred.metadata), { purpose: "outfitter-local-host", env: "test", id: ID, userId: userIdFor(EMAIL), createdAt: T0.toISOString() });

    const [ep] = [...h.ngrok.endpoints.values()];
    assert.match(ep.url, /^https:\/\/lh-[a-z2-7]{26}\.kernal\.run$/);
    assert.equal(meta(ep.metadata).purpose, "outfitter-local-host");
    assert.equal(meta(ep.metadata).env, "test");

    assert.equal(answer.provider, "ngrok");
    assert.equal(answer.authtoken, `tok_${cred.id}`);
    assert.equal(answer.credentialId, cred.id);
    assert.equal(answer.url, internalUrl(ID));
    assert.equal(answer.publicUrl, ep.url);
    assert.match(answer.bearer, /^lhb_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(answer.allowPaths, [...LOCAL_HOST_ALLOW_PATHS]);
    assert.deepEqual(answer.rateLimit, { requests: 120, windowSeconds: 60 });
    assert.equal(answer.issuedAt, T0.toISOString());
    assert.equal(answer.expiresAt, "2026-10-12T12:00:00.000Z");
    assert.equal(answer.trafficPolicy, internalPolicy(answer.bearer));

    const rec = await h.host();
    assert.deepEqual(rec.managed, {
      credentialId: cred.id,
      credentialIssuedAt: T0.toISOString(),
      endpointId: ep.id,
      publicUrl: ep.url,
      bearerSecret: bearerSecretName(ID),
      bearerVersion: 1,
      bearerHash: bearerHash(answer.bearer),
    });
    const last = h.changes.at(-1)!;
    assert.equal(last.reason, "credentials");
    assert.equal(last.host.managed?.publicUrl, ep.url);
  });

  test("the bearer is in Secret Manager only: never in Mongo, metadata or descriptions", async () => {
    const h = harness();
    const answer = await issueTunnelCredentials(h.deps, await registered(h));
    assert.equal(await h.secrets.accessLatest(bearerSecretName(ID)), answer.bearer);
    assert.ok(!JSON.stringify(await h.host()).includes(answer.bearer));
    for (const c of h.ngrok.credentials.values()) assert.ok(!JSON.stringify(c).includes(answer.bearer));
    for (const e of h.ngrok.endpoints.values()) {
      assert.ok(!`${e.metadata}${e.description}${e.url}`.includes(answer.bearer));
      assert.ok(e.trafficPolicy.includes(answer.bearer), "the cloud policy checks it");
    }
    assert.ok(!h.logs.join("\n").includes(answer.bearer));
  });

  test("a refetch keeps the bearer and the endpoint, re-mints the credential and deletes the old one", async () => {
    const h = harness();
    const first = await issueTunnelCredentials(h.deps, await registered(h));
    const changesBefore = h.changes.length;
    h.clock.now = new Date(T0.getTime() + 60_000);
    const second = await issueTunnelCredentials(h.deps, await h.host());
    assert.equal(second.bearer, first.bearer);
    assert.equal(second.publicUrl, first.publicUrl);
    assert.notEqual(second.credentialId, first.credentialId);
    assert.deepEqual(h.ngrok.deletedCredentials, [first.credentialId]);
    assert.equal(h.ngrok.endpoints.size, 1);
    assert.equal((await h.host()).managed?.bearerVersion, 1);
    assert.equal(h.changes.length, changesBefore, "nothing the router uses changed");
  });

  test("a bearer Secret Manager lost is re-minted with a new version and a new endpoint", async () => {
    const h = harness();
    const first = await issueTunnelCredentials(h.deps, await registered(h));
    await h.secrets.disableAllEnabled(bearerSecretName(ID));
    const firstEndpoint = (await h.host()).managed!.endpointId!;
    const second = await issueTunnelCredentials(h.deps, await h.host());
    assert.notEqual(second.bearer, first.bearer);
    assert.notEqual(second.publicUrl, first.publicUrl);
    assert.equal((await h.host()).managed?.bearerVersion, 2);
    assert.ok(h.ngrok.deletedEndpoints.includes(firstEndpoint), "the endpoint holding the old bearer goes");
    assert.equal(h.changes.at(-1)?.reason, "credentials");
  });

  test("off without a domain or an ngrok client", async () => {
    for (const h of [harness({ domain: "" }), harness({ ngrok: false })]) {
      await assert.rejects(issueTunnelCredentials(h.deps, await registered(h)), (err: unknown) => err instanceof TunnelCredentialsError && err.code === "local_host_tunnels_off");
    }
  });

  test("an endpoint failure rolls back the new credential and the new bearer, and says ngrok_failed", async () => {
    const h = harness();
    h.ngrok.failCreateEndpoint = true;
    await assert.rejects(issueTunnelCredentials(h.deps, await registered(h)), (err: unknown) => err instanceof TunnelCredentialsError && err.code === "ngrok_failed" && !/lhb_/.test(err.message));
    assert.equal(h.ngrok.credentials.size, 0, "the new credential is deleted");
    assert.equal(await h.secrets.accessLatest(bearerSecretName(ID)), undefined, "the new bearer is disabled");
    assert.equal((await h.host()).managed, undefined);
  });

  test("an ngrok error that quotes the policy never puts the bearer in the logs", async () => {
    const h = harness();
    h.ngrok.createCloudEndpoint = async (input) => {
      const bearer = /lhb_[A-Za-z0-9_-]{43}/.exec(input.trafficPolicy)![0];
      throw new NgrokApiError(400, "ERR_NGROK_18002", `failed to compile expression 'Bearer ${bearer}'`);
    };
    await assert.rejects(issueTunnelCredentials(h.deps, await registered(h)), TunnelCredentialsError);
    assert.ok(h.logs.some((l) => l.includes("lhb_[redacted]")), h.logs.join("\n"));
    assert.ok(!h.logs.some((l) => /lhb_[A-Za-z0-9_-]{43}/.test(l)));
  });

  test("a failure on refetch leaves the laptop's current credential working", async () => {
    const h = harness();
    const first = await issueTunnelCredentials(h.deps, await registered(h));
    h.ngrok.createCredential = async () => { throw new NgrokApiError(429, "ERR_NGROK_RATE", "slow down"); };
    await assert.rejects(issueTunnelCredentials(h.deps, await h.host()), TunnelCredentialsError);
    assert.ok(h.ngrok.credentials.has(first.credentialId));
    assert.equal((await h.host()).managed?.credentialId, first.credentialId);
    assert.equal(await h.secrets.accessLatest(bearerSecretName(ID)), first.bearer, "an existing bearer is never disabled by a rollback");
  });
});

describe("traffic policies (§2.4)", () => {
  const bearer = "lhb_" + "A".repeat(43);
  test("cloud: rate limit, bearer, paths, forward-internal, response headers, in that order", () => {
    const p = JSON.parse(cloudPolicy(ID, bearer));
    const rules = p.on_http_request;
    assert.equal(rules.length, 4);
    assert.deepEqual(rules[0].actions[0], {
      type: "rate-limit",
      config: { name: "outfitter-local-host", algorithm: "sliding_window", capacity: 120, rate: "60s", bucket_key: ["conn.client_ip"] },
    });
    assert.deepEqual(rules[1].expressions, [`!('authorization' in req.headers) || req.headers['authorization'][0] != 'Bearer ${bearer}'`]);
    assert.deepEqual(rules[1].actions, [{ type: "deny", config: { status_code: 401 } }]);
    assert.deepEqual(rules[2].expressions, ["!(req.url.path in ['/v1/chat/completions', '/v1/completions', '/v1/embeddings', '/v1/models'])"]);
    assert.equal(rules[2].actions[0].config.status_code, 404);
    assert.deepEqual(JSON.parse(rules[2].actions[0].config.body), { error: { message: "not found", type: "not_found" } });
    assert.deepEqual(rules[3].actions, [{ type: "forward-internal", config: { url: internalUrl(ID) } }]);
    assert.deepEqual(p.on_http_response[0].actions[0].config.headers, { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" });
  });

  test("internal: the bearer and paths again, no rate limit, no forward", () => {
    const p = JSON.parse(internalPolicy(bearer));
    assert.equal(p.on_http_request.length, 2);
    assert.equal(p.on_http_request[0].actions[0].type, "deny");
    assert.equal(p.on_http_request[1].actions[0].type, "custom-response");
    assert.ok(!JSON.stringify(p).includes("rate-limit"));
    assert.equal(p.on_http_response, undefined);
  });

  test("a bearer that could break out of the expression is refused", () => {
    for (const bad of ["lhb_short", "lhb_" + "A".repeat(42) + "'", "Bearer x' || true || '", "lhb_" + "A".repeat(44)]) {
      assert.throws(() => cloudPolicy(ID, bad));
      assert.throws(() => internalPolicy(bad));
    }
  });
});

describe("clean-up (§2.5)", () => {
  test("device revoked: credential, endpoint and bearer go; the next credentials call mints bearerVersion + 1", async () => {
    const h = harness();
    const first = await issueTunnelCredentials(h.deps, await registered(h));
    const managed = (await h.host()).managed!;
    await localHostDeviceHook(h.deps).onRevoked!({ device: { id: "dev_a", userId: userIdFor(EMAIL), ownerEmail: EMAIL, name: "mbp" }, reason: "logout" });
    assert.ok(h.ngrok.deletedCredentials.includes(managed.credentialId));
    assert.ok(h.ngrok.deletedEndpoints.includes(managed.endpointId!));
    assert.equal(await h.secrets.accessLatest(bearerSecretName(ID)), undefined);
    assert.equal((await h.host()).managed, undefined);

    const back = await recordHeartbeat(h.deps, { email: EMAIL, deviceId: "dev_b" }, heartbeat());
    assert.equal(back.credentials, "fetch");
    const again = await issueTunnelCredentials(h.deps, await h.host());
    assert.notEqual(again.bearer, first.bearer);
    const remade = (await h.host()).managed!;
    assert.equal(remade.bearerVersion, 2, "monotonic across the revoke");
    assert.equal(remade.bearerSecret, managed.bearerSecret, "the same secret, a new version");
    assert.equal(remade.bearerHash, bearerHash(again.bearer));
    assert.notEqual(remade.bearerHash, managed.bearerHash);
    assert.equal((await h.host()).retiredBearerVersion, undefined);
  });

  test("host deleted: everything goes", async () => {
    const h = harness();
    await issueTunnelCredentials(h.deps, await registered(h));
    await deleteLocalHost(h.deps, await h.host());
    assert.equal(h.ngrok.credentials.size, 0);
    assert.equal(h.ngrok.endpoints.size, 0);
    assert.equal(await h.secrets.accessLatest(bearerSecretName(ID)), undefined);
  });

  test("sharing off: the endpoint goes, the credential stays; sharing on again makes a new endpoint, same bearer", async () => {
    const h = harness();
    const first = await issueTunnelCredentials(h.deps, await registered(h));
    await recordHeartbeat(h.deps, { email: EMAIL, deviceId: "dev_a" }, heartbeat({ shareModels: false }));
    assert.equal(h.ngrok.endpoints.size, 0);
    assert.equal(h.ngrok.credentials.size, 1);
    const back = await recordHeartbeat(h.deps, { email: EMAIL, deviceId: "dev_a" }, heartbeat({ tunnel: { ...heartbeat().tunnel, credentialId: first.credentialId } }));
    assert.equal(back.credentials, "fetch");
    const again = await issueTunnelCredentials(h.deps, await h.host());
    assert.equal(again.bearer, first.bearer);
    assert.notEqual(again.publicUrl, first.publicUrl);
  });
});

describe("the tunnel listener's sweep (§2.5)", () => {
  test("deletes a stale host's endpoint after 24 h idle, not before", async () => {
    const h = harness();
    await issueTunnelCredentials(h.deps, await registered(h));
    const sweep = localHostTunnelListener(h.deps).sweep!;
    const day = 24 * 3600_000;
    assert.deepEqual(await sweep(new Date(T0.getTime() + 960_000 + day - 1000)), { endpointsIdle: 0, endpointsOrphaned: 0, credentialsOrphaned: 0 });
    assert.deepEqual(await sweep(new Date(T0.getTime() + 961_000 + day)), { endpointsIdle: 1, endpointsOrphaned: 0, credentialsOrphaned: 0 });
    const rec = await h.host();
    assert.equal(rec.managed?.endpointId, undefined);
    assert.equal(rec.managed?.publicUrl, undefined);
    assert.ok(rec.managed?.credentialId);
  });

  test("deletes our unreferenced endpoints and credentials past the grace; never others' or fresh ones", async () => {
    const h = harness();
    await issueTunnelCredentials(h.deps, await registered(h));
    const old = new Date(T0.getTime() - 10 * 60_000).toISOString();
    const mk = (m: Record<string, unknown>) => JSON.stringify(m);
    const orphanEp = await h.ngrok.createCloudEndpoint({ url: "https://lh-orphan.kernal.run", trafficPolicy: "{}", description: "x", metadata: mk({ purpose: "outfitter-local-host", env: "test", id: "lh_gone", createdAt: old }) });
    const freshEp = await h.ngrok.createCloudEndpoint({ url: "https://lh-fresh.kernal.run", trafficPolicy: "{}", description: "x", metadata: mk({ purpose: "outfitter-local-host", env: "test", id: "lh_new", createdAt: T0.toISOString() }) });
    const previewEp = await h.ngrok.createCloudEndpoint({ url: "https://p.kernal.run", trafficPolicy: "{}", description: "x", metadata: mk({ purpose: "outfitter-preview", env: "test", createdAt: old }) });
    const otherEnvEp = await h.ngrok.createCloudEndpoint({ url: "https://lh-o.kernal.run", trafficPolicy: "{}", description: "x", metadata: mk({ purpose: "outfitter-local-host", env: "prod", createdAt: old }) });
    const handEp = await h.ngrok.createCloudEndpoint({ url: "https://mine.kernal.run", trafficPolicy: "{}", description: "x", metadata: "" });
    const orphanCred = await h.ngrok.createCredential({ description: "x", metadata: mk({ purpose: "outfitter-local-host", env: "test", createdAt: old }), acl: [] });
    const previewCred = await h.ngrok.createCredential({ description: "x", metadata: mk({ purpose: "outfitter-preview", env: "test", runId: "r", createdAt: old }), acl: [] });

    const counts = await localHostTunnelListener(h.deps).sweep!(new Date(T0.getTime() + 60_000));
    assert.deepEqual(counts, { endpointsIdle: 0, endpointsOrphaned: 1, credentialsOrphaned: 1 });
    assert.deepEqual(h.ngrok.deletedEndpoints, [orphanEp.id]);
    assert.deepEqual(h.ngrok.deletedCredentials, [orphanCred.id]);
    for (const kept of [freshEp, previewEp, otherEnvEp, handEp]) assert.ok(h.ngrok.endpoints.has(kept.id));
    assert.ok(h.ngrok.credentials.has(previewCred.id));
    const managed = (await h.host()).managed!;
    assert.ok(h.ngrok.endpoints.has(managed.endpointId!), "the referenced endpoint stays");
    assert.ok(h.ngrok.credentials.has(managed.credentialId), "the referenced credential stays");
  });

  test("without an ngrok client the sweep does nothing and reports no counts", async () => {
    const h = harness({ ngrok: false });
    assert.equal(await localHostTunnelListener(h.deps).sweep!(T0), undefined);
  });
});
