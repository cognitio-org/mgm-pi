# Sandbox git: what shipped, what is live, what is left (2026-09-22/23)

Handoff for the sandbox's git behaviour — phase 0 of `kernal/docs/git-github-spec.md` plus what came
out of running it against the real cloud. Written because the week's quota ran out mid-verification.
Updated the same day, after the deploy and the end-to-end check.

## Status in one line

Deployed and checked. `outfitter-agent` runs `ca451ae4466d` (tag `outfitter-v2026.09.23.1`), which
contains #55, and the end-to-end check on `cognitio-org/testit` passed.

| | |
|---|---|
| Deployed image (Job `outfitter-agent`, label `build-commit`) | `ca451ae4466d` — #41, #44, and #55 |
| `main` when this was checked | `ca451ae` (`ca451ae4466d`) |
| Release | `outfitter-v2026.09.23.1` |
| Repo sessions in the cloud | Working, as of the check below |

## What merged

**#41 — the four phase-0 bugs.**
- Checkpoints push whenever HEAD differs from what origin has for the session branch, not only when
  agentd itself committed, so commits the agent makes are no longer stranded. `checkpoint.pushed`
  reports what actually happened.
- Resume: the single-branch clone's `git fetch origin <branch>` never created `origin/<branch>`, so
  `checkout -B` failed for **every** session that had checkpointed. Fetch now uses an explicit
  refspec, and clone adds the session branch to `remote.origin.fetch`.
- Dubious ownership: deliberately **not** solved with `safe.directory`, which would let root's git run
  hooks, `fsmonitor`, filters or `insteadOf` from a repo the agent controls, with the auth header in
  its environment. Instead local git runs as the workspace's own user, and push runs as root from a
  private repository outside the workspace.
- Commit identity: the Outfitter bot (`Outfitter <noreply@outfitter.invalid>`) authors and commits
  every cloud commit; the person is credited by `Co-authored-by` and `On-behalf-of` trailers built
  from the new optional `run.spec.author {name, email, login?}`. Not
  `outfitter@users.noreply.github.com` — GitHub would credit an unrelated account of that name.

**#44 — the exposure #41's review left open**, plus checkpoint reporting.
- Root's git no longer reads the agent's object store through `alternates`. The push repository is
  seeded from the pristine clone, and each push takes the new commits as a *bundle* the workspace
  user writes, which root copies out with `O_NOFOLLOW` and imports with `transfer.fsckObjects`.
- A failed checkpoint is reported as a `status` detail (`checkpoint failed: …`) instead of vanishing
  into the logs; stop paths retry once; a `--force-with-lease` rejection is named and never retried,
  because only a person can reconcile the two histories.

**#55 — repo sessions could not start at all.** The image creates `/workspace` owned by `agent`;
`git clone` works (it *creates* the repo) but every root git command after it must *discover* a repo
whose worktree belongs to another uid, which git refuses and `git config` words as
`fatal: not in a git directory`. Root now owns the directory for the clone's duration and hands the
tree over before the checkout. **This predates the phase-0 work** — the old code's first post-clone
command was `git checkout -b`, which fails identically, which is why no `outfitter-github-token-*`
secret had ever existed in the project: no repo session ever got far enough to need one.

## How the deploy went

Pushing `outfitter-v2026.09.23.1` started Actions run `35853815936`. The test job passed. The deploy
job then stopped on `kernal-web`, before the agent image moved: that service still runs as the
project's default Compute service account
(`97916961297-compute@developer.gserviceaccount.com`), and `outfitter-deployer` has no
`iam.serviceaccounts.actAs` on it. `ci-setup.sh` grants actAs only on `outfitter-api`,
`outfitter-agent`, and `outfitter-builder`. `release.sh` deploys the landing page first, so that
one refusal stops the fleet as well.

The release was finished by hand from the primary `main` checkout (`/Users/mgm/localllm`, not a
worktree), as `mgm@mgms.eu`: `MANUAL=1 ./release.sh`. `outfitter-agent`, `outfitter-link`,
`outfitter-api`, and `kernal-web` all came back with `build-commit` `ca451ae4466d`. The page is
labelled now, so a later release that does not touch `landing/` skips it. The next change under
`landing/` fails the workflow the same way until `kernal-web` runs as an account the deployer can
act as (`deploy/README.md`).

## The end-to-end check (done 2026-09-23)

Session `2cc9494a-96f8-4af3-88e2-a0a5a5d5f4af` ("git e2e check") on `cognitio-org/testit`, branch
`outfitter/3b352e25`, woken from the web UI at `app.kernal.one` after the image above was live.
The prompt asked the agent to write `check.md` and commit it with the git tool (action `commit`),
and not to push. The git tool is what appends the attribution trailers; a raw shell `git commit`
would have kept the bot identity from `GIT_AUTHOR_*` / `GIT_COMMITTER_*` and omitted the trailers.

1. The agent committed `a461e96ab2d74cf2bb2b54b2bb8f6d74aa9c209c` (`add check.md`). Stop
   checkpointed. The session record now holds `checkpoint.branch` `outfitter/3b352e25` and
   `checkpoint.head` that sha, and the branch is on GitHub at that commit, with `check.md`
   containing `sandbox git check 2026-09-23`. The sandbox log shows `checkpointing`, then
   `stopping`, then `exit(0)`, and no `checkpoint failed`.
2. Author and committer on GitHub are `Outfitter <noreply@outfitter.invalid>`. The message also
   carries `Co-Authored-By: Kernal <noreply@kernal.invalid>`, `Co-authored-by: Matthew Monteleone
   <1931461+mgmonteleone@users.noreply.github.com>`, and `On-behalf-of` for the same person. GitHub
   links the co-author to `mgmonteleone`.
   https://github.com/cognitio-org/testit/commit/a461e96ab2d74cf2bb2b54b2bb8f6d74aa9c209c
3. Stop, then Play. The resumed agent reported branch `outfitter/3b352e25`, HEAD
   `a461e96ab2d74cf2bb2b54b2bb8f6d74aa9c209c`, and that first line of `check.md`. The session was
   stopped again afterwards. The header read `STOPPED · PRESS PLAY`, with no status-detail note.

**The page never showed `pushed: true`.** Agentd sends it on the checkpoint frame, and the link
role publishes that frame on its own SSE hub (`agentlink.ts`). The browser is connected to the web
role, whose `SsePoller` republishes entries, status, spend, and a pending UI request, and does not
republish checkpoint. `session.checkpoint` stores `branch` and `head` only. The push is what
created the branch: it was not on the repo before the stop, and it was at the agent's sha after.

A failure surfaces in the run's status detail rather than an indefinite spinner (#54).

## Next actions, in order

1. **`kernal-web`'s runtime account.** Give the landing page a service account `outfitter-deployer`
   can act as, and pass it from `landing.sh`. Until then a `landing/` change blocks every release.
2. **Matej's attribution**: `matej@mgms.eu` has no user record (he has never signed into Outfitter),
   so his commits get the bot alone. When he signs in, set `name`, `githubLogin` (`TEJ42000`) and
   `githubEmail` (`247988220+TEJ42000@users.noreply.github.com`) on his row. Matthew
   (`mgm@mgms.eu`) and Matija Turk (`matija.turk@gmail.com`, `johnny2211`) are already configured.
3. **Clean up the test fixtures**: session `2cc9494a-96f8-4af3-88e2-a0a5a5d5f4af`, repo
   `cognitio-org/testit`, and secret `outfitter-github-token-2cc9494a-…` (holds a real fine-grained
   PAT scoped to that repo — revoke it on GitHub too).

## Things that cost time, so the next person does not repeat them

- **`RunController`'s default `onExit` is `process.exit`.** A test helper that did not override it
  ended the test process the first time a test delivered `stop`, so **every test declared after it
  silently never ran** — three of them. Fixed in #44. If you append tests to `run.test.ts`, check
  they appear in the output.
- **Per-session GitHub tokens.** #53's `outfitter-github-token-default` shipped in
  `outfitter-v2026.09.23.1`, so a repo session with no secret of its own falls back to that shared
  token. A per-session secret still wins when it exists. Before that fallback, a missing secret
  left the session in `PROVISIONING`; the refusal is explained in the UI (#54).
- **Which token.** It must be a **GitHub** PAT, not an Outfitter `outf_` dongle; fine-grained tokens
  need resource owner = the org, the repo selected, and **Contents: read and write**. A stored value
  starting `outf` or of length 21 or 59 is one of the wrong ones we hit.
- **`gcloud` lives at `~/google-cloud-sdk/bin`** and is not on the agent's default PATH; the project
  is `outfitter-509211` and the account is `mgm@mgms.eu`, not the corporate one.
- **Verifying a deploy**: `gcloud run jobs describe outfitter-agent … --format='value(metadata.labels.build-commit)'`
  gives the commit actually running. Sandbox logs are `resource.type="cloud_run_job"` with
  `jsonPayload.message`; `value(...)` format strings that guess at `msg`/`error` print blanks.
- **A repo session that fails after `hello` still costs mail.** Each wake charges the agent mailbox
  an attempt, and a queued message dead-letters after six. From the outside that looks like the
  mailbox dropping messages, so a session that will not clone is worth fixing before re-sending
  anything (see the E5.5 notes in `EPIC.md`, and `docs/reports/agent-messaging.md`).
- **`pushed` is not on the session page.** The checkpoint frame stays on the link role's SSE hub.
  Confirm the push from `session.checkpoint.head` and from the branch on GitHub.

## Deliberate decisions worth not re-litigating

- **No `safe.directory`**, for the reason above; the ownership refusal is a feature and the code works
  with it rather than switching it off.
- **The bot is author *and* committer**, with the person in trailers ("the bot, on behalf of the
  person"), per the spec's Attribution section.
- **`run.spec.author` is sent only when the user record has a `githubEmail`.** The sign-in address is
  a work email and these trailers are permanent, public commit metadata.
- **A failed checkpoint sends no `checkpoint` frame**, because the api replaces `session.checkpoint`
  wholesale and a frame without a head would erase the last good one.

## Known residual risk

Root's push still parses the agent's *bundle*, which is the input path git hardens (`index-pack` with
fsck) — the previous, weaker exposure through `alternates` is gone. The pre-existing token-isolation
hole (pi inheriting `RUN_TOKEN`) was fixed separately in #45.
