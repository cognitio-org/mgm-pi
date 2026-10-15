/**
 * `kernal local enable | disable | status | run` (#381, local-host.md §4.2, §4.7), as a function so
 * tests drive it with a fake runner, a temporary home and fake loop dependencies instead of
 * launchctl, systemctl, ngrok or Outfitter. Exit codes: 0 done, 1 failed, 2 usage.
 *
 * Built-ins and relative imports only (§4.3).
 */
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { reresolve, refreshConfig, webOrigin } from "../_shared/central-config.ts";
import { kernalVersion } from "../_shared/version.ts";
import { defaultTargets, discoverLocalModels, serverRoot } from "../_shared/local-discovery.ts";
import { getAccessToken, loginState, outfitterApi } from "../_shared/outfitter-session.ts";
import { installNgrok, ngrokProvider, type InstallResult } from "../_shared/tunnel/ngrok.ts";
import { openTunnel, parseTunnelChoice, type ProviderStatus } from "../_shared/tunnel/tunnel.ts";
import { LocalHostLoop, serve, type LoopDeps, type SignalName } from "./loop.ts";
import {
  chooseRuntime, currentRuntime, installService, realRunner, removeService, serviceStatus, stableLauncher, unitPath,
  type Runner, type ServiceDeps, type ServiceStatus,
} from "./service.ts";
import {
  acquireLock, fileLogger, hostNameOf, kernalHome, logPath, pidAlive, readLockPid, readState, resolveHostId, writeState,
  type Logger, type ServiceState,
} from "./state.ts";

export const USAGE = "Usage: kernal local enable [--profile <name>] | kernal local disable | kernal local status [--json] | kernal local run";
/** How long `disable` waits for the running loop to send its "stop" heartbeat and exit. */
export const DISABLE_WAIT_MS = 6_000;

type Env = Readonly<Record<string, string | undefined>>;

export interface LocalIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: Env;
  /** The Kernal root: the bundle, or the checkout's kernal/. */
  root: string;
  platform?: NodeJS.Platform;
  userHome?: string;
  uid?: number;
  runner?: Runner;
  /** `localHost.shareModels` as resolved now (default: central-config). */
  shareModels?: () => { value: boolean; source: string };
  /** ngrok on enable (defaults: the real provider's status and the pinned install). */
  ngrokStatus?: () => Promise<ProviderStatus>;
  installNgrok?: () => Promise<InstallResult>;
  /** `run`: replaces parts of the loop's outside world (tests). */
  loopDeps?: Partial<LoopDeps>;
  onSignal?: (signal: SignalName, handler: () => void) => void;
  log?: Logger;
  /** `disable`: signal the running loop and wait for it. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

type Parsed = { command?: string; profile?: string; json: boolean; bad?: string };

export function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const p: Parsed = { command, json: false };
  if (!command) return { ...p, bad: "missing command" };
  if (!["enable", "disable", "status", "run"].includes(command)) return { ...p, bad: `unknown command ${command}` };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (command === "enable" && a === "--profile") {
      const v = rest[++i];
      if (!v || v.startsWith("-")) return { ...p, bad: "--profile needs a profile name" };
      p.profile = v;
    } else if (command === "enable" && a.startsWith("--profile=")) {
      p.profile = a.slice("--profile=".length);
      if (!p.profile) return { ...p, bad: "--profile needs a profile name" };
    } else if (command === "status" && a === "--json") p.json = true;
    else return { ...p, bad: `unknown option ${a}` };
  }
  return p;
}

function defaultShareModels(): { value: boolean; source: string } {
  const v = reresolve().values["localHost.shareModels"];
  return { value: v?.value === true, source: v?.source ?? "default" };
}

function serviceDeps(io: LocalIo): ServiceDeps {
  return {
    platform: io.platform ?? process.platform,
    userHome: io.userHome ?? (io.env?.HOME?.trim() || homedir()),
    uid: io.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    runner: io.runner ?? realRunner,
  };
}

export { kernalVersion };

const sourceText = (s: string) => (s === "default" ? "the default" : s === "local" ? "this machine's config.local.json" : s);

function sharingHelp(io: LocalIo, env: Env, share: { value: boolean; source: string }): void {
  io.out(`Sharing (localHost.shareModels): ${share.value ? "on" : "off"}, from ${sourceText(share.source)}.`);
  if (!share.value) {
    io.out("  The service shares nothing until it is on. Turn it on with one of:");
    io.out(`    - the account page on ${webOrigin(outfitterApi(env as NodeJS.ProcessEnv))} (this device or every device), or /admin inside Kernal;`);
    io.out(`    - "localHost.shareModels": true under "values" in ${join(kernalHome(env), "config.local.json")} (this machine only).`);
    io.out("  /config inside Kernal shows the value and where it comes from.");
  }
}

// ---------- enable ----------

async function enable(p: Parsed, io: LocalIo, env: Env): Promise<number> {
  const sd = serviceDeps(io);
  if (!unitPath(sd.platform, sd.userHome)) {
    io.err(`kernal local: runs on macOS and Linux, not ${sd.platform}`);
    return 1;
  }
  const runtime = chooseRuntime({ env, root: io.root, runner: sd.runner });
  if (!runtime) {
    io.err("kernal local needs Node 22.18+ or a release bundle");
    return 1;
  }
  const home = kernalHome(env);
  const profile = p.profile ?? (env.KERNAL_PROFILE?.trim() || undefined);

  // The tunnel's runtime: Kernal's own pinned ngrok, installed now when the service would not
  // find one. enable is the one command a person runs on purpose; the service never downloads.
  // A ngrok on this shell's PATH is not enough: the LaunchAgent's PATH is the node directory
  // plus the system directories, so Homebrew is invisible there. findNgrok runs Kernal's copy
  // (KERNAL_HOME/bin/ngrok) before PATH.
  const choice = parseTunnelChoice(env.KERNAL_LOCAL_TUNNEL);
  if (choice !== "cloudflare") {
    const status = await (io.ngrokStatus ?? (() => ngrokProvider().status()))();
    const needsManaged = status.source === "path" || (!status.available && !!status.installable);
    if (!needsManaged && status.available) io.out(`Tunnel: ${status.runtime ?? "ngrok"}`);
    else if (needsManaged) {
      io.out(status.source === "path"
        ? "Tunnel: installing Kernal's ngrok agent (this shell's ngrok is not on the service's PATH) ..."
        : "Tunnel: installing the ngrok agent (pinned version, checksum checked) ...");
      const r = await (io.installNgrok ?? (() => installNgrok()))();
      if (r.ok) io.out(`Tunnel: ngrok ${r.version} (${r.path})`);
      else if (status.available) io.err(`kernal local: could not install Kernal's ngrok (${r.detail}); this shell can see ${status.runtime ?? "ngrok"}, but the service cannot`);
      else io.err(`kernal local: could not install ngrok (${r.detail}); the service runs, but no tunnel opens until it is installed`);
    } else io.err(`kernal local: ${status.reason ?? "ngrok is unavailable"}; the service runs, but no tunnel opens until that is fixed`);
  }

  const r = installService({ kernal: stableLauncher(io.root, home), homeDir: home, node: runtime.kind === "node" ? runtime.path : undefined, profile }, sd);
  if (!r.ok) {
    io.err(`kernal local: ${r.error}`);
    return 1;
  }
  io.out(`Installed and started the Local Host service: ${r.unit}`);
  io.out(`  Runs \`kernal local run\` with ${runtime.kind === "node" ? `node ${runtime.version} (${runtime.path})` : `the bundle's pi as Bun (${runtime.path})`}${profile ? `, profile ${profile}` : ""}.`);
  io.out(`  Log: ${logPath(home)}. \`kernal local status\` shows what it is doing; \`kernal local disable\` removes it.`);
  try {
    sharingHelp(io, env, (io.shareModels ?? defaultShareModels)());
  } catch {}
  if (!loginState({ api: outfitterApi(env as NodeJS.ProcessEnv), env: env as NodeJS.ProcessEnv }).signedIn) {
    io.out("Signed out: run `kernal login` so Outfitter can register this machine's models (until then only interim .env tunnel credentials apply).");
  }
  return 0;
}

// ---------- disable ----------

async function disable(io: LocalIo, env: Env): Promise<number> {
  const sd = serviceDeps(io);
  const home = kernalHome(env);
  const alive = io.alive ?? pidAlive;
  const kill = io.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Removing the unit first: launchctl bootout / systemctl disable --now send SIGTERM (the loop's
  // "stop" heartbeat) and wait, and the unit can't restart it (KeepAlive / Restart=always would if
  // it were signalled while still installed).
  const before = serviceStatus(sd);
  const r = removeService(sd);
  if (!r.ok) {
    io.err(`kernal local: ${r.error}`);
    return 1;
  }
  // A loop still holding run.lock is a foreground `kernal local run`: stop it the same way.
  const pid = readLockPid(home);
  if (pid !== undefined && pid !== process.pid && alive(pid)) {
    try {
      kill(pid, "SIGTERM");
      for (let waited = 0; waited < DISABLE_WAIT_MS && alive(pid); waited += 100) await sleep(100);
    } catch {}
  }
  io.out(before.installed ? `Stopped and removed the Local Host service (${r.unit}).` : "The Local Host service was not installed.");
  return 0;
}

// ---------- status ----------

const ago = (iso: string | null | undefined) => (iso ? iso : "never");

export function statusLines(st: ServiceState | undefined, svc: ServiceStatus, home: string, lockAlive: boolean): string[] {
  const lines: string[] = [];
  const running = svc.running || lockAlive;
  const pid = svc.pid ?? (lockAlive ? st?.pid ?? null : null);
  lines.push(`Service:    ${svc.installed ? "installed" : "not installed"}, ${running ? `running${pid ? ` (pid ${pid}${st?.runtime ? `, ${st.runtime}` : ""})` : ""}` : "not running"}`);
  if (!st) {
    lines.push("State:      none yet (the service has not run)");
    lines.push(`Log:        ${logPath(home)}`);
    return lines;
  }
  if (!running) lines.push(`Last run:   started ${st.startedAt}, last update ${st.updatedAt}`);
  lines.push(`Account:    ${st.signedIn ? st.signedIn.email : "signed out"}`);
  lines.push(`Sharing:    ${st.shareModels.value ? "on" : "off"} (${sourceText(st.shareModels.source)})`);
  const t = st.tunnel;
  const kind = t.provider ? `${t.provider}, ${t.managed ? "managed" : "interim credentials"}` : t.managed ? "managed" : "";
  lines.push(`Tunnel:     ${t.state} since ${t.since}${kind ? ` (${kind})` : ""}${t.publicUrl ? `, ${t.publicUrl}` : ""}${t.reason ? `: ${t.reason}` : ""}`);
  lines.push(`Server:     ${st.server ?? "none answers"}; models ${st.models.total}, loaded ${st.models.loaded}`);
  const h = st.heartbeat;
  if (st.signedIn || h.lastAt) {
    lines.push(`Heartbeat:  ${ago(h.lastAt)}${h.ok === true ? `, ${h.status ?? "ok"}` : h.ok === false ? ", failed" : ""}${h.nextAt ? `, next ${h.nextAt}` : ""}${h.error ? ` (${h.error})` : ""}`);
  }
  if (h.problems.length) lines.push(`Problems:   ${h.problems.join("; ")}`);
  lines.push(`Router:     ${h.routerModels.length ? h.routerModels.join(", ") : "no models registered"}`);
  lines.push(`Log:        ${logPath(home)}`);
  return lines;
}

function status(p: Parsed, io: LocalIo, env: Env): number {
  const home = kernalHome(env);
  const st = readState(home);
  const svc = serviceStatus(serviceDeps(io));
  const pid = readLockPid(home);
  const lockAlive = pid !== undefined && (io.alive ?? pidAlive)(pid);
  if (p.json) {
    io.out(JSON.stringify({ ...(st ?? {}), service: { installed: svc.installed, running: svc.running || lockAlive, pid: svc.pid ?? (lockAlive ? pid : null), unit: svc.unit } }, null, 2));
    return 0;
  }
  for (const l of statusLines(st, svc, home, lockAlive)) io.out(l);
  return 0;
}

// ---------- run ----------

/** The discovery env: KERNAL_LOCAL_HOST_SERVER is probed too when it isn't one of the defaults. */
export function discoveryEnv(env: Env): Record<string, string | undefined> {
  const want = env.KERNAL_LOCAL_HOST_SERVER?.trim() ? serverRoot(env.KERNAL_LOCAL_HOST_SERVER) : undefined;
  if (!want || defaultTargets(env as Record<string, string | undefined>).some((t) => t.url === want)) return { ...env };
  return { ...env, KERNAL_LOCAL_SERVERS: [env.KERNAL_LOCAL_SERVERS, want].filter(Boolean).join(",") };
}

async function run(io: LocalIo, env: Env): Promise<number> {
  const home = kernalHome(env);
  const lock = acquireLock(home);
  if (!lock.ok) {
    io.out(`kernal local: already running (pid ${lock.pid})`);
    return 0;
  }
  const log = io.log ?? fileLogger(logPath(home));
  try {
    const showCache = new Map<string, any>();
    const denv = discoveryEnv(env);
    const penv = env as NodeJS.ProcessEnv;
    const deps: LoopDeps = {
      env,
      now: Date.now,
      fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
      discover: () => discoverLocalModels({ env: denv, ollamaShowCache: showCache }),
      openTunnel,
      session: {
        account: () => {
          const s = loginState({ api: outfitterApi(penv), env: penv });
          return s.signedIn ? { api: s.account.api, email: s.account.email, deviceId: s.account.deviceId } : undefined;
        },
        token: (a, rejected) => getAccessToken({ api: a.api, email: a.email, env: penv, ...(rejected ? { rejected } : {}) }),
      },
      config: {
        refresh: async () => { await refreshConfig(); },
        shareModels: io.shareModels ?? defaultShareModels,
      },
      host: io.loopDeps?.host ?? {
        hostId: resolveHostId(home),
        hostName: hostNameOf(hostname()),
        kernalVersion: kernalVersion(io.root),
        platform: `${process.platform}-${process.arch}`,
        runtime: currentRuntime(),
        pid: process.pid,
      },
      log,
      saveState: (s) => writeState(home, s),
      ...io.loopDeps,
    };
    const loop = new LocalHostLoop(deps);
    deps.saveState(loop.state());
    log("info", `started (pid ${deps.host.pid}, ${deps.host.runtime}, host ${deps.host.hostId}, kernal ${deps.host.kernalVersion})`);
    io.err(`kernal local: running (log ${logPath(home)}); Ctrl-C stops it`);
    await serve(loop, { log, onSignal: io.onSignal ?? ((sig, h) => { process.on(sig, h); }) });
    log("info", "stopped");
    return 0;
  } catch (e: any) {
    log("error", `failed: ${e?.message ?? e}`);
    io.err(`kernal local: ${e?.message ?? e}`);
    return 1;
  } finally {
    lock.release();
  }
}

/** Runs one command; resolves to the exit code (0 done, 1 failed, 2 usage). */
export async function main(argv: string[], io: LocalIo): Promise<number> {
  const env = io.env ?? process.env;
  const p = parseArgs(argv);
  if (p.bad) {
    io.err(`kernal local: ${p.bad}`);
    io.err(USAGE);
    return 2;
  }
  switch (p.command) {
    case "enable": return enable(p, io, env);
    case "disable": return disable(io, env);
    case "status": return status(p, io, env);
    case "run": return run(io, env);
  }
  return 2;
}
