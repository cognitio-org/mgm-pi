/**
 * Background jobs for kernal-background (#121): commands that outlive the turn.
 *
 * Every job runs in its own session and process group (spawn `detached`, i.e. setsid), under a small
 * bash wrapper that also starts a watchdog in the same group. The watchdog polls pi's pid and kills
 * the whole group when pi is gone (SIGTERM, then SIGKILL), so a job never outlives the agent even
 * when pi dies by SIGKILL and none of our cleanup runs. Everything that ends a job -- the model, the
 * person, a deadline, session shutdown -- goes through one path: SIGTERM to the group, SIGKILL after
 * a grace period.
 *
 * A job ends when its command exits. Whatever it left running in its group (a server it put in the
 * background with `&`, a daemonized child) is stopped then and reported, rather than left behind
 * unmanaged: grandchildren die with the group. "Running" is the command's own process, which a
 * quiet server still has; a log line arriving is never the signal. A process that calls setsid or
 * double-forks leaves the group, and nothing here can follow it.
 *
 * stdout and stderr share one pipe (in order) into a log file that rotates at half of
 * `logCapBytes`, keeping one previous file, so a chatty server can't fill the disk. The model reads a
 * tail, never a stream. stdin is a pipe pi holds open and never writes to: some watchers (esbuild
 * --watch) exit when stdin reaches EOF, and a command that prompts waits instead of failing.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

export type JobKind = "server" | "batch";
/** exited: the command exited 0. failed: non-zero or killed by a signal it didn't get from us.
 * timed_out: its deadline passed. killed: the model or the person stopped it. reaped: stopped
 * because the session ended. */
export type JobStatus = "running" | "exited" | "failed" | "timed_out" | "killed" | "reaped";

export interface Job {
  id: string;
  name: string;
  command: string;
  kind: JobKind;
  cwd: string;
  /** The wrapper's pid, which is also the process group id (setsid). */
  pid: number;
  startedAt: number;
  endedAt?: number;
  status: JobStatus;
  exitCode?: number;
  signal?: string;
  /** Processes the command left in its group, stopped when it exited. */
  leftovers?: boolean;
  /** When the job is killed as timed out (batch deadline, or a server's hard cap). */
  deadlineAt: number;
  logPath: string;
}

export interface JobManagerOptions {
  /** Directory for the logs; created (mode 0700) on first use. */
  dir: string;
  /** Called exactly once when a job reaches a terminal state, unless it ended through kill() with
   * `quiet` or through reapAll() (the caller reports those itself). */
  onEnd?: (job: Job) => void;
  /** pid the watchdog follows (default: this process). */
  parentPid?: number;
  /** SIGTERM-to-SIGKILL grace (default 3 s). */
  graceMs?: number;
  /** Total log bytes kept per job, across the current and the previous file (default 10 MB). */
  logCapBytes?: number;
  /** How often the watchdog checks the parent (default 2 s). */
  watchdogIntervalSeconds?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface StartOptions {
  command: string;
  kind: JobKind;
  cwd: string;
  name?: string;
  /** Seconds until the job is killed as timed out. */
  timeoutSeconds: number;
}

/** setTimeout's ceiling (~24.8 days); a longer delay fires at once. */
export const MAX_TIMEOUT_SECONDS = Math.floor(2 ** 31 / 1000) - 1;

// The wrapper runs as `bash -c WRAPPER` in a new session, with stderr folded into stdout. The
// watchdog sleeps in the background so its TERM trap can fire at once; the trap waits for that
// sleep, so no orphan is left for a PID 1 that never reaps (agentd in a Drive). Before signalling the
// group, the watchdog ignores TERM itself, or its own trap would end it before the SIGKILL.
const WRAPPER = `
exec 2>&1
( trap 'kill "$s" 2>/dev/null; wait "$s" 2>/dev/null; exit 0' TERM
  while kill -0 "$KERNAL_BG_PARENT" 2>/dev/null; do sleep "$KERNAL_BG_WATCH" & s=$!; wait "$s"; done
  trap '' TERM
  kill -TERM 0 2>/dev/null; sleep "$KERNAL_BG_GRACE"; kill -KILL 0 2>/dev/null ) </dev/null >/dev/null 2>&1 &
w=$!
cmd=$KERNAL_BG_CMD
unset KERNAL_BG_CMD KERNAL_BG_PARENT KERNAL_BG_WATCH KERNAL_BG_GRACE
bash -c "$cmd"
c=$?
kill -TERM "$w" 2>/dev/null
wait "$w" 2>/dev/null
exit "$c"
`;

interface Running {
  child: ChildProcess;
  timer: NodeJS.Timeout;
  /** Set when we started stopping it, so the exit handler knows why it ended. */
  ending?: { status: JobStatus; quiet: boolean };
  log: RotatingLog;
  done: Promise<Job>;
  /** Resolves when the output pipe has closed (all output read). */
  outputClosed: Promise<void>;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly running = new Map<string, Running>();
  private seq = 0;
  private readonly graceMs: number;
  private readonly logCapBytes: number;
  private readonly now: () => number;
  private readonly opts: JobManagerOptions;

  constructor(opts: JobManagerOptions) {
    this.opts = opts;
    this.graceMs = opts.graceMs ?? 3000;
    this.logCapBytes = opts.logCapBytes ?? 10 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
  }

  start(o: StartOptions): Job {
    const command = o.command.trim();
    if (!command) throw new Error("command is empty");
    if (!existsSync(o.cwd)) throw new Error(`cwd does not exist: ${o.cwd}`);
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    const id = `bg${this.seq + 1}`;
    const logPath = join(this.opts.dir, `${id}.log`);
    const graceSeconds = Math.max(1, Math.ceil(this.graceMs / 1000));
    const timeoutSeconds = Math.min(Math.max(1, o.timeoutSeconds), MAX_TIMEOUT_SECONDS);
    let spawnError: Error | undefined;
    const child = spawn("bash", ["-c", WRAPPER], {
      cwd: o.cwd,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...(this.opts.env ?? process.env),
        KERNAL_BG_CMD: command,
        KERNAL_BG_PARENT: String(this.opts.parentPid ?? process.pid),
        KERNAL_BG_WATCH: String(this.opts.watchdogIntervalSeconds ?? 2),
        KERNAL_BG_GRACE: String(graceSeconds),
      },
    });
    // Attached before anything else: a spawn failure (no bash, EAGAIN, EMFILE) is emitted on the next
    // tick, and with no listener it would be an uncaught exception that takes pi down.
    child.on("error", (err) => { spawnError = err; });
    if (child.pid === undefined) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      throw new Error("could not start bash");
    }
    this.seq += 1;
    const startedAt = this.now();
    const job: Job = {
      id, name: o.name?.trim() || firstWords(command), command, kind: o.kind, cwd: o.cwd,
      pid: child.pid, startedAt, status: "running", deadlineAt: startedAt + timeoutSeconds * 1000, logPath,
    };
    const log = new RotatingLog(logPath, this.logCapBytes);
    child.stdout!.on("data", (b: Buffer) => log.write(b));
    const outputClosed = new Promise<void>((r) => {
      child.stdout!.once("close", () => r());
      child.stdout!.once("error", () => r());
    });
    // Held open, never written: a command reading stdin waits rather than seeing EOF.
    child.stdin!.on("error", () => { /* the job closed its end */ });
    const timer = setTimeout(() => void this.stop(id, "timed_out", false), timeoutSeconds * 1000);
    timer.unref();
    let resolveDone!: (j: Job) => void;
    const done = new Promise<Job>((r) => { resolveDone = r; });
    const run: Running = { child, timer, log, done, outputClosed };
    this.jobs.set(id, job);
    this.running.set(id, run);
    child.on("exit", (code, signal) => {
      if (spawnError) log.write(Buffer.from(`\n[kernal-background] ${spawnError.message}\n`));
      void this.finish(id, code, signal).then(resolveDone, () => resolveDone({ ...job }));
    });
    // A job must never hold pi open by itself.
    child.unref();
    (child.stdout as any)?.unref?.();
    (child.stdin as any)?.unref?.();
    return { ...job };
  }

  list(): Job[] {
    return [...this.jobs.values()].map((j) => ({ ...j }));
  }

  get(id: string): Job | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j } : undefined;
  }

  /** Stops a running job (the group: SIGTERM, then SIGKILL) and resolves once it has ended. With
   * `quiet`, onEnd isn't called: the caller reports the result itself. */
  kill(id: string, quiet = true): Promise<Job> {
    return this.stop(id, "killed", quiet);
  }

  /** The last `lines` lines of a job's output, optionally only those containing `grep`. */
  tail(id: string, lines = 40, grep?: string): string {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no job ${id}`);
    const parts: Buffer[] = [];
    for (const p of [`${job.logPath}.1`, job.logPath]) {
      try { parts.push(readFileSync(p)); } catch { /* not there (yet) */ }
    }
    // Decoded as one buffer, so a character split across the rotation point stays whole.
    let all = Buffer.concat(parts).toString("utf8").split("\n");
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    if (grep) all = all.filter((l) => l.includes(grep));
    return all.slice(-Math.max(1, lines)).join("\n");
  }

  /** Stops every running job and waits for them (session shutdown). No onEnd calls. */
  async reapAll(): Promise<Job[]> {
    const ids = [...this.running.keys()];
    return Promise.all(ids.map((id) => this.stop(id, "reaped", true)));
  }

  /** Synchronous last resort for process exit: SIGKILL every running group. */
  killAllNow(): void {
    for (const [id, run] of this.running) {
      const job = this.jobs.get(id)!;
      run.ending ??= { status: "reaped", quiet: true };
      signalGroup(job.pid, "SIGKILL");
    }
  }

  /** Removes the log directory (after reapAll). */
  cleanup(): void {
    rmSync(this.opts.dir, { recursive: true, force: true });
  }

  private stop(id: string, status: JobStatus, quiet: boolean): Promise<Job> {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new Error(`no job ${id}`));
    const run = this.running.get(id);
    if (!run) return Promise.resolve({ ...job });
    if (!run.ending) {
      run.ending = { status, quiet };
      signalGroup(job.pid, "SIGTERM");
      const k = setTimeout(() => signalGroup(job.pid, "SIGKILL"), this.graceMs);
      k.unref();
      void run.done.then(() => clearTimeout(k));
    }
    return run.done;
  }

  private async finish(id: string, code: number | null, signal: NodeJS.Signals | null): Promise<Job> {
    const job = this.jobs.get(id)!;
    const run = this.running.get(id)!;
    clearTimeout(run.timer);
    // Decided now, before any await: a kill arriving while leftovers are being stopped must not turn
    // a job that already exited on its own into "killed".
    const ending = run.ending;
    try {
      // Whatever the command left in its group goes too. The wrapper already stopped its watchdog,
      // so a live process still in the group here is the command's own leftover.
      if (groupHasLiveMembers(job.pid)) {
        if (!ending) job.leftovers = true;
        signalGroup(job.pid, "SIGTERM");
        const until = this.now() + this.graceMs;
        while (groupHasLiveMembers(job.pid) && this.now() < until) await sleep(50);
        if (groupHasLiveMembers(job.pid)) signalGroup(job.pid, "SIGKILL");
      }
      // Read what's left in the pipe before closing the log ('exit' can come before the last output).
      await Promise.race([run.outputClosed, sleep(1000)]);
    } finally {
      run.log.close();
      run.child.stdin?.destroy();
      job.endedAt = this.now();
      if (code !== null) job.exitCode = code;
      if (signal) job.signal = signal;
      job.status = ending?.status ?? (code === 0 ? "exited" : "failed");
      this.running.delete(id);
    }
    if (!ending?.quiet) {
      try { this.opts.onEnd?.({ ...job }); } catch { /* a reporting failure must not wedge the manager */ }
    }
    return { ...job };
  }
}

/** A one-line summary of a job for lists and notices. */
export function describeJob(job: Job, now = Date.now()): string {
  const took = formatDuration((job.endedAt ?? now) - job.startedAt);
  const what = `${job.id} ${job.kind} "${job.name}"`;
  switch (job.status) {
    case "running": return `${what}: running for ${took} (pid ${job.pid})`;
    case "exited": return `${what}: exited 0 after ${took}`;
    case "failed": return `${what}: failed after ${took} (${job.exitCode !== undefined ? `exit ${job.exitCode}` : `signal ${job.signal ?? "?"}`})`;
    case "timed_out": return `${what}: timed out after ${took} and was stopped`;
    case "killed": return `${what}: stopped after ${took}`;
    case "reaped": return `${what}: stopped with the session after ${took}`;
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function firstWords(command: string): string {
  const one = command.replace(/\s+/g, " ");
  return one.length > 40 ? `${one.slice(0, 39)}…` : one;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); } catch { /* already gone */ }
}

/** Whether any process in the group is still running. On Linux, zombies don't count: kill -0
 * succeeds on a group of zombies, and in a Drive PID 1 (agentd) never reaps processes it didn't
 * start, so a stopped leftover would otherwise look alive forever. */
export function groupHasLiveMembers(pgid: number): boolean {
  try { process.kill(-pgid, 0); } catch (err: any) { if (err?.code !== "EPERM") return false; }
  if (process.platform !== "linux") return true;
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return true; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let stat: string;
    try { stat = readFileSync(`/proc/${e}/stat`, "utf8"); } catch { continue; }
    // "pid (comm) state ppid pgrp ...": comm may contain spaces and parentheses.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(rest[2]) === pgid && rest[0] !== "Z" && rest[0] !== "X") return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Appends to `path`; at half the cap, moves it to `path.1` (replacing the older one) and starts
 * over, so at most `capBytes` stay on disk. A disk or file error stops logging for that job; it
 * never throws into the pipe's event handler (which would take pi down). */
class RotatingLog {
  private fd = -1;
  private size = 0;
  private closed = false;
  private readonly path: string;
  private readonly half: number;
  constructor(path: string, capBytes: number) {
    this.path = path;
    this.half = Math.max(1, Math.floor(capBytes / 2));
    try {
      this.fd = openSync(path, "a", 0o600);
      this.size = statSync(path).size;
    } catch {
      this.closed = true;
    }
  }
  write(b: Buffer): void {
    let rest = b;
    try {
      while (!this.closed && rest.length > 0) {
        if (this.size >= this.half) this.rotate();
        const n = Math.min(rest.length, this.half - this.size);
        writeSync(this.fd, rest.subarray(0, n));
        this.size += n;
        rest = rest.subarray(n);
      }
    } catch {
      this.close();
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const fd = this.fd;
    this.fd = -1;
    try { if (fd >= 0) closeSync(fd); } catch { /* already closed */ }
  }
  private rotate(): void {
    const fd = this.fd;
    this.fd = -1; // never keep a number the OS may hand to another file
    closeSync(fd);
    renameSync(this.path, `${this.path}.1`);
    this.fd = openSync(this.path, "a", 0o600);
    this.size = 0;
  }
}
