import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitJsonlChunk, JsonlLineReader, SessionTailer, SpendTailer, JsonlTailer, validateSpendLine, spawnPi, baseEnvForPi, PI_ENV_PASSTHROUGH_VAR } from "../src/pi.js";

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("splitJsonlChunk: splits on LF only, strips trailing CR, keeps partial tail", () => {
  const { lines, rest } = splitJsonlChunk('{"a":1}\n{"b":2}\r\n{"c":3');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, '{"c":3');
});

test("splitJsonlChunk: does not split on U+2028/U+2029 embedded in a JSON string", () => {
  const line = JSON.stringify({ text: "para one para two para three" });
  const { lines, rest } = splitJsonlChunk(`${line}\n`);
  assert.deepEqual(lines, [line]);
  assert.equal(rest, "");
  assert.equal(JSON.parse(lines[0]).text.includes(" "), true);
});

test("JsonlLineReader: reassembles lines split across chunk boundaries", () => {
  const reader = new JsonlLineReader();
  assert.deepEqual(reader.push('{"a":'), []);
  assert.deepEqual(reader.push('1}\n{"b":2}\n{"c":'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(reader.push("3}\n"), ['{"c":3}']);
  assert.deepEqual(reader.end(), []);
});

test("JsonlLineReader: end() flushes a trailing line with no newline", () => {
  const reader = new JsonlLineReader();
  reader.push('{"a":1}\n{"partial":true');
  assert.deepEqual(reader.end(), ['{"partial":true']);
});

test("SessionTailer: emits entries appended after the header, skipping the header itself", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outfitter-pi-test-"));
  const file = join(dir, "session.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "t", cwd: "/workspace" })}\n`);

  const seen: any[] = [];
  const tailer = new SessionTailer(file, (entry) => seen.push(entry), { intervalMs: 20 });
  await tailer.poll(); // header only so far -> no entries
  assert.equal(seen.length, 0);

  await appendFile(file, `${JSON.stringify({ type: "message", id: "e1", parentId: "s1", timestamp: "t", message: { role: "user", content: "hi" } })}\n`);
  await tailer.poll();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, "e1");

  await appendFile(file, `${JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "t", message: { role: "assistant", content: [] } })}\n`);
  await tailer.poll();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].id, "e2");
  tailer.stop();
});

test("SessionTailer: does not emit a partial (no trailing newline) line until it is completed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outfitter-pi-test-"));
  const file = join(dir, "session.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "t", cwd: "/workspace" })}\n`);

  const seen: any[] = [];
  const tailer = new SessionTailer(file, (entry) => seen.push(entry), { intervalMs: 20 });
  await tailer.poll();

  // Simulate pi writing an entry without the trailing newline yet (mid-write).
  await appendFile(file, '{"type":"message","id":"partial","parentId":"s1"');
  await tailer.poll();
  assert.equal(seen.length, 0);

  // Now the writer finishes the line.
  await appendFile(file, `,"timestamp":"t","message":{"role":"user","content":"done"}}\n`);
  await tailer.poll();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, "partial");
  tailer.stop();
});

test("SpendTailer: emits every line, no header to skip (unlike SessionTailer)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outfitter-pi-test-"));
  const file = join(dir, "spend.jsonl");
  await writeFile(file, `${JSON.stringify({ usage: 0.01, callId: "call-1" })}\n`);

  const seen: any[] = [];
  const tailer = new SpendTailer(file, (line) => seen.push(line), { intervalMs: 20 });
  await tailer.poll();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].callId, "call-1");
  tailer.stop();
});

test("SpendTailer is a JsonlTailer with no skipHeader (SessionTailer/SpendTailer share one tailer implementation)", () => {
  assert.ok(new SpendTailer("/nonexistent", () => {}) instanceof JsonlTailer);
  assert.ok(new SessionTailer("/nonexistent", () => {}) instanceof JsonlTailer);
});

test("validateSpendLine: accepts a well-formed line and passes its fields through unchanged", () => {
  const line = validateSpendLine({ usage: 0.5, keySpend: 1.5, keyMax: 10, modelGroup: "sonnet", callId: "call-1" });
  assert.deepEqual(line, { usage: 0.5, keySpend: 1.5, keyMax: 10, modelGroup: "sonnet", callId: "call-1", baseline: undefined });
});

test("validateSpendLine: accepts a line with only some fields present", () => {
  assert.deepEqual(validateSpendLine({ usage: 0.01 }), {
    usage: 0.01,
    keySpend: undefined,
    keyMax: undefined,
    modelGroup: undefined,
    callId: undefined,
    baseline: undefined,
  });
  assert.deepEqual(validateSpendLine({}), {
    usage: undefined,
    keySpend: undefined,
    keyMax: undefined,
    modelGroup: undefined,
    callId: undefined,
    baseline: undefined,
  });
});

// ---------- E2.11b: baseline lines ----------

test("validateSpendLine: accepts a baseline line (baseline: true, keySpend, no usage)", () => {
  const line = validateSpendLine({ baseline: true, keySpend: 4.5 });
  assert.deepEqual(line, { usage: undefined, keySpend: 4.5, keyMax: undefined, modelGroup: undefined, callId: undefined, baseline: true });
});

test("validateSpendLine: rejects a non-boolean baseline field", () => {
  assert.equal(validateSpendLine({ baseline: "true", keySpend: 4.5 }), undefined);
  assert.equal(validateSpendLine({ baseline: 1, keySpend: 4.5 }), undefined);
});

test("validateSpendLine: rejects a non-object value (malformed/hostile line)", () => {
  assert.equal(validateSpendLine(null), undefined);
  assert.equal(validateSpendLine(undefined), undefined);
  assert.equal(validateSpendLine("not an object"), undefined);
  assert.equal(validateSpendLine(42), undefined);
  assert.equal(validateSpendLine(true), undefined);
  assert.equal(validateSpendLine([1, 2, 3]), undefined);
});

test("validateSpendLine: rejects usage outside [0, 1000] or non-finite", () => {
  assert.equal(validateSpendLine({ usage: -0.01 }), undefined);
  assert.equal(validateSpendLine({ usage: 1000.01 }), undefined);
  assert.equal(validateSpendLine({ usage: Infinity }), undefined);
  assert.equal(validateSpendLine({ usage: NaN }), undefined);
  assert.equal(validateSpendLine({ usage: "0.01" }), undefined);
  assert.ok(validateSpendLine({ usage: 1000 }));
  assert.ok(validateSpendLine({ usage: 0 }));
});

test("validateSpendLine: rejects keySpend/keyMax that are negative, non-finite, or the wrong type", () => {
  assert.equal(validateSpendLine({ keySpend: -1 }), undefined);
  assert.equal(validateSpendLine({ keySpend: Infinity }), undefined);
  assert.equal(validateSpendLine({ keySpend: "1" }), undefined);
  assert.equal(validateSpendLine({ keyMax: -1 }), undefined);
  assert.equal(validateSpendLine({ keyMax: NaN }), undefined);
  assert.ok(validateSpendLine({ keySpend: 0, keyMax: 0 }));
});

test("validateSpendLine: rejects modelGroup/callId that are too long or the wrong type", () => {
  assert.equal(validateSpendLine({ modelGroup: "x".repeat(200) }), undefined);
  assert.equal(validateSpendLine({ callId: "x".repeat(200) }), undefined);
  assert.equal(validateSpendLine({ modelGroup: 123 }), undefined);
  assert.equal(validateSpendLine({ callId: { toString: () => "call-1" } }), undefined);
  assert.ok(validateSpendLine({ modelGroup: "x".repeat(199), callId: "call-1" }));
});

test("validateSpendLine: a prototype-pollution attempt is rejected without touching the prototype", () => {
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "usage": 0.01}');
  const line = validateSpendLine(hostile);
  assert.ok(line);
  assert.equal(line!.usage, 0.01);
  assert.equal(({} as any).polluted, undefined);
});

test("spawnPi: send() after the child has exited does not throw, and is logged instead", async () => {
  const logs: string[] = [];
  const exitCodes: Array<number | null> = [];
  const pi = spawnPi({
    piBin: process.execPath,
    args: ["-e", "process.exit(0)"],
    env: {},
    cwd: process.cwd(),
    onLog: (line) => logs.push(line),
  });
  pi.onExit((code) => exitCodes.push(code));

  await waitFor(() => exitCodes.length === 1);
  assert.equal(exitCodes[0], 0);

  assert.doesNotThrow(() => pi.send({ type: "prompt", message: "hello" }));
  assert.ok(logs.some((l) => l.includes("send() ignored after exit")), logs.join("\n"));
});

test("SessionTailer: tolerates the file not existing yet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outfitter-pi-test-"));
  const file = join(dir, "does-not-exist-yet.jsonl");
  const seen: any[] = [];
  const tailer = new SessionTailer(file, (entry) => seen.push(entry), { intervalMs: 20 });
  await tailer.poll();
  assert.equal(seen.length, 0);
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "t", cwd: "/workspace" })}\n${JSON.stringify({ type: "message", id: "e1", parentId: "s1", timestamp: "t", message: { role: "user", content: "hi" } })}\n`);
  await tailer.poll();
  assert.equal(seen.length, 1);
  tailer.stop();
});

// ---------- pi's inherited environment (finding #1, docs/reports/security-review-pr41.md) ----------

/** The env a real Cloud Run Job execution of the sandbox image hands agentd: the image's own ENV
 * block (image/Dockerfile) plus what providers/cloudrun.ts injects per execution. */
const SANDBOX_PROCESS_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/root",
  HOSTNAME: "localhost",
  NODE_VERSION: "24.0.0",
  LANG: "C.UTF-8",
  PI_CODING_AGENT_DIR: "/opt/kernal/.pi",
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_BIN: "/opt/kernal/node_modules/.bin/pi",
  PI_RUN_AS_USER: "agent",
  WORKSPACE: "/workspace",
  OUTFITTER_SPEND_EXTENSION: "/opt/outfitter/agentd/dist/pi-extension/outfitter-spend.js",
  OUTFITTER_SPEND_FILE: "/run/outfitter/spend.jsonl",
  OUTFITTER_MAIL_EXTENSION: "/opt/outfitter/agentd/dist/pi-extension/outfitter-mail.js",
  KERNAL_NO_CODEBASE_INDEX: "1",
  KERNAL_SANDBOX: "1",
  PI_TIMING: "1",
  // Injected per execution by the api (providers/cloudrun.ts) -- none of these may reach pi.
  RUN_ID: "run-123",
  RUN_TOKEN: "not-a-real-run-token",
  OUTFITTER_API: "https://outfitter-link.example.run.app",
  // Cloud Run's own execution metadata: pi has no use for any of it.
  CLOUD_RUN_JOB: "outfitter-agent",
  CLOUD_RUN_EXECUTION: "outfitter-agent-abcde",
  CLOUD_RUN_TASK_INDEX: "0",
};

test("baseEnvForPi: never hands pi the run-takeover kit (RUN_TOKEN/RUN_ID/OUTFITTER_API)", () => {
  const env = baseEnvForPi(SANDBOX_PROCESS_ENV);
  // The whole of finding #1: with these three, the model's shell can mint an agent identity token
  // from the metadata server, open its own /agent/ws for this run and be handed run.spec's
  // githubToken and litellmKey.
  assert.equal(env.RUN_TOKEN, undefined);
  assert.equal(env.RUN_ID, undefined);
  assert.equal(env.OUTFITTER_API, undefined);
  assert.equal(env.OUTFITTER_DEV_TOKEN, undefined);
});

test("baseEnvForPi: keeps what pi and the model's shell actually need", () => {
  const env = baseEnvForPi(SANDBOX_PROCESS_ENV);
  assert.equal(env.PATH, "/usr/local/bin:/usr/bin:/bin");
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.PI_CODING_AGENT_DIR, "/opt/kernal/.pi");
  assert.equal(env.PI_OFFLINE, "1");
  assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
  assert.equal(env.KERNAL_NO_CODEBASE_INDEX, "1");
  // Added to the image by the start-up trim (#37): the allowlist's KERNAL_*/PI_* prefixes have to
  // keep covering new image ENV entries, or a sandbox silently loses sandbox mode / phase timings.
  assert.equal(env.KERNAL_SANDBOX, "1");
  assert.equal(env.PI_TIMING, "1");
  // Deliberately absent, not overridden: pi must fall back to /tmp so it finds the jiti cache the
  // image prewarms at /tmp/jiti as the `agent` user (image/prewarm-extensions.sh, "nothing may set
  // TMPDIR for pi"). TMPDIR is allowlisted only so a set one still reaches pi, as it did before.
  assert.equal(env.TMPDIR, undefined);
});

test("baseEnvForPi: allowlist, not denylist -- an unknown var is dropped, not passed", () => {
  const env = baseEnvForPi({ ...SANDBOX_PROCESS_ENV, SOME_FUTURE_SECRET: "leak-me" });
  assert.equal(env.SOME_FUTURE_SECRET, undefined);
  // Cloud Run's execution metadata is equally unneeded.
  assert.equal(env.CLOUD_RUN_EXECUTION, undefined);
  assert.equal(env.HOSTNAME, undefined);
});

test("baseEnvForPi: drops NODE_OPTIONS and the GIT_CONFIG_* auth-header overlay", () => {
  const env = baseEnvForPi({
    ...SANDBOX_PROCESS_ENV,
    NODE_OPTIONS: "--require /tmp/evil.js",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "Authorization: Basic not-a-real-github-credential",
  });
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_CONFIG_KEY_0, undefined);
  assert.equal(env.GIT_CONFIG_VALUE_0, undefined);
});

test("baseEnvForPi: the operator passthrough adds vars but can never re-add a secret one", () => {
  const env = baseEnvForPi({
    ...SANDBOX_PROCESS_ENV,
    HTTPS_PROXY: "http://proxy.internal:3128",
    NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
    [PI_ENV_PASSTHROUGH_VAR]: "HTTPS_PROXY, NODE_EXTRA_CA_CERTS, RUN_TOKEN, NODE_OPTIONS",
  });
  assert.equal(env.HTTPS_PROXY, "http://proxy.internal:3128");
  assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/ssl/corp.pem");
  assert.equal(env.RUN_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test("spawnPi: the child's env is the allowlist plus the caller's explicit overlay", () => {
  const calls: Array<{ env: Record<string, string> }> = [];
  const fakeSpawn: any = (_bin: string, _args: string[], options: any) => {
    calls.push({ env: options.env });
    return {
      stdin: { on() {}, write() {} },
      stdout: { setEncoding() {}, on() {} },
      stderr: { setEncoding() {}, on() {} },
      on() {},
      kill() {},
      pid: 1234,
    };
  };
  const previous = { RUN_TOKEN: process.env.RUN_TOKEN, OUTFITTER_API: process.env.OUTFITTER_API };
  process.env.RUN_TOKEN = "not-a-real-run-token";
  process.env.OUTFITTER_API = "https://outfitter-link.example.run.app";
  try {
    spawnPi({
      piBin: "/opt/kernal/node_modules/.bin/pi",
      args: ["--mode", "rpc"],
      // What run.ts passes: the per-run secrets pi is *meant* to have, explicitly.
      env: { LITELLM_AGENT_KEY: "not-a-real-litellm-key", OUTFITTER_SESSION_ID: "s1", HOME: "/home/agent" },
      cwd: "/workspace",
      spawnFn: fakeSpawn,
    });
  } finally {
    if (previous.RUN_TOKEN === undefined) delete process.env.RUN_TOKEN;
    else process.env.RUN_TOKEN = previous.RUN_TOKEN;
    if (previous.OUTFITTER_API === undefined) delete process.env.OUTFITTER_API;
    else process.env.OUTFITTER_API = previous.OUTFITTER_API;
  }

  assert.equal(calls.length, 1);
  const env = calls[0].env;
  assert.equal(env.RUN_TOKEN, undefined);
  assert.equal(env.OUTFITTER_API, undefined);
  assert.equal(env.LITELLM_AGENT_KEY, "not-a-real-litellm-key");
  assert.equal(env.OUTFITTER_SESSION_ID, "s1");
  assert.equal(env.HOME, "/home/agent");
});
