# Code-review fixes: packages/agentd

Scope: `packages/agentd` only (per instructions -- `packages/api` and `mgm/` were being edited by
other agents concurrently and were left untouched). All changes verified with `npm test` in
`packages/agentd` (52/52 passing) and `npm test` from `outfitter/` (agentd 52, api 42,
provider-local 2 -- all passing, nothing else broken).

## 1. `run.ts:161` -- prompts dropped before pi is up

**Problem:** `prompt`/`steer`/`follow_up`/`abort`/`ui_response`/`rpc` down-messages that arrived
while `this.pi` was still `undefined` (during `cloning`/`restoring`/`starting`) were sent via
`this.pi?.send(...)`, which is a silent no-op on `undefined` -- the message was simply lost.

**Fix:** `src/run.ts`

- Added `PiTargetedDownMessage` (a union of the six message types) and `isPiTargetedDownMessage()`.
- `handleDown()` now queues these messages into a new `pendingPiMessages` array when `this.pi` is
  still unset, instead of dispatching them.
- Extracted the actual "write to pi's stdin" logic into a new `dispatchToPi()` method (shared by
  `handleDown` once pi is up, and by the flush below).
- In `begin()`, immediately after `this.pi = spawnFn(...)` and wiring `onEvent`/`onStderr`/`onExit`,
  the queue is drained in order via `dispatchToPi()`, before the tailer starts and before
  `enterIdle()`/`startHeartbeat()`.

**Tests:** `test/run.test.ts`

- "a prompt sent before pi is spawned ... is queued and delivered to pi once it starts" -- delivers
  `run.spec` and a `prompt` in the same tick (before `begin()`'s first `await` resolves, so `pi` is
  provably still `undefined`), then asserts the fake pi still receives it and produces
  `agent_start`/`agent_settled` and the session entry.
- "multiple down-messages queued before pi is up are flushed to pi in the order they arrived" --
  uses a hand-controlled `PiProcess` double to assert exact queue-flush ordering
  (`prompt`, `steer`, `abort`).

## 2. `main.ts:58` / `link.ts` -- identity token never refreshed

**Problem:** `Link` took a static `headers: Record<string,string>` object built once at startup
from a single `getIdToken()` call. GCE/Cloud Run identity tokens are short-lived; a long-running
agentd process reconnecting hours into a run would keep presenting the original (expired) token on
every reconnect and fail forever.

**Fix:**

- `src/link.ts`: `LinkOptions.headers` is now `() => Promise<Record<string,string>>`. `open()` calls
  it fresh on every (re)connect before constructing the WebSocket (`openWithHeaders()`); a rejected
  provider is treated like a failed connection attempt and retried with the existing backoff.
- `src/main.ts`: passes `headers: async () => ({ Authorization: \`Bearer ${await
  getIdToken(apiOrigin, devToken)}\` })` instead of a token fetched once. `getIdToken`'s existing dev
  -token fallback path is unchanged and still exercised on every call.
- Added proactive reconnect ahead of Cloud Run's documented 60-minute connection cap (`EPIC.md`
  E2.4: "Cloud Run 60 min cap: agentd reconnects at 55 min"): `maxConnectionAgeMs` (default 55 min)
  arms a timer on every successful open; on expiry it resets the backoff `attempt` counter and closes
  the socket, letting the existing `close` → `scheduleReconnect()` path reopen it (fresh headers
  included). The timer is built via injectable `setTimeoutFn`/`clearTimeoutFn` (for tests) and is
  `.unref()`'d so it never by itself keeps the process alive (the live socket / heartbeat / pi child
  already do that while a run is active) -- this also matters for tests, which would otherwise hang
  for up to `maxConnectionAgeMs` waiting on that handle.

**Tests:** `test/link.test.ts` (rewritten for the async `headers()` API; every test now cleans up
via `t.after(() => link.close())` to avoid cross-test timer leakage through the shared
`FakeWebSocket.instances` static)

- "the headers provider is invoked fresh on every (re)connect, not cached from the first connect"
- "a headers-provider failure is treated like a failed connection attempt and retried with backoff"
- "proactively reconnects once a connection reaches maxConnectionAgeMs (Cloud Run's 60 min cap)"
- "the connection-age timer does not fire again after close() (no leaked reconnect)"

## 3. `run.ts:385` -- `checkpoint()` restores stale pre-checkpoint state

**Problem:** `checkpoint()` recorded `previous = this.state` before checkpointing and blindly
restored it afterward. If `agent_settled` (or `agent_start`) arrived from pi *while* the checkpoint
was in flight, `handlePiEvent`'s existing `state !== "checkpointing"` guard correctly avoided
flipping state mid-checkpoint, but the event was then **lost**: `checkpoint()` would restore
`"running"` (or whatever preceded it) even though pi had since gone idle -- and critically, never
re-armed the idle timer for that missed idle transition.

**Fix:** `src/run.ts`

- Added `stateAfterCheckpoint: RunState | undefined`. `handlePiEvent`'s `agent_start`/`agent_settled`
  branches now record into it (`"running"` / `"idle"`) when `this.state === "checkpointing"`, instead
  of silently doing nothing.
- `checkpoint()` resets `stateAfterCheckpoint` before starting, and afterward resolves to
  `stateAfterCheckpoint ?? previous`. If the resolved state is `"idle"` it calls `enterIdle()` (not a
  bare `setState`), so the idle timer is actually (re-)armed -- this also fixes a related latent bug
  where a checkpoint taken while already idle never re-armed the idle timer at all.

**Test:** `test/run.test.ts` -- "an agent_settled arriving mid-checkpoint resolves to idle afterward
(not the stale pre-checkpoint state), and the idle timer fires". Uses a hand-controlled `PiProcess`
double plus a gated `gitOps.commitAll()` (blocks on a promise the test controls) to deterministically
interleave: drive to `"running"` → start an explicit checkpoint → emit `agent_settled` while still
`"checkpointing"` → release the gate → assert the resolved state is `"idle"` → assert idle-stop
subsequently fires (`bye` with reason `"idle"`, exit 0).

*(Debugging note, not a product bug: the first attempt at this test used `idleStopSeconds: 0`
throughout, which raced the test's own drive-into-`"running"` step against the real idle-stop timer
armed by the initial `enterIdle()` a few lines earlier. Fixed by using a small non-zero
`idleStopSeconds` (0.2s) instead, which still exercises "idle-stop fires" but doesn't race the setup.)*

## 4. `git.ts:88` -- GitHub token persisted in `.git/config`

**Problem:** `withAccessTokenUrl()` embedded `x-access-token:<token>@github.com` directly into the
clone URL, which `git clone`/`git push -u` then write verbatim into `.git/config`
(`remote.origin.url`), leaving the token in plaintext on disk for the life of the workspace.

**Fix:** `src/git.ts` -- replaced `withAccessTokenUrl` with `authHeaderArgs(remoteUrl, token)`,
which returns a `["-c", "http.extraheader=AUTHORIZATION: basic <base64>"]` pair: a **per-invocation**
git config override that is never written anywhere. `clone`, the `createBranch: false` fetch step,
and `push` all pass this ahead of the subcommand and use the *plain* URL/`origin` remote (nothing
token-bearing ever appears in argv persisted by git). `file://` URLs (local smokes) get `[]` and are
unaffected.

**Verified GitHub's actual auth requirement via web search** (the review's suggestion of a literal
`Bearer` scheme turned out to be wrong for git's smart-HTTP endpoint, only for GitHub's REST API):
GitHub's git-over-HTTPS endpoint **rejects** `AUTHORIZATION: bearer <token>` -- confirmed by a
community report of exactly that failure
([github.com/mitkox/ecdf/issues/1](https://github.com/mitkox/ecdf/issues/1)) -- and instead expects
**Basic** auth with the token as the password: `AUTHORIZATION: basic base64(x-access-token:<token>)`,
per GitHub's own docs on authenticating Git operations with a personal access token
(docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
`authHeaderArgs` builds that Basic form; this is documented in `git.ts`'s module comment and on
`authHeaderArgs` itself.

**Defense in depth:** a new `redactToken()` helper strips the raw token out of any thrown error
message built from git's stdout/stderr (in case git or something in front of it ever echoes the
invocation back), on top of the pre-existing `redactUrl()` used for the clone URL in log/error text.

**Tests:** new `test/git.test.ts` (12 tests) covers: `authHeaderArgs`'s Basic-not-Bearer shape and
its no-header cases (no token / non-github host / `file://` / unparseable URL); that `clone`
(both branch-creation and existing-branch/fetch paths) and `push` pass the header via `-c` and use
the plain URL/`origin`, never a token-bearing URL; that thrown errors from a failing clone/push never
contain the token, even when the stubbed git stderr deliberately echoes it back; and that `file://`
clones are unaffected (no auth args, no local-smoke regression).

## 5. `pi.ts:114` -- stdin write after pi exit crashes agentd

**Problem:** `send()` unconditionally called `child.stdin.write(...)`. A write after pi has already
exited throws/emits `EPIPE`; the streams also had no `'error'` handlers, so per Node's
`EventEmitter` contract an EPIPE on `stdin`/`stdout`/`stderr` would be an **unhandled 'error' event
and crash the whole agentd process**, not just the one run.

**Fix:** `src/pi.ts`

- `child.stdin`/`stdout`/`stderr` each get an `'error'` handler that logs (via the new `onLog`
  option, see below) and swallows the error instead of leaving it unhandled.
- Added an `exited` flag set in the `'exit'` handler; `send()` becomes a no-op-with-a-log-line once
  it's set. A `child.stdin.write()` is also now wrapped in `try/catch` as a second line of defense
  for the narrow window before the `'exit'` event fires.
- Added `PiProcessOptions.onLog?: (line: string) => void` (defaults to a no-op) so these swallowed
  errors are observable; `run.ts`'s `begin()` now passes its own `this.onLog` through when spawning
  pi.

**Test:** `test/pi.test.ts` -- "send() after the child has exited does not throw, and is logged
instead": spawns a real (trivial, immediately-exiting) child process, waits for the real `exit`
event, then calls `send()` and asserts it doesn't throw and that the log line was emitted.

## 6. `run.ts:242` -- snapshot fetch ignores non-2xx

**Problem:** `await fetchFn(spec.snapshot.url)` followed straight to `res.text()` with no `res.ok`
check -- a 404/500 (e.g. an expired signed URL, or an error page from a CDN/proxy) would be silently
imported as the session's JSONL content.

**Fix:** `src/run.ts` -- checks `res.ok` and throws `` `snapshot fetch failed: ${res.status}
${res.statusText} (${spec.snapshot.url})` `` otherwise. This propagates out of `begin()` into the
existing `.catch((err) => this.fail(err))` path, which sends `bye("error", message)` and exits 1 --
so the run fails clearly instead of continuing with garbage session content.

**Test:** `test/run.test.ts` -- "a non-2xx snapshot fetch fails the run with a clear,
status-including message" -- injects a `fetchFn` stub returning a 404, asserts the `bye` frame has
`reason: "error"` and a message containing both the status code and status text, exit code 1, and
that `"idle"` is never reached.

## Also from the review (not separately numbered)

### A `/command` prompt or a prompt pi rejects never emits `agent_start` / `markActivity()` disarms the idle timer with nothing to re-arm it

Both are really the same bug: `markActivity()` unconditionally cleared the idle timer
(`this.clearIdleTimer()`) with no corresponding re-arm for the case where the triggering
activity never produces `agent_start`/`agent_settled` (a `/command` pi handles locally without a
turn, or a prompt pi rejects outright). Once that happened while idle, the idle timer stayed
disarmed for the rest of the run -- idle-stop would never fire again.

**Fix:** `src/run.ts` -- `markActivity()` now branches on `this.state`: if currently `"idle"`, it
resets `idleSince` and re-arms the idle timer (the same bookkeeping `enterIdle()` does) instead of
just clearing it; otherwise it clears it as before (a real turn starting is expected to be followed
by `agent_start`, which re-arms things properly once the turn settles).

**Test:** `test/run.test.ts` -- "activity while idle that never produces agent_start/agent_settled
... re-arms the idle timer instead of leaving it disarmed forever". Uses a hand-controlled
`PiProcess` double so no `agent_start`/`agent_settled` ever fires for the test's prompt, and asserts
idle-stop still eventually fires (`bye` with reason `"idle"`, exit 0) -- which fails without the fix
(the timer would stay disarmed and the test would time out).

## Verification

- `cd packages/agentd && npm test` -- **52/52 passing** (10 new: 6 in `link.test.ts`, 4 in
  `run.test.ts`; plus 12 new in `git.test.ts`; plus 1 new in `pi.test.ts`).
- `cd outfitter && npm test` (all workspaces) -- **agentd 52/52, api 42/42, provider-local 2/2**,
  nothing else broken by these changes.
- `npx tsc -p packages/agentd/tsconfig.json --noEmit` -- clean.
- No debug/temp code left behind (checked with `grep` for `console.`/`TODO`/`HACK`/`debugger` in
  `src/`; the two `console.error` hits are the pre-existing, intentional stderr log sink in
  `main.ts`).

## Files touched

- `packages/agentd/src/run.ts`
- `packages/agentd/src/link.ts`
- `packages/agentd/src/main.ts`
- `packages/agentd/src/git.ts`
- `packages/agentd/src/pi.ts`
- `packages/agentd/test/run.test.ts`
- `packages/agentd/test/link.test.ts`
- `packages/agentd/test/pi.test.ts`
- `packages/agentd/test/git.test.ts` (new)

Nothing outside `packages/agentd` was touched, per instructions.
