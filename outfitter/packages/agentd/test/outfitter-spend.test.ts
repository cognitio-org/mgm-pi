import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import outfitterSpend, {
  parseSpendHeaders,
  sessionCostTotal,
  buildSpendLogLine,
  newestAssistantUsage,
  parseModelInfoPrices,
  isZeroPrice,
  computeResolvedCost,
} from "../pi-extension/outfitter-spend.js";

test("parseSpendHeaders: not LiteLLM when x-litellm-call-id is absent", () => {
  assert.deepEqual(parseSpendHeaders({ "content-type": "application/json" }), { litellm: false });
  assert.deepEqual(parseSpendHeaders(undefined), { litellm: false });
});

test("parseSpendHeaders: parses key spend, max budget, model group and call id case-insensitively", () => {
  const h = parseSpendHeaders({
    "X-LiteLLM-Call-Id": "call-1",
    "x-litellm-key-spend": "1.5",
    "x-litellm-key-max-budget": "10",
    "x-litellm-model-group": "sonnet",
  });
  assert.deepEqual(h, { litellm: true, keySpend: 1.5, keyMax: 10, modelGroup: "sonnet", callId: "call-1", resolvedModel: undefined, classifierCost: undefined });
});

test("parseSpendHeaders: keyMax is undefined when the header is missing (no budget cap set)", () => {
  const h = parseSpendHeaders({ "x-litellm-call-id": "call-2", "x-litellm-key-spend": "3" });
  assert.equal(h.litellm, true);
  assert.equal(h.keySpend, 3);
  assert.equal(h.keyMax, undefined);
});

// ---------- E2.11b: auto-router pricing ----------

test("parseSpendHeaders: parses x-litellm-model-name and x-litellm-classifier-cost", () => {
  const h = parseSpendHeaders({
    "x-litellm-call-id": "call-3",
    "x-litellm-model-group": "claude-auto-llm",
    "x-litellm-model-name": "claude-sonnet-5",
    "x-litellm-classifier-cost": "0.0002",
  });
  assert.equal(h.resolvedModel, "claude-sonnet-5");
  assert.ok(Math.abs(h.classifierCost! - 0.0002) < 1e-12);
});

test("parseModelInfoPrices: builds a per-token price map keyed by model_name, first deployment wins", () => {
  const json = {
    data: [
      { model_name: "claude-auto-llm", model_info: { input_cost_per_token: 0, output_cost_per_token: 0 } },
      { model_name: "claude-sonnet-5", model_info: { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, cache_read_input_token_cost: 0.0000003, cache_creation_input_token_cost: 0.00000375 } },
      { model_name: "claude-sonnet-5", model_info: { input_cost_per_token: 999 } }, // duplicate deployment: ignored
    ],
  };
  const prices = parseModelInfoPrices(json);
  assert.deepEqual(prices.get("claude-auto-llm"), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(prices.get("claude-sonnet-5"), { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 });
});

test("isZeroPrice: true for undefined or an all-zero price, false otherwise", () => {
  assert.equal(isZeroPrice(undefined), true);
  assert.equal(isZeroPrice({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), true);
  assert.equal(isZeroPrice({ input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0 }), false);
});

test("newestAssistantUsage: returns the last litellm assistant message's usage", () => {
  const entries = [
    { type: "message", message: { role: "assistant", provider: "litellm", usage: { input: 1, output: 1 } } },
    { type: "message", message: { role: "assistant", provider: "litellm", usage: { input: 10, output: 20 } } },
    { type: "message", message: { role: "assistant", provider: "anthropic", usage: { input: 99, output: 99 } } },
  ];
  assert.deepEqual(newestAssistantUsage(entries), { input: 10, output: 20 });
});

test("newestAssistantUsage: undefined when there's no litellm assistant message", () => {
  assert.equal(newestAssistantUsage([]), undefined);
});

test("computeResolvedCost: token counts x per-token prices plus classifier cost", () => {
  const usage = { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 };
  const price = { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 };
  const cost = computeResolvedCost(usage, price, 0.0002);
  // 1000*0.000003 + 500*0.000015 + 200*0.0000003 + 0.0002 = 0.003 + 0.0075 + 0.00006 + 0.0002
  assert.ok(Math.abs(cost! - 0.01076) < 1e-9);
});

test("computeResolvedCost: undefined when usage or price is missing", () => {
  assert.equal(computeResolvedCost(undefined, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, undefined), undefined);
  assert.equal(computeResolvedCost({ input: 1 }, undefined, undefined), undefined);
});

test("buildSpendLogLine: group priced -- keeps the existing delta-based usage even if a resolved model is present", () => {
  const headers = { litellm: true, modelGroup: "claude-sonnet-5", resolvedModel: "claude-sonnet-5" };
  const prices = new Map([["claude-sonnet-5", { input: 0.000003, output: 0.000015, cacheRead: 0, cacheWrite: 0 }]]);
  const line = buildSpendLogLine(headers, 0.05, 0.02, prices, { input: 999999, output: 999999 });
  assert.ok(Math.abs(line.usage! - 0.03) < 1e-9); // delta, not the (huge) resolved-model computation
});

test("buildSpendLogLine: auto-router group unpriced, resolved model priced -- usage computed from tokens", () => {
  const headers = {
    litellm: true,
    modelGroup: "claude-auto-llm",
    resolvedModel: "claude-sonnet-5",
    classifierCost: 0.0001,
  };
  const prices = new Map([
    ["claude-auto-llm", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
    ["claude-sonnet-5", { input: 0.000003, output: 0.000015, cacheRead: 0, cacheWrite: 0 }],
  ]);
  // currentTotal === previousTotal: pi's own delta is 0 (it priced the group, not the resolved model).
  const line = buildSpendLogLine(headers, 0.5, 0.5, prices, { input: 1000, output: 500 });
  // 1000*0.000003 + 500*0.000015 + 0.0001 = 0.003 + 0.0075 + 0.0001
  assert.ok(Math.abs(line.usage! - 0.0106) < 1e-9);
});

test("buildSpendLogLine: auto-router group, prices unknown (network fetch failed) -- degrades to delta-based usage", () => {
  const headers = { litellm: true, modelGroup: "claude-auto-llm", resolvedModel: "claude-sonnet-5" };
  const line = buildSpendLogLine(headers, 0.05, 0.02); // no prices map at all -- the default
  assert.ok(Math.abs(line.usage! - 0.03) < 1e-9);
});

test("buildSpendLogLine: auto-router group unpriced but resolved model also unpriced/unknown -- degrades to delta", () => {
  const headers = { litellm: true, modelGroup: "claude-auto-llm", resolvedModel: "gemini-3.8-flash" };
  const prices = new Map([["claude-auto-llm", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]]);
  const line = buildSpendLogLine(headers, 0.05, 0.02, prices, { input: 1000, output: 500 });
  assert.ok(Math.abs(line.usage! - 0.03) < 1e-9);
});

function assistantEntry(cost: number, provider = "litellm"): unknown {
  return { type: "message", message: { role: "assistant", provider, usage: { cost: { total: cost } } } };
}

test("sessionCostTotal: sums litellm assistant-turn usage.cost.total, ignoring other providers/roles", () => {
  const entries = [
    { type: "message", message: { role: "user", provider: "litellm" } },
    assistantEntry(0.01),
    assistantEntry(0.02),
    assistantEntry(0.5, "anthropic"), // different provider: not counted
    { type: "custom" },
  ];
  assert.equal(sessionCostTotal(entries), 0.03);
});

test("sessionCostTotal: empty entries is 0", () => {
  assert.equal(sessionCostTotal([]), 0);
});

test("buildSpendLogLine: usage is the delta since the previous total", () => {
  const headers = { litellm: true, keySpend: 5, keyMax: 20, modelGroup: "sonnet", callId: "call-1" };
  const line = buildSpendLogLine(headers, 0.05, 0.02);
  assert.equal(line.keySpend, 5);
  assert.equal(line.keyMax, 20);
  assert.equal(line.modelGroup, "sonnet");
  assert.equal(line.callId, "call-1");
  assert.ok(Math.abs(line.usage! - 0.03) < 1e-9);
});

test("buildSpendLogLine: usage never goes negative even if the running total decreased", () => {
  const headers = { litellm: true };
  const line = buildSpendLogLine(headers, 0.01, 0.05);
  assert.equal(line.usage, 0);
});

// ---------- extension wiring: resumed-session previousTotal baseline ----------

/** Fake pi extension API: records handlers by event name so a test can fire them directly, the same
 * way the real pi runtime would. */
function fakePi() {
  const handlers = new Map<string, (ev: any, ctx: any) => void>();
  return {
    api: { on: (event: string, handler: any) => handlers.set(event, handler) },
    fire(event: string, ev: any, ctx: any) {
      handlers.get(event)?.(ev, ctx);
    },
  };
}

function litellmHeaders(callId: string): Record<string, string> {
  return { "x-litellm-call-id": callId };
}

test("outfitterSpend: on a resumed session, the first response's usage is only its own delta, not the whole history", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "outfitter-spend-test-"));
  const spendFile = join(dir, "spend.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const previousEnv = process.env.OUTFITTER_SPEND_FILE;
  process.env.OUTFITTER_SPEND_FILE = spendFile;
  t.after(() => {
    if (previousEnv === undefined) delete process.env.OUTFITTER_SPEND_FILE;
    else process.env.OUTFITTER_SPEND_FILE = previousEnv;
  });

  const { api, fire } = fakePi();
  outfitterSpend(api as any);

  // Resumed session: history already has 0.5 of prior cost before this run's first new response.
  const historyEntries = [assistantEntry(0.5)];
  fire("session_start", {}, { sessionManager: { getEntries: () => historyEntries } });

  // First new response of this run: pi's running session total is now history + this response's own
  // 0.02 cost.
  const afterFirstResponse = [...historyEntries, assistantEntry(0.02)];
  fire("after_provider_response", { headers: litellmHeaders("call-1") }, { sessionManager: { getEntries: () => afterFirstResponse } });

  const lines = readFileSync(spendFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.ok(Math.abs(lines[0].usage - 0.02) < 1e-9, `expected ~0.02, got ${lines[0].usage}`);
});

test("outfitterSpend: without a session_start, the first after_provider_response lazily baselines before computing its delta", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "outfitter-spend-test-"));
  const spendFile = join(dir, "spend.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const previousEnv = process.env.OUTFITTER_SPEND_FILE;
  process.env.OUTFITTER_SPEND_FILE = spendFile;
  t.after(() => {
    if (previousEnv === undefined) delete process.env.OUTFITTER_SPEND_FILE;
    else process.env.OUTFITTER_SPEND_FILE = previousEnv;
  });

  const { api, fire } = fakePi();
  outfitterSpend(api as any);

  // No session_start fired at all (defensive fallback path): entries already carry 0.5 of prior cost
  // plus this response's own 0.02 by the time after_provider_response fires.
  const entries = [assistantEntry(0.5), assistantEntry(0.02)];
  fire("after_provider_response", { headers: litellmHeaders("call-1") }, { sessionManager: { getEntries: () => entries } });

  const lines = readFileSync(spendFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].usage, 0);
});

// ---------- E2.11b: extension wiring -- network-backed session_start ----------

/** Sets LITELLM_AGENT_KEY/OUTFITTER_SPEND_FILE and a stub global fetch for the duration of the test,
 * restoring all three afterwards. */
function withLitellmEnv(t: any, spendFile: string, fetchImpl: typeof fetch) {
  const prevKey = process.env.LITELLM_AGENT_KEY;
  const prevFile = process.env.OUTFITTER_SPEND_FILE;
  const prevFetch = globalThis.fetch;
  process.env.LITELLM_AGENT_KEY = "sk-test";
  process.env.OUTFITTER_SPEND_FILE = spendFile;
  globalThis.fetch = fetchImpl;
  t.after(() => {
    if (prevKey === undefined) delete process.env.LITELLM_AGENT_KEY;
    else process.env.LITELLM_AGENT_KEY = prevKey;
    if (prevFile === undefined) delete process.env.OUTFITTER_SPEND_FILE;
    else process.env.OUTFITTER_SPEND_FILE = prevFile;
    globalThis.fetch = prevFetch;
  });
}

test("outfitterSpend: session_start appends a baseline line from GET /key/info before any provider call", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "outfitter-spend-test-"));
  const spendFile = join(dir, "spend.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const calls: string[] = [];
  withLitellmEnv(t, spendFile, (async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith("/key/info")) return { ok: true, json: async () => ({ info: { spend: 4.5 } }) } as any;
    if (String(url).endsWith("/model/info")) return { ok: true, json: async () => ({ data: [] }) } as any;
    return { ok: false, json: async () => ({}) } as any;
  }) as any);

  const { api, fire } = fakePi();
  outfitterSpend(api as any);
  fire("session_start", {}, { sessionManager: { getEntries: () => [] } });

  // session_start's fetches are async; give the microtask/macrotask queue a turn to resolve.
  await new Promise((resolve) => setTimeout(resolve, 10));

  const lines = readFileSync(spendFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { baseline: true, keySpend: 4.5 });
  assert.ok(calls.some((u) => u.endsWith("/key/info")));
  assert.ok(calls.some((u) => u.endsWith("/model/info")));
});

test("outfitterSpend: session_start's fetched prices make a later auto-router response use the resolved-model cost", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "outfitter-spend-test-"));
  const spendFile = join(dir, "spend.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  withLitellmEnv(t, spendFile, (async (url: string) => {
    if (String(url).endsWith("/key/info")) return { ok: true, json: async () => ({ info: {} }) } as any; // no spend field: no baseline line
    if (String(url).endsWith("/model/info")) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { model_name: "claude-auto-llm", model_info: { input_cost_per_token: 0, output_cost_per_token: 0 } },
            { model_name: "claude-sonnet-5", model_info: { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 } },
          ],
        }),
      } as any;
    }
    return { ok: false, json: async () => ({}) } as any;
  }) as any);

  const { api, fire } = fakePi();
  outfitterSpend(api as any);
  fire("session_start", {}, { sessionManager: { getEntries: () => [] } });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const entries = [
    { type: "message", message: { role: "assistant", provider: "litellm", usage: { input: 1000, output: 500, cost: { total: 0 } } } },
  ];
  fire(
    "after_provider_response",
    { headers: { "x-litellm-call-id": "call-1", "x-litellm-model-group": "claude-auto-llm", "x-litellm-model-name": "claude-sonnet-5" } },
    { sessionManager: { getEntries: () => entries } },
  );

  const lines = readFileSync(spendFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // The baseline line is absent (no `spend` in /key/info's response), so this is the only line.
  assert.equal(lines.length, 1);
  // 1000*0.000003 + 500*0.000015 = 0.003 + 0.0075 = 0.0105 -- not the 0 pi's own delta would give.
  assert.ok(Math.abs(lines[0].usage - 0.0105) < 1e-9, `expected ~0.0105, got ${lines[0].usage}`);
});

test("outfitterSpend: a fetch failure at session_start degrades to the prior behaviour without throwing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "outfitter-spend-test-"));
  const spendFile = join(dir, "spend.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  withLitellmEnv(t, spendFile, (async () => {
    throw new Error("ECONNREFUSED");
  }) as any);

  const { api, fire } = fakePi();
  outfitterSpend(api as any);
  assert.doesNotThrow(() => fire("session_start", {}, { sessionManager: { getEntries: () => [] } }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  // No baseline line written (the /key/info probe failed); a normal response still logs its delta.
  fire("after_provider_response", { headers: litellmHeaders("call-1") }, { sessionManager: { getEntries: () => [assistantEntry(0.02)] } });
  const lines = readFileSync(spendFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.ok(Math.abs(lines[0].usage - 0.02) < 1e-9);
});
