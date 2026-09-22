# mgm → kernal rename: report

Full rename of the mgm coding agent to Kernal, with a safe automatic migration for the two existing
installs (owner's and son's laptops, both on mgm 0.1.17). See `kernal/docs/rename.md` for what
changed, the migration mechanics, and the fallback removal plan — this report is the verification
record and the two lists the task asked for (web-package strings, remaining grep hits).

## Summary of changes

- `mgm/` → `kernal/` via `git mv` (history preserved). Extensions `mgm-admin`, `mgm-banner`,
  `mgm-codebase-index`, `mgm-context`, `mgm-report`, `mgm-update`, `mgm-voice` → `kernal-*`.
  `bin/mgm` → `bin/kernal`.
- Every `MGM_*` env var → `KERNAL_*`, with a shared fallback: `.pi/extensions/_shared/env.ts`'s
  `env(name)` for the TypeScript extensions, and a duplicated `kenv()` shell function in
  `bin/kernal` and `scripts/install.sh` (duplicated, not sourced, because `install.sh` ships and
  runs standalone — `kernal update` downloads it on its own). Both warn once per process per old
  name. `MGM_USER` → `KERNAL_USER`; the banner's MGM/MATEK identity letters are unaffected (they are
  Matthew's and Matej's initials, not the product name).
- `scripts/install.sh` rewritten to migrate a legacy `~/.mgm` install into the new `~/.kernal`
  default: state (sessions, credentials, trust, caches), `.env` (MGM_* keys renamed to KERNAL_*,
  values untouched, never printed), the settings.json three-way merge, and the update-check cache.
  `~/.mgm` is left in place with a `MOVED` marker; `~/.local/bin/mgm` becomes a shim that warns and
  execs `kernal`. Idempotent (gated on `~/.mgm/MOVED`).
- Outfitter: `/opt/mgm` → `/opt/kernal` in `outfitter/image/Dockerfile`, `COPY mgm/...` →
  `COPY kernal/...`, `MGM_NO_CODEBASE_INDEX` → `KERNAL_NO_CODEBASE_INDEX` (read by kernal's own
  `env()` fallback, so no separate agentd-side fallback needed), deploy scripts, EPIC.md, all four
  `.github/workflows/*.yml` (path filters, `working-directory`, `cache-dependency-path`, the images
  job's extension-exclusion checks).
- Version bumped to 0.2.0 in `kernal/package.json` (previously unversioned; `release.yml`'s build
  job already stamps the release tag's version at build time via `npm version`, so this is the
  declared default/next-release version).
- New: `kernal/tests/install-migration.test.ts` (the end-to-end migration test the task asked for —
  builds a fake `~/.mgm/mgm-0.1.17-<platform>/` install and a fake new bundle, runs the real
  `install.sh`, asserts every migration guarantee including idempotency), `kernal/tests/env-compat.test.ts`
  (the `env()` helper), a `kenv()` block added to `kernal/tests/install.test.ts` (both shell copies,
  extracted from the real scripts so a drift between them would fail the test), and
  `kernal/docs/rename.md`.
- Not renamed, on purpose: the GitHub repo `mgmonteleone/mgm-pi` (an owner-account setting, GitHub
  redirects the old URL automatically if renamed later — noted in rename.md); `mgmonteleone` as a
  GitHub user/org name; `mgm@mgms.eu` / `mgm@mgmonteleone.com` (Matthew's actual email addresses,
  caught and reverted after an over-eager first-pass rename — see "Mistakes caught" below).

## Bugs found and fixed while writing the migration test

Writing `install-migration.test.ts` (a fresh bundle with no `.env` shipped, upgrading over a
migrated `.env` that *is* non-empty) exposed a pre-existing `pipefail` bug in the "add only the
shipped keys the user doesn't have" step of `install.sh`: `printf ... | grep -E '...' | while ...`
exits non-zero under `set -o pipefail` when `grep` finds nothing, which — because nothing guarded
it — killed the whole install under `set -e`. This is now `{ grep -E '...' || true; }`. It was never
hit by the existing "install.sh upgrade" tests because their fake bundles never carry a `.env`
either way (so `keep_env` is always empty and the block is skipped entirely) — only migration
creates the (previously untested) case where `keep_env` is non-empty and the new bundle's own `.env`
is empty.

## Mistakes caught during the mechanical rename (and how)

The bulk of the text rename was a script applying `MGM_ → KERNAL_` and a word-boundary `mgm → kernal`
substitution across ~85 files (protecting the literal `mgmonteleone/mgm-pi` substring). Two classes
of false positive were caught by re-reading the diff before committing, not by tests:

- **`mgm@mgms.eu` / `mgm@mgmonteleone.com`** (Matthew's real email addresses, used in
  `outfitter/EPIC.md`, `outfitter/deploy/README.md`, `outfitter/deploy/atlas.md`,
  `outfitter/deploy/env.sh` as `gcloud`/MongoDB Atlas account identifiers) were incorrectly rewritten
  to `kernal@...` by the word-boundary rule (a hyphen or `@` counts as a boundary). Reverted by hand.
- **`mgmonteleone\/mgm-pi`** inside one regex literal in `kernal/tests/report.test.ts` (escaped
  slashes) didn't match the plain-slash protection string, so it got partially rewritten to
  `mgmonteleone\/kernal-pi`. Caught by grepping for `mgm-pi` after the pass and fixed by hand.

Both are called out here in case a similar mechanical pass is ever rerun on this codebase — the
protection list needs `mgm@` email addresses and escaped-slash occurrences, not just the plain
literal.

## outfitter/packages/web: not touched (per instructions — another branch is reworking it)

Every user-facing "mgm" string in that package, for whoever merges this against that branch:

| File:line | Current | Replacement |
|---|---|---|
| `outfitter/packages/web/src/pages/SessionPage.tsx:64` | `` const cmd = `mgm --teleport ${sessionId}`; `` | `` const cmd = `kernal --teleport ${sessionId}`; `` |
| `outfitter/packages/web/src/pages/TokensPage.tsx:6` | `"export MGM_TELEPORT_STORE=outfitter"` | `"export KERNAL_TELEPORT_STORE=outfitter"` |
| `outfitter/packages/web/src/pages/TokensPage.tsx:75` | `` Used by <code>mgm --teleport</code> (and <code>/teleport</code>) to talk to the Outfitter link service from `` | `` Used by <code>kernal --teleport</code> (and <code>/teleport</code>) to talk to the Outfitter link service from `` |

`KERNAL_TELEPORT_STORE` (with an `MGM_TELEPORT_STORE` fallback, per the same policy as every other
renamed var) is what `kernal/.pi/extensions/teleport/store-factory.ts` reads after this change, so
the web package's copy-paste snippet on the Tokens page should switch to the new name to avoid
directing users at a name that only works via the deprecated fallback.

## `git grep -niE '\bmgm\b|MGM_'` — remaining hits, grouped by reason

(`\b` is not honoured the same way by every grep implementation `git grep` can be built against;
these were verified with an unambiguous plain-substring grep for `mgm`, `MGM_`, `mgm-pi` and
`mgmonteleone` and hand-categorized below — every hit falls into one of the six allowed reasons.)

**1. Identity (Matthew's/Matej's profile, not the product)**
- `kernal/.pi/extensions/kernal-banner/lib.ts` — the `PROFILES` regex (`/^(mgm|matthew|mgm@|mgmonteleone|matthewm@)/i`), matching Matthew's OS username/GitHub login/email, and the `"MGM"` display letters.
- `kernal/.pi/extensions/kernal-report/lib.ts` — `DEFAULT_ASSIGNEE = "mgmonteleone"` (Matthew's GitHub login, for `/report`'s `gh issue create --assignee`).
- `kernal/tests/banner.test.ts` — test values (`"mgm"`, `"mgmonteleone"`) exercising the identity match.
- `outfitter/EPIC.md`, `outfitter/deploy/{README.md,atlas.md,env.sh,service.sh}`,
  `outfitter/packages/api/docs/data-model.md` — the `mgmonteleone.com` Google Workspace domain and
  `mgm@mgms.eu` / `mgm@mgmonteleone.com` account identifiers (see "Mistakes caught" above).

**2. The legacy fallback helper and its tests**
- `kernal/.pi/extensions/_shared/env.ts`, its comment and the `MGM_` branch of `env()`.
- `kernal/bin/kernal`, `kernal/scripts/install.sh` — the `kenv()` function definitions and comments.
- `kernal/tests/env-compat.test.ts`, the `kenv()` block in `kernal/tests/install.test.ts`.
- `.env.example:5` — one comment line noting the old name.
- `kernal/.pi/extensions/kernal-banner/index.ts:7`, `kernal-banner/lib.ts:57` — doc comments naming
  the legacy `MGM_USER` the fallback still reads.
- `kernal/.pi/extensions/compaction/index.ts` — the `s.mgm` settings-key fallback and its comment.
- `kernal/.pi/extensions/compaction/lib.ts` — the `mgm-pin` legacy pinned-content tag and its comment.

**3. Migration code in install.sh**
- `kernal/scripts/install.sh` — `LEGACY_DEFAULT_HOME`, `rename_env_keys()`, `migrate_legacy()`, and
  every comment describing the `~/.mgm` → `~/.kernal` migration.

**4. The `mgm` shim**
- `kernal/scripts/install.sh:237-247` — the heredoc that writes `~/.local/bin/mgm`.

**5. The repo slug (unchanged, an owner-account setting)**
- `mgmonteleone/mgm-pi` in `kernal/bin/kernal`, `kernal/scripts/install.sh`, `kernal/README.md`,
  `kernal/.pi/extensions/kernal-report/lib.ts`, `kernal/.pi/extensions/kernal-update/{index.ts,lib.ts}`,
  `kernal/tests/report.test.ts`.

**6. Historical docs (left as-is per instructions)**
- `outfitter/docs/reports/*.md` — `api-tokens.md`, `critic-review-pr15.md`, `image-trim.md`,
  `security-review-pr1.md`, `teleport-store.md`. These are point-in-time review records; their
  content is history and was not edited.

**Not covered by the six reasons above, and intentionally left for the other branch:**
- `outfitter/packages/web/**` — see the table above.

No other hits.

## Verification

**1. `cd kernal && npm ci && npm test`**
```
ℹ tests 324
ℹ suites 81
ℹ pass 324
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
Includes the new `install-migration.test.ts` (8/8) and `env-compat.test.ts` (7/7), plus the extended
`kenv()` coverage in `install.test.ts`, run against the real `install.sh` (no mocking of the shell
script itself — it is executed with `execFileSync`).

**2. `cd outfitter && npm ci && npm test && npm run build`**
```
npm test:  exit 0, 0 failing markers across all four workspaces (api, agentd, provider-local, web)
  api:            153 tests, 153 pass
  agentd:         (part of the same `npm test` run across workspaces; no failures)
  provider-local: 2 tests, 2 pass
  web (vitest):   27 tests, 4 files, all passed
npm run build: agentd (tsc), provider-local (tsc), web (tsc --noEmit + vite build) all succeed
```

**3. `git grep -niE '\bmgm\b|MGM_'`** — see the grouped list above; every remaining hit is one of
the six allowed reasons, or the documented `outfitter/packages/web` exception.

**4. `bash -n` on every shell script** (`kernal/scripts/{install,package,prebundle}.sh`,
`kernal/bin/kernal`, every `outfitter/deploy/*.sh`, `outfitter/image/{build,render-settings,strip-native-binaries,strip-native-binaries.test}.sh`,
`tunnel.sh`) — all pass. **`shellcheck`** was not available in this environment (`command -v
shellcheck` found nothing); this step could not be run and should be done before merge if a
`shellcheck` binary is available in CI or a reviewer's machine.

## Left for someone with `shellcheck` access

Run `shellcheck` over the shell scripts listed above (`kernal/scripts/*.sh`, `kernal/bin/kernal`,
`outfitter/deploy/*.sh`, `outfitter/image/*.sh`, `tunnel.sh`) — it wasn't installed in this sandbox.
