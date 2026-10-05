// #458: GET /api/config/models, the options behind the Account page's model dropdowns: the
// router's models (LiteLLM mocked, never called for real) and the curated OpenRouter list with
// the fleet's, the account's and a profile's adds and removes.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { curatedOpenRouter, DEFAULT_OPENROUTER_MODELS, modelOptions, parseIdList } from "../src/central/model-options.ts";
import type { ResolvedValue } from "../src/central/settings-schema.ts";
import { buildTestApp, type TestApp } from "./helpers.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A mocked LiteLLM: /model/info answers two chat models and an embedding model; anything else 404. */
function mockLitellm(): { calls: Array<{ url: string; auth?: string }> } {
  const calls: Array<{ url: string; auth?: string }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url, auth });
    if (url === "https://router.test/model/info") {
      return jsonResponse({
        data: [
          { model_name: "gpt-5.4-nano", model_info: { mode: "chat", input_cost_per_token: 0.0000001, output_cost_per_token: 0.0000004 } },
          { model_name: "claude-auto-llm", model_info: { mode: "chat", input_cost_per_token: 0, output_cost_per_token: 0 } },
          { model_name: "text-embed", model_info: { mode: "embedding" } },
        ],
      });
    }
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;
  return { calls };
}

const v = (value: string, source: ResolvedValue["source"] = "user"): ResolvedValue => ({ value, source, override: "any", locked: false, localAllowed: true });

async function close(app: TestApp): Promise<void> {
  app.stopBackgroundTasks();
  await app.fastify.close();
}

describe("curatedOpenRouter", () => {
  test("applies each level's removes then adds, nearer levels winning, the fleet's removals last", () => {
    const list = curatedOpenRouter(
      {
        "openrouter.models.fleetAdd": v("x-ai/grok-5, mistral/large", "fleet"),
        "openrouter.models.fleetRemove": v("z-ai/glm-5.1, mistral/large", "fleet"),
        "openrouter.models.remove": v("openai/gpt-5.5, x-ai/grok-5"),
        "openrouter.models.profileAdd": v("openai/gpt-5.5, z-ai/glm-5.1", "profile"),
      },
      ["openai/gpt-5.5", "z-ai/glm-5.1", "qwen/qwen3.6-35b-a3b"],
    );
    // The profile adds back what the account removed; the fleet's removal wins over the profile.
    assert.deepEqual(list, ["qwen/qwen3.6-35b-a3b", "openai/gpt-5.5"]);
  });

  test("the base list is Kernal's DEFAULT_OPENROUTER_MODELS", (t) => {
    const lib = new URL("../../../../kernal/.pi/extensions/connect/lib.ts", import.meta.url);
    if (!existsSync(lib)) return t.skip("no Kernal checkout beside this package");
    const m = /DEFAULT_OPENROUTER_MODELS = \[([^\]]*)\]/.exec(readFileSync(lib, "utf8"));
    assert.ok(m, "DEFAULT_OPENROUTER_MODELS not found in connect/lib.ts");
    const kernal = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual([...DEFAULT_OPENROUTER_MODELS], kernal);
  });

  test("nothing set is Kernal's base list", () => {
    assert.deepEqual(curatedOpenRouter({}), [...DEFAULT_OPENROUTER_MODELS]);
    assert.deepEqual(parseIdList(" a/b, ,a/b,c "), ["a/b", "c"]);
  });

  test("modelOptions strips the router prefix, sorts, and notes an empty router list", () => {
    const opts = modelOptions([{ id: "litellm/b", auto: false }, { id: "litellm/a", auto: false }], {});
    assert.deepEqual(opts.providers.find((p) => p.id === "litellm")?.models, ["a", "b"]);
    assert.equal(opts.providers.find((p) => p.id === "litellm")?.note, undefined);
    assert.match(modelOptions([], {}).providers[0].note ?? "", /couldn't be read/);
    assert.match(modelOptions([{ id: "litellm/local-qwen-mlx", auto: false, local: true }], {}, { routerAnswered: false }).providers[0].note ?? "", /couldn't be read/);
    // Every router model also in LOCAL_MODELS is still the router answering.
    assert.equal(modelOptions([{ id: "litellm/local-qwen-mlx", auto: false, local: true }], {}, { routerAnswered: true }).providers[0].note, undefined);
    assert.deepEqual(opts.providers.find((p) => p.id === "lmstudio")?.models, []);
  });
});

describe("GET /api/config/models", () => {
  test("lists the router's chat models (mocked LiteLLM, admin key) and the person's curated OpenRouter list", async () => {
    const { calls } = mockLitellm();
    const app = await buildTestApp({ LITELLM_BASE_URL: "https://router.test/v1", LITELLM_ADMIN_KEY: "sk-admin-test" });
    try {
      const f = app.fastify;
      // The account adds a model and removes one; a profile adds another.
      const put = await f.inject({ method: "PUT", url: "/api/config/user", headers: { "if-match": 'W/"0"' }, payload: { values: { "openrouter.models.add": "x-ai/grok-5", "openrouter.models.remove": "z-ai/glm-5.1" } } });
      assert.equal(put.statusCode, 200);
      await f.inject({ method: "POST", url: "/api/config/profiles", payload: { name: "work" } });
      await f.inject({ method: "PUT", url: "/api/config/profiles/work", headers: { "if-match": 'W/"1"' }, payload: { values: { "openrouter.models.profileAdd": "mistral/large" } } });

      const res = await f.inject({ method: "GET", url: "/api/config/models" });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["cache-control"], "no-store");
      const body = res.json() as { providers: Array<{ id: string; label: string; models: string[]; note?: string }> };
      const by = Object.fromEntries(body.providers.map((p) => [p.id, p]));
      // LOCAL_MODELS (the laptop tunnel's, default local-qwen-mlx) are router names too.
      assert.deepEqual(by.litellm.models, ["claude-auto-llm", "gpt-5.4-nano", "local-qwen-mlx"]);
      assert.equal(by.litellm.note, undefined);
      assert.ok(by.openrouter.models.includes("x-ai/grok-5"));
      assert.ok(!by.openrouter.models.includes("z-ai/glm-5.1"));
      assert.ok(!by.openrouter.models.includes("mistral/large"), "no profile named: the profile's adds don't apply");
      assert.deepEqual(by.lmstudio.models, []);
      const info = calls.filter((c) => c.url.endsWith("/model/info"));
      assert.equal(info.length, 1);
      assert.equal(info[0].auth, "Bearer sk-admin-test");

      const work = (await f.inject({ method: "GET", url: "/api/config/models?profile=work" })).json() as typeof body;
      assert.ok(work.providers.find((p) => p.id === "openrouter")!.models.includes("mistral/large"));
      // The router list is cached: the second answer made no new /model/info call.
      assert.equal(calls.filter((c) => c.url.endsWith("/model/info")).length, 1);

      // The account-wide editor (scope=account) leaves the default profile's adds out.
      const patch = await f.inject({ method: "PATCH", url: "/api/config/profiles/work", headers: { "if-match": 'W/"2"' }, payload: { isDefault: true } });
      assert.equal(patch.statusCode, 200);
      const viaDefault = (await f.inject({ method: "GET", url: "/api/config/models" })).json() as typeof body;
      assert.ok(viaDefault.providers.find((p) => p.id === "openrouter")!.models.includes("mistral/large"), "no scope: the default profile applies");
      const account = (await f.inject({ method: "GET", url: "/api/config/models?scope=account" })).json() as typeof body;
      assert.ok(!account.providers.find((p) => p.id === "openrouter")!.models.includes("mistral/large"));
      assert.ok(account.providers.find((p) => p.id === "openrouter")!.models.includes("x-ai/grok-5"));

      const unknown = await f.inject({ method: "GET", url: "/api/config/models?profile=nope" });
      assert.equal(unknown.statusCode, 404);
      assert.equal(unknown.json().error, "unknown_profile");
    } finally {
      await close(app);
    }
  });

  test("the router unreachable still answers, with an empty router list and a note", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const app = await buildTestApp({ LITELLM_BASE_URL: "https://router.test/v1", LITELLM_ADMIN_KEY: "sk-admin-test" });
    try {
      const res = await app.fastify.inject({ method: "GET", url: "/api/config/models" });
      assert.equal(res.statusCode, 200);
      const router = res.json().providers.find((p: { id: string }) => p.id === "litellm");
      assert.ok(!router.models.includes("gpt-5.4-nano"));
      assert.match(router.note, /couldn't be read/);
    } finally {
      await close(app);
    }
  });

  test("needs a signed-in caller", async () => {
    const { calls } = mockLitellm();
    const app = await buildTestApp({ OUTFITTER_ROLE: "web", OUTFITTER_DEV: "0", LITELLM_BASE_URL: "https://router.test/v1", LITELLM_ADMIN_KEY: "sk-admin-test" });
    try {
      const res = await app.fastify.inject({ method: "GET", url: "/api/config/models" });
      assert.equal(res.statusCode, 401);
      assert.equal(calls.filter((c) => c.url.endsWith("/model/info")).length, 0);
    } finally {
      await close(app);
    }
  });
});
