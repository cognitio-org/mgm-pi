#!/usr/bin/env node
/**
 * Fake pi RPC process: speaks a subset of docs/rpc.md. Reads `--session <path>` from argv; on a
 * `prompt` command emits `agent_start`, one `message_update`, appends a fake entry to the session
 * file, then `agent_end` and `agent_settled`. Not a real pi -- just enough of the wire contract to
 * drive RunController's state machine in tests without pi installed.
 *
 * Used two ways: spawned directly via `node fake-pi.js` (run.test.ts, which overrides piBin to
 * process.execPath and prepends this file to argv), and as a standalone executable pointed to by
 * PI_BIN (packages/agentd's postbuild `chmod +x`s the compiled dist/test/fake-pi.js -- see
 * packages/api/test/e2e.test.ts, which spawns a *real* agentd that execs $PI_BIN directly, the way
 * it execs a real pi in production).
 */
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);

// agentd's own startup (main.ts's getPiVersion) runs `$PI_BIN --version` before ever touching
// --session, and waits up to 5s for it -- answer immediately instead of hanging until that
// timeout, the way a real `pi --version` would.
if (args.includes("--version")) {
  process.stdout.write("fake-pi 0.0.0-test\n");
  process.exit(0);
}

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

/** "SEND <sessionId> <text>" makes this fake pi do what the outfitter-mail extension's
 * outfitter_send does: append an outfitter.mail custom entry (see the api's e2e mail test). */
function appendSendEntry(message: string): void {
  const match = /^SEND (\S+) ([\s\S]+)$/.exec(message);
  if (!sessionFile || !match) return;
  const entry = {
    type: "custom",
    id: randomBytes(4).toString("hex"),
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "outfitter.mail",
    data: { to: match[1], text: match[2], urgent: false },
  };
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
}

function handle(cmd: any): void {
  if (cmd.type === "prompt") {
    emit({ id: cmd.id, type: "response", command: "prompt", success: true });
    if (typeof cmd.message === "string") appendSendEntry(cmd.message);
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
  } else if (cmd.type === "get_state") {
    // agentd's start-up readiness probe (startup-phases.ts): real pi answers once it has loaded.
    emit({ id: cmd.id, type: "response", command: "get_state", success: true, data: {} });
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
