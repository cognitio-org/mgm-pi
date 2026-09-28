/**
 * Browser IDE (#241, docs/specs/browser-ide.md §2): puts the pinned code-server release in
 * `/opt/code-server` when `run.spec.ide` asks for it, started as soon as the spec arrives so it's
 * usually done before anyone clicks "Open in VS Code" (about 20 s on GKE, spike S2).
 *
 * agentd runs as root and pi (and code-server, later) as `agent`, so:
 * - The HTTP body goes through a SHA-256 hash and then into tar's stdin: no tarball on disk. The
 *   hash sits before tar, so it covers every byte, the excluded entries included, and the whole body
 *   is read and hashed even if tar stops early.
 * - tar unpacks into a root-only (0700) temp dir beside the destination. Those bytes aren't verified
 *   yet; nothing runs from there, and the dir is renamed into place only once the hash matches.
 * - `--no-same-owner --no-same-permissions`: files belong to root with the process umask, whatever
 *   the archive says; the top dir becomes 0755 so `agent` can run code-server but not change it.
 * - The bundled Copilot extension and SDK (~40% of the tree, spike) are excluded: AI features are
 *   off in the IDE. GNU tar matches excludes against archive paths before --strip-components, hence
 *   the leading `*`.
 * - tar runs under `nice`, so it yields the one vCPU to pi's start.
 *
 * One install at a time; after a failure the next start() tries again. abort() (run end) stops the
 * download and tar and removes the temp dir.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import type { RunSpecIde } from "./protocol.js";

export const CODE_SERVER_DIR = "/opt/code-server";
/** The whole install, download and unpack, must finish within this. */
export const IDE_INSTALL_TIMEOUT_MS = 5 * 60_000;
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

  /** Run end: stop the download and tar; the temp dir is removed by install()'s cleanup. */
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
    const parsed = parseIdeSpec(this.opts.spec, this.opts.arch ?? ideArch());
    if ("error" in parsed) return done(parsed.error);
    const arch = (this.opts.arch ?? ideArch())!;
    const url = (this.opts.urlFor ?? codeServerUrl)(parsed.version, arch);

    let tmp: string | undefined;
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? IDE_INSTALL_TIMEOUT_MS);
    timer.unref?.();
    try {
      tmp = await mkdtemp(join(dirname(this.dest), `.${basename(this.dest)}.tmp-`));
      const res = await (this.opts.fetch ?? fetch)(url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok || !res.body) return done(`download failed: HTTP ${res.status}`);

      const tarArgs = [
        "xzf", "-", "-C", tmp, "--strip-components=1", "--no-same-owner", "--no-same-permissions",
        ...COPILOT_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
      ];
      const tarBin = this.opts.tarBin ?? "tar";
      const tar = this.opts.nice === false
        ? spawn(tarBin, tarArgs, { stdio: ["pipe", "ignore", "pipe"] })
        : spawn("nice", ["-n", "10", tarBin, ...tarArgs], { stdio: ["pipe", "ignore", "pipe"] });
      this.tar = tar;
      let tarStderr = "";
      tar.stderr?.on("data", (d: Buffer) => { if (tarStderr.length < 2000) tarStderr += d.toString(); });
      const tarExit = new Promise<number | null>((resolve) => {
        tar.once("error", () => resolve(-1));
        tar.once("close", (code) => resolve(code));
      });
      // A write error (tar died: EPIPE) mustn't stop the hash: keep reading, report it after.
      let pipeError: string | undefined;
      tar.stdin?.on("error", (err) => { pipeError ??= (err as NodeJS.ErrnoException).code ?? err.message; });

      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        bytes += chunk.length;
        const stdin = tar.stdin;
        if (!pipeError && stdin && !stdin.destroyed && !stdin.write(chunk)) {
          await new Promise<void>((resolve) => {
            const go = () => { stdin.off("drain", go); stdin.off("close", go); stdin.off("error", go); resolve(); };
            stdin.once("drain", go); stdin.once("close", go); stdin.once("error", go);
          });
        }
      }
      tar.stdin?.end();
      const code = await tarExit;
      this.tar = undefined;

      const got = hash.digest("hex");
      if (got !== parsed.sha256) return done(`checksum mismatch (got ${got.slice(0, 12)}…, ${bytes} bytes)`);
      if (pipeError || code !== 0) return done(`unpack failed (tar exit ${code}${pipeError ? `, ${pipeError}` : ""}): ${tarStderr.trim().slice(0, 300)}`);
      if (!(await stat(join(tmp, "bin", "code-server")).catch(() => undefined))) return done("unpacked tree has no bin/code-server");

      await rm(this.dest, { recursive: true, force: true });
      await rename(tmp, this.dest);
      tmp = undefined;
      await chmod(this.dest, 0o755);
      return done();
    } catch (err) {
      if (controller.signal.aborted) return done(this.aborted ? "the run is stopping" : "timed out");
      return done((err as Error).message);
    } finally {
      clearTimeout(timer);
      this.controller = undefined;
      if (this.tar) { this.tar.kill("SIGKILL"); this.tar = undefined; }
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}
