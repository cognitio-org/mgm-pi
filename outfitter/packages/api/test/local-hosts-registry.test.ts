// #382 Local Host registry (docs/specs/local-host.md §1): heartbeat validation, record creation and
// takeover, router prefix collisions, status, the answer's credentials hint and routerModels,
// changed() only on a fingerprint change, the listing's filters and missing secrets, DELETE, and
// the LaptopProbe / resolveRunModel preflight for `local/...` names.

import { test, describe, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import assert from "node:assert/strict";
import { userIdFor } from "../src/central/user-id.ts";
import { LocalHostEvents, type LocalHostChange } from "../src/local-hosts/events.ts";
import { localHostId, internalUrl } from "../src/local-hosts/naming.ts";
import {
  HeartbeatInvalid,
  credentialsHint,
  deleteLocalHost,
  hostView,
  listLocalHosts,
  localHostDeviceHook,
  parseHeartbeat,
  recordHeartbeat,
  type LocalHostDeps,
} from "../src/local-hosts/registry.ts";
import type { HeartbeatRequest } from "../src/local-hosts/contract.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { MongoStore } from "../src/store/mongo.ts";
import { MemorySecretAdmin } from "../src/secrets.ts";
import { LaptopProbe, resolveRunModel } from "../src/laptop.ts";
import type { LocalHost } from "../src/store/local-hosts.ts";
import { FakeNgrok } from "./fake-ngrok.ts";

const EMAIL = "mgm@example.com";
const HOST_ID = "h_3f9c0a1b2c3d4e5f60718293";
const LMS = "http://localhost:1234";
const OLLAMA = "http://localhost:11434";
const T0 = new Date("2026-10-05T12:00:00.000Z");

function heartbeat(overrides: Partial<HeartbeatRequest> = {}): HeartbeatRequest {
  return {
    hostId: HOST_ID,
    hostName: "Matthews-MacBook-Pro",
    kernalVersion: "0.4.1",
    platform: "darwin-arm64",
    shareModels: true,
    discoveryKey: "9a1c2e3f4b5d6a7c",
    servers: [
      { id: LMS, kind: "lmstudio", baseUrl: `${LMS}/v1`, ok: true, endpoints: ["/api/v0/models", "/v1/models"], models: 2 },
      { id: OLLAMA, kind: "ollama", baseUrl: `${OLLAMA}/v1`, ok: true, endpoints: ["/api/tags"], models: 1 },
    ],
    models: [
      { id: "qwen/qwen3-coder-30b", server: LMS, kind: "lmstudio", loaded: true, listed: true, contextLength: 32768, type: "llm", toolUse: true, quantization: "4bit" },
      { id: "text-embedding-nomic", server: LMS, kind: "lmstudio", loaded: false, type: "embeddings" },
      { id: "llama3.2:3b", server: OLLAMA, kind: "ollama", loaded: false },
    ],
    tunnel: { provider: "ngrok", managed: true, state: "up", url: "https://lhx.internal", server: LMS, credentialId: "cr_1" },
    reason: "change",
    ...overrides,
  };
}

interface Harness {
  deps: LocalHostDeps;
  store: MemoryStore;
  changes: LocalHostChange[];
  ngrok: FakeNgrok;
  secrets: MemorySecretAdmin;
  clock: { now: Date };
}

function harness(opts: { provisioning?: boolean; problems?: string[] } = {}): Harness {
  const store = new MemoryStore();
  const events = new LocalHostEvents();
  const changes: LocalHostChange[] = [];
  events.register({
    name: "spy",
    async onChange(c) {
      changes.push(c);
      if (opts.problems?.length) throw new Error(opts.problems[0]);
    },
  });
  const ngrok = new FakeNgrok();
  const secrets = new MemorySecretAdmin();
  const clock = { now: T0 };
  const provisioning = opts.provisioning ?? true;
  const deps: LocalHostDeps = {
    store,
    ngrok: provisioning ? ngrok : undefined,
    config: { localHostDomain: provisioning ? "kernal.run" : "", previewEnv: "test" },
    secretAdmin: secrets,
    events,
    now: () => clock.now,
  };
  return { deps, store, changes, ngrok, secrets, clock };
}

const caller = (deviceId = "dev_a", email = EMAIL) => ({ email, deviceId });
const later = (h: Harness, seconds: number) => { h.clock.now = new Date(h.clock.now.getTime() + seconds * 1000); };

describe("heartbeat validation (§1.2)", () => {
  test("a good body parses, keeps the contract's fields and drops anything else", () => {
    const body = { ...heartbeat(), extra: "x", servers: [{ ...heartbeat().servers[0], secret: "s" }], models: [{ ...heartbeat().models[0], junk: 1 }] };
    const hb = parseHeartbeat(body);
    assert.equal((hb as unknown as Record<string, unknown>).extra, undefined);
    assert.equal((hb.servers[0] as unknown as Record<string, unknown>).secret, undefined);
    assert.equal((hb.models[0] as unknown as Record<string, unknown>).junk, undefined);
    assert.equal(hb.models[0].quantization, "4bit");
  });

  test("the host name is trimmed", () => {
    assert.equal(parseHeartbeat(heartbeat({ hostName: "  mbp  " })).hostName, "mbp");
  });

  const cases: Array<[string, unknown, string]> = [
    ["not an object", "nope", "body"],
    ["bad hostId", { ...heartbeat(), hostId: "h_XYZ" }, "hostId"],
    ["uppercase hostId", { ...heartbeat(), hostId: HOST_ID.toUpperCase().replace("H_", "h_") }, "hostId"],
    ["empty hostName", { ...heartbeat(), hostName: "   " }, "hostName"],
    ["long hostName", { ...heartbeat(), hostName: "x".repeat(65) }, "hostName"],
    ["control character", { ...heartbeat(), hostName: "mbp\u0007" }, "hostName"],
    ["long kernalVersion", { ...heartbeat(), kernalVersion: "1".repeat(33) }, "kernalVersion"],
    ["long platform", { ...heartbeat(), platform: "p".repeat(33) }, "platform"],
    ["shareModels not boolean", { ...heartbeat(), shareModels: "yes" }, "shareModels"],
    ["too many servers", { ...heartbeat(), servers: Array(17).fill(heartbeat().servers[0]) }, "servers"],
    ["too many models", { ...heartbeat(), models: Array(257).fill(heartbeat().models[0]) }, "models"],
    ["bad server kind", { ...heartbeat(), servers: [{ ...heartbeat().servers[0], kind: "triton" }] }, "servers[0].kind"],
    ["bad model kind", { ...heartbeat(), models: [heartbeat().models[0], { ...heartbeat().models[1], kind: "x" }] }, "models[1].kind"],
    ["negative number", { ...heartbeat(), models: [{ ...heartbeat().models[0], contextLength: -1 }] }, "models[0].contextLength"],
    ["infinite number", { ...heartbeat(), models: [{ ...heartbeat().models[0], contextLength: Infinity }] }, "models[0].contextLength"],
    ["long string", { ...heartbeat(), models: [{ ...heartbeat().models[0], id: "m".repeat(513) }] }, "models[0].id"],
    ["bad provider", { ...heartbeat(), tunnel: { ...heartbeat().tunnel, provider: "tailscale" } }, "tunnel.provider"],
    ["bad tunnel state", { ...heartbeat(), tunnel: { ...heartbeat().tunnel, state: "busy" } }, "tunnel.state"],
    ["bad reason", { ...heartbeat(), reason: "busy" }, "reason"],
    ["missing tunnel", { ...heartbeat(), tunnel: undefined }, "tunnel"],
  ];
  for (const [name, body, field] of cases) {
    test(`refuses ${name} (field ${field})`, () => {
      assert.throws(() => parseHeartbeat(body), (err: unknown) => err instanceof HeartbeatInvalid && err.field === field);
    });
  }
});

describe("recordHeartbeat (§1.3)", () => {
  test("a first heartbeat creates the record and answers the contract", async () => {
    const h = harness();
    const answer = await recordHeartbeat(h.deps, caller(), heartbeat());
    const id = localHostId(userIdFor(EMAIL), HOST_ID);
    assert.equal(answer.accepted, true);
    assert.equal(answer.id, id);
    assert.equal(answer.status, "online");
    assert.equal(answer.nextHeartbeatSeconds, 300);
    assert.equal(answer.routerPrefix, "mgm-matthews-macbook-pro");
    assert.deepEqual(answer.routerModels, [
      "local/mgm-matthews-macbook-pro/qwen/qwen3-coder-30b",
      "local/mgm-matthews-macbook-pro/text-embedding-nomic",
    ]);
    assert.equal(answer.credentials, "fetch", "no managed credentials yet");
    assert.deepEqual(answer.problems, []);

    const rec = (await h.store.localHosts.findById(id))!;
    assert.equal(rec.userId, userIdFor(EMAIL));
    assert.equal(rec.ownerEmail, EMAIL);
    assert.equal(rec.deviceId, "dev_a");
    assert.equal(rec.accessGroup, "everyone");
    assert.equal(rec.createdAt, T0.toISOString());
    assert.equal(rec.lastSeenAt, T0.toISOString());
    assert.equal(h.changes.length, 1);
    assert.equal(h.changes[0].reason, "heartbeat");
    assert.equal(h.changes[0].previous, undefined);
  });

  test("changed() fires only when routerFingerprint changes", async () => {
    const h = harness();
    await recordHeartbeat(h.deps, caller(), heartbeat());
    later(h, 300);
    await recordHeartbeat(h.deps, caller(), heartbeat({ reason: "interval" }));
    assert.equal(h.changes.length, 1, "an interval heartbeat with nothing new is quiet");
    // A model not on the tunnel's server isn't in the fingerprint.
    const models = heartbeat().models.map((m) => (m.server === OLLAMA ? { ...m, loaded: true } : m));
    await recordHeartbeat(h.deps, caller(), heartbeat({ models, discoveryKey: "k2" }));
    assert.equal(h.changes.length, 1);
    // Loading a shared model is.
    const loaded = heartbeat().models.map((m) => (m.id === "text-embedding-nomic" ? { ...m, loaded: true } : m));
    await recordHeartbeat(h.deps, caller(), heartbeat({ models: loaded, discoveryKey: "k3" }));
    assert.equal(h.changes.length, 2);
    assert.ok(h.changes[1].previous);
    // A stop heartbeat takes the host offline: changed.
    const stop = await recordHeartbeat(h.deps, caller(), heartbeat({ models: loaded, reason: "stop", tunnel: { ...heartbeat().tunnel, state: "stopped" } }));
    assert.equal(stop.status, "offline");
    assert.deepEqual(stop.routerModels, []);
    assert.equal(h.changes.length, 3);
  });

  test("a heartbeat after the host went stale is a change (status back to online)", async () => {
    const h = harness();
    await recordHeartbeat(h.deps, caller(), heartbeat());
    later(h, 961);
    await recordHeartbeat(h.deps, caller(), heartbeat());
    assert.equal(h.changes.length, 2);
  });

  test("an existing record keeps routerPrefix, accessGroup, managed and createdAt; a new device takes it over", async () => {
    const h = harness();
    const first = await recordHeartbeat(h.deps, caller("dev_a"), heartbeat());
    const managed = { credentialId: "cr_1", credentialIssuedAt: T0.toISOString(), endpointId: "ep_1", publicUrl: "https://lh-x.kernal.run", bearerSecret: "s", bearerVersion: 1, bearerHash: "0".repeat(64) };
    await h.store.localHosts.update(first.id, { managed, accessGroup: "everyone", revokedAt: T0.toISOString() });
    later(h, 60);
    const answer = await recordHeartbeat(h.deps, caller("dev_b"), heartbeat({ hostName: "Renamed-Mac" }));
    const rec = (await h.store.localHosts.findById(first.id))!;
    assert.equal(rec.routerPrefix, "mgm-matthews-macbook-pro", "renaming the machine doesn't rename its models");
    assert.equal(rec.hostName, "Renamed-Mac");
    assert.deepEqual(rec.managed, managed);
    assert.equal(rec.createdAt, T0.toISOString());
    assert.equal(rec.deviceId, "dev_b");
    assert.equal(rec.revokedAt, undefined, "an accepted heartbeat comes from a newer login");
    assert.equal(answer.credentials, "current");
  });

  test("router prefix collisions take the 4-hex, then 8-hex candidate", async () => {
    const h = harness();
    const a = await recordHeartbeat(h.deps, caller("dev_a", "mgm@example.com"), heartbeat());
    const b = await recordHeartbeat(h.deps, caller("dev_b", "mgm@other.example"), heartbeat());
    assert.equal(a.routerPrefix, "mgm-matthews-macbook-pro");
    assert.equal(b.routerPrefix, `mgm-matthews-macbook-pro-${b.id.slice(3, 7)}`);
    // Someone already holds the third user's 4-hex candidate too.
    const cId = localHostId(userIdFor("mgm+x@third.example"), HOST_ID);
    const squatter = (await h.store.localHosts.findById(a.id))!;
    await h.store.localHosts.upsert({ ...squatter, id: localHostId("u_squat", HOST_ID), userId: "u_squat", routerPrefix: `mgm-matthews-macbook-pro-${cId.slice(3, 7)}` });
    const c = await recordHeartbeat(h.deps, caller("dev_c", "mgm+x@third.example"), heartbeat());
    assert.equal(c.id, cId);
    assert.equal(c.routerPrefix, `mgm-matthews-macbook-pro-${cId.slice(3, 11)}`);
  });

  test("a prefix race (upsert throws LocalHostPrefixTakenError) moves on to the next candidate", async () => {
    const h = harness();
    const realUpsert = h.store.localHosts.upsert.bind(h.store.localHosts);
    let raced = false;
    h.store.localHosts.upsert = async (host: LocalHost) => {
      if (!raced) {
        raced = true;
        // Another instance wins the base prefix between the lookup and the insert.
        await realUpsert({ ...host, id: localHostId("u_other", HOST_ID), userId: "u_other" });
      }
      return realUpsert(host);
    };
    const answer = await recordHeartbeat(h.deps, caller(), heartbeat());
    assert.equal(answer.routerPrefix, `mgm-matthews-macbook-pro-${answer.id.slice(3, 7)}`);
  });

  test("credentials hint: none, unavailable, fetch, current (first match wins)", async () => {
    const off = harness({ provisioning: false });
    assert.equal((await recordHeartbeat(off.deps, caller(), heartbeat())).credentials, "unavailable");
    assert.equal((await recordHeartbeat(off.deps, caller(), heartbeat({ shareModels: false }))).credentials, "none");

    const h = harness();
    const first = await recordHeartbeat(h.deps, caller(), heartbeat());
    assert.equal(first.credentials, "fetch");
    const managed = { credentialId: "cr_1", credentialIssuedAt: T0.toISOString(), endpointId: "ep_1", publicUrl: "https://lh-x.kernal.run", bearerSecret: "s", bearerVersion: 1, bearerHash: "0".repeat(64) };
    await h.store.localHosts.update(first.id, { managed });
    assert.equal((await recordHeartbeat(h.deps, caller(), heartbeat())).credentials, "current");
    const rotated = heartbeat({ tunnel: { ...heartbeat().tunnel, credentialId: "cr_old" } });
    assert.equal((await recordHeartbeat(h.deps, caller(), rotated)).credentials, "fetch", "agent runs an old credential");
    const interim = heartbeat({ tunnel: { ...heartbeat().tunnel, managed: false, credentialId: undefined } });
    assert.equal((await recordHeartbeat(h.deps, caller(), interim)).credentials, "current", "an interim tunnel isn't compared");
    await h.store.localHosts.update(first.id, { managed: { ...managed, endpointId: undefined } });
    assert.equal((await recordHeartbeat(h.deps, caller(), heartbeat())).credentials, "fetch", "endpoint gone");

    // A revoked record: the heartbeat (a newer login) clears revokedAt first, so the hint is about
    // the credentials alone, never `none` for the revocation.
    await h.store.localHosts.update(first.id, { revokedAt: T0.toISOString(), managed: undefined });
    const back = await recordHeartbeat(h.deps, caller(), heartbeat());
    assert.equal(back.credentials, "fetch");
    assert.equal(back.status, "online");
    assert.equal((await h.store.localHosts.findById(first.id))!.revokedAt, undefined);
    const rec = (await h.store.localHosts.findById(first.id))!;
    assert.equal(credentialsHint({ ...rec, shareModels: false }, true), "none");
  });

  test("routerModels: [] for an interim tunnel, offline server, or not sharing", async () => {
    const h = harness();
    const interim = await recordHeartbeat(h.deps, caller(), heartbeat({ tunnel: { ...heartbeat().tunnel, managed: false } }));
    assert.equal(interim.status, "online");
    assert.deepEqual(interim.routerModels, []);
    const servers = heartbeat().servers.map((s) => (s.id === LMS ? { ...s, ok: false } : s));
    const down = await recordHeartbeat(h.deps, caller(), heartbeat({ servers }));
    assert.equal(down.status, "offline");
    assert.deepEqual(down.routerModels, []);
    const notSharing = await recordHeartbeat(h.deps, caller(), heartbeat({ shareModels: false }));
    assert.equal(notSharing.status, "not-sharing");
    assert.deepEqual(notSharing.routerModels, []);
  });

  test("an unroutable model id is kept, gets no router name, and is a problem", async () => {
    const h = harness();
    const models = [...heartbeat().models, { id: "bad id with spaces", server: LMS, kind: "lmstudio" as const }];
    const answer = await recordHeartbeat(h.deps, caller(), heartbeat({ models }));
    assert.deepEqual(answer.problems, ["model id not routable: bad id with spaces"]);
    assert.equal(answer.routerModels.length, 2);
    const rec = (await h.store.localHosts.findById(answer.id))!;
    assert.equal(rec.models.length, 4);
    assert.equal(hostView(rec, true, T0).models[3].routerModel, undefined);
  });

  test("a listener's failure is in the answer's problems, never a failed heartbeat", async () => {
    const h = harness({ problems: ["LiteLLM did not answer"] });
    const answer = await recordHeartbeat(h.deps, caller(), heartbeat());
    assert.deepEqual(answer.problems, ["spy: LiteLLM did not answer"]);
  });

  test("sharing off deletes the cloud endpoint and forgets it; the credential stays", async () => {
    const h = harness();
    const first = await recordHeartbeat(h.deps, caller(), heartbeat());
    const ep = await h.ngrok.createCloudEndpoint({ url: "https://lh-x.kernal.run", trafficPolicy: "{}", description: "d", metadata: "{}" });
    const managed = { credentialId: "cr_1", credentialIssuedAt: T0.toISOString(), endpointId: ep.id, publicUrl: ep.url, bearerSecret: "s", bearerVersion: 1, bearerHash: "0".repeat(64) };
    await h.store.localHosts.update(first.id, { managed });
    const answer = await recordHeartbeat(h.deps, caller(), heartbeat({ shareModels: false }));
    assert.equal(answer.credentials, "none");
    assert.deepEqual(h.ngrok.deletedEndpoints, [ep.id]);
    assert.deepEqual(h.ngrok.deletedCredentials, []);
    const rec = (await h.store.localHosts.findById(first.id))!;
    assert.equal(rec.managed?.endpointId, undefined);
    assert.equal(rec.managed?.publicUrl, undefined);
    assert.equal(rec.managed?.credentialId, "cr_1");
    assert.equal(h.changes.at(-1)?.host.managed?.publicUrl, undefined, "the listeners see the endpoint gone");
    // Turning sharing back on asks for a new endpoint.
    assert.equal((await recordHeartbeat(h.deps, caller(), heartbeat())).credentials, "fetch");
  });
});

describe("GET listing (§1.7)", () => {
  test("own hosts (any status) first, then others' sharing online/offline/stale hosts; no secrets", async () => {
    const h = harness();
    const mine = await recordHeartbeat(h.deps, caller("dev_a"), heartbeat());
    await h.store.localHosts.update(mine.id, {
      managed: { credentialId: "cr_secret", credentialIssuedAt: T0.toISOString(), endpointId: "ep_secret", publicUrl: "https://lh-secret.kernal.run", bearerSecret: "outfitter-localhost-x", bearerVersion: 1, bearerHash: "f".repeat(64) },
    });
    await recordHeartbeat(h.deps, caller("dev_n", EMAIL), heartbeat({ hostId: "h_" + "1".repeat(24), hostName: "mine-not-sharing", shareModels: false }));
    const other = (hostId: string, email: string, o: Partial<HeartbeatRequest> = {}) =>
      recordHeartbeat(h.deps, caller(`dev_${hostId.slice(-4)}`, email), heartbeat({ hostId, hostName: `host-${hostId.slice(-4)}`, ...o }));
    await other("h_" + "2".repeat(24), "ana@example.com");
    await other("h_" + "3".repeat(24), "bo@example.com", { shareModels: false });
    await other("h_" + "4".repeat(24), "cy@example.com", { tunnel: { ...heartbeat().tunnel, state: "down" } });
    const revoked = await other("h_" + "5".repeat(24), "di@example.com");
    await h.store.localHosts.update(revoked.id, { revokedAt: T0.toISOString() });

    const list = await listLocalHosts({ store: h.store, now: () => T0 }, EMAIL);
    const names = list.hosts.map((x) => [x.hostName, x.owner.mine, x.status]);
    assert.deepEqual(names.slice(0, 2).map((n) => n[1]), [true, true]);
    assert.deepEqual(new Set(names.slice(0, 2).map((n) => n[0])), new Set(["Matthews-MacBook-Pro", "mine-not-sharing"]));
    assert.deepEqual(new Set(names.slice(2).map((n) => n[0])), new Set(["host-2222", "host-4444"]));
    assert.ok(names.slice(2).every((n) => n[1] === false));

    const body = JSON.stringify(list);
    for (const secret of ["cr_secret", "ep_secret", "lh-secret", "outfitter-localhost", "f".repeat(64), "dev_a", userIdFor(EMAIL), "9a1c2e3f4b5d6a7c", "lhx.internal", "cr_1"]) {
      assert.ok(!body.includes(secret), `the listing leaks ${secret}`);
    }
    const view = list.hosts.find((x) => x.hostName === "Matthews-MacBook-Pro")!;
    assert.deepEqual(Object.keys(view).sort(), ["accessGroup", "hostName", "id", "kernalVersion", "lastSeenAt", "models", "owner", "platform", "routerPrefix", "servers", "shareModels", "status", "tunnel"]);
    assert.deepEqual(view.tunnel, { provider: "ngrok", managed: true, state: "up" });
    assert.deepEqual(view.servers[0], { id: LMS, kind: "lmstudio", ok: true });
    assert.deepEqual(view.models[0], { id: "qwen/qwen3-coder-30b", routerModel: "local/mgm-matthews-macbook-pro/qwen/qwen3-coder-30b", kind: "lmstudio", loaded: true, contextLength: 32768, toolUse: true, type: "llm", shared: true });
    assert.equal(view.models[2].shared, false, "the ollama model isn't on the tunnel's server");
  });

  test("others' stale hosts stay listed; the caller's revoked ones too", async () => {
    const h = harness();
    await recordHeartbeat(h.deps, caller("dev_x", "ana@example.com"), heartbeat({ hostId: "h_" + "2".repeat(24) }));
    const mine = await recordHeartbeat(h.deps, caller(), heartbeat());
    await h.store.localHosts.update(mine.id, { revokedAt: T0.toISOString() });
    const list = await listLocalHosts({ store: h.store, now: () => new Date(T0.getTime() + 2000_000) }, EMAIL);
    assert.deepEqual(list.hosts.map((x) => [x.owner.mine, x.status]), [[true, "revoked"], [false, "stale"]]);
  });
});

describe("delete and device revoke", () => {
  test("deleteLocalHost removes ngrok resources, disables the bearer, deletes the record, then announces it", async () => {
    const h = harness();
    const first = await recordHeartbeat(h.deps, caller(), heartbeat());
    const ep = await h.ngrok.createCloudEndpoint({ url: "https://lh-x.kernal.run", trafficPolicy: "{}", description: "d", metadata: "{}" });
    const cred = await h.ngrok.createCredential({ description: "d", metadata: "{}", acl: [] });
    await h.secrets.addVersion("outfitter-localhost-x", "lhb_" + "a".repeat(43));
    await h.store.localHosts.update(first.id, {
      managed: { credentialId: cred.id, credentialIssuedAt: T0.toISOString(), endpointId: ep.id, publicUrl: ep.url, bearerSecret: "outfitter-localhost-x", bearerVersion: 1, bearerHash: "0".repeat(64) },
    });
    const before = (await h.store.localHosts.findById(first.id))!;
    await deleteLocalHost(h.deps, before);
    assert.deepEqual(h.ngrok.deletedEndpoints, [ep.id]);
    assert.deepEqual(h.ngrok.deletedCredentials, [cred.id]);
    assert.equal(await h.secrets.accessLatest("outfitter-localhost-x"), undefined);
    assert.equal(await h.store.localHosts.findById(first.id), null);
    const last = h.changes.at(-1)!;
    assert.equal(last.reason, "deleted");
    assert.equal(last.host.id, first.id);
  });

  test("the device hook marks the device's hosts revoked, retires their resources, and announces each", async () => {
    const h = harness();
    const a = await recordHeartbeat(h.deps, caller("dev_a"), heartbeat());
    const b = await recordHeartbeat(h.deps, caller("dev_b"), heartbeat({ hostId: "h_" + "9".repeat(24), hostName: "other" }));
    await h.store.localHosts.update(a.id, {
      managed: { credentialId: "cr_9", credentialIssuedAt: T0.toISOString(), endpointId: "ep_9", publicUrl: "https://lh-x.kernal.run", bearerSecret: "outfitter-localhost-a", bearerVersion: 3, bearerHash: "0".repeat(64) },
    });
    await h.secrets.addVersion("outfitter-localhost-a", "lhb_" + "b".repeat(43));
    const hook = localHostDeviceHook(h.deps);
    await hook.onRevoked!({ device: { id: "dev_a", userId: userIdFor(EMAIL), ownerEmail: EMAIL, name: "mbp" }, reason: "revoked" });
    const rec = (await h.store.localHosts.findById(a.id))!;
    assert.equal(rec.revokedAt, T0.toISOString());
    assert.equal(rec.managed, undefined);
    assert.equal(rec.retiredBearerVersion, 3);
    assert.deepEqual(h.ngrok.deletedEndpoints, ["ep_9"]);
    assert.deepEqual(h.ngrok.deletedCredentials, ["cr_9"]);
    assert.equal(await h.secrets.accessLatest("outfitter-localhost-a"), undefined);
    assert.equal(h.changes.at(-1)?.reason, "device-revoked");
    assert.equal((await h.store.localHosts.findById(b.id))!.revokedAt, undefined, "another device's host is untouched");

    // A heartbeat from a newer login clears it and asks for credentials.
    const back = await recordHeartbeat(h.deps, caller("dev_c"), heartbeat());
    assert.equal(back.status, "online");
    assert.equal(back.credentials, "fetch");
  });
});

describe("LaptopProbe.isOnlineFor and resolveRunModel (§1.8)", () => {
  async function seeded(o: Partial<HeartbeatRequest> = {}) {
    const h = harness();
    await recordHeartbeat(h.deps, caller(), heartbeat(o));
    let probes = 0;
    const probe = new LaptopProbe({
      tunnelDomain: "legacy.ngrok.app",
      token: "t",
      localHosts: h.store.localHosts,
      fetchImpl: (async () => { probes++; return new Response("{}", { status: 200 }); }) as typeof fetch,
    });
    return { h, probe, probes: () => probes };
  }

  test("a shared model on an online host is online, with or without litellm/", async () => {
    const { probe, probes } = await seeded();
    assert.equal(await probe.isOnlineFor("local/mgm-matthews-macbook-pro/qwen/qwen3-coder-30b"), true);
    assert.equal(await probe.isOnlineFor("litellm/local/mgm-matthews-macbook-pro/text-embedding-nomic"), true);
    assert.equal(probes(), 0, "never probes the legacy tunnel for a local/ name");
  });

  test("an unshared model, an unknown host, or an offline host is not", async () => {
    const { probe } = await seeded({ tunnel: { ...heartbeat().tunnel } });
    assert.equal(await probe.isOnlineFor("local/mgm-matthews-macbook-pro/llama3.2:3b"), false, "on the other server");
    assert.equal(await probe.isOnlineFor("local/mgm-matthews-macbook-pro/nope"), false);
    assert.equal(await probe.isOnlineFor("local/nobody-nowhere/qwen"), false);
    const off = await seeded({ tunnel: { ...heartbeat().tunnel, state: "down" } });
    assert.equal(await off.probe.isOnlineFor("local/mgm-matthews-macbook-pro/qwen/qwen3-coder-30b"), false);
  });

  test("the record is cached per prefix for cacheMs", async () => {
    const { h, probe } = await seeded();
    let lookups = 0;
    const real = h.store.localHosts.findByRouterPrefix.bind(h.store.localHosts);
    h.store.localHosts.findByRouterPrefix = async (p: string) => { lookups++; return real(p); };
    await probe.isOnlineFor("local/mgm-matthews-macbook-pro/qwen/qwen3-coder-30b");
    await probe.isOnlineFor("local/mgm-matthews-macbook-pro/text-embedding-nomic");
    assert.equal(lookups, 1);
  });

  test("any other name falls back to the legacy tunnel probe", async () => {
    const { probe, probes } = await seeded();
    assert.equal(await probe.isOnlineFor("litellm/local-qwen-mlx"), true);
    assert.equal(probes(), 1);
  });

  test("resolveRunModel treats a local/ name as a laptop model", () => {
    const base = { localModels: ["litellm/local-qwen-mlx"], defaultCloudModel: "litellm/cloud", guruFallbackModel: undefined };
    assert.deepEqual(resolveRunModel({ ...base, wanted: "litellm/local/mgm-mbp/qwen", laptopOnline: false }), {
      model: "litellm/cloud",
      fallback: { wanted: "litellm/local/mgm-mbp/qwen", used: "litellm/cloud" },
    });
    assert.deepEqual(resolveRunModel({ ...base, wanted: "local/mgm-mbp/qwen", laptopOnline: true }), { model: "local/mgm-mbp/qwen" });
    assert.deepEqual(resolveRunModel({ ...base, wanted: "litellm/cloud-x", laptopOnline: false }), { model: "litellm/cloud-x" });
  });
});

test("internalUrl matches what the credentials hand out (sanity)", () => {
  assert.match(internalUrl(localHostId("u_1", HOST_ID)), /^https:\/\/lh[0-9a-f]{24}\.internal$/);
});

describe("the store never reads a cleared revokedAt as revoked (MongoDB, no ignoreUndefined)", () => {
  let mongod: { stop(): Promise<unknown> } | undefined;
  let store: MongoStore | undefined;
  let client: MongoClient | undefined;
  const dbName = `outfitter_lh_registry_${randomUUID().slice(0, 8)}`;

  before(async () => {
    let uri = process.env.OUTFITTER_TEST_MONGODB_URI;
    if (!uri) {
      const { MongoMemoryServer } = await import("mongodb-memory-server");
      const started = await MongoMemoryServer.create();
      mongod = started;
      uri = started.getUri();
    }
    store = await MongoStore.connect(uri, dbName);
    client = await MongoClient.connect(uri);
  }, { timeout: 120_000 });

  after(async () => {
    await store?.close();
    await client?.close();
    await mongod?.stop();
  });

  test("upsert drops undefined fields; listSharing treats a stored null as not revoked; a revoke-then-heartbeat round trip lists the host again", async () => {
    const raw = client!.db(dbName).collection("localHosts");
    const events = new LocalHostEvents();
    const deps: LocalHostDeps = { store: store!, config: { localHostDomain: "", previewEnv: "test" }, secretAdmin: new MemorySecretAdmin(), events, now: () => T0 };
    const answer = await recordHeartbeat(deps, caller(), heartbeat());

    // upsert with undefined fields: nothing stored as null.
    const rec = (await store!.localHosts.findById(answer.id))!;
    await store!.localHosts.upsert({ ...rec, revokedAt: undefined, managed: undefined, kernalVersion: undefined });
    const doc = (await raw.findOne({ _id: answer.id as never }))!;
    for (const field of ["revokedAt", "managed", "kernalVersion"]) assert.ok(!(field in doc), `${field} not stored`);

    // A null left by an older write is not a revocation.
    await raw.updateOne({ _id: answer.id as never }, { $set: { revokedAt: null } });
    assert.ok((await store!.localHosts.listSharing()).some((h) => h.id === answer.id));

    // Revoked, then a newer login's heartbeat: back in the sharing list.
    await store!.localHosts.update(answer.id, { revokedAt: T0.toISOString() });
    assert.ok(!(await store!.localHosts.listSharing()).some((h) => h.id === answer.id));
    await recordHeartbeat(deps, caller("dev_b"), heartbeat());
    assert.ok(!("revokedAt" in (await raw.findOne({ _id: answer.id as never }))!));
    assert.ok((await store!.localHosts.listSharing()).some((h) => h.id === answer.id));
  });
});
