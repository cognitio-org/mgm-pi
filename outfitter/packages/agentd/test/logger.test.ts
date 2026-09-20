import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/logger.js";

/** A fake writable stream that just accumulates each write() call's chunk as a line. */
function fakeStream(): NodeJS.WritableStream & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      lines.push(String(chunk));
      return true;
    },
  } as unknown as NodeJS.WritableStream & { lines: string[] };
}

test("logger: non-TTY emits one JSON line per call with severity/message and base+call fields", () => {
  const stream = fakeStream();
  const logger = createLogger({ runId: "run1" }, { stream, isTTY: false });
  logger.info("hello", { sessionId: "sess1", state: "running" });

  assert.equal(stream.lines.length, 1);
  const parsed = JSON.parse(stream.lines[0]);
  assert.deepEqual(parsed, {
    severity: "INFO",
    message: "hello",
    runId: "run1",
    sessionId: "sess1",
    state: "running",
  });
});

test("logger: debug/warn/error map to the right severity", () => {
  const stream = fakeStream();
  const logger = createLogger({}, { stream, isTTY: false });
  logger.debug("d");
  logger.warn("w");
  logger.error("e");
  const severities = stream.lines.map((l) => JSON.parse(l).severity);
  assert.deepEqual(severities, ["DEBUG", "WARNING", "ERROR"]);
});

test("logger: TTY mode writes a human-readable line, not JSON", () => {
  const stream = fakeStream();
  const logger = createLogger({ runId: "run1" }, { stream, isTTY: true });
  logger.info("hello world");
  assert.equal(stream.lines.length, 1);
  assert.match(stream.lines[0], /^\[agentd\] INFO hello world/);
  assert.throws(() => JSON.parse(stream.lines[0]));
});

test("logger: addSecret redacts an exact value from later messages and fields", () => {
  const stream = fakeStream();
  const logger = createLogger({}, { stream, isTTY: false });
  // Built from plain words at runtime so secret scanners do not mistake the fixture for a credential.
  const secret = ["fake", "run", "token", "value"].join("-");
  logger.addSecret(secret);
  logger.info(`connecting with token ${secret}`, { detail: `Authorization: Bearer ${secret}` });
  const parsed = JSON.parse(stream.lines[0]);
  assert.ok(!parsed.message.includes(secret));
  assert.ok(!parsed.detail.includes(secret));
  assert.match(parsed.message, /\[redacted\]/);
  assert.match(parsed.detail, /\[redacted\]/);
});

test("logger: addSecret is a no-op for undefined/empty values", () => {
  const stream = fakeStream();
  const logger = createLogger({}, { stream, isTTY: false });
  logger.addSecret(undefined);
  logger.addSecret("");
  logger.info("plain message");
  assert.equal(JSON.parse(stream.lines[0]).message, "plain message");
});

test("logger: redacts URL userinfo credentials unconditionally", () => {
  const stream = fakeStream();
  const logger = createLogger({}, { stream, isTTY: false });
  logger.info("clone failed for https://x-access-token:ghp_abcdef123@github.com/o/r.git");
  const parsed = JSON.parse(stream.lines[0]);
  assert.ok(!parsed.message.includes("ghp_abcdef123"));
  assert.match(parsed.message, /https:\/\/\[redacted\]@github\.com\/o\/r\.git/);
});

test("logger: redacts secret-shaped query params (token/key/secret/signature) unconditionally", () => {
  const stream = fakeStream();
  const logger = createLogger({}, { stream, isTTY: false });
  logger.info("fetch failed: https://storage.example.com/blob?X-Goog-Signature=deadbeef&other=1");
  const parsed = JSON.parse(stream.lines[0]);
  assert.ok(!parsed.message.includes("deadbeef"));
  assert.match(parsed.message, /X-Goog-Signature=\[redacted\]/);
  assert.match(parsed.message, /other=1/); // non-sensitive params are left alone
});

test("logger: child() inherits base fields and shares the secret registry with its parent", () => {
  const stream = fakeStream();
  const parent = createLogger({ runId: "run1" }, { stream, isTTY: false });
  const child = parent.child({ sessionId: "sess1" });
  parent.addSecret("shared-secret");
  child.info("leaked shared-secret here");
  const parsed = JSON.parse(stream.lines[0]);
  assert.equal(parsed.runId, "run1");
  assert.equal(parsed.sessionId, "sess1");
  assert.ok(!parsed.message.includes("shared-secret"));
});

test("logger: a circular field structure logs a placeholder field instead of throwing", () => {
  const stream = fakeStream();
  const logger = createLogger({}, { stream, isTTY: false });
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  assert.doesNotThrow(() => logger.info("hello", { circular }));
  assert.equal(stream.lines.length, 1);
  const parsed = JSON.parse(stream.lines[0]);
  assert.equal(parsed.severity, "INFO");
  assert.equal(parsed.message, "hello");
  assert.equal(parsed.logError, "unserialisable fields");
  assert.equal(parsed.circular, undefined);
});

test("logger: a circular field structure in TTY mode also logs a placeholder instead of throwing", () => {
  const stream = fakeStream();
  const logger = createLogger({}, { stream, isTTY: true });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.doesNotThrow(() => logger.info("hello", { circular }));
  assert.match(stream.lines[0], /logError/);
  assert.match(stream.lines[0], /unserialisable fields/);
});

test("logger: an Error field is converted to { name, message } instead of becoming {}", () => {
  const stream = fakeStream();
  const logger = createLogger({}, { stream, isTTY: false });
  logger.info("failed", { err: new Error("boom") });
  const parsed = JSON.parse(stream.lines[0]);
  assert.deepEqual(parsed.err, { name: "Error", message: "boom" });
});

test("logger: an Error field's stack is included at DEBUG severity", () => {
  const stream = fakeStream();
  const logger = createLogger({}, { stream, isTTY: false });
  logger.debug("failed", { err: new Error("boom") });
  const parsed = JSON.parse(stream.lines[0]);
  assert.equal(parsed.err.name, "Error");
  assert.equal(parsed.err.message, "boom");
  assert.ok(typeof parsed.err.stack === "string" && parsed.err.stack.length > 0);
});

test("logger: an Error field's stack is omitted at INFO/WARNING/ERROR unless verbose is set", () => {
  const stream = fakeStream();
  const logger = createLogger({}, { stream, isTTY: false });
  logger.error("failed", { err: new Error("boom") });
  const parsed = JSON.parse(stream.lines[0]);
  assert.equal(parsed.err.stack, undefined);

  const verboseStream = fakeStream();
  const verboseLogger = createLogger({}, { stream: verboseStream, isTTY: false, verbose: true });
  verboseLogger.error("failed", { err: new Error("boom") });
  const verboseParsed = JSON.parse(verboseStream.lines[0]);
  assert.ok(typeof verboseParsed.err.stack === "string" && verboseParsed.err.stack.length > 0);
});

test("logger: an Error field is still redacted for secrets in its message", () => {
  const stream = fakeStream();
  const logger = createLogger({}, { stream, isTTY: false });
  const secret = ["fake", "err", "secret"].join("-");
  logger.addSecret(secret);
  logger.error("failed", { err: new Error(`token=${secret}`) });
  const parsed = JSON.parse(stream.lines[0]);
  assert.ok(!parsed.err.message.includes(secret));
});

test("logger: never logs an unredacted RUN_TOKEN or LiteLLM key end to end", () => {
  const stream = fakeStream();
  const logger = createLogger({ runId: "run1" }, { stream, isTTY: false });
  const runToken = ["fake", "run", "token"].join("-");
  const litellmKey = ["fake", "litellm", "key"].join("-");
  logger.addSecret(runToken);
  logger.addSecret(litellmKey);
  logger.info(`hello runToken=${runToken}`);
  logger.debug("pi stderr", { detail: `Authorization: Bearer ${litellmKey}` });
  for (const line of stream.lines) {
    assert.ok(!line.includes(runToken), `line leaked runToken: ${line}`);
    assert.ok(!line.includes(litellmKey), `line leaked litellmKey: ${line}`);
  }
});
