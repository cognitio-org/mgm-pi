# mgm → kernal

Starting with release 0.2.0, the **mgm** coding agent is renamed to **Kernal** (spelled with an
`a`, after the Commodore 64's KERNAL ROM). This is a full rename with a safe, automatic migration
for existing installs — nothing manual is required beyond `mgm update` once.

## What changed

- **Product name**: "Kernal" in prose and UI. Banner wordmark and release titles use "KERNAL" /
  "Kernal 0.2.0". The CLI command is `kernal` (lowercase, matching the old `mgm` command's style).
- **Directory**: `mgm/` → `kernal/` in this repository (moved with `git mv`, so history follows).
- **Extensions**: `mgm-admin`, `mgm-banner`, `mgm-codebase-index`, `mgm-context`, `mgm-report`,
  `mgm-update`, `mgm-voice` → `kernal-admin`, `kernal-banner`, `kernal-codebase-index`,
  `kernal-context`, `kernal-report`, `kernal-update`, `kernal-voice`.
- **Release assets**: `mgm-<version>-<platform>.tar.gz` → `kernal-<version>-<platform>.tar.gz`.
- **Install directory**: `~/.mgm` → `~/.kernal` (see *Migration* below).
- **Environment variables**: every `MGM_*` variable is now `KERNAL_*` (`MGM_HOME` → `KERNAL_HOME`,
  `MGM_USER` → `KERNAL_USER`, `MGM_TELEPORT_STORE` → `KERNAL_TELEPORT_STORE`, and so on — see
  `.pi/extensions/_shared/env.ts` for the full list of names each extension reads). The old names
  keep working (see *Fallback policy*).
- **`mgm --teleport`** → **`kernal --teleport`**.
- **Not renamed**: the banner's **MGM** letters are Matthew's initials, and **MATEK** is Matej's —
  those are identity, not the product name, and are unchanged (only the *environment variable* that
  feeds them, `MGM_USER`, is renamed to `KERNAL_USER`). The GitHub repo `mgmonteleone/mgm-pi` is
  unchanged (renaming a GitHub repo is an owner-only setting outside this codebase's control — see
  *What the owner needs to do*). The `mgmonteleone` GitHub user/org name is unchanged.

## Migration (existing installs)

This matters for the two real installs this rename has to not break: the owner's laptop and his
son's, both on mgm 0.1.17.

**All you do is run `mgm update`.** That downloads the new (0.2.0) release's `install.sh` and runs
it the same way it always has: `MGM_HOME=~/.mgm MGM_VERSION=0.2.0 bash install.sh`. The new
`install.sh` recognizes `MGM_HOME=~/.mgm` (the default) as "the legacy install to migrate from," not
as a target, and:

1. Installs the new release into `~/.kernal` (the new default), regardless of the `MGM_HOME` it was
   given.
2. Moves `~/.mgm/state/` (sessions, credentials, trust decisions, caches) into `~/.kernal/state`,
   without overwriting anything already there (idempotent).
3. Copies `~/.mgm/.update-check.json` (kernal-update's daily-check cache) into `~/.kernal`.
4. Carries your `~/.mgm/current/.env` into `~/.kernal/current/.env`, **renaming every `MGM_*` key
   to `KERNAL_*`** (values are copied byte-for-byte and never printed anywhere, including in the
   installer's own output).
5. Carries your `~/.mgm/current/.pi/settings.json` edits forward using the same three-way settings
   merge every upgrade already uses (your changes win, the new release's new defaults arrive, list
   settings like installed packages merge key by key).
6. Leaves `~/.mgm` in place — **nothing under it is deleted** — but replaces `~/.mgm/current` with a
   symlink to the new `~/.kernal/current`, and writes `~/.mgm/MOVED`, a text file explaining what
   happened and that the directory is safe to delete once you've confirmed `kernal version` and
   your sessions look right.
   Its old release bundles are most of its size; `kernal prune --legacy` lists them and,
   with `--yes`, deletes only them, after checking every session file in `~/.mgm` is byte-identical
   in `~/.kernal/state/sessions` (README, *Staying up to date*).
7. Installs `~/.local/bin/kernal` (the new launcher) and makes `~/.local/bin/mgm` a link to the same
   launcher. `mgm` is a permanent, silent alias, not a deprecated name: it is the owner's initials
   and years of muscle memory, and keeping it costs nothing. Both names behave identically and
   follow every upgrade.

**Idempotent.** Running `install.sh` a second time (e.g. `mgm update` run twice, or `kernal update`
after the migration already happened) is a no-op for the migration step: it checks for
`~/.mgm/MOVED` first and returns immediately if it exists.

**A custom `MGM_HOME`** (anything other than the default `~/.mgm`, e.g.
`MGM_HOME=~/tools/mgm bash install.sh`) is *not* treated as a legacy install to migrate from — it is
honored as the install target directly, exactly as `KERNAL_HOME` would be. That directory just goes
on holding the renamed bundle; there is nothing to migrate because there is no ambiguity about which
directory the user meant. Its `.env` keys are still renamed: every install rewrites `MGM_<X>` to
`KERNAL_<X>` in the carried-over `.env` (keeping `KERNAL_<X>` if both are present), so an in-place
upgrade at a custom home ends up with the same keys as a migrated one.

Verified end-to-end by `kernal/tests/install-migration.test.ts`: it builds a fake `~/.mgm/mgm-0.1.17-<platform>/`
install (a `current` symlink, a session file under `state/sessions/`, a `.env` with `MGM_USER` and a
secret-looking key, a `settings.json` edit, and a legacy `~/.local/bin/mgm` symlink — the shape a
real v0.1.17 laptop install has), runs the real `install.sh` against it with a locally built fake
bundle (no network, no download), and asserts every guarantee above, including that a second run
changes nothing.

## Fallback policy

Every `MGM_*` environment variable name still works, for now:

- **TypeScript extensions** read env vars through `env(name)` in
  `.pi/extensions/_shared/env.ts`, which checks `KERNAL_<NAME>` first and falls back to the legacy
  `MGM_<NAME>` if the new name isn't set. The fallback path prints one line to stderr —
  `"MGM_<NAME> is now KERNAL_<NAME>; the old name stops working in a later release."` — the first
  time it's used in a process, and stays silent after that (so a long-running session or a script
  that calls the same code path repeatedly doesn't spam the terminal).
- **Shell scripts** (`bin/kernal`, `scripts/install.sh`) each define their own small `kenv NAME`
  function with the identical behavior — they can't share a single sourced file, because
  `install.sh` is downloaded and run standalone by `kernal update`, separately from the rest of the
  repo.
- **Settings persisted to `.pi/settings.json`**: `compaction`'s preferences used to live under the
  top-level `"mgm"` key; they now live under `"kernal"`, and the code reads `"kernal"` first, then
  falls back to reading (never writing) the old `"mgm"` key, so a settings.json carried across the
  rename by the three-way merge still works.
- **The `mgm-pin` pinned-content tag and `mgm.report` custom session-entry type** (both internal,
  written into a session's `.jsonl` history, not env vars) are now `kernal-pin` / `kernal.report`
  going forward; the code that reads pinned content still recognizes the old `mgm-pin` tag so pins
  made before the rename keep surfacing after an upgrade.

Covered by tests: `kernal/tests/env-compat.test.ts` (the TypeScript helper) and a `kenv()` block in
`kernal/tests/install.test.ts` (both shell copies, extracted from the real scripts and exercised
directly, so the two can't quietly drift apart).

**When to remove the fallback.** It exists for exactly one reason: two real people (the owner and
his son) have mgm 0.1.17 installs today, and an env var set in a dotfile or shell profile (as
opposed to `.env`, which `install.sh` migrates automatically) won't get renamed by the migration.
Once both machines have been on kernal for a while and nothing is logging the "is now KERNAL_"
warning anymore, delete: `.pi/extensions/_shared/env.ts`'s `MGM_` branch (or the whole fallback,
replacing `env("X")` calls with plain `process.env.KERNAL_X`), the `kenv` functions' `mv`/legacy
branches in `bin/kernal` and `scripts/install.sh`, the `s.mgm` fallback in
`.pi/extensions/compaction/index.ts`, and the `mgm-pin` branch in `compaction/lib.ts`. The `~/.local/bin/mgm` alias is permanent. Leave the `MGM_HOME`-migration logic in `install.sh` alone for
longer too: it costs nothing to keep and only runs for someone still on a pre-0.2.0 install.

## What the owner needs to do

**Nothing**, for the two existing installs — `mgm update` handles everything above.

**Optional**: rename the GitHub repository from `mgmonteleone/mgm-pi` to something matching the new
name (e.g. `mgmonteleone/kernal`). GitHub automatically redirects the old URL (git remotes, `git
clone`, and web links) to the new one after a rename, so this is safe to do at any time and does not
need to happen before or alongside anything in this change. It was intentionally left undone here:
renaming a GitHub repository is an owner-account setting, not a code change, and is out of scope for
a PR. If done, update `REPO="mgmonteleone/mgm-pi"` in `bin/kernal`, `scripts/install.sh`,
`.pi/extensions/kernal-update/lib.ts` and `.pi/extensions/kernal-report/lib.ts` (all currently
correct as-is, since the repo slug has not changed) — and the CI workflow files that reference the
repo by URL.

## Version

Bumped to 0.2.0 (`kernal/package.json`) — the rename is a breaking change for anyone relying on the
`mgm` name, the `MGM_*` env vars without the fallback, or the `mgm-*` extension directory names.
