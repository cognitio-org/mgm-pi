// E2.10 provider status service: probe parsing (ngrok/laptop/litellm/cloudrun), the reconcile loop
// (status transitions, 7-day history bounding, SSE publish-on-transition-only), and the routes. The
// webhook's immediate laptop update is covered in hooks.test.ts (verifyNgrokSignature / route
// wiring) plus one assertion here that it's reflected through GET /api/providers.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory.ts";
import { SseHub, type SseEvent } from "../src/sse.ts";
import { LaptopProbe } from "../src/laptop.ts";
import type { SandboxCapacity } from "@outfitter/provider-local";
import {
  ProviderStatusService,
  probeNgrok,
  probeLaptop,
  probeLitellm,
  probeSandbox,
  sandboxTargets,
  DEFAULT_TIMEOUT_MS,
  SANDBOX_TIMEOUT_MS,
  NOT_REGISTERED_DETAIL,
  type SandboxCapacitySource,
  parseNgrokEndpoints,
  parseModelInfo,
  parseKeyInfo,
  parseLmStudioModels,
} from "../src/providers-status.ts";
import { buildTestApp } from "./helpers.ts";

function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => handler(String(input), init)) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------- parsing ----------

describe("parseNgrokEndpoints", () => {
  test("reads the current /endpoints shape", () => {
    assert.deepEqual(parseNgrokEndpoints({ endpoints: [{ id: "ep_1" }] }), [{ id: "ep_1" }]);
  });

  test("falls back to the legacy /tunnels shape", () => {
    assert.deepEqual(parseNgrokEndpoints({ tunnels: [{ id: "t_1" }] }), [{ id: "t_1" }]);
  });

  test("an unrecognized shape is an empty list, not a throw", () => {
    assert.deepEqual(parseNgrokEndpoints({}), []);
    assert.deepEqual(parseNgrokEndpoints(undefined), []);
  });
});

describe("parseModelInfo (copied from kernal connect/lib.ts)", () => {
  test("skips non-chat modes and dedupes by model_name, converting per-token costs to per-million", () => {
    const { ids, meta } = parseModelInfo({
      data: [
        { model_name: "gpt-5-mini", model_info: { mode: "chat", input_cost_per_token: 0.000001, output_cost_per_token: 0.000005 } },
        { model_name: "gpt-5-mini", model_info: { mode: "chat", input_cost_per_token: 0.5 } }, // duplicate, ignored
        { model_name: "embedding-model", model_info: { mode: "embedding" } }, // dropped: not chat
        { model_name: "", model_info: { mode: "chat" } }, // dropped: no model_name
      ],
    });
    assert.deepEqual(ids, ["gpt-5-mini"]);
    assert.equal(meta.get("gpt-5-mini")?.cost.input, 1);
    assert.equal(meta.get("gpt-5-mini")?.cost.output, 5);
  });

  test("an empty/malformed body parses to no models instead of throwing", () => {
    assert.deepEqual(parseModelInfo(undefined).ids, []);
    assert.deepEqual(parseModelInfo({}).ids, []);
  });
});

describe("parseKeyInfo", () => {
  test("reads spend/max_budget nested under info", () => {
    assert.deepEqual(parseKeyInfo({ info: { spend: 1.5, max_budget: 10 } }), { spend: 1.5, maxBudget: 10 });
  });

  test("falls back to top-level spend/max_budget", () => {
    assert.deepEqual(parseKeyInfo({ spend: 2, max_budget: null }), { spend: 2, maxBudget: null });
  });
});

describe("parseLmStudioModels", () => {
  test("prefers loaded_context_length when loaded, max_context_length otherwise; drops non llm/vlm types", () => {
    const models = parseLmStudioModels({
      data: [
        { id: "qwen", type: "llm", state: "loaded", loaded_context_length: 32000, max_context_length: 128000 },
        { id: "idle-model", type: "llm", state: "not-loaded", max_context_length: 8000 },
        { id: "embed", type: "embeddings", state: "loaded", loaded_context_length: 512 },
      ],
    });
    assert.deepEqual(models, [
      { id: "qwen", contextWindow: 32000, loaded: true },
      { id: "idle-model", contextWindow: 8000, loaded: false },
    ]);
  });
});

// ---------- probes ----------

describe("probeNgrok", () => {
  test("no API key: a single unknown row, never a network call", async () => {
    let called = false;
    const rows = await probeNgrok("", 3000, fakeFetch(() => {
      called = true;
      return jsonResponse({ endpoints: [] });
    }));
    assert.equal(called, false);
    assert.deepEqual(rows, [{ id: "ngrok", kind: "ngrok", name: "ngrok", status: "unknown", detail: "not configured", checkedAt: rows[0].checkedAt }]);
  });

  test("one row per online endpoint", async () => {
    const rows = await probeNgrok(
      "key",
      3000,
      fakeFetch(() =>
        jsonResponse({
          endpoints: [
            { id: "ep_1", hostname: "a.ngrok.app", proto: "https" },
            { id: "ep_2", hostname: "b.ngrok.app", proto: "https" },
          ],
        }),
      ),
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "ngrok:ep_1");
    assert.equal(rows[0].status, "up");
    assert.equal(rows[1].id, "ngrok:ep_2");
  });

  test("a successful but empty endpoint list reports down, not an empty row set", async () => {
    const rows = await probeNgrok("key", 3000, fakeFetch(() => jsonResponse({ endpoints: [] })));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "down");
  });

  test("a network failure reports down with the error message, never throws", async () => {
    const rows = await probeNgrok(
      "key",
      3000,
      fakeFetch(() => {
        throw new Error("boom");
      }),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "down");
    assert.match(rows[0].detail ?? "", /boom/);
  });
});

describe("probeLaptop", () => {
  test("no tunnel domain configured: unknown, LaptopProbe never consulted", async () => {
    const probe = new LaptopProbe({ tunnelDomain: "", token: "", fetchImpl: fakeFetch(() => jsonResponse({})) });
    const rows = await probeLaptop(probe, "", "tok");
    assert.equal(rows[0].status, "unknown");
    assert.equal(rows[0].detail, "not configured");
  });

  test("reuses LaptopProbe's own cached reachability (no duplicate probe of /v1/models)", async () => {
    let modelsFetches = 0;
    const laptopProbe = new LaptopProbe({
      tunnelDomain: "x.ngrok.app",
      token: "tok",
      cacheMs: 60_000,
      fetchImpl: fakeFetch(() => jsonResponse([])), // LaptopProbe's own /v1/models check, cached after this
    });
    await laptopProbe.isOnline(); // warms LaptopProbe's cache once

    const rows = await probeLaptop(
      laptopProbe,
      "x.ngrok.app",
      "tok",
      3000,
      fakeFetch((url) => {
        modelsFetches++;
        assert.match(url, /\/api\/v0\/models$/);
        return jsonResponse({ data: [{ id: "qwen", type: "llm", state: "loaded", loaded_context_length: 4096 }] });
      }),
    );
    assert.equal(rows[0].status, "up");
    assert.deepEqual((rows[0].meta as { models: unknown[] }).models, [{ id: "qwen", contextWindow: 4096, loaded: true }]);
    assert.equal(modelsFetches, 1); // only the /api/v0/models call, not another /v1/models probe
  });

  test("offline per LaptopProbe: down, no /api/v0/models call at all", async () => {
    let called = false;
    const laptopProbe = new LaptopProbe({ tunnelDomain: "x.ngrok.app", token: "tok", fetchImpl: fakeFetch(() => new Response("", { status: 502 })) });
    const rows = await probeLaptop(laptopProbe, "x.ngrok.app", "tok", 3000, fakeFetch(() => {
      called = true;
      return jsonResponse({});
    }));
    assert.equal(rows[0].status, "down");
    assert.equal(called, false);
  });

  test("online but the models call fails: still up, with a detail instead of meta", async () => {
    const laptopProbe = new LaptopProbe({ tunnelDomain: "x.ngrok.app", token: "tok", fetchImpl: fakeFetch(() => jsonResponse([])) });
    await laptopProbe.isOnline();
    const rows = await probeLaptop(laptopProbe, "x.ngrok.app", "tok", 3000, fakeFetch(() => {
      throw new Error("network down");
    }));
    assert.equal(rows[0].status, "up");
    assert.equal(rows[0].detail, "model list unavailable: network down");
  });
});

describe("probeLitellm", () => {
  test("no key resolvable: unknown, never a network call", async () => {
    let called = false;
    const rows = await probeLitellm("https://litellm.example/v1", async () => "", 3000, fakeFetch(() => {
      called = true;
      return jsonResponse({});
    }));
    assert.equal(called, false);
    assert.equal(rows[0].status, "unknown");
    assert.equal(rows[0].detail, "not configured");
  });

  test("healthy liveliness + model/info + key/info combine into one row", async () => {
    const rows = await probeLitellm(
      "https://litellm.example/v1",
      async () => "admin-key",
      3000,
      fakeFetch((url) => {
        if (url.endsWith("/health/liveliness")) return new Response("I'm alive!", { status: 200 });
        if (url.endsWith("/model/info")) {
          return jsonResponse({ data: [{ model_name: "gpt-5-mini", model_info: { mode: "chat", input_cost_per_token: 0.000003 } }] });
        }
        if (url.endsWith("/key/info")) return jsonResponse({ info: { spend: 4.2, max_budget: 50 } });
        throw new Error(`unexpected url ${url}`);
      }),
    );
    const row = rows[0];
    assert.equal(row.status, "up");
    assert.equal(row.id, "litellm");
    assert.deepEqual((row.meta as { models: string[] }).models, ["gpt-5-mini"]);
    assert.deepEqual((row.meta as { key: unknown }).key, { spend: 4.2, maxBudget: 50 });
  });

  test("a failing liveliness check reports down even when model/info succeeds", async () => {
    const rows = await probeLitellm(
      "https://litellm.example/v1",
      async () => "admin-key",
      3000,
      fakeFetch((url) => {
        if (url.endsWith("/health/liveliness")) return new Response("down", { status: 503 });
        return jsonResponse({ data: [] });
      }),
    );
    assert.equal(rows[0].status, "down");
    assert.match(rows[0].detail ?? "", /503/);
  });

  test("/model/info and /key/info failing independently doesn't fail the whole probe", async () => {
    const rows = await probeLitellm(
      "https://litellm.example/v1",
      async () => "admin-key",
      3000,
      fakeFetch((url) => {
        if (url.endsWith("/health/liveliness")) return new Response("ok", { status: 200 });
        return new Response("error", { status: 500 });
      }),
    );
    assert.equal(rows[0].status, "up");
    assert.deepEqual((rows[0].meta as { models: string[] }).models, []);
  });
});

describe("probeSandbox", () => {
  test("SANDBOX_PROVIDER not a cloud provider (inprocess): unknown, capacityFn never called", async () => {
    let called = false;
    const rows = await probeSandbox("inprocess", async () => {
      called = true;
      return { active: 1 };
    });
    assert.equal(rows[0].status, "unknown");
    assert.equal(rows[0].id, "cloudrun"); // the historical default row; nothing gke-specific to show
    assert.equal(called, false);
  });

  test("cloudrun with a working capacity(): up, with active/runningExecutions in meta", async () => {
    const rows = await probeSandbox("cloudrun", async () => ({ active: 3 }));
    assert.equal(rows[0].status, "up");
    assert.equal(rows[0].id, "cloudrun");
    assert.deepEqual(rows[0].meta, { active: 3, runningExecutions: 3 });
  });

  test("gke with a working capacity(): its own row, id/kind 'gke', warm fields included when present", async () => {
    const rows = await probeSandbox("gke", async () => ({ active: 2, warmReady: 1, warmDesired: 1, limit: 3 }));
    assert.equal(rows[0].status, "up");
    assert.equal(rows[0].id, "gke");
    assert.equal(rows[0].kind, "gke");
    assert.deepEqual(rows[0].meta, { active: 2, runningExecutions: 2, warmReady: 1, warmDesired: 1, limit: 3 });
  });

  test("cloudrun with a failing capacity(): down, never throws", async () => {
    const rows = await probeSandbox("cloudrun", async () => {
      throw new Error("permission denied");
    });
    assert.equal(rows[0].status, "down");
    assert.match(rows[0].detail ?? "", /permission denied/);
  });

  test("cloudrun with a capacity() that never resolves: down, bounded by timeoutMs", async () => {
    const startedAt = Date.now();
    const rows = await probeSandbox("cloudrun", () => new Promise(() => {}), 20);
    assert.equal(rows[0].status, "down");
    assert.ok(Date.now() - startedAt < 1000);
  });

  test("isDefault marks the row only when asked", async () => {
    const [def] = await probeSandbox("gke", async () => ({ active: 0 }), 100, true);
    const [other] = await probeSandbox("cloudrun", async () => ({ active: 0 }), 100);
    assert.equal(def.isDefault, true);
    assert.equal("isDefault" in other, false);
  });

  test("a provider with no capacity() (capacityFn resolves undefined): unknown, not down", async () => {
    const [row] = await probeSandbox("cloudrun", async () => undefined, 100);
    assert.equal(row.status, "unknown");
    assert.equal(row.detail, "no capacity probe");
  });

  test("the sandbox probe's default timeout is the longer SANDBOX_TIMEOUT_MS (about 10 s), not the 3 s one", () => {
    assert.equal(SANDBOX_TIMEOUT_MS, 10_000);
    assert.ok(SANDBOX_TIMEOUT_MS > DEFAULT_TIMEOUT_MS);
    assert.equal(DEFAULT_TIMEOUT_MS, 3_000, "the other probes keep their 3 s");
  });
});

describe("sandboxTargets", () => {
  test("every registered cloud provider, default first; local dev providers never get a row", () => {
    assert.deepEqual(sandboxTargets("gke", ["cloudrun", "gke"]), ["gke", "cloudrun"]);
    assert.deepEqual(sandboxTargets("cloudrun", ["gke", "cloudrun"]), ["cloudrun", "gke"]);
    assert.deepEqual(sandboxTargets("docker", ["docker", "gke"]), ["gke"]);
  });

  test("a local dev default with no cloud provider registered keeps the historical single row", () => {
    assert.deepEqual(sandboxTargets("inprocess", ["inprocess"]), ["inprocess"]);
  });
});

// ---------- the service: reconcile, history bounding, SSE ----------

function buildService(store: MemoryStore, sse: SseHub, overrides: { sandboxCapacity?: () => Promise<SandboxCapacity> } = {}) {
  const laptopProbe = new LaptopProbe({ tunnelDomain: "", token: "" });
  return new ProviderStatusService({
    store,
    sse,
    laptopProbe,
    config: {
      ngrokApiKey: "",
      tunnelDomainLmstudio: "",
      localTunnelToken: "",
      litellmBaseUrl: "https://litellm.example/v1",
      sandboxProvider: "cloudrun",
    },
    litellmKey: async () => "",
    sandboxCapacity: overrides.sandboxCapacity,
  });
}

/** Like buildService, but with a registry-shaped sandbox source (production's shape, #169). */
function buildMultiService(
  store: MemoryStore,
  sse: SseHub,
  opts: { defaultName: "gke" | "cloudrun"; sandboxes: SandboxCapacitySource; timeoutMs?: number; sandboxTimeoutMs?: number },
) {
  return new ProviderStatusService({
    store,
    sse,
    laptopProbe: new LaptopProbe({ tunnelDomain: "", token: "" }),
    config: {
      ngrokApiKey: "",
      tunnelDomainLmstudio: "",
      localTunnelToken: "",
      litellmBaseUrl: "https://litellm.example/v1",
      sandboxProvider: opts.defaultName,
    },
    litellmKey: async () => "",
    sandboxes: opts.sandboxes,
    timeoutMs: opts.timeoutMs,
    sandboxTimeoutMs: opts.sandboxTimeoutMs,
  });
}

describe("ProviderStatusService: every registered sandbox provider (#169)", () => {
  test("probes gke and cloudrun both while both are registered, in parallel, marking only the default", async () => {
    const store = new MemoryStore();
    const probed: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const service = buildMultiService(store, new SseHub(), {
      defaultName: "gke",
      sandboxes: {
        names: ["gke", "cloudrun"],
        capacity: async (name) => {
          probed.push(name);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 10));
          inFlight--;
          return name === "gke" ? { active: 1, warmReady: 1, warmDesired: 1, limit: 3 } : { active: 0 };
        },
      },
    });

    const rows = await service.pollOnce();
    const gke = rows.find((r) => r.id === "gke");
    const cloudrun = rows.find((r) => r.id === "cloudrun");
    assert.equal(gke?.status, "up");
    assert.equal(gke?.isDefault, true);
    assert.equal(cloudrun?.status, "up");
    assert.equal(cloudrun?.isDefault, undefined);
    assert.deepEqual(cloudrun?.meta, { active: 0, runningExecutions: 0 });
    assert.deepEqual(probed.sort(), ["cloudrun", "gke"]);
    assert.equal(maxInFlight, 2, "the two capacity probes ran concurrently");
  });

  test("the non-default provider's row is refreshed every poll: a failure there shows, and doesn't touch the default", async () => {
    const store = new MemoryStore();
    let cloudrunFails = false;
    const service = buildMultiService(store, new SseHub(), {
      defaultName: "gke",
      sandboxes: {
        names: ["gke", "cloudrun"],
        capacity: async (name) => {
          if (name === "cloudrun" && cloudrunFails) throw new Error("permission denied");
          return { active: 0 };
        },
      },
    });
    await service.pollOnce();
    cloudrunFails = true;
    const rows = await service.pollOnce();
    assert.equal(rows.find((r) => r.id === "cloudrun")?.status, "down");
    assert.match(rows.find((r) => r.id === "cloudrun")?.detail ?? "", /permission denied/);
    assert.equal(rows.find((r) => r.id === "gke")?.status, "up");
  });

  test("after the switch, the old default's stored row loses its default marker", async () => {
    const store = new MemoryStore();
    await store.providers.upsert({
      id: "cloudrun",
      kind: "cloudrun",
      name: "Cloud Run agent job",
      status: "up",
      checkedAt: "2026-09-25T00:00:00.000Z",
      isDefault: true,
      meta: { active: 2, runningExecutions: 2 },
      history: [{ status: "up", at: "2026-09-25T00:00:00.000Z" }],
    });
    const service = buildMultiService(store, new SseHub(), {
      defaultName: "gke",
      sandboxes: { names: ["gke", "cloudrun"], capacity: async () => ({ active: 0 }) },
    });
    const rows = await service.pollOnce();
    const cloudrun = rows.find((r) => r.id === "cloudrun");
    assert.equal(cloudrun?.isDefault, undefined);
    assert.notEqual(cloudrun?.checkedAt, "2026-09-25T00:00:00.000Z", "re-probed, not the pre-switch row");
    assert.equal(rows.filter((r) => r.isDefault).map((r) => r.id).join(), "gke");
  });

  test("a stored sandbox row whose provider is no longer registered is marked unknown once and left out of current rows", async () => {
    const store = new MemoryStore();
    const sse = new SseHub();
    const published: SseEvent[] = [];
    (sse as unknown as { publish: SseHub["publish"] }).publish = (_channel, event) => published.push(event);
    await store.providers.upsert({
      id: "cloudrun",
      kind: "cloudrun",
      name: "Cloud Run agent job",
      status: "up",
      checkedAt: "2026-09-25T00:00:00.000Z",
      meta: { active: 2, runningExecutions: 2 },
      history: [{ status: "up", at: new Date().toISOString() }],
    });
    const service = buildMultiService(store, sse, {
      defaultName: "gke",
      sandboxes: { names: ["gke"], capacity: async () => ({ active: 0 }) },
    });

    const rows = await service.pollOnce();
    assert.equal(rows.some((r) => r.id === "cloudrun"), false, "no ghost row in GET /api/providers");
    assert.equal(rows.find((r) => r.id === "gke")?.isDefault, true);

    const record = await store.providers.findById("cloudrun");
    assert.ok(record);
    assert.equal(record.status, "unknown");
    assert.equal(record.detail, NOT_REGISTERED_DETAIL);
    assert.equal(record.meta, undefined, "its last live capacity is dropped");
    assert.deepEqual(record.history.map((h) => h.status), ["up", "unknown"]);
    const markedAt = record.checkedAt;

    published.length = 0;
    await service.pollOnce();
    assert.equal(published.length, 0, "nothing transitioned on the second poll");
    assert.equal((await store.providers.findById("cloudrun"))?.checkedAt, markedAt, "marked once, not rewritten every poll");
  });

  test("a sandbox probe that crashed outright never gets its (still registered) row marked unregistered", async () => {
    const store = new MemoryStore();
    const service = buildMultiService(store, new SseHub(), {
      defaultName: "gke",
      sandboxes: {
        names: ["gke", "cloudrun"],
        capacity: async (name) => {
          if (name === "cloudrun") throw new Error("boom");
          return { active: 0 };
        },
      },
    });
    const rows = await service.pollOnce();
    assert.equal(rows.find((r) => r.id === "cloudrun")?.status, "down");
    assert.notEqual(rows.find((r) => r.id === "cloudrun")?.detail, NOT_REGISTERED_DETAIL);
  });

  test("sandbox probes use their own, longer timeout; the other probes keep theirs", async () => {
    const store = new MemoryStore();
    // A capacity() slower than the general timeout but within the sandbox one reports up...
    const slowButFine = buildMultiService(store, new SseHub(), {
      defaultName: "gke",
      timeoutMs: 20,
      sandboxTimeoutMs: 1_000,
      sandboxes: {
        names: ["gke"],
        capacity: async () => {
          await new Promise((r) => setTimeout(r, 80));
          return { active: 0 };
        },
      },
    });
    assert.equal((await slowButFine.pollOnce()).find((r) => r.id === "gke")?.status, "up");

    // ...and one that never answers is cut off at the sandbox timeout, saying so.
    const hung = buildMultiService(new MemoryStore(), new SseHub(), {
      defaultName: "gke",
      timeoutMs: 1_000,
      sandboxTimeoutMs: 30,
      sandboxes: { names: ["gke"], capacity: () => new Promise(() => {}) },
    });
    const row = (await hung.pollOnce()).find((r) => r.id === "gke");
    assert.equal(row?.status, "down");
    assert.match(row?.detail ?? "", /timed out after 30ms/);
  });
});

describe("probe failure detail", () => {
  test("a LiteLLM health check that times out says so instead of reporting HTTP 0", async () => {
    const hang = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    }));
    const rows = await probeLitellm("https://litellm.example/v1", async () => "k", 20, hang);
    assert.equal(rows[0].status, "down");
    assert.equal(rows[0].detail, "health check failed: timed out after 20 ms");
  });

  test("a LiteLLM network error carries its message", async () => {
    const rows = await probeLitellm("https://litellm.example/v1", async () => "k", 3000, fakeFetch(() => {
      throw new TypeError("fetch failed");
    }));
    assert.equal(rows[0].detail, "health check failed: fetch failed");
  });

  test("a real non-2xx still reports its status code", async () => {
    const rows = await probeLitellm("https://litellm.example/v1", async () => "k", 3000, fakeFetch(() => jsonResponse({}, 503)));
    assert.equal(rows[0].detail, "health check HTTP 503");
  });
});

describe("ProviderStatusService.refreshIfStale", () => {
  test("polls on the first read, then serves stored rows until they are older than maxAge", async () => {
    let calls = 0;
    const service = buildService(new MemoryStore(), new SseHub(), { sandboxCapacity: async () => { calls++; return { active: 1 }; } });
    const first = await service.refreshIfStale(60_000);
    assert.equal(calls, 1);
    assert.equal(first.find((r) => r.id === "cloudrun")?.status, "up");
    await service.refreshIfStale(60_000);
    assert.equal(calls, 1, "fresh data is served without re-probing");
    await service.refreshIfStale(0);
    assert.equal(calls, 2, "stale data triggers a poll");
  });

  test("a store failure mid-poll serves the stored rows instead of failing the read, and retries next time", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const service = buildService(store, new SseHub(), { sandboxCapacity: async () => { calls++; return { active: 1 }; } });
    await service.pollOnce();
    const upsert = store.providers.upsert.bind(store.providers);
    store.providers.upsert = async () => { throw new Error("atlas failover"); };
    const logged = console.error;
    console.error = () => {};
    try {
      const rows = await service.refreshIfStale(0);
      assert.equal(rows.find((r) => r.id === "cloudrun")?.status, "up", "last stored rows are served");
    } finally {
      console.error = logged;
      store.providers.upsert = upsert;
    }
    await service.refreshIfStale(0);
    assert.equal(calls, 3, "the failed poll did not count as fresh");
  });

  test("concurrent reads share one in-flight poll", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const service = buildService(new MemoryStore(), new SseHub(), { sandboxCapacity: async () => { calls++; await gate; return { active: 1 }; } });
    const a = service.refreshIfStale(60_000);
    const b = service.refreshIfStale(60_000);
    const c = service.pollOnce();
    release();
    await Promise.all([a, b, c]);
    assert.equal(calls, 1);
  });
});

describe("ProviderStatusService.pollOnce", () => {
  test("persists current rows and publishes on the providers SSE channel only when something transitioned", async () => {
    const store = new MemoryStore();
    const sse = new SseHub();
    const published: SseEvent[] = [];
    (sse as unknown as { publish: SseHub["publish"] }).publish = (_channel, event) => published.push(event);

    const service = buildService(store, sse, { sandboxCapacity: async () => ({ active: 1 }) });

    const first = await service.pollOnce();
    assert.equal(first.find((r) => r.id === "cloudrun")?.status, "up");
    assert.equal(published.length, 1, "new provider rows always count as a transition");

    published.length = 0;
    await service.pollOnce(); // same status (still succeeds) -> no transition
    assert.equal(published.length, 0);

    // A second service instance against the same store, whose counter fails: forces a real
    // up -> down transition and should publish again.
    const throwing = buildService(store, sse, {
      sandboxCapacity: async () => {
        throw new Error("down");
      },
    });
    await throwing.pollOnce();
    assert.equal(published.length, 1);
    const current = await service.getCurrent();
    assert.equal(current.find((r) => r.id === "cloudrun")?.status, "down");
  });

  test("getCurrent never leaks the stored history array", async () => {
    const store = new MemoryStore();
    const sse = new SseHub();
    const service = buildService(store, sse, { sandboxCapacity: async () => ({ active: 1 }) });
    await service.pollOnce();
    const current = await service.getCurrent();
    for (const row of current) assert.equal((row as { history?: unknown }).history, undefined);
  });

  test("history is bounded to the last 7 days of transitions", async () => {
    const store = new MemoryStore();
    const sse = new SseHub();

    let shouldFail = false;
    const service = buildService(store, sse, {
      sandboxCapacity: async () => {
        if (shouldFail) throw new Error("down");
        return { active: 1 };
      },
    });

    await service.pollOnce(); // transition 1: unknown/absent -> up
    shouldFail = true;
    await service.pollOnce(); // transition 2: up -> down

    // Simulate both transitions being over 7 days old by rewriting the stored record directly.
    const stale = await store.providers.findById("cloudrun");
    assert.ok(stale);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await store.providers.upsert({ ...stale, history: stale.history.map((h) => ({ ...h, at: eightDaysAgo })) });

    shouldFail = false;
    await service.pollOnce(); // transition 3: down -> up, recent

    const record = await store.providers.findById("cloudrun");
    assert.ok(record);
    assert.equal(record.history.length, 1, "the two stale (8-day-old) transitions were pruned");
    assert.equal(record.status, "up");
  });
});

// ---------- routes ----------

describe("provider status routes", () => {
  test("GET /api/providers polls on the first read, with no background poller having run", async () => {
    const app = await buildTestApp();

    const res = await app.fastify.inject({ method: "GET", url: "/api/providers" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.providers));
    const ids = body.providers.map((p: { id: string }) => p.id);
    assert.ok(ids.includes("ngrok"));
    assert.ok(ids.includes("laptop"));
    assert.ok(ids.includes("litellm"));
    assert.ok(ids.includes("cloudrun"));

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("POST /api/providers/refresh forces a poll and returns the resulting rows", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "POST", url: "/api/providers/refresh" });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json().providers));

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  // Security review #3 (docs/reports/security-review-pr15.md): no rate limit meant any
  // IAP-authenticated caller could hammer this route into repeated outbound probes (ngrok,
  // laptop, LiteLLM, Cloud Run Admin API). A second call within the cooldown window is rejected.
  test("POST /api/providers/refresh returns 429 on a second call within the cooldown window", async () => {
    const app = await buildTestApp();
    const first = await app.fastify.inject({ method: "POST", url: "/api/providers/refresh" });
    assert.equal(first.statusCode, 200);

    const second = await app.fastify.inject({ method: "POST", url: "/api/providers/refresh" });
    assert.equal(second.statusCode, 429);
    assert.ok(second.json().error);

    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("the ngrok webhook's laptop transition is visible through GET /api/providers", async () => {
    // TUNNEL_DOMAIN_LMSTUDIO intentionally left unset: noteLaptopTransition (called from the
    // webhook) sets the "laptop" row directly from the event, without probing the tunnel itself,
    // so this doesn't need a real (or faked) tunnel domain configured.
    const app = await buildTestApp({ NGROK_WEBHOOK_SECRET: "s" });
    // First read polls (nothing fresh yet); the webhook then updates the row, and the next read,
    // still within PROVIDER_POLL_MS, serves the stored row instead of re-probing.
    await app.fastify.inject({ method: "GET", url: "/api/providers" });
    const { createHmac } = await import("node:crypto");
    const body = JSON.stringify({ event_type_id: "agent_session_start.v0" });
    const signature = createHmac("sha256", "s").update(body, "utf8").digest("hex");

    const hookRes = await app.fastify.inject({
      method: "POST",
      url: "/api/hooks/ngrok",
      headers: { "content-type": "application/json", "ngrok-signature": signature },
      payload: body,
    });
    assert.equal(hookRes.statusCode, 204);

    const res = await app.fastify.inject({ method: "GET", url: "/api/providers" });
    const laptop = res.json().providers.find((p: { id: string }) => p.id === "laptop");
    assert.equal(laptop.status, "up");

    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});
