/**
 * kernal-github: git the agent and the person can actually use, and the GitHub tools beside it.
 *
 * Registers the `git` tool (status, diff, log, commit, push, pull, branch, stash), `github_pr`,
 * `github_issue` and `github_repo`, the rules the model follows around them, and the commands
 * `/git`, `/commit`, `/github`, `/pr` and `/issues`. The GitHub tool bodies live in github-tools.ts;
 * this file only wires them up.
 *
 * Why a tool at all, when the model has a shell: the shell answer to "where am I?" is five commands
 * and a guess at the output. `git status` here is one call that already knows the branch, what
 * changed, whether it is pushed, and what the pull request and its checks say. Everything else in
 * the tool exists so a commit message with quotes cannot be mangled on a command line, a push can
 * never be a silent force-push, and a refused hook comes back as something the model can act on.
 * The shell still works; this is the easier path, not a fence (kernal/docs/git-github-spec.md).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { readSettings } from "../connect/settings.ts";
import * as git from "../_shared/git.ts";
import { attributionFrom, renderStatus, repoStatus, runAction } from "./lib.ts";
import { classifyGithub, gateGithub, githubConfirmFrom, githubToolsAllows, type GithubToolsMode } from "./confirm.ts";
import { authState, findGh, installGh, kernalBin, loginCommand, missingScopes, setupGitCommand } from "./gh.ts";
import { executeGithub, githubIssueTool, githubPrTool, githubRepoTool, handleIssuesCommand, handlePrCommand } from "./github-tools.ts";

const AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const ACTIVE_AGENT = /<active_agent\s+name="([^"]*)"\s*\/>/;

function modeValue(raw: unknown): GithubToolsMode | undefined {
  return raw === "off" || raw === "read" || raw === "full" ? raw : undefined;
}

/** pi-subagents puts this at the start of the child prompt. The tool context never receives `githubTools`. */
function activeAgent(prompt: string): { present: boolean; name?: string } {
  const match = ACTIVE_AGENT.exec(prompt);
  if (!match) return { present: false };
  const name = match[1]?.trim() ?? "";
  return AGENT_NAME.test(name) ? { present: true, name } : { present: true };
}

async function systemPromptOf(ctx: any): Promise<string> {
  const parts: string[] = [];
  if (typeof ctx?.getSystemPrompt === "function") {
    try {
      const value = await ctx.getSystemPrompt();
      if (typeof value === "string") parts.push(value);
    } catch { /* a missing prompt is not permission */ }
  }
  if (typeof ctx?.systemPrompt === "string") parts.push(ctx.systemPrompt);
  if (typeof ctx?.appendSystemPrompt === "string") parts.push(ctx.appendSystemPrompt);
  return parts.join("\n");
}

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const home = homedir();
  if (!configured) return join(home, ".pi", "agent");
  if (configured === "~") return home;
  if (configured.startsWith("~/")) return join(home, configured.slice(2));
  return configured;
}

/** Project `.pi/agents/<name>.md` wins, walking up from cwd as far as the git root. Then the user agent dir. */
function agentFile(cwd: string, name: string): string | undefined {
  const base = `${name}.md`;
  let dir = resolve(cwd);
  const stop = parse(dir).root;
  for (;;) {
    const project = join(dir, ".pi", "agents", base);
    if (existsSync(project)) return project;
    if (existsSync(join(dir, ".git")) || dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const user = join(agentDir(), "agents", base);
  return existsSync(user) ? user : undefined;
}

/** `githubTools` in that file. A file with no usable value is off: missing means off for an agent. */
function modeInFile(file: string): GithubToolsMode {
  try {
    const text = readFileSync(file, "utf8");
    const end = text.startsWith("---\n") ? text.indexOf("\n---", 3) : -1;
    if (end < 0) return "off";
    const match = /^githubTools:[ \t]*["']?([^\s#"']+)["']?[ \t]*$/m.exec(text.slice(4, end));
    return modeValue(match?.[1]) ?? "off";
  } catch {
    return "off";
  }
}

/**
 * The running agent's GitHub access. The parent session has none and stays unrestricted.
 * A subagent (`PI_SUBAGENT_CHILD`, or an `<active_agent>` tag) is never treated as unrestricted
 * just because the tool context omitted the field: the mode is read from the agent file, and a
 * child we cannot resolve is off.
 */
async function agentGithubTools(ctx: any): Promise<GithubToolsMode | undefined> {
  const explicit = modeValue(ctx?.githubTools ?? ctx?.agent?.githubTools);
  if (explicit) return explicit;
  const tagged = activeAgent(await systemPromptOf(ctx));
  const child = process.env.PI_SUBAGENT_CHILD === "1" || tagged.present;
  if (!child) return undefined;
  const file = tagged.name ? agentFile(ctx?.cwd ?? process.cwd(), tagged.name) : undefined;
  return file ? modeInFile(file) : "off";
}

/** Found once per session, then reused; `/github setup` refreshes it after an install. */
let ghCache: { path: string; version: string; managed: boolean } | undefined;
let ghLooked = false;

async function ghNow(force = false) {
  if (force || !ghLooked) { ghCache = await findGh(); ghLooked = true; }
  return ghCache;
}

/**
 * pi appends these to the shared Guidelines section, where they sit among rules about every other
 * tool, so each one names git itself rather than relying on the reader knowing what it is about.
 */
const GUIDELINES = [
  "git: use the git tool rather than running git in bash; it reports the whole repository state in one call and keeps commit messages, pushes and pulls predictable.",
  "git: commit and push only when the user asked for it, never rewrite published history, never force-push (forceWithLease is for your own branch, and only when asked), and never change git config.",
  "git: stage the files you mean by name rather than committing everything, and never commit credentials or a .env file.",
  "git: never skip hooks. If a hook refuses a commit, fix what it reports and make a new commit: the commit did not happen, so there is nothing to amend.",
  "git: never revert or discard changes you did not make, and never reset a branch the user has not asked you to reset.",
];

const CONFIRM_TIMEOUT_MS = 60_000;

/** A person is at the terminal. RPC has a UI and may have nobody watching; a cloud run has no viewer yet. */
function personHere(ctx: any): boolean {
  if (process.env.OUTFITTER_SESSION_ID) return false;
  return ctx?.mode === "tui";
}

function confirmPreview(tool: string, action: string, params: any): string {
  const lines = [`${tool} ${action}`];
  if (params?.decision) lines.push(String(params.decision));
  if (params?.number) lines.push(`#${params.number}`);
  const title = typeof params?.title === "string" ? params.title.trim() : "";
  const message = typeof params?.message === "string" ? params.message.trim().split("\n")[0] : "";
  const shown = (title || message).slice(0, 120);
  if (shown) lines.push(shown);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  const settings = () => { try { return readSettings(); } catch { return {}; } };

  /** Per-agent access first, then `github.confirm`. Undefined means the call may run. */
  async function refuseGithub(ctx: any, tool: string, action: string, params: any): Promise<string | undefined> {
    const mode = await agentGithubTools(ctx);
    if (mode && !githubToolsAllows(mode, tool, action, params)) {
      return `Refused: this agent's GitHub access is ${mode}.`;
    }
    const cls = classifyGithub(tool, action, params);
    const gate = await gateGithub({
      confirm: githubConfirmFrom(settings()),
      cls,
      personPresent: personHere(ctx),
      ask: async () => {
        const confirm = ctx?.ui?.confirm;
        if (typeof confirm !== "function") return false;
        try {
          return await confirm.call(ctx.ui, `Allow this ${cls}?`, confirmPreview(tool, action, params), { timeout: CONFIRM_TIMEOUT_MS }) === true;
        } catch {
          return false;
        }
      },
    });
    return gate.ok ? undefined : gate.message;
  }

  pi.registerTool({
    name: "git",
    label: "Git",
    description:
      "Work with the git repository: status (branch, changes, upstream, and this branch's pull request with its review state and checks), diff, log, commit, push, pull, branch and stash. Prefer this over running git in bash.",
    promptSnippet: "git: repository status (including this branch's pull request), diff, log, commit, push, pull, branch, stash.",
    promptGuidelines: GUIDELINES,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["status", "diff", "log", "commit", "push", "pull", "branch", "stash"], description: "What to do" },
        message: { type: "string", description: "commit: the message. A subject line, then a blank line, then why the change was made." },
        paths: { type: "array", items: { type: "string" }, description: "commit: the files to stage, relative to the repository root. diff: limit to these paths." },
        all: { type: "boolean", description: "commit: stage every change, including untracked files. Prefer naming paths." },
        tracked: { type: "boolean", description: "commit: stage the tracked files that changed, and nothing untracked." },
        amend: { type: "boolean", description: "commit: amend the previous commit. Only for a commit that was never pushed." },
        staged: { type: "boolean", description: "diff: show what is staged instead of what is not." },
        stat: { type: "boolean", description: "diff: summarise as a file list with counts." },
        limit: { type: "number", description: "log: how many commits (default 10)." },
        range: { type: "string", description: "log: a revision range, e.g. main..HEAD." },
        rebase: { type: "boolean", description: "pull: rebase instead of fast-forward." },
        forceWithLease: { type: "boolean", description: "push: replace your own branch, still refusing if someone else pushed to it." },
        op: { type: "string", enum: ["list", "create", "switch", "delete", "push", "pop"], description: "branch: list, create, switch or delete. stash: push or pop." },
        name: { type: "string", description: "branch: which branch." },
        from: { type: "string", description: "branch create: the starting point (default: the current branch)." },
        pullRequest: { type: "boolean", description: "status: set false to skip the pull request lookup." },
      },
    } as any,
    execute: async (_id: string, params: any, _signal: unknown, _update: unknown, ctx: any) => {
      const action = String(params?.action ?? "");
      const refusal = await refuseGithub(ctx, "git", action, params ?? {});
      if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
      const res = await runAction(action, params ?? {}, { cwd: ctx?.cwd ?? process.cwd(), settings: settings(), gh: await ghNow() });
      return { content: [{ type: "text", text: res.text }], isError: res.isError };
    },
  } as any);

  for (const def of [githubPrTool, githubIssueTool, githubRepoTool]) {
    pi.registerTool({
      ...def,
      execute: async (_id: string, params: any, signal: AbortSignal | undefined, update: any, ctx: any) => {
        const action = String(params?.action ?? "");
        const refusal = await refuseGithub(ctx, def.name, action, params ?? {});
        if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
        const res = await executeGithub(def.name, params ?? {}, {
          cwd: ctx?.cwd ?? process.cwd(), settings: settings(), gh: await ghNow(), update, signal,
        });
        return { content: [{ type: "text", text: res.text }], isError: res.isError };
      },
    } as any);
  }

  // ---------- /git ----------
  pi.registerCommand("git", {
    description: "Where this repository stands: branch, changes, what is pushed, and this branch's pull request",
    handler: async (_args: string, ctx: any) => {
      const st = await repoStatus(ctx.cwd ?? process.cwd(), await ghNow());
      if (!st) { ctx.ui.notify(`${ctx.cwd ?? process.cwd()} is not inside a git repository.`, "warning"); return; }
      ctx.ui.notify(renderStatus(st), "info");
    },
  });

  // ---------- /commit ----------
  pi.registerCommand("commit", {
    description: "Commit the current changes (with a message, or ask the agent to write one)",
    handler: async (args: string, ctx: any) => {
      const cwd = ctx.cwd ?? process.cwd();
      const st = await git.status(cwd);
      if (!st) { ctx.ui.notify(`${cwd} is not inside a git repository.`, "warning"); return; }
      if (st.clean) { ctx.ui.notify("Nothing to commit: the working tree is clean.", "info"); return; }
      const message = args.trim();
      if (!message) {
        // A command handler's return value is discarded by pi, so the turn is started explicitly.
        await ctx.sendUserMessage(
          "Commit the current changes. First run the git tool with action \"status\", then action \"diff\" to see what changed. " +
          "Stage the files that belong together by name and write a message that says what changed and why. " +
          "If the changes are unrelated, make more than one commit. Do not push.",
        );
        return;
      }
      // Tracked changes only: `all` would sweep in every untracked file, which is how a stray .env
      // or a scratch file ends up in a commit.
      const res = await runAction("commit", { message, tracked: true }, { cwd, settings: settings(), gh: await ghNow() });
      const skipped = st.untracked.length ? `\n${st.untracked.length} untracked file(s) were not committed; name them with the git tool to include them.` : "";
      ctx.ui.notify(res.text + (res.isError ? "" : skipped), res.isError ? "error" : "info");
    },
  });

  // ---------- /github ----------
  pi.registerCommand("github", {
    description: "GitHub setup: install the GitHub CLI, sign in, and check what kernal can do",
    getArgumentCompletions: (prefix: string) =>
      ["setup", "status", "install"].filter((o) => o.startsWith(prefix.trim())).map((o) => ({ value: o, label: o })),
    handler: async (args: string, ctx: any) => {
      const sub = args.trim().toLowerCase() || "status";
      if (sub !== "status" && sub !== "setup" && sub !== "install") {
        ctx.ui.notify(`Unknown /github option "${sub}". Try: status, setup, install`, "error");
        return;
      }

      let found = await ghNow(true);
      if (!found && (sub === "setup" || sub === "install")) {
        ctx.ui.notify("Installing the GitHub CLI from github.com/cli/cli (about 15 MB, checked against its published checksum)…", "info");
        const res = await installGh();
        if (!res.ok) { ctx.ui.notify(`Could not install the GitHub CLI: ${res.detail}\nInstall it yourself and run /github again.`, "error"); return; }
        found = await ghNow(true);
        ctx.ui.notify(`Installed gh ${res.version} in ${kernalBin()}.`, "info");
      }
      if (!found) {
        ctx.ui.notify("The GitHub CLI is not installed. Run /github setup to install it into kernal's own bin directory.", "warning");
        return;
      }

      const auth = await authState(found.path);
      const lines = [`gh ${found.version}${found.managed ? " (installed by kernal)" : ""} at ${found.path}`];
      if (!auth.signedIn) {
        lines.push("", "Not signed in. Run this in a terminal, then /github again:", `  ${loginCommand(found.managed ? found.path : "gh")}`);
        lines.push("", "A token in GH_TOKEN or GITHUB_TOKEN works too.");
        ctx.ui.notify(lines.join("\n"), "warning");
        return;
      }
      lines.push(`signed in as ${auth.login ?? "(unknown account)"}${auth.fromEnv ? " (token from the environment)" : ""}`);
      if (auth.scopes?.length) lines.push(`scopes: ${auth.scopes.join(", ")}`);
      const missing = missingScopes(auth.scopes);
      if (missing.length) lines.push(`missing scopes: ${missing.join(", ")} — rerun ${loginCommand(found.managed ? found.path : "gh")}`);
      if (!auth.gitConfigured) {
        lines.push("", "git does not use this login yet. This changes your global git config (it sets a credential helper for github.com):", `  ${setupGitCommand(found.managed ? found.path : "gh")}`);
      } else lines.push("git push over https uses this login");

      const st = await repoStatus(ctx.cwd ?? process.cwd(), found, { pr: false });
      if (st?.repo) lines.push("", `this repository: ${st.repo.owner}/${st.repo.repo}${st.repo.ssh ? " (SSH remote: kernal's GitHub tools need an https remote)" : ""}`);
      const attribution = attributionFrom(settings());
      lines.push("", `commit attribution: ${attribution.commit || "off"}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ---------- /pr ----------
  pi.registerCommand("pr", {
    description: "This branch's pull request; /pr new asks to open one, /pr review <n> asks to review",
    getArgumentCompletions: (prefix: string) =>
      ["new", "review"].filter((o) => o.startsWith(prefix.trim())).map((o) => ({ value: o, label: o })),
    handler: async (args: string, ctx: any) => {
      await handlePrCommand(args, ctx, { cwd: ctx.cwd ?? process.cwd(), settings: settings(), gh: await ghNow() });
    },
  });

  // ---------- /issues ----------
  pi.registerCommand("issues", {
    description: "Open issues assigned to you; /issues <n> views one, /issues <n> start checks out a branch for it",
    handler: async (args: string, ctx: any) => {
      await handleIssuesCommand(args, ctx, { cwd: ctx.cwd ?? process.cwd(), settings: settings(), gh: await ghNow() });
    },
  });
}
