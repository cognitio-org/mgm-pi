/**
 * Git operations for a run's workspace: clone with a token, create/checkout the session branch,
 * commit-all, push, and diff. The GitHub token is passed as a per-invocation `http.extraheader` (via
 * `authHeaderArgs`, a pure helper so the header construction is unit-testable without touching a
 * real URL) rather than embedded in the remote URL -- an embedded-in-URL token is exactly what `git
 * clone`/`git push -u` persist into `.git/config` (`remote.origin.url`), so it would sit there in
 * plaintext for the lifetime of the workspace. `-c http.extraheader=...` is a one-shot config
 * override for that single git invocation only and is never written anywhere.
 *
 * GitHub's git-over-HTTP endpoint rejects the `Bearer` auth scheme for this header (confirmed via
 * GitHub's own docs and community reports of `Bearer` being rejected while `Basic` succeeds, e.g.
 * https://github.com/mitkox/ecdf/issues/1); GitHub instead documents Basic auth with a PAT/token as
 * the password, i.e. `AUTHORIZATION: basic base64(x-access-token:<token>)`
 * (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens),
 * so `authHeaderArgs` builds that Basic form even though GitHub's REST API separately accepts
 * `Bearer`.
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

/** Builds the `-c http.extraheader=...` git argument pair that authenticates a single clone/fetch/
 * push against `remoteUrl` with `token`, without embedding the token in the URL (see module doc for
 * why that matters) or in `.git/config`. Returns `[]` when there's no token, the URL isn't parseable,
 * or the URL isn't an https github.com remote (e.g. a `file://` URL used in local smoke tests --
 * those need no auth at all). */
export function authHeaderArgs(remoteUrl: string, token: string | undefined): string[] {
  if (!token) return [];
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return [];
  }
  if (url.protocol !== "https:" || url.host !== "github.com") return [];
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`];
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

/** Strips a token value out of process output before it's embedded in a thrown Error or logged --
 * defense in depth in case git ever echoes the invocation (e.g. under `GIT_TRACE`) back on
 * stdout/stderr, since `authHeaderArgs`'s header no longer appears in the URL we log via
 * `redactUrl`. */
function redactToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join("<redacted>");
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
      const authArgs = authHeaderArgs(spec.cloneUrl, spec.githubToken);
      const cloneArgs = [...authArgs, "clone", "--branch", spec.baseBranch, "--single-branch", spec.cloneUrl, dest];
      const cloned = await exec("git", cloneArgs, process.cwd());
      if (cloned.code !== 0) {
        throw new Error(
          `git clone failed (${redactUrl(spec.cloneUrl)}): ${redactToken(cloned.stderr.trim(), spec.githubToken)}`,
        );
      }
      if (spec.createBranch) {
        const created = await run(dest, ["checkout", "-b", spec.branch]);
        if (created.code !== 0) {
          throw new Error(`git checkout -b ${spec.branch} failed: ${created.stderr.trim()}`);
        }
      } else {
        const fetched = await exec("git", [...authArgs, "fetch", "origin", spec.branch], dest);
        if (fetched.code !== 0) {
          throw new Error(
            `git fetch origin ${spec.branch} failed: ${redactToken(fetched.stderr.trim(), spec.githubToken)}`,
          );
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
      const remoteUrl = remote.stdout.trim();
      const authArgs = authHeaderArgs(remoteUrl, githubToken);
      const push = await exec("git", [...authArgs, "push", "-u", "origin", `HEAD:${branch}`], cwd);
      if (push.code !== 0) {
        throw new Error(
          `git push -u ${redactUrl(remoteUrl)} HEAD:${branch} failed: ${redactToken(push.stderr.trim(), githubToken)}`,
        );
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
