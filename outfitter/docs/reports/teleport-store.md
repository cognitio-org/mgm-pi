# E4.1 `OutfitterStore` / E4.2 store half — implementation report

## What this covers

E4.1 (`OutfitterStore` in the mgm teleport extension) and the store half of E4.2 (cloud → laptop:
stop-before-pull). See `outfitter/EPIC.md`'s E4 section for the up-to-date status; this report is
the narrative version.

## Where it lives

- `mgm/.pi/extensions/teleport/outfitter-store.ts` — the new `Store` implementation.
- `mgm/.pi/extensions/teleport/store-factory.ts` — picks `GitStore` vs `OutfitterStore` from
  `MGM_TELEPORT_STORE`.
- `mgm/.pi/extensions/teleport/lib.ts` — `Store.get` grew an optional `opts?: { force?: boolean }`
  second parameter (`GitStore` ignores it; it has no notion of an active run).
- `mgm/.pi/extensions/teleport/index.ts`, `cli.ts`, `bin/mgm` — wired to `createStore()` instead of
  constructing `GitStore` directly, and thread a `--force` flag through to `store.get`.
- `outfitter/packages/api/src/routes/sessions.ts` — `GET /api/sessions/:id` now also returns
  `runState`.
- Tests: `mgm/tests/teleport-outfitter.test.ts` (new), `outfitter/packages/api/test/routes.test.ts`
  (one new case).
- Docs: `mgm/README.md`'s Teleport section, `outfitter/EPIC.md`'s E4.1/E4.2 entries.

## How the interface maps

`OutfitterStore` implements the exact same three methods `GitStore` does, so `index.ts`/`cli.ts`
don't know or care which store they're driving:

- **`list()`** → `GET /api/sessions`, mapped from the API's `SessionSummary` shape to teleport's
  `SessionRef` (`{id, name?, cwd, repo?, branch?, updatedAt, host}`). `cwd` is always `/workspace`
  (every Outfitter session's header cwd, per `sessions.ts`'s `headerLine`); `host` is
  `outfitter:<api hostname>`, so `describeRef` shows which deployment a session came from.
- **`get(id, opts)`** → `GET /api/sessions/:id/export.jsonl` for the transcript, plus `GET
  /api/sessions/:id` to build the `Manifest` (`repo` is populated only when the session has both
  `repo` and `branch`; `head` comes from `checkpoint.head`, empty string if the session was never
  checkpointed). Before fetching, it stops an active run and waits — see below.
- **`put(id, jsonl, manifest)`** → `PUT /api/sessions/:id/import` with the raw JSONL body. The
  `manifest` argument is accepted for interface compatibility but unused: the API derives
  everything it needs from the JSONL header, and **already creates the session server-side when the
  id doesn't exist yet** (`sessions.ts`'s import handler inserts a fresh `Session` row before
  writing entries) — so pushing a laptop-originated session to a fresh Outfitter deployment needed
  no API change. Import is refused with 409 while a run is active for that id (pre-existing
  behavior, unchanged); `OutfitterStore.put` does not try to stop a run first — the task only
  required the stop-and-wait for pulls (`get`), not pushes.

## Stop-before-pull

`get()` calls a private `ensureStopped(id, force)`:

1. `GET /api/sessions/:id` for the current `runState`.
2. If it's not one of `queued/provisioning/running/idle/stopping` (mirrors `memory.ts`'s
   `findActiveForSession`'s active-state set), there's nothing to do.
3. If `--force` was passed, it warns and returns immediately — the pulled transcript may then be
   missing whatever the still-running agent hasn't checkpointed yet.
4. Otherwise: `POST /api/sessions/:id/stop` (a 404 here just means the run finished between steps 1
   and 3 — treated as already stopped), then polls `GET /api/sessions/:id` every `pollIntervalMs`
   (default 2s) until `runState` clears, up to `stopTimeoutMs` (default 90s). On timeout it throws
   an actionable error naming the elapsed time and suggesting `--force`.

`--force` reaches this from two places: `mgm --teleport <id> --force` (parsed in `bin/mgm`, stripped
before the remaining args are exec'd into `pi`) and `/teleport pull <id> --force` inside a running
pi session.

### Why `GET /api/sessions/:id` needed a small change

`GET /api/sessions/:id` returned the raw `Session` row, which has no `runState` field — only the
list endpoint's `summarize()` computed that per-row via `ctx.store.runs.findActiveForSession`. Since
polling by id needed exactly that value without re-listing every session on the deployment, the
route now also calls `findActiveForSession` and spreads `runState` onto the response. This is
additive (existing consumers reading `Session` fields still get them) and covered by a new test
(`outfitter/packages/api/test/routes.test.ts`, "GET /api/sessions/:id... includes runState").

## Auth

Two modes, resolved once per `authHeader()` call (an IAP token is cached after the first mint):

- **`OUTFITTER_TOKEN`** → `Authorization: Bearer <token>`. This only actually authenticates against
  today's API when it's running `OUTFITTER_DEV=1` — `auth.ts`'s `identityFromRequest` in dev mode
  ignores every header and returns `dev@localhost` unconditionally. There is no server-side
  verification of a personal token yet (EPIC.md's original E4.1 line mentioned "a personal API token
  issued by the API" as an option; that issuance/verification doesn't exist in the codebase, so this
  mode is dev/local-only today, documented as such in `mgm/README.md`).
- **`OUTFITTER_IAP_CLIENT_ID`** → shells out to `gcloud auth print-identity-token
  --audiences=<id>` (via `execFile`, promisified, exactly like `lib.ts`'s own git-exec pattern) using
  whichever account `gcloud` is currently logged in as — never hardcoded — and sends the result the
  same way, `Authorization: Bearer`. This is standard GCP IAP behavior for programmatic/service
  access: IAP verifies the token itself in front of Cloud Run and forwards the request to the API
  with `x-goog-iap-jwt-assertion` set, which `auth.ts` already verifies for browser traffic. **No
  API-side change was needed for this path** — it works purely because of how IAP is configured
  (`deploy/api.sh`'s `--iap` flag), not because of anything `OutfitterStore` does beyond sending the
  right header.

Neither token is ever written to disk. A 401 response is turned into "sign in with `gcloud auth
login` as your mgmonteleone.com account (IAP mode), or check OUTFITTER_TOKEN (dev mode)"; a 403
into "your account is not allowed to use this Outfitter deployment"; missing config into a message
naming both env vars.

## What's still open (honest E4.2 status)

- **Repo/clean-tree verification** is not new code — it already existed in `cli.ts`/`index.ts` and
  runs for *any* store whose returned manifest has a `repo` section, GitStore or Outfitter alike.
  `OutfitterStore.get` does populate `manifest.repo` from the session's `repo`/`branch`/
  `checkpoint.head` when present, so a repo-backed cloud session does get the same "same repo,
  clean tree, fetch + checkout the branch" treatment on pull. Nothing Outfitter-specific was needed
  here — that's the "not yet wired up" EPIC.md flagged as a caveat, now confirmed as already
  covered by reusing the existing checks.
- **Model remap** (`pickModelForHost`) is likewise unchanged and reused as-is by the generic
  `pull()`/`cli.ts` flow, regardless of which store returned the transcript.
- **End-to-end testing against a real deployed Outfitter API** has not been done — `OutfitterStore`
  is unit-tested against a fake `fetch` (list/get/put mapping, the stop-then-poll flow, `--force`,
  the 90s timeout, and auth header selection), matching the existing `GitStore` test's style
  (`mgm/tests/teleport.test.ts`), but nobody has run `mgm --teleport <id>
  MGM_TELEPORT_STORE=outfitter` against a live Cloud Run deployment yet.
- **E4.3 (laptop → cloud push that wakes a run)** and **E4.4 (web "Open in terminal")** are
  untouched — out of scope for this story.

## Test results

- `cd mgm && npm test` — 226 passed, 0 failed (10 new: `OutfitterStore auth header selection` ×4,
  `OutfitterStore.list` ×1, `OutfitterStore.get` ×4, `OutfitterStore.put` ×1).
- `cd outfitter/packages/api && npm test` — 93 passed, 0 failed (1 new: `GET /api/sessions/:id`
  runState case).
