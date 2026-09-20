import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseEnvText, parseModelInfo, parseLmStudioModels, backends, normalizeBaseUrl, rootUrl, parseSpendHeaders, sessionEstimate,
  money, pctText, price, fit, bar, budgetRows, renderPanel, footerStatus, plainLen, QWEN_THINKING_MAP, DEFAULT_OPENROUTER_MODELS,
} from "../.pi/extensions/connect/lib.ts";

const id = (_c: string, t: string) => t;   // identity painter

describe("env parsing", () => {
  test("handles export, quotes, comments and blanks", () => {
    const env = parseEnvText(`# comment\nexport A=1\nB="two words"\nC='x'\n\nD = spaced \nlower=ignored\n`);
    assert.deepEqual(env, { A: "1", B: "two words", C: "x", D: "spaced" });
  });
});

describe("backends", () => {
  test("agent key wins over general key for litellm; empty key when neither set", () => {
    const meta = new Map();
    const both = backends({ LITELLM_AGENT_KEY: "agent", LITELLM_API_KEY: "general" }, meta).find((b) => b.id === "litellm")!;
    assert.equal(both.apiKey, "agent");
    const fallback = backends({ LITELLM_API_KEY: "general" }, meta).find((b) => b.id === "litellm")!;
    assert.equal(fallback.apiKey, "general");
    const none = backends({}, meta).find((b) => b.id === "openrouter")!;
    assert.equal(none.apiKey, "");
    assert.equal(none.keyVar, "OPENROUTER_API_KEY");
  });

  test("qwen routes map thinking off to reasoning_effort none; cloud routes omit it", () => {
    const meta = new Map();
    const [lm, ll] = backends({}, meta);
    assert.equal(lm.model("qwen/qwen3.6-35b-a3b").thinkingLevelMap?.off, "none");
    assert.equal(ll.model("local-qwen-mlx").thinkingLevelMap?.off, "none");
    assert.equal(ll.model("claude-sonnet-5").thinkingLevelMap?.off, undefined);
    assert.deepEqual(lm.model("x").thinkingLevelMap, QWEN_THINKING_MAP);
  });

  test("proxied providers disable the OpenAI store flag and keep pi's strict finish_reason check", () => {
    // supportsFinishReason stays on: under pi 0.85.1's binary, turning it off made a dropped LM Studio
    // stream return an instant empty reply instead of an error. pi 0.86.1 fixed the stream itself.
    for (const b of backends({}, new Map())) { assert.equal(b.model("m").compat?.supportsStore, false, b.id); assert.equal(b.model("m").compat?.supportsFinishReason, undefined, b.id); }
  });

  test("litellm models use router metadata when present, defaults otherwise, and cap max tokens", () => {
    const meta = new Map([["claude-sonnet-5", { cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, contextWindow: 1_000_000, maxTokens: 128_000, vision: true, reasoning: true }]]);
    const ll = backends({}, meta).find((b) => b.id === "litellm")!;
    const m = ll.model("claude-sonnet-5");
    assert.equal(m.contextWindow, 1_000_000);
    assert.equal(m.maxTokens, 64_000, "capped");
    assert.equal(m.cost.input, 2);
    const unknown = ll.model("claude-haiku-4-5");
    assert.equal(unknown.contextWindow, 200_000);
    assert.equal(unknown.cost.input, 3);
    const local = ll.model("local-qwen-mlx");
    assert.equal(local.cost.output, 0, "local route is free even if router had a price");
  });

  test("lmstudio discovery filter drops embedding models", () => {
    const lm = backends({}, new Map())[0];
    assert.ok(lm.filter!("qwen/qwen3.6-35b-a3b"));
    assert.ok(!lm.filter!("text-embedding-nomic-embed-text-v1.5"));
  });

  test("OPENROUTER_MODELS overrides the curated list", () => {
    const or = backends({ OPENROUTER_MODELS: " a/b, c/d ,, " }, new Map()).find((b) => b.id === "openrouter")!;
    assert.deepEqual(or.fallback, ["a/b", "c/d"]);
    assert.deepEqual(backends({}, new Map()).find((b) => b.id === "openrouter")!.fallback, DEFAULT_OPENROUTER_MODELS);
  });

  test("normalizeBaseUrl repairs what people type", () => {
    const d = "http://localhost:1234/v1";
    assert.equal(normalizeBaseUrl("http://127.0.0.1:1234", d), "http://127.0.0.1:1234/v1", "the bug: missing /v1");
    assert.equal(normalizeBaseUrl("localhost:1234", d), "http://localhost:1234/v1");
    assert.equal(normalizeBaseUrl("http://localhost:1234/v1/", d), "http://localhost:1234/v1");
    assert.equal(normalizeBaseUrl("litellm.example.com", d), "https://litellm.example.com/v1");
    assert.equal(normalizeBaseUrl("https://openrouter.ai/api/v1", d), "https://openrouter.ai/api/v1");
    assert.equal(normalizeBaseUrl("", d), d);
    assert.equal(backends({ LMSTUDIO_BASE_URL: "127.0.0.1:1234" }, new Map())[0].baseUrl, "http://127.0.0.1:1234/v1", "env values are normalised too");
  });

  test("rootUrl strips a trailing /v1", () => {
    assert.equal(rootUrl("https://x/v1"), "https://x");
    assert.equal(rootUrl("https://x/v1/"), "https://x");
    assert.equal(rootUrl("https://x"), "https://x");
  });
});

describe("LM Studio /api/v0/models parsing", () => {
  const sample = { data: [
    { id: "qwen/qwen3.6-35b-a3b", type: "vlm", state: "loaded", max_context_length: 262144, loaded_context_length: 183296, capabilities: ["tool_use"] },
    { id: "nvidia/nemotron-3-nano-omni", type: "vlm", state: "not-loaded", max_context_length: 262144, capabilities: [] },
    { id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", state: "loaded", max_context_length: 2048 },
  ] };
  test("loaded models report the served window, unloaded ones their ceiling, embeddings are skipped", () => {
    const m = parseLmStudioModels(sample);
    assert.deepEqual([...m.keys()], ["qwen/qwen3.6-35b-a3b", "nvidia/nemotron-3-nano-omni"]);
    assert.deepEqual(m.get("qwen/qwen3.6-35b-a3b"), { contextWindow: 183296, loaded: true, vision: true, toolUse: true });
    assert.deepEqual(m.get("nvidia/nemotron-3-nano-omni"), { contextWindow: 262144, loaded: false, vision: true, toolUse: false });
  });
  test("provider uses the served window, capped by LMSTUDIO_CONTEXT, with a 32k fallback", () => {
    const meta = parseLmStudioModels(sample);
    const lm = (env: Record<string, string>) => backends(env, new Map(), meta)[0];
    assert.equal(lm({}).model("qwen/qwen3.6-35b-a3b").contextWindow, 183296);
    assert.equal(lm({ LMSTUDIO_CONTEXT: "131072" }).model("qwen/qwen3.6-35b-a3b").contextWindow, 131072);
    assert.equal(lm({ LMSTUDIO_CONTEXT: "131072" }).model("unknown-model").contextWindow, 32768);
    assert.equal(parseLmStudioModels(undefined).size, 0);
  });
});

describe("LiteLLM /model/info parsing", () => {
  const sample = { data: [
    { model_name: "claude-haiku-4-5", model_info: { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, cache_read_input_token_cost: 1e-7, max_input_tokens: 200000, max_output_tokens: 64000, mode: "chat", supports_vision: true, supports_reasoning: true } },
    { model_name: "text-embedding-3-small", model_info: { mode: "embedding", input_cost_per_token: 2e-8 } },
    { model_name: "local-qwen-mlx", model_info: { mode: "chat" } },
    { model_name: "claude-haiku-4-5", model_info: { mode: "chat", input_cost_per_token: 1e-6 } },
  ] };
  test("prices become per-million, non-chat modes are dropped, ids deduped and sorted", () => {
    const { ids, meta } = parseModelInfo(sample);
    assert.deepEqual(ids, ["claude-haiku-4-5", "local-qwen-mlx"]);
    const h = meta.get("claude-haiku-4-5")!;
    assert.equal(h.cost.output, 5);
    assert.ok(Math.abs(h.cost.cacheRead - 0.1) < 1e-9);
    assert.equal(h.contextWindow, 200000);
    assert.equal(meta.get("local-qwen-mlx")!.cost.input, 0);
    assert.equal(meta.get("local-qwen-mlx")!.contextWindow, undefined);
  });
  test("tolerates empty or malformed payloads", () => {
    assert.deepEqual(parseModelInfo(undefined).ids, []);
    assert.deepEqual(parseModelInfo({ data: [{ model_info: {} }] }).ids, []);
  });
});

describe("spend headers", () => {
  test("ignores non-LiteLLM responses", () => {
    assert.deepEqual(parseSpendHeaders({ "content-type": "text/event-stream" }), { litellm: false });
    assert.deepEqual(parseSpendHeaders(undefined), { litellm: false });
  });
  test("reads key spend, cap and model group case-insensitively", () => {
    const h = parseSpendHeaders({ "X-LiteLLM-Call-Id": "abc", "x-litellm-key-spend": "0.7594545", "X-Litellm-Key-Max-Budget": "1000", "x-litellm-model-group": "claude-haiku-4-5", "x-litellm-response-cost": "0" });
    assert.equal(h.litellm, true);
    assert.equal(h.keySpend, 0.7594545);
    assert.equal(h.keyMax, 1000);
    assert.equal(h.modelGroup, "claude-haiku-4-5");
  });
  test("missing or garbage numbers become undefined", () => {
    const h = parseSpendHeaders({ "x-litellm-call-id": "x", "x-litellm-key-spend": "nope" });
    assert.equal(h.keySpend, undefined);
    assert.equal(h.keyMax, undefined);
  });
});

describe("session estimate", () => {
  test("sums only assistant messages from the litellm provider", () => {
    const entries = [
      { type: "message", message: { role: "assistant", provider: "litellm", usage: { cost: { total: 0.01 } } } },
      { type: "message", message: { role: "assistant", provider: "lmstudio", usage: { cost: { total: 5 } } } },
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant", provider: "litellm" } },
      { type: "thinking_level_change" },
      { type: "message", message: { role: "assistant", provider: "litellm", usage: { cost: { total: 0.02 } } } },
    ];
    assert.ok(Math.abs(sessionEstimate(entries) - 0.03) < 1e-12);
    assert.equal(sessionEstimate([]), 0);
  });
});

describe("formatting", () => {
  test("money, pct, price, fit", () => {
    assert.equal(money(undefined), "—");
    assert.equal(money(0.0031), "$0.0031");
    assert.equal(money(12.345), "$12.35");
    assert.equal(pctText(0), "0%");
    assert.equal(pctText(0.0008), "0.1%");
    assert.equal(pctText(0.5), "50%");
    assert.equal(price(0.09999999999999999), "$0.1");
    assert.equal(price(2), "$2");
    assert.equal(fit("MGM-Pi").length, 20);
    assert.equal(fit("Customer Engineering"), "Customer Engineer…  ");
  });
  test("bar colours and minimum fill", () => {
    assert.equal(bar(0, 100).segs[0][0], "");
    assert.equal(bar(0.5, 1000).segs[0][0], "▰", "tiny usage still shows one cell");
    assert.equal(bar(10, 100).color, "success");
    assert.equal(bar(60, 100).color, "warning");
    assert.equal(bar(95, 100).color, "error");
    assert.equal(bar(500, 100).pct, 1, "clamped");
    assert.equal(bar(0, 0).pct, 0, "no cap");
    for (const b of [bar(0, 1), bar(37, 100), bar(1, 1)]) assert.equal(plainLen(b.segs), 14);
  });
});

describe("budget panel", () => {
  const data = { estimate: 0.076, actual: 0, calls: 2, key: { key_alias: "MGM-Pi", spend: 0.84, max_budget: 1000 }, team: { team_alias: "Customer Engineering", spend: 3.64, max_budget: 500, budget_duration: "24h" }, model: { provider: "litellm", id: "claude-haiku-4-5" }, meta: { cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } } };
  test("rows cover session, key, team and model", () => {
    const text = budgetRows(data).map((r) => r.map(([t]) => t).join(""));
    assert.equal(text.length, 4);
    assert.match(text[0], /session \$0\.08 est {2}· {2}billed \+\$0\.0000 {2}· {2}2 calls/);
    assert.match(text[1], /^key {2}MGM-Pi {12} {2}▰▱{13} {2}\$0\.84 \/ \$1000\.00 {2}0\.1%$/);
    assert.match(text[2], /^team Customer Engineer… {2}▰▱{13} {2}\$3\.64 \/ \$500\.00 {2}resets 24h$/);
    assert.match(text[3], /^model litellm\/claude-haiku-4-5 {3}\$1\/M in · \$5\/M out · \$0\.1\/M cached$/);
  });
  test("falls back to header-derived key numbers and explains missing info", () => {
    const rows = budgetRows({ estimate: 0, calls: 0, keySpend: 2, keyMax: 10 });
    const text = rows.map((r) => r.map(([t]) => t).join(""));
    assert.match(text[1], /^key {2}agent/);
    assert.match(text.at(-1)!, /info_routes/);
    const noCap = budgetRows({ estimate: 0, calls: 1, key: { key_alias: "k", spend: 1 } }).map((r) => r.map(([t]) => t).join(""));
    assert.match(noCap[1], /no cap/);
  });
  test("panel lines are boxed, equal width and never wider than the terminal", () => {
    for (const width of [30, 60, 100, 200]) {
      const lines = renderPanel(budgetRows(data), width, id);
      assert.equal(lines.length, 6);
      assert.ok(lines[0].startsWith("╭─ LiteLLM budget "));
      assert.ok(lines.at(-1)!.startsWith("╰"));
      const inner = Math.max(24, Math.min(width - 2, 96));
      assert.equal([...lines[0]].length, inner + 1, `top width at ${width}`);
      assert.equal([...lines.at(-1)!].length, inner + 1, `bottom width at ${width}`);
      for (const l of lines.slice(1, -1)) assert.ok([...l].length >= inner + 1, "row padded to box width");
      if (width >= 100) for (const l of lines) assert.ok([...l].length <= width);
    }
  });
  test("painter is applied to coloured segments only", () => {
    const paint = (c: string, t: string) => `<${c}>${t}</${c}>`;
    const [top] = renderPanel([], 80, paint);
    assert.ok(top.includes("<accent> LiteLLM budget </accent>"));
  });
  test("footer status", () => {
    assert.equal(footerStatus(0, undefined, undefined), "◆ $0.0000");
    assert.equal(footerStatus(0.076, 0.84, 1000), "◆ $0.08 · key $0.84/$1000.00 (0.1%)");
    assert.equal(footerStatus(0.076, 0.84, null), "◆ $0.08 · key $0.84");
  });
});
