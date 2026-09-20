import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import outfitterSpend, { parseSpendHeaders, sessionCostTotal, buildSpendLogLine } from "../pi-extension/outfitter-spend.js";

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
  assert.deepEqual(h, { litellm: true, keySpend: 1.5, keyMax: 10, modelGroup: "sonnet", callId: "call-1" });
});

test("parseSpendHeaders: keyMax is undefined when the header is missing (no budget cap set)", () => {
  const h = parseSpendHeaders({ "x-litellm-call-id": "call-2", "x-litellm-key-spend": "3" });
  assert.equal(h.litellm, true);
  assert.equal(h.keySpend, 3);
  assert.equal(h.keyMax, undefined);
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
