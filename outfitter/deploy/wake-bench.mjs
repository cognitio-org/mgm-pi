#!/usr/bin/env node
// Cloud wake benchmark (E2.9, docs/reports/startup-trim.md): wakes one stopped session N times by
// sending it a message, the way a person does in the web UI, and records per wake the time until
// the run is up (runState running/idle) and until the model's answer is stored as an entry. Stops
// the session between wakes and waits for it to be fully stopped, so every wake is a cold one.
//
//   OUTFITTER_API=https://<link origin> OUTFITTER_TOKEN=outf_... \
//     node outfitter/deploy/wake-bench.mjs <session-id> [wakes=10] ["prompt text"]
//
// OUTFITTER_API is the link service's origin (the one `kernal --teleport` uses; it accepts personal
// `outf_` tokens -- the IAP-protected web origin does not). Use a repo-less session with a cheap
// guru model. Each wake costs one short model call. The sandbox's own breakdown of every wake
// (agentd `phase` lines, pi's PI_TIMING table) is in Cloud Logging; the command to read it is
// printed at the end. Node 24+, no dependencies.
const [sessionId, wakesArg, promptArg] = process.argv.slice(2);
const api = process.env.OUTFITTER_API?.replace(/\/+$/, "");
const token = process.env.OUTFITTER_TOKEN;
if (!sessionId || !api || !token) {
  console.error("usage: OUTFITTER_API=... OUTFITTER_TOKEN=... node wake-bench.mjs <session-id> [wakes=10] [prompt]");
  process.exit(2);
}
const wakes = Number(wakesArg ?? 10);
if (!Number.isInteger(wakes) || wakes < 1 || wakes > 100) {
  console.error("wakes must be an integer from 1 to 100");
  process.exit(2);
}
const prompt = promptArg ?? "Reply with exactly: ok";
const POLL_MS = 500;
const WAKE_TIMEOUT_MS = 10 * 60_000;

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok && res.status !== 202 && res.status !== 404) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: undefined }; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runState = async () => (await call("GET", `/api/sessions/${sessionId}`)).json?.runState;
const runFilter = () => results.filter((r) => r.runId).map((r) => `jsonPayload.runId="${r.runId}"`).join(" OR ") || "jsonPayload.runId!=\"\"";
const isLive = (s) => s !== undefined && s !== "stopped" && s !== "failed";

async function stopAndWait() {
  if (isLive(await runState())) await call("POST", `/api/sessions/${sessionId}/stop`);
  const deadline = Date.now() + 5 * 60_000;
  while (isLive(await runState())) {
    if (Date.now() > deadline) throw new Error("session did not stop within 5 minutes");
    await sleep(2000);
  }
}

async function lastEntryId() {
  const entries = (await call("GET", `/api/sessions/${sessionId}/entries`)).json ?? [];
  return entries.at(-1)?.id;
}

const results = [];
for (let i = 1; i <= wakes; i++) {
  await stopAndWait();
  const after = await lastEntryId();
  const t0 = performance.now();
  const startedAt = new Date().toISOString();
  const posted = await call("POST", `/api/sessions/${sessionId}/messages`, { text: prompt });
  // 404 is tolerated by call() for /stop (no active run); here it means a wrong session id, and
  // waiting out WAKE_TIMEOUT_MS on every wake would hide that for over an hour.
  if (posted.status !== 200 && posted.status !== 202) throw new Error(`POST messages: ${posted.status}`);
  const runId = posted.json?.run?.id;
  let upMs, answerMs;
  while (answerMs === undefined) {
    const elapsed = performance.now() - t0;
    if (elapsed > WAKE_TIMEOUT_MS) break;
    const state = await runState();
    if (upMs === undefined && (state === "running" || state === "idle")) upMs = Math.round(elapsed);
    const fresh = (await call("GET", `/api/sessions/${sessionId}/entries${after ? `?after=${encodeURIComponent(after)}` : ""}`)).json ?? [];
    if (fresh.some((e) => e?.type === "message" && e.message?.role === "assistant")) answerMs = Math.round(performance.now() - t0);
    else await sleep(POLL_MS);
  }
  results.push({ wake: i, runId, startedAt, upMs, answerMs });
  console.log(JSON.stringify(results.at(-1)));
}
await stopAndWait();

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return undefined;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
console.log(JSON.stringify({
  wakes: results.length,
  medianUpMs: median(results.map((r) => r.upMs)),
  medianAnswerMs: median(results.map((r) => r.answerMs)),
  answerMs: results.map((r) => r.answerMs),
}));
console.log(`
Per-wake breakdown from the sandbox itself (agentd phase lines; pi's per-extension table is the
DEBUG lines with source="pi" in the same executions):
  gcloud logging read 'resource.type="cloud_run_job" AND jsonPayload.message="phase" AND (${runFilter()}) AND timestamp>="${results[0]?.startedAt ?? ""}"' \\
    --format='table(timestamp, jsonPayload.runId, jsonPayload.phase, jsonPayload.ms, jsonPayload.sinceLastMs)' --order=asc`);
