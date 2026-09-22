# Spec: git and GitHub in Kernal (`kernal-github`)

Status: proposal, for review. Nothing here is built yet.

## Goal

Make everyday git and GitHub work easy for both the agent and the person using it: committing,
pulling, branching, pull requests (open, comment, review, approve, merge), checking the state of the
codebase, and working with issues. Getting there should take one command: install `gh` if it is
missing, sign in, and go.

It must work the same way in all three places Kernal runs:

| Where | Who is at the keyboard | GitHub credentials |
|---|---|---|
| **Local**: an installed release or a source checkout, on Matthew's or Matej's machine | a person, in the terminal UI or `kernal -p` | that person's own `gh` login |
| **Cloud**: an Outfitter run (Cloud Run Job sandbox, `pi --mode rpc` under agentd) | a person through the Outfitter web UI, or nobody (automations, mailbox) | never inside the agent; agentd and the API hold them |
| **Teleport**: a session moving between the two | either | whichever side it is on |

Guardrails are deliberately light. The agent does what it is asked; the design goal is that it can
do it in one clear step instead of improvising shell commands.

## What exists today, and what we learned

- The agent runs `git` and `gh` through its bash tool. There are no git tools, no conventions in the
  prompt, and nothing that sets up `gh`.
- Kernal already uses git and GitHub for its own upkeep: the daily update check and `/report` call
  `gh`; teleport's git store and its clean-tree and pushed-branch checks run `git`; the banner reads
  `git config user.email`.
- **In the cloud the agent has no GitHub token, on purpose.** agentd runs as root and does the clone,
  checkpoint commits and pushes, passing the token to each git child through `GIT_CONFIG_*`
  environment variables; pi and every command the model runs are the unprivileged `agent` user and
  cannot read it (outfitter `docs/protocol.md`, "Two Linux users"; `docs/reports/security-review-pr1.md`
  finding #1). The clone is `--single-branch` on the session branch. The image already has `gh`
  installed "for E6", unused. So in the cloud, `gh` inside the agent cannot simply work, and it
  should not be made to by handing the model a token.
- Research (four evaluations, 2026-09-22) found no pi package worth adopting whole. Borrowed ideas:
  - `@gotgenes/pi-github-tools`: wait for the CI run of an exact commit, then watch that run;
    a timeout is a normal result; only reads retry.
  - `@estebanforge/pi-git-me`: commit message on stdin; headless behaviour decided up front;
    an editable preview as an optional approval step.
  - `@firstpick/pi-extension-git-guided-workflow`: push an exact commit with an explicit refspec
    after `--`; process hygiene (args array, timeout, output caps, `GIT_OPTIONAL_LOCKS=0`).
  - `@sesori/pr-monitor-pi`: merge pinned to the head SHA; auto-merge only enabled by config.
  - `@narumitw/pi-github-pr`: PR review state, checks and comment counts for the current branch.
    Used for ideas only, because the status bar is already full: it becomes part of `/git` and the
    status tool instead.
  - Claude Code and Codex: short git rules in the system prompt; PR bodies with a summary and a test
    plan that follow the repository's PR template; configurable attribution added exactly once.
  - Rejected: `@sfroment/pi-gh-cli` (GPL-3.0 cannot go in our bundles), `pi-pr-review` (duplicates
    pi-subagents), a read-write GitHub MCP server (a second write path gated by tool-name globs).
- GitHub's MCP server only speaks to GitHub's API: it cannot commit, pull, branch or read the working
  tree. Hosting it on the LiteLLM proxy would make every person act as one shared account, or need
  each person's token passed through, which brings back the local `gh` login anyway. Not the core.

## Design

One new extension, `.pi/extensions/kernal-github/`, plus a small shared git module that teleport
moves onto. Inside it, every operation goes through a **backend** chosen at start:

```
tools, commands, /admin section
        │
        ▼
   operations (status, commit, branch, sync, pr.*, issue.*, ci.*)
        │
        ├── LocalBackend   git + gh as the signed-in person        (local, teleported-in)
        └── BrokerBackend  local git for the working tree;          (cloud: OUTFITTER_SESSION_ID set)
                           network and GitHub API via agentd
```

The tools, their inputs and their results are identical on both backends, so the agent, the
prompt text and teleported sessions never care where they run. A backend reports its capabilities
(for example, "branches other than the session branch: no" in cloud v1) and a tool that needs a
missing capability returns a plain explanation instead of failing oddly.

### Agent tools

Four tools, each with an `action`, to keep the prompt small (target: under 2,500 tokens for all
four, measured in a test so it cannot creep).

| Tool | Actions |
|---|---|
| `git` | `status`, `diff`, `log`, `commit`, `branch` (list, create, switch, delete merged), `pull`, `push`, `stash` |
| `github_pr` | `view`, `list`, `create`, `edit`, `checkout`, `comment`, `reply` (to a review thread), `review` (comment, approve, request changes, with inline comments), `resolve` (a thread), `checks`, `wait_ci`, `merge` |
| `github_issue` | `list`, `view`, `create`, `comment`, `edit` (title, body, labels, assignees), `close`, `reopen`, `start` (branch linked to the issue) |
| `github_repo` | `view` (default branch, PR template, permissions), `search` (issues and PRs), `releases` |

Behaviour that matters:

- **`git status` is the "codebase status" answer.** One call returns: repo and remote, current
  branch and its upstream, ahead or behind, staged, unstaged and untracked files (counts, then paths
  up to a cap), stashes, the last commit, and, when the branch has a PR, its number, state, review
  decision, unresolved thread count and check summary. `/git` renders the same thing for the person.
  This is where the `@narumitw/pi-github-pr` idea lives.
- **`commit`** takes the paths to stage explicitly (or `all: true`) and a message, passed on stdin
  (`git commit -F -`). It never skips hooks. If a hook changes files or fails, the result says so
  with the hook's output, and the agent makes a new commit rather than amending. Attribution
  (below) is appended exactly once.
- **`push`** pushes the current branch's exact commit with an explicit refspec after `--`, and sets
  the upstream the first time. `force` is not an option of the tool; `force_with_lease` is, and only
  for the agent's own branch.
- **`pull`** is fetch plus fast-forward by default; `rebase: true` rebases. Conflicts come back as a
  list of files and the next step, never a half-finished state the tool hides.
- **`github_pr create`** reads the repository's PR template when there is one and fills it;
  otherwise it writes a summary and a test plan. It links issues named in the branch or commits
  (`Closes #n`). It returns the URL.
- **`review`** can approve, request changes or comment, with inline comments on lines of the diff.
  **`merge`** takes the method (merge, squash, rebase) and is pinned to the head SHA the agent last
  saw, so it fails if the PR changed underneath.
- **`wait_ci`** finds the checks for the pushed commit, streams progress through the tool's update
  callback, and returns pass, fail (with the failing job's log tail) or timeout, all as normal
  results.
- **`github_issue start`** creates a branch linked to the issue (`gh issue develop`) and switches to
  it, so the PR closes the issue.

### Light guardrails

As agreed, no approval prompts for everyday work, in the UI or headless. What remains:

- **Prompt rules**, a short block modelled on Claude Code and Codex: commit, push, approve and merge
  only when the person asked in this conversation; never force-push, skip hooks or change git
  config; stage by name; never commit secrets; never revert changes you did not make.
- **One setting**, `github.confirm`: `none` (default), `merge` (ask before merge and approve), or
  `writes` (ask before anything that changes GitHub or pushes). With a UI it opens an editable
  preview (the `pi-git-me` pattern); headless, a confirm-required action is refused with a message
  that names the setting. The default never blocks `kernal -p`.
- **No shell interception.** The agent can still run `git` and `gh` in bash; the tools are simply
  the easier path.

### Attribution

Settings `github.attribution.commit` and `github.attribution.pr`, each a string or empty:

- default commit trailer: `Co-Authored-By: Kernal <noreply@kernal.invalid>` style, final address to be
  decided;
- default PR footer: `Opened with Kernal`.

Added exactly once, checked before appending. In the cloud the commit author is the session's human
owner (their name and GitHub noreply address from the Outfitter user record), not the token owner.

### Setup: installing `gh` and signing in (local)

`/github` with no arguments shows status; `/github setup` does whatever is missing, in order:

1. **Find `gh`**: on `PATH`, then `~/.kernal/bin/gh`.
2. **Install it if missing.** Download the official release for this platform from
   `github.com/cli/cli/releases` (the same four platforms Kernal ships), verify it against the
   release's `gh_<version>_checksums.txt`, and unpack `gh` into `~/.kernal/bin`. No admin rights, no Homebrew. The
   launcher already controls `PATH`, so `~/.kernal/bin` goes first. In a source checkout the binary
   goes in the git-ignored `kernal/.pi/bin`. Bundling `gh` in every release (about 40 MB per
   platform) is the alternative; downloading on first use keeps releases small. Decision below.
3. **Sign in**: `gh auth login --web --git-protocol https --hostname github.com`, which shows a
   one-time code and opens the browser (or prints the URL on a machine without one). `gh` always
   asks for `repo`, `read:org` and `gist`; setup adds `--scopes workflow` so the agent can edit
   workflow files and re-run checks.
4. **Connect git**: `gh auth setup-git`, so `git push` over HTTPS uses the same login. No SSH keys.
5. **Check**: account, scopes, and whether the current repository is reachable and writable.

`GH_TOKEN` or `GITHUB_TOKEN` in the environment still wins, for people who prefer a token. Each
person uses their own account; nothing is issued by Matthew. `kernal setup` (the terminal
command) offers the same step, and the first-run setup mentions it once.

`/admin` gets a **GitHub** page: signed-in account and avatar, scopes, git connected or not, the
current repository with its default branch and your permission there, and buttons for Install `gh`,
Sign in, Sign out and Re-check. In the cloud it shows the broker's identity and the session's repo
instead, read-only.

### The person's commands

| Command | Does |
|---|---|
| `/git` | the status view above, with the PR, reviews and checks |
| `/commit [message]` | asks the agent to review the diff and commit, or commits with the given message |
| `/pr` | the current branch's PR; `/pr new` asks the agent to open one; `/pr review <n>` asks it to review one |
| `/issues` | open issues assigned to you, then `/issues <n>` to view one and `start` it |
| `/github` | setup and sign-in, as above |

The commands are thin: they either render data directly or hand the agent a precise instruction,
so the same logic serves both.

### Cloud: the broker

Rule kept from Outfitter: **the GitHub token never enters the agent's process or its shell.**

- **Working-tree operations run locally as `agent`**: status, diff, log, commit, branch create and
  switch, stash. They need no credentials. Commits made by the agent are ordinary commits; agentd's
  checkpoint then only commits leftovers and pushes (today it already commits "all" if anything is
  dirty, then pushes).
- **Network and API operations go to the broker**: fetch, pull, push, and every `github_*` action.
  The extension sends a request over a Unix socket that agentd serves at `$OUTFITTER_GITHUB_SOCKET`
  (mode `0660`, group `agent`). agentd:
  - does git network operations itself as root with the per-session token (as for checkpoints);
  - forwards GitHub API requests up the existing link as a new frame, `github.request {reqId, op,
    args}`, answered by `github.result {reqId, ok, data | error}`. The API executes them with the
    run's GitHub credential (today the fine-grained PAT; the E2.5 GitHub App installation token
    later) and records them for audit.
  - enforces a small policy: only the session's repository; pushes only to the session branch (v1)
    or branches under a configured prefix (v2); merges only if the guru's config allows it.
- **Branches in v1**: one working branch per session, the one agentd cloned or created. `branch
  create` and `switch` return "this cloud session works on `<branch>`" rather than breaking the
  checkpoint push, which targets `spec.repo.branch`. v2 lets agentd push whichever branch is checked
  out, reported in the `checkpoint` frame.
- **Identity**: API actions appear as the credential's owner. With a PAT that is Matthew, so a PR
  opened from the cloud cannot then be approved by Matthew (GitHub forbids approving your own PR),
  and anything Matej's cloud session does appears as Matthew. The GitHub App (E2.5 phase 2) fixes
  this: actions appear as the app, and user-to-server tokens can later make them appear as the
  person. Until then the tools say who they will act as.
- **Why agentd plus the API, not agentd alone**: the API already holds the credential and will mint
  App tokens; routing through it gives one audit log and one policy, and E6 (webhooks, PR Fixer and
  Reviewer gurus) needs the same broker anyway. The image's unused `gh` package can then be dropped
  (about 38 MB).
- Outfitter changes needed (owned by the Outfitter work, specified here so the interface is agreed):
  the socket in agentd, the two frames in `docs/protocol.md`, the API's executor and policy, and a
  protocol version bump.

### Teleport

- Teleport's git checks (clean tree, branch pushed, same repository) move into the shared git module
  so both extensions agree on what "clean" and "pushed" mean; teleport's tests keep passing
  unchanged.
- **Laptop to cloud**: before a push, `/teleport` can offer to commit and push through the new tools
  instead of refusing with "commit or stash first". The cloud side then clones that branch.
- **Cloud to laptop**: the local side fetches the session branch (`outfitter/<session>` refs
  included) with the person's own login, and checks it out, as teleport does today.
- `git status` shows teleport-relevant facts: "branch not pushed", "session branch is 3 commits
  ahead of your checkout".

### Non-interactive runs and subagents

- Every `gh` and `git` child runs with stdin closed, `GH_PROMPT_DISABLED=1`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` for read operations, a timeout (30 s default,
  longer for `wait_ci` and network operations), and output caps. Nothing can hang `kernal -p`.
- Tools behave the same headless; only a `github.confirm` setting other than `none` changes that.
- pi-subagents children do not load the parent's extensions. The `worker` and `reviewer` roles get
  the tools only if we add them to those agents' tool lists; v1 leaves subagents on bash.

### Relation to existing features

- `kernal-update` and `/report` keep calling `gh`, but through the shared helper, so both find
  `~/.kernal/bin/gh`.
- `kernal-codebase-index` already shows the indexed branch; after `switch`, the status can suggest a
  re-index when the index is for another branch.
- A GitHub MCP server stays optional and read-only (with lockdown) for work on public repositories
  whose issues strangers can write. It is not part of this spec.

## Testing

- Unit tests for parsing (`git status --porcelain=v2`, `gh --json` output) and for each action's
  argument building, with no shell strings anywhere.
- Integration tests against a real temporary repository and a local bare remote: commit, branch,
  pull with conflicts, push with upstream.
- A fake `gh` on `PATH` that records its arguments and replays canned JSON, for every `github_*`
  action and for setup (missing `gh`, signed out, signed in, missing scopes).
- A fake broker socket for the cloud backend, including policy refusals.
- A test that the four tools' definitions stay under the prompt budget.
- A live test (opt-in, like the existing live suite) against a scratch repository: open a PR, comment,
  wait for a trivial check, close it.

## Delivery

| Phase | Contents | Where |
|---|---|---|
| 1 | Shared git module (teleport moved onto it); `/github setup` with install and sign-in; `/admin` GitHub page; `git` tool; `/git`, `/commit`; prompt rules; attribution | Kernal |
| 2 | `github_pr` and `github_issue` (all actions), `github_repo`, `/pr`, `/issues`, `wait_ci` | Kernal |
| 3 | Broker backend; Outfitter socket, frames, API executor and policy | Kernal + Outfitter |
| 4 | Cloud multi-branch; GitHub App identity; teleport offers commit-and-push; optional read-only MCP | Kernal + Outfitter |

Each phase is its own PR with tests; phases 1 and 2 are useful locally on their own.

## Open questions

1. **Bundle `gh` or download on first use?** Recommendation: download on first use, verified by
   checksum; revisit if first-run downloads prove fragile.
2. **Attribution text and address** for commits and PRs, and whether it is on by default.
3. **Cloud identity before the GitHub App**: accept "everything appears as Matthew" for now, or do the
   App (E2.5 phase 2) before phase 3?
4. **Merges from the cloud**: allowed by default, or only when the guru's config says so?
5. **Subagents**: give `worker` and `reviewer` the new tools in phase 2, or keep them on bash?
