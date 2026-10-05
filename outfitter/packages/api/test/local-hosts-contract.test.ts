// #378 Local Host wave 2: the spec-owned pieces of the contract (docs/specs/local-host.md §9): the
// names derived from a host, the status and fingerprint rules, the events seam, the localHosts
// store (memory and MongoDB alike), and the scaffold wiring (the tick runs the listeners' sweeps).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  bearerHash,
  bearerSecretName,
  credentialAcl,
  hostSlug,
  internalLabel,
  internalUrl,
  localHostId,
  newBearer,
  newPublicSlug,
  parseRouterModelName,
  routableModelId,
  routerDeploymentId,
  routerModelName,
  routerPrefixCandidates,
  userSlug,
  HOST_ID_RE,
  LOCAL_HOST_ID_RE,
} from "../src/local-hosts/naming.ts";
import { LocalHostEvents, type LocalHostChange } from "../src/local-hosts/events.ts";
import { HEARTBEAT_INTERVAL_SECONDS, LOCAL_HOST_ALLOW_PATHS } from "../src/local-hosts/contract.ts";
import {
  LocalHostPrefixTakenError,
  hostStatus,
  routerFingerprint,
  sharedModels,
  staleAfterSeconds,
  type LocalHost,
} from "../src/store/local-hosts.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { MongoStore } from "../src/store/mongo.ts";
import type { Store } from "../src/store/types.ts";
import { buildTestApp } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

function host(overrides: Partial<LocalHost> = {}): LocalHost {
  const id = overrides.id ?? localHostId("u_1", "h_" + "a".repeat(24));
  return {
    id,
    userId: "u_1",
    ownerEmail: "mgm@example.com",
    hostId: "h_" + "a".repeat(24),
    deviceId: "dev_1",
    hostName: "Matthews-MacBook-Pro.local",
    accessGroup: "everyone",
    routerPrefix: "mgm-matthews-macbook-pro",
    shareModels: true,
    discoveryKey: "k1",
    servers: [
      { id: "http://localhost:1234", kind: "lmstudio", baseUrl: "http://localhost:1234/v1", ok: true, endpoints: ["/api/v0/models", "/v1/models"], models: 2 },
      { id: "http://localhost:11434", kind: "ollama", baseUrl: "http://localhost:11434/v1", ok: true, endpoints: ["/api/tags"], models: 1 },
    ],
    models: [
      { id: "qwen/qwen3-coder-30b", server: "http://localhost:1234", kind: "lmstudio", loaded: true, contextLength: 32768, toolUse: true },
      { id: "text-embedding-nomic", server: "http://localhost:1234", kind: "lmstudio", loaded: false, type: "embeddings" },
      { id: "llama3.2:3b", server: "http://localhost:11434", kind: "ollama", loaded: false },
    ],
    tunnel: { provider: "ngrok", managed: true, state: "up", url: internalUrl(id), server: "http://localhost:1234", credentialId: "cr_1" },
    managed: { credentialId: "cr_1", credentialIssuedAt: ago(60), endpointId: "ep_1", publicUrl: "https://lh-x.kernal.run", bearerSecret: bearerSecretName(id), bearerVersion: 1, bearerHash: "0".repeat(64) },
    createdAt: ago(3600),
    updatedAt: ago(10),
    lastSeenAt: ago(10),
    ...overrides,
  };
}

describe("naming", () => {
  test("ids and ngrok names are stable, shaped, and per person per machine", () => {
    const id = localHostId("u_1", "h_" + "a".repeat(24));
    assert.match(id, LOCAL_HOST_ID_RE);
    assert.equal(id, localHostId("u_1", "h_" + "a".repeat(24)));
    assert.notEqual(id, localHostId("u_2", "h_" + "a".repeat(24)));
    assert.match("h_" + "0".repeat(24), HOST_ID_RE);
    assert.equal(internalLabel(id), id.replace("lh_", "lh"));
    assert.equal(internalUrl(id), `https://${internalLabel(id)}.internal`);
    assert.deepEqual(credentialAcl(id), [`bind:${internalLabel(id)}.internal`]);
    assert.ok(internalLabel(id).length <= 63);
    assert.equal(bearerSecretName(id), `outfitter-localhost-${id.slice(3)}`);
  });

  test("public slugs and bearers are random and shaped", () => {
    const a = newPublicSlug(), b = newPublicSlug();
    assert.match(a, /^lh-[a-z2-7]{26}$/);
    assert.notEqual(a, b);
    const bearer = newBearer();
    assert.match(bearer, /^lhb_[A-Za-z0-9_-]{43}$/);
    assert.match(bearer, /^[A-Za-z0-9._~+\/=-]{16,512}$/, "fits Kernal's checkBearerToken");
    assert.match(bearerHash(bearer), /^[0-9a-f]{64}$/);
  });

  test("slugs and router prefixes", () => {
    assert.equal(userSlug("Matthew.Monteleone+lh@Example.com"), "matthew-monteleo");
    assert.equal(userSlug("@x"), "user");
    assert.equal(hostSlug("Matthews-MacBook-Pro.local"), "matthews-macbook-pro");
    assert.equal(hostSlug("..."), "host");
    assert.equal(hostSlug("a very long machine name indeed"), "a-very-long-machine");
    const id = localHostId("u_1", "h_" + "b".repeat(24));
    const c = routerPrefixCandidates("mgm@mgms.eu", "Studio.lan", id);
    assert.deepEqual(c, ["mgm-studio", `mgm-studio-${id.slice(3, 7)}`, `mgm-studio-${id.slice(3, 11)}`]);
    for (const p of c) assert.ok(p.length <= 48 && /^[a-z0-9-]+$/.test(p));
  });

  test("router model names round-trip; unroutable ids are refused", () => {
    for (const m of ["qwen/qwen3-coder-30b", "llama3.2:3b", "hf.co/unsloth/Qwen3-GGUF:Q4_K_M", "mlx-community/Qwen3-30B-A3B-4bit"]) {
      const name = routerModelName("mgm-studio", m)!;
      assert.equal(name, `local/mgm-studio/${m}`);
      assert.deepEqual(parseRouterModelName(name), { routerPrefix: "mgm-studio", modelId: m });
      assert.deepEqual(parseRouterModelName(`litellm/${name}`), { routerPrefix: "mgm-studio", modelId: m });
    }
    for (const bad of ["", "a b", "a//b", "../x", "x/..", "qén", "x".repeat(161)]) assert.equal(routableModelId(bad), false, bad);
    assert.equal(routerModelName("p", "a b"), undefined);
    assert.equal(parseRouterModelName("openai/gpt-5"), undefined);
  });

  test("deployment ids are deterministic per host and model", () => {
    const id = localHostId("u_1", "h_" + "a".repeat(24));
    assert.equal(routerDeploymentId(id, "m1"), routerDeploymentId(id, "m1"));
    assert.notEqual(routerDeploymentId(id, "m1"), routerDeploymentId(id, "m2"));
    assert.match(routerDeploymentId(id, "m1"), /^lh-[0-9a-f]{24}-[0-9a-f]{12}$/);
  });

  test("the allow-list is Kernal's", () => {
    assert.deepEqual([...LOCAL_HOST_ALLOW_PATHS], ["/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/models"]);
  });
});

describe("status and fingerprint", () => {
  test("status order: revoked, stale, not-sharing, offline, online", () => {
    assert.equal(staleAfterSeconds(), 3 * HEARTBEAT_INTERVAL_SECONDS + 60);
    assert.equal(hostStatus(host(), NOW), "online");
    assert.equal(hostStatus(host({ revokedAt: ago(1) }), NOW), "revoked");
    assert.equal(hostStatus(host({ lastSeenAt: ago(staleAfterSeconds() + 1) }), NOW), "stale");
    assert.equal(hostStatus(host({ lastSeenAt: ago(staleAfterSeconds() - 1) }), NOW), "online");
    assert.equal(hostStatus(host({ shareModels: false }), NOW), "not-sharing");
    assert.equal(hostStatus(host({ tunnel: { provider: "ngrok", managed: true, state: "down", server: "http://localhost:1234" } }), NOW), "offline");
    const h = host();
    h.servers[0].ok = false;
    assert.equal(hostStatus(h, NOW), "offline");
  });

  test("only the tunnel's server's models are shared", () => {
    assert.deepEqual(sharedModels(host()).map((m) => m.id), ["qwen/qwen3-coder-30b", "text-embedding-nomic"]);
    assert.deepEqual(sharedModels(host({ tunnel: { provider: "ngrok", managed: true, state: "off" } })), []);
  });

  test("the fingerprint moves with what the router entries depend on, and nothing else", () => {
    const base = routerFingerprint(host(), NOW);
    assert.equal(routerFingerprint(host({ updatedAt: ago(1), discoveryKey: "k2", kernalVersion: "9.9.9" }), NOW), base);
    const other = host();
    other.models[2].loaded = true; // a model the tunnel doesn't reach
    assert.equal(routerFingerprint(other, NOW), base);
    const loaded = host();
    loaded.models[1].loaded = true;
    assert.notEqual(routerFingerprint(loaded, NOW), base);
    assert.notEqual(routerFingerprint(host({ shareModels: false }), NOW), base);
    assert.notEqual(routerFingerprint(host({ lastSeenAt: ago(staleAfterSeconds() + 1) }), NOW), base);
    const rotated = host();
    rotated.managed!.bearerVersion = 2;
    assert.notEqual(routerFingerprint(rotated, NOW), base);
  });
});

describe("LocalHostEvents", () => {
  const change: LocalHostChange = { reason: "heartbeat", host: host() };

  test("runs listeners in order and reports a failing or slow one without throwing", async () => {
    const seen: string[] = [];
    const logged: string[] = [];
    const events = new LocalHostEvents((msg) => logged.push(msg), { timeoutMs: 20 });
    events.register({ name: "tunnel", onChange: async (c) => { seen.push(`tunnel:${c.reason}`); } });
    events.register({ name: "router", onChange: async () => { throw new Error("LiteLLM did not answer\nstack"); } });
    events.register({ name: "slow", onChange: () => new Promise((r) => setTimeout(r, 200)) });
    const { problems } = await events.changed(change);
    assert.deepEqual(seen, ["tunnel:heartbeat"]);
    assert.deepEqual(problems, ["router: LiteLLM did not answer", "slow: still updating"]);
    assert.ok(logged.some((l) => l.includes("router failed on heartbeat")));
  });

  test("sweep collects counts and survives a failing listener", async () => {
    const events = new LocalHostEvents(() => {});
    events.register({ name: "tunnel", sweep: async () => ({ endpointsDeleted: 1 }) });
    events.register({ name: "router", sweep: async () => { throw new Error("down"); } });
    events.register({ name: "quiet", sweep: async () => undefined });
    assert.deepEqual(await events.sweep(NOW), { tunnel: { endpointsDeleted: 1 } });
  });

  test("the tick runs the sweep and reports it", async () => {
    const app = await buildTestApp();
    try {
      app.localHostEvents.register({ name: "router", sweep: async () => ({ added: 2 }) });
      const res = await app.fastify.inject({ method: "POST", url: "/api/hooks/tick", headers: { authorization: "Bearer test-agent-token" }, payload: {} });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().localHosts, { router: { added: 2 } });
    } finally {
      app.stopBackgroundTasks();
      await app.fastify.close();
    }
  });
});

let server: { stop(): Promise<unknown> } | undefined;
const opened: Store[] = [];

function suite(name: string, open: () => Promise<Store>) {
  describe(name, () => {
    let store: Store;
    before(async () => {
      store = await open();
      opened.push(store);
    }, { timeout: 120_000 });

    test("round-trip, lists, unique router prefix, patch and delete", async () => {
      const user = `u_${randomUUID().slice(0, 8)}`;
      const a = host({ id: localHostId(user, "h_" + "1".repeat(24)), userId: user, routerPrefix: `${user}-a`, deviceId: `${user}-d1`, lastSeenAt: ago(20) });
      const b = host({ id: localHostId(user, "h_" + "2".repeat(24)), userId: user, routerPrefix: `${user}-b`, deviceId: `${user}-d1`, shareModels: false, lastSeenAt: ago(5) });
      await store.localHosts.upsert(a);
      await store.localHosts.upsert(b);
      assert.deepEqual(await store.localHosts.findById(a.id), a);
      assert.deepEqual(await store.localHosts.findByRouterPrefix(`${user}-b`), b);
      assert.deepEqual((await store.localHosts.listForUser(user)).map((h) => h.id), [b.id, a.id]);
      assert.deepEqual((await store.localHosts.listForDevice(`${user}-d1`)).map((h) => h.id), [b.id, a.id]);
      const sharing = (await store.localHosts.listSharing()).map((h) => h.id);
      assert.ok(sharing.includes(a.id) && !sharing.includes(b.id));
      await assert.rejects(store.localHosts.upsert({ ...b, id: localHostId(user, "h_" + "3".repeat(24)), routerPrefix: `${user}-a` }), LocalHostPrefixTakenError);
      await store.localHosts.upsert({ ...a, hostName: "renamed" });
      assert.equal((await store.localHosts.findById(a.id))?.hostName, "renamed");

      const revoked = await store.localHosts.update(a.id, { revokedAt: ago(0), managed: undefined });
      assert.equal(revoked?.revokedAt, ago(0));
      assert.equal(revoked?.managed, undefined);
      assert.ok(!(await store.localHosts.listSharing()).some((h) => h.id === a.id));
      assert.equal(await store.localHosts.update("lh_missing", { shareModels: true }), null);
      assert.ok((await store.localHosts.listAll(1000)).some((h) => h.id === a.id));
      assert.equal(await store.localHosts.delete(a.id), true);
      assert.equal(await store.localHosts.delete(a.id), false);
      assert.equal(await store.localHosts.findById(a.id), null);
    });
  });
}

suite("local hosts store: memory", async () => new MemoryStore());
suite("local hosts store: MongoDB", async () => {
  let uri = process.env.OUTFITTER_TEST_MONGODB_URI;
  if (!uri) {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const started = await MongoMemoryServer.create();
    server = started;
    uri = started.getUri();
  }
  return MongoStore.connect(uri, `outfitter_localhosts_${randomUUID().slice(0, 8)}`);
});

after(async () => {
  for (const s of opened) await s.close();
  await server?.stop();
});

describe("local hosts config", () => {
  test("LOCAL_HOST_DOMAIN falls back to PREVIEW_DOMAIN when unset or empty; both unset turn provisioning off", () => {
    assert.equal(loadConfig({ PREVIEW_DOMAIN: "kernal.run" }).localHostDomain, "kernal.run");
    assert.equal(loadConfig({ PREVIEW_DOMAIN: "kernal.run", LOCAL_HOST_DOMAIN: "" }).localHostDomain, "kernal.run");
    assert.equal(loadConfig({ PREVIEW_DOMAIN: "kernal.run", LOCAL_HOST_DOMAIN: " " }).localHostDomain, "kernal.run");
    assert.equal(loadConfig({ PREVIEW_DOMAIN: "kernal.run", LOCAL_HOST_DOMAIN: "Hosts.Example.COM." }).localHostDomain, "hosts.example.com");
    assert.equal(loadConfig({}).localHostDomain, "");
  });

  test("the router key is its own setting, separate from LITELLM_ADMIN_KEY", () => {
    assert.equal(loadConfig({ LITELLM_ADMIN_KEY: "sk-a" }).localHostRouterKey, "");
    assert.equal(loadConfig({ LOCAL_HOST_ROUTER_KEY: " sk-b " }).localHostRouterKey, "sk-b");
  });
});
