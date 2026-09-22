// E3.7: ModelsService (fetch/cache/merge) and GET /api/models.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ModelsService, isAutoRouterGroupName, rowsFromModelInfoMeta, mergeLocalModels, type ModelRow } from "../src/models.ts";
import { buildTestApp } from "./helpers.ts";

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("isAutoRouterGroupName", () => {
  test("matches the known auto-router group naming (E2.11b)", () => {
    assert.equal(isAutoRouterGroupName("claude-auto-llm"), true);
    assert.equal(isAutoRouterGroupName("gemini-auto-llm"), true);
    assert.equal(isAutoRouterGroupName("foo-agentic"), true);
    assert.equal(isAutoRouterGroupName("foo-affinity"), true);
    assert.equal(isAutoRouterGroupName("gpt-5-mini"), false);
  });
});

describe("rowsFromModelInfoMeta", () => {
  test("marks a zero-priced auto-router group as auto, a zero-priced non-matching name as not", () => {
    const meta = new Map([
      ["claude-auto-llm", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000 }],
      ["some-free-model", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      ["gpt-5-mini", { cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16000 }],
    ]);
    const rows = rowsFromModelInfoMeta(meta as any);
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get("litellm/claude-auto-llm")?.auto, true);
    assert.equal(byId.get("litellm/some-free-model")?.auto, false);
    const paid = byId.get("litellm/gpt-5-mini")!;
    assert.equal(paid.auto, false);
    assert.equal(paid.contextWindow, 128000);
    assert.equal(paid.maxOutput, 16000);
    assert.equal(paid.inputPerM, 1);
    assert.equal(paid.outputPerM, 5);
  });

  test("a priced model matching the auto-router naming is not marked auto", () => {
    const meta = new Map([["claude-auto-llm", { cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }]]);
    const rows = rowsFromModelInfoMeta(meta as any);
    assert.equal(rows[0].auto, false);
  });
});

describe("mergeLocalModels", () => {
  test("marks an existing row local, and adds a bare row for one LiteLLM doesn't know about", () => {
    const rows: ModelRow[] = [{ id: "litellm/local-qwen-mlx", auto: false, contextWindow: 32768 }];
    const merged = mergeLocalModels(rows, ["litellm/local-qwen-mlx", "litellm/other-local"]);
    const byId = new Map(merged.map((r) => [r.id, r]));
    assert.equal(byId.get("litellm/local-qwen-mlx")?.local, true);
    assert.equal(byId.get("litellm/local-qwen-mlx")?.contextWindow, 32768); // untouched otherwise
    assert.deepEqual(byId.get("litellm/other-local"), { id: "litellm/other-local", auto: false, local: true });
  });
});

describe("ModelsService", () => {
  test("fetches, parses and merges local models", async () => {
    let calls = 0;
    const fetchImpl = fakeFetch((url) => {
      calls++;
      assert.match(url, /\/model\/info$/);
      return jsonResponse({
        data: [{ model_name: "gpt-5-mini", model_info: { mode: "chat", input_cost_per_token: 0.000001, output_cost_per_token: 0.000005 } }],
      });
    });
    const service = new ModelsService({
      litellmBaseUrl: "https://litellm.example/v1",
      litellmKey: async () => "test-key",
      localModels: ["litellm/local-qwen-mlx"],
      fetchImpl,
    });
    const rows = await service.list();
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get("litellm/gpt-5-mini")?.inputPerM, 1);
    assert.equal(byId.get("litellm/local-qwen-mlx")?.local, true);
    assert.equal(calls, 1);
  });

  test("caches for cacheMs; a second call within the window makes no new fetch", async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(() => {
      calls++;
      return jsonResponse({ data: [] });
    });
    const service = new ModelsService({
      litellmBaseUrl: "https://litellm.example/v1",
      litellmKey: async () => "test-key",
      localModels: [],
      fetchImpl,
      cacheMs: 60_000,
    });
    await service.list();
    await service.list();
    assert.equal(calls, 1);
  });

  test("no key configured resolves to an empty LiteLLM list, not a throw", async () => {
    const service = new ModelsService({
      litellmBaseUrl: "https://litellm.example/v1",
      litellmKey: async () => "",
      localModels: ["litellm/local-qwen-mlx"],
      fetchImpl: fakeFetch(() => {
        throw new Error("should not be called");
      }),
    });
    const rows = await service.list();
    assert.deepEqual(rows, [{ id: "litellm/local-qwen-mlx", auto: false, local: true }]);
  });

  test("a network failure resolves to an empty LiteLLM list, not a throw", async () => {
    const service = new ModelsService({
      litellmBaseUrl: "https://litellm.example/v1",
      litellmKey: async () => "test-key",
      localModels: [],
      fetchImpl: fakeFetch(() => {
        throw new Error("network down");
      }),
    });
    assert.deepEqual(await service.list(), []);
  });
});

describe("GET /api/models", () => {
  test("returns the models array from the service", async () => {
    const app = await buildTestApp();
    const res = await app.fastify.inject({ method: "GET", url: "/api/models" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.models));
    await app.fastify.close();
  });
});
