# Deploy gaps

Findings from real (non-local) deploys of Outfitter, and the fixes that came out of them. Append a
new `##` section per gap; don't rewrite earlier ones.

## agentd: reconnect storm on a server-closed link (first real Cloud Run execution)

**Observed:** in the first real Cloud Run execution of `agentd`, the link service accepted the
token, completed the WebSocket upgrade (101), then immediately closed the socket with the
application close code `4404` ("run not found"). `agentd` treated this exactly like a dropped TCP
connection: it reconnected with `attempt` reset to 0 on every `open`, so it hammered the link
service roughly twice a second, indefinitely. The execution had to be cancelled by hand; a
misconfigured or already-finished run would otherwise have retried right up against the job's own
much longer timeout.

**Root causes (`packages/agentd/src/link.ts`):**
1. No WebSocket close code was ever treated as terminal — `ws.on("close", ...)` always called
   `scheduleReconnect()`, regardless of what code the server sent.
2. `attempt` (the backoff exponent) was reset to `0` unconditionally in the `open` handler. A
   server that accepts the upgrade and then closes right away looked exactly like a successful,
   stable connection, so every reconnect used the base backoff delay instead of growing.

**Fix:**
1. Added `TERMINAL_CLOSE_CODES` (`4400` bad request, `4401` unauthorized, `4404` run/session/guru
   not found, `4409` run in a terminal state). `Link`'s `close` handler now checks the code: for a
   terminal code it stops reconnecting, clears its timers, and fires the new
   `onTerminal(code, reason)` handler instead of scheduling a reconnect. `1011` (server internal
   error) and any other code still reconnect as before. `main.ts` wires `onTerminal` to
   `process.exit(0)` for `4404`/`4409` (nothing to do — the run is already over server-side) and
   `process.exit(1)` for `4400`/`4401` (agentd misconfiguration), logging the code and reason first.
2. `attempt` is no longer reset on `open`. It now resets only once a connection has stayed open for
   `stableAfterMs` (default 10s, via a new per-connection timer armed on `open` and cleared on
   `close`), or immediately on the first `ack`/`run.spec` received on that connection, whichever
   comes first. A flapping server (accept, then close quickly, repeatedly) is now retried at the
   backoff cap (30s by default) instead of every base-delay tick.
3. Added `maxUnspecMs` (default 10 minutes): a timer armed on the first `connect()` and cleared the
   moment `run.spec` ever arrives. If it fires first, `Link` calls the new `onUnspecTimeout()`
   handler once; `main.ts` wires it to a clear log line plus `process.exit(1)`, so a misconfigured
   job gives up loudly well before it would otherwise run quietly to its own (much longer, e.g. 24h)
   job timeout.

**Tests:** `packages/agentd/test/link.test.ts` — one test per terminal code (4400/4401/4404/4409)
asserting `onTerminal` fires and no reconnect is attempted; a test each for `1011` and an
unrecognized code confirming they still reconnect; a test that repeated immediate opens (no
stability, no ack) keep growing backoff up to the cap; a test that staying open `stableAfterMs`
resets backoff to the base delay; a test that an `ack` resets backoff immediately without waiting
out the stability window; and two `maxUnspecMs` tests (fires once if `run.spec` never arrives,
never fires once it has). `npm test` in `packages/agentd`: 63/63 passing.

**Files touched:** `packages/agentd/src/link.ts`, `packages/agentd/src/main.ts`,
`packages/agentd/test/link.test.ts`.

## api: cross-process down-messages, secret-not-found handling, and IAP audience (first real deploy)

Three separate gaps found deploying `packages/api` for real (two Cloud Run services + Secret
Manager + IAP), none of which showed up against `MemoryStore`/`MemorySecretsBroker` in dev.

### 1. Down-messages queued on `outfitter-api` never reached a socket held by `outfitter-link`

**Observed:** `outfitter-api` (web role) and `outfitter-link` (link role) are separate Cloud Run
services sharing one Atlas store, but `AgentLink` keeps live WebSocket sockets in an in-process
`Map`. A message posted through the web role's REST API (e.g. `POST /api/sessions/:id/messages`)
for a run whose socket happened to be held by a *different* `outfitter-link` instance (or replica)
only ever reached `store.runs.enqueueDownMessage` — it sat in `run.pending` until that run's next
`hello` (reconnect) or its first `running`/`idle` `status` frame, which could be a long time (or
never, for an already-running session) after the browser sent it.

**Fix (`packages/api/src/agentlink.ts`):** added `AgentLink.startDownQueuePoller` /
`pollDownQueuesOnce`: every `config.downQueuePollMs` (env `DOWN_QUEUE_POLL_MS`, default 1500), for
each run whose socket lives in *this* process and whose state is `running`/`idle`, drains
`store.runs.drainDownMessages(runId)` and sends the result in order over that socket.
`drainDownMessages` was already an atomic pop on both stores (`MongoStore`: `findOneAndUpdate`
setting `pending: []` and returning the prior document; `MemoryStore`: a single synchronous
swap — JS's single-threaded execution makes that already atomic), so two processes racing to poll
the same run's queue can't double-deliver; whichever poll (or `hello`/`status` drain) runs first
gets the messages, the other finds an empty queue. `server.ts` only starts the poller for role
`link`/`all` (the same condition under which it registers `/agent/ws` at all) — the web role never
holds a socket for any run, so there's nothing for it to poll. `AgentLink.send` already enqueued
whenever the local process had no socket for the run; that part needed no change.

**Tests:** `packages/api/test/agentlink.test.ts`, "down-message queue poller (cross-process
delivery)" — two `buildTestApp` instances share one `MemoryStore`; one ("sender") calls
`agentLink.send` for a run whose socket only the other ("owner") holds, asserting it lands in
`store.runs.pending` rather than being dropped; then `owner.agentLink.pollDownQueuesOnce()` is
called directly (deterministic — an unref'd `setInterval` with nothing else keeping a short-lived
test process's event loop alive may never actually fire before `node --test` decides the file is
done) and the message is asserted delivered over the owner's socket, with the store's queue now
empty.

### 2. `GcpSecretsBroker` threw on a not-yet-created per-run secret, killing runs that didn't need it

**Observed:** `deploy/README.md` already documented `outfitter-github-token-<sessionId>` and
`outfitter-litellm-key-<guruId>` as created "before that session/guru's first run", but in
practice a fresh guru or a repo-less session routinely hit its first run before anyone got around
to creating a secret it turns out not to need. `GcpSecretsBroker.accessSecret` let a Secret Manager
404 propagate straight out of `secretsForRun`, which `agentlink.ts`'s `buildRunSpec` never caught,
so `handleConnection`'s outer `catch` closed the agentd connection with a generic 1011 "internal
error" — no signal of *which* secret, and it fired even for sessions that never needed a GitHub
token at all (repo-less sessions) or gurus that could've used a shared fallback key.

**Fix (`packages/api/src/secrets.ts`):** `GcpSecretsBroker.accessSecretOrEmpty` now catches a
"not found" failure specifically (HTTP 404, or gRPC code `5` in case a client surfaces it that
way) and resolves to `""` with a `console.warn` log line instead of throwing; any other error
(auth, network, malformed payload) still propagates. `outfitter-litellm-key-<guruId>` falls back
to a shared `outfitter-litellm-key-default` secret before giving up. `accessSecret` (renamed
`accessSecretFromGcp`) is reachable through an injectable `fetchSecret` constructor param so tests
can stub Secret Manager access without ADC or the network.

The broker resolving to `""` isn't itself the fix for run-killing failures — an empty GitHub token
is genuinely fatal for a session that has a repo (agentd would clone with no credentials and fail
deep inside the sandbox instead), so `agentlink.ts`'s `buildRunSpec` now checks that specific case
explicitly (`session.repo && !secrets.githubToken`) and throws a `MissingGithubTokenError`, which
`handleConnection` catches to close the agentd WebSocket with code `1011` and a short, specific
reason (`missing github token secret for session <id>`) instead of the generic message. A
repo-less session, or a guru whose key resolves via the default fallback, is unaffected.
`MemorySecretsBroker` (dev/test) now also defaults its `githubToken` to a non-empty placeholder
(`dev-github-token`) rather than `""`, so existing dev/test repo-session fixtures didn't regress
under the new check — same reasoning `config.ts` already applies to `devToken` for agentd's own
bearer token.

**Docs:** `deploy/README.md`'s secrets table (b) now documents `outfitter-litellm-key-default` and
the empty-resolves / githubToken-is-the-only-fatal-case behavior above.

**Tests:** `packages/api/test/secrets.test.ts` (new) — `GcpSecretsBroker` with a stubbed
`fetchSecret`: missing secrets resolve to `""`; `outfitter-litellm-key-default` fallback fires only
when the per-guru key is missing; a non-404 error still propagates. `packages/api/test/agentlink.test.ts`,
"run.spec build validates secrets" — a repo session with an empty `githubToken` closes 1011 with a
reason matching `/missing github token/`; a repo-less session with the same empty token still gets
a normal `run.spec`.

### 3. `IAP_AUDIENCE` was never set by `deploy/api.sh`, and its own doc caveat was stale

**Observed:** `deploy/api.sh` deployed `outfitter-api` with `--iap` but never set `IAP_AUDIENCE` in
`--set-env-vars`, so `auth.ts`'s `identityFromRequest` would fail every real browser request
(`"IAP_AUDIENCE is not configured"`) the moment IAP was actually turned on. Also, IAP's own docs
distinguish the `aud` claim format by *how* IAP is fronting the service — App Engine
(`/projects/PROJECT_NUMBER/apps/PROJECT_ID`), a load-balancer-fronted backend service
(`/projects/PROJECT_NUMBER/global/backendServices/BACKEND_SERVICE_ID`), and — the case that
applies here, IAP enabled directly *on* a Cloud Run service via `--iap` — a third, Cloud
Run-specific format that the script never accounted for. Separately, `api.sh`'s own header comment
carried a stale caveat ("if `--iap` errors, rerun with `gcloud beta`") left over from before this
was actually run for real; `--iap` worked as-is.

**Fix (`src/auth.ts`, `deploy/api.sh`):** per the JWT payload claims table ("aud (Audience)" row,
"Cloud Run") at <https://cloud.google.com/iap/docs/signed-headers-howto>, the `aud` claim for IAP
enabled directly on a Cloud Run service is `/projects/PROJECT_NUMBER/locations/REGION/services/
SERVICE_NAME` — cited in a comment in `auth.ts` next to where `IAP_AUDIENCE` is verified.
`api.sh` now looks up `PROJECT_NUMBER` via `gcloud projects describe` *before* the real deploy
(it already needed that call later, for the `run.invoker` binding — moved earlier and reused
rather than looked up twice), computes `IAP_AUDIENCE="/projects/${PROJECT_NUMBER}/locations/${REGION}/services/${SERVICE}"`,
and adds it to the deploy's `--set-env-vars`. Also deleted the stale `gcloud beta` caveat from the
script's header comment.

**Verification:** no `gcloud` commands were run for this fix (out of scope per the task); the aud
format was confirmed by fetching the current IAP docs page directly rather than from memory, and
`deploy/api.sh` was checked with `bash -n` for syntax.

**Files touched:** `packages/api/src/agentlink.ts`, `packages/api/src/config.ts`,
`packages/api/src/secrets.ts`, `packages/api/src/auth.ts`, `packages/api/src/server.ts`,
`packages/api/test/agentlink.test.ts`, `packages/api/test/secrets.test.ts` (new),
`packages/api/test/helpers.ts`, `deploy/api.sh`, `deploy/README.md`.

**Test run:** `npm test` in `packages/api` (typecheck via `pretest`, then `node --test test/`):
50/50 passing. `npm test` from `outfitter/` (all workspaces): also green
(`@outfitter/api` 50/50, `@outfitter/provider-local` 2/2).

## Six review findings from the previous two gaps' own fixes

A follow-up review of the two sections above turned up six more issues — one a real correctness bug
(the missing-secret 1011 kept agentd retrying for ten minutes), the rest cleanup/consistency.

### 1. Missing-GitHub-token 1011 close made agentd retry a run that could never start

**Observed:** the previous gap's fix (`## api: ...`, item 2) closed the agentd socket with `1011`
when a repo session had no usable GitHub token secret. `1011` isn't in agentd's
`TERMINAL_CLOSE_CODES` (`packages/agentd/src/link.ts`), so agentd treated it as transient and kept
reconnecting with backoff for up to `maxUnspecMs` (10 minutes) while the run sat in `provisioning`
the entire time — the exact reconnect-storm shape the first gap's fix was written to prevent, just
for a condition (a secret that will never appear) that can never resolve itself.

**Fix:** added close code `4412` ("run cannot start: missing secret") to `docs/protocol.md`'s new
close-codes table and to agentd's `TERMINAL_CLOSE_CODES` (`packages/agentd/src/link.ts`) — terminal,
`main.ts` exits 1 for it (same bucket as `4400`/`4401` misconfiguration). `agentlink.ts`'s
`handleConnection` now marks the run `failed` (with `err.message` as `reason`) and removes it from
the live-sockets map *before* closing with `4412`, instead of just closing with `1011` and leaving
the run's state for the reconciler to eventually notice.

**Tests:** `packages/api/test/agentlink.test.ts` — the missing-token test now runs with `devMode`
off (the real production path; `verifyIdToken` is stubbed via `t.mock.method` so the WS connection
can still authenticate in-process) and asserts close code `4412` plus `run.state === "failed"` with
a matching `reason`. `packages/agentd/test/link.test.ts` — `4412` added to the existing
terminal-close-codes test loop (alongside `4400/4401/4404/4409`).

### 2. `GcpSecretsBroker` built a new `GoogleAuth` client (and did an ADC lookup) per secret access

**Observed:** `accessSecretFromGcp` called `new GoogleAuth(...)` and `auth.getClient()` on every
single secret fetch. `secretsForRun` fetches two secrets per run (`githubToken`, `litellmKey`), so
every run start did the ADC handshake twice for no reason — the client doesn't need to change
between calls.

**Fix (`packages/api/src/secrets.ts`):** `GcpSecretsBroker` now lazily builds the auth client once
(`getAuthClient`/`buildAuthClient`, cached in `authClientPromise`) and reuses it for every
subsequent `accessSecretFromGcp` call in that broker's lifetime.

### 3. `MemorySecretsBroker`'s placeholder githubToken turned an anonymous dev clone into a 401

**Observed:** the previous gap's fix (item 2) gave `MemorySecretsBroker` a non-empty default
`githubToken` (`"dev-github-token"`) specifically so the new missing-token check wouldn't block
dev/test repo sessions. But that placeholder is then sent to git as a real `Authorization` header on
clone — for a public repo cloned anonymously, presenting a bogus credential turns what would have
been a working anonymous clone into a `401`, which is worse than the problem it was meant to avoid.

**Fix:** `MemorySecretsBroker`'s `githubToken` default is back to `""`
(`OUTFITTER_DEV_GITHUB_TOKEN` still overrides it for a dev/test session that actually needs a
private-repo token). The missing-token check itself now understands the dev-mode case instead:
`agentlink.ts`'s `buildRunSpec` only treats an empty `githubToken` as fatal for a repo session when
`config.devMode` is false — in dev mode "no secret configured" means "clone anonymously", not "fail
the run", matching how a real anonymous `git clone` of a public repo behaves with no credentials at
all.

**Tests:** `packages/api/test/agentlink.test.ts` — the pre-existing "empty githubToken" test (which
relied on the non-empty placeholder never actually going empty) is now two tests: one with
`devMode` off asserting the `4412` failure (see item 1 above), and a new one with `devMode` on (the
`buildTestApp` default) asserting a repo session with an empty token still gets a normal `run.spec`
with `secrets.githubToken === ""`.

### 4. `Link.close()` used the global `clearTimeout` instead of the injectable `clearTimeoutFn`

**Observed:** every other timer in `packages/agentd/src/link.ts` (`connectionAgeTimer`,
`stableTimer`, `unspecTimer`) is cleared through `this.clearTimeoutFn`, injectable for tests — except
`close()`'s `reconnectTimer` clear, which called the global `clearTimeout` directly. Harmless with
real timers, but inconsistent, and would silently stop working if a test ever swapped in a fake
`clearTimeoutFn` and expected `close()` to use it too.

**Fix:** `close()` now calls `this.clearTimeoutFn(this.reconnectTimer)`, matching every other timer
in the class.

### 5. `stopReconciler` also stopped the down-queue poller — name didn't match what it did

**Observed:** the previous gap's fix (item 1) added `stopDownQueuePoller` and folded it into the
function `buildApp` already returned as `stopReconciler`, but never renamed it — so the `App`
interface and every caller kept calling something that stopped two different background tasks
`stopReconciler`.

**Fix (`packages/api/src/server.ts`):** renamed to `stopBackgroundTasks` (interface field, local
`const`, and the returned object); doc comment already described both jobs, left as-is. Updated the
one caller (`packages/api/src/main.ts`) and every test call site (`packages/api/test/agentlink.test.ts`,
15 call sites across the file).

### 6. `existing_secrets()` was duplicated verbatim in `deploy/api.sh` and `deploy/link.sh`

**Observed:** both scripts defined the identical `existing_secrets()` shell function (filters a
`--set-secrets` pair list down to secrets that actually exist yet, per-secret `gcloud secrets
describe`) — a straight copy-paste, already diverging in nothing but guaranteed to eventually.

**Fix:** moved `existing_secrets()` into `deploy/env.sh`, which both scripts already `source` first
thing (the shared project/account guard). `api.sh` and `link.sh` now each just call it, with a
one-line comment pointing at `env.sh`.

**Verification:** `bash -n` on all three scripts (`env.sh`, `api.sh`, `link.sh`) — no gcloud commands
run.

**Files touched:** `docs/protocol.md`, `packages/api/src/agentlink.ts`, `packages/api/src/secrets.ts`,
`packages/api/src/server.ts`, `packages/api/src/main.ts`, `packages/agentd/src/link.ts`,
`packages/agentd/src/main.ts`, `packages/api/test/agentlink.test.ts`,
`packages/agentd/test/link.test.ts`, `deploy/env.sh`, `deploy/api.sh`, `deploy/link.sh`.

**Test run:** `npm test` from `outfitter/` (all workspaces): `@outfitter/agentd` 64/64,
`@outfitter/api` 51/51, `@outfitter/provider-local` 2/2 — all green.

## Round-two stack: hello race and execution handle

Two bugs from the first cloud session run against the round-two stack (`outfitter/round-three`
branch): a real `hello`-frame race that stranded a run for its entire reconnect backoff, and a
`CloudRunProvider` handle bug that made the reconciler's cancel of a stale run a no-op.

### 1. `hello`, sent immediately after connect, was dropped by a listener-attachment race

**Observed:** agentd connects and sends `hello` as the very first thing it does once the WS upgrade
completes — there's nothing for it to wait on. But `AgentLink.handleConnection`
(`packages/api/src/agentlink.ts`) used to `await verifyAgentToken` (a real network call for Google's
certs on Cloud Run) and three store lookups (`runs.findById`, `sessions.findById`, `gurus.findById`)
*before* ever calling `waitForHello`, which is what attached the connection's first `'message'`
listener. `ws` emits `'message'` synchronously with no listener attached — it doesn't buffer — so a
`hello` that arrived during those awaits was simply lost. `waitForHello` then had nothing left to
wait for: agentd only sends `hello` once per connection, so the socket sat open with nobody ever
going to send it another frame. The observed symptom was the connection eventually giving up (agentd
gave up on `maxUnspecMs` and reconnected; the API's own log line was the pre-existing "closing
connection with a missing or invalid run token" warning, since the *retried* connection's `hello` won
the same race often enough to look like a real bad-token failure) — a run stuck in `provisioning`
for minutes over a frame that had, in fact, already been sent correctly the first time.

**Fix (`packages/api/src/agentlink.ts`):** a new `FrameBuffer` class wraps the raw socket and starts
buffering `'message'` frames the moment it's constructed — the very first statement in
`handleConnection`, before the `verifyAgentToken` call or any other `await`. `waitForHello` now reads
from that buffer (`FrameBuffer#next`): anything already queued first, then live frames — so it sees
the connection's true first frame regardless of when the awaits ahead of it finish. Once `hello` is
accepted, any *further* frames that piled up in the buffer during those same awaits (e.g. agentd
sending an `entry` right behind `hello`) are replayed through the normal `handleUpFrame` path, in
order, before the buffering listener is torn down and the connection's regular `'message'` listener
takes over — so nothing sent this early is lost or reordered. The buffer is capped at 256 frames
(`FRAME_BUFFER_CAP`); a connection that overflows it before ever getting through the handshake is
closed with `4400` rather than allowed to grow unbounded. Separately, `waitForHello`'s wait is now
bounded at 30s (`HELLO_TIMEOUT_MS`) instead of unbounded — agentd sends `hello` immediately, so there
is no legitimate reason to wait on it for anywhere near the ~5–10 minutes a stuck connection was
previously left hanging before something else (agentd's own reconnect backoff) finally moved it
along.

**Tests:** `packages/api/test/agentlink.test.ts`, new `describe("hello sent immediately after
connect is never dropped", ...)` — stubs `OAuth2Client.prototype.verifyIdToken` (devMode off, the
real production auth path) behind a promise the test controls explicitly, sends `hello` plus an
`entry` frame while that promise is still pending (reproducing the exact race), then releases
verification and asserts the connection still gets `run.spec` and that the entry was acked and
persisted, in order.

### 2. `CloudRunProvider.start` stored the runJob *operation* name as the run handle, not the execution's

**Observed:** `CloudRunProvider.start` (`packages/api/src/providers/cloudrun.ts`) stored
`operation.name` — the `JobsClient#runJob` long-running operation's own resource name
(`.../operations/<uuid>`) — as the run's `SandboxHandle`. `status()` and `stop()` both hand that
handle straight to `ExecutionsClient#getExecution` / `#cancelExecution`, which only understand
*execution* resource names (`.../jobs/<job>/executions/<name>`), not operation names. Against the
real API this silently no-ops in both directions: `getExecution` 404s (caught and reported as
`"unknown"`), and `cancelExecution` 404s and cancels nothing. `RunManager.reconcileOnce`'s stale-run
handling calls exactly that `stop()` before marking a run failed — so a stale run's Cloud Run Job
execution just kept running, unaffected, until someone cancelled it by hand.

**Fix (`packages/api/src/providers/cloudrun.ts`):** the execution's real resource name is available
off the runJob operation itself — `@google-cloud/run`'s generated `JobsClient#runJob` decodes the
LRO's `metadata` field as a `google.cloud.run.v2.Execution` synchronously in the gax `Operation`
constructor (`google-gax`'s `longrunning.js`, `_unpackResponse`), populated as soon as Cloud Run
accepts the job run — well before the execution itself finishes. `start()` now reads
`operation.metadata.name` for the handle instead of `operation.name`. For the rare case
`metadata.name` isn't present yet on the first response, a new bounded fallback
(`resolveExecutionName`) polls `operation.getOperation()` (which refreshes `metadata` in place) up to
`executionNamePoll.maxAttempts` times (default 10, 1s apart) and throws rather than ever storing an
operation name as the handle. `CloudRunProvider`'s constructor now also takes an optional `deps`
param (`jobsClient`/`executionsClient`/`executionNamePoll` factories) so this can be exercised
without real GCP credentials; production callers (`packages/api/src/providers/index.ts`) are
unaffected since the param is optional and defaults to the real lazy `@google-cloud/run` imports.
`status()`/`stop()` needed no changes — they were already calling `ExecutionsClient` correctly, just
with the wrong handle.

**Tests:** `packages/api/test/cloudrun.test.ts` (new) — stubbed `JobsClient`/`ExecutionsClient`:
`start()` stores `metadata.name` (not `operation.name`); falls back to polling `getOperation()` when
`metadata` isn't populated on the first response; throws (rather than storing a bad handle) if the
execution name never appears within the bounded poll; `status()`/`stop()` call `ExecutionsClient`
with the stored execution-name handle; `status()`'s starting/running/exited mapping per the v2
`Execution` field semantics already documented in `status()`'s own comment.

**Files touched:** `packages/api/src/agentlink.ts`, `packages/api/src/providers/cloudrun.ts`,
`packages/api/test/agentlink.test.ts`, `packages/api/test/cloudrun.test.ts` (new).

**Test run:** `npm test` from `outfitter/` (all workspaces): `@outfitter/api` 86/86,
`@outfitter/agentd` and `@outfitter/provider-local` unaffected and still green — all passing, no
failures anywhere in the workspace.

## Round-two stack: `/stop` used the wrong signal, and one socket's frames could race each other

Two more bugs found on the deployed stack (`outfitter/round-three` branch), both from the same root
cause: `packages/api` runs as two Cloud Run services (`outfitter-api` web role, `outfitter-link` link
role) sharing one Atlas store, but `AgentLink` keeps live WebSocket sockets in an in-process `Map` —
anything that assumes "this process's socket state" reflects the run's real state is wrong on the
role that doesn't hold the socket.

### 1. `POST /api/sessions/:id/stop` on the web role always sent SIGTERM instead of a graceful stop

**Observed:** the route branched on `ctx.agentLink.hasSocket(run.id)` to decide between a graceful
stop (send agentd a `stop` down-message, let it checkpoint and say `bye`) and a hard provider cancel.
`hasSocket` is process-local (`AgentLink.sockets`, an in-memory `Map`), and the web role
(`outfitter-api`) never registers `/agent/ws` at all (`server.ts`: `agentLink.register(fastify)` only
runs for role `link`/`all`) — so `hasSocket` was `false` for *every* call on that role, regardless of
whether the run had a live agent connected on `outfitter-link`. Every stop request from the browser
(which only ever reaches the web role, behind IAP) fell through to `ctx.runs.stop()`, which calls
`provider.stop()` — a hard cancel (SIGTERM to the sandbox on `docker`/`inprocess`, `cancelExecution`
on `cloudrun`) — skipping the checkpoint entirely and losing whatever wasn't already pushed.

**Fix (`packages/api/src/routes/sessions.ts`, `src/store/types.ts`, `src/agentlink.ts`,
`src/runs.ts`, `src/config.ts`):** `/stop` no longer looks at `hasSocket` at all. For a `running`/
`idle` run it always calls `agentLink.send(run.id, { t: "stop", reason: "user" })` — which already
does the right process-independent thing (deliver immediately if this process happens to hold the
socket, else enqueue in the store for the link role's existing down-queue poller to pick up) — then
marks the run a new `stopping` state. `stopping` is added to `RunState`, to both stores' active-run
sets (`ACTIVE_RUN_STATES` in `mongo.ts`, the two local `Set`s in `memory.ts`) so `findActiveForSession`
still finds it (no second `wake()` starts on the same session mid-stop) and to `AgentLink`'s
`isReadyState` (the agent is still connected, just draining toward `bye`, so a queued message must
still get delivered) and to `handleConnection`'s run-state gate (a reconnecting agentd mid-stop is
still accepted). A `queued`/`provisioning` run has no live agent to ask gracefully, so `/stop` still
cancels it via the provider directly in that case, same as before. `RunManager.reconcileStoppingOnce`
(new; wired into the existing 60s reconciler loop alongside `reconcileOnce`) cancels any run still
`stopping` past `STOP_GRACE_MS` (env, default 60s) via the provider and marks it `stopped` — the
backstop for agentd never getting, or never acting on, the down-message. `docs/protocol.md`'s run
state machine and REST section now document `stopping`.

**Tests:** `packages/api/test/stop.test.ts` (new) — `RunManager.reconcileStoppingOnce` cancels a run
stuck `stopping` past the grace and marks it `stopped` (and leaves one alone still inside the grace
window); a two-`buildTestApp`-sharing-one-`MemoryStore` test (same shape as the existing
cross-process down-queue test in `agentlink.test.ts`) asserting a `/stop` call on the process with no
socket for the run enqueues `{t:"stop",reason:"user"}` in the store and marks it `stopping` — never
calling `provider.stop` on either process — then that the owning process's poller delivers it and a
`bye` finishes the job; a `queued`/`provisioning` run still gets a direct provider cancel.

### 2. Up-frames on one socket were handled concurrently, so a late store write could undo `bye`

**Observed:** `AgentLink.handleConnection`'s `socket.on("message", ...)` called `handleUpFrame` per
message without awaiting the previous call's promise — each invocation does its own
`store.runs.findById` then `store.runs.update` round trip, so two frames arriving close together ran
those round trips concurrently instead of in sequence. In production, a `status: "stopping"` frame
(mapped, before this fix, to `provisioning` — see below) and the following `bye` frame raced: `bye`'s
update (`state: "stopped"`) resolved first, but the earlier `status` frame's update resolved *after*
it and silently overwrote the terminal `stopped` back to `provisioning` — a run that had actually
finished looked, to the store, like it was still starting up.

**Fix (`packages/api/src/agentlink.ts`):** `handleConnection` now serializes up-frame handling per
connection with a promise chain (`chain = chain.then(() => this.handleUpFrame(...).catch(...))`) — a
frame's handling (all its awaited store calls included) fully settles before the next frame on the
same socket even starts; errors are still caught and logged inline so one bad frame never wedges the
chain for every frame after it. Independently, `bye` is now final: the `status` and `heartbeat` cases
both check the run's current stored state first and no-op if it's already terminal (`stopped`/
`failed`), so a frame that's somehow still in flight or delivered after `bye` (the socket's own close
handshake, or a client oddity) can't resurrect a finished run either. Separately fixed the actual
`status`→state mapping bug this surfaced: `mapStatusToRunState` used to fall every unrecognized
`status.state` through to `provisioning`, which included agentd's own `checkpointing` and `stopping`
statuses (protocol.md always specced these; the mapping function just never handled them) — a
mid-turn checkpoint's `status: "checkpointing"` briefly overwrote a `running`/`idle` run back to
`provisioning`, and agentd's own `status: "stopping"` (distinct from this api's `stopping` run state,
sent while agentd is mid-shutdown) did the same. `checkpointing` now leaves the run's current state
untouched; `stopping` now maps to the new `stopping` run state.

**Tests:** `packages/api/test/stop.test.ts` — a custom `RunsCollection` wrapping `MemoryStore`'s whose
first `update()` call is artificially delayed 50ms (simulating a store whose writes can resolve out
of order) proves serialization: `status`+`bye` sent back-to-back land in `stopped` regardless of the
delay, where the old concurrent handling would have let the delayed `status` write clobber `bye`'s
terminal state; a second test sends `bye` then a `status` frame right behind it on the same
(still-open a moment longer) socket and asserts the run stays `stopped`.

**Files touched:** `packages/api/src/routes/sessions.ts`, `packages/api/src/store/types.ts`,
`packages/api/src/store/memory.ts`, `packages/api/src/store/mongo.ts`, `packages/api/src/agentlink.ts`,
`packages/api/src/runs.ts`, `packages/api/src/config.ts`, `packages/api/test/stop.test.ts` (new),
`docs/protocol.md`.

**Test run:** `npm test` from `outfitter/` (all workspaces): `@outfitter/agentd` 123/123,
`@outfitter/api` 92/92, `@outfitter/provider-local` 2/2 — all green.

## Every repo session needed a hand-minted PAT before its first run

**Observed:** on 2026-09-23 the `outfitter-509211` project held exactly one
`outfitter-github-token-*` secret — `outfitter-github-token-2cc9494a-…`, hand-minted at 00:37 UTC
for a single session and revised four times over the following nine hours, evidently while its PAT
scopes were being worked out. Every *other* repo session had nothing.
`GcpSecretsBroker.secretsForRun` read only `outfitter-github-token-<sessionId>`, so those sessions
resolved an empty `githubToken` and `agentlink.ts`'s `buildRunSpec` correctly refused them with the
terminal `4412`.

Creating a repo session through the UI therefore could not work end to end, and the one secret that
did exist shows why rather than contradicting it: the session is created by the person using the
UI, but the secret its first run needs can only be created out-of-band, by an operator, against a
session id that does not exist until `POST /api/sessions` has already returned. Every repo session
needs that dance before its first run, and gets it wrong a few times on the way.

The gap isn't the fatal check — an empty token really would fail deep inside the sandbox, and
`buildRunSpec` is right to refuse early. It's that there was no floor under it, unlike gurus, whose
LiteLLM keys have had an `outfitter-litellm-key-default` fallback since the "api: cross-process
down-messages, secret-not-found handling" gap above.

**Fix (`packages/api/src/secrets.ts`):** `secretsForRun`'s GitHub token lookup now mirrors
`litellmKeyForGuru` — `githubTokenForSession` reads `outfitter-github-token-<sessionId>` first and
falls back to a shared `outfitter-github-token-default` (exported as `GITHUB_TOKEN_DEFAULT_SECRET`)
when the per-session secret doesn't exist. It logs which of the two a run resolved, since "the
token worked" and "the token I expected" are different questions once a clone or push fails. The
fallback is fetched only when the per-session secret is absent, so a session with its own token
never pays for or touches the shared one.

The fallback is also gated on `session.repo`. `run.spec` carries `secrets` for every run, repo or
not, so falling back unconditionally would have handed the org-wide token to sandboxes that
provably have nothing to clone or push — strictly more exposure for no capability. (Caught in this
PR's own review pass, not in the first draft.) A repo-less session with a token of its own still
gets it: creating that secret is a deliberate grant.

The per-session secret remains the preferred form and is unchanged in precedence: a fine-grained
PAT scoped to one repo, revocable on its own, is a much smaller blast radius than an org-wide
token every repo session can reach. `outfitter-github-token-default` makes skipping it *looser*,
not fatal — see `deploy/README.md` (b) for when to mint a per-session PAT anyway (private or
production repos, push rights that matter, a session whose operator shouldn't reach the rest of
the org).

`buildRunSpec`'s fatal check is deliberately kept as-is: reaching it with an empty token now means
*neither* secret exists, which is still a run that cannot clone. Its comment was updated to say so.

**Docs:** `deploy/README.md` (b) now leads with the two `-default` secrets as the up-front ones and
the per-id secrets as per-session/per-guru overrides, and has a "Per-session vs. shared GitHub
token" paragraph on the tradeoff. It also corrects a stale close code in that section: the
missing-token close is `4412`, not the `1011` it originally shipped as (fixed in "Six review
findings from the previous two gaps' own fixes" above, but never corrected in the deploy doc).

**Not done:** `outfitter-github-token-default` is not in `src/operator.ts`'s managed-secret list,
so the E2.14 operator settings page can't set or rotate it — it's a `gcloud secrets` operation for
now, like the per-session tokens. Worth adding alongside `outfitter-litellm-key-default`, but it's
a separate change (route + `appliesAt` + tests).

**Tests:** `packages/api/test/secrets.test.ts` — the shared fallback fires when the per-session
secret is missing; the per-session token still wins when both exist (and the shared one isn't even
fetched); neither existing still resolves to `""` (having attempted both) rather than throwing, so
`buildRunSpec` keeps owning the repo-session-is-fatal decision; a repo-less session never reaches
the shared secret, but does still get a per-session token when one exists.

**Files touched:** `packages/api/src/secrets.ts`, `packages/api/src/agentlink.ts` (comment only),
`packages/api/test/secrets.test.ts`, `deploy/README.md`.

**Secret created:** `outfitter-github-token-default` was created by hand on 2026-09-23 at 10:00 UTC
(version 1, enabled) — by the operator, not by this change; nothing in this repo writes a secret
value. `outfitter-api` already holds a project-wide `roles/secretmanager.secretAccessor` from
`baseline.sh`, so no per-secret IAM binding was needed, and none was added. The fallback therefore
takes effect for repo sessions as soon as an API carrying this code is deployed (an `outfitter-v*`
tag, per the deploy convention); the running service still resolves only the per-session name.
