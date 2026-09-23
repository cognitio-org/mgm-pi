/**
 * kernal-github (phase 1): git the agent and the person can actually use.
 *
 * Registers one `git` tool (status, diff, log, commit, push, pull, branch, stash), the rules the
 * model follows around it, and three commands: `/git` (where this repository stands, with its pull
 * request), `/commit` (review the diff and commit), `/github` (install the GitHub CLI and sign in).
 *
 * Why a tool at all, when the model has a shell: the shell answer to "where am I?" is five commands
 * and a guess at the output. `git status` here is one call that already knows the branch, what
 * changed, whether it is pushed, and what the pull request and its checks say. Everything else in
 * the tool exists so a commit message with quotes cannot be mangled on a command line, a push can
 * never be a silent force-push, and a refused hook comes back as something the model can act on.
 * The shell still works; this is the easier path, not a fence (kernal/docs/git-github-spec.md).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSettings } from "../connect/settings.ts";
import * as git from "../_shared/git.ts";
import { attributionFrom, renderStatus, repoStatus, runAction } from "./lib.ts";
import { authState, findGh, installGh, kernalBin, loginCommand, missingScopes, setupGitCommand } from "./gh.ts";

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

export default function (pi: ExtensionAPI) {
  const settings = () => { try { return readSettings(); } catch { return {}; } };

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
      const res = await runAction(action, params ?? {}, { cwd: ctx?.cwd ?? process.cwd(), settings: settings(), gh: await ghNow() });
      return { content: [{ type: "text", text: res.text }], isError: res.isError };
    },
  } as any);

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
}
