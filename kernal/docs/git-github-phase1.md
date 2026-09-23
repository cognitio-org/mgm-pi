# Handoff: git and GitHub in kernal (2026-09-23)

What was decided, what is built, what is next, and the traps worth knowing. The design is
[git-github-spec.md](git-github-spec.md); this is the state of the work against it.

## Open, needs a human

1. **Nothing left in phase 1.** It is merged, including the admin GitHub page
   ([#61](https://github.com/cognitio-org/mgm-pi/pull/61)). Phases 2, 3 and 4 are tracked as GitHub
   issues; see Next.
2. **Sign-in is a paste, by design.** `gh auth login` asks its own questions and pi cannot hand a
   child process the terminal, so `/github setup` shows the command instead of running it. If that
   ever becomes worth automating, the route is a kernal OAuth app and GitHub's device flow, which
   means registering an app and shipping its client id.
3. **Matej has no GitHub account on record in Outfitter**, so his cloud commits are the bot's alone
   (no `Co-authored-by`). Fixing it is one user record, not code.

## Decided (all five open questions in the spec, 2026-09-22)

| Question | Decision |
|---|---|
| Bundle `gh` or download it | Download on first use, verified against the release's `gh_<version>_checksums.txt`. Releases stay small and kernal does not own someone else's binary. |
| Attribution | `Co-Authored-By: Kernal <noreply@kernal.invalid>` and "Opened with Kernal", on by default, blankable in settings. A `.invalid` address on purpose: a `users.noreply.github.com` one credits whichever account owns that name. |
| Cloud identity before the GitHub App | Accepted as is while Matthew is the only person running cloud sessions. Everything appears as him, and he cannot approve a PR the cloud opened as him. |
| Merging from the cloud | Off by default, enabled per guru. A cloud run can have nobody watching. |
| Tool access for subagents and gurus | A per-agent and per-guru choice of off, read or full, written into the agent's own `extensions`/`tools` or the guru's tool lists. Every shipped role starts at off. |

Also decided: github.com over https only (no GitHub Enterprise, no SSH remotes); cloud commits are
the Outfitter bot **on behalf of** the person (bot as author and committer, `Co-authored-by` and
`On-behalf-of` trailers); and phase 3 gets a localhost git proxy in agentd so plain `git` works in
the cloud shell.

## Built

- **Phase 0** (Outfitter, merged): the sandbox git fixes. See
  `outfitter/docs/reports/sandbox-git.md` for that half.
- **Phase 1** ([#48](https://github.com/cognitio-org/mgm-pi/pull/48), merged):
  - `.pi/extensions/_shared/git.ts`: one git module for every extension. Argument arrays only,
    stdin closed with `GIT_TERMINAL_PROMPT=0`, a timeout on every call, capped output, and results
    rather than exceptions for ordinary git failures. Status is porcelain v2 with `-z`.
  - `kernal-github`: the `git` tool (status, diff, log, commit, push, pull, branch, stash), the
    model's git rules, and `/git`, `/commit`, `/github`. `gh` install with checksum verification.
  - teleport now shares the module's "dirty" and "needs pushing" definitions.
  - `kernal github` in the launcher, and kernal's own bin directory on `PATH` (last).
- **The admin GitHub page** ([#61](https://github.com/cognitio-org/mgm-pi/pull/61), merged): the
  `gh` kernal found, the signed-in account and scopes, whether git over https uses that login, this
  repository's branch and pull request, and the attribution strings. Sign-in and `setup-git` are
  copied commands, not buttons. The spec's mention of an avatar, a Sign out button, the default
  branch and the person's permission on the repo was not built and is not open work.

## Next

Tracked under [#86](https://github.com/cognitio-org/mgm-pi/issues/86).

| Phase | What | Depends on |
|---|---|---|
| 2 | [#87](https://github.com/cognitio-org/mgm-pi/issues/87) the tools and `/pr`, `/issues`; [#88](https://github.com/cognitio-org/mgm-pi/issues/88) `github.confirm` and per-agent access | phase 1 (done) |
| 3 | [#89](https://github.com/cognitio-org/mgm-pi/issues/89) the git proxy; [#90](https://github.com/cognitio-org/mgm-pi/issues/90) the broker; [#91](https://github.com/cognitio-org/mgm-pi/issues/91) the session-page panel | phase 0 (done) and phase 2 |
| 4 | [#92](https://github.com/cognitio-org/mgm-pi/issues/92) multi-branch; [#93](https://github.com/cognitio-org/mgm-pi/issues/93) the GitHub App; [#94](https://github.com/cognitio-org/mgm-pi/issues/94) teleport carries the repository | phase 3 |

Phase 3's proxy should be designed against the residual-risk section of
`outfitter/docs/reports/sandbox-git.md`: the bundle-based push landed in
[#44](https://github.com/cognitio-org/mgm-pi/pull/44) and is what it builds on.

## Traps this work hit, so the next person does not

- **`gh pr view --json reviewThreads` does not exist.** gh refuses the whole call with "Unknown JSON
  field", so the pull request lookup returned nothing and `/git` always said "no pull request". The
  tests missed it because they hand-built the PR data instead of exercising the call. Unresolved
  threads come from `gh api graphql` instead.
- **A command handler's return value is discarded by pi.** Returning `{ prompt: … }` does nothing at
  all; `ctx.sendUserMessage()` is how a command starts a turn.
- **git silently declines `--set-upstream`** when the pushed source is a commit id rather than a
  branch name. It exits 0 and sets nothing, so the tracking config is written explicitly.
- **git never says "hook"** when a hook refuses a commit: you see only the hook's own output, and
  the exit status is the hook's. Detect a hook's existence instead, and rule out git's own fatals
  (exit 128, `fatal:`/`error:`) first, or every locked index becomes "fix your lint error".
- **`git switch` and `git branch` do not accept `--end-of-options`**, so a caller-supplied branch
  name or start point has to be validated instead. `git log` does accept it, which matters because a
  range like `--output=<path>` otherwise writes a file from what looks like a read.
- **EPIPE on stdin**: git and gh may exit before reading it, and the write then fails as an
  unhandled socket error. Linux loses that race every time; macOS never did, so CI caught it and no
  local run ever would have.
- **A bare `git init --bare` remote defaults to a `master` HEAD**, so a later clone checks out a
  different branch than the test pushed. Set `symbolic-ref HEAD refs/heads/main` in fixtures.
