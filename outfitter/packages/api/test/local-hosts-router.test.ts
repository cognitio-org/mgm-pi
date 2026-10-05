// #384 Local Host router reconciliation (docs/specs/local-host.md §3), against the fake LiteLLM
// (test/fake-litellm.ts /model/*). The payload, add/update/delete per host, the sweep removing stale
// hosts' entries, entries without our metadata or of another env left alone, duplicate clean-up,
// failures that never leak the bearer, and the server wiring.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bearerSecretName, internalUrl, localHostId, routerDeploymentId } from "../src/local-hosts/naming.ts";
import { LocalHostEvents } from "../src/local-hosts/events.ts";
import {
  buildDeployment,
  hostWantsEntries,
  localHostRouterListener,
  thinkingOffBody,
  type LocalHostRouterSync,
} from "../src/local-hosts/router-sync.ts";
import { routerFingerprint, type LocalHost } from "../src/store/local-hosts.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { MemorySecretAdmin } from "../src/secrets.ts";
import { createLitellmKeys } from "../src/central/litellm-keys.ts";
import { buildTestApp } from "./helpers.ts";
import { FakeLitellm, type FakeDeployment } from "./fake-litellm.ts";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const ADMIN = "sk-admin-test-key";
const ENV = "test-env";
const BEARER = "lhb_" + "B".repeat(43);
const BEARER2 = "lhb_" + "C".repeat(43);
const CONFIG = { litellmBaseUrl: "https://router.test/v1", litellmAdminKey: ADMIN, previewEnv: ENV };

function host(overrides: Partial<LocalHost> = {}, hostId = "h_" + "a".repeat(24)): LocalHost {
  const id = overrides.id ?? localHostId("u_1", hostId);
  return {
    id,
    userId: "u_1",
    ownerEmail: "mgm@example.com",
    hostId,
    deviceId: "dev_1",
    hostName: "Matthews-MacBook-Pro",
    accessGroup: "everyone",
    routerPrefix: "mgm-matthews-macbook-pro",
    shareModels: true,
    discoveryKey: "k1",
    servers: [
      { id: "http://localhost:1234", kind: "lmstudio", baseUrl: "http://localhost:1234/v1", ok: true, endpoints: ["/v1/models"], models: 3 },
      { id: "http://localhost:11434", kind: "ollama", baseUrl: "http://localhost:11434/v1", ok: true, endpoints: ["/api/tags"], models: 1 },
    ],
    models: [
      { id: "qwen/qwen3-coder-30b", server: "http://localhost:1234", kind: "lmstudio", loaded: true, contextLength: 32768, toolUse: true, type: "llm" },
      { id: "text-embedding-nomic", server: "http://localhost:1234", kind: "lmstudio", loaded: false, type: "embeddings" },
      { id: "bad id with spaces", server: "http://localhost:1234", kind: "lmstudio", loaded: false },
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

interface Setup {
  fake: FakeLitellm;
  store: MemoryStore;
  secrets: MemorySecretAdmin;
  sync: LocalHostRouterSync;
  logs: string[];
  clock: { now: Date };
}

async function setup(hosts: LocalHost[] = []): Promise<Setup> {
  const fake = new FakeLitellm();
  const store = new MemoryStore();
  const secrets = new MemorySecretAdmin();
  const logs: string[] = [];
  const clock = { now: NOW };
  for (const h of hosts) {
    await store.localHosts.upsert(h);
    if (h.managed) await secrets.addVersion(h.managed.bearerSecret, BEARER);
  }
  const sync = localHostRouterListener({
    store,
    config: CONFIG,
    secretAdmin: secrets,
    fetch: fake.fetch,
    log: (msg, err) => logs.push(`${msg} ${err ?? ""}`),
    now: () => clock.now,
  });
  return { fake, store, secrets, sync, logs, clock };
}

const writes = (fake: FakeLitellm) => fake.calls.filter((c) => c.method === "POST").map((c) => `${c.path} ${c.body.model_info?.id ?? c.body.id}`);
const names = (fake: FakeLitellm) => fake.deployments.map((d) => d.model_name).sort();

function foreign(overrides: Partial<FakeDeployment> = {}): FakeDeployment {
  return {
    model_name: "local-qwen-mlx",
    litellm_params: { model: "openai/qwen", api_base: "https://mgm-lmstudio.ngrok.app/v1", api_key: "secret" },
    model_info: { id: "hand-made-1" },
    ...overrides,
  };
}

describe("buildDeployment (§3.3)", () => {
  test("the payload for a chat model on LM Studio", () => {
    const h = host();
    const d = buildDeployment(h, h.models[0], { env: ENV, bearer: BEARER, now: NOW });
    assert.deepEqual(d, {
      model_name: "local/mgm-matthews-macbook-pro/qwen/qwen3-coder-30b",
      litellm_params: {
        model: "openai/qwen/qwen3-coder-30b",
        api_base: "https://lh-x.kernal.run/v1",
        api_key: BEARER,
        timeout: 600,
        stream_timeout: 600,
        max_retries: 0,
        extra_body: { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "none" },
      },
      model_info: {
        id: routerDeploymentId(h.id, "qwen/qwen3-coder-30b"),
        mode: "chat",
        max_input_tokens: 32768,
        supports_vision: false,
        supports_function_calling: true,
        access_groups: ["local-hosts"],
        description: "On Matthews-MacBook-Pro (mgm@example.com), LM Studio, loaded. A request to a model that isn't loaded loads it first, which can take minutes.",
        metadata: {
          outfitter: "local-host",
          env: ENV,
          hostId: h.id,
          ownerUserId: "u_1",
          modelId: "qwen/qwen3-coder-30b",
          fingerprint: routerFingerprint(h, NOW),
        },
      },
    });
  });

  test("an embedding model: mode embedding, no thinking switch, no max_input_tokens when unknown", () => {
    const h = host();
    const d = buildDeployment(h, h.models[1], { env: ENV, bearer: BEARER, now: NOW });
    assert.equal(d.model_info.mode, "embedding");
    assert.ok(!("extra_body" in d.litellm_params));
    assert.ok(!("max_input_tokens" in d.model_info));
    assert.match(d.model_info.description, /, not loaded\./);
  });

  test("the thinking switch per server kind: reasoning_effort only where it is understood", () => {
    const base = { id: "m", server: "s", loaded: true } as const;
    assert.deepEqual(thinkingOffBody({ ...base, kind: "ollama" }), { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "none" });
    for (const kind of ["vllm", "llamacpp", "mlx-lm", "openai"] as const) {
      assert.deepEqual(thinkingOffBody({ ...base, kind }), { chat_template_kwargs: { enable_thinking: false } }, kind);
    }
  });

  test("hostWantsEntries: online, managed, with a public URL and bearer secret only", () => {
    assert.equal(hostWantsEntries(host(), NOW), true);
    assert.equal(hostWantsEntries(host({ tunnel: { ...host().tunnel, managed: false } }), NOW), false);
    assert.equal(hostWantsEntries(host({ tunnel: { ...host().tunnel, state: "down" } }), NOW), false);
    assert.equal(hostWantsEntries(host({ shareModels: false }), NOW), false);
    assert.equal(hostWantsEntries(host({ revokedAt: ago(1) }), NOW), false);
    assert.equal(hostWantsEntries(host({ lastSeenAt: ago(961) }), NOW), false);
    assert.equal(hostWantsEntries(host({ managed: { ...host().managed!, publicUrl: undefined } }), NOW), false);
    assert.equal(hostWantsEntries(host({ managed: undefined }), NOW), false);
  });
});

describe("onChange (§3.4): one host", () => {
  test("adds one entry per routable shared model with the admin key on the management root", async () => {
    const h = host();
    const { fake, sync } = await setup([h]);
    await sync.onChange({ reason: "heartbeat", host: h });
    assert.deepEqual(names(fake), [
      "local/mgm-matthews-macbook-pro/qwen/qwen3-coder-30b",
      "local/mgm-matthews-macbook-pro/text-embedding-nomic",
    ]);
    for (const c of fake.calls) {
      assert.equal(c.authorization, `Bearer ${ADMIN}`);
      assert.ok(!c.path.startsWith("/v1"), c.path);
    }
    assert.equal(fake.deployments[0].litellm_params.api_key, BEARER);
    assert.deepEqual(fake.callsTo("/model/new").length, 2);
  });

  test("is idempotent: a second change with nothing new writes nothing", async () => {
    const h = host();
    const { fake, sync } = await setup([h]);
    await sync.onChange({ reason: "heartbeat", host: h });
    const before = writes(fake).length;
    await sync.onChange({ reason: "heartbeat", host: h });
    assert.equal(writes(fake).length, before);
  });

  test("a changed model updates its entry in place (same id); a removed one is deleted", async () => {
    const h = host();
    const { fake, store, sync } = await setup([h]);
    await sync.onChange({ reason: "heartbeat", host: h });
    const next = { ...h, models: [{ ...h.models[0], loaded: false }] };
    await store.localHosts.upsert(next);
    fake.calls.length = 0;
    await sync.onChange({ reason: "heartbeat", host: next, previous: h });
    const qwen = routerDeploymentId(h.id, "qwen/qwen3-coder-30b");
    assert.deepEqual(writes(fake).sort(), [`/model/delete ${routerDeploymentId(h.id, "text-embedding-nomic")}`, `/model/update ${qwen}`]);
    assert.equal(fake.deployments.length, 1);
    assert.match(fake.deployments[0].model_info.description, /not loaded/);
    assert.equal(fake.deployments[0].model_info.metadata.fingerprint, routerFingerprint(next, NOW));
  });

  test("new credentials (bearer version) rewrite api_key and api_base", async () => {
    const h = host();
    const { fake, store, secrets, sync } = await setup([h]);
    await sync.onChange({ reason: "heartbeat", host: h });
    await secrets.addVersion(h.managed!.bearerSecret, BEARER2);
    const next = { ...h, managed: { ...h.managed!, bearerVersion: 2, publicUrl: "https://lh-y.kernal.run/" } };
    await store.localHosts.upsert(next);
    await sync.onChange({ reason: "credentials", host: next, previous: h });
    assert.equal(fake.callsTo("/model/update").length, 2);
    for (const d of fake.deployments) {
      assert.equal(d.litellm_params.api_key, BEARER2);
      assert.equal(d.litellm_params.api_base, "https://lh-y.kernal.run/v1");
    }
  });

  for (const [label, change] of [
    ["the tunnel went down", (h: LocalHost) => ({ ...h, tunnel: { ...h.tunnel, state: "stopped" as const } })],
    ["sharing turned off", (h: LocalHost) => ({ ...h, shareModels: false })],
    ["the tunnel runs on interim credentials", (h: LocalHost) => ({ ...h, tunnel: { ...h.tunnel, managed: false } })],
    ["the cloud endpoint is gone", (h: LocalHost) => ({ ...h, managed: { ...h.managed!, publicUrl: undefined, endpointId: undefined } })],
  ] as const) {
    test(`every entry goes when ${label}`, async () => {
      const h = host();
      const { fake, store, sync } = await setup([h]);
      await sync.onChange({ reason: "heartbeat", host: h });
      const next = change(h);
      await store.localHosts.upsert(next);
      await sync.onChange({ reason: "heartbeat", host: next, previous: h });
      assert.equal(fake.deployments.length, 0);
    });
  }

  test("deleted and device-revoked mean no entries, whatever the event's record says", async () => {
    const h = host();
    const { fake, store, sync } = await setup([h]);
    await sync.onChange({ reason: "heartbeat", host: h });
    await sync.onChange({ reason: "device-revoked", host: h });
    assert.equal(fake.deployments.length, 0);
    await sync.onChange({ reason: "heartbeat", host: h });
    assert.equal(fake.deployments.length, 2);
    await store.localHosts.delete(h.id);
    await sync.onChange({ reason: "deleted", host: h });
    assert.equal(fake.deployments.length, 0);
  });

  test("a record that is gone from the store wants nothing, even on a heartbeat event", async () => {
    const h = host();
    const { fake, store, sync } = await setup([h]);
    await sync.onChange({ reason: "heartbeat", host: h });
    await store.localHosts.delete(h.id);
    await sync.onChange({ reason: "heartbeat", host: h });
    assert.equal(fake.deployments.length, 0);
  });

  test("only touches entries that name this host", async () => {
    const a = host();
    const b = host({ routerPrefix: "mgm-other" }, "h_" + "b".repeat(24));
    const { fake, sync } = await setup([a, b]);
    fake.deployments.push(foreign());
    await sync.onChange({ reason: "heartbeat", host: a });
    await sync.onChange({ reason: "heartbeat", host: b });
    await sync.onChange({ reason: "device-revoked", host: a });
    assert.deepEqual(names(fake), ["local-qwen-mlx", "local/mgm-other/qwen/qwen3-coder-30b", "local/mgm-other/text-embedding-nomic"]);
  });

  test("two changes at once for one host are serialised: no duplicate add", async () => {
    const h = host();
    const { fake, sync } = await setup([h]);
    await Promise.all([sync.onChange({ reason: "heartbeat", host: h }), sync.onChange({ reason: "credentials", host: h })]);
    assert.equal(fake.callsTo("/model/new").length, 2);
    assert.equal(fake.deployments.length, 2);
  });

  test("a failure rejects with a short line, without the bearer, and the events seam reports it", async () => {
    const h = host();
    const { fake, sync, logs } = await setup([h]);
    fake.failNext("/model/new", 500, { error: { message: `upstream echoed ${BEARER} and sk-abc123` } });
    const events = new LocalHostEvents();
    events.register(sync);
    const { problems } = await events.changed({ reason: "heartbeat", host: h });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^router: LiteLLM \/model\/new answered 500/);
    for (const text of [...problems, ...logs]) {
      assert.ok(!text.includes(BEARER), text);
      assert.ok(!text.includes("sk-abc123"), text);
    }
    // The other model still made it; the next change repairs the rest.
    assert.equal(fake.deployments.length, 1);
    await sync.onChange({ reason: "heartbeat", host: h });
    assert.equal(fake.deployments.length, 2);
  });

  test("LiteLLM down: the change rejects with 'LiteLLM did not answer'", async () => {
    const h = host();
    const { fake, sync } = await setup([h]);
    fake.down = true;
    await assert.rejects(sync.onChange({ reason: "heartbeat", host: h }), /LiteLLM did not answer/);
  });

  test("no bearer in Secret Manager: a failure, and existing entries stay", async () => {
    const h = host();
    const { fake, store, sync } = await setup([h]);
    await sync.onChange({ reason: "heartbeat", host: h });
    const next = { ...h, managed: { ...h.managed!, bearerSecret: "outfitter-localhost-missing", bearerVersion: 2 } };
    await store.localHosts.upsert(next);
    await assert.rejects(sync.onChange({ reason: "credentials", host: next }), /no enabled version/);
    assert.equal(fake.deployments.length, 2);
  });
});

describe("sweep (§3.4): every host from one /model/info", () => {
  test("adds what is missing, removes a stale host's entries, leaves foreign and other-env entries alone", async () => {
    const online = host();
    const stale = host({ routerPrefix: "mgm-stale" }, "h_" + "c".repeat(24));
    const { fake, store, sync, clock } = await setup([online, stale]);
    await sync.onChange({ reason: "heartbeat", host: stale });
    assert.equal(fake.deployments.length, 2);
    const otherEnv = structuredClone(fake.deployments[0]);
    otherEnv.model_info.id = "other-env-entry";
    otherEnv.model_info.metadata.env = "prod";
    fake.deployments.push(foreign(), foreign({ model_name: "local/x/y", model_info: { id: "no-metadata" } }), otherEnv);
    // 20 minutes on, `stale` has missed three heartbeats; `online` heartbeats again.
    clock.now = new Date(NOW.getTime() + 20 * 60_000);
    online.lastSeenAt = clock.now.toISOString();
    await store.localHosts.upsert(online);
    fake.calls.length = 0;
    const counts = await sync.sweep();
    assert.deepEqual(counts, { added: 2, updated: 0, deleted: 2, failed: 0 });
    assert.equal(fake.callsTo("/model/info").length, 1);
    assert.deepEqual(names(fake), [
      "local-qwen-mlx",
      "local/mgm-matthews-macbook-pro/qwen/qwen3-coder-30b",
      "local/mgm-matthews-macbook-pro/text-embedding-nomic",
      "local/mgm-stale/qwen/qwen3-coder-30b",
      "local/x/y",
    ]);
    assert.ok(fake.deployments.some((d) => d.model_info.id === "other-env-entry"));
    // Nothing left to do.
    assert.deepEqual(await sync.sweep(), { added: 0, updated: 0, deleted: 0, failed: 0 });
  });

  test("removes entries of a host that no longer exists or stopped sharing", async () => {
    const h = host();
    const { fake, store, sync } = await setup([h]);
    await sync.onChange({ reason: "heartbeat", host: h });
    await store.localHosts.delete(h.id);
    assert.deepEqual(await sync.sweep(), { added: 0, updated: 0, deleted: 2, failed: 0 });
    assert.equal(fake.deployments.length, 0);
  });

  test("keeps one entry per model_info.id when two instances added the same one", async () => {
    const h = host();
    const { fake, sync } = await setup([h]);
    await sync.onChange({ reason: "heartbeat", host: h });
    fake.deployments.push(structuredClone(fake.deployments[0]), structuredClone(fake.deployments[0]));
    const counts = await sync.sweep();
    assert.deepEqual(counts, { added: 0, updated: 0, deleted: 2, failed: 0 });
    const ids = fake.deployments.map((d) => d.model_info.id).sort();
    assert.deepEqual(ids, [...new Set(ids)]);
    assert.equal(fake.deployments.length, 2);
    // The restored copy carries the bearer again.
    assert.ok(fake.deployments.every((d) => d.litellm_params.api_key === BEARER));
  });

  test("repairs an entry whose params drifted (hand-edited api_base)", async () => {
    const h = host();
    const { fake, sync } = await setup([h]);
    await sync.onChange({ reason: "heartbeat", host: h });
    fake.deployments[0].litellm_params.api_base = "https://evil.example/v1";
    assert.deepEqual(await sync.sweep(), { added: 0, updated: 1, deleted: 0, failed: 0 });
    assert.equal(fake.deployments[0].litellm_params.api_base, "https://lh-x.kernal.run/v1");
  });

  test("counts failures and keeps going; reads each bearer version from Secret Manager once", async () => {
    const a = host();
    const b = host({ routerPrefix: "mgm-other" }, "h_" + "b".repeat(24));
    const { fake, secrets, sync } = await setup([a, b]);
    let reads = 0;
    const accessLatest = secrets.accessLatest.bind(secrets);
    secrets.accessLatest = async (name: string) => {
      reads++;
      return accessLatest(name);
    };
    fake.failNext("/model/new", 500);
    const first = await sync.sweep();
    assert.deepEqual(first, { added: 3, updated: 0, deleted: 0, failed: 1 });
    const second = await sync.sweep();
    assert.deepEqual(second, { added: 1, updated: 0, deleted: 0, failed: 0 });
    assert.equal(reads, 2);
  });

  test("LiteLLM down: the sweep rejects (the events seam logs it and leaves it out)", async () => {
    const { fake, sync } = await setup([host()]);
    fake.down = true;
    await assert.rejects(sync.sweep(), /LiteLLM did not answer/);
    const events = new LocalHostEvents();
    events.register(sync);
    assert.deepEqual(await events.sweep(), {});
  });
});

describe("server wiring (§3.4, §5)", () => {
  test("no listener without LITELLM_ADMIN_KEY: the tick's localHosts has no router counts", async () => {
    const store = new MemoryStore();
    const fake = new FakeLitellm();
    // Minting injected (as other tests do) but no admin key in config: nothing may call the router.
    const keys = createLitellmKeys({ litellmBaseUrl: "https://router.test/v1", litellmAdminKey: ADMIN }, store, { fetch: fake.fetch })!;
    const app = await buildTestApp({}, { store, litellmKeys: keys });
    try {
      assert.deepEqual(await app.localHostEvents.sweep(), {});
      assert.deepEqual(fake.calls.filter((c) => c.path.startsWith("/model/")), []);
    } finally {
      await app.fastify.close();
    }
  });
});
