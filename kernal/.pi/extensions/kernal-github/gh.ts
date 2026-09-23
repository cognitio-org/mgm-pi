/**
 * The GitHub CLI, as kernal uses it: finding it, installing it when it is missing, and reporting
 * who is signed in.
 *
 * Why `gh` and not GitHub's API directly: both people who use kernal already sign in to `gh`, it
 * holds the token in the OS keychain rather than in a file kernal would have to guard, it refreshes
 * and scopes that token itself, and `gh auth setup-git` makes `git push` over https work with the
 * same login. kernal never sees or stores a token (kernal/docs/git-github-spec.md).
 *
 * Installing: github.com/cli/cli publishes one archive per platform plus a checksums file. kernal
 * downloads the archive for this platform, checks its sha256 against that file, and unpacks the one
 * `gh` binary into KERNAL_HOME/bin (a source checkout: .pi/bin, git-ignored). No admin rights, no
 * package manager, and nothing else from the archive is kept. It is not bundled in releases: it
 * would add about 40 MB per platform for a tool many sessions never use, and kernal would then own
 * someone else's binary and its updates.
 *
 * Signing in cannot be driven from inside kernal: `gh auth login --web` is an interactive prompt,
 * and pi has no way to hand the terminal to a child process. So setup prints the exact command to
 * run in a terminal and then re-checks. A one-time paste beats a wrong abstraction.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "../_shared/env.ts";

export type Exec = (cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; stdin?: string }) => Promise<{ stdout: string; stderr: string; code: number }>;

export const execCommand: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      cmd, args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, encoding: "utf8",
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", CLICOLOR: "0", NO_COLOR: "1" } },
      (err: any, stdout: string, stderr: string) => {
        if (err && err.code === "ENOENT") return reject(new Error(`${cmd} is not installed`));
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: typeof err?.code === "number" ? err.code : err ? 1 : 0 });
      },
    );
    // git (and gh) may exit before reading stdin -- `git status` never reads it at all -- and the
    // write then fails with EPIPE, which would otherwise become an unhandled error on the socket
    // rather than a result. Seen on Linux in CI, not on macOS: the race goes the other way there.
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.stdin ?? "");
  });

/** Where kernal keeps a `gh` it installed itself: the install's bin directory, or the checkout's. */
export function kernalBin(): string {
  const home = env("HOME_DIR") || join(homedir(), ".kernal");
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  // A release bundle has a VERSION file next to .pi; a source checkout does not.
  if (agentDir && !existsSync(join(dirname(agentDir), "VERSION"))) return join(agentDir, "bin");
  return join(home, "bin");
}

/**
 * The `gh` to run, decided without starting a process: whatever is on PATH, unless the only one is
 * the copy kernal installed. Used by the callers that cannot await a lookup (kernal-update's daily
 * check, /report); `findGh` is the thorough version.
 */
export function ghPath(): string {
  // Same precedence as findGh: PATH first (a gh the person installed themselves wins), then the
  // copy kernal installed. Checked without starting a process, so callers on a hot path can use it.
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try { accessSync(join(dir, "gh"), constants.X_OK); return "gh"; } catch { /* not here */ }
  }
  const managed = join(kernalBin(), "gh");
  return existsSync(managed) ? managed : "gh";
}

/** PATH first, so a newer `gh` the person installed themselves wins, then kernal's own copy. */
export async function findGh(exec: Exec = execCommand): Promise<{ path: string; version: string; managed: boolean } | undefined> {
  const managed = join(kernalBin(), "gh");
  for (const [path, isManaged] of [["gh", false] as const, [managed, true] as const]) {
    if (isManaged && !existsSync(managed)) continue;
    try {
      const r = await exec(path, ["--version"], { timeoutMs: 10_000 });
      if (r.code !== 0) continue;
      const version = /gh version (\S+)/.exec(r.stdout)?.[1] ?? "unknown";
      return { path: isManaged ? managed : path, version, managed: isManaged };
    } catch { /* not there: try the next one */ }
  }
  return undefined;
}

export type AuthState = {
  signedIn: boolean;
  login?: string;
  scopes?: string[];
  /** Set when the token comes from GH_TOKEN/GITHUB_TOKEN rather than a `gh auth login`. */
  fromEnv?: boolean;
  gitConfigured?: boolean;
  detail?: string;
};

const SCOPES_WANTED = ["repo", "read:org", "workflow"];

/** Who `gh` is signed in as, which scopes the token has, and whether git uses the same login. */
export async function authState(gh: string, exec: Exec = execCommand): Promise<AuthState> {
  const res = await exec(gh, ["auth", "status", "--hostname", "github.com"], { timeoutMs: 20_000 });
  const text = res.stdout + res.stderr;
  if (res.code !== 0) return { signedIn: false, detail: text.trim() };
  const login = /(?:Logged in to github\.com (?:account )?|account )([A-Za-z0-9-]+)/.exec(text)?.[1];
  const scopes = /Token scopes:\s*(.+)/.exec(text)?.[1]?.split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
  const fromEnv = /Token: \*+|env|GH_TOKEN|GITHUB_TOKEN/.test(text) && !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
  const git = await exec("git", ["config", "--global", "--get-regexp", "^credential\\..*helper$"], { timeoutMs: 10_000 }).catch(() => ({ stdout: "", stderr: "", code: 1 }));
  return {
    signedIn: true,
    login,
    scopes,
    fromEnv: fromEnv || undefined,
    gitConfigured: githubComUsesGh(git.stdout),
    detail: text.trim(),
  };
}

/** True when a credential helper for github.com itself (or a global helper) runs `gh auth git-credential`.
 *  A helper scoped to some other host, such as a GitHub Enterprise server, does not count. */
export function githubComUsesGh(config: string): boolean {
  for (const line of config.split("\n")) {
    const m = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (!m || !/gh auth git-credential/.test(m[2])) continue;
    if (m[1] === "credential.helper") return true;
    if (/^credential\.https:\/\/github\.com(?:\/.*)?\.helper$/.test(m[1])) return true;
  }
  return false;
}

/** A single shell word. Paths with spaces or metacharacters stay one argument when pasted. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./@:+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Scopes the tools need that this token does not have. */
export const missingScopes = (scopes: string[] | undefined) =>
  scopes ? SCOPES_WANTED.filter((s) => !scopes.includes(s) && !(s === "read:org" && scopes.includes("admin:org"))) : [];

/** The command a person runs in a terminal to sign in, with the scopes kernal's tools need. */
export const loginCommand = (gh = "gh") => `${shellWord(gh)} auth login --web --git-protocol https --hostname github.com --scopes workflow`;
/** The command that makes `git push` over https use the same login. */
export const setupGitCommand = (gh = "gh") => `${shellWord(gh)} auth setup-git --hostname github.com`;

// ---------- installing ----------

export type Platform = { os: "darwin" | "linux"; arch: "arm64" | "x64" };

export function currentPlatform(): Platform | undefined {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  return os && arch ? { os, arch } : undefined;
}

/** The release asset for a platform: what cli/cli calls it, and how it is packed. */
export function assetFor(version: string, p: Platform): { name: string; kind: "zip" | "tar" } {
  const v = version.replace(/^v/, "");
  if (p.os === "darwin") return { name: `gh_${v}_macOS_${p.arch === "arm64" ? "arm64" : "amd64"}.zip`, kind: "zip" };
  return { name: `gh_${v}_linux_${p.arch === "arm64" ? "arm64" : "amd64"}.tar.gz`, kind: "tar" };
}

export const checksumsFor = (version: string) => `gh_${version.replace(/^v/, "")}_checksums.txt`;

/** The sha256 recorded for `asset` in a `gh_<v>_checksums.txt` body. */
export function checksumFrom(body: string, asset: string): string | undefined {
  for (const line of body.split("\n")) {
    const m = /^([0-9a-f]{64})\s+(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === asset) return m[1];
  }
  return undefined;
}

export type InstallDeps = {
  fetchJson?: (url: string) => Promise<any>;
  fetchText?: (url: string) => Promise<string>;
  fetchBinary?: (url: string) => Promise<Buffer>;
  exec?: Exec;
  binDir?: string;
};

export type InstallResult = { ok: true; path: string; version: string } | { ok: false; detail: string };

/**
 * Downloads the newest `gh` for this platform, verifies its sha256 against the release's checksums
 * file, unpacks the binary into kernal's bin directory and makes it executable. Everything else in
 * the archive is thrown away with the temporary directory.
 */
export async function installGh(deps: InstallDeps = {}): Promise<InstallResult> {
  const platform = currentPlatform();
  if (!platform) return { ok: false, detail: `kernal has no gh build for ${process.platform}/${process.arch}` };
  // Node's fetch has no timeout of its own, so a stalled connection would hang /github setup for
  // the life of the session -- the one thing this module promises cannot happen. A non-2xx response
  // is reported as itself, rather than being hashed and misreported as a tampered download.
  const get = async (url: string, timeoutMs: number, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { headers: { "user-agent": "kernal", ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!res.ok) throw new Error(`${url} returned ${res.status} ${res.statusText}`);
    return res;
  };
  const fetchJson = deps.fetchJson ?? (async (url) => (await get(url, 30_000, { accept: "application/vnd.github+json" })).json());
  const fetchText = deps.fetchText ?? (async (url) => (await get(url, 30_000)).text());
  const fetchBinary = deps.fetchBinary ?? (async (url) => Buffer.from(await (await get(url, 300_000)).arrayBuffer()));
  const exec = deps.exec ?? execCommand;
  const binDir = deps.binDir ?? kernalBin();

  let tmp: string | undefined;
  try {
    const release = await fetchJson("https://api.github.com/repos/cli/cli/releases/latest");
    const version: string | undefined = typeof release?.tag_name === "string" ? release.tag_name : undefined;
    if (!version) return { ok: false, detail: "could not read the latest gh release from github.com" };
    const asset = assetFor(version, platform);
    const base = `https://github.com/cli/cli/releases/download/${version}`;
    const sums = await fetchText(`${base}/${checksumsFor(version)}`);
    const want = checksumFrom(sums, asset.name);
    if (!want) return { ok: false, detail: `the gh ${version} release has no checksum for ${asset.name}` };

    const data = await fetchBinary(`${base}/${asset.name}`);
    const got = createHash("sha256").update(data).digest("hex");
    if (got !== want) return { ok: false, detail: `the downloaded ${asset.name} does not match its published checksum; nothing was installed` };

    tmp = await mkdtemp(join(tmpdir(), "kernal-gh-"));
    const archive = join(tmp, asset.name);
    await writeFile(archive, data);
    const unpack = asset.kind === "zip"
      ? await exec("unzip", ["-q", "-o", archive, "-d", tmp], { cwd: tmp, timeoutMs: 120_000 })
      : await exec("tar", ["xzf", archive, "-C", tmp], { cwd: tmp, timeoutMs: 120_000 });
    if (unpack.code !== 0) return { ok: false, detail: `unpacking ${asset.name} failed: ${unpack.stderr.trim()}` };

    const dirName = asset.name.replace(/\.zip$|\.tar\.gz$/, "");
    const found = join(tmp, dirName, "bin", "gh");
    if (!existsSync(found)) return { ok: false, detail: `the ${asset.name} archive did not contain bin/gh where expected` };
    await mkdir(binDir, { recursive: true });
    const target = join(binDir, "gh");
    await rename(found, target).catch(async () => { await writeFile(target, await readFile(found)); });
    await chmod(target, 0o755);
    const check = await exec(target, ["--version"], { timeoutMs: 10_000 });
    if (check.code !== 0) return { ok: false, detail: `the installed gh does not run: ${check.stderr.trim()}` };
    return { ok: true, path: target, version: version.replace(/^v/, "") };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e) };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- calling gh ----------

export type GhResult = { ok: boolean; stdout: string; stderr: string; code: number };

/** One `gh` call, with prompting off so it can never hang, and a JSON parse helper. */
export async function gh(path: string, args: string[], opts: { cwd?: string; timeoutMs?: number; stdin?: string } = {}, exec: Exec = execCommand): Promise<GhResult> {
  const r = await exec(path, args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 60_000, stdin: opts.stdin });
  return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr, code: r.code };
}

export async function ghJson<T = any>(path: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}, exec: Exec = execCommand): Promise<T | undefined> {
  const r = await gh(path, args, opts, exec);
  if (!r.ok) return undefined;
  try { return JSON.parse(r.stdout) as T; } catch { return undefined; }
}
