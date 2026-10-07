/**
 * The Local Host service units (#381, local-host.md §4.3, §4.5): the macOS LaunchAgent and the
 * systemd user unit that run `kernal local run`, installing and removing them through an injectable
 * runner (tests never call launchctl or systemctl), reading their state, and choosing the runtime
 * the loop runs under.
 *
 * Built-ins and relative imports only (§4.3).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { outLogPath } from "./state.ts";

export const LAUNCHD_LABEL = "one.kernal.local-host";
export const SYSTEMD_UNIT = "kernal-local-host.service";
/** The oldest Node whose type stripping is on by default. */
export const NODE_MIN = [22, 18] as const;

export type Runner = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

export const realRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
};

// ---------- runtime (§4.3) ----------

/** `v22.19.0` / `22.19.0` → whether it is at least NODE_MIN. */
export function nodeQualifies(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > NODE_MIN[0] || (major === NODE_MIN[0] && minor >= NODE_MIN[1]);
}

export type Runtime =
  | { kind: "node"; path: string; version: string }
  | { kind: "bun"; path: string };

export interface RuntimeDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** The Kernal root (the bundle or the checkout's kernal/). */
  root: string;
  runner?: Runner;
  exists?: (path: string) => boolean;
}

/**
 * What the service will run the loop with, as bin/kernal's exec_local_runtime chooses it:
 * KERNAL_LOCAL_NODE, else `node` on PATH, when its version qualifies; else the bundle's pi binary
 * (as Bun, BUN_BE_BUN=1). Undefined: neither, and `enable` refuses.
 */
export function chooseRuntime(d: RuntimeDeps): Runtime | undefined {
  const run = d.runner ?? realRunner;
  const exists = d.exists ?? existsSync;
  const candidates: string[] = [];
  const recorded = d.env.KERNAL_LOCAL_NODE?.trim();
  if (recorded) candidates.push(recorded);
  const onPath = run("/bin/sh", ["-c", "command -v node"]);
  const p = onPath.status === 0 ? onPath.stdout.trim().split("\n")[0] : "";
  if (p && p.startsWith("/")) candidates.push(p);
  for (const path of candidates) {
    if (!exists(path)) continue;
    const v = run(path, ["--version"]);
    if (v.status === 0 && nodeQualifies(v.stdout)) return { kind: "node", path, version: v.stdout.trim().replace(/^v/, "") };
  }
  const pi = join(d.root, "pi", "pi");
  if (exists(pi)) return { kind: "bun", path: pi };
  return undefined;
}

/** "node 22.19.0" or "bun 1.2.x", for the state file. */
export function currentRuntime(): string {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? `bun ${bun}` : `node ${process.versions.node}`;
}

/**
 * The stable launcher the unit runs (§4.5): `<home>/current/bin/kernal` for an installed bundle
 * (survives `kernal update`, which prunes old bundles), else the checkout's own `bin/kernal`.
 */
export function stableLauncher(root: string, home: string, exists: (p: string) => boolean = existsSync): string {
  const current = join(home, "current", "bin", "kernal");
  if (exists(join(root, "VERSION")) && exists(current)) return current;
  return join(root, "bin", "kernal");
}

// ---------- unit text ----------

export interface UnitOptions {
  /** Absolute path of bin/kernal (stableLauncher). */
  kernal: string;
  /** The Kernal home, absolute (KERNAL_HOME_DIR). */
  homeDir: string;
  /** Absolute node path, when enable found one that qualifies. */
  node?: string;
  profile?: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function pathFor(node: string | undefined, rest: string): string {
  return node ? `${dirname(node)}:${rest}` : rest;
}

export function launchdPlist(o: UnitOptions): string {
  const out = outLogPath(o.homeDir);
  const env: Array<[string, string]> = [
    ["KERNAL_HOME_DIR", o.homeDir],
    ["PATH", pathFor(o.node, "/usr/bin:/bin:/usr/sbin:/sbin")],
  ];
  if (o.node) env.push(["KERNAL_LOCAL_NODE", o.node]);
  if (o.profile) env.push(["KERNAL_PROFILE", o.profile]);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array><string>/bin/bash</string><string>${xml(o.kernal)}</string><string>local</string><string>run</string></array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...env.map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`),
    `  </dict>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key><true/>`,
    `  <key>ThrottleInterval</key><integer>30</integer>`,
    `  <key>ProcessType</key><string>Background</string>`,
    `  <key>StandardOutPath</key><string>${xml(out)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(out)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** A systemd value: as is when plain, else double-quoted with `\` and `"` escaped. */
function sd(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function systemdUnit(o: UnitOptions): string {
  const env = [
    `Environment=${sd(`KERNAL_HOME_DIR=${o.homeDir}`)}`,
    ...(o.node ? [`Environment=${sd(`KERNAL_LOCAL_NODE=${o.node}`)}`] : []),
    ...(o.profile ? [`Environment=${sd(`KERNAL_PROFILE=${o.profile}`)}`] : []),
    `Environment=${sd(`PATH=${pathFor(o.node, "/usr/local/bin:/usr/bin:/bin")}`)}`,
  ];
  return [
    `[Unit]`,
    `Description=Kernal Local Host (share this machine's local models)`,
    `After=network-online.target`,
    ``,
    `[Service]`,
    `ExecStart=/bin/bash ${sd(o.kernal)} local run`,
    `Restart=always`,
    `RestartSec=30`,
    ...env,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

// ---------- install, remove, status ----------

export interface ServiceDeps {
  platform: NodeJS.Platform;
  /** The user's home directory (the unit lives under it). */
  userHome: string;
  uid: number;
  runner: Runner;
  writeFile?: (path: string, text: string) => void;
  removeFile?: (path: string) => void;
  exists?: (path: string) => boolean;
}

export function unitPath(platform: NodeJS.Platform, userHome: string): string | undefined {
  if (platform === "darwin") return join(userHome, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  if (platform === "linux") return join(userHome, ".config", "systemd", "user", SYSTEMD_UNIT);
  return undefined;
}

const defaultWrite = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o644 });
};
const defaultRemove = (path: string) => rmSync(path, { force: true });

export type Result = { ok: true; unit: string } | { ok: false; error: string };

const tail = (r: { stdout: string; stderr: string; status: number | null }) => (r.stderr || r.stdout).trim().split("\n").slice(-1)[0] || `exit ${r.status}`;

/** Writes the unit and (re)starts it. Idempotent: a second call rewrites the unit and restarts. */
export function installService(o: UnitOptions, d: ServiceDeps): Result {
  const unit = unitPath(d.platform, d.userHome);
  if (!unit) return { ok: false, error: `kernal local runs on macOS and Linux, not ${d.platform}` };
  const write = d.writeFile ?? defaultWrite;
  // Where launchd/systemd write stdout/stderr must exist before the job starts.
  try { mkdirSync(dirname(outLogPath(o.homeDir)), { recursive: true, mode: 0o700 }); } catch {}
  if (d.platform === "darwin") {
    write(unit, launchdPlist(o));
    d.runner("launchctl", ["bootout", `gui/${d.uid}/${LAUNCHD_LABEL}`]); // not loaded yet: fine
    const r = d.runner("launchctl", ["bootstrap", `gui/${d.uid}`, unit]);
    if (r.status !== 0) return { ok: false, error: `launchctl bootstrap failed: ${tail(r)}` };
    return { ok: true, unit };
  }
  // A rewritten unit only takes effect on a restart; a new one is started by enable --now.
  const existed = (d.exists ?? existsSync)(unit);
  write(unit, systemdUnit(o));
  const steps = [["--user", "daemon-reload"], ["--user", "enable", "--now", SYSTEMD_UNIT], ...(existed ? [["--user", "restart", SYSTEMD_UNIT]] : [])];
  for (const args of steps) {
    const r = d.runner("systemctl", args);
    if (r.status !== 0) return { ok: false, error: `systemctl ${args.slice(1).join(" ")} failed: ${tail(r)}` };
  }
  return { ok: true, unit };
}

/** Stops the service and removes the unit. Nothing installed is success. */
export function removeService(d: ServiceDeps): Result {
  const unit = unitPath(d.platform, d.userHome);
  if (!unit) return { ok: false, error: `kernal local runs on macOS and Linux, not ${d.platform}` };
  const remove = d.removeFile ?? defaultRemove;
  if (d.platform === "darwin") {
    d.runner("launchctl", ["bootout", `gui/${d.uid}/${LAUNCHD_LABEL}`]);
    remove(unit);
    return { ok: true, unit };
  }
  d.runner("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
  remove(unit);
  d.runner("systemctl", ["--user", "daemon-reload"]);
  return { ok: true, unit };
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid: number | null;
  unit: string | null;
}

/** The unit's state, from launchctl print / systemctl show. No network. */
export function serviceStatus(d: ServiceDeps): ServiceStatus {
  const unit = unitPath(d.platform, d.userHome);
  if (!unit) return { installed: false, running: false, pid: null, unit: null };
  const installed = (d.exists ?? existsSync)(unit);
  if (d.platform === "darwin") {
    const r = d.runner("launchctl", ["print", `gui/${d.uid}/${LAUNCHD_LABEL}`]);
    if (r.status !== 0) return { installed, running: false, pid: null, unit };
    const state = /^\s*state = (\S+)/m.exec(r.stdout)?.[1];
    const pid = Number(/^\s*pid = (\d+)/m.exec(r.stdout)?.[1]);
    return { installed, running: state === "running", pid: Number.isInteger(pid) && pid > 0 ? pid : null, unit };
  }
  const r = d.runner("systemctl", ["--user", "show", SYSTEMD_UNIT, "--property=ActiveState,MainPID"]);
  if (r.status !== 0) return { installed, running: false, pid: null, unit };
  const active = /^ActiveState=(\S+)/m.exec(r.stdout)?.[1];
  const pid = Number(/^MainPID=(\d+)/m.exec(r.stdout)?.[1]);
  return { installed, running: active === "active", pid: Number.isInteger(pid) && pid > 0 ? pid : null, unit };
}
