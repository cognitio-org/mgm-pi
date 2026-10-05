/**
 * The Local Host service's files (#381, local-host.md §4.4): its home and state directory, the
 * state file (no secrets, written whole and renamed), the run lock, the host id, and the log with
 * its rotation. Every log line goes through _shared/redact.ts.
 *
 * Built-ins and relative imports only (§4.3).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redact } from "../_shared/redact.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** `KERNAL_HOME_DIR` (`MGM_HOME_DIR` the legacy name), default `~/.kernal`. */
export function kernalHome(env: Env = process.env): string {
  return env.KERNAL_HOME_DIR?.trim() || env.MGM_HOME_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".kernal");
}

export const stateDir = (home: string) => join(home, "local-host");
export const statePath = (home: string) => join(stateDir(home), "state.json");
export const lockPath = (home: string) => join(stateDir(home), "run.lock");
export const hostIdPath = (home: string) => join(stateDir(home), "host-id");
export const logPath = (home: string) => join(home, "logs", "local-host.log");
/** Where launchd/systemd put the process's own stdout/stderr (crashes only). */
export const outLogPath = (home: string) => join(home, "logs", "local-host.out.log");

export function ensureStateDir(home: string): string {
  const dir = stateDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* someone else's directory: the files are 0600 anyway */ }
  return dir;
}

// ---------- state.json ----------

export interface ServiceState {
  version: 1;
  pid: number;
  startedAt: string;
  /** "node 22.19.0" | "bun 1.2.x" */
  runtime: string;
  hostId: string;
  signedIn: { email: string } | null;
  shareModels: { value: boolean; source: string };
  /** The tunnel's model server (ServerSnapshot.id), when one answers. */
  server: string | null;
  discoveryKey: string | null;
  models: { total: number; loaded: number };
  tunnel: {
    provider: string | null;
    managed: boolean;
    state: "up" | "down" | "stopped" | "off";
    url: string | null;
    publicUrl: string | null;
    since: string;
    reason: string | null;
  };
  heartbeat: {
    lastAt: string | null;
    ok: boolean | null;
    status: string | null;
    nextAt: string | null;
    routerModels: string[];
    problems: string[];
    error: string | null;
  };
  updatedAt: string;
}

/** Written whole then renamed, 0600, so `kernal local status` never reads half a file. */
export function writeState(home: string, state: ServiceState): void {
  ensureStateDir(home);
  writeWhole(statePath(home), JSON.stringify(state, null, 2) + "\n");
}

export function readState(home: string): ServiceState | undefined {
  try {
    const j = JSON.parse(readFileSync(statePath(home), "utf8"));
    return j && typeof j === "object" && j.version === 1 ? (j as ServiceState) : undefined;
  } catch {
    return undefined;
  }
}

function writeWhole(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

// ---------- run.lock ----------

export const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // alive, someone else's
  }
};

export function readLockPid(home: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lockPath(home), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export type Lock = { ok: true; release(): void } | { ok: false; pid: number };

/**
 * Takes run.lock for `pid`. Held by a live process: `{ ok: false, pid }` (a second `run` exits 0,
 * "already running"). A lock whose pid is gone is taken over.
 */
export function acquireLock(home: string, pid: number = process.pid, alive: (pid: number) => boolean = pidAlive): Lock {
  ensureStateDir(home);
  const file = lockPath(home);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, `${pid}\n`, { flag: "wx", mode: 0o600 });
      return { ok: true, release: () => releaseLock(home, pid) };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
    const holder = readLockPid(home);
    if (holder !== undefined && holder !== pid && alive(holder)) return { ok: false, pid: holder };
    try { rmSync(file, { force: true }); } catch {}
  }
  return { ok: false, pid: readLockPid(home) ?? 0 };
}

/** Removes run.lock only while it is still `pid`'s. */
export function releaseLock(home: string, pid: number = process.pid): void {
  if (readLockPid(home) === pid) {
    try { rmSync(lockPath(home), { force: true }); } catch {}
  }
}

// ---------- host id and name ----------

export type MachineIdDeps = {
  platform?: NodeJS.Platform;
  /** Runs ioreg (macOS); tests pass a fake. */
  run?: (cmd: string, args: string[]) => { status: number | null; stdout: string };
  readFile?: (path: string) => string;
};

const realRun = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
  return { status: r.status, stdout: r.stdout ?? "" };
};

/** IOPlatformUUID on macOS, /etc/machine-id (or dbus's) on Linux; undefined when neither is there. */
export function machineId(deps: MachineIdDeps = {}): string | undefined {
  const platform = deps.platform ?? process.platform;
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  if (platform === "darwin") {
    const r = (deps.run ?? realRun)("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const id = r.status === 0 ? /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(r.stdout)?.[1] : undefined;
    return id?.trim() || undefined;
  }
  if (platform === "linux") {
    for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const id = read(p).trim();
        if (id) return id;
      } catch {}
    }
  }
  return undefined;
}

/** `h_` + the first 24 hex of sha256("kernal-local-host:" + machine id) (§4.4). */
export function hostIdFrom(machine: string): string {
  return "h_" + createHash("sha256").update(`kernal-local-host:${machine}`).digest("hex").slice(0, 24);
}

/** This machine's host id: from its machine id, else a random one kept in `host-id`. */
export function resolveHostId(home: string, deps: MachineIdDeps = {}): string {
  const m = machineId(deps);
  if (m) return hostIdFrom(m);
  const file = hostIdPath(home);
  try {
    const kept = readFileSync(file, "utf8").trim();
    if (/^h_[0-9a-f]{24}$/.test(kept)) return kept;
  } catch {}
  const id = hostIdFrom(randomBytes(32).toString("hex"));
  ensureStateDir(home);
  writeWhole(file, `${id}\n`);
  return id;
}

/** os.hostname() without `.local`, at most 64 printable characters; "host" when nothing is left. */
export function hostNameOf(raw: string): string {
  const name = raw.trim().replace(/\.local$/i, "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64).trim();
  return name || "host";
}

// ---------- the log ----------

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;

export type Level = "info" | "warn" | "error";
export type Logger = (level: Level, message: string) => void;

/**
 * One line per event, `<iso> <level> <message>`, redacted. Rotated before a line would take the
 * file past `maxBytes`: `.2` → `.3`, `.1` → `.2`, the file → `.1`, keeping `keep`. Never throws.
 */
export function fileLogger(file: string, opts: { maxBytes?: number; keep?: number; now?: () => number } = {}): Logger {
  const max = opts.maxBytes ?? LOG_MAX_BYTES;
  const keep = opts.keep ?? LOG_KEEP;
  const now = opts.now ?? Date.now;
  let ready = false;
  return (level, message) => {
    try {
      if (!ready) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); ready = true; }
      const line = `${new Date(now()).toISOString()} ${level} ${redact(message).replace(/[\r\n]+/g, " ")}\n`;
      let size = 0;
      try { size = statSync(file).size; } catch {}
      if (size > 0 && size + Buffer.byteLength(line) > max) rotate(file, keep);
      appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // A full disk must not take the service down.
    }
  };
}

export function rotate(file: string, keep: number): void {
  try { rmSync(`${file}.${keep}`, { force: true }); } catch {}
  for (let i = keep - 1; i >= 1; i--) {
    try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {}
  }
  try { renameSync(file, `${file}.1`); } catch {}
}
