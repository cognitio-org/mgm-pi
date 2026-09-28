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
 * - The run's end kills the whole process group (terminals fork their own children), the tunnel
 *   and the proxy.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chown, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
    // Root-owned, empty: every setting is on the command line.
    const configDir = this.opts.configDir ?? IDE_CONFIG_DIR;
    await mkdir(configDir, { recursive: true, mode: 0o755 });
    const configFile = join(configDir, "config.yaml");
    await writeFile(configFile, "", { mode: 0o644 });
    // Machine settings are preferences, not a security boundary: agent-owned like the rest of its data.
    const machineDir = join(dataDir, "Machine");
    await mkdir(machineDir, { recursive: true });
    await writeFile(join(machineDir, "settings.json"), `${JSON.stringify(IDE_MACHINE_SETTINGS, null, 2)}\n`);
    if (user) {
      for (const dir of [join(home, ".local"), join(home, ".local", "share"), dataDir, machineDir]) {
        await chown(dir, user.uid, user.gid).catch(() => {});
      }
      await chown(join(machineDir, "settings.json"), user.uid, user.gid).catch(() => {});
    }

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
    while (!(await probePort(port, 500))) {
      if (exited) throw new Error(`${exited}: ${output.replace(/[^\x20-\x7e\n]+/g, " ").trim().slice(-300)}`);
      if (Date.now() > deadline) throw new Error("code-server didn't start listening in time");
      await new Promise((r) => setTimeout(r, 200));
    }

    const proxy = new LocalPreviewProxy({
      port,
      keepOrigin: true,
      clientData: () => this.meter.connection(),
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

  /** code-server or its tunnel died after starting: tear down and tell the api. */
  private async onChildGone(reason: string): Promise<void> {
    if (this.stopped || !this.ready) return; // start()'s own catch reports failures while opening
    this.ready = false;
    this.log(`ide: ${reason}`);
    await this.teardown();
    this.opts.send({ t: "ide.status", state: "stopped", detail: reason.slice(0, 300) });
  }

  private async teardown(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const pgid = child.pid;
      try { process.kill(-pgid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      const gone = new Promise<void>((r) => child.once("exit", () => r()));
      const timer = setTimeout(() => { try { process.kill(-pgid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, STOP_GRACE_MS);
      await Promise.race([gone, new Promise((r) => setTimeout(r, STOP_GRACE_MS + 1000))]);
      clearTimeout(timer);
    }
    const tunnel = this.tunnel;
    this.tunnel = undefined;
    const proxy = this.proxy;
    this.proxy = undefined;
    await Promise.allSettled([tunnel?.stop(), proxy?.stop()]);
    this.codeServerPort = undefined;
  }

  /** Run end: everything goes, no `stopped` frame (the run's own `bye` says it). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    await this.opening?.catch(() => {});
    await this.teardown();
  }
}
