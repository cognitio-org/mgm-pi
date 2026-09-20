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
