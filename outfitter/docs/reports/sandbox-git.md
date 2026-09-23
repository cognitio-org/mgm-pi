# Sandbox git: what shipped, what is live, what is left (2026-09-22/23)

Handoff for the sandbox's git behaviour — phase 0 of `kernal/docs/git-github-spec.md` plus what came
out of running it against the real cloud. Written because the week's quota ran out mid-verification.

## Status in one line

Everything is merged; **`main` is ahead of the deployed image**, and the deploy is the only thing
standing between the code and a working repo session.

| | |
|---|---|
| Deployed image (Job `outfitter-agent`, label `build-commit`) | `4e5463c` — has #41 and #44, **not #55** |
| `main` at handoff | `ca451ae` |
| Repo sessions in the cloud | **Broken until #55 deploys** |

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

## Next actions, in order

1. **Deploy `main`.** Nothing above about #55 is live until then.
2. **Finish the end-to-end check** (below). It was blocked at the clone, which #55 fixes.
3. **Matej's attribution**: `matej@mgms.eu` has no user record (he has never signed into Outfitter),
   so his commits get the bot alone. When he signs in, set `name`, `githubLogin` (`TEJ42000`) and
   `githubEmail` (`247988220+TEJ42000@users.noreply.github.com`) on his row. Matthew
   (`mgm@mgms.eu`) and Matija Turk (`matija.turk@gmail.com`, `johnny2211`) are already configured.
4. **Clean up the test fixtures** when done: session `2cc9494a-96f8-4af3-88e2-a0a5a5d5f4af`, repo
   `cognitio-org/testit`, and secret `outfitter-github-token-2cc9494a-…` (holds a real fine-grained
   PAT scoped to that repo — revoke it on GitHub too).

## The end-to-end check, to resume after the deploy

Session `2cc9494a-96f8-4af3-88e2-a0a5a5d5f4af` ("git e2e check") on `cognitio-org/testit` is set up
and its token secret is valid (GitHub returns 200 and `push: true`). Wake it from the UI and:

1. The agent commits `check.md` itself, then checkpoint → the branch `outfitter/3b352e25` should
   appear on GitHub at the agent's commit, and the frame should say `pushed: true`. That is bugs 1
   and 3 together.
2. On GitHub, the commit's committer should be `Outfitter <noreply@outfitter.invalid>` with
   `Co-authored-by`/`On-behalf-of` naming the owner, and their avatar on it.
3. Stop and resume the session → it should return on `outfitter/3b352e25` at the right commit. That
   is the resume refspec, which failed for every resumed session before #41.

A failure now surfaces in the run's status detail rather than an indefinite spinner (#54).

**It also costs mail.** A repo session that fails this way fails *after* its `hello` has validated, so
each wake charges the agent mailbox an attempt, and a queued message dead-letters after six. From the
outside that looks like the mailbox dropping messages, so a session that will not clone is worth
fixing before re-sending anything (see the E5.5 notes in `EPIC.md`, and `docs/reports/agent-messaging.md`).

## Things that cost time, so the next person does not repeat them

- **`RunController`'s default `onExit` is `process.exit`.** A test helper that did not override it
  ended the test process the first time a test delivered `stop`, so **every test declared after it
  silently never ran** — three of them. Fixed in #44. If you append tests to `run.test.ts`, check
  they appear in the output.
- **Per-session GitHub tokens.** Until #53's `outfitter-github-token-default` is deployed, every repo
  session needs its own secret, created by hand, or it sits in `PROVISIONING`. The failure is now
  explained in the UI (#54).
- **Which token.** It must be a **GitHub** PAT, not an Outfitter `outf_` dongle; fine-grained tokens
  need resource owner = the org, the repo selected, and **Contents: read and write**. A stored value
  starting `outf` or of length 21 or 59 is one of the wrong ones we hit.
- **`gcloud` lives at `~/google-cloud-sdk/bin`** and is not on the agent's default PATH; the project
  is `outfitter-509211` and the account is `mgm@mgms.eu`, not the corporate one.
- **Verifying a deploy**: `gcloud run jobs describe outfitter-agent … --format='value(metadata.labels.build-commit)'`
  gives the commit actually running. Sandbox logs are `resource.type="cloud_run_job"` with
  `jsonPayload.message`; `value(...)` format strings that guess at `msg`/`error` print blanks.

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
