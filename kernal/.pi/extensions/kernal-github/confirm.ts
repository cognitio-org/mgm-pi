/**
 * `github.confirm` and the per-call gate (kernal/docs/git-github-spec.md, "Light guardrails").
 *
 * The default is `none` so a headless `kernal -p` is never blocked. A person being present is not
 * `ctx.hasUI`: RPC mode has a UI and may have nobody watching, and this module does not guess.
 * The caller passes `personPresent` and, when someone is there, an `ask` that shows the preview.
 */

export type GithubConfirm = "none" | "merge" | "writes";
export type GithubClass = "read" | "write" | "merge" | "push";

/** Missing or unknown is `none`: the setting must be chosen, not implied. */
export function githubConfirmFrom(settings: unknown): GithubConfirm {
  const v = (settings as { github?: { confirm?: unknown } } | null | undefined)?.github?.confirm;
  const s = typeof v === "string" ? v.trim() : "";
  return s === "none" || s === "merge" || s === "writes" ? s : "none";
}

const READ = new Set([
  "github_pr:view", "github_pr:list", "github_pr:checks", "github_pr:wait_ci",
  "github_issue:list", "github_issue:view",
  "github_repo:view", "github_repo:search", "github_repo:releases",
  "git:status", "git:diff", "git:log",
]);
const WRITE = new Set([
  "github_pr:create", "github_pr:edit", "github_pr:comment", "github_pr:reply", "github_pr:resolve", "github_pr:checkout",
  "github_issue:create", "github_issue:comment", "github_issue:edit", "github_issue:close", "github_issue:reopen", "github_issue:start",
  "git:commit", "git:pull", "git:branch", "git:stash",
]);

/** Approve and request-changes are the reviews that land on the pull request as a decision. */
function reviewClass(decision: unknown): "write" | "merge" {
  const d = (typeof decision === "string" ? decision : "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return d === "approve" || d === "request-changes" ? "merge" : "write";
}

/**
 * What a tool call is, for the gate. An action the table does not name is a write, so `writes`
 * asks for it. `merge` still lets a write through: it only stops merges and approving reviews.
 */
export function classifyGithub(tool: string, action: string, params?: { decision?: string }): GithubClass {
  const key = `${tool.trim().toLowerCase()}:${action.trim().toLowerCase()}`;
  if (key === "git:push") return "push";
  if (key === "github_pr:merge") return "merge";
  if (key === "github_pr:review") return reviewClass(params?.decision);
  if (READ.has(key)) return "read";
  if (WRITE.has(key)) return "write";
  return "write";
}

/** `merge` stops only merges and approving reviews; `writes` stops every change, including push. */
function needsConfirm(confirm: GithubConfirm, cls: GithubClass): boolean {
  if (cls === "read" || confirm === "none") return false;
  if (confirm === "merge") return cls === "merge";
  return cls === "write" || cls === "merge" || cls === "push";
}

/** Tool names pi-subagents can exclude. Off lists all of them; read and full list none. */
export const GITHUB_TOOL_NAMES = ["git", "github_pr", "github_issue", "github_repo"] as const;

export type GithubToolsMode = "off" | "read" | "full";

/** Per-agent access. Off denies every GitHub tool. Read allows only the read class. Full allows all. */
export function githubToolsAllows(mode: GithubToolsMode, tool: string, action: string, params?: { decision?: string }): boolean {
  if (mode === "off") return false;
  if (mode === "full") return true;
  return classifyGithub(tool, action, params) === "read";
}

/** `excludeTools` after applying this agent's GitHub choice. Other denied tools are kept. */
export function excludeToolsFor(mode: GithubToolsMode, existing: string[]): string[] {
  const rest = existing.filter((name) => !(GITHUB_TOOL_NAMES as readonly string[]).includes(name));
  return mode === "off" ? [...rest, ...GITHUB_TOOL_NAMES] : rest;
}

export async function gateGithub(opts: {
  confirm: GithubConfirm;
  cls: GithubClass;
  personPresent: boolean;
  ask?: () => Promise<boolean>;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!needsConfirm(opts.confirm, opts.cls)) return { ok: true };
  if (!opts.personPresent) {
    return { ok: false, message: `Refused: github.confirm is "${opts.confirm}", and no one is here to confirm this ${opts.cls}.` };
  }
  const yes = opts.ask ? await opts.ask() : false;
  if (!yes) return { ok: false, message: `Refused: this ${opts.cls} was not confirmed.` };
  return { ok: true };
}
