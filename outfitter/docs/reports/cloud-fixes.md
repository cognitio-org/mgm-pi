# Cloud reliability and UX fixes (2026-09-22)

A batch of ten bugs found in the first real cloud use of Outfitter, fixed one commit per item.
Each item below: cause, fix, test, anything left open. `npm test` and `npm run build` pass across
`packages/agentd`, `packages/api`, `packages/web` after all ten.

## 1. Five-minute WebSocket/SSE drops

**Cause**: `deploy/service.sh` passed `--timeout=20m` only on the one-off bootstrap deploy (used
once, to learn a brand-new service's URL), never on the real deploy that actually serves traffic.
Every real deployment silently reverted to Cloud Run's 300s default, cutting both agentd's
WebSocket (`link` role) and the browser's SSE stream (`web` role, `GET /api/sessions/:id/stream`)
every 5 minutes.

**Fix**: `service.sh` now passes an explicit `--timeout` (default 3600s, `DEPLOY_TIMEOUT`
override) on the real deploy for **both** roles. `link` needs it comfortably past agentd's
55-minute proactive reconnect (`packages/agentd/src/link.ts`); `web` gets the same value rather
than "300s is fine for REST" because the SSE stream is a long-held connection on that same role --
a 5-minute cut would still mean periodic reconnect churn and gaps in live updates.

**Test**: none (shell change) -- `bash -n deploy/service.sh` only, per the story's own instruction.

**Left open**: nothing.

## 2. Session page not updating live in the split web/link deployment

**Cause**: `AgentLink.publish` (`packages/api/src/agentlink.ts`) writes into an in-process
`SseHub`. In a split deployment, agentd's WebSocket lives on the `link` role's process while
browsers subscribe to SSE on the `web` role's process -- two different Cloud Run services/
containers with no shared memory. A publish on one process's hub was never seen by subscribers on
the other, so the page kept showing STOPPED with no new entries after a run went
provisioning -> idle -> running and answered.

**Fix**: `SsePoller` (new, `packages/api/src/sse.ts`) polls the shared Atlas/Mongo store every
1.5s for new entries, run-state changes, cost estimates, and pending UI requests, and republishes
them through the local `SseHub` -- so any process's subscribers stay live regardless of which
role/process actually wrote the data. Polling was chosen over a Mongo change stream: it needs no
new dependency, degrades to "up to 1.5s stale" instead of "the watcher silently stops," and is
cheap at this fleet's scale (a handful of open session tabs). Live intra-turn `event` frames
(token-by-token streaming) are not recoverable this way since they're explicitly not persisted per
protocol.md -- an accepted tradeoff; the reported bug was about status/entries going stale, not
about losing streaming granularity. Wired into the existing stream route so role "all" keeps
working unchanged (the poller and AgentLink's own push both fire there; the browser dedupes).

**Test**: `packages/api/test/sse-poller.test.ts` -- two independent `SseHub` instances sharing one
`MemoryStore` (standing in for the two roles' processes), writes made the way agentlink.ts writes
them bypassing the "web" hub entirely, asserting the "web" hub's subscriber still sees the entry
and status-change once polled; a stopped-transition-published-once test; a stop-watching-on-
disconnect test.

**Left open**: nothing structural. A future optimization could target the poll interval per
number of open sessions if it ever matters at scale.

## 3. READY. shown when nothing is running

**Cause**: `deriveTransportStatusLine` took a plain `active` boolean (`!RUNNING_STATES.has(runState)`),
which is true whenever no run is *active* -- including a cleanly stopped run and a failed one, so
both read exactly like an idle run waiting for input. Separately, the stream's "no active run"
fallback hardcoded `state: "stopped"`, losing the distinction from `"failed"` entirely.

**Fix**: Added `RunsCollection.findLatestForSession` (memory + Mongo) to recover the real terminal
state (and its `reason`) once there's no *active* run. `deriveTransportStatusLine` now takes the
run's actual state (+ optional reason): `"idle"` -> READY., a live state -> nothing (the `Working`
indicator covers it), `"failed"` -> LOAD ERROR with the reason, `"stopped"` (or no run at all) ->
"stopped · press Play". The stream route and `SsePoller` both use `findLatestForSession` for this
fallback and carry `reason`/`detail` on the status frame.

**Test**: `packages/web/test/retro-errors.test.ts` rewritten for the new signature (idle/live-
state/failed/stopped/no-run cases, and the flashed-outcome precedence rule); `packages/api/test/
sse-poller.test.ts`'s stopped-once test doubles as store-level coverage.

**Left open**: nothing.

## 4. New Floppy Start button staying disabled

**Cause**: `NewSessionDialog` picked `guruId` once from `useState`'s initializer. Opened before the
`gurus` prop had loaded (`gurus=[]`), `guruId` stayed `""` forever -- once `gurus` arrived, the
`<select>` visually fell back to its first `<option>` (no matching value), but React's own state
(and `disabled={!guruId}`) never caught up.

**Fix**: Extracted the selection logic into `resolveGuruId` (pure, exported, testable) and re-run it
in a `useEffect` keyed on `gurus`/`initialGuruId`, so `guruId` catches up once the list loads
without clobbering a deliberate user pick already made.

**Test**: `packages/web/test/new-session-dialog.test.tsx` -- unit tests for `resolveGuruId`'s cases,
plus a real-DOM mount test (gurus=[] -> gurus=[one guru]) verifying the `<select>` and the Start
button both catch up.

**Left open**: nothing.

## 5. Thinking level mismatch and "unrecognized entry: thinking_level_change"

**(a) Cause**: `renderModelArg` (`packages/agentd/src/guru.ts`) special-cased `thinking === "off"`
as "append nothing" to the `--model` flag. pi 0.87's `--model <pattern>` accepts an optional
`:<thinking>` suffix whose valid values are `off, minimal, low, medium, high, xhigh, max` --
`off` is a real, explicit level in that list, not the absence of one. Omitting it entirely left pi
with no explicit level at all, so it fell back to its own startup default (`medium` in this
image's `.pi/settings.json`) -- exactly the "header says thinking medium" symptom.

**Fix**: `off` now renders `:off` like every other level; only a genuinely unset `guru.thinking`
renders nothing at all.

**(b) Cause**: `entry-view.ts` had a case for pi's `model_change` entry but none for
`thinking_level_change` (`docs/session-format.md`: `{type:"thinking_level_change",
thinkingLevel, ...}`), so it fell through to `"unknown"` and rendered as "unrecognized entry:
thinking_level_change" -- a normal, expected entry, not an error.

**Fix**: Added a `thinking-level-change` view kind and rendering ("Thinking level changed to
`<level>`"), alongside the existing model-change handling.

**Test**: `packages/agentd/test/guru.test.ts` (renderModelArg/renderGuru with `thinking: "off"`);
`packages/web/test/entry-view.test.ts` (thinking_level_change maps instead of falling to unknown).

**Left open**: nothing.

## 6. Display-only UI events stored as pending questions

**Cause**: `agentlink.ts` stored every `extension_ui_request` event as `Run.pendingUiRequest`. pi's
`rpc.md` splits that frame into dialog methods (`select`, `confirm`, `input`, `editor` -- pi blocks
for an `extension_ui_response`) and fire-and-forget display methods (`setStatus`, `setWidget`,
`notify`, `setTitle`, `set_editor_text` -- no response expected). Only the former are a real
question the run is waiting on; storing the rest left the session's questions UI showing a stale
"pending" notify/status update nothing was ever going to answer.

**Fix**: Added `INTERACTIVE_UI_METHODS` (the four dialog methods) and gated the
`pendingUiRequest` write on `event.method` being one of them.

**Test**: `packages/api/test/agentlink.test.ts` -- sends all five display-only methods and asserts
none land in `pendingUiRequest`, then an interactive one and asserts it does.

**Left open**: nothing.

## 7. Silent pi refusals

**Cause**: `run.ts`'s `handlePiEvent` only ever inspected pi's RPC `response` frames for the mail
path (`mailInFlight`); every other unsuccessful response (a rejected `prompt`/`steer`/`follow_up`)
was forwarded as a raw, unpersisted `event` frame and otherwise ignored -- no log, no signal to the
session at all.

**Fix**: `handlePiEvent` now logs every unsuccessful non-mail response at WARN (`command` + `error`
only -- this frame never carries the prompt text at all) and sends a `status` frame carrying the
notice in `detail` (protocol.md's existing optional field on `status`) without treating it as a
state transition. `agentlink.ts` persists a status frame's `detail` on `Run.statusDetail`, so it
survives a reload or a split-role deployment, without letting an ordinary state-only frame (the
vast majority) immediately clear it. `SsePoller` republishes a `statusDetail` change too. The web
UI shows it as a small note under the session header.

**Test**: `packages/agentd/test/run.test.ts` (a non-mail rejected response is logged with command +
error, and doesn't collide with the mail path's own differently-worded log line);
`packages/api/test/agentlink.test.ts` (a status frame's `detail` persists on the run and survives a
later state-only frame).

**Left open**: the web note is a plain, non-dismissable line under the header -- fine for now, but
a toast/history of notices would read better if this fires often in practice.

## 8. Duplicate model_change/thinking_level_change entries on each restore

**Cause**: Entry ingestion was already idempotent by entry id (the API's unique
`{sessionId, "entry.id"}` Mongo index / `MemoryStore`'s seen-id set), so re-sending a
previously-seen entry (which restoring does -- the tailer re-reads the whole forked session file
from offset 0) was already correctly a no-op. The actual duplicates were not resends at all: every
restore spawns a brand-new `pi --mode rpc` process, and agentd always passed `--model` (with an
optional `:thinking` suffix) unconditionally. pi treats an explicit `--model`/`--thinking` flag as
the user setting that value for *this* process and logs a fresh `model_change`/
`thinking_level_change` entry -- with a genuinely new id -- even when it exactly matches what the
restored session already ended with. No amount of "idempotent by id" ingestion can catch a
genuinely distinct id.

**Fix**: `session.ts`'s `lastKnownModelState` (pure) scans the restored snapshot's own last
`model_change`/`thinking_level_change` entries. `run.ts`'s `begin()` now skips passing `--model` to
pi (`guru.ts`'s new `skipModelArg`) when they already match the guru's resolved model/thinking, so
pi has no reason to reassert them. A genuine change (laptop-preflight fallback, an edited Tape, a
brand-new session with no prior entries) still passes `--model` exactly as before.

**Test**: `packages/agentd/test/session.test.ts` (`lastKnownModelState` cases);
`packages/agentd/test/guru.test.ts` (`skipModelArg` omits `--model`); `packages/agentd/test/
run.test.ts` (an unchanged restore omits `--model`; a genuinely changed one still passes it).

**Left open**: the comparison normalizes an unset `guru.thinking` and a never-recorded
`thinking_level_change` both to `"off"` for matching purposes -- a defensible simplification, but
means a session that has *never* had an explicit thinking level set won't get one asserted on a
model-matching restore even if the guru's own default isn't actually `"off"`. In practice this
only matters the very first time a guru's thinking is set at all, at which point `--model` is
still passed (the model itself won't have matched yet either).

## 9. Deploy version skew guard

**Fix**:
- `deploy/env.sh`'s `check_deploy_skew`: `service.sh` and `agent-job.sh` label what they deploy
  `build-commit=<git short sha>` and, before deploying, compare that against the *other* two
  components' currently-deployed `build-commit` (`gcloud run services|jobs describe
  --format='value(metadata.labels.build-commit)'`), refusing (or, with `ALLOW_SKEW=1`, warning) on
  a mismatch and printing which component(s) are stale.
- `deploy/deploy-all.sh` (new): deploys link, then web, then the Job, from one commit.
- agentd announces its wire protocol version in `hello`
  (`packages/agentd/src/protocol.ts`'s `WIRE_PROTOCOL_VERSION`); `agentlink.ts` refuses (WS close
  `4409`, a reason string naming both versions) a sandbox whose version is older than the API's own
  copy of the constant (`API_PROTOCOL_VERSION`) -- including a hello with no `protocolVersion` at
  all (an agentd build that predates the field, treated as version 0). This is a second, independent
  guard: it catches skew even if the deploy-time label check was bypassed (`ALLOW_SKEW=1`) or a
  sandbox was already running before a skewed deploy landed.
- Documented in `docs/protocol.md` (close-codes table, `hello` row) and `deploy/README.md`.

**Test**: `packages/agentd/test/link.test.ts` (hello carries a numeric `protocolVersion`);
`packages/api/test/agentlink.test.ts` (an old/missing protocol version closes 4409 with a clear
reason; a matching one connects normally). The deploy-script half has no test beyond
`bash -n <script>` (all six deploy scripts checked), per the story's precedent for shell changes.

**Left open**: `check_deploy_skew` only looks at Cloud Run's `build-commit` label, which is only
as trustworthy as every deploy going through these scripts -- a manual `gcloud run deploy` (or an
old revision manually rolled back to) bypasses it. `WIRE_PROTOCOL_VERSION`/`API_PROTOCOL_VERSION`
must be bumped together by hand when a wire-incompatible change lands; nothing enforces that today
beyond the doc comments pointing at each other.

## 10. Dead mail on skew

**Cause**: `MailService.wakeForMail` charged *every* deliverable mail of a session an attempt on
*every* wake it started, regardless of whether the resulting run ever connected at all. A run that
failed before a valid `hello` -- a clone failure, a missing secret, a Cloud Run scheduling failure,
and (before item 9 existed) a version-skewed agentd that connected but couldn't read mail -- still
burned the full attempt on a delivery that was never actually attempted. Because the charge applies
to *every* deliverable mail of the session at once, a session with several queued messages could
lose all of them together after just 6 doomed wakes -- matching the reported "seven messages
marked dead after 6 attempts."

**Fix**: The charge moved out of `wakeForMail` (wake time) and into `agentlink.ts`'s
`handleConnection`, firing once per run, the moment that run's `hello` actually passes the token
and protocol-version checks (new `Run.protocolAcked`) -- i.e. once we know this run can genuinely
speak the protocol, not merely that a wake was started for it. It only fires for a run
`RunManager.wake` created specifically to delivery mail (new `Run.mailWakePending`, set by
`wakeForMail`'s `{ mailDriven: true }`), so a run started for an unrelated reason (a browser
Start/Wake button) that happens to also have deliverable mail queued isn't double-charged against
`claimNext`'s own per-delivery attempt. The existing "mail delivered but never acked returns to
`queued` on `bye`" behavior (`MailCollection.releaseRun`) was already correct and is unchanged.

**Test**: `packages/api/test/mail.test.ts` -- a session whose runs never validate a hello (marked
failed directly, as the stale-run reconciler would) is retried indefinitely and its mail stays
`queued` with `attempts: 0`; a session whose runs *do* validate the protocol but keep dying before
acking still exhausts its 6 attempts and goes `dead`, over a real WebSocket handshake per cycle.

**Left open**: a session whose runs never validate a hello is now retried *indefinitely* (bounded
only by one-active-run-per-session and whatever the sandbox provider itself does about repeatedly
failing executions) -- intentional per the story ("a bad deploy shouldn't throw the message away"),
but worth a dashboard/alert eventually so an operator notices a session stuck in that state rather
than relying on someone reading logs.
