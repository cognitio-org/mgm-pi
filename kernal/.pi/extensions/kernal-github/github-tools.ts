/**
 * Phase 2 GitHub tools: pull requests, issues and the repository.
 *
 * `gh` is invoked the same way as the rest of kernal-github: an argument array, a timeout, stdin
 * closed. Titles and bodies are arguments or stdin, never a shell string, so a quote or a `$()`
 * in a title is data. When OUTFITTER_GITHUB_SOCKET is set, `call` sends that invocation to the
 * broker and turns the result back into the stdout the parsers below already understand, so the
 * model sees the same text. A cloud checkout views the pull request, then switches only when that
 * head is the session branch or under the branch prefix. A cloud issue start checks out
 * `<prefix>issue-<n>` locally. `gh issue develop` is not sent.
 *
 * Merge is pinned to the head SHA last seen. `gh pr merge --match-head-commit` is the backstop,
 * but a local check comes first so a moved pull request is explained instead of attempted.
 */
import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import * as git from "../_shared/git.ts";
import { brokerCall, cloudBranchAllowed, cloudBranchPrefix, cloudSessionBranch, githubSocketPath } from "./broker.ts";
import { gh as ghExec, type Exec, execCommand } from "./gh.ts";
import { attributionFrom, checksLine, latestChecks, rollup } from "./lib.ts";

export type GithubToolClass = "read" | "write" | "merge";

/**
 * Stable names for the gate. Review is not listed: its class depends on `decision`
 * (comment or omitted → write, approve or request-changes → merge). Push is the git tool's.
 */
export const GITHUB_ACTION_CLASS: Record<Exclude<GithubToolClass, never>, readonly string[]> = {
  read: [
    "github_pr:view",
    "github_pr:list",
    "github_pr:checks",
    "github_issue:list",
    "github_issue:view",
    "github_repo:view",
    "github_repo:search",
    "github_repo:releases",
  ],
  write: [
    "github_pr:create",
    "github_pr:edit",
    "github_pr:comment",
    "github_pr:reply",
    "github_pr:resolve",
    "github_pr:checkout",
    "github_issue:create",
    "github_issue:comment",
    "github_issue:edit",
    "github_issue:close",
    "github_issue:reopen",
    "github_issue:start",
  ],
  merge: ["github_pr:merge"],
};

/** Actions the tools accept. `wait_ci` is deliberately absent from GITHUB_ACTION_CLASS: it only reads, and the gate list does not name it. */
const GITHUB_ACTIONS: Record<string, readonly string[]> = {
  github_pr: ["view", "list", "create", "edit", "checkout", "comment", "reply", "review", "resolve", "checks", "wait_ci", "merge"],
  github_issue: ["list", "view", "create", "comment", "edit", "close", "reopen", "start"],
  github_repo: ["view", "search", "releases"],
};

export type ReviewDecision = "comment" | "approve" | "request-changes";

/** `undefined` when the caller did not choose. `"unknown"` is a choice we will not send. */
export function reviewDecision(raw: unknown): ReviewDecision | "unknown" | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const s = String(raw).trim().toLowerCase().replace(/[_ ]+/g, "-");
  if (s === "approve" || s === "approved") return "approve";
  if (s === "request-changes" || s === "request-change" || s === "changes-requested" || s === "changes") return "request-changes";
  if (s === "comment" || s === "commented") return "comment";
  return "unknown";
}

export function githubToolClass(tool: string, action: string, params?: { decision?: string }): GithubToolClass | undefined {
  const key = `${tool}:${String(action ?? "").trim()}`;
  if (key === "github_pr:review") {
    const d = reviewDecision(params?.decision);
    if (d === "unknown") return undefined;
    if (d === "approve" || d === "request-changes") return "merge";
    return "write";
  }
  for (const cls of ["read", "write", "merge"] as const) {
    if (GITHUB_ACTION_CLASS[cls].includes(key)) return cls;
  }
  return undefined;
}

// ---------- pull request body ----------

const TEMPLATE_FILES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];
const TEMPLATE_DIRS = [".github/PULL_REQUEST_TEMPLATE", ".github/pull_request_template", "docs/PULL_REQUEST_TEMPLATE"];

export type PrTemplate = { path: string; body: string };

/** GitHub's template locations. A directory of them means the agent has to pick: there is no default.
 *  The two spellings of the single-file template are the same file on a case-insensitive volume. */
export async function prTemplates(root: string): Promise<PrTemplate[]> {
  const found: PrTemplate[] = [];
  const seen = new Set<string>();
  const add = async (path: string, abs: string) => {
    try {
      const key = await realpath(abs);
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ path, body: await readFile(abs, "utf8") });
    } catch { /* not this one */ }
  };
  for (const path of TEMPLATE_FILES) await add(path, join(root, path));
  for (const dir of TEMPLATE_DIRS) {
    let names: string[] = [];
    try { names = (await readdir(join(root, dir))).filter((n) => /\.(md|txt)$/i.test(n)).sort(); } catch { continue; }
    for (const name of names) await add(`${dir}/${name}`, join(root, dir, name));
  }
  return found;
}

/** `#12` counts. `other-org/repo#12` belongs to that repository, so it does not. */
function takeHashes(text: string, found: Set<number>) {
  for (const match of text.matchAll(/#(\d+)\b/g)) {
    const before = text.slice(0, match.index ?? 0);
    if (/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(before)) continue;
    found.add(Number(match[1]));
  }
}

/** Issues a branch name or a commit message actually names. A date or a bare number in "phase2" is not one. */
export function issuesNamed(branch: string | undefined, commitText: string): number[] {
  const found = new Set<number>();
  const take = (s: string, re: RegExp) => { for (const m of s.matchAll(re)) found.add(Number(m[1])); };
  if (branch) {
    takeHashes(branch, found);
    take(branch, /(?:^|[/\-])issues?[/\-](\d+)\b/gi);
    // `87-tools` names an issue. `2024-09-23` is a date: the hyphen is followed by a digit.
    take(branch, /(?:^|\/)(\d+)-[A-Za-z]/g);
  }
  takeHashes(commitText, found);
  return [...found].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
}

const closing = (n: number) => new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s*#${n}\\b`, "i");

/** Puts summary and test plan under those headings when the template has them, without deleting the rest. */
function insertUnder(markdown: string, heading: RegExp, value: string): { text: string; found: boolean } {
  const trimmed = value.trim();
  if (!trimmed) return { text: markdown, found: false };
  const m = heading.exec(markdown);
  if (!m) return { text: markdown, found: false };
  const at = m.index + m[0].length;
  const next = markdown.indexOf("\n#", at);
  const section = markdown.slice(at, next === -1 ? undefined : next);
  if (section.includes(trimmed)) return { text: markdown, found: true };
  return { text: markdown.slice(0, at) + "\n" + trimmed + "\n" + markdown.slice(at), found: true };
}

export function withFooter(text: string, footer: string | undefined): string {
  const line = footer?.trim() ?? "";
  let out = text.endsWith("\n") || !text ? text : text + "\n";
  if (line && !out.includes(line)) out = out.trimEnd() + "\n\n" + line + "\n";
  if (out && !out.endsWith("\n")) out += "\n";
  return out;
}

/**
 * The body `github_pr create` sends. An explicit body is the agent having filled the template
 * already; otherwise the template is filled, or a summary and a test plan are written. `Closes #n`
 * is added for each issue the branch or the commits named, unless a closing line is already there.
 */
export function composePrBody(input: {
  template?: string;
  body?: string;
  summary?: string;
  testPlan?: string;
  closes?: number[];
  footer?: string;
}): string {
  let text = input.body?.trim() ?? "";
  if (!text && input.template?.trim()) {
    let filled = input.template.endsWith("\n") ? input.template : input.template + "\n";
    const summary = insertUnder(filled, /^#{1,6}[^\n]*\bsummary\b[^\n]*\n/im, input.summary ?? "");
    filled = summary.text;
    const plan = insertUnder(filled, /^#{1,6}[^\n]*\btest plan\b[^\n]*\n/im, input.testPlan ?? "");
    filled = plan.text;
    if (!summary.found && input.summary?.trim()) filled = filled.trimEnd() + `\n\n## Summary\n\n${input.summary.trim()}\n`;
    if (!plan.found && input.testPlan?.trim()) filled = filled.trimEnd() + `\n\n## Test plan\n\n${input.testPlan.trim()}\n`;
    text = filled.trim();
  } else if (!text) {
    text = `## Summary\n\n${input.summary?.trim() || "See the commits on this branch."}\n\n## Test plan\n\n${input.testPlan?.trim() || "- [ ] not run"}`;
  }
  const missing = (input.closes ?? []).filter((n) => !closing(n).test(text));
  if (missing.length) text = text.trimEnd() + "\n\n" + missing.map((n) => `Closes #${n}`).join("\n");
  return withFooter(text, input.footer);
}

// ---------- tool definitions (kept short: four tools share a 2,500 token budget) ----------

const prParams = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["view", "list", "create", "edit", "checkout", "comment", "reply", "review", "resolve", "checks", "wait_ci", "merge"], description: "What to do" },
    number: { type: "number", description: "Pull request number. view and checks default to the current branch." },
    title: { type: "string", description: "create, edit: title" },
    body: { type: "string", description: "create: filled body, if you already wrote it. Otherwise summary and testPlan are used. comment, review: text." },
    summary: { type: "string", description: "create: summary, written into the template or under ## Summary" },
    testPlan: { type: "string", description: "create: test plan" },
    draft: { type: "boolean", description: "create: open as a draft" },
    base: { type: "string", description: "create, edit: base branch" },
    template: { type: "string", description: "create: which template file when the repo has several" },
    method: { type: "string", enum: ["merge", "squash", "rebase"], description: "merge: how to merge" },
    sha: { type: "string", description: "merge: head SHA you last saw. Omit to use the one from the last view of this pull request." },
    decision: { type: "string", enum: ["comment", "approve", "request-changes"], description: "review: comment, approve, or request-changes" },
    comments: { type: "array", description: "review: inline comments", items: { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, body: { type: "string" }, side: { type: "string", enum: ["LEFT", "RIGHT"] } } } },
    thread: { type: "string", description: "reply, resolve: review thread node id" },
    timeout: { type: "number", description: "wait_ci: seconds to wait (default 600, max 900)" },
    limit: { type: "number", description: "list: how many (default 20)" },
    state: { type: "string", enum: ["open", "closed", "merged", "all"], description: "list: which pull requests" },
  },
};

const issueParams = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["list", "view", "create", "comment", "edit", "close", "reopen", "start"], description: "What to do" },
    number: { type: "number", description: "Issue number" },
    title: { type: "string", description: "create, edit: title" },
    body: { type: "string", description: "create, edit, comment: text" },
    labels: { type: "array", items: { type: "string" }, description: "create, edit: labels to add" },
    removeLabels: { type: "array", items: { type: "string" }, description: "edit: labels to remove" },
    assignees: { type: "array", items: { type: "string" }, description: "create, edit: assignees to add. list: filter (use @me for yourself)." },
    removeAssignees: { type: "array", items: { type: "string" }, description: "edit: assignees to remove" },
    assignee: { type: "string", description: "list: only issues assigned to this login, or @me" },
    state: { type: "string", enum: ["open", "closed", "all"], description: "list: which issues" },
    reason: { type: "string", enum: ["completed", "not planned"], description: "close: why" },
    limit: { type: "number", description: "list: how many (default 20)" },
  },
};

const repoParams = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["view", "search", "releases"], description: "What to do" },
    query: { type: "string", description: "search: issues and pull requests" },
    limit: { type: "number", description: "search, releases: how many (default 20)" },
  },
};

export const githubPrTool = {
  name: "github_pr",
  label: "Pull request",
  description: "Pull requests. create fills the repo template (else a summary and a test plan) and adds Closes #n. merge is pinned to the head SHA last seen. wait_ci returns pass, fail or timeout.",
  promptSnippet: "github_pr: view, create, review, checks and merge pull requests.",
  promptGuidelines: [
    "github_pr: create, edit, comment, review and merge only when the user asked in this conversation.",
    "github_pr: merge is pinned to the head SHA last seen; if the pull request moved, look again instead of merging.",
  ],
  parameters: prParams,
};

export const githubIssueTool = {
  name: "github_issue",
  label: "Issue",
  description: "Issues. start runs gh issue develop and switches to the linked branch.",
  promptSnippet: "github_issue: list, create, edit and start issues.",
  promptGuidelines: [
    "github_issue: open, edit, close or start an issue only when the user asked in this conversation.",
  ],
  parameters: issueParams,
};

export const githubRepoTool = {
  name: "github_repo",
  label: "Repository",
  description: "This repository: default branch, pull request templates, your permission, search, releases.",
  promptSnippet: "github_repo: default branch, templates, permission, search, releases.",
  parameters: repoParams,
};

// ---------- running them ----------

export type GithubResult = { text: string; isError?: boolean; data?: any };

export type GithubDeps = {
  cwd: string;
  settings: any;
  gh?: { path: string; exec?: Exec };
  /** Set when the tool runtime wants progress. wait_ci streams one line per poll. */
  update?: (partial: { content: { type: "text"; text: string }[] }) => void;
  signal?: AbortSignal;
  /** Override the clock and the pause so a wait cannot hang a session or a test. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
};

type RepoRef = { root: string; owner: string; repo: string; branch?: string };
type GhOut = { ok: boolean; stdout: string; stderr: string; code: number };

const fail = (text: string): GithubResult => ({ text, isError: true });
const ok = (data: any, text?: string): GithubResult => ({ text: text ?? JSON.stringify(data, null, 2), data });
const clip = (s: string, n = 8000) => (s.length <= n ? s : s.slice(0, n) + `\n… (${s.length - n} more characters)`);
const tail = (s: string, lines = 60, chars = 4000) => {
  const t = s.trim().split("\n").slice(-lines).join("\n");
  return t.length <= chars ? t : t.slice(t.length - chars);
};

/** The head SHA last returned for a pull request, so a later merge can be pinned without the caller repeating it. */
const seenHead = new Map<string, string>();
const seenKey = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`;
export const clearSeenHeads = () => seenHead.clear();
const remember = (owner: string, repo: string, number: number, sha: string | undefined) => {
  if (sha && /^[0-9a-f]{40}$/i.test(sha)) seenHead.set(seenKey(owner, repo, number), sha.toLowerCase());
};

function ghDetail(res: GhOut): string {
  const detail = (res.stderr || res.stdout).trim();
  return clip(detail || `gh exited ${res.code}`, 2000);
}

/** `https://github.com/owner/repo/pull/N`, the repository `gh pr view` resolved. The path is not decoded. */
function repoFromPullUrl(url: unknown): { owner: string; repo: string } | undefined {
  if (typeof url !== "string") return undefined;
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/.exec(url);
  if (!match) return undefined;
  return { owner: match[1]!, repo: match[2]! };
}

/** The owner/repo `gh` itself will use, which is not always `origin` (a fork, or GH_REPO). */
async function ghOwnerRepo(deps: GithubDeps, repo: RepoRef): Promise<{ owner: string; repo: string } | { error: string }> {
  const res = await call(deps, repo.root, ["repo", "view", "--json", "nameWithOwner"]);
  if (!res.ok) return { error: ghDetail(res) };
  const name = jsonOr(res.stdout)?.nameWithOwner;
  const match = typeof name === "string" ? /^([^/\s]+)\/([^/\s]+)$/.exec(name.trim()) : undefined;
  if (!match) return { error: "gh did not name the repository." };
  return { owner: match[1]!, repo: match[2]! };
}

async function repoOf(cwd: string): Promise<RepoRef | { error: string }> {
  const root = await git.repoRoot(cwd);
  if (!root) return { error: `${cwd} is not inside a git repository.` };
  const rem = await git.remote(root);
  if (!rem) return { error: "This directory has no origin remote, so there is no GitHub repository to use." };
  if (!rem.github || !rem.owner || !rem.repo) {
    const ssh = rem.url.startsWith("git@") || rem.url.startsWith("ssh://");
    return { error: ssh
      ? "This remote is SSH. kernal's GitHub tools need an https remote on github.com."
      : "This remote is not a github.com https repository. kernal's GitHub tools do not support it." };
  }
  const st = await git.status(root);
  return { root, owner: rem.owner, repo: rem.repo, branch: st?.branch };
}

/** Set from a cloud `github_pr.checks` payload. wait_ci reads them; they are not shown to the model. */
let brokerChecksRemaining: number | undefined;
let brokerChecksLog: string | undefined;

type BrokerMap =
  | { op: string; args: Record<string, unknown>; stdout: (data: any) => string }
  | { error: string };

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

function options(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === name) out.push(argv[i + 1]!);
  return out;
}

function ghField(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit?.slice(prefix.length);
}

function whichArgs(which: string): Record<string, unknown> {
  return /^[1-9]\d*$/.test(which) ? { number: Number(which) } : { branch: which };
}

function limitArg(argv: string[]): number | undefined {
  const n = Number(option(argv, "--limit"));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function urlStdout(data: any): string {
  const url = typeof data?.url === "string" ? data.url : typeof data === "string" ? data : "";
  if (!url) return "";
  return url.endsWith("\n") ? url : `${url}\n`;
}

function detailStdout(data: any): string {
  const detail = typeof data?.detail === "string" ? data.detail : "";
  if (!detail) return "";
  return detail.endsWith("\n") ? detail : `${detail}\n`;
}

function jsonStdout(data: any): string {
  return JSON.stringify(data ?? null);
}

/**
 * The API returns the normalized pull (`sha`, `author` as a login, `jobs`). The parsers below
 * still read `gh pr view --json` (`headRefOid`, `author.login`, `statusCheckRollup`). A payload
 * that is already gh-shaped is left alone.
 */
function asGhPull(data: any): any {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  if (data.headRefOid || data.statusCheckRollup || data.isDraft !== undefined) return data;
  const brokerShaped = data.sha !== undefined || data.draft !== undefined || typeof data.author === "string" || Array.isArray(data.jobs) || data.head !== undefined;
  if (!brokerShaped) return data;
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return {
    number: data.number,
    title: data.title,
    url: data.url,
    state: data.state,
    isDraft: data.draft === true,
    baseRefName: data.base,
    headRefOid: data.sha,
    headRefName: data.head,
    reviewDecision: data.review,
    author: typeof data.author === "string" ? { login: data.author } : data.author,
    ...(data.body !== undefined ? { body: data.body } : {}),
    statusCheckRollup: jobs.map((job: any) => ({
      name: job?.name,
      conclusion: job?.state,
      detailsUrl: job?.url,
      status: "COMPLETED",
    })),
  };
}

/** Repo view from the API is `{ repo, defaultBranch, permission }`. `gh repo view --json` is not. */
function asGhRepo(data: any): any {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  if (data.nameWithOwner || data.defaultBranchRef || data.viewerPermission) return data;
  if (typeof data.repo !== "string" && data.defaultBranch === undefined && data.permission === undefined) return data;
  return {
    nameWithOwner: data.repo,
    url: data.url,
    defaultBranchRef: typeof data.defaultBranch === "string" ? { name: data.defaultBranch } : undefined,
    viewerPermission: data.permission ?? null,
  };
}

function ghPullStdout(data: any): string {
  return JSON.stringify(asGhPull(data) ?? null);
}

function ghRepoStdout(data: any): string {
  return JSON.stringify(asGhRepo(data) ?? null);
}

/** An array, or that array under `key` (or `items`, the earlier envelope). Pull rows are gh-shaped. */
function listStdout(data: any, key: string): string {
  const rows = Array.isArray(data) ? data : Array.isArray(data?.[key]) ? data[key] : Array.isArray(data?.items) ? data.items : undefined;
  if (!rows) return JSON.stringify(data ?? null);
  const mapped = key === "pullRequests" ? rows.map((row) => asGhPull({ ...row, body: undefined })) : rows;
  return JSON.stringify(mapped);
}

function checksStdout(data: any): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    brokerChecksRemaining = undefined;
    brokerChecksLog = undefined;
    return JSON.stringify(data ?? null);
  }
  const remaining = data.rateLimit?.remaining;
  brokerChecksRemaining = typeof remaining === "number" && Number.isFinite(remaining) ? remaining : undefined;
  brokerChecksLog = typeof data.log === "string" ? data.log : undefined;
  const rest = { ...data };
  delete rest.rateLimit;
  delete rest.log;
  return JSON.stringify(asGhPull(rest));
}

function replyStdout(data: any): string {
  if (data && (data.errors || data.data)) return JSON.stringify(data);
  const url = typeof data?.url === "string" ? data.url : undefined;
  return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { url } } } });
}

function resolveStdout(data: any): string {
  if (data && (data.errors || data.data)) return JSON.stringify(data);
  return JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: data?.resolved === true } } } });
}

function reviewApiStdout(data: any): string {
  if (typeof data?.html_url === "string") return JSON.stringify(data);
  const html = typeof data?.url === "string" ? data.url : undefined;
  return JSON.stringify(html ? { html_url: html } : {});
}

/**
 * The gh argv `call` was about to run, as one broker op. Checkout and `issue develop` are refused
 * here and never written to the socket. `gh run` is not an op; wait_ci reads a log off the checks
 * payload instead. Search does not forward `--repo`: the API's repo is the session's.
 */
function mapBroker(argv: string[], stdin: string | undefined, env?: NodeJS.ProcessEnv): BrokerMap {
  const cmd = argv[0];
  const sub = argv[1];
  if ((cmd === "pr" && sub === "checkout") || (cmd === "issue" && sub === "develop")) return { error: cloudSessionBranch(env) };
  if (cmd === "run") return { error: "the cloud broker does not fetch job logs as its own operation" };

  if (cmd === "pr" && sub === "view") {
    const fields = new Set((option(argv, "--json") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    const op = fields.has("statusCheckRollup") && !fields.has("title") ? "github_pr.checks" : "github_pr.view";
    return { op, args: whichArgs(argv[2] ?? ""), stdout: op === "github_pr.checks" ? checksStdout : ghPullStdout };
  }
  if (cmd === "pr" && sub === "list") {
    const args: Record<string, unknown> = {};
    const state = option(argv, "--state");
    if (state) args.state = state;
    const limit = limitArg(argv);
    if (limit) args.limit = limit;
    return { op: "github_pr.list", args, stdout: (data) => listStdout(data, "pullRequests") };
  }
  if (cmd === "pr" && sub === "create") {
    const args: Record<string, unknown> = { title: option(argv, "--title") ?? "", body: stdin ?? "" };
    if (argv.includes("--draft")) args.draft = true;
    const base = option(argv, "--base");
    if (base) args.base = base;
    return { op: "github_pr.create", args, stdout: urlStdout };
  }
  if (cmd === "pr" && sub === "edit") {
    const args: Record<string, unknown> = { number: Number(argv[2]) };
    const title = option(argv, "--title");
    if (title) args.title = title;
    if (argv.includes("--body-file")) args.body = stdin ?? "";
    const base = option(argv, "--base");
    if (base) args.base = base;
    return { op: "github_pr.edit", args, stdout: urlStdout };
  }
  if (cmd === "pr" && sub === "comment") {
    return { op: "github_pr.comment", args: { number: Number(argv[2]), body: stdin ?? "" }, stdout: urlStdout };
  }
  if (cmd === "pr" && sub === "review") {
    const decision = argv.includes("--approve") ? "approve" : argv.includes("--request-changes") ? "request-changes" : "comment";
    const args: Record<string, unknown> = { number: Number(argv[2]), decision };
    if (argv.includes("--body-file")) args.body = stdin ?? "";
    return { op: "github_pr.review", args, stdout: urlStdout };
  }
  if (cmd === "pr" && sub === "merge") {
    const method = argv.includes("--squash") ? "squash" : argv.includes("--rebase") ? "rebase" : "merge";
    const args: Record<string, unknown> = { number: Number(argv[2]), method };
    const sha = option(argv, "--match-head-commit");
    if (sha) args.sha = sha;
    return { op: "github_pr.merge", args, stdout: detailStdout };
  }

  if (cmd === "api" && sub === "graphql") {
    const query = ghField(argv, "query") ?? "";
    const thread = ghField(argv, "id") ?? "";
    if (query.includes("addPullRequestReviewThreadReply")) {
      return { op: "github_pr.reply", args: { thread, body: ghField(argv, "body") ?? "" }, stdout: replyStdout };
    }
    if (query.includes("resolveReviewThread")) {
      return { op: "github_pr.resolve", args: { thread }, stdout: resolveStdout };
    }
    return { error: "the cloud broker has no operation for that" };
  }
  if (cmd === "api" && argv[1] === "--method" && argv[2] === "POST" && /\/pulls\/\d+\/reviews$/.test(argv[3] ?? "")) {
    let payload: any;
    try { payload = JSON.parse(stdin ?? ""); } catch { return { error: "the review payload was not JSON" }; }
    const number = Number(/\/pulls\/(\d+)\/reviews$/.exec(argv[3] ?? "")?.[1]);
    const decision = payload?.event === "APPROVE" ? "approve" : payload?.event === "REQUEST_CHANGES" ? "request-changes" : "comment";
    const args: Record<string, unknown> = {
      number,
      decision,
      body: typeof payload?.body === "string" ? payload.body : "",
      sha: payload?.commit_id,
      comments: Array.isArray(payload?.comments) ? payload.comments : [],
    };
    return { op: "github_pr.review", args, stdout: reviewApiStdout };
  }

  if (cmd === "issue" && sub === "list") {
    const args: Record<string, unknown> = {};
    const state = option(argv, "--state");
    if (state) args.state = state;
    const limit = limitArg(argv);
    if (limit) args.limit = limit;
    const assignee = option(argv, "--assignee");
    if (assignee) args.assignee = assignee;
    return { op: "github_issue.list", args, stdout: (data) => listStdout(data, "issues") };
  }
  if (cmd === "issue" && sub === "view") {
    return { op: "github_issue.view", args: { number: Number(argv[2]) }, stdout: jsonStdout };
  }
  if (cmd === "issue" && sub === "create") {
    const args: Record<string, unknown> = { title: option(argv, "--title") ?? "" };
    if (argv.includes("--body-file")) args.body = stdin ?? "";
    const labels = options(argv, "--label");
    const assignees = options(argv, "--assignee");
    if (labels.length) args.labels = labels;
    if (assignees.length) args.assignees = assignees;
    return { op: "github_issue.create", args, stdout: urlStdout };
  }
  if (cmd === "issue" && sub === "comment") {
    return { op: "github_issue.comment", args: { number: Number(argv[2]), body: stdin ?? "" }, stdout: urlStdout };
  }
  if (cmd === "issue" && sub === "edit") {
    const args: Record<string, unknown> = { number: Number(argv[2]) };
    const title = option(argv, "--title");
    if (title) args.title = title;
    if (argv.includes("--body-file")) args.body = stdin ?? "";
    const addLabels = options(argv, "--add-label");
    if (addLabels.length) args.labels = addLabels;
    const removeLabels = options(argv, "--remove-label");
    if (removeLabels.length) args.removeLabels = removeLabels;
    const addAssignees = options(argv, "--add-assignee");
    if (addAssignees.length) args.assignees = addAssignees;
    const removeAssignees = options(argv, "--remove-assignee");
    if (removeAssignees.length) args.removeAssignees = removeAssignees;
    return { op: "github_issue.edit", args, stdout: () => "" };
  }
  if (cmd === "issue" && sub === "close") {
    const args: Record<string, unknown> = { number: Number(argv[2]) };
    const reason = option(argv, "--reason");
    if (reason) args.reason = reason;
    const comment = option(argv, "--comment");
    if (comment) args.body = comment;
    return { op: "github_issue.close", args, stdout: () => "" };
  }
  if (cmd === "issue" && sub === "reopen") {
    return { op: "github_issue.reopen", args: { number: Number(argv[2]) }, stdout: () => "" };
  }

  if (cmd === "repo" && sub === "view") return { op: "github_repo.view", args: {}, stdout: ghRepoStdout };
  if (cmd === "search" && (sub === "issues" || sub === "prs")) {
    const type = sub === "prs" ? "pullRequests" : "issues";
    const args: Record<string, unknown> = { query: argv[2] ?? "", type };
    const limit = limitArg(argv);
    if (limit) args.limit = limit;
    return { op: "github_repo.search", args, stdout: (data) => listStdout(data, type) };
  }
  if (cmd === "release" && sub === "list") {
    const args: Record<string, unknown> = {};
    const limit = limitArg(argv);
    if (limit) args.limit = limit;
    return { op: "github_repo.releases", args, stdout: (data) => listStdout(data, "releases") };
  }
  return { error: "the cloud broker has no operation for that" };
}

async function brokerGh(deps: GithubDeps, socketPath: string, argv: string[], opts: { timeoutMs?: number; stdin?: string }): Promise<GhOut> {
  const mapped = mapBroker(argv, opts.stdin, deps.env);
  if ("error" in mapped) return { ok: false, stdout: "", stderr: mapped.error, code: 1 };
  const res = await brokerCall({
    socketPath,
    op: mapped.op,
    args: mapped.args,
    timeoutMs: opts.timeoutMs ?? 30_000,
    signal: deps.signal,
  });
  if (!res.ok) return { ok: false, stdout: "", stderr: res.error, code: 1 };
  return { ok: true, stdout: mapped.stdout(res.data), stderr: "", code: 0 };
}

async function call(deps: GithubDeps, cwd: string, args: string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<GhOut> {
  const socket = githubSocketPath(deps.env);
  if (socket) return brokerGh(deps, socket, args, opts);
  if (!deps.gh) return { ok: false, stdout: "", stderr: "the GitHub CLI is not installed; run /github setup", code: 127 };
  // stdin is always ended by execCommand. Pass an empty string when there is no body so gh cannot wait for one.
  const res = await ghExec(deps.gh.path, args, { cwd, timeoutMs: opts.timeoutMs ?? 30_000, stdin: opts.stdin ?? "" }, deps.gh.exec ?? execCommand);
  return res;
}

function positiveInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^[1-9]\d*$/.test(v)) return Number(v);
  return undefined;
}

function limitOf(v: unknown, fallback = 20): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
  return Math.min(Math.max(n, 1), 50);
}

function stringList(v: unknown, what: string): { values: string[] } | { error: string } {
  if (v === undefined || v === null) return { values: [] };
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : null;
  if (!arr) return { error: `${what} must be a list of strings.` };
  const values: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string" || !item.trim()) return { error: `${what} must be a list of strings.` };
    const s = item.trim();
    if (s.startsWith("-") || /[\n\r]/.test(s)) return { error: `${what} cannot start with "-" or contain a newline.` };
    values.push(s);
  }
  return { values };
}

function loginOk(v: string): boolean {
  return v === "@me" || /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(v);
}

const jsonOr = (stdout: string) => { try { return JSON.parse(stdout); } catch { return undefined; } };

function prFooter(deps: GithubDeps): string {
  const lines: string[] = [];
  const local = attributionFrom(deps.settings).pr;
  if (local) lines.push(local);
  const login = (deps.env ?? process.env).OUTFITTER_AUTHOR_LOGIN?.replace(/^@/, "").trim();
  if (login && /^[A-Za-z0-9-]+$/.test(login)) lines.push(`Outfitter, on behalf of @${login}`);
  return lines.join("\n");
}

function commentFooter(deps: GithubDeps): string {
  const login = (deps.env ?? process.env).OUTFITTER_AUTHOR_LOGIN?.replace(/^@/, "").trim();
  return login && /^[A-Za-z0-9-]+$/.test(login) ? `Outfitter, on behalf of @${login}` : "";
}

/** The commit `base` (or the default branch) and HEAD diverged at. Empty when that point cannot be named. */
async function branchPoint(root: string, base?: string): Promise<string | undefined> {
  const candidates: string[] = [];
  if (base && !git.refNameProblem(base)) candidates.push(`origin/${base}`, base);
  else if (!base) candidates.push("origin/HEAD", "origin/main", "main");
  for (const name of candidates) {
    const sha = await git.gitValue(["merge-base", "--end-of-options", "HEAD", name], { cwd: root });
    if (sha && /^[0-9a-f]{7,64}$/i.test(sha)) return sha;
  }
  return undefined;
}

async function commitMessages(root: string, base?: string): Promise<string> {
  // Only commits this branch adds on top of its base. No base means no commit text:
  // the last 20 commits on HEAD would close issues the branch did not newly reference.
  // Options stay in front of --end-of-options; after it, `--format` would be a path and the log would be empty.
  const point = await branchPoint(root, base);
  if (!point) return "";
  return (await git.gitValue(["log", "--format=%s%n%b", "--end-of-options", `${point}..HEAD`], { cwd: root })) ?? "";
}

function jobState(node: any): string {
  return String(node?.conclusion ?? node?.state ?? node?.status ?? "");
}

function jobsFrom(nodes: any): { name: string; state: string; url: string }[] {
  return latestChecks(nodes).map((n) => ({
    name: String(n?.name ?? n?.context ?? "check"),
    state: jobState(n),
    url: String(n?.detailsUrl ?? n?.targetUrl ?? ""),
  }));
}

function normalizePr(data: any, owner: string, repoName: string): any {
  const number = Number(data?.number);
  const sha = typeof data?.headRefOid === "string" ? data.headRefOid.toLowerCase() : undefined;
  if (Number.isInteger(number) && sha) remember(owner, repoName, number, sha);
  const checks = rollup(data?.statusCheckRollup);
  return {
    number,
    title: String(data?.title ?? ""),
    url: String(data?.url ?? ""),
    state: String(data?.state ?? ""),
    draft: data?.isDraft === true,
    base: data?.baseRefName ? String(data.baseRefName) : undefined,
    sha,
    review: data?.reviewDecision ? String(data.reviewDecision) : undefined,
    author: data?.author?.login ? String(data.author.login) : undefined,
    head: data?.headRefName ? String(data.headRefName) : undefined,
    body: typeof data?.body === "string" ? clip(data.body) : undefined,
    checks,
    jobs: jobsFrom(data?.statusCheckRollup),
  };
}

const PR_FIELDS = "number,title,url,state,isDraft,reviewDecision,headRefOid,baseRefName,body,statusCheckRollup,author,headRefName";

async function viewPr(deps: GithubDeps, repo: RepoRef, which: string): Promise<GithubResult> {
  const res = await call(deps, repo.root, ["pr", "view", which, "--json", PR_FIELDS]);
  if (!res.ok) return fail(ghDetail(res));
  const data = jsonOr(res.stdout);
  if (!data || typeof data.number !== "number") return fail("gh returned something that is not a pull request.");
  return ok(normalizePr(data, repo.owner, repo.repo));
}

export async function executeGithub(tool: string, params: any, deps: GithubDeps): Promise<GithubResult> {
  const action = String(params?.action ?? "").trim();
  if (!action) return fail("An action is required.");
  if (!GITHUB_ACTIONS[tool]?.includes(action)) return fail(`Unknown ${tool} action "${action}".`);
  if (tool === "github_pr" && action === "review" && reviewDecision(params?.decision) === "unknown") {
    return fail(`Unknown review decision "${params?.decision}". Use comment, approve or request-changes.`);
  }
  const repo = await repoOf(deps.cwd);
  if ("error" in repo) return fail(repo.error);
  if (tool === "github_pr") return runPr(action, params ?? {}, deps, repo);
  if (tool === "github_issue") return runIssue(action, params ?? {}, deps, repo);
  if (tool === "github_repo") return runRepo(action, params ?? {}, deps, repo);
  return fail(`Unknown tool "${tool}".`);
}

async function runPr(action: string, params: any, deps: GithubDeps, repo: RepoRef): Promise<GithubResult> {
  const number = positiveInt(params.number);
  switch (action) {
    case "view": {
      const which = number ? String(number) : repo.branch;
      if (!which) return fail("Not on a branch. Pass the pull request number.");
      return viewPr(deps, repo, which);
    }
    case "list": {
      const state = params.state ?? "open";
      if (!["open", "closed", "merged", "all"].includes(state)) return fail(`Unknown state "${state}".`);
      const res = await call(deps, repo.root, ["pr", "list", "--state", state, "--limit", String(limitOf(params.limit)), "--json", "number,title,url,state,isDraft,headRefName,headRefOid,author"]);
      if (!res.ok) return fail(ghDetail(res));
      const data = jsonOr(res.stdout);
      if (!Array.isArray(data)) return fail("gh returned something that is not a list of pull requests.");
      return ok(data.map((d) => normalizePr(d, repo.owner, repo.repo)));
    }
    case "create":
      return createPr(params, deps, repo);
    case "edit": {
      if (!number) return fail("A pull request number is required.");
      const title = typeof params.title === "string" ? params.title.trim() : "";
      const body = typeof params.body === "string" ? withFooter(params.body, prFooter(deps)) : undefined;
      const base = typeof params.base === "string" ? params.base.trim() : "";
      if (!title && body === undefined && !base) return fail("Nothing to change. Pass a title, a body or a base.");
      if (base.startsWith("-")) return fail("A base branch cannot start with \"-\".");
      const args = ["pr", "edit", String(number)];
      if (title) args.push("--title", title);
      if (body !== undefined) args.push("--body-file", "-");
      if (base) args.push("--base", base);
      const res = await call(deps, repo.root, args, { timeoutMs: 60_000, stdin: body });
      if (!res.ok) return fail(ghDetail(res));
      return ok({ number, url: res.stdout.trim() || undefined });
    }
    case "checkout": {
      if (!number) return fail("A pull request number is required.");
      if (githubSocketPath(deps.env)) return checkoutCloud(number, deps, repo);
      const res = await call(deps, repo.root, ["pr", "checkout", String(number)], { timeoutMs: 60_000 });
      if (!res.ok) return fail(ghDetail(res));
      const st = await git.status(repo.root);
      return ok({ number, branch: st?.branch, detail: clip(res.stdout.trim(), 500) });
    }
    case "comment": {
      if (!number) return fail("A pull request number is required.");
      if (typeof params.body !== "string" || !params.body.trim()) return fail("A comment body is required.");
      const body = withFooter(params.body, commentFooter(deps));
      const res = await call(deps, repo.root, ["pr", "comment", String(number), "--body-file", "-"], { timeoutMs: 60_000, stdin: body });
      if (!res.ok) return fail(ghDetail(res));
      return ok({ number, url: res.stdout.trim() || undefined });
    }
    case "reply":
      return replyThread(params, deps, repo);
    case "review":
      return reviewPr(params, deps, repo);
    case "resolve":
      return resolveThread(params, deps, repo);
    case "checks": {
      const which = number ? String(number) : repo.branch;
      if (!which) return fail("Not on a branch. Pass the pull request number.");
      return checksFor(deps, repo, which);
    }
    case "wait_ci":
      return waitCi(params, deps, repo);
    case "merge":
      return mergePr(params, deps, repo);
    default:
      return fail(`Unknown github_pr action "${action}".`);
  }
}

async function createPr(params: any, deps: GithubDeps, repo: RepoRef): Promise<GithubResult> {
  const title = typeof params.title === "string" ? params.title.trim() : "";
  if (!title) return fail("A title is required.");
  const base = typeof params.base === "string" ? params.base.trim() : "";
  if (base.startsWith("-")) return fail("A base branch cannot start with \"-\".");
  const templates = await prTemplates(repo.root);
  // A blank body is not "I already wrote the pull request"; it would throw away the template.
  const explicit = typeof params.body === "string" && params.body.trim() ? params.body : undefined;
  let template: PrTemplate | undefined;
  if (explicit === undefined) {
    const wanted = typeof params.template === "string" ? params.template.trim() : "";
    if (templates.length > 1 && !wanted) {
      return fail("This repository has more than one pull request template. Pass template with one of:\n" + templates.map((t) => t.path).join("\n"));
    }
    if (wanted) {
      template = templates.find((t) => t.path === wanted || t.path.endsWith("/" + wanted));
      if (!template) return fail(`No pull request template matches "${wanted}".\n` + (templates.map((t) => t.path).join("\n") || "(none)"));
    } else template = templates[0];
  }
  const named = issuesNamed(repo.branch, await commitMessages(repo.root, base || undefined));
  const body = composePrBody({
    template: template?.body,
    body: explicit,
    summary: typeof params.summary === "string" ? params.summary : undefined,
    testPlan: typeof params.testPlan === "string" ? params.testPlan : undefined,
    closes: named,
    footer: prFooter(deps),
  });
  const args = ["pr", "create", "--title", title, "--body-file", "-"];
  if (params.draft === true) args.push("--draft");
  if (base) args.push("--base", base);
  const res = await call(deps, repo.root, args, { timeoutMs: 60_000, stdin: body });
  if (!res.ok) return fail(ghDetail(res));
  const url = res.stdout.trim().split("\n").find((l) => l.startsWith("http")) ?? res.stdout.trim();
  return ok({ url, template: template?.path ?? null, closes: named });
}

async function replyThread(params: any, deps: GithubDeps, repo: RepoRef): Promise<GithubResult> {
  const thread = typeof params.thread === "string" ? params.thread.trim() : "";
  if (!thread || thread.startsWith("-")) return fail("A review thread id is required.");
  if (typeof params.body !== "string" || !params.body.trim()) return fail("A reply body is required.");
  const body = withFooter(params.body, commentFooter(deps));
  // GraphQL because `gh pr comment` starts a new thread; it cannot answer an existing one.
  const query = "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{url}}}";
  const res = await call(deps, repo.root, ["api", "graphql", "-f", `query=${query}`, "-f", `id=${thread}`, "-f", `body=${body}`], { timeoutMs: 60_000 });
  if (!res.ok) return fail(ghDetail(res));
  const data = jsonOr(res.stdout);
  const url = data?.data?.addPullRequestReviewThreadReply?.comment?.url;
  if (data?.errors) return fail(clip(JSON.stringify(data.errors), 2000));
  return ok({ thread, url: url ? String(url) : undefined });
}

async function resolveThread(params: any, deps: GithubDeps, repo: RepoRef): Promise<GithubResult> {
  const thread = typeof params.thread === "string" ? params.thread.trim() : "";
  if (!thread || thread.startsWith("-")) return fail("A review thread id is required.");
  const query = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}";
  const res = await call(deps, repo.root, ["api", "graphql", "-f", `query=${query}`, "-f", `id=${thread}`], { timeoutMs: 60_000 });
  if (!res.ok) return fail(ghDetail(res));
  const data = jsonOr(res.stdout);
  if (data?.errors) return fail(clip(JSON.stringify(data.errors), 2000));
  const resolved = data?.data?.resolveReviewThread?.thread?.isResolved === true;
  return ok({ thread, resolved });
}

async function reviewPr(params: any, deps: GithubDeps, repo: RepoRef): Promise<GithubResult> {
  const number = positiveInt(params.number);
  if (!number) return fail("A pull request number is required.");
  const decision = reviewDecision(params.decision) ?? "comment";
  if (decision === "unknown") return fail(`Unknown review decision "${params.decision}". Use comment, approve or request-changes.`);
  const inline = Array.isArray(params.comments) ? params.comments : [];
  const bodyIn = typeof params.body === "string" ? params.body : "";
  if ((decision === "request-changes" || decision === "comment") && !bodyIn.trim() && !inline.length) return fail("A review body is required.");
  for (const c of inline) {
    if (!c || typeof c.path !== "string" || !c.path.trim() || typeof c.body !== "string" || !c.body.trim() || !Number.isInteger(c.line) || c.line <= 0) {
      return fail("Each inline comment needs a path, a line and a body.");
    }
    if (c.side !== undefined && c.side !== "LEFT" && c.side !== "RIGHT") return fail("An inline comment side must be LEFT or RIGHT.");
  }
  const body = withFooter(bodyIn, commentFooter(deps));
  if (!inline.length) {
    const flag = decision === "approve" ? "--approve" : decision === "request-changes" ? "--request-changes" : "--comment";
    const args = ["pr", "review", String(number), flag];
    if (body.trim()) args.push("--body-file", "-");
    const res = await call(deps, repo.root, args, { timeoutMs: 60_000, stdin: body.trim() ? body : "" });
    if (!res.ok) return fail(ghDetail(res));
    return ok({ number, decision, url: res.stdout.trim() || undefined });
  }
  // Inline comments are not flags on `gh pr review`; the reviews API takes them on the commit they refer to.
  // That API also has to name an owner and a repo. `gh pr view` resolved which repository this
  // pull request is; origin can be a different one (a fork, or GH_REPO).
  const viewed = await call(deps, repo.root, ["pr", "view", String(number), "--json", "url,headRefOid"]);
  if (!viewed.ok) return fail(ghDetail(viewed));
  const viewedData = jsonOr(viewed.stdout);
  const target = repoFromPullUrl(viewedData?.url);
  if (!target) return fail("Could not read which repository this pull request is in.");
  let sha = typeof params.sha === "string" ? params.sha.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    const head = viewedData?.headRefOid;
    if (typeof head !== "string") return fail("Could not read the pull request head, which inline comments have to name.");
    sha = head.toLowerCase();
  }
  remember(target.owner, target.repo, number, sha);
  const payload = {
    commit_id: sha,
    body: body.trim(),
    event: decision === "approve" ? "APPROVE" : decision === "request-changes" ? "REQUEST_CHANGES" : "COMMENT",
    comments: inline.map((c: any) => ({ path: c.path.trim(), line: c.line, side: c.side ?? "RIGHT", body: c.body })),
  };
  const res = await call(deps, repo.root, ["api", "--method", "POST", `repos/${target.owner}/${target.repo}/pulls/${number}/reviews`, "--input", "-"], { timeoutMs: 60_000, stdin: JSON.stringify(payload) });
  if (!res.ok) return fail(ghDetail(res));
  const data = jsonOr(res.stdout);
  return ok({ number, decision, sha, url: data?.html_url ? String(data.html_url) : undefined });
}

async function checksFor(deps: GithubDeps, repo: RepoRef, which: string): Promise<GithubResult> {
  const res = await call(deps, repo.root, ["pr", "view", which, "--json", "number,headRefOid,statusCheckRollup,url"]);
  if (!res.ok) return fail(ghDetail(res));
  const data = jsonOr(res.stdout);
  if (!data || typeof data.number !== "number") return fail("gh returned something that is not a pull request.");
  const pr = normalizePr(data, repo.owner, repo.repo);
  return ok({ number: pr.number, sha: pr.sha, url: pr.url, checks: pr.checks ?? null, jobs: pr.jobs });
}

async function mergePr(params: any, deps: GithubDeps, repo: RepoRef): Promise<GithubResult> {
  const number = positiveInt(params.number);
  if (!number) return fail("A pull request number is required.");
  const method = params.method;
  if (method !== "merge" && method !== "squash" && method !== "rebase") return fail("method must be merge, squash or rebase.");
  const given = typeof params.sha === "string" ? params.sha.trim().toLowerCase() : "";
  if (given && !/^[0-9a-f]{40}$/.test(given)) return fail("sha must be the full 40-character head you saw.");
  const pin = given || seenHead.get(seenKey(repo.owner, repo.repo, number));
  if (!pin) return fail("View the pull request first, or pass sha, so the merge is pinned to the commit you saw.");
  const live = await call(deps, repo.root, ["pr", "view", String(number), "--json", "headRefOid,url"]);
  if (!live.ok) return fail(ghDetail(live));
  const head = jsonOr(live.stdout)?.headRefOid;
  if (typeof head !== "string") return fail("Could not read the pull request head.");
  if (head.toLowerCase() !== pin) return fail(`The pull request head moved from ${pin} to ${head.toLowerCase()}. Look again before merging.`);
  const flag = method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge";
  const res = await call(deps, repo.root, ["pr", "merge", String(number), flag, "--match-head-commit", pin], { timeoutMs: 60_000 });
  if (!res.ok) return fail(ghDetail(res));
  seenHead.delete(seenKey(repo.owner, repo.repo, number));
  return ok({ number, method, sha: pin, detail: clip(res.stdout.trim(), 500) });
}

const WAIT_CAP_S = 15 * 60;
const WAIT_DEFAULT_S = 10 * 60;

/** Cloud polls share one hourly budget. Under 100 left, wait three times as long; under 10, six. The production gap is 20s, so those are 60s and 120s. */
function checksInterval(baseMs: number, remaining: number | undefined): number {
  if (remaining === undefined || !Number.isFinite(remaining) || remaining >= 100) return baseMs;
  if (remaining < 10) return baseMs * 6;
  return baseMs * 3;
}

/**
 * Polls the checks for the commit we started on. One poll uses a 30s timeout; the whole wait
 * is capped, and a stuck clock still stops after a fixed number of polls, so this cannot hang.
 * In the cloud each poll is its own github_pr.checks request. There is no github_pr.wait_ci op,
 * and the socket is not held open between polls.
 */
async function waitCi(params: any, deps: GithubDeps, repo: RepoRef): Promise<GithubResult> {
  const number = positiveInt(params.number);
  const which = number ? String(number) : repo.branch;
  if (!which) return fail("Not on a branch. Pass the pull request number.");
  const seconds = typeof params.timeout === "number" && Number.isFinite(params.timeout) ? Math.trunc(params.timeout) : WAIT_DEFAULT_S;
  const timeoutMs = Math.min(Math.max(seconds, 0), WAIT_CAP_S) * 1000;
  const intervalMs = Math.min(Math.max(deps.intervalMs ?? 20_000, 0), 60_000);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    if (deps.signal?.aborted || ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    deps.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  }));
  const maxPolls = intervalMs <= 0 ? 1 : Math.ceil(timeoutMs / intervalMs) + 1;
  const start = now();
  let polls = 0;
  let last: any;
  let pin: string | undefined;
  brokerChecksRemaining = undefined;
  brokerChecksLog = undefined;
  while (polls < maxPolls) {
    if (deps.signal?.aborted) return fail("wait_ci was cancelled.");
    polls++;
    const res = await call(deps, repo.root, ["pr", "view", which, "--json", "number,headRefOid,statusCheckRollup,url"]);
    if (!res.ok) {
      last = { error: ghDetail(res) };
    } else {
      const data = jsonOr(res.stdout);
      if (!data || typeof data.number !== "number") return fail("gh returned something that is not a pull request.");
      const pr = normalizePr(data, repo.owner, repo.repo);
      if (!pin) pin = pr.sha;
      else if (pr.sha && pr.sha !== pin) {
        return ok({ result: "fail", number: pr.number, reason: "head-moved", from: pin, to: pr.sha });
      }
      const checks = pr.checks;
      const pending = checks?.pending ?? (checks ? 0 : 1);
      const failed = checks?.failed ?? 0;
      last = { number: pr.number, sha: pr.sha, url: pr.url, checks: checks ?? null, jobs: pr.jobs };
      const progress = `CI for #${pr.number}${pr.sha ? ` at ${pr.sha.slice(0, 8)}` : ""}: ${failed} failing, ${checks?.passed ?? 0} passed, ${pending && checks ? pending : checks ? 0 : "no"} running`;
      deps.update?.({ content: [{ type: "text", text: progress }] });
      if (checks && failed > 0 && pending === 0) {
        const log = await failingLog(deps, repo, pr.sha, pr.jobs);
        return ok({ result: "fail", ...last, failed: pr.jobs.filter((j) => /FAILURE|TIMED_OUT|CANCELLED|ERROR|STARTUP_FAILURE|ACTION_REQUIRED/i.test(j.state)).map((j) => j.name), log });
      }
      if (checks && failed === 0 && pending === 0 && checks.total > 0) return ok({ result: "pass", ...last });
    }
    if (now() - start >= timeoutMs || polls >= maxPolls) break;
    const remaining = timeoutMs - (now() - start);
    if (remaining <= 0) break;
    const gap = githubSocketPath(deps.env) ? checksInterval(intervalMs, brokerChecksRemaining) : intervalMs;
    await sleep(Math.min(gap, remaining));
  }
  return ok({ result: "timeout", ...(last ?? {}), waitedMs: now() - start });
}

async function failingLog(deps: GithubDeps, repo: RepoRef, sha: string | undefined, jobs: { name: string; state: string; url: string }[]): Promise<string | undefined> {
  // No log socket op. A checks result may carry the tail; otherwise the fail result has none.
  if (githubSocketPath(deps.env)) {
    const log = brokerChecksLog;
    brokerChecksLog = undefined;
    return typeof log === "string" ? tail(log) : undefined;
  }
  let runId: string | undefined;
  for (const job of jobs) {
    const m = /\/actions\/runs\/(\d+)/.exec(job.url);
    if (m && /fail|error|timed_out|cancel/i.test(job.state)) { runId = m[1]; break; }
  }
  if (!runId && sha && /^[0-9a-f]{40}$/.test(sha)) {
    const list = await call(deps, repo.root, ["run", "list", "--commit", sha, "--limit", "10", "--json", "databaseId,conclusion,name"]);
    const rows = list.ok ? jsonOr(list.stdout) : undefined;
    const hit = Array.isArray(rows) ? rows.find((r) => /failure|timed_out|cancelled|startup_failure/i.test(String(r?.conclusion ?? ""))) : undefined;
    if (hit?.databaseId) runId = String(hit.databaseId);
  }
  if (!runId) return undefined;
  const log = await call(deps, repo.root, ["run", "view", runId, "--log-failed"], { timeoutMs: 60_000 });
  if (!log.ok && !log.stdout) return undefined;
  return tail(log.stdout || log.stderr);
}

async function runIssue(action: string, params: any, deps: GithubDeps, repo: RepoRef): Promise<GithubResult> {
  const number = positiveInt(params.number);
  switch (action) {
    case "list": {
      const state = params.state ?? "open";
      if (!["open", "closed", "all"].includes(state)) return fail(`Unknown state "${state}".`);
      const assignee = typeof params.assignee === "string" ? params.assignee.trim() : "";
      if (assignee && !loginOk(assignee)) return fail(`"${assignee}" is not a login.`);
      const args = ["issue", "list", "--state", state, "--limit", String(limitOf(params.limit)), "--json", "number,title,url,state,labels,assignees"];
      if (assignee) args.push("--assignee", assignee);
      const res = await call(deps, repo.root, args);
      if (!res.ok) return fail(ghDetail(res));
      const data = jsonOr(res.stdout);
      if (!Array.isArray(data)) return fail("gh returned something that is not a list of issues.");
      return ok(data.map(normalizeIssue));
    }
    case "view": {
      if (!number) return fail("An issue number is required.");
      const res = await call(deps, repo.root, ["issue", "view", String(number), "--json", "number,title,body,state,url,labels,assignees"]);
      if (!res.ok) return fail(ghDetail(res));
      const data = jsonOr(res.stdout);
      if (!data || typeof data.number !== "number") return fail("gh returned something that is not an issue.");
      return ok(normalizeIssue(data));
    }
    case "create": {
      const title = typeof params.title === "string" ? params.title.trim() : "";
      if (!title) return fail("A title is required.");
      const labels = stringList(params.labels, "labels");
      if ("error" in labels) return fail(labels.error);
      const assignees = stringList(params.assignees, "assignees");
      if ("error" in assignees) return fail(assignees.error);
      const body = typeof params.body === "string" ? withFooter(params.body, commentFooter(deps)) : "";
      const args = ["issue", "create", "--title", title];
      if (body) args.push("--body-file", "-");
      for (const l of labels.values) args.push("--label", l);
      for (const a of assignees.values) args.push("--assignee", a);
      const res = await call(deps, repo.root, args, { timeoutMs: 60_000, stdin: body || "" });
      if (!res.ok) return fail(ghDetail(res));
      return ok({ url: res.stdout.trim() });
    }
    case "comment": {
      if (!number) return fail("An issue number is required.");
      if (typeof params.body !== "string" || !params.body.trim()) return fail("A comment body is required.");
      const body = withFooter(params.body, commentFooter(deps));
      const res = await call(deps, repo.root, ["issue", "comment", String(number), "--body-file", "-"], { timeoutMs: 60_000, stdin: body });
      if (!res.ok) return fail(ghDetail(res));
      return ok({ number, url: res.stdout.trim() || undefined });
    }
    case "edit":
      return editIssue(params, deps, repo);
    case "close": {
      if (!number) return fail("An issue number is required.");
      const reason = params.reason === undefined ? "completed" : params.reason === "not planned" || params.reason === "completed" ? params.reason : "";
      if (!reason) return fail(`Unknown close reason "${params.reason}". Use completed or "not planned".`);
      const args = ["issue", "close", String(number), "--reason", reason];
      const body = typeof params.body === "string" && params.body.trim() ? withFooter(params.body, commentFooter(deps)) : "";
      if (body) args.push("--comment", body.trim());
      const res = await call(deps, repo.root, args, { timeoutMs: 60_000 });
      if (!res.ok) return fail(ghDetail(res));
      return ok({ number, state: "closed", reason });
    }
    case "reopen": {
      if (!number) return fail("An issue number is required.");
      const res = await call(deps, repo.root, ["issue", "reopen", String(number)], { timeoutMs: 60_000 });
      if (!res.ok) return fail(ghDetail(res));
      return ok({ number, state: "open" });
    }
    case "start":
      return startIssue(params, deps, repo);
    default:
      return fail(`Unknown github_issue action "${action}".`);
  }
}

function normalizeIssue(data: any): any {
  const labels = Array.isArray(data?.labels) ? data.labels.map((l: any) => String(l?.name ?? l)).filter(Boolean) : [];
  const assignees = Array.isArray(data?.assignees) ? data.assignees.map((a: any) => String(a?.login ?? a)).filter(Boolean) : [];
  return {
    number: Number(data?.number),
    title: String(data?.title ?? ""),
    url: String(data?.url ?? ""),
    state: String(data?.state ?? ""),
    labels,
    assignees,
    body: typeof data?.body === "string" ? clip(data.body) : undefined,
  };
}

async function editIssue(params: any, deps: GithubDeps, repo: RepoRef): Promise<GithubResult> {
  const number = positiveInt(params.number);
  if (!number) return fail("An issue number is required.");
  const title = typeof params.title === "string" ? params.title.trim() : "";
  const body = typeof params.body === "string" ? withFooter(params.body, commentFooter(deps)) : undefined;
  const labels = stringList(params.labels, "labels");
  if ("error" in labels) return fail(labels.error);
  const removeLabels = stringList(params.removeLabels, "removeLabels");
  if ("error" in removeLabels) return fail(removeLabels.error);
  const assignees = stringList(params.assignees, "assignees");
  if ("error" in assignees) return fail(assignees.error);
  const removeAssignees = stringList(params.removeAssignees, "removeAssignees");
  if ("error" in removeAssignees) return fail(removeAssignees.error);
  if (!title && body === undefined && !labels.values.length && !removeLabels.values.length && !assignees.values.length && !removeAssignees.values.length) {
    return fail("Nothing to change. Pass a title, a body, labels or assignees.");
  }
  const args = ["issue", "edit", String(number)];
  if (title) args.push("--title", title);
  if (body !== undefined) args.push("--body-file", "-");
  for (const l of labels.values) args.push("--add-label", l);
  for (const l of removeLabels.values) args.push("--remove-label", l);
  for (const a of assignees.values) args.push("--add-assignee", a);
  for (const a of removeAssignees.values) args.push("--remove-assignee", a);
  const res = await call(deps, repo.root, args, { timeoutMs: 60_000, stdin: body });
  if (!res.ok) return fail(ghDetail(res));
  return ok({ number });
}

/** Fetch `refs/heads/<branch>` into `refs/remotes/origin/<branch>`. A missing remote ref is `present: false`. */
async function fetchRemoteBranch(cwd: string, branch: string): Promise<{ ok: true; present: boolean } | { ok: false; detail: string }> {
  const spec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  const fetched = await git.runGit(["fetch", "origin", spec], { cwd, timeoutMs: 60_000 });
  if (fetched.code === 0) return { ok: true, present: true };
  const text = `${fetched.stderr}\n${fetched.stdout}`.toLowerCase();
  if (text.includes("couldn't find remote ref") || text.includes("could not find remote ref")) return { ok: true, present: false };
  return { ok: false, detail: (fetched.stderr || fetched.stdout).trim() || "Could not fetch that branch." };
}

/** Point the local branch at the remote-tracking ref just fetched, creating it when needed. */
async function resetToOrigin(cwd: string, branch: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const sw = await git.runGit(["switch", "--force", "-C", branch, `refs/remotes/origin/${branch}`], { cwd, timeoutMs: 60_000 });
  if (sw.code !== 0) return { ok: false, detail: (sw.stderr || sw.stdout).trim() || `Could not switch to ${branch}.` };
  return { ok: true };
}

async function checkoutCloud(number: number, deps: GithubDeps, repo: RepoRef): Promise<GithubResult> {
  const viewed = await call(deps, repo.root, ["pr", "view", String(number), "--json", "headRefName,number"]);
  if (!viewed.ok) return fail(ghDetail(viewed));
  let head = "";
  try {
    head = String(JSON.parse(viewed.stdout)?.headRefName ?? "");
  } catch {
    head = "";
  }
  if (!head || !cloudBranchAllowed(head, deps.env)) return fail(cloudSessionBranch(deps.env));
  const fetched = await fetchRemoteBranch(repo.root, head);
  if (!fetched.ok) return fail(fetched.detail);
  if (!fetched.present) return fail(`origin has no branch ${head}.`);
  const sw = await resetToOrigin(repo.root, head);
  if (!sw.ok) return fail(sw.detail);
  return ok({ number, branch: head });
}

async function startIssue(params: any, deps: GithubDeps, repo: RepoRef): Promise<GithubResult> {
  const number = positiveInt(params.number);
  if (!number) return fail("An issue number is required.");
  if (githubSocketPath(deps.env)) {
    const branch = `${cloudBranchPrefix(deps.env)}issue-${number}`;
    if (!cloudBranchAllowed(branch, deps.env)) return fail(cloudSessionBranch(deps.env));
    const fetched = await fetchRemoteBranch(repo.root, branch);
    if (!fetched.ok) return fail(fetched.detail);
    if (fetched.present) {
      const sw = await resetToOrigin(repo.root, branch);
      if (!sw.ok) return fail(sw.detail);
    } else {
      const sw = await git.switchBranch(repo.root, branch, { create: true });
      if (!sw.ok) {
        const again = await git.switchBranch(repo.root, branch);
        if (!again.ok) return fail(sw.detail);
      }
    }
    return ok({ number, branch });
  }
  const developed = await call(deps, repo.root, ["issue", "develop", String(number), "--checkout"], { timeoutMs: 60_000 });
  if (!developed.ok) return fail(ghDetail(developed));
  // develop prints `…/tree/<name>` and already checks that branch out. Other linked
  // branches are not the one just created, and the name is not percent-encoded.
  const url = /github\.com\/[^/\s]+\/[^/\s]+\/tree\/([^\s]+)/.exec(developed.stdout);
  const branch = url?.[1];
  if (!branch) return fail(`gh issue develop ran, but the linked branch name did not come back.\n${clip(developed.stdout, 500)}`);
  const current = (await git.status(repo.root))?.branch;
  if (current !== branch) {
    const sw = await git.switchBranch(repo.root, branch);
    if (!sw.ok) return fail(`${sw.detail}\nThe linked branch is ${branch}.`);
  }
  return ok({ number, branch });
}

async function runRepo(action: string, params: any, deps: GithubDeps, repo: RepoRef): Promise<GithubResult> {
  if (action === "view") {
    const res = await call(deps, repo.root, ["repo", "view", "--json", "nameWithOwner,defaultBranchRef,viewerPermission,url"]);
    if (!res.ok) return fail(ghDetail(res));
    const data = jsonOr(res.stdout);
    if (!data) return fail("gh returned something that is not the repository.");
    const templates = await prTemplates(repo.root);
    return ok({
      repo: String(data.nameWithOwner ?? `${repo.owner}/${repo.repo}`),
      url: data.url ? String(data.url) : undefined,
      defaultBranch: data.defaultBranchRef?.name ? String(data.defaultBranchRef.name) : undefined,
      permission: data.viewerPermission ? String(data.viewerPermission) : null,
      templates: templates.map((t) => ({ path: t.path, body: clip(t.body, 2000) })),
    });
  }
  if (action === "search") {
    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (!query) return fail("A search query is required.");
    if (query.startsWith("-")) return fail("A search query cannot start with \"-\".");
    const limit = String(limitOf(params.limit));
    const socket = githubSocketPath(deps.env);
    if (socket) {
      const res = await brokerCall({ socketPath: socket, op: "github_repo.search", args: { query, limit: limitOf(params.limit) }, timeoutMs: 30_000, signal: deps.signal });
      if (!res.ok) return fail(res.error);
      const data = res.data ?? {};
      return ok({
        issues: Array.isArray(data.issues) ? data.issues : [],
        pullRequests: Array.isArray(data.pullRequests) ? data.pullRequests : [],
      });
    }
    const wantIssues = !/\bis:pr\b/.test(query) || /\bis:issue\b/.test(query);
    const wantPrs = !/\bis:issue\b/.test(query) || /\bis:pr\b/.test(query);
    // `gh issue list` uses the repository gh resolved. Search has to name one, and origin is not that.
    const resolved = await ghOwnerRepo(deps, repo);
    if ("error" in resolved) return fail(resolved.error);
    const repoArg = `${resolved.owner}/${resolved.repo}`;
    const issues = wantIssues ? await call(deps, repo.root, ["search", "issues", query, "--repo", repoArg, "--limit", limit, "--json", "number,title,state,url"]) : undefined;
    const prs = wantPrs ? await call(deps, repo.root, ["search", "prs", query, "--repo", repoArg, "--limit", limit, "--json", "number,title,state,url"]) : undefined;
    if (issues && !issues.ok) return fail(ghDetail(issues));
    if (prs && !prs.ok) return fail(ghDetail(prs));
    const parse = (res: GhOut | undefined) => (res ? jsonOr(res.stdout) ?? [] : []);
    return ok({ issues: parse(issues), pullRequests: parse(prs) });
  }
  if (action === "releases") {
    // `url` is not a release-list field; asking for it makes gh reject the whole call.
    const res = await call(deps, repo.root, ["release", "list", "--limit", String(limitOf(params.limit)), "--json", "tagName,name,publishedAt,isDraft,isPrerelease"]);
    if (!res.ok) return fail(ghDetail(res));
    const data = jsonOr(res.stdout);
    if (!Array.isArray(data)) return fail("gh returned something that is not a list of releases.");
    return ok(data);
  }
  return fail(`Unknown github_repo action "${action}".`);
}

// ---------- commands ----------

const REVIEW_WORDS: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

export function renderPr(pr: any): string {
  const state = [pr.draft ? "draft" : String(pr.state ?? "").toLowerCase(), REVIEW_WORDS[pr.review] ?? undefined].filter(Boolean).join(", ");
  const checks = checksLine(pr.checks ?? undefined);
  const lines = [`PR #${pr.number}  ${pr.title}`, `  ${state}${checks ? ` · ${checks}` : ""}`];
  if (pr.sha) lines.push(`  head ${pr.sha.slice(0, 12)}`);
  if (pr.url) lines.push(`  ${pr.url}`);
  return lines.join("\n");
}

export function renderIssues(issues: any[], empty = "No issues."): string {
  if (!issues.length) return empty;
  return issues.map((i) => `#${i.number}  ${i.title}`).join("\n");
}

export function renderIssue(issue: any): string {
  const labels = (issue.labels ?? []).join(", ");
  const lines = [`#${issue.number}  ${issue.title}`, `  ${String(issue.state ?? "").toLowerCase()}${labels ? ` · ${labels}` : ""}`];
  if (issue.url) lines.push(`  ${issue.url}`);
  if (issue.body) lines.push("", clip(String(issue.body), 2000));
  return lines.join("\n");
}

export async function handlePrCommand(args: string, ctx: any, deps: GithubDeps): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts[0] === "new") {
    await ctx.sendUserMessage(
      "Open a pull request for the current branch. Use github_pr with action \"create\": pass a title, a summary and a test plan. " +
      "The tool fills the repository's pull request template when there is one (if several are listed, pass template with the one you chose) and adds Closes #n for issues the branch or the commits name. Do not merge it.",
    );
    return;
  }
  if (parts[0] === "review") {
    const n = positiveInt(parts[1]);
    if (!n) { ctx.ui.notify("Usage: /pr review <number>", "error"); return; }
    await ctx.sendUserMessage(
      `Review pull request #${n}. Use github_pr action "view" and the git tool action "diff" to read it, then github_pr action "review" with decision "comment" and inline comments where a line needs one. ` +
      "Do not approve or request changes unless the user asked for that decision.",
    );
    return;
  }
  const number = parts[0] && /^\d+$/.test(parts[0]) ? Number(parts[0]) : undefined;
  const res = await executeGithub("github_pr", { action: "view", number }, deps);
  if (res.isError || !res.data) { ctx.ui.notify(res.text, "error"); return; }
  ctx.ui.notify(renderPr(res.data), "info");
}

export async function handleIssuesCommand(args: string, ctx: any, deps: GithubDeps): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const startAt = parts[0] === "start" ? 1 : parts[1] === "start" ? 0 : -1;
  if (startAt >= 0) {
    const n = positiveInt(parts[startAt]);
    if (!n) { ctx.ui.notify("Usage: /issues <number> start", "error"); return; }
    const res = await executeGithub("github_issue", { action: "start", number: n }, deps);
    ctx.ui.notify(res.isError ? res.text : `On ${res.data?.branch} for issue #${n}.`, res.isError ? "error" : "info");
    return;
  }
  if (parts.length === 0) {
    const res = await executeGithub("github_issue", { action: "list", assignee: "@me", state: "open" }, deps);
    if (res.isError || !Array.isArray(res.data)) { ctx.ui.notify(res.text, "error"); return; }
    ctx.ui.notify(renderIssues(res.data, "No open issues assigned to you."), "info");
    return;
  }
  const n = positiveInt(parts[0]);
  if (!n || parts.length > 1) { ctx.ui.notify("Usage: /issues, /issues <number>, or /issues <number> start", "error"); return; }
  const res = await executeGithub("github_issue", { action: "view", number: n }, deps);
  if (res.isError || !res.data) { ctx.ui.notify(res.text, "error"); return; }
  ctx.ui.notify(renderIssue(res.data), "info");
}
