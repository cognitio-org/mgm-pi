# Review: PR #22 — mgm → Kernal rename (branch `kernal-rename`)

Adversarial review of the diff `origin/main...HEAD`, the PR description, and
`outfitter/docs/reports/kernal-rename.md`. Every finding below was verified by reading the actual
code (not just the report's claims) and, where practical, by running the code.

## Verdict: APPROVE, with one MEDIUM finding worth a follow-up (not a merge blocker)

No CRITICAL or HIGH-confidence blocking issues found. The migration path for the two real installs
this PR has to not break (default `~/.mgm`, `mgm update` triggering it) is correct, safe on
partial-failure, and idempotent, and I could not break it under any of the scenarios in the task
that use the *default* install location. One real gap exists for a **custom** `MGM_HOME`, documented
below as MEDIUM/HIGH-confidence, plus a couple of LOW-severity notes.

## What I checked and found sound

1. **Old-client compatibility** (`v0.1.18`'s `bin/mgm update`, read from the `v0.1.18` tag on
   `origin/main`): it downloads only `install.sh` (`gh release download ... --pattern install.sh`,
   or the equivalent `curl` fallback) and runs
   `MGM_HOME="$(cd -P "$ROOT/.." && pwd)" MGM_VERSION=... bash install.sh`. `REPO="mgmonteleone/mgm-pi"`
   is unchanged in both `kernal/bin/kernal` and `kernal/scripts/install.sh`, so the old client's
   download URL still resolves. The new release workflow's `installer` job
   (`.github/workflows/release.yml:76-82`) uploads `kernal/scripts/install.sh` with `gh release
   upload`, which publishes it under its basename `install.sh` — exactly the asset name the old
   client's `--pattern install.sh` expects. Verified this is unchanged from `origin/main`'s own
   `release.yml` (same `gh release upload ... mgm/scripts/install.sh` pattern, just the source path
   renamed).
2. **`kernal-update`'s version check** (`kernal/.pi/extensions/kernal-update/lib.ts` /
   `index.ts`) and the **old** `mgm-update` extension (`v0.1.18:mgm/.pi/extensions/mgm-update/`):
   both call `gh release view --json tagName` (or the API fallback) and compare semver — neither
   looks at asset filenames, so the `mgm-*` → `kernal-*` asset rename does not break update
   detection either direction. Confirmed `kernal-update/index.ts` migrated its `MGM_NO_UPDATE_CHECK`
   / `MGM_UPDATE_REPO` / `MGM_UPDATE_CACHE` reads to `env("NO_UPDATE_CHECK")` /
   `env("UPDATE_REPO")` / `env("UPDATE_CACHE")` (`kernal/.pi/extensions/kernal-update/index.ts:24,32,79`)
   — no direct `process.env.MGM_*` left in that file.
3. **The default-path migration itself** (`kernal/scripts/install.sh:93-133`, `migrate_legacy()`):
   read line by line against the task's failure scenarios:
   - **Checksum/download failure**: happens at `install.sh:90`, strictly *before* `migrate_legacy()`
     is ever called (`:133`) and before `mkdir -p "$HOME_DIR"` — a failure here leaves `~/.mgm`
     completely untouched and the old `mgm` binary fully usable. Verified by reading the line order.
   - **Extraction failure mid-migration** (`tar xzf` fails at `:149`, e.g. disk full): this runs
     *after* `migrate_legacy()` has already copied `state/`, staged `.env`/`settings.json` into
     `$tmp`, but the `~/.mgm/current` symlink swap and `~/.mgm/MOVED` marker only happen at
     `:220-231`, well after extraction. `set -e` aborts the script at the failed `tar`, so
     `~/.mgm/current` still points at the real, intact 0.1.17 bundle — the old install stays usable,
     and a re-run safely re-does the (idempotent, copy-without-clobber) migration. Verified by
     reading the ordering and the copy-without-clobber guards (`:112-115`, `:117-119`).
   - **bash 3.2 / `set -u` empty arrays**: every array expansion I found (`auth`, `force`, `rest` in
     `bin/kernal`; `auth`, `merge` in `install.sh`) either uses the `${arr[@]+"${arr[@]}"}` guard or
     is only referenced when known non-empty (`merge` is always populated before use). No unguarded
     empty-array expansion introduced by this PR.
   - **`.env` with quotes, `=` in values, CRLF, no trailing newline**: tested `rename_env_keys()`
     (`sed -E 's/^MGM_([A-Za-z0-9_]*)=/KERNAL_\1=/'`) directly against a file with all four
     conditions (`MGM_API_KEY="sk-abc=123 with space"`, CRLF line ending, no final newline) — the
     key prefix is renamed correctly and every value, including embedded `=`, quotes and the `\r`,
     passes through byte-for-byte. Only the key prefix is touched, matching the report's "values
     untouched" claim.
   - **`~/.mgm` as a symlink**: `[[ -d "$legacy" ]]` follows symlinks, and the later
     `cat > "$LEGACY_DEFAULT_HOME/MOVED"` write goes through the symlink to its target — no special
     case needed, behaves the same as a real directory.
   - **`~/.kernal` already present**: `migrate_legacy()`'s copy loops are copy-without-clobber
     (`[[ -f "$STATE/$f" ]] && continue`), so a pre-existing `~/.kernal/state` is only ever added to,
     never overwritten.
   - **`~/.local/bin/mgm` already a symlink**: `rm -f "$mgm_shim"` unconditionally removes whatever
     was there (symlink or file) before writing the new shim as a regular file via heredoc
     (`install.sh:237-247`) — no dangling-symlink risk.
   - **Dangling `~/.mgm/current`**: `ln -sfn "$HOME_DIR/current" "$LEGACY_DEFAULT_HOME/current"`
     (`:221`) only runs after the new `$HOME_DIR/current` symlink has already been created
     successfully (`:150`), so `~/.mgm/current` never ends up pointing at something that doesn't
     exist.
   - **A raw re-invocation of the literal old `~/.mgm/current/bin/mgm` binary** (bypassing the new
     `mgm` shim, e.g. a stale absolute-path alias) after a successful migration: its `update` case
     still computes `MGM_HOME="$(cd -P "$ROOT/.." && pwd)"` = the literal `~/.mgm`, which equals
     `LEGACY_DEFAULT_HOME` exactly, so `install.sh`'s `elif` at `:45` is false and it falls through to
     the `~/.kernal` default (`:47-49`) rather than misinstalling into `~/.mgm` again — and
     `migrate_legacy()` short-circuits on the pre-existing `MOVED` marker. Confirmed this
     self-corrects rather than compounding.
4. **`env()` / `kenv()` fallback precedence**: both the TypeScript helper
   (`kernal/.pi/extensions/_shared/env.ts:13-24`) and the two shell copies
   (`kernal/bin/kernal:10-19`, `kernal/scripts/install.sh:29-38`) check `KERNAL_<NAME>` first and
   fall back to `MGM_<NAME>`, consistently. `grep`ed every extension file that references
   `MGM_`/`KERNAL_` (`compaction`, `connect`, `kernal-admin`, `kernal-admin/subagents`,
   `kernal-banner`, `kernal-codebase-index`, `kernal-report`, `kernal-update`, `kernal-voice`,
   `teleport`, `teleport/outfitter-store`) for direct `process.env.MGM_`/`process.env.KERNAL_`
   access bypassing `env()` — none found; only `_shared/env.ts` itself touches those names directly.
   In the shell scripts, the only direct `$KERNAL_HOME` read (`install.sh:43-44`) is intentional —
   `MGM_HOME` needs its own special source-vs-target handling that a generic `kenv HOME` call
   couldn't express, and that logic is documented inline. The warn-once behavior
   (`_kenv_warned` / `warnedOnce` sets) is correctly scoped to fire once per name per process in both
   implementations.
5. **Mechanical rename correctness**: `git grep`ed for `kernal@`, `kernalonteleone`, `kernal-pi`
   (the exact false-positive shapes the report says it caught) across `*.md`/`*.ts`/`*.sh`/`*.yml` —
   none remain outside the report's own prose describing the fix. Confirmed
   `mgm@mgms.eu`/`mgm@mgmonteleone.com`/`mgmonteleone.com` are intact and unmangled in
   `outfitter/EPIC.md`, `outfitter/deploy/{README.md,atlas.md,env.sh,service.sh}`. Confirmed
   `mgmonteleone/mgm-pi` is intact in `kernal/tests/report.test.ts` (the escaped-slash regex the
   report flagged as a near-miss) and in `kernal-report/lib.ts`'s `DEFAULT_REPO`. `grep`ed
   `.github/workflows/*.yml` for any leftover `mgm` string — none. Dockerfile (`outfitter/image/Dockerfile`)
   consistently uses `/opt/kernal`, `KERNAL_NO_CODEBASE_INDEX`, `kernal-builder`, `kernal-voice` /
   `kernal-update` / `kernal-admin` exclusions, and the images CI job
   (`.github/workflows/outfitter-ci.yml:84-85`) asserts the renamed exclusion paths
   (`/opt/kernal/.pi/extensions/kernal-voice`, `.../kernal-admin`) — consistent with (not changed by)
   the pre-existing check that never asserted `kernal-update`'s absence either.
6. **Identity/banner strings** (`kernal-banner/lib.ts`): the `PROFILES` regex and `"MGM"`/`"MATEK"`
   letters are correctly left alone (Matthew's/Matej's initials, not the product), matching
   `origin/main`'s pre-rename version byte-for-byte in the parts that should be unchanged.
7. **Ran the verification commands myself**: `cd kernal && npm ci && npm test` → 324/324 pass, 81
   suites, matching the report. `cd outfitter && npm ci && npm test && npm run build` → api 153/153,
   provider-local 2/2, web (vitest) 27/27, all four `npm run build` steps (agentd tsc,
   provider-local tsc, web tsc+vite) succeed — matching the report's claims exactly.
   `lsp_diagnostics_directory` on `_shared/env.ts` and `kernal-update/` → 0 errors, 0 warnings.
8. **Release workflow publishes what old clients expect**: `build` job uploads
   `dist/kernal-*.tar.gz(.sha256)` (matches the new `install.sh`'s own download pattern
   `kernal-$VERSION-$platform.tar.gz`); `installer` job uploads `install.sh` at the release root.
   Both are what the *old* `bin/mgm update` and the *new* `install.sh` each need.

## Findings

### [MEDIUM] A custom (non-default) `MGM_HOME` legacy install never gets its `.env` keys renamed, and the gap is undocumented
**File**: `kernal/scripts/install.sh:41-49` (home resolution), `:93-133` (`migrate_legacy`)
**Confidence**: HIGH (verified by code reading; not covered by `install-migration.test.ts`, which
only exercises `MGM_HOME` = the exact legacy default)

`migrate_legacy()` only fires for `$LEGACY_DEFAULT_HOME` (`$HOME/.mgm`) exactly (`:103-106`). A user
whose *original* mgm install used a custom location — e.g. always ran with
`MGM_HOME=~/tools/mgm` — has that same value threaded through by the old `bin/mgm update`'s
`MGM_HOME="$(cd -P "$ROOT/.." && pwd)"` (their real install directory, not the default). Per
`install.sh:45-46`, since that value `!= "$LEGACY_DEFAULT_HOME"`, it is honored as the **target**
directly — this is explicitly the intended design (documented in `docs/rename.md`'s "A custom
`MGM_HOME`" section and the `install.sh` header comment), not an oversight in itself. But one
consequence isn't accounted for anywhere: because this path never calls `migrate_legacy()` (there is
no separate `$HOME/.mgm` to migrate — the "legacy" and "new" homes are the same custom directory),
`rename_env_keys()` — the *only* place `.env` keys get renamed from `MGM_*` to `KERNAL_*` — never
runs for this user. Their `.env` keeps `MGM_*` names **forever**, through every future upgrade,
because the normal (non-migration) upgrade path at `:139-156` only ever preserves `keep_env`
verbatim, never rewrites keys.

This is not a silent break today — `env()`/`kenv()`'s fallback keeps it working and prints a
once-per-process warning — but `docs/rename.md`'s own "When to remove the fallback" section commits
to eventually deleting the `MGM_*` branches "once both machines have been on kernal for a while."
When that happens, anyone in this situation (a custom-`MGM_HOME` upgrade-in-place, as opposed to a
migration) loses functionality with no automated remediation ever having been offered, and nothing
in `docs/rename.md` flags that their `.env` needs manual editing. The task explicitly asked me to
check the custom-`MGM_HOME` case; I don't believe either of the two real installs this PR has to
protect (both on default paths, per the report) hit this, so it's not a merge blocker, but it's a
real, verifiable gap in an otherwise careful migration.

**Fix**: either (a) call `rename_env_keys()` unconditionally whenever `keep_env` is sourced from an
`MGM_*`-keyed file regardless of which branch set `HOME_DIR` (detect by grepping the existing
`.env`'s key prefixes rather than gating on `$HOME_DIR == $LEGACY_DEFAULT_HOME`), or (b) at minimum,
document the gap explicitly in `docs/rename.md` so a custom-`MGM_HOME` user knows to rename their
`.env` keys by hand before the fallback is removed.

### [LOW] `docs/rename.md`'s "nothing to migrate" framing for custom `MGM_HOME` slightly overstates the case
**File**: `kernal/docs/rename.md:67-70`
**Confidence**: MEDIUM

"there is nothing to migrate because there is no ambiguity about which directory the user meant" is
true for *which directory* to use, but glosses over the `.env` key-rename gap above (the doc frames
it as purely a home-directory-resolution question). Worth a one-line addition once the MEDIUM finding
above is triaged, so the doc doesn't need a second pass.

### [LOW] `outfitter/packages/web` still shows `mgm`/`MGM_TELEPORT_STORE` in user-facing copy
**File**: `outfitter/packages/web/src/pages/SessionPage.tsx:64`, `TokensPage.tsx:6,75`
**Confidence**: HIGH (functionally harmless, cosmetic only)

This is called out explicitly in the PR description and the report as intentionally deferred to
another branch, and I confirmed it is not a functional break — `store-factory.ts` reads
`KERNAL_TELEPORT_STORE` via `env()` with the `MGM_TELEPORT_STORE` fallback
(`kernal/.pi/extensions/teleport/store-factory.ts:1-10`), so copy-pasting the page's current snippet
still works, just triggers the deprecation warning and points users at the legacy name. Flagging only
so it isn't lost — the PR author already has the exact file:line table in the report.

## Not re-litigated (already covered adequately by the report / tests, verified but not written up again)
- `kernal-report`'s `DEFAULT_ASSIGNEE`/`DEFAULT_REPO` and `kernal-banner`'s `PROFILES` regex: identity,
  correctly unrenamed.
- `compaction`'s `s.mgm` settings fallback and `mgm-pin` session-entry-type fallback: read-only
  fallback, write path migrates to `s.kernal`/`kernal-pin` on first patch — verified in
  `compaction/index.ts:37-48` and `compaction/lib.ts:182-183`.
- `shellcheck` was not run (also unavailable in this sandbox, matching the report's own caveat);
  `bash -n` was implicitly exercised by successfully running `install-migration.test.ts` and
  `install.test.ts` against the real scripts via `execFileSync`.

## Positive observations
- The failure-mode analysis in `migrate_legacy()` — ordering the checksum check before any legacy
  read, and the symlink/`MOVED`-marker swap after extraction succeeds — means the two real installs
  this PR protects cannot end up in a half-migrated, unusable state even on a bad network day. This
  is the right shape for a migration script and it's rare to see it this carefully sequenced.
- `install-migration.test.ts` runs the *real* `install.sh` via `execFileSync` rather than mocking the
  shell script, which is exactly the right level of rigor for this kind of change and is what let me
  trust the default-path scenarios without re-deriving them by hand.
- The `pipefail` bug fix (`{ grep -E '...' || true; }` at `install.sh:155`) was caught by writing a
  new test rather than by inspection — good instinct, and the report's explanation of *why* the
  existing tests never hit it is accurate (I re-derived the same reasoning independently while
  reading the diff).
- The mechanical-rename mistakes (email addresses, one escaped-slash regex) were caught and reverted
  before this PR — I re-verified both are actually fixed, not just claimed fixed.
