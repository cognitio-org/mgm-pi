/**
 * Browser IDE (#242, docs/specs/browser-ide.md §3): starts code-server when a person asks
 * (`ide.open`, never the model) and serves it through the Drive previews pieces, apart from the
 * model-facing preview listener: the `preview` tool can't list, close or impersonate it.
 *
 * - code-server runs as `agent` (the model's user, never root), in its own process group, on a
 *   loopback port, with every setting on the command line and `--config` pointing at a root-owned
 *   empty file (so an agent-writable config.yaml can't change them), `--auth none` (sign-in is at
 *   ngrok's edge, owner and sysops only), `--disable-proxy` (its /proxy/<port> would reach agentd's
 *   own listeners), `--disable-workspace-trust`, and a listed environment: none of pi's secrets.
 * - Its own LocalPreviewProxy keeps `Origin` (code-server refuses every WebSocket otherwise, spike
 *   S3) and feeds the activity meter (ide-activity.ts).
 * - Its own ngrok tunnel binds `https://ide.<run>.internal`, a name the run's credential may bind
 *   and the preview tool never uses (previews are `p<port>.…`).
 * - The run's end signals code-server's whole process group, then stops the tunnel and the proxy.
 *   node-pty puts each terminal in its own session, so terminal shells aren't in that group; they get
 *   SIGHUP when their pty closes, and a job the person nohup'd survives until the container ends.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { peerUidFromProcNet } from "./browser-capture.js";
import { join } from "node:path";
import { IdeActivityMeter } from "./ide-activity.js";
import { CODE_SERVER_DIR, type IdeInstallResult, type IdeInstallState } from "./ide-install.js";
import { startNgrok, type NgrokTunnel } from "./ngrok-runner.js";
import { LocalPreviewProxy } from "./preview-proxy.js";
import { probePort } from "./preview.js";
import type { UpIdeStatus } from "./protocol.js";
import type { RunAsUser } from "./run-as-user.js";

/** How long code-server gets to start listening. */
export const IDE_START_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 2_000;
/** Root-owned, so `agent` can't change code-server's settings through a config file. */
export const IDE_CONFIG_DIR = "/run/outfitter-ide";

/** What IdeManager needs of the installer (ide-install.ts's CodeServerInstaller). */
export interface IdeInstallerPort {
  start(): Promise<IdeInstallResult>;
  readonly state: IdeInstallState;
}

type StartTunnel = (opts: { upstream: string; url: string; authtoken: string; onExit: (reason: string) => void }) => Promise<NgrokTunnel>;
type SpawnCodeServer = (bin: string, args: string[], opts: { env: Record<string, string>; cwd: string; uid?: number; gid?: number }) => ChildProcess;

/** VS Code settings for the IDE: AI chat off (VS Code 1.139 opens it by default, wired to nothing
 * here, and it took keystrokes in the spike), no telemetry, no update checks. */
export const IDE_MACHINE_SETTINGS = {
  "chat.disableAIFeatures": true,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off",
  "extensions.autoCheckUpdates": false,
  "update.mode": "none",
};

export interface IdeManagerOptions {
  installer: IdeInstallerPort;
  /** The run's internal ngrok domain (run.spec.preview.internalDomain). */
  internalDomain: string;
  authtoken: string;
  workspace: string;
  send: (frame: UpIdeStatus) => void;
  /** Someone is using the IDE (ide-activity.ts's rule). */
  onActivity: () => void;
  /** code-server runs as this user; undefined only where agentd isn't root (tests, laptop). */
  runAsUser?: RunAsUser;
  /** Extra environment for code-server's terminals: the run's git proxy and commit identity. */
  env?: Record<string, string>;
  /** Default `/opt/code-server/bin/code-server`. */
  codeServerBin?: string;
  /** Default IDE_CONFIG_DIR. */
  configDir?: string;
  /** Default the run-as user's home, else $HOME. */
  home?: string;
  startTimeoutMs?: number;
  onLog?: (line: string) => void;
  /** Default (when agentd is root): only root's connections reach the IDE's proxy. Tests may pass
   * their own. */
  peerAllowed?: (socket: Socket) => Promise<boolean>;
  /** Tests: replace the ngrok agent and the code-server process. */
  startTunnel?: StartTunnel;
  spawnCodeServer?: SpawnCodeServer;
  ngrokBin?: string;
}

const defaultSpawn: SpawnCodeServer = (bin, args, opts) =>
  spawn(bin, args, {
    env: opts.env,
    cwd: opts.cwd,
    ...(opts.uid !== undefined ? { uid: opts.uid, gid: opts.gid } : {}),
    detached: true, // its own process group, so stop() takes the terminals' children too
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The connecting process's uid, from /proc/net/tcp (the preview listener's own check), must be 0. */
async function rootPeerOnly(socket: Socket): Promise<boolean> {
  const { localPort, remotePort } = socket;
  if (localPort === undefined || remotePort === undefined) return false;
  const table = await readFile("/proc/net/tcp", "utf8").catch(() => "");
  return peerUidFromProcNet(table, localPort, remotePort) === 0;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export class IdeManager {
  private readonly opts: IdeManagerOptions;
  private readonly log: (line: string) => void;
  private readonly meter: IdeActivityMeter;
  private child: ChildProcess | undefined;
  private proxy: LocalPreviewProxy | undefined;
  private tunnel: NgrokTunnel | undefined;
  private codeServerPort: number | undefined;
  private opening: Promise<void> | undefined;
  private waiting: string[] = [];
  private ready = false;
  private stopped = false;

  constructor(opts: IdeManagerOptions) {
    this.opts = opts;
    this.log = opts.onLog ?? (() => {});
    this.meter = new IdeActivityMeter({ onActive: () => opts.onActivity() });
  }

  get internalUrl(): string {
    return `https://ide.${this.opts.internalDomain}`;
  }

  /** code-server's and its proxy's loopback ports, which the `preview` tool must never open. */
  ports(): number[] {
    return [this.codeServerPort, this.proxy?.port].filter((p): p is number => p !== undefined);
  }

  /** `ide.open`: start (or reuse) the IDE and answer with `ide.status` frames for `reqId`. */
  open(reqId: string): void {
    if (this.stopped) {
      this.opts.send({ t: "ide.status", reqId, state: "error", detail: "the run is stopping" });
      return;
    }
    if (this.ready) {
      this.opts.send({ t: "ide.status", reqId, state: "ready", internalUrl: this.internalUrl });
      return;
    }
    this.waiting.push(reqId);
    this.opening ??= this.start().finally(() => { this.opening = undefined; });
  }

  private sendAll(frame: Omit<UpIdeStatus, "t" | "reqId">, final: boolean): void {
    const ids = final ? this.waiting.splice(0) : [...this.waiting];
    for (const reqId of ids) this.opts.send({ t: "ide.status", reqId, ...frame });
  }

  private async start(): Promise<void> {
    try {
      if (this.opts.installer.state !== "ready") this.sendAll({ state: "installing" }, false);
      const installed = await this.opts.installer.start();
      if (!installed.ok) throw new Error(`code-server isn't installed: ${installed.error ?? "unknown error"}`);
      if (this.stopped) throw new Error("the run is stopping");
      this.sendAll({ state: "starting" }, false);
      await this.launch();
      if (this.stopped) throw new Error("the run is stopping");
      this.ready = true;
      this.log(`ide: ready at ${this.internalUrl}`);
      this.sendAll({ state: "ready", internalUrl: this.internalUrl }, true);
    } catch (err) {
      const detail = (err as Error).message.slice(0, 300);
      this.log(`ide: open failed: ${detail}`);
      await this.teardown();
      this.sendAll({ state: "error", detail }, true);
    }
  }

  private async launch(): Promise<void> {
    const user = this.opts.runAsUser;
    const home = this.opts.home ?? user?.home ?? process.env.HOME ?? "/tmp";
    const dataDir = join(home, ".local", "share", "code-server");
    // Root-owned, empty: every setting is on the command line. Checked, not assumed: a real directory
    // (not a symlink) owned by the user agentd runs as, and a fresh file, never one followed.
    const configDir = this.opts.configDir ?? IDE_CONFIG_DIR;
    await mkdir(configDir, { recursive: true, mode: 0o755 });
    const dirStat = await lstat(configDir);
    const me = process.getuid?.();
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (me !== undefined && dirStat.uid !== me) || (dirStat.mode & 0o022) !== 0) {
      throw new Error(`${configDir} isn't a directory only agentd can write`);
    }
    const configFile = join(configDir, "config.yaml");
    await unlink(configFile).catch(() => {});
    await writeFile(configFile, "", { mode: 0o644, flag: "wx" });
    // Machine settings are preferences, not a security boundary, and they live in the agent's home:
    // written *as agent*, never as root, so a symlink `agent` planted there can't turn root's write
    // into an overwrite of some other file.
    const machineDir = join(dataDir, "Machine");
    await this.writeAsUser(machineDir, "settings.json", `${JSON.stringify(IDE_MACHINE_SETTINGS, null, 2)}\n`);

    const port = await freePort();
    this.codeServerPort = port;
    const args = [
      "--config", configFile,
      "--bind-addr", `127.0.0.1:${port}`,
      "--auth", "none",
      "--disable-telemetry",
      "--disable-update-check",
      "--disable-proxy",
      "--disable-workspace-trust",
      "--disable-getting-started-override",
      "--user-data-dir", dataDir,
      "--extensions-dir", join(dataDir, "extensions"),
      this.opts.workspace,
    ];
    // Listed, not inherited: no LiteLLM key, no loopback tool tokens, no Tape env.
    const env: Record<string, string> = {
      HOME: home,
      USER: user?.user ?? process.env.USER ?? "agent",
      LOGNAME: user?.user ?? process.env.USER ?? "agent",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
      // The agent user's login shell is nologin; without this every terminal exits at once (spike).
      SHELL: "/bin/bash",
      ...this.opts.env,
    };
    const bin = this.opts.codeServerBin ?? join(CODE_SERVER_DIR, "bin", "code-server");
    const child = (this.opts.spawnCodeServer ?? defaultSpawn)(bin, args, {
      env,
      cwd: this.opts.workspace,
      ...(user ? { uid: user.uid, gid: user.gid } : {}),
    });
    this.child = child;
    let output = "";
    const keep = (d: Buffer) => { if (output.length < 4000) output += d.toString(); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    let exited: string | undefined;
    child.on("error", (err) => { exited ??= `spawn failed: ${err.message}`; });
    child.on("exit", (code, signal) => {
      exited ??= `code-server exited (code ${code}, signal ${signal})`;
      if (this.child === child) void this.onChildGone(exited);
    });

    const deadline = Date.now() + (this.opts.startTimeoutMs ?? IDE_START_TIMEOUT_MS);
    const failure = () => `${exited}: ${output.replace(/[^\x20-\x7e\n]+/g, " ").trim().slice(-300)}`;
    while (!(await probePort(port, 500))) {
      if (this.stopped) throw new Error("the run is stopping");
      if (exited) throw new Error(failure());
      if (Date.now() > deadline) throw new Error("code-server didn't start listening in time");
      await new Promise((r) => setTimeout(r, 200));
    }
    // Something answered; make sure it's still ours (another process could have taken the port).
    await new Promise((r) => setTimeout(r, 100));
    if (exited) throw new Error(failure());

    const proxy = new LocalPreviewProxy({
      port,
      keepOrigin: true,
      clientData: () => this.meter.connection(),
      // Only root's connections: the ngrok agent runs as root, the model's shell as `agent`. Without
      // this the model could reach the proxy on loopback and fake activity, which has no cap.
      ...(this.opts.peerAllowed ? { peerAllowed: this.opts.peerAllowed } : user ? { peerAllowed: rootPeerOnly } : {}),
      onLog: this.log,
    });
    await proxy.start();
    this.proxy = proxy;
    const startTunnel: StartTunnel = this.opts.startTunnel
      ?? ((o) => startNgrok({ ...o, bin: this.opts.ngrokBin, onLog: this.log }));
    this.tunnel = await startTunnel({
      upstream: `http://127.0.0.1:${proxy.port}`,
      url: this.internalUrl,
      authtoken: this.opts.authtoken,
      onExit: (reason) => { void this.onChildGone(`the IDE's tunnel ended: ${reason}`); },
    });
  }

  /** Writes `dir/name` as the run-as user (a short `sh`), or directly when agentd isn't root. */
  private async writeAsUser(dir: string, name: string, content: string): Promise<void> {
    const user = this.opts.runAsUser;
    if (!user) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), content);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", 'umask 022 && mkdir -p -- "$1" && cat > "$1/$2"', "sh", dir, name], {
        uid: user.uid,
        gid: user.gid,
        env: { PATH: "/usr/bin:/bin", HOME: user.home },
        stdio: ["pipe", "ignore", "pipe"],
      });
      let err = "";
      child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`writing ${name} as ${user.user} failed: ${err.trim().slice(0, 200)}`))));
      child.stdin?.end(content);
    });
  }

  /** code-server or its tunnel died after starting: tear down and tell the api. */
  private async onChildGone(reason: string): Promise<void> {
    if (this.stopped || !this.ready) return; // start()'s own catch reports failures while opening
    this.ready = false;
    this.log(`ide: ${reason}`);
    await this.teardown();
    this.opts.send({ t: "ide.status", state: "stopped", detail: reason.slice(0, 300) });
  }

  private async teardown(): Promise<void> {
    // Take every handle before the first await, so a start that follows can't lose its own.
    const child = this.child;
    this.child = undefined;
    const tunnel = this.tunnel;
    this.tunnel = undefined;
    const proxy = this.proxy;
    this.proxy = undefined;
    this.codeServerPort = undefined;
    if (child?.pid !== undefined) {
      // Always the whole group: code-server's launcher forks the real server, the extension host
      // and ptyHost, which outlive it if only the top process has gone. ESRCH (all gone) is fine.
      const pgid = child.pid;
      const signal = (sig: NodeJS.Signals) => { try { process.kill(-pgid, sig); } catch { /* none left */ } };
      signal("SIGTERM");
      const running = child.exitCode === null && child.signalCode === null;
      if (running) await Promise.race([new Promise<void>((r) => child.once("exit", () => r())), new Promise((r) => setTimeout(r, STOP_GRACE_MS))]);
      signal("SIGKILL");
    }
    await Promise.allSettled([tunnel?.stop(), proxy?.stop()]);
  }

  /** Run end: everything goes, no `stopped` frame (the run's own `bye` says it). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    // Tear down first: a start in progress sees `stopped` at its next step instead of holding up the
    // run's `bye` until code-server's startup timeout.
    await this.teardown();
    await this.opening?.catch(() => {});
    await this.teardown();
  }
}
