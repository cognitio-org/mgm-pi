/**
 * Git operations for a run's workspace: clone with a token, create/checkout the session branch,
 * commit-all, push, and diff. The GitHub token is passed as a per-invocation `http.extraheader` via
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` **environment** variables on the git
 * child process (via `authHeaderEnv`, a pure helper so the header construction is unit-testable
 * without touching a real URL), rather than embedded in the remote URL or passed as a `-c` argv
 * flag. Two reasons, not one:
 *  - An embedded-in-URL token is exactly what `git clone`/`git push -u` persist into `.git/config`
 *    (`remote.origin.url`), so it would sit there in plaintext for the lifetime of the workspace.
 *  - `-c http.extraheader=...` on argv is readable by any process sharing this git child's Linux
 *    user, for the life of the invocation, via `ps auxww` or `/proc/<pid>/cmdline` (finding #1 in
 *    docs/reports/security-review-pr1.md). Environment variables are visible only via
 *    `/proc/<pid>/environ`, which the kernel restricts to the owning uid (or root) -- this only
 *    actually closes the leak when this git child runs as a *different* Linux user than the model's
 *    shell, which is why the sandbox image runs agentd (and its git child) as root and spawns `pi`
 *    as the unprivileged `agent` user (see run-as-user.ts and image/Dockerfile).
 *
 * GitHub's git-over-HTTP endpoint rejects the `Bearer` auth scheme for this header (confirmed via
 * GitHub's own docs and community reports of `Bearer` being rejected while `Basic` succeeds, e.g.
 * https://github.com/mitkox/ecdf/issues/1); GitHub instead documents Basic auth with a PAT/token as
 * the password, i.e. `AUTHORIZATION: basic base64(x-access-token:<token>)`
 * (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens),
 * so `authHeaderEnv` builds that Basic form even though GitHub's REST API separately accepts
 * `Bearer`.
 *
 * Which Linux user runs which git child matters as much as where the token travels. After the
 * clone, /workspace (including .git/config and .git/hooks) belongs to the `agent` user the model's
 * shell runs as, so anything root's git read from it -- a hook, `core.fsmonitor`, a clean filter,
 * `url.*.insteadOf`, `http.proxy` -- would run or redirect with root's privileges and, during a
 * push, with the auth header in its environment. git >= 2.35.2 refuses to work in a repository
 * owned by another uid for exactly that reason, and agentd does not paper over it with
 * `safe.directory`. Instead:
 *  - everything local (add/commit/status/diff/rev-parse/update-ref/config) runs as the workspace's
 *    own user (`GitOpsOptions.runAs`) and never sees the token;
 *  - `push` runs as root, but from a private, root-owned bare repository that borrows the
 *    workspace's objects through `objects/info/alternates` (object data only -- no config, hooks or
 *    attributes), and pushes to the clone URL run.spec gave agentd, not to whatever the
 *    workspace's `origin` now says.
 * `clone` (and the resume fetch/checkout) run as root before the workspace is chowned, as before.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Matches the shape used elsewhere in kernal (teleport's ExecFn): (cmd, args, cwd) => result, plus an
 * optional `env` overlay (merged on top of the parent process env) so auth material can travel via
 * environment variables instead of argv. Lets tests stub git entirely.
 *
 * This type (and defaultExec below) is deliberately duplicated in kernal/.pi/extensions/teleport/
 * lib.ts rather than imported from here: agentd's release bundle ships as part of the outfitter
 * image, and kernal's teleport extension ships independently as part of the kernal CLI release, so the
 * kernal bundle must not gain a build-order dependency on the outfitter tree (see
 * outfitter/docs/reports/maintainability-review-pr1.md for the tradeoff). */
export type ExecFn = (
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  as?: ExecAs,
) => Promise<ExecResult>;

/** Linux uid/gid to run a child as (see GitOpsOptions.runAs). */
export interface ExecAs {
  uid: number;
  gid: number;
}

export async function defaultExec(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  as?: ExecAs,
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      ...(as ? { uid: as.uid, gid: as.gid } : {}),
    });
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return {
      stdout: err?.stdout ?? "",
      stderr: err?.stderr ?? String(err?.message ?? err),
      code: typeof err?.code === "number" ? err.code : 1,
    };
  }
}

/** One `key=value` git config entry, passed via `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`. */
export type GitConfigEntry = [key: string, value: string];

/** Encodes `entries` as `GIT_CONFIG_COUNT` plus one `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` pair
 * each, in order, with a count that always matches. Returns `{}` for no entries (so a caller's
 * inherited `GIT_CONFIG_*`, if any, is left alone rather than reset to a count of 0). */
export function gitConfigEnv(entries: GitConfigEntry[]): Record<string, string> {
  if (entries.length === 0) return {};
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** The `http.extraheader` entry that authenticates a single clone/fetch/push against `remoteUrl`
 * with `token` (see module doc for why env, not argv or the URL, and what that does and doesn't
 * protect against). Empty when there's no token, the URL isn't parseable, or the URL isn't an https
 * github.com remote (e.g. a `file://` URL used in local smoke tests -- those need no auth at all). */
export function authConfigEntries(remoteUrl: string, token: string | undefined): GitConfigEntry[] {
  if (!token) return [];
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return [];
  }
  if (url.protocol !== "https:" || url.host !== "github.com") return [];
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return [["http.extraheader", `AUTHORIZATION: basic ${basic}`]];
}

/** `authConfigEntries` alone, as `GIT_CONFIG_*` env vars. Returns `{}` when there's no auth to add. */
export function authHeaderEnv(remoteUrl: string, token: string | undefined): Record<string, string> {
  return gitConfigEnv(authConfigEntries(remoteUrl, token));
}

/** A git identity (name + email), as used for GIT_AUTHOR_* / GIT_COMMITTER_*. */
export interface GitIdentity {
  name: string;
  email: string;
}

/** The Outfitter bot: author *and* committer of every cloud commit -- agentd's checkpoint commits
 * and, pinned into pi's env, the agent's own ("the bot, on behalf of the person";
 * kernal/docs/git-github-spec.md, "Attribution"). The session's person is credited through
 * trailers instead (attributionTrailers). `.invalid` is reserved (RFC 2606), so the address can
 * never resolve to a mailbox or to someone's GitHub account -- unlike
 * `<name>@users.noreply.github.com`, which GitHub attributes to the account `<name>` (and
 * github.com/outfitter is an unrelated user). */
export const OUTFITTER_BOT_IDENTITY: GitIdentity = {
  name: "Outfitter",
  email: "noreply@outfitter.invalid",
};

/** GIT_AUTHOR_* and GIT_COMMITTER_*, both the Outfitter bot. */
export function botIdentityEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: OUTFITTER_BOT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: OUTFITTER_BOT_IDENTITY.email,
    GIT_COMMITTER_NAME: OUTFITTER_BOT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: OUTFITTER_BOT_IDENTITY.email,
  };
}

/** The session's person, as run.spec.author carries them. */
export interface CommitAuthor {
  name: string;
  /** The address to credit: their GitHub noreply address when the api knows it. */
  email: string;
  login?: string;
}

/** run.spec's `author` with whitespace runs (line breaks included) collapsed to one space and git's
 * `<`/`>` delimiters stripped, so a stored name can't malform or add a trailer, or `undefined` when it's absent or either required field is blank -- an older
 * api, or a session with no owner on record. */
export function sanitizeAuthor(author: unknown): CommitAuthor | undefined {
  if (!author || typeof author !== "object") return undefined;
  const a = author as Record<string, unknown>;
  const clean = (v: unknown) =>
    typeof v === "string" ? v.replace(/[<>]/g, "").replace(/\s+/g, " ").trim() : "";
  const name = clean(a.name);
  const email = clean(a.email);
  if (!name || !email) return undefined;
  const login = clean(a.login).replace(/^@/, "");
  return login ? { name, email, login } : { name, email };
}

/** The two trailers that credit `author` on a cloud commit: `Co-authored-by` (GitHub shows their
 * avatar next to the bot's and counts the commit for them) and `On-behalf-of` (plain text for
 * anyone reading the log). None without an author: the bot alone. */
export function attributionTrailers(author: CommitAuthor | undefined): string[] {
  if (!author) return [];
  const who = `${author.name} <${author.email}>`;
  return [`Co-authored-by: ${who}`, `On-behalf-of: ${who}`];
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
 * stdout/stderr, since `authHeaderEnv`'s header no longer appears in the URL we log via
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

export interface PushSpec {
  /** The clone URL from run.spec -- never read back from the workspace's own (agent-writable)
   * `remote.origin.url`. */
  remoteUrl: string;
  branch: string;
  githubToken?: string;
}

export interface GitOps {
  clone(spec: CloneSpec, dest: string): Promise<void>;
  /** Stages and commits everything as agentd's own checkpoint commit: the Outfitter bot is both
   * author and committer, and each of `trailers` is appended unless the message already has it. */
  commitAll(cwd: string, message: string, trailers?: string[]): Promise<{ committed: boolean }>;
  /** Pushes HEAD to `spec.branch` when it differs from the last known remote state of that branch
   * (or the remote branch isn't known yet), whoever made the commits -- agentd's own checkpoint
   * commit or the agent itself. `pushed` is false when there was nothing to send. */
  push(cwd: string, spec: PushSpec): Promise<{ head: string; pushed: boolean }>;
  diff(cwd: string, base: string): Promise<string>;
}

export interface GitOpsOptions {
  /** The user that owns the workspace after the clone (the `agent` user pi runs as, when agentd is
   * root). Every local git command after the clone runs as this user, with its HOME, so git never
   * runs as root inside a repository the model controls (see module doc). Omitted when agentd isn't
   * root: everything runs as agentd's own user, as before. */
  runAs?: ExecAs & { home: string };
  /** Parent directory for the private push repository; defaults to os.tmpdir(). */
  pushRoot?: string;
}

/** The remote-tracking ref for a session branch. The clone is `--single-branch` on the base branch;
 * clone() adds the session branch to origin's fetch refspec and names it explicitly when fetching,
 * and push() moves it itself after a successful push (push only updates tracking refs for the
 * `origin` remote, and agentd pushes to a URL). */
function trackingRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

export function createGitOps(exec: ExecFn = defaultExec, options: GitOpsOptions = {}): GitOps {
  const runAs = options.runAs;
  const localEnv: Record<string, string> = runAs ? { HOME: runAs.home } : {};
  let pushRepo: Promise<string> | undefined;

  /** A local git command in the workspace, as the workspace's own user. */
  async function run(cwd: string, args: string[], env: Record<string, string> = {}): Promise<ExecResult> {
    return exec("git", args, cwd, { ...localEnv, ...env }, runAs && { uid: runAs.uid, gid: runAs.gid });
  }

  /** agentd's private push repository: a root-owned (mode 0700, from mkdtemp) bare repo whose only
   * link to the workspace is the alternates file push() writes. Created once per GitOps. */
  function ensurePushRepo(): Promise<string> {
    pushRepo ??= (async () => {
      const dir = await mkdtemp(join(options.pushRoot ?? tmpdir(), "agentd-push-"));
      const init = await exec("git", ["init", "--bare", "--quiet", dir], dir, {});
      if (init.code !== 0) throw new Error(`git init --bare ${dir} failed: ${init.stderr.trim()}`);
      // Borrow the workspace's objects but never its refs: by default git lists an alternate's refs
      // by running `git for-each-ref` *inside* the (agent-owned) alternate repository.
      const cfg = await exec("git", ["config", "core.alternateRefsCommand", "true"], dir, { GIT_DIR: dir });
      if (cfg.code !== 0) throw new Error(`git config in ${dir} failed: ${cfg.stderr.trim()}`);
      return dir;
    })();
    return pushRepo;
  }

  return {
    async clone(spec, dest) {
      const authEnv = authHeaderEnv(spec.cloneUrl, spec.githubToken);
      const cloneArgs = ["clone", "--branch", spec.baseBranch, "--single-branch", spec.cloneUrl, dest];
      const cloned = await exec("git", cloneArgs, process.cwd(), authEnv);
      if (cloned.code !== 0) {
        throw new Error(
          `git clone failed (${redactUrl(spec.cloneUrl)}): ${redactToken(cloned.stderr.trim(), spec.githubToken)}`,
        );
      }
      // Still root, still before the caller chowns dest to the workspace user: agentd owns this repo.
      // Map the session branch in origin's fetch refspec too (the single-branch clone maps only the
      // base branch), so its tracking ref resolves as the upstream push() sets, and a plain
      // `git fetch` keeps it current.
      const refspec = `+refs/heads/${spec.branch}:${trackingRef(spec.branch)}`;
      const mapped = await exec("git", ["config", "--add", "remote.origin.fetch", refspec], dest);
      if (mapped.code !== 0) {
        throw new Error(`git config --add remote.origin.fetch ${refspec} failed: ${mapped.stderr.trim()}`);
      }
      if (spec.createBranch) {
        const created = await exec("git", ["checkout", "-b", spec.branch], dest);
        if (created.code !== 0) {
          throw new Error(`git checkout -b ${spec.branch} failed: ${created.stderr.trim()}`);
        }
      } else {
        // The explicit refspec, not just the branch name: `git fetch origin <branch>` on a
        // single-branch clone lands in FETCH_HEAD alone and never creates origin/<branch> for the
        // checkout below (which failed every resumed session before this).
        const fetched = await exec("git", ["fetch", "origin", refspec], dest, authEnv);
        if (fetched.code !== 0) {
          throw new Error(
            `git fetch origin ${refspec} failed: ${redactToken(fetched.stderr.trim(), spec.githubToken)}`,
          );
        }
        const checked = await exec("git", ["checkout", "-B", spec.branch, trackingRef(spec.branch)], dest);
        if (checked.code !== 0) {
          throw new Error(`git checkout ${spec.branch} failed: ${checked.stderr.trim()}`);
        }
      }
    },

    async commitAll(cwd, message, trailers = []) {
      const add = await run(cwd, ["add", "-A"]);
      if (add.code !== 0) throw new Error(`git add -A failed: ${add.stderr.trim()}`);
      const status = await run(cwd, ["status", "--porcelain"]);
      if (status.stdout.trim().length === 0) return { committed: false };
      // --no-verify: a checkpoint is a snapshot, and must not be blocked (or run) by hooks the agent
      // installed. trailer.ifExists=doNothing: a `checkpoint` down-message whose text already
      // carries one of the trailers doesn't get it twice.
      const trailerArgs = trailers.flatMap((t) => ["--trailer", t]);
      const commit = await run(cwd, ["commit", "--no-verify", "-m", message, ...trailerArgs], {
        ...gitConfigEnv([["trailer.ifexists", "doNothing"]]),
        ...botIdentityEnv(),
      });
      if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
      return { committed: true };
    },

    async push(cwd, spec) {
      const { remoteUrl, branch, githubToken } = spec;
      const headRes = await run(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
      if (headRes.code !== 0) throw new Error(`git rev-parse HEAD failed: ${headRes.stderr.trim()}`);
      const head = headRes.stdout.trim();
      const known = await run(cwd, ["rev-parse", "--verify", "--quiet", `${trackingRef(branch)}^{commit}`]);
      if (known.code === 0 && known.stdout.trim() === head) return { head, pushed: false };

      const pushDir = await ensurePushRepo();
      await mkdir(join(pushDir, "objects", "info"), { recursive: true });
      await writeFile(join(pushDir, "objects", "info", "alternates"), `${resolve(cwd, ".git", "objects")}\n`);
      // The exact commit read above, not HEAD: a mid-turn checkpoint can race the agent's next
      // commit, and the tracking ref recorded below must be what the remote actually has.
      const push = await exec(
        "git",
        ["push", "--quiet", remoteUrl, `${head}:refs/heads/${branch}`],
        pushDir,
        { GIT_DIR: pushDir, ...authHeaderEnv(remoteUrl, githubToken) },
      );
      if (push.code !== 0) {
        throw new Error(
          `git push ${redactUrl(remoteUrl)} ${head}:${branch} failed: ${redactToken(push.stderr.trim(), githubToken)}`,
        );
      }
      // A push to a URL (not to `origin`) moves no tracking ref by itself; record what the remote now
      // has, and the upstream `push -u` would have set, for the agent's own `git status`.
      for (const args of [
        ["update-ref", trackingRef(branch), head],
        ["config", `branch.${branch}.remote`, "origin"],
        ["config", `branch.${branch}.merge`, `refs/heads/${branch}`],
      ]) {
        const res = await run(cwd, args);
        if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
      }
      return { head, pushed: true };
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
  };
}
