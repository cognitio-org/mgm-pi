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
  /** Linux uid/gid to spawn pi as (node:child_process.spawn's own `uid`/`gid` options), dropping
   * privilege from agentd's own (root, in the sandbox image) user -- see run-as-user.ts and
   * finding #1 in docs/reports/security-review-pr1.md. Omitted when agentd isn't root (nothing to
   * drop) or outside the sandbox image (tests, local dev). */
  uid?: number;
  gid?: number;
  /** Injectable for tests; defaults to node:child_process.spawn. */
  spawnFn?: typeof spawn;
  /** Sink for swallowed stdio errors (e.g. EPIPE once pi has exited) and no-op `send()` calls after
   * exit. Defaults to a no-op. */
  onLog?: (line: string) => void;
}

/** agentd's own process env, minus the GIT_CONFIG_* variables git.ts's authHeaderEnv sets for a
 * single git child invocation. Those never actually land in agentd's own process.env (git.ts passes
 * them as a per-call overlay to execFile, not via process.env mutation), but this strips them
 * defensively anyway so pi's environment can never inherit the GitHub auth header even if that
 * invariant were ever broken -- see finding #1's "pi's environment never inherits GIT_CONFIG_* or
 * the token" requirement. */
function baseEnvForPi(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) continue;
    env[key] = value;
  }
  return env;
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
    env: { ...baseEnvForPi(), ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
    ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
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

// ---------- spend log tailer (E2.11) ----------

/** One line the outfitter-spend pi extension appends to OUTFITTER_SPEND_FILE per LiteLLM-backed
 * provider response (pi-extension/outfitter-spend.ts). `usage` is pi's own per-message cost estimate
 * for that one response (not a running total); RunController accumulates it into the run's
 * `costEstimate`. keySpend/keyMax are absent when the response carried no (or an incomplete) LiteLLM
 * spend header, e.g. a key with no budget cap set.
 *
 * E2.11b: `baseline: true` marks the one line the extension appends at `session_start`, before any
 * provider call -- `keySpend` there is the LiteLLM key's balance *before* this run's first call, read
 * from `GET /key/info`, and `usage` is always absent on it. `RunController.handleSpendLine` forwards
 * it as a `spend` frame the same as any other line; the API's spend handler already pins
 * `keySpendStart` from the first frame it sees for a run, so a baseline line arriving first fixes the
 * "first call under-reports cost" bug without any special-casing there. */
export interface SpendLogLine {
  keySpend?: number;
  keyMax?: number;
  modelGroup?: string;
  callId?: string;
  usage?: number;
  baseline?: boolean;
}

const SPEND_STRING_FIELD_MAX_LENGTH = 200;
const SPEND_USAGE_MAX = 1000;

/** OUTFITTER_SPEND_FILE lives in /tmp inside the sandbox image and is writable by the model's own
 * shell user (it can run arbitrary shell commands) -- a line in it is untrusted input, not just
 * possibly-malformed JSON. Validates shape and ranges before a parsed JSON value is treated as a
 * `SpendLogLine` anywhere (an up-frame to the control plane, this run's cost accounting): `usage`
 * must be a finite number in [0, 1000] (a single response "costing" more than $1000 is certainly
 * bogus); `keySpend`/`keyMax`, if present, must be finite non-negative numbers; `modelGroup`/`callId`,
 * if present, must be strings under 200 chars. Returns `undefined` for anything else -- including a
 * non-object value, extra/prototype-polluting keys (only the known fields are ever read), or a field
 * of the wrong shape -- so the caller can drop the line and log a WARNING instead of using it. */
export function validateSpendLine(value: unknown): SpendLogLine | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;

  const finiteNonNegative = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
  const shortString = (x: unknown): x is string => typeof x === "string" && x.length < SPEND_STRING_FIELD_MAX_LENGTH;

  if (v.usage !== undefined && !(finiteNonNegative(v.usage) && v.usage <= SPEND_USAGE_MAX)) return undefined;
  if (v.keySpend !== undefined && !finiteNonNegative(v.keySpend)) return undefined;
  if (v.keyMax !== undefined && !finiteNonNegative(v.keyMax)) return undefined;
  if (v.modelGroup !== undefined && !shortString(v.modelGroup)) return undefined;
  if (v.callId !== undefined && !shortString(v.callId)) return undefined;
  if (v.baseline !== undefined && typeof v.baseline !== "boolean") return undefined;

  return {
    usage: v.usage as number | undefined,
    keySpend: v.keySpend as number | undefined,
    keyMax: v.keyMax as number | undefined,
    modelGroup: v.modelGroup as string | undefined,
    callId: v.callId as string | undefined,
    baseline: v.baseline as boolean | undefined,
  };
}

// ---------- JSONL tailer ----------

export interface JsonlTailerOptions {
  /** Poll interval in ms. */
  intervalMs?: number;
  /** Called on each parsed line until it returns true once (e.g. the pi session file's header line,
   * `type: "session"`) -- that line is consumed but never passed to `onLine`. Omit when the file has
   * no header to skip (e.g. OUTFITTER_SPEND_FILE). */
  skipHeader?: (parsed: unknown) => boolean;
}

/** Alias kept for the pre-existing SessionTailer/SpendTailer constructor signature. */
export type SessionTailerOptions = JsonlTailerOptions;

/** Polls `file` for newly appended JSONL lines (poll-by-byte-offset) and emits each parsed line to
 * `onLine`. Handles the file not existing yet by retrying until it appears -- e.g. the spend
 * extension only creates OUTFITTER_SPEND_FILE on its first LiteLLM-backed response, which may be
 * well after pi starts, and the session file doesn't exist until importSession writes it. Shared by
 * `SessionTailer` (session file, skips the `type: "session"` header) and `SpendTailer`
 * (OUTFITTER_SPEND_FILE, no header) below -- previously two near-identical classes. */
export class JsonlTailer {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private sawHeader = false;
  private readonly intervalMs: number;
  private readonly skipHeader?: (parsed: unknown) => boolean;

  constructor(
    private readonly file: string,
    private readonly onLine: (parsed: unknown) => void,
    opts: JsonlTailerOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 250;
    this.skipHeader = opts.skipHeader;
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
      const st = await stat(this.file).catch(() => undefined);
      if (!st || st.size <= this.offset) return;
      const handle = await open(this.file, "r");
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
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (!this.sawHeader && this.skipHeader?.(parsed)) {
            this.sawHeader = true;
            continue;
          }
          this.onLine(parsed);
        }
      } finally {
        await handle.close();
      }
    } finally {
      this.reading = false;
    }
  }
}

/** Thin wrapper over JsonlTailer: OUTFITTER_SPEND_FILE has no header line to skip. Each parsed JSON
 * value is handed to `onLine` as-is (unvalidated) -- run.ts's `handleSpendLine` validates it with
 * `validateSpendLine` before using it, since the file is untrusted (see validateSpendLine's doc). */
export class SpendTailer extends JsonlTailer {
  constructor(file: string, onLine: (line: unknown) => void, opts: JsonlTailerOptions = {}) {
    super(file, onLine, opts);
  }
}

/** Thin wrapper over JsonlTailer: the pi session file's first line is a `type: "session"` header,
 * consumed but never emitted as an entry. */
export class SessionTailer extends JsonlTailer {
  constructor(sessionFile: string, onEntry: (entry: PiSessionEntry) => void, opts: JsonlTailerOptions = {}) {
    super(sessionFile, (parsed) => onEntry(parsed as PiSessionEntry), {
      ...opts,
      skipHeader: (parsed) => (parsed as { type?: unknown })?.type === "session",
    });
  }
}
