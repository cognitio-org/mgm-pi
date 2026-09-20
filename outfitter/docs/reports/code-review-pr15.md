# Code review — PR #15 (`outfitter/round-four`, `git diff origin/main...HEAD`)

Reviewed against `outfitter/EPIC.md`, `outfitter/docs/protocol.md`, and the four workstream reports
(`web-ui.md`, `providers-status.md`, `spend-fix.md`, `teleport-store.md`). Every finding below was
verified by reading the actual source, not just the reports. Read-only review — no source edited.

## Summary

| Severity | Count |
|---|---|
| Blocker | 0 |
| Major | 2 |
| Minor | 6 |

**Recommendation: REQUEST CHANGES** — two Major findings (a broken UI filter that always returns
empty results, and a stop-endpoint state-machine gap that a new code path in this PR now reaches and
can force-kill a sandbox mid-checkpoint). Neither is a security hole and both have small, well-scoped
fixes; nothing here should block on redesign.

---

## Major

### M1. Fleet page's "run state" filter can never match anything

**File:** `outfitter/packages/web/src/pages/FleetPage.tsx:8,51-58` (dropdown), talking to
`outfitter/packages/api/src/routes/sessions.ts:96-99` and
`outfitter/packages/api/src/store/memory.ts:41-46` / `store/mongo.ts:64-70` (`SessionsCollection.list`).

`FleetPage`'s status filter is built from:
```ts
const RUN_STATES = ["queued", "provisioning", "running", "idle", "stopping", "stopped", "failed"];
...
<select value={statusFilter} ... aria-label="Filter by run state">
  {RUN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
```
and calls `api.sessions({ status: statusFilter || undefined, ... })`, which hits
`GET /api/sessions?status=<value>`.

The API route passes that straight through to `ctx.store.sessions.list({ status: query.status, ... })`,
and both `MemorySessions.list` and `MongoSessions.list` filter on **`Session.status`**, whose only two
values are `"open"` and `"closed"` (`store/types.ts:28`) — not `Run.state` (`RunState`, which is where
`"queued"/"running"/"idle"/"stopping"/"stopped"/"failed"` actually live, `store/types.ts:6`). Every
option in the dropdown is a `RunState` value, so picking any of them sends a `status` the store never
matches (`s.status === "running"` is always false), and the fleet table silently renders "No sessions
yet." regardless of what's actually running. The filter is unusable for its stated purpose; only an
(unlisted) `open`/`closed` value would ever work, and the UI doesn't offer those.

**Failure scenario:** a user opens `/`, picks "running" from "Filter by run state" expecting to see
active sessions, and gets an empty table even though sessions are running — indistinguishable from "no
sessions" at a glance, which is actively misleading on an ops dashboard.

**Fix:** either (a) change the dropdown to filter on `session.status` (`open`/`closed`, matching what
the API actually filters on) and drop the "run state" label, or (b) add real run-state filtering:
extend `SessionListFilter`/`summarize()` to filter post-hoc on `runState` (computed per-row already in
`summarize`), which needs an API change since today's `list()` filters before `runState` is even known.
Either way, the current combination of frontend labels/values and backend filter semantics is broken.
No existing test caught this — `FleetPage`/`api.sessions` filtering has no test at all (only
`api.sendMessage`'s body shape is tested in `test/client.test.ts`).

### M2. `POST /sessions/:id/stop` can force-kill a run that's already gracefully stopping — newly reachable via `OutfitterStore.ensureStopped`'s retry path

**Files:** `outfitter/packages/api/src/routes/sessions.ts:150-176` (pre-existing logic, unchanged by
this PR) exercised by the new `mgm/.pi/extensions/teleport/outfitter-store.ts:175-205`
(`ensureStopped`, added in this PR for E4.2).

The `/stop` route branches on:
```ts
if (run.state !== "running" && run.state !== "idle") {
  // No live agent yet (queued/provisioning) to ask gracefully -- cancel the provider execution
  // directly, same as before.
  const stopped = await ctx.runs.stop(run.id, "user");
  return { run: stopped };
}
```
`RunsCollection.findActiveForSession` (and this route's own "active" notion) includes `"stopping"` as
an active state (`memory.ts:98`, `mongo.ts:29`, matching `protocol.md`'s "`stopping` ... counts for
`findActiveForSession`"). So if the run is already `stopping` (a *previous* stop request is mid-flight,
agentd is draining toward `bye` after a checkpoint push), a **second** `POST /stop` call takes the
"no live agent, cancel directly" branch — `run.state !== "running" && run.state !== "idle"` is true for
`"stopping"` too — and calls `RunManager.stop()` (`runs.ts:86-97`), which immediately calls
`provider.stop(providerHandle)` (a hard Cloud Run execution cancel) and marks the run `stopped`. This
skips the graceful drain entirely and can kill agentd mid-checkpoint (git push / JSONL upload in
progress), the exact scenario `docs/protocol.md`'s `stopping` design was built to avoid.

`OutfitterStore.ensureStopped` (new in this PR, `outfitter-store.ts:175-205`) is a concrete new caller
that can trigger the *second* stop:
- Its `ACTIVE_RUN_STATES` set (line 29) explicitly includes `"stopping"`, so its initial `GET
  /api/sessions/:id` check treats a run already `stopping` as "needs stopping" and proceeds to
  `POST .../stop` again rather than skipping straight to the poll loop.
- Concretely reachable: teleport's own 90s timeout (`stopTimeoutMs`) throws if the first stop takes too
  long; a user who retries `mgm --teleport <id>` (or `/teleport pull <id>`) after that timeout re-enters
  `ensureStopped` while the run is still `"stopping"` from the first attempt, and the retry's
  `POST /stop` now takes the force-cancel branch. Same outcome if the web UI's "Stop" button was
  clicked moments before a teleport pull — `SessionPage.tsx`'s own Stop button is correctly disabled
  once `runState` becomes `"stopping"` (`RUNNING_STATES` includes it), but nothing stops a *different*
  actor (teleport, or a second browser tab) from calling `/stop` again during that window.

**Fix:** in the `/stop` route, branch explicitly on the three cases (`running`/`idle` → graceful;
`queued`/`provisioning` → direct cancel; already `stopping` → no-op, return the current run as-is, let
the existing grace-period/reconciler path finish it) instead of collapsing `stopping` into the "no live
agent" branch. `outfitter-store.ts`'s `ensureStopped` should also skip re-`POST`ing `/stop` when the
observed state is already `"stopping"` and go straight to polling — belt-and-suspenders, since the
route is the real fix. Not covered by any test: `test/stop.test.ts` covers `reconcileStoppingOnce` and
a single stop call, but nothing calls `/stop` twice or with an initial state of `"stopping"`; likewise
`mgm/tests/teleport-outfitter.test.ts`'s stop-then-poll tests all start from `"running"`, never
`"stopping"`.

---

## Minor

### N1. `useSessionStream`'s initial fetch can clobber entries that arrive over SSE first

**File:** `outfitter/packages/web/src/hooks/useSessionStream.ts:21-45`.

On mount, the hook fires `api.entries(sessionId)` (a plain `GET`) and opens the `EventSource`
essentially back-to-back, with no ordering guarantee between them:
```ts
api.entries(sessionId).then((initial) => { ... setEntries(initial); });
const source = new EventSource(api.streamUrl(sessionId));
source.addEventListener("entry", (ev) => { ...; setEntries((prev) => [...prev, entry]); });
```
If an `entry` SSE event is received and applied (`setEntries(prev => [...prev, entry])`) *before* the
`GET /entries` promise resolves, the later `setEntries(initial)` unconditionally replaces the whole
array — silently dropping the entry that arrived over SSE in the interim, unless it happens to already
be included in `initial` (a race that depends on server-side timing between the two requests, not
guaranteed by the protocol). `entryIds.current` correctly dedupes future SSE entries against `initial`,
but does nothing to prevent this one-time clobber on mount.

**Failure scenario:** opening a session view for a very fast-turning run (or right as a new prompt
lands) can drop the entry the browser was actively streaming, leaving a gap in the transcript until the
next entry arrives (or forever, if that was the last one before the run goes idle).

**Fix:** merge instead of replace — e.g. seed `entryIds` and merge `initial` into whatever's already in
`entries` (union by id, re-sorted if order matters), or buffer SSE `entry` events until the initial
fetch resolves. No test exists for this hook at all (`outfitter/packages/web/test/` has no
`useSessionStream` test), so this race isn't caught by CI either.

### N2. `OutfitterStore.request`'s 409-tolerant branch doesn't match what `/stop` actually returns

**File:** `mgm/.pi/extensions/teleport/outfitter-store.ts:187-191`.

```ts
if (stopRes.status === 404) return; // "no active run" -- already stopped between our check and this call
if (!stopRes.ok && stopRes.status !== 409) { throw ...; }
```
`POST /api/sessions/:id/stop` (`routes/sessions.ts:150-176`) never returns 409 for anything — it
returns 404 ("no active run") or 200. The 409 tolerance here is dead code (harmless, but suggests the
implementation was written against an assumption about the route's status codes that isn't true).
Low-risk cosmetic issue; flagging so it isn't read as "409 is a real, tested response" by a future
change.

### N3. `SseHub`/`ProviderStatusService`'s `"providers"` SSE channel is unused by the frontend

**Files:** `outfitter/packages/api/src/routes/providers.ts:14-18`, `providers-status.ts` (publish
logic), vs. `outfitter/packages/web/src/hooks/useProviders.ts` (poll-once-on-mount only, no
`EventSource`).

`GET /api/providers/stream` is fully implemented server-side (subscribes, pushes an initial snapshot,
and pushes again on any status transition), but nothing in `packages/web` opens it — `useProviders`
only calls `api.providers()` once on mount and never refreshes. This isn't a bug in either piece taken
alone (both reports flag it as intentionally out of scope: E3.6 hasn't been built yet), but it means the
provider strip/`/providers` page currently never updates after first paint even though the backend
machinery to make it live already exists and is tested. Worth tracking so it isn't lost as "already
done" — `web-ui.md` correctly scopes this out, but nothing currently points back at it as a concrete
follow-up task in EPIC.md's E3.6 line beyond the general SSE requirement already listed there.

### N4. `outfitter-spend.ts`'s `session_start` baseline can race with the first real spend line (already disclosed, re-confirmed)

**File:** `outfitter/packages/agentd/pi-extension/outfitter-spend.ts:297-317`.

`pi.on("session_start", (_ev, ctx) => { ...; void Promise.all([fetchModelPrices(), fetchKeySpend()]).then(...) })`
is fire-and-forget (`void`, not awaited by the handler), so pi is free to make its first provider call
and fire `after_provider_response` before the `Promise.all` resolves and appends the `{baseline: true,
...}` line. If that happens, the real spend line lands in `OUTFITTER_SPEND_FILE` first, and
`agentlink.ts`'s "pin `keySpendStart` from the first frame seen" logic pins from the post-call balance
again — reverting to the exact bug E2.11b was written to fix, for that one run's first call only.
`spend-fix.md`'s own "Follow-up" section already documents this race and accepts the degraded-not-wrong
outcome; confirmed by reading the code that the race is real (not just theoretical) and that there's no
synchronization forcing the baseline fetch to complete before the first provider call can return. No
action required beyond what's already disclosed — noting it here because the task asked specifically to
verify the `keySpendStart` interaction, and confirming it independently is different from trusting the
report's own description of it.

### N5. `parseModelInfo`/`parseModelInfoPrices` duplicated across three files with different unit conventions

**Files:** `mgm/.pi/extensions/connect/lib.ts` (per-*million*-token prices), `outfitter/packages/api/src/providers-status.ts:200-225` (`parseModelInfo`, per-million, explicit copy), `outfitter/packages/agentd/pi-extension/outfitter-spend.ts:127-141` (`parseModelInfoPrices`, per-*token*).

All three parse the same LiteLLM `GET /model/info` response shape, with two of the three copies
explicitly and deliberately not importing from `mgm/` (documented in both `providers-status.md` and the
`outfitter-spend.ts` header comment, for legitimate reasons — `packages/api` and `packages/agentd`
shouldn't depend on `mgm/`'s layout). This is a reasonable, disclosed tradeoff, not an oversight, but
it's worth flagging as accumulating duplication risk: `providers-status.ts`'s copy converts to
per-million (`perM = v => v * 1e6`) while `outfitter-spend.ts`'s copy keeps per-token — a future change
to LiteLLM's response shape (e.g. a renamed field) would need to be caught and fixed in three places
independently, and nothing enforces that all three stay in sync (no shared fixture/golden test across
the three). Consider a small shared `@outfitter/litellm-shapes` package (or at minimum a comment in each
copy pointing at the other two) if a fourth consumer shows up.

### N6. Cloud Run image smoke test in CI doesn't exercise the web bundle it now ships

**File:** `.github/workflows/outfitter-ci.yml` (`images` job).

The `images` job builds `outfitter/packages/api/Dockerfile` (which now also builds and copies
`packages/web/dist`, per this PR) and boots the resulting image, but only checks `POST
/api/hooks/ngrok` (401) and `GET /api/sessions` (404, role `link`, so this doesn't even reach the "web"
role code path that serves the SPA). It never hits `GET /` or `GET /sessions/x` to confirm the SPA
fallback added in this PR (`routes/static.ts`) actually serves `index.html` from the built image, only
that the Vite build didn't fail. `web-ui.md` reports this was checked manually against a locally built
image; CI itself doesn't re-verify it, so a future regression in `static.ts`'s `existsSync`/path
resolution wouldn't be caught until a real deploy. Low severity since the manual verification is
documented and the path logic is simple and unchanged since (`WEB_DIST` resolution was verified sound
by tracing `import.meta.url` against the Dockerfile's actual `COPY --from=builder` destination —
`/app/packages/web/dist`, matching `../../../web/dist` from `packages/api/src/routes/static.ts`).

---

## What was checked and found sound

- **Provider status Memory vs Mongo parity**: `ProvidersCollection` (`findById`/`list`/`upsert`) is
  implemented identically in shape by `MemoryProviders` (`store/memory.ts:206-221`) and `MongoProviders`
  (`store/mongo.ts:258-280`); `upsert` semantics (whole-record replace) match in both.
- **Spend concurrency**: `agentlink.ts`'s `"spend"` handler does a read-modify-write across
  `store.runs`/`store.sessions` with no explicit locking, but up-frames for one WebSocket connection are
  processed strictly sequentially (`agentlink.ts:316-336`, each `handleUpFrame` call is awaited before
  the next message is dispatched — a deliberate fix per its own comment, "up-frames used to be handed to
  handleUpFrame per-message with no await"). No lost-update race across concurrent spend frames for the
  same run.
- **`keySpendStart`/baseline math**: `cost = max(0, frame.keySpend - keySpendStart)` and the
  session-cost delta application (`agentlink.ts:478-487`) are correct given a monotonically increasing
  `keySpend`; `SpendTailer`/`validateSpendLine` correctly reject a non-boolean `baseline` and the
  `costEstimate` accumulator correctly skips a baseline line (`usage` is always absent on it, confirmed
  in `run.ts:472-490` and `outfitter-spend.ts`'s `append({ baseline: true, keySpend })` call, which omits
  `usage`).
- **Auto-router per-token pricing** (`computeResolvedCost`, `isZeroPrice`, `parseModelInfoPrices` in
  `outfitter-spend.ts`): units are consistently per-token throughout that file (never mixed with
  per-million), and `buildSpendLogLine`'s fallback to the delta-based estimate when `prices` is empty or
  the resolved model is also unpriced is correct and matches its own tests.
- **SSE wire format**: `SseHub.formatFrame` (`sse.ts:14-16`) emits `event: <type>\ndata:
  <JSON.stringify(data)>\n\n`; every `ctx.sse.publish(channel, {type, data})` call's `data` shape lines
  up with what `useSessionStream`/`useProviders` parse on the client (`status.state`, raw `PiEntry` for
  `entry`, raw event object for `event`, `{estimate}` subset read from the full spend frame for `spend`).
  Verified route-by-route against `docs/protocol.md`'s SSE event table.
- **SPA fallback vs API/agent routes**: `static.ts`'s `setNotFoundHandler` correctly excludes
  `/api/*`, `/agent/*`, and non-GET methods before falling through to `index.html`; registered on the
  root Fastify instance (not a scoped sub-plugin), so it applies globally as intended. `hooks.ts`'s
  scoped `addContentTypeParser` override is correctly isolated to its own `register()` context and
  doesn't leak into the rest of the app's JSON parsing.
- **`RUN_TOKEN`/hello handshake, close codes, two-origin role split**: matches `docs/protocol.md`
  exactly where checked (`agentlink.ts`'s `waitForHello`/token-hash comparison, `config.ts`'s role
  gating of provider/down-queue pollers).
- **Docker build path for `packages/web/dist`**: traced `WORKDIR`/`COPY --from=builder` in
  `packages/api/Dockerfile` against `routes/static.ts`'s `fileURLToPath(new URL("../../../web/dist",
  import.meta.url))` — resolves to the same `/app/packages/web/dist` the builder stage produces.
- **Teleport auth header selection, `--force` plumbing (`bin/mgm`, `cli.ts`, `index.ts`)**: bash
  argv splitting in `bin/mgm` correctly strips `--force` before re-exec'ing into `pi`, and both the
  CLI (`cli.ts`) and interactive (`/teleport pull <id> --force`) paths thread it through to
  `store.get(id, { force })` correctly. `GitStore` ignoring `opts` (no active-run concept) is a
  deliberate, documented no-op, not an oversight.
- **`PUT /api/sessions/:id/import`**: idempotent session creation (inserts a fresh row only if
  `findById` misses), `insertIfNew`'s dedup-by-`entry.id` prevents double-import on retry, `409` when a
  run is active is correctly checked before any writes.
- **No dead/duplicated logic found** beyond N5 above (which is disclosed, intentional duplication, not
  copy-paste drift) — `entry-view.ts`'s `entryToViews` is a clean, non-duplicated mapping; no leftover
  commented-out code or obvious copy-paste blocks were found across the diff's new files.

