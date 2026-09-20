/**
 * Git operations for a run's workspace: clone with a token, create/checkout the session branch,
 * commit-all, push, and diff. The GitHub token is rewritten into the clone/push URL only (never into
 * argv that gets logged elsewhere, never printed) via `withAccessTokenUrl`, a pure helper so the
 * rewrite itself is unit-testable without touching a real URL containing a secret.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Matches the shape used elsewhere in mgm (teleport's ExecFn): (cmd, args, cwd) => result. Lets
 * tests stub git entirely. */
export type ExecFn = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>;

export async function defaultExec(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd });
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return {
      stdout: err?.stdout ?? "",
      stderr: err?.stderr ?? String(err?.message ?? err),
      code: typeof err?.code === "number" ? err.code : 1,
    };
  }
}

/** Rewrites an https GitHub URL to embed `x-access-token:<token>@github.com`. Pure string logic;
 * the caller is responsible for never logging the result. Non-GitHub or non-https URLs (e.g. a
 * `file://` URL used in local smoke tests) are returned unchanged since there is nothing to embed a
 * token into. */
export function withAccessTokenUrl(cloneUrl: string, token: string | undefined): string {
  if (!token) return cloneUrl;
  let url: URL;
  try {
    url = new URL(cloneUrl);
  } catch {
    return cloneUrl;
  }
  if (url.protocol !== "https:" || url.host !== "github.com") return cloneUrl;
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

/** Redacts a possibly-token-bearing URL for safe logging: keeps scheme/host/path, drops userinfo. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}

export interface CloneSpec {
  cloneUrl: string;
  baseBranch: string;
  branch: string;
  createBranch: boolean;
  githubToken?: string;
}

export interface GitOps {
  clone(spec: CloneSpec, dest: string): Promise<void>;
  commitAll(cwd: string, message: string): Promise<{ committed: boolean }>;
  push(cwd: string, branch: string, githubToken?: string): Promise<{ head: string }>;
  diff(cwd: string, base: string): Promise<string>;
  headSha(cwd: string): Promise<string>;
}

export function createGitOps(exec: ExecFn = defaultExec): GitOps {
  async function run(cwd: string, args: string[]): Promise<ExecResult> {
    return exec("git", args, cwd);
  }

  return {
    async clone(spec, dest) {
      const authedUrl = withAccessTokenUrl(spec.cloneUrl, spec.githubToken);
      const cloneArgs = ["clone", "--branch", spec.baseBranch, "--single-branch", authedUrl, dest];
      const cloned = await exec("git", cloneArgs, process.cwd());
      if (cloned.code !== 0) {
        throw new Error(`git clone failed (${redactUrl(spec.cloneUrl)}): ${cloned.stderr.trim()}`);
      }
      if (spec.createBranch) {
        const created = await run(dest, ["checkout", "-b", spec.branch]);
        if (created.code !== 0) {
          throw new Error(`git checkout -b ${spec.branch} failed: ${created.stderr.trim()}`);
        }
      } else {
        const fetched = await run(dest, ["fetch", "origin", spec.branch]);
        if (fetched.code !== 0) {
          throw new Error(`git fetch origin ${spec.branch} failed: ${fetched.stderr.trim()}`);
        }
        const checked = await run(dest, ["checkout", "-B", spec.branch, `origin/${spec.branch}`]);
        if (checked.code !== 0) {
          throw new Error(`git checkout ${spec.branch} failed: ${checked.stderr.trim()}`);
        }
      }
    },

    async commitAll(cwd, message) {
      const add = await run(cwd, ["add", "-A"]);
      if (add.code !== 0) throw new Error(`git add -A failed: ${add.stderr.trim()}`);
      const status = await run(cwd, ["status", "--porcelain"]);
      if (status.stdout.trim().length === 0) return { committed: false };
      const commit = await run(cwd, ["commit", "-m", message]);
      if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
      return { committed: true };
    },

    async push(cwd, branch, githubToken) {
      const remote = await run(cwd, ["remote", "get-url", "origin"]);
      const pushUrl = withAccessTokenUrl(remote.stdout.trim(), githubToken);
      const push = await run(cwd, ["push", "-u", pushUrl, `HEAD:${branch}`]);
      if (push.code !== 0) {
        throw new Error(`git push -u ${redactUrl(remote.stdout.trim())} HEAD:${branch} failed: ${push.stderr.trim()}`);
      }
      const head = await run(cwd, ["rev-parse", "HEAD"]);
      return { head: head.stdout.trim() };
    },

    async diff(cwd, base) {
      const committed = await run(cwd, ["diff", `${base}...HEAD`]);
      const working = await run(cwd, ["diff", "HEAD"]);
      const untracked = await run(cwd, ["status", "--porcelain=v1"]);
      const untrackedFiles = untracked.stdout
        .split("\n")
        .filter((l) => l.startsWith("??"))
        .map((l) => l.slice(3).trim());
      let untrackedDiff = "";
      for (const f of untrackedFiles) {
        const d = await run(cwd, ["diff", "--no-index", "/dev/null", f]);
        // git diff --no-index exits 1 when there is a difference (expected here); only bail on real errors.
        if (d.code === 0 || d.code === 1) untrackedDiff += d.stdout;
      }
      return [committed.stdout, working.stdout, untrackedDiff].filter(Boolean).join("\n");
    },

    async headSha(cwd) {
      const head = await run(cwd, ["rev-parse", "HEAD"]);
      return head.stdout.trim();
    },
  };
}
