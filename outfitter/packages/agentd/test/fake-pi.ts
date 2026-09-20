#!/usr/bin/env node
/**
 * Fake pi RPC process for run.test.ts: speaks a subset of docs/rpc.md. Reads `--session <path>`
 * from argv; on a `prompt` command emits `agent_start`, one `message_update`, appends a fake entry
 * to the session file, then `agent_end` and `agent_settled`. Not a real pi -- just enough of the
 * wire contract to drive RunController's state machine in tests without pi installed.
 */
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const sessionIdx = args.indexOf("--session");
const sessionFile = sessionIdx !== -1 ? args[sessionIdx + 1] : undefined;

function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function appendFakeEntry(): void {
  if (!sessionFile) return;
  const entry = {
    type: "message",
    id: randomBytes(4).toString("hex"),
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
      api: "fake",
      provider: "fake",
      model: "fake-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  };
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
}

function handle(cmd: any): void {
  if (cmd.type === "prompt") {
    emit({ id: cmd.id, type: "response", command: "prompt", success: true });
    emit({ type: "agent_start" });
    emit({
      type: "message_update",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "pong" },
    });
    appendFakeEntry();
    emit({ type: "agent_end", messages: [], willRetry: false });
    emit({ type: "agent_settled" });
  } else if (cmd.type === "abort") {
    emit({ id: cmd.id, type: "response", command: "abort", success: true });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.length === 0) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
});
process.stdin.resume();
