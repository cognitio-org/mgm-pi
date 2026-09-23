# Handoff: the shared GitHub token fallback

Written 2026-09-23 because the session that did this work ran out of weekly quota mid-stream. It is
written for an agent with **no context on this work at all**, so it repeats things the code already
says. Scope is the GitHub-token fallback and its follow-ons only — not the rest of Outfitter.

Everything under "State" was verified against the live project on 2026-09-23, not inferred. Where a
fact came from a command, the command is given so you can re-verify rather than trust this file:
these are exactly the facts most likely to have gone stale by the time you read it.

## The one-sentence version

The code that lets a repo session fall back to a shared GitHub token is **merged into `main` and
green, the secret it needs exists, and it is not deployed** — so nothing has changed for a real
session yet. The remaining work is a release tag, a verification, and one follow-on.

## State

**Merged.** `64b186c` on `main` — "Secrets: a shared outfitter-github-token-default under every repo
session", PR #53. Main's CI passed on the merge commit, which mattered because #55 landed after the
branch was rebased, so the merge run was the first time the two were tested together.

What it does: `GcpSecretsBroker.secretsForRun` (`packages/api/src/secrets.ts`) resolves a run's
GitHub token by reading `outfitter-github-token-<sessionId>` first and falling back to a shared
`outfitter-github-token-default` when that secret does not exist — the same shape
`outfitter-litellm-key-<guruId>` → `outfitter-litellm-key-default` has had for a while. It logs
which of the two a run resolved. `agentlink.ts`'s fatal check is unchanged: a repo session with an
empty token is still refused with the terminal WS `4412`, which now means *neither* secret exists.

The fallback is gated on `session.repo` (`secrets.ts:113`, `if (!session.repo) return "";`). Do not
remove that gate as a simplification. `buildRunSpec` sends `secrets: { ...secrets, litellmBaseUrl }`
in **every** `run.spec`, repo or not, so an ungated fallback hands an org-wide PAT to sandboxes that
have nothing to clone — strictly more exposure, no capability. It was caught twice on PR #53 (by the
review bot, severity high, and independently in the author's own review pass) and is pinned by two
tests in `packages/api/test/secrets.test.ts`. A repo-less session that has a token of its own still
gets it, because creating that secret by hand is a deliberate grant.

**The secret exists.** `outfitter-github-token-default`, created by the operator 2026-09-23 10:00 UTC,
version 1, enabled. `outfitter-api@outfitter-509211.iam.gserviceaccount.com` holds a project-wide
`roles/secretmanager.secretAccessor` from `baseline.sh`, so no per-secret IAM binding is needed and
none was added.

```bash
gcloud secrets versions list outfitter-github-token-default --project=outfitter-509211
```

**It is not deployed.** The live service runs revision `outfitter-api-00018-jdg`, built from commit
`4e5463c` — five merged PRs behind `main` (#49, #54, #52, #55, #53). Merging runs CI; it does not
deploy. So the running API still resolves only `outfitter-github-token-<sessionId>`, and a repo
session without one still dies at `4412`.

```bash
gcloud run revisions describe outfitter-api-00018-jdg --region=us-central1 \
  --project=outfitter-509211 --format='value(metadata.labels.build-commit)'
```

**One per-session secret also exists**, `outfitter-github-token-2cc9494a-96f8-4af3-88e2-a0a5a5d5f4af`,
minted 00:37 UTC and revised four times in nine hours. It keeps precedence for its own session and
is untouched by any of this. Do not delete it while investigating.

## What is left

### 1. Deploy, and know that it ships more than this change — issue #57

Outfitter deploys **only** by pushing an `outfitter-v*` tag; `.github/workflows/outfitter-deploy.yml`
tests that commit and runs `release.sh`. From the **main checkout** (`~/localllm`), never from a
worktree:

```bash
DRY_RUN=1 ./outfitter/deploy/tag-release.sh
```

Read what the dry run prints before tagging for real. The previous tag is `outfitter-v2026.09.22.1`,
so a tag cut now ships five merged PRs, not just this one — the tag message lists them, and that
list is the thing to actually read.

**You may not be able to do this yourself.** The tag is protected by an admin-only ruleset
(`tag-release.sh`'s own header: "repository admins only"). If the push is refused, that is the
ruleset, not a broken script — hand it to Matthew rather than working around it. Never cut a GitHub
*Release*: this repo's Releases are Kernal's, and `kernal update` reads `releases/latest`.

### 2. Verify end to end, on the thing that was actually broken — issue #57

The bug this fixes is that **creating a repo session through the UI could not work**: the secret a
session's first run needs can only be created out-of-band, against a session id that does not exist
until `POST /api/sessions` has already returned. So the verification is not a unit test — it is
creating a repo session through the UI and watching it reach `running` instead of `4412`.

The positive signal is a log line, not an absence of errors:

```
[secrets] session <id>: outfitter-github-token-<id> not set; using outfitter-github-token-default
```

Also worth confirming, because it is the half that protects you: a **repo-less** session's log shows
no `outfitter-github-token-default` line at all. If it does, the gate has been lost.

### 3. Follow-on: make the shared secret operator-manageable — issue #58

`outfitter-github-token-default` is **not** in `src/operator.ts`'s managed-secret list, so the E2.14
operator settings page cannot show, set or rotate it — it is a `gcloud secrets` operation today.
It belongs there beside `outfitter-litellm-key-default`. That means a managed-secret entry with
`appliesAt: "next run"`, and a look at the `DELETE` route's 409 guard in `routes/operator.ts`:
`outfitter-litellm-key-default` refuses deletion when no guru has a key of its own, and the same
reasoning applies here — deleting the shared GitHub token while sessions depend on it breaks every
repo session that has no token of its own. Left out of PR #53 deliberately to keep it one story.

## Traps this work hit, so you don't

- **A conflicted PR runs no CI at all.** When PR #53 went `CONFLICTING` against main, GitHub stopped
  triggering `pull_request` workflows entirely — it cannot build the merge commit. The PR showed
  *zero* checks, which in the UI reads like "pending", not like a problem. If checks seem missing,
  check `mergeStateStatus` before hunting for path filters or billing.
  `gh pr view <n> --json mergeable,mergeStateStatus`
- **Never write a secret value.** The operator creates and rotates PATs. Nothing in this repo writes
  one, no agent should mint one, and reading a value back is almost never necessary — version state
  and IAM answer most questions.
- **`docs/reports/deploy-gaps.md` is append-only.** Its own header says to append a new `##` section
  per gap and not rewrite earlier ones. Earlier sections contain statements that were true when
  written (e.g. an older one says the missing-token close is `1011`; it is `4412` now). Correct the
  *current* docs, not the history.
- **Check premises before repeating them.** The PR body originally asserted the project had no
  `outfitter-github-token-*` secrets at all. That was true when the task was written and false by
  the time it was pushed — one `gcloud secrets list` would have caught it, and didn't get run.

## Where the detail lives

- `docs/reports/deploy-gaps.md`, last section — the full writeup: what was observed, the fix, what
  was deliberately not done.
- `deploy/README.md` section (b) — the operational doc: both `-default` secrets, when a per-session
  fine-grained PAT is worth minting anyway, and what the `4412` refusal looks like.
- PR #53 — the review record, the correction to it, and the rebase note, in that order.
- Issues #57 (deploy and verify) and #58 (operator-manageable secret) — the two pickup points, each
  self-contained enough to start from without reading this file first.
- `EPIC.md` E2.5 — the story this sits under. Phase 1 is per-session PATs from Secret Manager;
  phase 2 replaces them with GitHub App installation tokens minted per run and repo, which is what
  eventually makes the shared token unnecessary rather than merely looser.
