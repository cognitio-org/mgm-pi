// E2.8 laptop model preflight: LaptopProbe (network probing, caching, the setOnline push path) and
// resolveRunModel (the pure fallback-substitution decision it feeds). See src/laptop.ts.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LaptopProbe, resolveRunModel } from "../src/laptop.ts";

function fakeFetch(handler: (init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => handler(init)) as unknown as typeof fetch;
}

describe("LaptopProbe.isOnline", () => {
  test("online: a 2xx response from the tunnel means online", async () => {
    const probe = new LaptopProbe({
      tunnelDomain: "x.ngrok.app",
      token: "tok",
      fetchImpl: fakeFetch(() => new Response("[]", { status: 200 })),
    });
    assert.equal(await probe.isOnline(), true);
  });

  test("offline: a non-2xx response (ngrok's own offline error page) means offline", async () => {
    const probe = new LaptopProbe({
      tunnelDomain: "x.ngrok.app",
      token: "tok",
      fetchImpl: fakeFetch(() => new Response("tunnel not found", { status: 502 })),
    });
    assert.equal(await probe.isOnline(), false);
  });

  test("timeout: an unresponsive tunnel resolves offline once the 3s (here: 20ms) timeout aborts it", async () => {
    const probe = new LaptopProbe({
      tunnelDomain: "x.ngrok.app",
      token: "tok",
      timeoutMs: 20,
      fetchImpl: fakeFetch(
        (init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    });
    const startedAt = Date.now();
    assert.equal(await probe.isOnline(), false);
    assert.ok(Date.now() - startedAt < 1000, "should resolve promptly once the timeout aborts the fetch");
  });

  test("cache: a second call within cacheMs reuses the cached result instead of probing again", async () => {
    let calls = 0;
    const probe = new LaptopProbe({
      tunnelDomain: "x.ngrok.app",
      token: "tok",
      cacheMs: 60_000,
      fetchImpl: fakeFetch(() => {
        calls++;
        return new Response("[]", { status: 200 });
      }),
    });
    assert.equal(await probe.isOnline(), true);
    assert.equal(await probe.isOnline(), true);
    assert.equal(calls, 1);
  });

  test("setOnline overrides the cached value immediately, without probing", async () => {
    let calls = 0;
    const probe = new LaptopProbe({
      tunnelDomain: "x.ngrok.app",
      token: "tok",
      fetchImpl: fakeFetch(() => {
        calls++;
        return new Response("[]", { status: 200 });
      }),
    });
    probe.setOnline(false);
    assert.equal(await probe.isOnline(), false);
    assert.equal(calls, 0, "setOnline should short-circuit the probe for the rest of the cache window");
  });
});

describe("resolveRunModel (E2.8 fallback substitution)", () => {
  const localModels = ["litellm/local-qwen-mlx"];
  const defaultCloudModel = "litellm/claude-auto-llm";

  test("a non-local model passes through unchanged regardless of laptop state", () => {
    assert.deepEqual(
      resolveRunModel({ wanted: "litellm/gpt-5-mini", localModels, defaultCloudModel, laptopOnline: false }),
      { model: "litellm/gpt-5-mini" },
    );
  });

  test("a local model passes through unchanged when the laptop is online", () => {
    assert.deepEqual(
      resolveRunModel({ wanted: "litellm/local-qwen-mlx", localModels, defaultCloudModel, laptopOnline: true }),
      { model: "litellm/local-qwen-mlx" },
    );
  });

  test("a local model is substituted with the guru's fallbackModel when the laptop is offline", () => {
    assert.deepEqual(
      resolveRunModel({
        wanted: "litellm/local-qwen-mlx",
        guruFallbackModel: "litellm/gpt-5-mini",
        localModels,
        defaultCloudModel,
        laptopOnline: false,
      }),
      { model: "litellm/gpt-5-mini", fallback: { wanted: "litellm/local-qwen-mlx", used: "litellm/gpt-5-mini" } },
    );
  });

  test("falls back to defaultCloudModel when the guru has no fallbackModel of its own", () => {
    assert.deepEqual(
      resolveRunModel({ wanted: "litellm/local-qwen-mlx", localModels, defaultCloudModel, laptopOnline: false }),
      { model: defaultCloudModel, fallback: { wanted: "litellm/local-qwen-mlx", used: defaultCloudModel } },
    );
  });
});
