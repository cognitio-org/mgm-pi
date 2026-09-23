/**
 * What the `git` tool and the `/git` command actually do, kept out of index.ts so every rule here is
 * unit-tested against a real temporary repository and a fake `gh`.
 *
 * The shape of the answers matters more than the commands. A model asking "where am I?" should get
 * one reply that already contains the branch, what changed, whether it is pushed, and what the pull
 * request and its checks say, because otherwise it runs five shell commands and guesses at the
 * output. That is `repoStatus`.
 */
import * as git from "../_shared/git.ts";
import { gh, ghJson, type Exec, execCommand } from "./gh.ts";

export type PrSummary = {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
  reviewDecision?: string;
  unresolvedThreads?: number;
  checks?: { passed: number; failed: number; pending: number; total: number };
};

export type RepoStatus = {
  repo?: { owner: string; repo: string; url: string; github: boolean; ssh?: boolean };
  git: git.Status;
  pr?: PrSummary;
  /** Set when the pull request could not be looked up (not signed in, no gh, no remote). */
  prUnavailable?: string;
};

type Ghe = { path: string; exec?: Exec } | undefined;

/** Check names in gh's rollup are a union; count them without caring which kind each is. */
export function rollup(nodes: any[] | undefined): PrSummary["checks"] {
  if (!Array.isArray(nodes) || !nodes.length) return undefined;
  let passed = 0, failed = 0, pending = 0;
  for (const n of nodes) {
    const state = String(n?.conclusion ?? n?.state ?? n?.status ?? "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state)) passed++;
    else if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"].includes(state)) failed++;
    else pending++;
  }
  return { passed, failed, pending, total: nodes.length };
}

/** `gh pr view --json` fields: exactly what gh offers. `reviewThreads` is NOT one of them (gh
 * refuses the whole call with "Unknown JSON field"), so unresolved threads come from the GraphQL
 * query below instead. */
const PR_FIELDS = "number,title,url,state,isDraft,reviewDecision,statusCheckRollup";

/** Unresolved review threads, which `gh pr view` cannot report. Best effort: a failure just omits them. */
export async function unresolvedThreads(cwd: string, prNumber: number, owner: string, repo: string, ghc: NonNullable<Ghe>): Promise<number | undefined> {
  const query = `query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100){nodes{isResolved}}}}}`;
  const data = await ghJson<any>(
    ghc.path,
    ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `pr=${prNumber}`],
    { cwd, timeoutMs: 30_000 }, ghc.exec ?? execCommand,
  );
  const nodes = data?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  return Array.isArray(nodes) ? nodes.filter((t: any) => t?.isResolved === false).length : undefined;
}

/**
 * The pull request for `branch`. Three different answers, which callers must not confuse: a pull
 * request, no pull request (gh says so), or "could not look it up" (no gh, signed out, offline,
 * rate-limited), which is what `unavailable` carries.
 */
export async function prFor(cwd: string, branch: string, ghc: Ghe, repo?: { owner: string; repo: string }): Promise<{ pr?: PrSummary; unavailable?: string }> {
  if (!ghc) return { unavailable: "the GitHub CLI is not installed; run /github setup" };
  const res = await gh(ghc.path, ["pr", "view", branch, "--json", PR_FIELDS], { cwd, timeoutMs: 30_000 }, ghc.exec ?? execCommand);
  if (!res.ok) {
    const detail = (res.stderr || res.stdout).trim();
    // gh's own way of saying there is none; everything else is a lookup that failed.
    if (/no pull requests? found|no open pull requests|could not resolve to a PullRequest/i.test(detail)) return {};
    const first = detail.split("\n").find((l) => l.trim()) ?? `gh exited ${res.code}`;
    return { unavailable: `the pull request could not be looked up: ${first.trim()}` };
  }
  let data: any;
  try { data = JSON.parse(res.stdout); } catch { return { unavailable: "gh returned something that is not JSON" }; }
  if (!data || typeof data.number !== "number") return {};
  const threads = repo ? await unresolvedThreads(cwd, data.number, repo.owner, repo.repo, ghc) : undefined;
  return {
    pr: {
      number: data.number,
      title: String(data.title ?? ""),
      url: String(data.url ?? ""),
      state: String(data.state ?? ""),
      isDraft: data.isDraft === true || undefined,
      reviewDecision: data.reviewDecision ? String(data.reviewDecision) : undefined,
      unresolvedThreads: threads,
      checks: rollup(data.statusCheckRollup),
    },
  };
}

/** Everything about where the working tree stands, in one call. */
export async function repoStatus(cwd: string, ghc: Ghe, opts: { pr?: boolean } = {}): Promise<RepoStatus | undefined> {
  const s = await git.status(cwd);
  if (!s) return undefined;
  const r = await git.remote(s.root);
  const out: RepoStatus = {
    git: s,
    repo: r && r.owner && r.repo
      ? { owner: r.owner, repo: r.repo, url: r.url, github: r.github, ssh: r.url.startsWith("git@") || r.url.startsWith("ssh://") || undefined }
      : undefined,
  };
  if (opts.pr !== false && s.branch && out.repo?.github) {
    const { pr, unavailable } = await prFor(s.root, s.branch, ghc, out.repo ? { owner: out.repo.owner, repo: out.repo.repo } : undefined);
    out.pr = pr;
    out.prUnavailable = unavailable;
  }
  return out;
}

// ---------- attribution ----------

export type Attribution = { commit: string; pr: string };

export const DEFAULT_ATTRIBUTION: Attribution = {
  commit: "Co-Authored-By: Kernal <noreply@kernal.invalid>",
  pr: "Opened with Kernal",
};

/**
 * `github.attribution.commit` / `.pr` in settings: a string replaces the default, an empty string
 * turns it off. The address is a reserved `.invalid` domain, never a `users.noreply.github.com`
 * one, which GitHub would credit to whichever account owns that name.
 */
export function attributionFrom(settings: any): Attribution {
  const a = settings?.github?.attribution;
  const pick = (v: unknown, fallback: string) => (typeof v === "string" ? v.trim() : fallback);
  return { commit: pick(a?.commit, DEFAULT_ATTRIBUTION.commit), pr: pick(a?.pr, DEFAULT_ATTRIBUTION.pr) };
}

/**
 * The trailers a cloud run adds on top: the Outfitter bot commits, and the session's person is
 * credited (kernal/docs/git-github-spec.md, "Attribution"). agentd pins OUTFITTER_AUTHOR_* into
 * this process's environment; on a laptop they are absent and this adds nothing.
 */
export function cloudTrailers(env: NodeJS.ProcessEnv = process.env): string[] {
  const name = env.OUTFITTER_AUTHOR_NAME?.trim();
  const email = env.OUTFITTER_AUTHOR_EMAIL?.trim();
  if (!name || !email) return [];
  const who = `${name} <${email}>`;
  return [`Co-authored-by: ${who}`, `On-behalf-of: ${who}`];
}

export const commitTrailers = (settings: any, env: NodeJS.ProcessEnv = process.env) =>
  [...(attributionFrom(settings).commit ? [attributionFrom(settings).commit] : []), ...cloudTrailers(env)];

// ---------- rendering for a person ----------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function checksLine(checks: PrSummary["checks"]): string | undefined {
  if (!checks) return undefined;
  if (checks.failed) return `checks: ${checks.failed} failing, ${checks.passed} passed${checks.pending ? `, ${checks.pending} running` : ""}`;
  if (checks.pending) return `checks: ${checks.pending} running, ${checks.passed} passed`;
  return `checks: all ${checks.total} passed`;
}

const REVIEW_WORDS: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  REVIEW_REQUIRED: "review required",
};

/** The `/git` view: what a person wants to see before deciding what to do next. */
export function renderStatus(st: RepoStatus): string {
  const g = st.git;
  const lines: string[] = [];
  const where = st.repo ? `${st.repo.owner}/${st.repo.repo}` : "no remote";
  lines.push(g.branch ? `${g.branch}  ·  ${where}` : `detached at ${(g.detached ?? "").slice(0, 8)}  ·  ${where}`);

  const track: string[] = [];
  if (!g.upstream) track.push("not pushed yet");
  else {
    if (g.ahead) track.push(`${plural(g.ahead, "commit")} to push`);
    if (g.behind) track.push(`${plural(g.behind, "commit")} to pull`);
    if (!g.ahead && !g.behind) track.push("up to date with " + g.upstream);
  }
  if (g.stashes) track.push(plural(g.stashes, "stash", "stashes"));
  lines.push("  " + track.join(" · "));

  if (g.clean) lines.push("  working tree clean");
  else {
    const bits: string[] = [];
    if (g.staged.length) bits.push(`${plural(g.staged.length, "file")} staged`);
    if (g.unstaged.length) bits.push(`${plural(g.unstaged.length, "file")} changed`);
    if (g.untracked.length) bits.push(`${plural(g.untracked.length, "file")} untracked`);
    if (g.conflicted.length) bits.push(`${plural(g.conflicted.length, "file")} conflicted`);
    lines.push("  " + bits.join(" · "));
    const show = [...g.staged.map((f) => `+ ${f.path}`), ...g.unstaged.map((f) => `M ${f.path}`), ...g.untracked.map((p) => `? ${p}`)];
    for (const line of show.slice(0, 10)) lines.push("    " + line);
    if (show.length > 10) lines.push(`    … ${show.length - 10} more`);
  }

  if (g.lastCommit) lines.push(`  last commit ${g.lastCommit.sha.slice(0, 8)} ${g.lastCommit.subject} (${g.lastCommit.relative})`);

  if (st.pr) {
    const p = st.pr;
    const state = [p.isDraft ? "draft" : p.state.toLowerCase(), REVIEW_WORDS[p.reviewDecision ?? ""] ?? undefined].filter(Boolean).join(", ");
    lines.push(`  PR #${p.number} ${p.title}`);
    lines.push(`    ${state}${p.unresolvedThreads ? ` · ${plural(p.unresolvedThreads, "unresolved thread")}` : ""}${checksLine(p.checks) ? ` · ${checksLine(p.checks)}` : ""}`);
    lines.push(`    ${p.url}`);
  } else if (st.repo?.github && g.branch) {
    lines.push("  no pull request for this branch");
  }
  if (st.prUnavailable) lines.push(`  (${st.prUnavailable})`);
  if (st.repo?.ssh) lines.push("  (this remote is SSH; kernal's GitHub tools need an https remote)");
  return lines.join("\n");
}

/** The same status, compact, for the agent: facts only, no decoration. */
export function statusForModel(st: RepoStatus): string {
  const g = st.git;
  const out: Record<string, unknown> = {
    repo: st.repo ? `${st.repo.owner}/${st.repo.repo}` : null,
    branch: g.branch ?? `detached:${g.detached}`,
    upstream: g.upstream ?? null,
    ahead: g.ahead,
    behind: g.behind,
    clean: g.clean,
    staged: g.staged.map((f) => f.path),
    changed: g.unstaged.map((f) => f.path),
    untracked: g.untracked,
    conflicted: g.conflicted,
    stashes: g.stashes,
    lastCommit: g.lastCommit ? { sha: g.lastCommit.sha.slice(0, 12), subject: g.lastCommit.subject } : null,
  };
  if (st.pr) out.pullRequest = {
    number: st.pr.number, state: st.pr.isDraft ? "DRAFT" : st.pr.state, url: st.pr.url,
    review: st.pr.reviewDecision ?? null, unresolvedThreads: st.pr.unresolvedThreads ?? null, checks: st.pr.checks ?? null,
  };
  if (st.prUnavailable) out.pullRequestLookup = st.prUnavailable;
  return JSON.stringify(out, null, 2);
}

// ---------- the tool's actions ----------

export type ToolDeps = { cwd: string; settings: any; gh: Ghe; env?: NodeJS.ProcessEnv };

export type ActionResult = { text: string; isError?: boolean };

const fail = (text: string): ActionResult => ({ text, isError: true });

export async function runAction(action: string, params: any, deps: ToolDeps): Promise<ActionResult> {
  const cwd = deps.cwd;
  const root = await git.repoRoot(cwd);
  if (!root && action !== "status") return fail(`${cwd} is not inside a git repository.`);

  switch (action) {
    case "status": {
      const st = await repoStatus(cwd, deps.gh, { pr: params?.pullRequest !== false });
      if (!st) return fail(`${cwd} is not inside a git repository.`);
      return { text: statusForModel(st) };
    }
    case "diff": {
      const d = await git.diff(root!, { staged: params?.staged === true, paths: toPaths(params?.paths), stat: params?.stat === true });
      if (!d.text.trim()) return { text: params?.staged ? "Nothing is staged." : "No unstaged changes." };
      return { text: d.truncated ? `${d.text}\n\n[diff truncated; ask for specific paths]` : d.text };
    }
    case "log": {
      const entries = await git.log(root!, { limit: clampLimit(params?.limit), range: typeof params?.range === "string" ? params.range : undefined });
      if (!entries.length) return { text: "No commits." };
      return { text: entries.map((e) => `${e.sha.slice(0, 12)} ${e.subject} — ${e.author}, ${e.relative}`).join("\n") };
    }
    case "commit": {
      const message = typeof params?.message === "string" ? params.message.trim() : "";
      if (!message) return fail("A commit message is required.");
      const paths = toPaths(params?.paths);
      if (!paths?.length && params?.all !== true && params?.tracked !== true) return fail("Name the paths to stage (relative to the repository root), or pass all: true to commit everything that changed.");
      const res = await git.commit(root!, { message, paths, all: params?.all === true, tracked: params?.tracked === true, trailers: commitTrailers(deps.settings, deps.env), amend: params?.amend === true });
      if (!res.ok) {
        if (res.reason === "nothing-to-commit") return fail("Nothing to commit: no changes are staged.");
        if (res.reason === "hook-failed") return fail(`A commit hook refused the commit. Fix what it reports, then commit again (do not amend: the commit was never made).\n\n${res.detail}`);
        if (res.reason === "identity") return fail("Git has no commit identity here. Set user.name and user.email, then commit again.");
        if (res.reason === "conflicted") return fail(`Resolve the conflicts first: ${res.detail}`);
        if (/did not match any files/i.test(res.detail)) return fail(`${res.detail}\n(paths are relative to the repository root, ${root})`);
        return fail(res.detail);
      }
      const after = await git.status(root!);
      const left = after && !after.clean ? ` ${after.staged.length + after.unstaged.length + after.untracked.length} file(s) still uncommitted.` : "";
      const changed = res.hookChanged?.length ? `\n\nA hook rewrote ${res.hookChanged.join(", ")} while committing; those changes are not in this commit.` : "";
      return { text: `Committed ${res.sha.slice(0, 12)} ${res.subject}.${left}${changed}${res.hookOutput ? `\n\nHook output:\n${res.hookOutput}` : ""}` };
    }
    case "push": {
      const res = await git.push(root!, { forceWithLease: params?.forceWithLease === true });
      if (!res.ok) {
        if (res.reason === "rejected") return fail(`The push was rejected: origin has commits this branch does not.\nPull first (git pull), or, only if this is your own branch and you meant to replace it, push with forceWithLease.\n\n${res.detail}`);
        if (res.reason === "no-upstream-remote") return fail(res.detail);
        if (res.reason === "detached") return fail(res.detail);
        return fail(res.detail);
      }
      if (res.alreadyUpToDate) return { text: `Nothing to push: ${res.branch} already matches origin.` };
      return { text: `Pushed ${res.sha.slice(0, 12)} to ${res.branch}${res.setUpstream ? " and set it to track origin" : ""}.` };
    }
    case "pull": {
      const res = await git.pull(root!, { rebase: params?.rebase === true });
      if (!res.ok) {
        if (res.reason === "conflict") return fail(`The pull stopped on conflicts in:\n${(res.files ?? []).join("\n")}\nResolve them, stage the files, then finish the ${params?.rebase ? "rebase" : "merge"}.`);
        if (res.reason === "no-upstream") return fail(res.detail);
        if (res.reason === "dirty") return fail(res.detail);
        return fail(res.detail);
      }
      return { text: res.changed ? res.summary || "Pulled." : "Already up to date." };
    }
    case "branch": {
      const name = typeof params?.name === "string" ? params.name.trim() : "";
      const op = typeof params?.op === "string" ? params.op : name ? "switch" : "list";
      if (op === "list") {
        const list = await git.branches(root!);
        return { text: list.map((b) => `${b.current ? "*" : " "} ${b.name}${b.upstream ? ` → ${b.upstream}` : ""}${b.lastCommit ? `  ${b.lastCommit}` : ""}`).join("\n") || "No branches." };
      }
      if (!name) return fail("A branch name is required.");
      if (op === "create" || op === "switch") {
        const res = await git.switchBranch(root!, name, { create: op === "create", from: typeof params?.from === "string" ? params.from : undefined });
        if (!res.ok) return fail(res.detail);
        return { text: res.created ? `Created and switched to ${name}.` : `Switched to ${name}.` };
      }
      if (op === "delete") {
        const res = await git.deleteBranch(root!, name);
        return res.ok ? { text: `Deleted ${name}.` } : fail(res.detail);
      }
      return fail(`Unknown branch operation "${op}". Use list, create, switch or delete.`);
    }
    case "stash": {
      const op = params?.op === "pop" ? "pop" : "push";
      const res = op === "pop" ? await git.stashPop(root!) : await git.stashPush(root!, typeof params?.message === "string" ? params.message : undefined);
      return res.ok ? { text: res.detail || (op === "pop" ? "Stash applied." : "Changes stashed.") } : fail(res.detail);
    }
    default:
      return fail(`Unknown action "${action}". Use status, diff, log, commit, push, pull, branch or stash.`);
  }
}

const clampLimit = (v: unknown) => Math.min(Math.max(typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 10, 1), 100);
const toPaths = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim()) : typeof v === "string" && v.trim() ? [v.trim()] : undefined;
