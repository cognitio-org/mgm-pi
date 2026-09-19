#!/usr/bin/env node
// Usage: node chat.mjs [provider] "your prompt"
//   provider = lmstudio (default) | litellm | openrouter
// Reads .env; every provider speaks the OpenAI chat-completions API.
import { readFileSync, existsSync } from "node:fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const args = process.argv.slice(2);
const provider = ["lmstudio", "litellm", "openrouter"].includes(args[0]) ? args.shift() : (process.env.PROVIDER || "lmstudio");
const prompt = args.join(" ") || "Say hello in five words.";

const P = provider.toUpperCase();
const baseUrl = process.env[`${P}_BASE_URL`];
const apiKey = process.env[`${P}_API_KEY`] || "lm-studio";
const model = process.env[`${P}_MODEL`];
if (!baseUrl || !model) {
  console.error(`Missing ${P}_BASE_URL or ${P}_MODEL in .env`);
  process.exit(1);
}

const t0 = Date.now();
const res = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: prompt }] }),
});
if (!res.ok) { console.error(res.status, await res.text()); process.exit(1); }

let tokens = 0;
const dec = new TextDecoder();
let buf = "";
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith("data:") || line === "data: [DONE]") continue;
    const delta = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content;
    if (delta) { process.stdout.write(delta); tokens++; }
  }
}
console.error(`\n\n[${provider} / ${model}] ~${tokens} chunks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
