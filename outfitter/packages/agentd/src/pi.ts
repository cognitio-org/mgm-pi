/**
 * Spawns `pi --mode rpc -a --session <file> ...`, speaks its LF-only JSONL framing (rpc.md:
 * "Split records on \n only... Node readline is not protocol-compliant"), forwards parsed events,
 * accepts commands to write to stdin, and tails the session file for newly appended entries so
 * agentd can emit `entry` up-frames as pi writes them (rather than waiting on an RPC round trip).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { open, stat } from "node:fs/promises";
import type { PiRpcCommand, PiRpcEvent, PiSessionEntry } from "./protocol.js";

// ---------- LF-only JSONL framing ----------

/** Splits `buffer` on `\n` only (never on U+2028/U+2029, unlike Node's `readline`), stripping a
 * trailing `\r` from each line. Returns complete lines plus whatever incomplete tail remains
 * buffered. Pure function, exported for direct unit testing. */
export function splitJsonlChunk(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf("\n", start);
    if (idx === -1) break;
    let line = buffer.slice(start, idx);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    lines.push(line);
    start = idx + 1;
  }
  return { lines, rest: buffer.slice(start) };
}

/** Incremental LF-only JSONL line reader over arbitrary string chunks. */
export class JsonlLineReader {
  private buffer = "";

  /** Feeds a chunk and returns any complete lines it produced (may be empty). */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const { lines, rest } = splitJsonlChunk(this.buffer);
    this.buffer = rest;
    return lines;
  }

  /** Flushes a final partial line at stream end, if any. */
  end(): string[] {
    if (this.buffer.length === 0) return [];
    const last = this.buffer;
    this.buffer = "";
    return [last];
  }
}

// ---------- pi RPC process ----------

export interface PiProcessOptions {
  piBin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Injectable for tests; defaults to node:child_process.spawn. */
  spawnFn?: typeof spawn;
  /** Sink for swallowed stdio errors (e.g. EPIPE once pi has exited) and no-op `send()` calls after
   * exit. Defaults to a no-op. */
  onLog?: (line: string) => void;
}

export interface PiProcess {
  send(command: PiRpcCommand): void;
  onEvent(handler: (event: PiRpcEvent) => void): void;
  onStderr(handler: (chunk: string) => void): void;
  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
  readonly pid: number | undefined;
}

export function spawnPi(opts: PiProcessOptions): PiProcess {
  const spawnFn = opts.spawnFn ?? spawn;
  const onLog = opts.onLog ?? (() => {});
  const child: ChildProcessWithoutNullStreams = spawnFn(opts.piBin, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const reader = new JsonlLineReader();
  const eventHandlers: Array<(event: PiRpcEvent) => void> = [];
  const stderrHandlers: Array<(chunk: string) => void> = [];
  const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  let exited = false;

  // A write to (or from) a dead child's stdio throws/emits EPIPE. Node's EventEmitter contract makes
  // an unhandled 'error' event on any of these streams fatal to the whole process -- without these
  // handlers, a send() racing pi's exit (or pi dying mid-write) would crash agentd, not just this run.
  child.stdin.on("error", (err: NodeJS.ErrnoException) => {
    onLog(`pi stdin error: ${err?.code ?? err?.message ?? err}`);
  });
  child.stdout.on("error", (err: NodeJS.ErrnoException) => {
    onLog(`pi stdout error: ${err?.code ?? err?.message ?? err}`);
  });
  child.stderr.on("error", (err: NodeJS.ErrnoException) => {
    onLog(`pi stderr error: ${err?.code ?? err?.message ?? err}`);
  });

  function emitLine(line: string) {
    if (line.length === 0) return;
    let parsed: PiRpcEvent;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // malformed line on stdout; not our contract to enforce, just drop it
    }
    for (const h of eventHandlers) h(parsed);
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const line of reader.push(chunk)) emitLine(line);
  });
  child.stdout.on("end", () => {
    for (const line of reader.end()) emitLine(line);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const h of stderrHandlers) h(chunk);
  });

  child.on("exit", (code, signal) => {
    exited = true;
    for (const h of exitHandlers) h(code, signal);
  });

  return {
    send(command) {
      if (exited) {
        onLog(`pi send() ignored after exit: ${command.type}`);
        return;
      }
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
      } catch (err: any) {
        onLog(`pi stdin write failed: ${err?.code ?? err?.message ?? err}`);
      }
    },
    onEvent(handler) {
      eventHandlers.push(handler);
    },
    onStderr(handler) {
      stderrHandlers.push(handler);
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    kill(signal = "SIGTERM") {
      child.kill(signal);
    },
    get pid() {
      return child.pid;
    },
  };
}

// ---------- session file tailer ----------

export interface SessionTailerOptions {
  /** Poll interval in ms. */
  intervalMs?: number;
}

/** Polls `sessionFile` for newly appended JSONL lines and emits parsed entries. The first line
 * (the session header, `type: "session"`) is consumed but never emitted as an entry. Handles the
 * file not existing yet by retrying until it appears. */
export class SessionTailer {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private sawHeader = false;
  private readonly intervalMs: number;

  constructor(
    private readonly sessionFile: string,
    private readonly onEntry: (entry: PiSessionEntry) => void,
    opts: SessionTailerOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 250;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads and emits everything currently available; used by tests and by the final drain before
   * checkpointing so no trailing entry is lost. */
  async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const st = await stat(this.sessionFile).catch(() => undefined);
      if (!st || st.size <= this.offset) return;
      const handle = await open(this.sessionFile, "r");
      try {
        const length = st.size - this.offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this.offset);
        const text = buffer.toString("utf8");
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline === -1) return; // no complete line yet; wait for more to be appended
        const consumed = text.slice(0, lastNewline + 1);
        this.offset += Buffer.byteLength(consumed, "utf8");
        const { lines } = splitJsonlChunk(consumed);
        for (const line of lines) {
          if (line.length === 0) continue;
          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (!this.sawHeader && parsed.type === "session") {
            this.sawHeader = true;
            continue;
          }
          this.onEntry(parsed as PiSessionEntry);
        }
      } finally {
        await handle.close();
      }
    } finally {
      this.reading = false;
    }
  }
}
