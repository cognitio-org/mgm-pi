/**
 * E9 §3.3 recall for `memory: auto` tapes: before each prompt, ask the API for memories relevant
 * to it (op `memory.context`) and put them in the system prompt's `memory` section. Loaded only
 * under agentd (renderGuru adds `--extension <this file>` when the tape's memory is `auto` and
 * OUTFITTER_MEMORY_EXTENSION is set). Self-contained, like outfitter-spend.ts: no import from pi
 * or Kernal.
 *
 * - The call goes over agentd's admin socket (OUTFITTER_ADMIN_SOCKET; one JSON object per line,
 *   `admin.request` / `admin.result`, as Kernal's outfitter-admin transport speaks it). The API
 *   runs it as the session's identity; the repo filter and the own+org merge are its job.
 * - At most RECALL_TIMEOUT_MS, then the turn goes on without memory. Any failure is skipped
 *   silently: recall must never hold up or break a prompt.
 * - pi rebuilds the prompt from `systemPromptOptions.sections` every turn, so setting
 *   `sections.memory` replaces last turn's block. When an earlier handler forced the whole prompt
 *   (`forceSystemPrompt`, pi-memory does), the block is appended to that instead, as
 *   kernal-html-preview does.
 * - The text is untrusted: the API frames it as notes that may be wrong, never instructions, and
 *   this side also makes sure it can't close the `<memory>` tag it sits in.
 */
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

export const RECALL_TIMEOUT_MS = 3_000;
const MAX_QUERY = 2_000;
const MAX_REPLY = 256 * 1024;
const MAX_SECTION = 8_000;

type PromptOptions = { sections?: Record<string, string>; forceSystemPrompt?: string; [key: string]: unknown };
type BeforeAgentStart = { prompt?: string; systemPromptOptions?: PromptOptions };

type PiMemoryApi = {
  on(event: "before_agent_start", handler: (ev: BeforeAgentStart, ctx: unknown) => void | Promise<void>): void;
};

export type Connect = (path: string) => Socket;

/**
 * One `memory.context` request over the admin socket. Resolves to the recalled text, or undefined
 * on any failure, a refusal, or the timeout. Never rejects.
 */
export function requestContext(socketPath: string, query: string, timeoutMs = RECALL_TIMEOUT_MS, connectFn: Connect = connect): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reqId = randomUUID();
    let socket: Socket;
    let buf = "";
    let done = false;
    const finish = (text?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.removeAllListeners();
      socket?.on("error", () => {});
      socket?.destroy();
      resolve(text);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    try {
      socket = connectFn(socketPath);
    } catch {
      return finish();
    }
    socket.setEncoding("utf8");
    socket.on("error", () => finish());
    socket.on("close", () => finish());
    socket.on("connect", () => {
      // A read: no idempotencyKey (the broker may resend it once after a link drop).
      socket.write(`${JSON.stringify({ t: "admin.request", reqId, op: "memory.context", args: { query } })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_REPLY) return finish();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, nl));
        if (msg?.t !== "admin.result" || msg.reqId !== reqId || msg.ok !== true || typeof msg.text !== "string") return finish();
        finish(msg.text);
      } catch {
        finish();
      }
    });
  });
}

/** The recalled text as it may sit inside `<memory>`: no tag that could close or reopen it, capped. */
export function memoryBlock(text: string): string {
  const safe = text.replace(/<\s*\/?\s*memory\b[^>]*>?/gi, "[memory tag]").trim();
  return safe.length <= MAX_SECTION ? safe : `${safe.slice(0, MAX_SECTION - 1)}…`;
}

/** Puts `text` into this turn's prompt (see the module doc). Empty text changes nothing. */
export function applyMemory(options: PromptOptions | undefined, text: string | undefined): void {
  if (!options || !text?.trim()) return;
  const block = memoryBlock(text);
  if (!block) return;
  options.sections ??= {};
  options.sections.memory = block;
  if (typeof options.forceSystemPrompt === "string") {
    options.forceSystemPrompt = `${options.forceSystemPrompt}\n\n<memory>\n${block}\n</memory>`;
  }
}

export default function outfitterMemory(pi: PiMemoryApi, env: NodeJS.ProcessEnv = process.env, deps: { connect?: Connect; timeoutMs?: number } = {}): void {
  const socketPath = env.OUTFITTER_ADMIN_SOCKET?.trim();
  // No socket (agentd couldn't open it) or no memory capability: nothing to ask.
  if (!socketPath) return;
  if (!(env.OUTFITTER_ADMIN_CAPS ?? "").split(",").map((s) => s.trim()).includes("memory")) return;
  pi.on("before_agent_start", async (event) => {
    try {
      const query = typeof event?.prompt === "string" ? event.prompt.trim().slice(0, MAX_QUERY) : "";
      if (!query) return;
      const text = await requestContext(socketPath, query, deps.timeoutMs ?? RECALL_TIMEOUT_MS, deps.connect);
      applyMemory(event.systemPromptOptions, text);
    } catch {
      // Recall is best effort: the prompt goes on without it.
    }
  });
}
