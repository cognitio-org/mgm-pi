import { readFileSync } from "node:fs";
import { serializeConversation, convertToLlm } from "/Users/mgm/localllm/mgm/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { summaryPrompt, wordBudget, SUMMARY_SYSTEM_PROMPT } from "/Users/mgm/localllm/mgm/.pi/extensions/compaction/lib.ts";
const [file, key, ...models] = process.argv.slice(2);
const entries = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const msgs = entries.filter((e) => e.type === "message").map((e) => e.message);
// take the first ~9k tokens worth of conversation as one fold
let text = "", chunk = [];
for (const m of msgs) { chunk.push(m); text = serializeConversation(convertToLlm(chunk)); if (text.length > 36_000) break; }
const prompt = summaryPrompt(text, undefined, undefined, wordBudget(1638));
console.log(`fold input: ${chunk.length} messages, ${text.length} chars ≈ ${Math.ceil(text.length/4)} tokens\n`);
const sections = ["## Goal", "## Constraints", "## Progress", "## Key Decisions", "## Next Steps", "## Critical Context", "<read-files>", "<modified-files>"];
for (const model of models) {
  const t0 = Date.now();
  const r = await fetch("https://litellm.augment-code.support/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: 1638, messages: [{ role: "system", content: SUMMARY_SYSTEM_PROMPT }, { role: "user", content: prompt }] }) });
  const cost = r.headers.get("x-litellm-response-cost");
  const d = await r.json();
  if (!r.ok) { console.log(`${model}: HTTP ${r.status} ${JSON.stringify(d).slice(0, 200)}\n`); continue; }
  const out = d.choices?.[0]?.message?.content ?? ""; const u = d.usage ?? {};
  const missing = sections.filter((s) => !out.includes(s));
  console.log(`${model}: ${((Date.now()-t0)/1000).toFixed(1)}s | in ${u.prompt_tokens} out ${u.completion_tokens} (reasoning ${u.completion_tokens_details?.reasoning_tokens ?? 0}) | billed $${Number(cost).toFixed(5)} | ${out.split(/\s+/).length} words | finish ${d.choices?.[0]?.finish_reason} | missing sections: ${missing.length ? missing.join(", ") : "none"}`);
  const sec = (name) => { const i = out.indexOf(name); if (i < 0) return ""; const j = out.indexOf("\n## ", i + 3); return out.slice(i, j < 0 ? undefined : j).trim(); };
  console.log("  " + sec("## Critical Context").replace(/\n/g, " ⏎ ").slice(0, 700));
  console.log("  " + (out.match(/<read-files>[\s\S]*?<\/modified-files>/)?.[0] ?? "(no file lists)").replace(/\n/g, " ").slice(0, 300) + "\n");
}
