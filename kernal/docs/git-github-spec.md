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
  finding #1). The image already has `gh` installed "for E6", unused, and E6 plans `gh pr create`
  from runs (EPIC.md). So in the cloud, `gh` inside the agent cannot simply work, and it should not
  be made to by handing the model a token.
- **Today's sandbox git has gaps this work depends on** (found while reviewing this spec, all in
  `outfitter/packages/agentd`):
  1. The checkpoint pushes only when agentd's own `commitAll` found something dirty
     (`run.ts`, `if (committed)`). Commits the agent makes itself are never pushed.
  2. The clone is `--single-branch` on the *base* branch; resuming a session then runs
     `git fetch origin <branch>` and `checkout -B <branch> origin/<branch>` (`git.ts`). With a
     single-branch refspec that fetch never creates `origin/<branch>`, so resuming any session that
     has checkpointed fails.
  3. After cloning, agentd hands `/workspace` to `agent` and later runs `git` as root inside it.
     Git refuses a repository owned by another user ("dubious ownership") and nothing sets
     `safe.directory`.
  4. Nothing sets a commit identity (`user.name`, `user.email`, `GIT_AUTHOR_*`), and `run.spec`
     carries no user identity, so `git commit` in the sandbox likely fails with "Author identity
     unknown".
  5. Teleporting laptop to cloud sends only the transcript: `OutfitterStore.put` drops the manifest
     and the import route creates the session with `repo: null`. A teleported-in cloud session has
     no clone.
  Items 1 to 4 are Outfitter fixes in their own right, and are phase 0 below: [PR #41](https://github.com/mgmonteleone/mgm-pi/pull/41).
  How it resolved them, which the rest of this spec follows:
  - **No `safe.directory`.** It would let root's git run hooks, fsmonitor, filters or `insteadOf`
    rules the agent planted in the checkout, with the token in its environment. Instead, local git
    operations (checkpoint commits included) run as the `agent` user.
  - **Pushes run as root from a private, root-owned bare repository** that borrows `/workspace`'s
    objects through git alternates and pushes to the session's clone URL. Root never runs git
    inside the agent's checkout.
  - The clone adds the session branch to `remote.origin.fetch`, so `origin/<branch>` exists after a
    resume and after pushes.
  - Commit identity is "the bot, on behalf of the person" (see "Attribution"), with pi given
    `OUTFITTER_AUTHOR_NAME`, `OUTFITTER_AUTHOR_EMAIL` and `OUTFITTER_AUTHOR_LOGIN` for the `git`
    tool to use.
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
  `writes` (ask before anything that changes GitHub or pushes). With a person present it opens an
  editable preview (the `pi-git-me` pattern); otherwise a confirm-required action is refused with a
  message that names the setting. The default never blocks `kernal -p`.
  - "A person present" is not `ctx.hasUI`: that is also true in RPC mode, where an Outfitter
    automation may have nobody watching. Dialogs always carry a timeout (pi's dialog `timeout`
    option), and an Outfitter run with no attached viewer counts as headless.
  - Locally the setting lives in `settings.json`; in the cloud it comes from the guru's config.
- **No shell interception.** The agent can still run `git` and `gh` in bash; the tools are simply
  the easier path. In the cloud, plain `git` reaches GitHub through the proxy (see "Cloud"); `gh`
  does not, because the shell has no token, so GitHub API work there goes through the tools.

### Attribution

Settings `github.attribution.commit` and `github.attribution.pr`, each a string or empty:

- default commit trailer: `Co-Authored-By: Kernal <noreply@kernal.invalid>` style, final address to be
  decided;
- default PR footer: `Opened with Kernal`.

Added exactly once, checked before appending. Locally the author is whatever the person's git
config says. In the cloud there is no identity today (gap 4), so phase 3 adds one: `run.spec.author
{name, email, login}` from the Outfitter user record, pinned as `GIT_AUTHOR_*` and `GIT_COMMITTER_*` in
pi's environment and in agentd's own git calls. **Decided: "the bot, on behalf of the person."**
- The Outfitter bot is both author and committer (`GIT_AUTHOR_*` and `GIT_COMMITTER_*`, pinned in
  pi's environment): `Outfitter <noreply@outfitter.invalid>`, and the GitHub App's bot identity
  once it exists. Not `outfitter@users.noreply.github.com`, which would credit commits to an
  unrelated GitHub user named `outfitter`.
- Every cloud commit gets two trailers naming the session's person, appended exactly once:
  `Co-authored-by: <name> <GitHub noreply address>`, which makes GitHub show the person's avatar
  next to the bot's and count the commit for them, and `On-behalf-of: <name> <address>`, plain text
  that states the relationship for anyone reading the log.
- GitHub's own "on behalf of" label exists only for organizations (a verified-domain trailer), so
  it is not used.
- PRs, comments and reviews made through the API appear as the credential's identity and carry a
  footer "Outfitter, on behalf of @<login>".
- Checkpoint commits carry the same trailers. The person's name, noreply address and login come in
  `run.spec.author`, and reach the `git` tool as `OUTFITTER_AUTHOR_NAME`, `_EMAIL` and `_LOGIN`,
  so the agent's own commits get the trailers too. Without an author (an older API), commits are
  the bot's alone, with no trailers.

### Setup: installing `gh` and signing in (local)

`/github` with no arguments shows status; `/github setup` does whatever is missing, in order:

1. **Find `gh`**: on `PATH` first (a person's newer system `gh` wins), then `~/.kernal/bin/gh`.
2. **Install it if missing.** Download the official release for this platform from
   `github.com/cli/cli/releases` (the same four platforms Kernal ships), verify it against the
   release's `gh_<version>_checksums.txt`, and unpack `gh` into `~/.kernal/bin`. No admin rights, no
   Homebrew. The launcher appends `~/.kernal/bin` to the **end** of `PATH` (it does not touch `PATH`
   today; this is a new line in `bin/kernal`), and Kernal's own calls use the resolved path
   directly. In a source checkout the binary goes in the git-ignored `kernal/.pi/bin`. Bundling `gh` in every release (about 40 MB per
   platform) is the alternative; downloading on first use keeps releases small. Decision below.
3. **Sign in**: `gh auth login --web --git-protocol https --hostname github.com`, which shows a
   one-time code and opens the browser (or prints the URL on a machine without one). `gh` always
   asks for `repo`, `read:org` and `gist`; setup adds `--scopes workflow` so the agent can edit
   workflow files and re-run checks.
4. **Connect git**, after saying what it changes: `gh auth setup-git` writes a credential helper for
   `github.com` into the person's global `~/.gitconfig`, which can take over from the macOS
   keychain helper. Setup shows that and asks first. HTTPS through the `gh` login is the one
   supported way to reach GitHub; SSH remotes are out of scope.
5. **Check**: account, scopes, and whether the current repository is reachable and writable.

`GH_TOKEN` or `GITHUB_TOKEN` in the environment still wins, for people who prefer a token. Each
person uses their own account; nothing is issued by Matthew. A new `kernal github` launcher
subcommand runs the same setup from a terminal (today's subcommands are `version`, `prune`, `update`
and `--teleport`), and the in-agent `/setup` mentions it once.

`/admin` gets a **GitHub** page: signed-in account and avatar, scopes, git connected or not, the
current repository with its default branch and your permission there, and buttons for Install `gh`,
Sign in, Sign out and Re-check. `/admin` is not in the cloud image, so the cloud equivalent (the
credential in use, the session's repo, what the broker permits) belongs on the Outfitter web UI's
session page.

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

**Split of work.**
- **Working-tree operations run locally as `agent`**: status, diff, log, commit, branch, stash, and
  the merge or rebase half of `pull`. They need no credentials, and conflicts and file ownership
  stay with the agent's user.
- **Only transport and the GitHub API go to the broker**: fetching refs, pushing, and every
  `github_*` action.

**Transport: a socket served by agentd.** The extension talks to a Unix socket at
`$OUTFITTER_GITHUB_SOCKET` under `/run/outfitter` (already `0750 root:agent`). Requirements:
- agentd must `chown 0:agent` and `chmod 0660` the socket after `listen()`; root's umask would
  otherwise leave it unusable (the same trap as the spend file).
- `OUTFITTER_GITHUB_SOCKET` is pinned in pi's environment after the guru's own env, like
  `OUTFITTER_SESSION_ID`, so a guru cannot point it elsewhere.
- **The model can reach the socket too** (`nc -U` from bash runs as `agent`). So every rule is
  enforced in agentd and the API; the extension enforces nothing on its own.
- Alternatives considered: the mailbox pattern cannot return results; the `rpc` frame points the
  wrong way (API to pi); intercepting a dialog request would work over stdio but is a hack.

**Git proxy: plain `git` works in the cloud shell too (decided).** agentd runs a git smart-HTTP
proxy on `127.0.0.1`, so the agent's own `git fetch`, `git pull` and `git push` in bash work exactly
as they do on a laptop, and the `git` tool uses the same path.
- **How git finds it**: pi's environment gets a pinned `url.<proxy>/<owner>/<repo>.git.insteadOf
  https://github.com/<owner>/<repo>.git` through `GIT_CONFIG_COUNT` variables, so `origin` keeps
  its real URL in `.git/config`. agentd's `baseEnvForPi` currently strips every `GIT_CONFIG_*`
  variable as a safety measure; it must strip only the auth header and allow this one. Git over
  HTTP cannot use a Unix socket, hence localhost TCP.
- **What it forwards**: only the smart-HTTP endpoints (`info/refs`, `git-upload-pack`,
  `git-receive-pack`) of the session's repository, to github.com, adding the auth header on the way
  out. Nothing else is proxied, and the token never appears in a response or a log.
- **Ref policy on push**: it reads the ref-update commands at the start of a `receive-pack` request
  and refuses the whole push, with a message git shows to the agent, if any ref is outside the
  allowed set (the session branch in v1, the configured prefix in v2) or is a deletion. Force
  pushes to the session branch are allowed, since it is the agent's own branch.
- **Anyone in the container can use it**, including the model, which is the point; the policy above
  is the boundary, as for the socket.
- **Consequences**: the socket then carries only GitHub API operations; fetch and push leave it.
  Checkpoints can keep phase 0's root-owned bare-repository push, or move to the proxy; either way
  root never runs git in the agent's checkout.
- **Prototype first** in phase 3: a spike with `git push` of a small and a large pack through the
  proxy, a refused ref, and a dropped connection, before the socket's transport half is removed.

**Git transport.** Through the proxy above. Until the proxy lands, or if the spike fails, the tools'
push goes through the same path as phase 0's checkpoint push (root-owned bare repository with
alternates), and fetch through a root-side fetch into it, never git as root inside `/workspace`.
Fetched refs reach `origin/<branch>` because phase 0 added the session branch to the fetch
refspec. Network git operations are serialized with the periodic checkpoint through one lock in
agentd.

**GitHub API (in the API).** agentd forwards API requests as a new frame, `github.request {reqId,
op, args, idempotencyKey}`, answered by `github.result {reqId, ok, data | error}`. The API runs
them with the run's GitHub credential and records them for audit.
- **A closed list of operations**, one per tool action, implemented in the API with Octokit (REST
  plus GraphQL for review threads and linked branches). No arbitrary `gh api` passthrough.
- **Reliability.** Requests are not replayed like `entry` frames. Each has a timeout; the extension
  retries reads only. Writes carry an idempotency key, and the API remembers recent keys, so a
  retry after a dropped link cannot post a comment twice.
- **`wait_ci` polls** with short `checks` requests from the extension, with backoff, rather than
  holding one request open across a reconnect.
- **Policy**: only the session's repository; pushes only to the session branch (v1) or branches
  under a configured prefix (v2); merges only if the guru's config allows it.

**Credential scope and limits.** Today's credential is one fine-grained PAT with contents and
pull-requests read/write. The tools also need issues (read/write), checks and actions (read, for
`wait_ci` and log tails) and, for `github_issue start`, metadata. Every session shares its rate
limit (5,000 requests an hour). So:
- the backend reports "not permitted" per operation when a permission is missing;
- the API tracks the remaining budget from response headers and backs off, and `wait_ci` polls
  slowly (every 20 s, longer when the budget is low).

**Checkpoints and the agent's own commits.**
- Checkpoints must push when `HEAD` differs from the remote, not only when agentd committed
  something itself (gap 1).
- agentd's `git add -A` must not sweep up work the agent staged by name. Checkpoints wait while a
  `git` tool call is running, and a checkpoint that finds staged changes commits exactly the index
  first, then leftovers separately.

**Branches.** v1 has one working branch per session. `branch create` and `switch`, `github_issue
start` and `github_pr checkout` return "this cloud session works on `<branch>`" (declared as
missing capabilities). v2 lets agentd push whichever branch is checked out, reported in the
`checkpoint` frame. Both rely on the refspec fix.

**Identity.** API actions appear as the credential's owner. With a PAT that is Matthew:
- a PR opened from the cloud cannot then be approved by Matthew, because GitHub forbids approving
  your own PR;
- anything Matej's cloud session does appears as Matthew.

The GitHub App (E2.5 phase 2 and E6) fixes this: actions appear as the app, and user-to-server
tokens can later make them appear as the person. Until then the tools say who they will act as.

**Why agentd plus the API, not agentd alone.** The API already holds the credential and will mint
App tokens. Routing through it gives one audit log and one policy, and E6 (webhooks, PR Fixer and
Reviewer gurus) needs the same executor. That replaces E6's plan of running `gh pr create` inside
runs, so the image's `gh` package (about 38 MB) can go; `EPIC.md` is updated in the phase 3 PR.

**Outfitter changes** (owned by the Outfitter work, specified here so the interface is agreed):
- the prerequisite fixes for gaps 1 to 4;
- `run.spec.author`;
- the socket and its lock in agentd;
- the two frames in `docs/protocol.md`, with a protocol version bump;
- the API's executor, policy, idempotency and rate-limit handling;
- the session page's GitHub panel.

### Teleport

- Teleport's git checks (clean tree, branch pushed, same repository) move into the shared git module
  so both extensions agree on what "clean" and "pushed" mean; teleport's tests keep passing
  unchanged.
- **Laptop to cloud does not carry a repository today** (gap 5). Phase 4 makes the import carry the
  manifest's repository, branch and base, and start the cloud session on that branch with
  `createBranch` off. That depends on the refspec fix (gap 2). Once it exists, `/teleport` can
  offer to commit and push through the new tools instead of refusing with "commit or stash first".
- **Cloud to laptop**: the local side fetches the session branch (`outfitter/<session>` refs
  included) with the person's own login and checks it out, as teleport does today.
- `git status` shows teleport-relevant facts: "branch not pushed", "session branch is 3 commits
  ahead of your checkout".

### Non-interactive runs and subagents

- Every `gh` and `git` child runs with stdin closed, `GH_PROMPT_DISABLED=1`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` for read operations, a timeout (30 s default,
  longer for `wait_ci` and network operations), and output caps. Nothing can hang `kernal -p`.
- Tools behave the same headless; only a `github.confirm` setting other than `none` changes that.
- pi-subagents' foreground children do not load the parent's extensions; background children load
  the parent's ambient extensions. So the tools reach background subagents automatically, and
  foreground roles such as `worker` and `reviewer` get them only if added to their tool lists. v1
  adds nothing to agent files.

### Scope and edge cases

- **Platforms**: macOS (arm64, x64) and Linux (x64, arm64), as Kernal ships. Windows is out of scope.
- **Hosts and protocols**: github.com over HTTPS only. GitHub Enterprise and SSH remotes are out of
  scope: setup, the tools and the cloud broker do not handle them.
- **No remote, or a non-GitHub remote**: the `git` tool works fully; `github_*` report the missing
  capability.
- **Forks**: PRs from a fork (push to the fork, open against upstream) and checking out a fork's PR
  are supported locally through `gh`'s own fork handling; in the cloud they are out of scope for v1.
- **Also handled**: draft PRs (`create` takes `draft`), several PR templates
  (`.github/PULL_REQUEST_TEMPLATE/`, the agent picks one and says which), detached HEAD and an empty
  repository (reported by `status`, with the next step), submodules (reported, never updated
  silently). Git LFS works through git itself; nothing extra.
- **`gh api`**: inline review comments, thread replies, resolving threads and linked branches go
  through `gh api` (GraphQL for the last two), so the fake-`gh` tests cover `gh api` calls too.

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
- A fake broker socket for the cloud backend, including policy refusals, a dropped link during a
  write (no duplicate), and permission errors.
- In the Outfitter image, as root on an `agent`-owned checkout: fetch, push and checkpoint after the
  agent's own commit (covers gaps 1 to 4).
- A test that the four tools' definitions stay under the prompt budget.
- A live test (opt-in, like the existing live suite) against a scratch repository: open a PR,
  comment, wait for a trivial check, close it.

## Delivery

| Phase | Contents | Where | Depends on |
|---|---|---|---|
| 0 | Sandbox git fixes: push the agent's own commits, the resume refspec, ownership (local git as `agent`, pushes from a root-owned bare repository), commit identity. In [PR #41](https://github.com/mgmonteleone/mgm-pi/pull/41) | Outfitter | nothing |
| 1 | Shared git module (teleport moved onto it); `/github setup` and `kernal github`; `/admin` GitHub page; `git` tool; `/git`, `/commit`; prompt rules; attribution | Kernal | nothing |
| 2 | `github_pr`, `github_issue`, `github_repo` (all actions), `/pr`, `/issues`, `wait_ci` | Kernal | 1 |
| 3 | Git proxy (spike first); broker backend; socket, frames, API executor, policy, idempotency, rate limits; bot committer; session-page panel; EPIC.md update | Kernal and Outfitter | 0, 2 |
| 4 | Cloud multi-branch; GitHub App identity; teleport carries the repository and offers commit and push; optional read-only MCP | Kernal and Outfitter | 3 |

Each phase is its own PR with tests. Phases 1 and 2 are useful locally on their own.

## Open questions

1. **Bundle `gh` or download on first use?** Recommendation: download on first use, verified by
   checksum; revisit if first-run downloads prove fragile.
2. **Attribution text and address** for commits and PRs, and whether it is on by default.
3. **Cloud identity before the GitHub App**: accept "everything appears as Matthew" for now, or do the
   App (E2.5 phase 2) before phase 3?
4. **Merges from the cloud**: allowed by default, or only when the guru's config says so?
5. **Subagents**: give `worker` and `reviewer` the new tools in phase 2, or keep them on bash?

## Decided

- **Scope**: github.com over HTTPS only; no GitHub Enterprise, no SSH remotes.
- **Cloud commits**: the Outfitter bot, on behalf of the person: the bot as author and committer,
  with `Co-authored-by` and `On-behalf-of` trailers for the person; API actions carry an "on behalf
  of @login" footer.
- **Git proxy**: build it in phase 3, after a spike, so plain `git` works in the cloud shell.
