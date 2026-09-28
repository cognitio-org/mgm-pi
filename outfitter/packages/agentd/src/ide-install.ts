/**
 * Browser IDE (#241, docs/specs/browser-ide.md §2): puts the pinned code-server release in
 * `/opt/code-server` when `run.spec.ide` asks for it, started as soon as the spec arrives so it's
 * usually done before anyone clicks "Open in VS Code" (about 20 s on GKE, spike S2).
 *
 * agentd runs as root and pi (and code-server, later) as `agent`, so tar never sees an unverified
 * byte:
 * 1. The download is written to a 0600 file inside a fresh 0700 temp dir beside the destination,
 *    hashed as it arrives, and capped at MAX_DOWNLOAD_BYTES.
 * 2. Only if its SHA-256 matches the pin does GNU tar unpack it, niced (it yields the one vCPU to
 *    pi's start), into `<tmp>/tree`: `--no-same-owner --no-same-permissions` make everything root's
 *    with the process umask, whatever the archive says. The temp dir itself stays 0700 whatever tar
 *    does to `tree` (a `top/.` member can reset `tree`'s mode, not its parent's).
 * 3. The bundled Copilot extension and SDK (~40% of the tree, spike) are excluded: AI features are
 *    off in the IDE. GNU tar matches excludes against archive paths before --strip-components,
 *    hence the leading `*`.
 * 4. `tree` is renamed to the destination (a sibling path, so the same filesystem; don't make
 *    /opt/code-server a mount point) and made 0755: `agent` can run code-server, not change it.
 *
 * One install at a time; after a failure the next start() tries again. abort() (run end) stops the
 * download or tar, and nothing is moved into place after it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import type { RunSpecIde } from "./protocol.js";

export const CODE_SERVER_DIR = "/opt/code-server";
/** The whole install, download and unpack, must finish within this. */
export const IDE_INSTALL_TIMEOUT_MS = 5 * 60_000;
/** The 4.139.1 release is 222 MB; anything far past that isn't the file we pinned. */
export const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;
export const COPILOT_EXCLUDES = ["*/lib/vscode/extensions/copilot", "*/lib/vscode/node_modules/@github"];

export type IdeArch = "amd64" | "arm64";
export type IdeInstallState = "idle" | "installing" | "ready" | "failed";

export interface IdeInstallResult {
  ok: boolean;
  /** Set when ok is false: what went wrong, fit for a log line or the session page. */
  error?: string;
  seconds: number;
}

export function ideArch(nodeArch: string = process.arch): IdeArch | undefined {
  if (nodeArch === "x64") return "amd64";
  if (nodeArch === "arm64") return "arm64";
  return undefined;
}

export function codeServerUrl(version: string, arch: IdeArch): string {
  return `https://github.com/coder/code-server/releases/download/v${version}/code-server-${version}-linux-${arch}.tar.gz`;
}

/** The api sets these, but they end up in a URL and a comparison: accept only the expected shapes. */
export function parseIdeSpec(ide: RunSpecIde | undefined, arch: IdeArch | undefined): { version: string; sha256: string } | { error: string } {
  if (!ide) return { error: "no ide in run.spec" };
  if (!arch) return { error: `unsupported architecture ${process.arch}` };
  if (typeof ide.version !== "string" || !/^\d+\.\d+\.\d+$/.test(ide.version)) return { error: "bad code-server version" };
  const sha = ide.artifacts?.[arch];
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) return { error: `no checksum for ${arch}` };
  return { version: ide.version, sha256: sha };
}

/** tar's stderr, for a log line: printable ASCII only, so a member name can't forge log lines. */
function printable(text: string): string {
  return text.replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 300);
}

export interface CodeServerInstallerOptions {
  spec: RunSpecIde;
  /** Default CODE_SERVER_DIR. */
  dest?: string;
  /** Default ideArch(). */
  arch?: IdeArch;
  /** Tests: a local server instead of GitHub. */
  urlFor?: (version: string, arch: IdeArch) => string;
  fetch?: typeof fetch;
  /** Default "tar" (GNU tar in the image). */
  tarBin?: string;
  /** Default true; tests may turn it off where `nice` isn't on PATH. */
  nice?: boolean;
  timeoutMs?: number;
  /** Default MAX_DOWNLOAD_BYTES. */
  maxBytes?: number;
  onLog?: (line: string) => void;
}

export class CodeServerInstaller {
  private readonly opts: CodeServerInstallerOptions;
  private readonly dest: string;
  private current: Promise<IdeInstallResult> | undefined;
  private controller: AbortController | undefined;
  private tar: ChildProcess | undefined;
  private _state: IdeInstallState = "idle";
  private aborted = false;

  constructor(opts: CodeServerInstallerOptions) {
    this.opts = opts;
    this.dest = opts.dest ?? CODE_SERVER_DIR;
  }

  get state(): IdeInstallState {
    return this._state;
  }

  /** The install in flight, or a new one unless it already succeeded. Never rejects. */
  start(): Promise<IdeInstallResult> {
    if (this.current && this._state !== "failed") return this.current;
    if (this.aborted) return Promise.resolve({ ok: false, error: "the run is stopping", seconds: 0 });
    this._state = "installing";
    this.current = this.install().then((result) => {
      this._state = result.ok ? "ready" : "failed";
      return result;
    });
    return this.current;
  }

  /** Run end: stop the download or tar. install() removes its temp dir and moves nothing. */
  abort(): void {
    this.aborted = true;
    this.controller?.abort();
    this.tar?.kill("SIGKILL");
  }

  private async install(): Promise<IdeInstallResult> {
    const started = Date.now();
    const log = this.opts.onLog ?? (() => {});
    const done = (error?: string): IdeInstallResult => {
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      if (error) log(`code-server install failed after ${seconds}s: ${error}`);
      else log(`code-server installed in ${seconds}s`);
      return error ? { ok: false, error, seconds } : { ok: true, seconds };
    };
    const arch = this.opts.arch ?? ideArch();
    const parsed = parseIdeSpec(this.opts.spec, arch);
    if ("error" in parsed) return done(parsed.error);
    const url = (this.opts.urlFor ?? codeServerUrl)(parsed.version, arch!);
    const maxBytes = this.opts.maxBytes ?? MAX_DOWNLOAD_BYTES;

    let tmp: string | undefined;
    const controller = new AbortController();
    this.controller = controller;
    // A timeout or abort also stops tar once the download is done.
    controller.signal.addEventListener("abort", () => this.tar?.kill("SIGKILL"));
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? IDE_INSTALL_TIMEOUT_MS);
    timer.unref?.();
    const stopped = () => (this.aborted ? "the run is stopping" : "timed out");
    try {
      tmp = await mkdtemp(join(dirname(this.dest), `.${basename(this.dest)}.tmp-`));

      // 1. Download to a 0600 file, hashing as it arrives.
      const res = await (this.opts.fetch ?? fetch)(url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        return done(`download failed: HTTP ${res.status}`);
      }
      const archive = join(tmp, "release.tar.gz");
      const file = createWriteStream(archive, { flags: "wx", mode: 0o600 });
      const fileDone = new Promise<void>((resolve, reject) => { file.once("finish", resolve); file.once("error", reject); });
      fileDone.catch(() => {}); // awaited below; don't let an early error go unhandled meanwhile
      const hash = createHash("sha256");
      let bytes = 0;
      let tooBig = false;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          bytes += chunk.length;
          // Leaving the loop cancels the body; aborting here would surface as an abort instead.
          if (bytes > maxBytes) { tooBig = true; break; }
          hash.update(chunk);
          if (!file.write(chunk)) {
            await new Promise<void>((resolve) => {
              const go = () => { file.off("drain", go); file.off("error", go); file.off("close", go); resolve(); };
              file.once("drain", go); file.once("error", go); file.once("close", go);
            });
          }
        }
      } finally {
        file.end();
      }
      await fileDone;
      if (tooBig) return done(`download larger than ${maxBytes} bytes`);
      if (controller.signal.aborted) return done(stopped());
      const got = hash.digest("hex");
      if (got !== parsed.sha256) return done(`checksum mismatch (got ${got.slice(0, 12)}…, ${bytes} bytes)`);

      // 2. Unpack the verified file.
      const tree = join(tmp, "tree");
      await mkdir(tree, { mode: 0o700 });
      const tarArgs = [
        "xzf", archive, "-C", tree, "--strip-components=1", "--no-same-owner", "--no-same-permissions",
        ...COPILOT_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
      ];
      const tarBin = this.opts.tarBin ?? "tar";
      const tar = this.opts.nice === false
        ? spawn(tarBin, tarArgs, { stdio: ["ignore", "ignore", "pipe"] })
        : spawn("nice", ["-n", "10", tarBin, ...tarArgs], { stdio: ["ignore", "ignore", "pipe"] });
      this.tar = tar;
      let tarStderr = "";
      tar.stderr?.on("data", (d: Buffer) => { if (tarStderr.length < 2000) tarStderr += d.toString(); });
      const code = await new Promise<number | null>((resolve) => {
        tar.on("error", () => resolve(-1));
        tar.once("close", (c) => resolve(c));
      });
      this.tar = undefined;
      if (controller.signal.aborted) return done(stopped());
      if (code !== 0) return done(`unpack failed (tar exit ${code}): ${printable(tarStderr)}`);
      if (!(await stat(join(tree, "bin", "code-server")).catch(() => undefined))) return done("unpacked tree has no bin/code-server");

      // 3. Into place, unless the run ended meanwhile.
      if (this.aborted) return done(stopped());
      await rm(this.dest, { recursive: true, force: true });
      await rename(tree, this.dest);
      await chmod(this.dest, 0o755);
      return done();
    } catch (err) {
      if (controller.signal.aborted) return done(stopped());
      return done(printable((err as Error).message));
    } finally {
      clearTimeout(timer);
      this.controller = undefined;
      if (this.tar) { this.tar.kill("SIGKILL"); this.tar = undefined; }
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}
