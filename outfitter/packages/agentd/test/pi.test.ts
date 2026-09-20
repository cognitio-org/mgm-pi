import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitJsonlChunk, JsonlLineReader, SessionTailer, spawnPi } from "../src/pi.js";

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
