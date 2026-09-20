# Code review fix: teleport GitStore.put() diverges after a non-fast-forward push

## Finding (lib.ts:166, pre-fix)

`GitStore.put()` committed locally, only *warned* when `git push` failed, and never pulled before
writing. If another machine had pushed to the store in between, the local clone was behind: the
commit diverged, the warn-only push kept silently failing on every later `push`, and `/teleport push`
still reported "Teleported" as if it succeeded.

## Fix

`mgm/.pi/extensions/teleport/lib.ts`:
- Added `GitStore.syncBeforePut()`: when a remote is configured, runs `git pull --ff-only` before any
  files are written; if that fails (divergence), falls back to `git pull --rebase` and continues
  either way (offline stays local-only here, same tolerance as the existing `syncFromRemote()` used by
  `list`/`get`).
- `put()` now calls `syncBeforePut()` right after `ensureRepo()`, then writes the session/manifest
  files and re-reads `index.json` *after* the sync (not before), so the merged index reflects
  whatever the pull brought in rather than a stale local copy.
- After `git commit`, `put()` runs `git push`; if that's rejected, it runs `git pull --rebase` once
  and retries the push exactly once. If the retry still fails — including being offline with no
  remote reachable — `put()` now **throws** (`"teleport: pushed locally only, will not be visible
  elsewhere until the next successful push: ..."`) instead of warning.

`mgm/.pi/extensions/teleport/index.ts` needed no change: `push()`'s existing `try { ... await
store.put(...); ctx.ui.notify("Teleported...") } catch (err) { ctx.ui.notify(\`teleport push failed:
${err.message}\`, "error") }` already only reports success when `put()` resolves without throwing, so
having `put()` throw on a persistent push failure is enough to turn it into a clear error
notification instead of a false "Teleported".

## Tests added (`mgm/tests/teleport.test.ts`, all stub `exec`, no real git)

- `put() pulls --ff-only before writing, and merges into the index that pull brought in` — stubs the
  `pull --ff-only` call to simulate another machine's session landing in `index.json`, and asserts the
  final merged index keeps that entry plus the new one, and that `pull` is called before `add`.
- `put() rebases and retries once when push is rejected, and succeeds` — first `push` returns a
  non-fast-forward rejection, `pull --rebase` succeeds, second `push` succeeds; asserts no throw and
  exactly 2 push calls.
- `put() throws when push still fails after the rebase retry, instead of reporting success` — both
  `push` and `pull --rebase` keep failing (simulated offline); asserts `put()` rejects with a message
  matching `/pushed locally only/i`, while the commit itself still exists locally.

`npm test` in `mgm/` is green: 58/58 passing (10 in the `GitStore` suite, including the 3 new ones).

## Files touched

- `mgm/.pi/extensions/teleport/lib.ts`
- `mgm/tests/teleport.test.ts`
- `mgm/README.md` (Teleport → Store layout section, describes the sync-before-write and
  rebase-and-retry-then-throw behavior)

No commit was made; changes are left in the working tree.
