/**
 * Git, once, for every kernal extension that touches a repository (kernal-github's tools and
 * commands, teleport's clean-tree and pushed-branch checks). Nothing here shells out through a
 * shell string: every call is an argument array, so a branch or path named like an option, or
 * holding a space or a quote, is still just a name.
 *
 * Process hygiene, for the reasons kernal already learned the hard way:
 *  - stdin is closed and `GIT_TERMINAL_PROMPT=0`, so git can never sit waiting for a password on a
 *    machine with no one watching (the same class of hang as pi's own `-p` stdin wait);
 *  - every call has a timeout, because a hook, a filter or a credential helper can block forever;
 *  - reads pass `GIT_OPTIONAL_LOCKS=0`, so a status while another git holds the index lock reports
 *    instead of failing;
 *  - output is capped, so a repository with a pathological diff cannot exhaust memory;
 *  - `LC_ALL=C` only for the calls whose output is parsed, so porcelain stays machine-readable.
 *
 * Errors: every function returns a result, never throws for an ordinary git failure ("not a
 * repository", "nothing to commit", a rejected push). Callers decide what to say. A thrown error
 * means git could not be run at all.
 */
import { execFile } from "node:child_process";

export type GitResult = { stdout: string; stderr: string; code: number; timedOut?: boolean };

export type GitRunOptions = {
  cwd: string;
  /** Default 30 s; network calls pass their own. */
  timeoutMs?: number;
  /** Written to git's stdin and then closed (a commit message, so it never goes on argv). */
  stdin?: string;
  /** Extra config for this call only, as `-c key=value` pairs. */
  config?: [string, string][];
  /** Reads set this: `GIT_OPTIONAL_LOCKS=0` and `LC_ALL=C`. */
  read?: boolean;
};

const MAX_OUTPUT = 32 * 1024 * 1024;

/** Runs one git command. Never throws for a non-zero exit; `code` says what happened. */
export function runGit(args: string[], opts: GitRunOptions): Promise<GitResult> {
  const config = (opts.config ?? []).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    ...(opts.read ? { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } : {}),
  };
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...config, ...args],
      { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 30_000, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT, encoding: "utf8" },
      (err: any, stdout: string, stderr: string) => {
        if (err && (err.code === "ENOENT" || err.code === "EACCES")) return reject(new Error("git is not installed, or not on PATH"));
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: typeof err?.code === "number" ? err.code : err ? 1 : 0,
          timedOut: err?.killed === true || err?.signal === "SIGKILL" || undefined,
        });
      },
    );
    child.stdin?.end(opts.stdin ?? "");
  });
}

/** stdout trimmed when the command succeeded, undefined otherwise. */
export async function gitValue(args: string[], opts: GitRunOptions): Promise<string | undefined> {
  const r = await runGit(args, { read: true, ...opts });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

// ---------- where we are ----------

/** The working tree's root, or undefined when `cwd` is not inside a git repository. */
export const repoRoot = (cwd: string) => gitValue(["rev-parse", "--show-toplevel"], { cwd });

export type Remote = { name: string; url: string; host?: string; owner?: string; repo?: string; github: boolean };

/**
 * Splits a remote URL into host, owner and repo. Handles the https form kernal supports, and
 * recognises (without supporting) the scp-like `git@host:owner/repo.git` and `ssh://` forms, so the
 * caller can say "SSH remotes are out of scope" instead of showing nothing.
 */
export function parseRemote(url: string): { host: string; owner: string; repo: string; ssh: boolean } | undefined {
  const clean = url.trim().replace(/\.git$/, "");
  const scp = /^[A-Za-z0-9._-]+@([^:/]+):([^/]+)\/(.+)$/.exec(clean);
  if (scp) return { host: scp[1], owner: scp[2], repo: scp[3], ssh: true };
  let u: URL;
  try { u = new URL(clean); } catch { return undefined; }
  const parts = u.pathname.replace(/^\//, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
  return { host: u.host, owner: parts[0], repo: parts[1], ssh: u.protocol === "ssh:" };
}

/** `origin` by default, with owner/repo parsed and whether it is a github.com https remote. */
export async function remote(cwd: string, name = "origin"): Promise<Remote | undefined> {
  const url = await gitValue(["remote", "get-url", name], { cwd });
  if (!url) return undefined;
  const parsed = parseRemote(url);
  return {
    name, url,
    host: parsed?.host, owner: parsed?.owner, repo: parsed?.repo,
    github: !!parsed && parsed.host === "github.com" && !parsed.ssh,
  };
}

// ---------- status ----------

export type FileChange = { path: string; from?: string; index: string; worktree: string };
export type Status = {
  root: string;
  branch?: string;            // undefined on a detached HEAD
  detached?: string;          // the commit it is on
  upstream?: string;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  conflicted: string[];
  stashes: number;
  lastCommit?: { sha: string; subject: string; author: string; relative: string };
  /** No staged, unstaged, untracked or conflicted entries. */
  clean: boolean;
  /** No commits yet. */
  unborn?: boolean;
};

/**
 * The whole working-tree picture in one call: `status --porcelain=v2 --branch -z`, plus the stash
 * count and the last commit. `-z` because a file name may contain a newline, a quote or a space,
 * and v2 because v1 cannot say how far ahead or behind the branch is.
 */
export async function status(cwd: string): Promise<Status | undefined> {
  const root = await repoRoot(cwd);
  if (!root) return undefined;
  const res = await runGit(["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"], { cwd: root, read: true });
  if (res.code !== 0) return undefined;
  const out: Status = { root, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], stashes: 0, clean: true };

  // Records are NUL-separated; a rename record is followed by its second path as its own record.
  const fields = res.stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i];
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) { const v = line.slice(13); if (v === "(initial)") out.unborn = true; else out.detached = v; continue; }
    if (line.startsWith("# branch.head ")) { const v = line.slice(14); if (v !== "(detached)") { out.branch = v; out.detached = undefined; } continue; }
    if (line.startsWith("# branch.upstream ")) { out.upstream = line.slice(18); continue; }
    if (line.startsWith("# branch.ab ")) {
      const m = /^\+(\d+) -(\d+)$/.exec(line.slice(12));
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
      continue;
    }
    if (line.startsWith("# ")) continue;
    const kind = line[0];
    if (kind === "?") { out.untracked.push(line.slice(2)); continue; }
    if (kind === "u") { out.conflicted.push(line.split(" ").slice(10).join(" ")); continue; }
    if (kind === "1" || kind === "2") {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const path = kind === "1" ? parts.slice(8).join(" ") : parts.slice(9).join(" ");
      const from = kind === "2" ? fields[++i] : undefined;   // the rename's source, its own record
      const change: FileChange = { path, from, index: xy[0], worktree: xy[1] };
      if (xy[0] !== ".") out.staged.push(change);
      if (xy[1] !== ".") out.unstaged.push(change);
    }
  }
  out.clean = !out.staged.length && !out.unstaged.length && !out.untracked.length && !out.conflicted.length;

  const stash = await gitValue(["stash", "list"], { cwd: root });
  out.stashes = stash ? stash.split("\n").filter(Boolean).length : 0;
  const last = await gitValue(["log", "-1", "--format=%H%x00%s%x00%an%x00%ar"], { cwd: root });
  if (last) {
    const [sha, subject, author, relative] = last.split("\0");
    out.lastCommit = { sha, subject, author, relative };
  }
  return out;
}

/**
 * The same two questions from raw git output, for callers that already ran the command themselves
 * (teleport's `/teleport` path and its standalone CLI). One definition of "dirty" and "needs
 * pushing" for every kernal extension.
 */
export const dirtyFromPorcelain = (porcelain: string): boolean => porcelain.trim().length > 0;

/** From `git status --porcelain=v2 --branch`: no upstream, or commits the upstream does not have. */
export function needsPushFromBranchStatus(branchStatus: string): boolean {
  if (!/^# branch\.upstream /m.test(branchStatus)) return true;
  const ab = branchStatus.match(/^# branch\.ab \+(\d+) -(\d+)/m);
  return ab ? Number(ab[1]) > 0 : false;
}

/** True when the working tree has nothing to commit and nothing untracked (teleport's check). */
export async function isClean(cwd: string): Promise<boolean> {
  const s = await status(cwd);
  return !!s?.clean;
}

/** Whether `branch`'s commit exists on its upstream, i.e. the branch is pushed (teleport's check). */
export async function isPushed(cwd: string): Promise<boolean> {
  const s = await status(cwd);
  return !!s && !!s.upstream && s.ahead === 0;
}

// ---------- writing ----------

export type CommitInput = { message: string; all?: boolean; paths?: string[]; trailers?: string[]; amend?: boolean };
export type CommitOutcome =
  | { ok: true; sha: string; subject: string; hookOutput?: string }
  | { ok: false; reason: "nothing-to-commit" | "hook-failed" | "identity" | "conflicted" | "error"; detail: string; hookOutput?: string };

/**
 * Stages what the caller names (never `git add .`: an agent that means one file should not sweep in
 * a half-finished change), then commits with the message on stdin, so a message with quotes,
 * newlines or a leading dash is never mangled on argv. Hooks are NOT skipped: a hook that rejects
 * the commit is the repository's rule, and its output comes back so the caller can act on it.
 */
export async function commit(cwd: string, input: CommitInput): Promise<CommitOutcome> {
  const root = (await repoRoot(cwd)) ?? cwd;
  const before = await status(root);
  if (before?.conflicted.length) return { ok: false, reason: "conflicted", detail: `unresolved conflicts in ${before.conflicted.join(", ")}` };
  if (input.paths?.length) {
    const add = await runGit(["add", "--", ...input.paths], { cwd: root });
    if (add.code !== 0) return { ok: false, reason: "error", detail: add.stderr.trim() || "git add failed" };
  } else if (input.all) {
    const add = await runGit(["add", "-A"], { cwd: root });
    if (add.code !== 0) return { ok: false, reason: "error", detail: add.stderr.trim() || "git add failed" };
  }
  const staged = await gitValue(["diff", "--cached", "--name-only"], { cwd: root });
  if (!input.amend && !staged) return { ok: false, reason: "nothing-to-commit", detail: "nothing is staged" };

  const message = withTrailers(input.message, input.trailers ?? []);
  const args = ["commit", "-F", "-", ...(input.amend ? ["--amend"] : [])];
  // A hook may edit the message; -F - plus no editor keeps that predictable.
  const res = await runGit(args, { cwd: root, stdin: message, timeoutMs: 120_000, config: [["core.editor", "true"]] });
  if (res.code !== 0) {
    const detail = (res.stderr + res.stdout).trim();
    if (/Author identity unknown|Please tell me who you are/i.test(detail)) return { ok: false, reason: "identity", detail };
    // git does not announce that a hook refused: a pre-commit hook's own output is all the caller
    // sees, and the exit code is the hook's. So ask whether this repository has a commit hook at
    // all, rather than looking for a word git never prints.
    if (await hasCommitHook(root)) return { ok: false, reason: "hook-failed", detail, hookOutput: detail };
    return { ok: false, reason: "error", detail };
  }
  const sha = (await gitValue(["rev-parse", "HEAD"], { cwd: root })) ?? "";
  const subject = (await gitValue(["log", "-1", "--format=%s"], { cwd: root })) ?? "";
  return { ok: true, sha, subject, hookOutput: res.stdout.trim() || undefined };
}

/** Whether this repository has an executable pre-commit or commit-msg hook (honouring core.hooksPath). */
export async function hasCommitHook(cwd: string): Promise<boolean> {
  const { access, constants } = await import("node:fs/promises");
  const { join, isAbsolute } = await import("node:path");
  const configured = await gitValue(["config", "--get", "core.hooksPath"], { cwd });
  const gitDir = (await gitValue(["rev-parse", "--absolute-git-dir"], { cwd })) ?? join(cwd, ".git");
  const dir = configured ? (isAbsolute(configured) ? configured : join(cwd, configured)) : join(gitDir, "hooks");
  for (const name of ["pre-commit", "commit-msg", "prepare-commit-msg"]) {
    try { await access(join(dir, name), constants.X_OK); return true; } catch { /* not this one */ }
  }
  return false;
}

/** Appends each trailer that is not already in the message, after a blank line. */
export function withTrailers(message: string, trailers: string[]): string {
  let out = message.replace(/\s+$/, "");
  const wanted = trailers.filter((t) => t.trim() && !out.includes(t.trim()));
  if (!wanted.length) return `${out}\n`;
  const lastBlock = out.split(/\n\s*\n/).pop() ?? "";
  const separator = /^[A-Za-z-]+: /m.test(lastBlock) ? "\n" : "\n\n";
  return `${out}${separator}${wanted.join("\n")}\n`;
}

export type PushOutcome =
  | { ok: true; branch: string; sha: string; setUpstream: boolean; alreadyUpToDate?: boolean }
  | { ok: false; reason: "no-upstream-remote" | "rejected" | "detached" | "error"; detail: string };

/**
 * Pushes the current branch's exact commit: `<sha>:refs/heads/<branch>` after `--`, so what is
 * pushed is what was just read, not whatever HEAD became. Never forced, and never `--force`: a
 * caller that means to overwrite its own branch passes `forceWithLease`, which still refuses if
 * someone else pushed in the meantime.
 */
export async function push(cwd: string, opts: { remote?: string; forceWithLease?: boolean } = {}): Promise<PushOutcome> {
  const root = (await repoRoot(cwd)) ?? cwd;
  const s = await status(root);
  if (!s) return { ok: false, reason: "error", detail: "not a git repository" };
  if (!s.branch) return { ok: false, reason: "detached", detail: `HEAD is detached at ${s.detached ?? "unknown"}; switch to a branch first` };
  const sha = await gitValue(["rev-parse", "HEAD"], { cwd: root });
  if (!sha) return { ok: false, reason: "error", detail: "this branch has no commits yet" };
  const name = opts.remote ?? "origin";
  const r = await remote(root, name);
  if (!r) return { ok: false, reason: "no-upstream-remote", detail: `this repository has no ${name} remote` };
  const setUpstream = !s.upstream;
  // `<sha>:refs/heads/<branch>`, not `HEAD` or the branch name: what is pushed is what was read a
  // line ago, even if something moves HEAD meanwhile. `--set-upstream` is NOT passed with it: git
  // silently declines to set an upstream when the source is a commit id rather than a branch (it
  // exits 0 and does nothing), so the tracking config is written explicitly after a first push.
  const args = [
    "push",
    ...(opts.forceWithLease ? [`--force-with-lease=refs/heads/${s.branch}`] : []),
    name, `${sha}:refs/heads/${s.branch}`,
  ];
  const res = await runGit(args, { cwd: root, timeoutMs: 15 * 60_000 });
  if (res.code !== 0) {
    const detail = (res.stderr + res.stdout).trim();
    if (/\[rejected\]|non-fast-forward|stale info|fetch first/i.test(detail)) return { ok: false, reason: "rejected", detail };
    return { ok: false, reason: "error", detail };
  }
  if (setUpstream) {
    // What `push -u` would have written, so the branch tracks origin and `git status` is right.
    await runGit(["config", `branch.${s.branch}.remote`, name], { cwd: root });
    await runGit(["config", `branch.${s.branch}.merge`, `refs/heads/${s.branch}`], { cwd: root });
  }
  const already = /Everything up-to-date/i.test(res.stderr + res.stdout);
  return { ok: true, branch: s.branch, sha, setUpstream, alreadyUpToDate: already || undefined };
}

export type PullOutcome =
  | { ok: true; changed: boolean; summary: string }
  | { ok: false; reason: "conflict" | "dirty" | "no-upstream" | "error"; detail: string; files?: string[] };

/** Fetch plus fast-forward by default, rebase on request. A conflict comes back as the file list. */
export async function pull(cwd: string, opts: { rebase?: boolean } = {}): Promise<PullOutcome> {
  const root = (await repoRoot(cwd)) ?? cwd;
  const before = await status(root);
  if (!before) return { ok: false, reason: "error", detail: "not a git repository" };
  if (!before.upstream) return { ok: false, reason: "no-upstream", detail: `${before.branch ?? "HEAD"} has no upstream branch; push it first` };
  if (!before.clean && opts.rebase) return { ok: false, reason: "dirty", detail: "commit or stash your changes before rebasing" };
  const head = await gitValue(["rev-parse", "HEAD"], { cwd: root });
  const res = await runGit(["pull", opts.rebase ? "--rebase" : "--ff-only"], { cwd: root, timeoutMs: 10 * 60_000 });
  if (res.code !== 0) {
    const detail = (res.stderr + res.stdout).trim();
    const after = await status(root);
    if (after?.conflicted.length) {
      return { ok: false, reason: "conflict", detail, files: after.conflicted };
    }
    return { ok: false, reason: "error", detail };
  }
  const now = await gitValue(["rev-parse", "HEAD"], { cwd: root });
  return { ok: true, changed: now !== head, summary: (res.stdout + res.stderr).trim() };
}

export type BranchInfo = { name: string; current: boolean; upstream?: string; lastCommit?: string };

export async function branches(cwd: string): Promise<BranchInfo[]> {
  const out = await gitValue(["for-each-ref", "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(contents:subject)", "refs/heads"], { cwd });
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((line) => {
    const [name, head, upstream, subject] = line.split("\0");
    return { name, current: head === "*", upstream: upstream || undefined, lastCommit: subject || undefined };
  });
}

export type BranchOutcome = { ok: true; branch: string; created: boolean } | { ok: false; detail: string };

/** Creates (optionally from `from`) and switches, or just switches. */
export async function switchBranch(cwd: string, name: string, opts: { create?: boolean; from?: string } = {}): Promise<BranchOutcome> {
  const root = (await repoRoot(cwd)) ?? cwd;
  const args = opts.create ? ["switch", "--create", name, ...(opts.from ? [opts.from] : [])] : ["switch", name];
  const res = await runGit(args, { cwd: root });
  if (res.code !== 0) return { ok: false, detail: (res.stderr + res.stdout).trim() };
  return { ok: true, branch: name, created: !!opts.create };
}

/** Branches already merged into `into`, never the current one and never the default branch. */
export async function mergedBranches(cwd: string, into: string): Promise<string[]> {
  const out = await gitValue(["branch", "--format=%(refname:short)", "--merged", into], { cwd });
  const current = (await status(cwd))?.branch;
  return (out ?? "").split("\n").map((b) => b.trim()).filter((b) => b && b !== into && b !== current);
}

export async function deleteBranch(cwd: string, name: string): Promise<{ ok: boolean; detail: string }> {
  const res = await runGit(["branch", "--delete", "--", name], { cwd });
  return { ok: res.code === 0, detail: (res.stderr + res.stdout).trim() };
}

export async function stashPush(cwd: string, message?: string, includeUntracked = true): Promise<{ ok: boolean; detail: string }> {
  const args = ["stash", "push", ...(includeUntracked ? ["--include-untracked"] : []), ...(message ? ["-m", message] : [])];
  const res = await runGit(args, { cwd });
  return { ok: res.code === 0, detail: (res.stderr + res.stdout).trim() };
}

export async function stashPop(cwd: string): Promise<{ ok: boolean; detail: string }> {
  const res = await runGit(["stash", "pop"], { cwd });
  return { ok: res.code === 0, detail: (res.stderr + res.stdout).trim() };
}

export type LogEntry = { sha: string; subject: string; author: string; relative: string };

export async function log(cwd: string, opts: { limit?: number; range?: string } = {}): Promise<LogEntry[]> {
  const args = ["log", `-${opts.limit ?? 10}`, "--format=%H%x00%s%x00%an%x00%ar"];
  if (opts.range) args.push(opts.range);
  const out = await gitValue(args, { cwd });
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((line) => {
    const [sha, subject, author, relative] = line.split("\0");
    return { sha, subject, author, relative };
  });
}

/** A diff, capped so a huge change cannot fill the model's context; `truncated` says it was cut. */
export async function diff(cwd: string, opts: { staged?: boolean; paths?: string[]; stat?: boolean; maxChars?: number } = {}): Promise<{ text: string; truncated: boolean }> {
  const args = ["diff", ...(opts.staged ? ["--cached"] : []), ...(opts.stat ? ["--stat"] : []), ...(opts.paths?.length ? ["--", ...opts.paths] : [])];
  const res = await runGit(args, { cwd, read: true, timeoutMs: 60_000 });
  const max = opts.maxChars ?? 60_000;
  const text = res.stdout;
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}
