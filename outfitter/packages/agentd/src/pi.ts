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

// ---------- pi's inherited environment (allowlist) ----------

/** Exact env var names pi may inherit from agentd's own process env. Locale/terminal/home basics
 * plus PATH -- everything the model's shell tool needs to behave like a normal shell. HOME/USER/
 * LOGNAME are normally overwritten by run.ts's `userEnv` (the `agent` user's own home) and are
 * listed here only so a non-root agentd outside the sandbox image still gets sane values. */
export const PI_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TZ",
  "LANG",
  "LANGUAGE",
  // Passed through when set, as before -- but note the sandbox image deliberately does not set it:
  // pi has to fall back to /tmp to find the jiti extension cache the image prewarms there
  // (image/prewarm-extensions.sh, docs/reports/startup-trim.md).
  "TMPDIR",
]);

/** Prefixes pi may inherit wholesale:
 *  - `LC_*`   locale categories (LC_ALL, LC_CTYPE, ...).
 *  - `PI_*`   pi's own configuration, set by the image (PI_CODING_AGENT_DIR, PI_OFFLINE,
 *             PI_SKIP_VERSION_CHECK, PI_BIN, PI_RUN_AS_USER).
 *  - `KERNAL_*` / `MGM_*` kernal's extensions (KERNAL_NO_CODEBASE_INDEX in the image;
 *             KERNAL_SUBAGENTS_PKG/MGM_SUBAGENTS_PKG on a laptop -- MGM_* is kernal's permanent
 *             legacy alias, see kernal/.pi/extensions).
 *  - `LITELLM_*` the LiteLLM base URL and key. run.ts already hands pi the *per-run* key and base
 *             URL explicitly (secretEnv), and the sandbox image/job sets no LITELLM_* of its own,
 *             so this changes nothing in the cloud; it keeps local dev working, where agentd is
 *             spawned with the developer's own env (provider-local/src/in-process.ts) and
 *             outfitter-spend.ts falls back to LITELLM_API_KEY.
 * Nothing here is a credential the sandbox is meant to withhold from the model. */
export const PI_ENV_ALLOWED_PREFIXES: readonly string[] = ["LC_", "PI_", "KERNAL_", "MGM_", "LITELLM_"];

/** Never handed to pi, whatever else says otherwise (an allowed prefix, or the passthrough escape
 * hatch below). RUN_TOKEN + RUN_ID + OUTFITTER_API together are a complete takeover kit: with them
 * the model can mint its own agent identity token from the GCE metadata server, open its own
 * `wss://<api>/agent/ws?run=<id>` and receive the run.spec -- i.e. `secrets.githubToken` and
 * `secrets.litellmKey` -- and displace agentd on the run's down-channel. OUTFITTER_DEV_TOKEN is the
 * same for a dev deployment. NODE_OPTIONS would let anything that can set agentd's env inject code
 * into the pi process (already denylisted for guru.env, see guru.ts). */
export const PI_ENV_NEVER: ReadonlySet<string> = new Set([
  "RUN_TOKEN",
  "RUN_ID",
  "OUTFITTER_API",
  "OUTFITTER_DEV_TOKEN",
  "NODE_OPTIONS",
  // A user Dongle. The capture tool uses agentd's own socket credential, never this (chrome
  // companion §13). An operator passthrough cannot put it back.
  "OUTFITTER_TOKEN",
]);

/** Operator escape hatch: a comma/whitespace-separated list of extra env var names to let through
 * (e.g. `HTTPS_PROXY,NO_PROXY,NODE_EXTRA_CA_CERTS` behind a corporate proxy). Read from agentd's
 * own env, which only the deployment sets -- never from the run.spec, and never from anything the
 * model controls. PI_ENV_NEVER still applies. */
export const PI_ENV_PASSTHROUGH_VAR = "OUTFITTER_PI_ENV_PASSTHROUGH";

function parsePassthrough(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
}

/**
 * The environment pi inherits from agentd, built from an explicit **allowlist** rather than by
 * copying agentd's own env minus a few known-bad keys.
 *
 * pi runs as the unprivileged `agent` user precisely so the model -- which can run arbitrary shell
 * commands through pi -- cannot reach agentd's credentials (finding #1,
 * docs/reports/security-review-pr1.md). That split is worthless if agentd hands those credentials
 * to pi in its environment, which is exactly what the previous GIT_CONFIG_*-only denylist did:
 * RUN_TOKEN, RUN_ID and OUTFITTER_API (the Cloud Run Job's own per-execution env, see
 * providers/cloudrun.ts) were all copied straight through, and `printenv` inside the sandbox was
 * enough to take the run over and read its GitHub token. A denylist also fails open by
 * construction: every new env var agentd gains is exposed to the model until someone remembers to
 * add it. An allowlist fails closed.
 *
 * Everything pi genuinely needs *per run* -- the LiteLLM key and base URL, the session id, the
 * spend file -- is passed explicitly by run.ts as the `env` overlay on top of this, not inherited.
 */
export function baseEnvForPi(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const passthrough = parsePassthrough(source[PI_ENV_PASSTHROUGH_VAR]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (PI_ENV_NEVER.has(key)) continue;
    const allowed =
      PI_ENV_ALLOWLIST.has(key) ||
      passthrough.has(key) ||
      PI_ENV_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (!allowed) continue;
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
  /** Byte offset to start reading from. Everything before it (header included) is treated as
   * already read -- e.g. the transcript a run restored, which the api already has. Default 0. */
  startOffset?: number;
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
  /** The read in progress, if any (see `poll`). */
  private inFlight: Promise<void> | undefined;
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
    this.offset = opts.startOffset ?? 0;
    this.sawHeader = this.offset > 0;
  }

  start(): void {
    if (this.timer) return;
    // A failed read (the file gone between stat and open, EMFILE) is retried by the next tick;
    // never an unhandled rejection.
    this.timer = setInterval(() => {
      // A tick that lands mid-read skips; it doesn't queue behind it.
      if (!this.inFlight) this.poll().catch(() => {});
    }, this.intervalMs);
    this.poll().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads and emits everything currently available; used by tests, by the final drain before
   * checkpointing so no trailing entry is lost, and by agentd's flush before forwarding
   * `agent_settled`. Resolves only once everything written before the call has been emitted: a read
   * already in progress may have stat()ed the file before the latest append, so a poll that finds
   * one waits for it and then reads again, instead of returning early as it used to. */
  async poll(): Promise<void> {
    while (this.inFlight) await this.inFlight.catch(() => {});
    const read = this.readAvailable().finally(() => {
      if (this.inFlight === read) this.inFlight = undefined;
    });
    this.inFlight = read;
    return read;
  }

  private async readAvailable(): Promise<void> {
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
