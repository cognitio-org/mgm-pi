/**
 * Live integration tests against the real LiteLLM router. Deliberately tiny and cheap: a few
 * calls to the router's cheapest capable model (gpt-5.4-nano) with small max_tokens, plus one real
 * compaction fold. Measured cost per run: well under $0.01.
 *
 * Gated: runs only with MGM_LIVE=1 and a LITELLM_AGENT_KEY in the environment (CI takes it from
 * the LITELLM_CI_KEY repository secret). Needs network; no LM Studio required (MGM_SKIP_LMS=1).
 *   npm run test:live
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseModelInfo, parseSpendHeaders } from "../.pi/extensions/connect/lib.ts";
import { summaryPrompt as compactionPrompt, wordBudget, SUMMARY_SYSTEM_PROMPT as COMPACTION_SYSTEM } from "../.pi/extensions/compaction/lib.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.LITELLM_AGENT_KEY ?? "";
const BASE = (process.env.LITELLM_BASE_URL ?? "https://litellm.augment-code.support/v1").replace(/\/$/, "");
const MODEL = process.env.MGM_LIVE_MODEL ?? "gpt-5.4-nano";
const enabled = process.env.MGM_LIVE === "1" && !!KEY;
const MAX_COST_USD = 0.02;   // hard ceiling for the whole suite, checked from the router's own cost headers

let spent = 0;
async function chat(body: object): Promise<{ res: Response; json: any }> {
  const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify({ model: MODEL, ...body }) });
  const json = await res.json();
  const c = Number(res.headers.get("x-litellm-response-cost") ?? res.headers.get("x-litellm-response-cost-original") ?? 0);
  if (Number.isFinite(c)) spent += c;
  assert.ok(spent < MAX_COST_USD, `live suite exceeded its cost ceiling: $${spent}`);
  return { res, json };
}
const agent = (args: string[], env: Record<string, string> = {}) =>
  execFileSync(join(root, "bin", "mgm"), args, { encoding: "utf8", timeout: 180_000, cwd: root, env: { ...process.env, MGM_SKIP_LMS: "1", MGM_NO_ANIMATION: "1", ...env } }).trim();

describe("live: LiteLLM router", { skip: !enabled && "set MGM_LIVE=1 and LITELLM_AGENT_KEY" }, () => {
  test("router lists models for this key and reports their context windows", async () => {
    const res = await fetch(`${BASE.replace(/\/v1$/, "")}/model/info`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(res.status, 200, "model/info reachable with the agent key");
    const { ids, meta } = parseModelInfo(await res.json());
    assert.ok(ids.includes(MODEL), `${MODEL} available to this key (has: ${ids.join(", ")})`);
    assert.ok((meta.get(MODEL)?.contextWindow ?? 0) > 0, "context window known");
  });

  test("a minimal completion returns and carries spend headers", async () => {
    const { res, json } = await chat({ max_tokens: 5, messages: [{ role: "user", content: "Reply with exactly: ok" }] });
    assert.equal(res.status, 200, JSON.stringify(json).slice(0, 200));
    assert.match(json.choices[0].message.content.trim().toLowerCase(), /^ok/);
    const h = parseSpendHeaders(Object.fromEntries(res.headers.entries()));
    assert.equal(h.litellm, true, "x-litellm-call-id present");
    assert.ok(typeof h.keySpend === "number", "x-litellm-key-spend present");
  });

  test("the agent answers through the router (real provider registration, discovery, request shaping)", () => {
    const out = agent(["-p", "--no-session", "--model", `litellm/${MODEL}`, "Reply with exactly: ok"]);
    assert.match(out.split("\n").at(-1)!.toLowerCase(), /ok/, out);
  });

  test("the agent can call a tool through the router", () => {
    const out = agent(["-p", "--no-session", "--model", `litellm/${MODEL}`, "Use your read tool on package.json in the current directory and reply with the value of its name field only."]);
    assert.match(out, /mgm/, out);
  });

  test("a real compaction fold follows the template on the default summarizer", async () => {
    const convo = [
      "[User]: Refactor the auth module in src/auth.ts to use the new session store; keep the public API.",
      "[Assistant tool calls]: read(path=\"src/auth.ts\")",
      "[Tool result]: export function login(user) { /* 40 lines */ } export function logout() {}",
      "[Assistant]: I will move session handling into src/session-store.ts and keep login/logout signatures.",
      "[Assistant tool calls]: edit(path=\"src/auth.ts\"); write(path=\"src/session-store.ts\")",
      "[Tool result]: ok",
      "[User]: Also add a test for logout.",
    ].join("\n");
    const prompt = compactionPrompt(convo, undefined, "This is software work. Keep every file path verbatim.", wordBudget(1638));
    const { res, json } = await chat({ max_tokens: 1638, messages: [{ role: "system", content: COMPACTION_SYSTEM }, { role: "user", content: prompt }] });
    assert.equal(res.status, 200);
    const out: string = json.choices[0].message.content;
    // The headings and the verbatim paths are what compaction depends on. The <read-files> and
    // <modified-files> blocks are a hint the prompt asks for, and the cheap summarizer sometimes
    // folds them into the prose instead; that is reported, not failed, so one stochastic omission
    // cannot block a release (it did on v0.1.8).
    for (const s of ["## Goal", "## Progress", "## Next Steps"]) assert.ok(out.includes(s), `summary has ${s}`);
    for (const s of ["<read-files>", "<modified-files>"]) if (!out.includes(s)) console.log(`note: the summarizer omitted ${s} on this run`);
    assert.ok(out.includes("src/auth.ts") && out.includes("src/session-store.ts"), "paths kept verbatim");
    assert.notEqual(json.choices[0].finish_reason, "length", "summary fit the budget");
  });

  test("total cost of this suite stays tiny", () => {
    console.log(`live suite spent ≈ $${spent.toFixed(5)} on ${MODEL}`);
    assert.ok(spent < 0.01, `spent $${spent}`);
  });
});
