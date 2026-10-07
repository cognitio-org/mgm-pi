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
 * `clone` does only its network part as root (a `--no-checkout` clone and the session branch's
 * fetch, before the workspace is handed over); the checkout itself runs as the workspace's user.
 * Root owns the workspace directory for exactly that window (`takeOver`), because git refuses to
 * discover a repository whose worktree belongs to another uid.
 *
 * The push repository never reads anything out of /workspace directly. It is seeded from the
 * pristine clone while that is still root's own, and each push takes the session's new commits as a
 * *bundle* the agent side writes, imported with `transfer.fsckObjects` -- the input path git hardens
 * for untrusted data, the same one a fetch from an untrusted remote goes through.
 */
import { execFile } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { constants, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
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
  opts?: ExecOptions,
) => Promise<ExecResult>;

export interface ExecOptions {
  /** Linux uid/gid to run the child as (see GitOpsOptions.runAs). */
  uid?: number;
  gid?: number;
  /** Use `env` as the child's whole environment instead of an overlay on agentd's process.env
   * (which carries RUN_TOKEN and friends). */
  isolatedEnv?: boolean;
  /** Kill the child after this long; it then reports a non-zero code. */
  timeoutMs?: number;
}

export async function defaultExec(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      env: opts.isolatedEnv ? env ?? {} : env ? { ...process.env, ...env } : process.env,
      maxBuffer: 64 * 1024 * 1024,
      ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
      ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const } : {}),
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
  return [["http.extraheader", `AUTHORIZATION: basic ${authHeaderSecret(token)}`]];
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

/** run.spec's `author` with control characters (line breaks, NUL) and git's `<`/`>` delimiters
 * blanked and whitespace collapsed, so a stored name can't malform or add a trailer (or, with a NUL,
 * make every execFile/spawn that carries it throw), or `undefined` when it's absent or either required field is blank -- an older
 * api, or a session with no owner on record. */
export function sanitizeAuthor(author: unknown): CommitAuthor | undefined {
  if (!author || typeof author !== "object") return undefined;
  const a = author as Record<string, unknown>;
  const clean = (v: unknown) =>
    typeof v === "string" ? v.replace(/[\x00-\x1f\x7f<>]/g, " ").replace(/\s+/g, " ").trim() : "";
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
  for (const secret of [token, authHeaderSecret(token)]) text = text.split(secret).join("<redacted>");
  return text;
}

/** The base64 credential authConfigEntries puts in the header -- what a trace of git's HTTP traffic
 * would show instead of the raw token. Register it with the logger alongside the token. */
export function authHeaderSecret(token: string): string {
  return Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
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
  /** Pushes HEAD to `spec.branch` when it differs from what agentd last saw on origin for that branch
   * (clone's fetch, or its own last push), whoever made the commits -- agentd's own checkpoint
   * commit or the agent itself, amended or rebased included. `pushed` is false when there was
   * nothing to send. */
  push(cwd: string, spec: PushSpec): Promise<{ head: string; pushed: boolean }>;
  diff(cwd: string, base: string): Promise<string>;
  /** The checked-out branch, or null when HEAD is detached. Absent in tests that keep v1 push behavior. */
  headBranch?(cwd: string): Promise<string | null>;
  /** The commit at `refs/heads/<branch>`, or undefined when that branch is absent. */
  tip?(cwd: string, branch: string): Promise<string | undefined>;
}

export interface GitOpsOptions {
  /** The user that owns the workspace after the clone (the `agent` user pi runs as, when agentd is
   * root). Every local git command after the clone runs as this user, with its HOME, so git never
   * runs as root inside a repository the model controls (see module doc). Omitted when agentd isn't
   * root: everything runs as agentd's own user, as before. */
  runAs?: { uid: number; gid: number; home: string };
  /** Parent directory for the private push repository; defaults to os.tmpdir(). */
  pushRoot?: string;
  /** Takes the (empty) workspace directory for agentd itself before the clone -- main.ts's chown to
   * root. The sandbox image creates /workspace owned by the `agent` user, and while `git clone` can
   * still write there, every root git command *after* it has to discover an existing repository
   * whose worktree belongs to another uid, which git >= 2.35.2 refuses ("not in a git directory"
   * from `git config`). Owning the directory for the clone's duration keeps that path honest
   * without `safe.directory`. */
  takeOver?: (dir: string) => Promise<void>;
  /** Hands the freshly cloned (not yet checked out) repository to `runAs` -- main.ts's recursive
   * chown. clone() calls it between the root-side network steps and the checkout, so root never
   * checks out (parses .gitattributes, writes) a tree that may have been authored by an earlier
   * session's agent. */
  handOver?: (dir: string) => Promise<void>;
}

/** Local (workspace-user) git commands and pushes get killed after this long: the agent can make
 * git block forever (a FIFO where an object should be), which would otherwise stall every later
 * checkpoint, including the SIGTERM one. */
const GIT_TIMEOUT_MS = 120_000;

/** What local git sees of agentd's environment: just enough to run, never RUN_TOKEN and friends.
 * GIT_CONFIG_GLOBAL/NOSYSTEM pass through so tests (and operators) can pin git's own config. */
const LOCAL_ENV_PASSTHROUGH = ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** #499: the most of a `diff.result` patch agentd sends. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** Cuts a patch at the last file boundary (`diff --git`/`diff --cc`) at or under `maxBytes`, so no
 * file is sent half-written. `truncated` when anything was cut. */
export function capPatch(patch: string, maxBytes = MAX_DIFF_BYTES): { patch: string; truncated: boolean } {
  const bytes = Buffer.from(patch, "utf8");
  if (bytes.length <= maxBytes) return { patch, truncated: false };
  const head = bytes.subarray(0, maxBytes).toString("utf8");
  const cut = Math.max(head.lastIndexOf("\ndiff --git "), head.lastIndexOf("\ndiff --cc "));
  return { patch: cut > 0 ? head.slice(0, cut + 1) : "", truncated: true };
}

/** Where the agent side stages the commit to push, and the bundle it hands to root. Both live in
 * the workspace's own .git (the agent owns it) and are removed again after each push. */
const PUSH_REF = "refs/outfitter/push";
const BUNDLE_NAME = "outfitter-push.bundle";

/** Copies `from` to `to` without ever following a symlink at `from`, and refusing anything that
 * isn't a regular file. `from` lives in the agent-owned workspace, so a path check followed by a
 * separate open (git's) is a race the agent can win; this opens once and copies from that handle. */
async function copyNoFollow(from: string, to: string): Promise<void> {
  let src;
  try {
    src = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err: any) {
    // ELOOP: the path was a symlink at open time.
    if (err?.code === "ELOOP") throw new Error(`${from} is not a plain file; refusing to push from it`);
    throw err;
  }
  const st = await src.stat();
  if (!st.isFile()) {
    await src.close();
    throw new Error(`${from} is not a plain file; refusing to push from it`);
  }
  // Both streams close their handles when the pipeline ends.
  await pipeline(src.createReadStream(), createWriteStream(to, { mode: 0o600 }));
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
  const localEnv: Record<string, string> = {};
  for (const key of LOCAL_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) localEnv[key] = value;
  }
  const home = runAs?.home ?? process.env.HOME;
  if (home) localEnv.HOME = home;
  let pushRepo: Promise<string> | undefined;
  /** What agentd itself last saw on origin for each session branch -- from the clone's fetch or its
   * own last push. Kept here, root-side, rather than read back from the workspace's
   * (agent-writable) tracking ref; it decides both whether to push and the push's lease. */
  const remoteHead = new Map<string, string>();

  /** A local git command in the workspace, as the workspace's own user, with a minimal environment
   * (whatever it runs -- a hook, fsmonitor -- is the agent's code). */
  async function run(cwd: string, args: string[], env: Record<string, string> = {}): Promise<ExecResult> {
    return exec("git", args, cwd, { ...localEnv, ...env }, {
      ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
      isolatedEnv: true,
      timeoutMs: GIT_TIMEOUT_MS,
    });
  }

  /** What the push repository already has, as `--not` arguments for the agent's bundle: the base
   * branch it was seeded with at clone time, plus whatever was last pushed. Keeps each bundle to the
   * session's new commits instead of the whole history. */
  async function excludesFor(pushDir: string, known: string | undefined): Promise<string[]> {
    const tips = await exec("git", ["for-each-ref", "--format=%(objectname)", "refs/remotes/origin/"], pushDir, {
      GIT_DIR: pushDir,
    });
    const shas = new Set<string>();
    if (tips.code === 0) {
      for (const sha of tips.stdout.split("\n").map((l) => l.trim())) if (SHA_RE.test(sha)) shas.add(sha);
    }
    if (known) shas.add(known);
    return [...shas].flatMap((sha) => ["--not", sha]);
  }

  /** agentd's private push repository: a root-owned (mode 0700, from mkdtemp) bare repo whose only
   * link to the workspace is the alternates file push() writes. Created once per GitOps. */
  function ensurePushRepo(): Promise<string> {
    pushRepo ??= createPushRepo().catch((err) => {
      pushRepo = undefined; // let the next checkpoint retry rather than failing forever
      throw err;
    });
    return pushRepo;
  }

  async function createPushRepo(): Promise<string> {
    const dir = await mkdtemp(join(options.pushRoot ?? tmpdir(), "agentd-push-"));
    const init = await exec("git", ["init", "--bare", "--quiet", dir], dir, {});
    if (init.code !== 0) throw new Error(`git init --bare ${dir} failed: ${init.stderr.trim()}`);
    // Everything the agent's repository could feed this one arrives as a bundle, imported with
    // transfer.fsckObjects (see push); nothing here ever points into /workspace.
    const cfg = await exec("git", ["config", "transfer.fsckObjects", "true"], dir, { GIT_DIR: dir });
    if (cfg.code !== 0) throw new Error(`git config transfer.fsckObjects in ${dir} failed: ${cfg.stderr.trim()}`);
    return dir;
  }

  return {
    async clone(spec, dest) {
      // Root does only the network part, into a repo nobody else can touch yet: clone without a
      // checkout, map and fetch the session branch. The checkout -- parsing a tree an earlier
      // session's agent may have written -- happens after handOver, as the workspace's own user.
      // The image creates /workspace owned by the user pi runs as; root's post-clone git commands
      // would then fail the ownership check (see GitOpsOptions.takeOver).
      await options.takeOver?.(dest);
      const authEnv = authHeaderEnv(spec.cloneUrl, spec.githubToken);
      const cloneArgs = ["clone", "--no-checkout", "--branch", spec.baseBranch, "--single-branch", spec.cloneUrl, dest];
      const cloned = await exec("git", cloneArgs, process.cwd(), authEnv);
      if (cloned.code !== 0) {
        throw new Error(
          `git clone failed (${redactUrl(spec.cloneUrl)}): ${redactToken(cloned.stderr.trim(), spec.githubToken)}`,
        );
      }
      // Map the session branch in origin's fetch refspec too (the single-branch clone maps only the
      // base branch), so its tracking ref resolves as the upstream push() sets, and a plain
      // `git fetch` keeps it current.
      const refspec = `+refs/heads/${spec.branch}:${trackingRef(spec.branch)}`;
      const mapped = await exec("git", ["config", "--add", "remote.origin.fetch", refspec], dest);
      if (mapped.code !== 0) {
        throw new Error(`git config --add remote.origin.fetch ${refspec} failed: ${mapped.stderr.trim()}`);
      }
      // The explicit refspec, not just the branch name: `git fetch origin <branch>` on a
      // single-branch clone lands in FETCH_HEAD alone and never creates origin/<branch> for the
      // checkout below (which failed every resumed session before this). Fetched even when
      // createBranch says the session is new: the api infers that from "no checkpoint recorded",
      // which a push whose checkpoint frame never arrived makes wrong, and starting over from the
      // base branch would then leave every later push non-fast-forward.
      const fetched = await exec("git", ["fetch", "origin", refspec], dest, authEnv);
      let start: string;
      if (fetched.code === 0) {
        const tip = await exec("git", ["rev-parse", "--verify", `${trackingRef(spec.branch)}^{commit}`], dest);
        if (tip.code !== 0) throw new Error(`git rev-parse ${trackingRef(spec.branch)} failed: ${tip.stderr.trim()}`);
        remoteHead.set(spec.branch, tip.stdout.trim());
        start = trackingRef(spec.branch);
      } else if (spec.createBranch) {
        // No such branch on origin yet (the clone itself just authenticated fine): a new session.
        start = `refs/remotes/origin/${spec.baseBranch}`;
      } else {
        throw new Error(
          `git fetch origin ${refspec} failed: ${redactToken(fetched.stderr.trim(), spec.githubToken)}`,
        );
      }
      // Seed the push repository from this clone while it is still agentd's own: these objects came
      // straight from GitHub, so root can read them safely, and every later push then only has to
      // carry the session's own new commits.
      const pushDir = await ensurePushRepo();
      const seeded = await exec(
        "git",
        ["fetch", "--quiet", dest, "+refs/remotes/origin/*:refs/remotes/origin/*"],
        pushDir,
        { GIT_DIR: pushDir },
      );
      if (seeded.code !== 0) throw new Error(`seeding the push repository failed: ${seeded.stderr.trim()}`);

      await options.handOver?.(dest);
      const checked = await run(dest, ["checkout", "--quiet", "-f", "-B", spec.branch, start]);
      if (checked.code !== 0) {
        throw new Error(`git checkout ${spec.branch} failed: ${checked.stderr.trim()}`);
      }
    },

    async commitAll(cwd, message, trailers = []) {
      const add = await run(cwd, ["add", "-A"]);
      if (add.code !== 0) throw new Error(`git add -A failed: ${add.stderr.trim()}`);
      const status = await run(cwd, ["status", "--porcelain"]);
      if (status.stdout.trim().length === 0) return { committed: false };
      // A checkpoint is a snapshot, and must not be blocked (or run) by anything the agent put in its
      // repo config: no hooks at all (--no-verify alone still runs prepare-commit-msg), no signing.
      // trailer.ifExists=addIfDifferent: a `checkpoint` down-message whose text already carries
      // exactly one of the trailers doesn't get it twice, but another person's Co-authored-by
      // doesn't suppress this one.
      const trailerArgs = trailers.flatMap((t) => ["--trailer", t]);
      const commit = await run(cwd, ["commit", "--no-verify", "-m", message, ...trailerArgs], {
        ...gitConfigEnv([
          ["trailer.ifexists", "addIfDifferent"],
          ["core.hooksPath", "/dev/null"],
          ["commit.gpgsign", "false"],
        ]),
        ...botIdentityEnv(),
      });
      if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
      return { committed: true };
    },

    async push(cwd, spec) {
      const { remoteUrl, branch, githubToken } = spec;
      // The branch tip, not HEAD: a checkpoint can race a switch, and publishing HEAD would
      // write the other branch's commit onto this ref.
      const headRes = await run(cwd, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
      if (headRes.code !== 0) throw new Error(`git rev-parse refs/heads/${branch} failed: ${headRes.stderr.trim()}`);
      const head = headRes.stdout.trim();
      // Output of a process running agent-controlled code; it's about to go on root's argv.
      if (!SHA_RE.test(head)) throw new Error(`git rev-parse refs/heads/${branch} returned something other than a commit id`);
      let known = remoteHead.get(branch);
      if (known === undefined) {
        const pushDir = await ensurePushRepo();
        const listed = await exec(
          "git",
          ["ls-remote", "--heads", remoteUrl, `refs/heads/${branch}`],
          pushDir,
          { GIT_DIR: pushDir, ...authHeaderEnv(remoteUrl, githubToken) },
          { timeoutMs: GIT_TIMEOUT_MS },
        );
        if (listed.code !== 0) {
          throw new Error(
            `git ls-remote ${redactUrl(remoteUrl)} refs/heads/${branch} failed: ${redactToken(listed.stderr.trim(), githubToken)}`,
          );
        }
        const sha = listed.stdout.trim().split(/\s+/)[0] ?? "";
        if (sha) {
          if (!SHA_RE.test(sha)) throw new Error(`git ls-remote returned something other than a commit id`);
          remoteHead.set(branch, sha);
          known = sha;
        }
      }
      if (known === head) return { head, pushed: false };

      const pushDir = await ensurePushRepo();
      // The agent side hands over exactly the new history, as a bundle: root never opens the
      // workspace's own object store (its packs, loose objects, alternates chain or graph files),
      // only this one file, and only through git's fsck-checked import path.
      // Already here (the base commit the seed brought in, or something a previous push imported)?
      // Then there is nothing for the agent side to hand over.
      const present = await exec("git", ["cat-file", "-e", `${head}^{commit}`], pushDir, { GIT_DIR: pushDir });
      if (present.code !== 0) {
        const bundle = resolve(cwd, ".git", BUNDLE_NAME);
        const staged = await run(cwd, ["update-ref", PUSH_REF, head]);
        if (staged.code !== 0) throw new Error(`git update-ref ${PUSH_REF} failed: ${staged.stderr.trim()}`);
        const handover = join(pushDir, BUNDLE_NAME);
        try {
          // `--not` what the push repo already has, so the bundle is just this session's new commits.
          // If any of those objects is missing from the workspace (the agent can prune its own
          // repo), fall back to a self-contained bundle rather than failing every later checkpoint.
          let bundled = await run(cwd, ["bundle", "create", bundle, PUSH_REF, ...(await excludesFor(pushDir, known))]);
          if (bundled.code !== 0) {
            await rm(bundle, { force: true });
            bundled = await run(cwd, ["bundle", "create", bundle, PUSH_REF]);
          }
          if (bundled.code !== 0) throw new Error(`git bundle create failed: ${bundled.stderr.trim()}`);
          // Copy it into the push repo before root's git ever opens it, refusing to follow a symlink
          // (O_NOFOLLOW): the file itself sits in the agent's .git, so the path it names could be
          // swapped between any check and git's own open.
          await copyNoFollow(bundle, handover);
          const imported = await exec(
            "git",
            ["fetch", "--quiet", handover, `+${PUSH_REF}:${PUSH_REF}`],
            pushDir,
            { GIT_DIR: pushDir },
            { timeoutMs: GIT_TIMEOUT_MS },
          );
          if (imported.code !== 0) throw new Error(`importing the agent's bundle failed: ${imported.stderr.trim()}`);
        } finally {
          await rm(bundle, { force: true });
          await rm(handover, { force: true });
          await run(cwd, ["update-ref", "-d", PUSH_REF]);
        }
        // What was imported must be the commit the checkpoint decided to push, whatever the bundle said.
        const importedHead = await exec("git", ["rev-parse", "--verify", `${PUSH_REF}^{commit}`], pushDir, {
          GIT_DIR: pushDir,
        });
        if (importedHead.code !== 0 || importedHead.stdout.trim() !== head) {
          throw new Error(`the agent's bundle did not contain ${head}`);
        }
      }

      // The exact commit read above, not HEAD: a mid-turn checkpoint can race the agent's next
      // commit, and the tracking ref recorded below must be what the remote actually has.
      // --force-with-lease against what agentd last saw there (empty: the branch must not exist yet):
      // the agent may amend or rebase its own session branch, which a plain push would reject as
      // non-fast-forward on every checkpoint from then on, but anyone else's push to it still wins.
      const push = await exec(
        "git",
        ["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${known ?? ""}`, remoteUrl, `${head}:refs/heads/${branch}`],
        pushDir,
        { GIT_DIR: pushDir, ...authHeaderEnv(remoteUrl, githubToken) },
        { timeoutMs: GIT_TIMEOUT_MS },
      );
      if (push.code !== 0) {
        throw new Error(
          `git push ${redactUrl(remoteUrl)} ${head}:${branch} failed: ${redactToken(push.stderr.trim(), githubToken)}`,
        );
      }
      remoteHead.set(branch, head);
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

    async headBranch(cwd) {
      const res = await run(cwd, ["symbolic-ref", "--short", "HEAD"]);
      if (res.code !== 0) return null;
      const name = res.stdout.trim();
      return name || null;
    },

    async tip(cwd, branch) {
      if (!branch || /[\s\0]/.test(branch)) return undefined;
      const res = await run(cwd, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
      if (res.code !== 0) return undefined;
      const sha = res.stdout.trim();
      return SHA_RE.test(sha) ? sha : undefined;
    },

    async diff(cwd, base) {
      // #499: one diff from the merge-base to the working tree covers the branch's commits and the
      // uncommitted edits together, so each file appears once, with hunks numbered against one base.
      // `--end-of-options`: `base` is a ref name, never an option.
      // The base may exist only as origin's tracking ref in this clone. Neither found: HEAD (the
      // uncommitted edits only), which is what a branch with no base to compare to has.
      let from = "HEAD";
      for (const ref of [base, `refs/remotes/origin/${base}`]) {
        const mergeBase = await run(cwd, ["merge-base", "--end-of-options", ref, "HEAD"]);
        const sha = mergeBase.stdout.trim();
        if (mergeBase.code === 0 && SHA_RE.test(sha)) {
          from = sha;
          break;
        }
      }
      const tracked = await run(cwd, ["diff", from]);
      const parts = [tracked.stdout];
      let size = Buffer.byteLength(tracked.stdout);
      // -z: unquoted paths, so names with spaces or odd bytes come through intact. -uall: files
      // inside a new directory are listed one by one, not as the directory.
      const untracked = await run(cwd, ["status", "--porcelain=v1", "-z", "-uall"]);
      const untrackedFiles = untracked.stdout
        .split("\0")
        .filter((l) => l.startsWith("?? "))
        .map((l) => l.slice(3));
      for (const f of untrackedFiles) {
        // Past the cap the rest would only be cut off again (capPatch, run.ts's handleDiff).
        if (size > MAX_DIFF_BYTES) break;
        // `--`: an untracked file named like an option (`--output=...`) must stay a path.
        const d = await run(cwd, ["diff", "--no-index", "--", "/dev/null", f]);
        // git diff --no-index exits 1 when there is a difference (expected here); only bail on real errors.
        if ((d.code === 0 || d.code === 1) && d.stdout) {
          parts.push(d.stdout);
          size += Buffer.byteLength(d.stdout);
        }
      }
      return parts.filter(Boolean).join("\n");
    },
  };
}
