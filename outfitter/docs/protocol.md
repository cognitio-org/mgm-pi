# Outfitter wire protocol (v0)

Two links: **agentd ⇄ api** (WebSocket, JSON text frames, one message per frame) and **browser ⇄ api**
(REST + SSE). All messages are `{ "t": "<type>", ... }`. Timestamps are ISO strings. Ids are strings.

## Two origins

In production these two links don't share an origin. IAP on a Cloud Run service is service-wide,
so a single IAP-protected service can't also carry agentd's WebSocket (its Google ID token's
audience is the service's own origin, not IAP's client id) or the unauthenticated ngrok webhook —
IAP would reject both before they reached the app. So `packages/api`'s image runs as two Cloud Run
services, picking its routes by env var `OUTFITTER_ROLE` (`src/config.ts`): `outfitter-api`
(`OUTFITTER_ROLE=web`, IAP on) serves everything under "browser ⇄ api (REST)" below; `outfitter-link`
(`OUTFITTER_ROLE=link`, `--allow-unauthenticated`) serves `GET /agent/ws`, `POST /api/hooks/*`
(ngrok, and the mailbox's `tasks/wake` and `tick`), the teleport routes (see "Personal API tokens"),
and the browser companion (see "Browser companion"). Each authenticates its own requests as
described in those sections.
Both roles share one Atlas store. `OUTFITTER_ROLE=all` (the default) runs both on one process, for
local dev where there's no IAP anyway. See `deploy/README.md` and `deploy/link.sh`.

## agentd ⇄ api

Connect: `wss://<api>/agent/ws?run=<runId>` with header `Authorization: Bearer <google id token>`
(audience = API origin; local dev: `OUTFITTER_DEV_TOKEN`). The API verifies the token, checks the run
exists and is `provisioning|running|idle`, then waits for the first frame (`hello`) before doing
anything else with the socket. agentd reconnects with backoff and resends `hello` with
`lastAckedSeq`; the API replays anything after it.

**Run token.** The id token above only proves the caller is *some* execution of the outfitter-agent
Cloud Run Job -- every execution of that job runs as the same service account, so it says nothing
about *which* run the caller is actually supposed to be driving
(docs/reports/security-review-pr1.md finding #2). `RunManager.wake` (`packages/api/src/runs.ts`)
generates a 32-byte random `runToken` per run, stores only its sha256 hash on the `Run` record, and
hands the plaintext to the provider as the `RUN_TOKEN` container-override env var (alongside
`RUN_ID`). agentd reads `RUN_TOKEN` and sends it back as `hello.runToken`; the API hashes it and
compares against the stored hash in constant time before registering the socket, sending
`run.spec`, or handling any other frame -- a missing or mismatched token closes the connection with
`4401` and no `run.spec` is ever sent. Outfitter's own code never logs or stores the plaintext
token: the api keeps only its hash, and agentd's logger redacts it.

**The launch request is audit-logged, token included (#168, accepted).** The platform records the
request that starts a sandbox, and that request carries the token:
- Cloud Run: the `google.cloud.run.v2.Jobs.RunJob` Admin Activity audit entry includes the
  container overrides, `RUN_TOKEN`'s value among them.
- GKE warm mode: the controller's `pods.patch`, which puts the claim's annotations on the warm pod,
  and the later `pods.delete` entries include the `outfitter.dev/run-token` annotation. GKE cold
  mode passes it as claim env, which reaches the pod spec the same way.

Admin Activity logs can't be turned off, and they are kept for 400 days. Decided 2026-09-26 to accept
this rather than change the protocol, because a leaked token alone can't drive a run:
- **Readers are already trusted.** Reading these entries needs Logs Viewer (or wider) on the
  project. As of 2026-09-26 that is the owner (`mgm@mgms.eu`), `outfitter-deployer@` (Logs Viewer;
  the release workflow's identity) and the default compute service account (project Editor, which
  #144 wants to narrow). Both service accounts can already deploy code that runs as
  `outfitter-agent@` (see deploy/README.md: a stolen deployer token is about as powerful as a
  malicious release), so reading a run token gives neither anything new.
- **A second credential is needed.** A connection must also present an id token for the
  `outfitter-agent@` service account. That account holds only `roles/logging.logWriter`, and
  `assert_agent_sa_no_unexpected_bindings` (`deploy/env.sh`) keeps it that way.
- **The token is short-lived.** It is only good for its own run, and only while that run is live.
- **Only one connection wins.** A second socket for a run that already has one is refused ("One
  live agent connection per run", below).

Revisit this if anyone who can't already deploy gets log access (a human or service account with
Logs Viewer alone), or if the agent service account gains broader roles. The options weighed then were: a one-time launch token rotated over the
WebSocket on first hello; no launch token, first connection wins; and a pod-bound Kubernetes token
(GKE only).

Close codes the API can send, and how agentd (`TERMINAL_CLOSE_CODES`, `packages/agentd/src/link.ts`)
treats them:

| code | reason | agentd behavior |
|---|---|---|
| `4400` | missing run query param | terminal, exit 1 (misconfiguration) |
| `4401` | unauthorized, or `hello.runToken` missing/incorrect for this run | terminal, exit 1 (misconfiguration) |
| `4404` | run/session/guru not found | terminal, exit 0 (nothing left to do) |
| `4409` | run is in a terminal state already, **or** (E5.7/bug 9, cloud-fixes.md) this agentd's `hello.protocolVersion` is older than the API's own (including a build that predates the field, treated as version 0) | terminal, exit 0 (nothing left to do) |
| `4412` | run cannot start: missing secret (a repo session with no usable GitHub token: including a repo the configured GitHub App's installation doesn't cover, an installation missing a permission runs need, or GitHub refusing the token request; #172) | terminal, exit 1; the API also marks the run `failed` with a reason before closing, and holds the session's deliverable mail with that reason (#172) so the `/tick` sweep stops starting runs for it until Retry. Not used for a transient App mint failure (#158): a first connect closes `1011` to retry, and a reconnect of a running run keeps its current token |
| `4429` | the run already has a live agent connection (see "One live agent connection per run" below) | transient, agentd keeps reconnecting with backoff |
| `1011` | internal error | transient, agentd keeps reconnecting with backoff |

Any other code is treated as transient too. `4412` exists specifically so a run stuck without a
clonable secret fails fast instead of agentd retrying for up to ten minutes (`maxUnspecMs`) with the
run sitting in `provisioning`.

**Every refusal explains itself.** agentd is closed on, so nothing it reports ever reaches the
browser for these: the API writes the reason onto the run itself instead, via
`AgentLink.refuse` — `Run.statusDetail` (a full sentence with a remedy, which the session page
renders as its own note and the Drives list shows under a failed floppy's pill) plus, for a code
agentd treats as terminal, `state: failed` and the short close reason in `Run.reason`. Which
refusals may write there is not a detail: a refusal decided *before* `hello.runToken` has been
checked is decided on an unproven caller's word — a valid agent identity token only proves the caller
is some execution of the shared agent job (`docs/reports/security-review-pr1.md` finding #2) — so
`4401`, along with `4400`'s missing-param case, persists nothing, and a sandbox that genuinely never
connects is failed by the stale-run reconciler (`packages/api/src/runs.ts`) on the API's own
evidence. `4409`'s already-terminal case and `4429` write nothing either: the first would overwrite
how the run really ended, and the second means the run is healthy.

**One live agent connection per run.** The run token above is a bearer credential: anything holding
it could, until this was fixed, open its own `/agent/ws?run=<id>`, be handed its own `run.spec`
(which carries `secrets.githubToken` and `secrets.litellmKey`) and *replace* agentd in the API's
socket map, taking over the run's down-channel -- and the sandbox handed that token to the model's
own shell in pi's environment (finding #1, `docs/reports/security-review-pr41.md`). A run now
accepts one live agent connection at a time: a second `hello` for a run whose socket is open and was
heard from within `AGENT_SOCKET_GRACE_MS` (default 60s -- four of agentd's 15s heartbeats) is closed
with `4429` before any side effect, and is never sent `run.spec`. agentd's own reconnects are
unaffected, because it only reconnects after its previous socket has closed (`link.ts`; the
55-minute rotation calls `close()` and waits for the `close` event). A socket that is still OPEN but
silent past the grace window is treated as a dead half-open connection -- a partitioned sandbox, a
killed instance -- and is replaced by the newcomer (closed with `1001`, which is non-terminal, so a
live agentd that lost the race reconnects instead of exiting) rather than leaving the run wedged
until TCP notices. That window is not a hole a live sandbox can slip through: it only opens once
agentd has stopped heartbeating, which means pi -- the process the model lives in -- is not running.
Note the check is per-process, so it cannot see a socket held by another `outfitter-link` instance;
it is defense in depth behind the real fix, which is that pi's environment never contains
`RUN_TOKEN` at all (`packages/agentd/src/pi.ts`'s `baseEnvForPi`).

**pi's environment is an allowlist.** agentd's own env holds the run's takeover kit (`RUN_TOKEN`,
`RUN_ID`, `OUTFITTER_API`, set per execution by `providers/cloudrun.ts`). `spawnPi` builds the child
environment from an explicit allowlist -- `PATH`/`HOME`/`USER`/`LOGNAME`/`SHELL`/`TERM`/`TZ`/`LANG`/
`LANGUAGE`/`TMPDIR`, plus the `LC_*`, `PI_*`, `KERNAL_*`, `MGM_*` and `LITELLM_*` prefixes -- rather
than copying agentd's env minus a denylist, so a new env var agentd gains is withheld from the model
by default instead of leaked by default. Everything pi needs *per run* (the LiteLLM key and base
URL, the session id, the spend file) is passed explicitly by `run.ts` on top of that. An operator
who needs more through (e.g. `HTTPS_PROXY`) sets `OUTFITTER_PI_ENV_PASSTHROUGH` on agentd, which can
add names but can never re-add `RUN_TOKEN`, `RUN_ID`, `OUTFITTER_API`, `OUTFITTER_DEV_TOKEN` or
`NODE_OPTIONS`. `main.ts` snapshots `process.env` into a private `bootEnv` object and deletes
`RUN_TOKEN`/`OUTFITTER_DEV_TOKEN` from the *real* `process.env` as its first act, before resolving
anything else (including `getPiVersion`'s `pi --version` and `resolveRunAsUser`'s `id`/`getent`
lookups, both of which spawn children that inherit `process.env` wholesale via `execFile`) -- a
review of an earlier cut of this file found the delete happening too late, after those two spawns
already had a chance to inherit `RUN_TOKEN`. Everything downstream reads from the `bootEnv` snapshot
instead of `process.env`, so nothing after that first line can still see the real value in the
process's own environment.

**Where the takeover kit comes from: env, or, on a GKE warm pod, a wait.** `packages/agentd/src/assignment.ts`'s
`resolveAssignment` is what main.ts actually calls, against `bootEnv`. On Cloud Run, docker,
inprocess and a GKE *cold* claim, `RUN_ID` is already in env at boot: `main.ts` resolves it right
away, before any child is spawned or any log line written, and it fails exactly as fast and as
quietly (zero log lines) on a missing var as it always did -- the same checks, same order, same
error text as before `assignment.ts` existed. A GKE *warm* pod boots with none of the three in env:
it was pulled from the warm pool before any run existed, so there is nothing to assign it yet
(`docs/specs/gke-sandbox-provider.md` §3.5). Only this case defers `resolveAssignment` past agentd's
own run-independent setup (pi's version, the run-as-user uid/gid, preloading pi's session package),
so a warm pod pre-pays that work while it waits: `resolveAssignment` polls the read-only files under
`OUTFITTER_ASSIGNMENT_DIR` (default `/etc/outfitter/assignment/{run-id,run-token,api}`, root-only
0400) until a `SandboxClaim`'s annotations -- the API's warm-mode `start()` -- reach them via the
downward API, with no default timeout: an unclaimed warm pod stays idle, never dialling out, until
the pool shrinks and deletes it. Same isolation rule either way: the resolved values are held in
memory only and never written to `process.env`.

**Two Linux users inside the sandbox.** `image/Dockerfile`'s entrypoint (agentd) runs as root; `git`
therefore also runs as root, so the `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` env
vars agentd's git.ts uses to authenticate a clone/fetch/push (instead of `-c ...` on argv, which is
readable via `/proc/<pid>/cmdline` by anyone sharing that process's Linux user) sit in an
environment only root can read. `pi` -- and everything the model's shell tool runs -- is spawned as
the unprivileged `agent` user instead (`PI_RUN_AS_USER`, agentd's run-as-user.ts), so it can never
read agentd's own git child's `/proc/<pid>/environ`. agentd chowns whatever git wrote into
`/workspace` back to `agent` right after each clone and each push (see run.ts's `chownWorkspace`)
so pi's own tools (which do run as `agent`) still have a normal, writable checkout.

Up (agentd → api):

| t | fields | when |
|---|---|---|
| `hello` | `runId, sessionId, agentdVersion, piVersion, lastAckedSeq, runToken, protocolVersion, boot?` | first frame after connect; `boot` (optional) is this sandbox's boot durations on agentd's own clock -- `bootMs, setupMs, assignmentWaitMs?, sinceAssignedMs, identityTokenMs?, connectMs?, preBooted?` (see "Start-up timing" below), numbers only, never a secret; the api keeps the first accepted hello's and ignores it on a reconnect; `runToken` is `RUN_TOKEN` echoed back (see "Run token" above); `protocolVersion` is agentd's `WIRE_PROTOCOL_VERSION` (`packages/agentd/src/protocol.ts`) -- the api closes with `4409` when it's older than its own copy of the constant (`packages/api/src/agentlink.ts`'s `API_PROTOCOL_VERSION`), so a deploy that updates the API ahead of the agent image fails loudly instead of the agent silently ignoring frames it doesn't understand (bug 9, `docs/reports/cloud-fixes.md`) |
| `status` | `state: "cloning"\|"restoring"\|"starting"\|"running"\|"idle"\|"checkpointing"\|"stopping", detail?` | on change; the api maps this to `Run.state` (`agentlink.ts`'s `mapStatusToRunState`): `running`/`idle` map straight across, `checkpointing` leaves the run's current state untouched (a mid-turn checkpoint push, not a state change), `stopping` maps to the `Run.state` of the same name, anything else (`cloning`/`restoring`/`starting`) maps to `provisioning`. A `status`/`heartbeat` frame that arrives after the run has already reached a terminal state (`bye` already processed) is ignored — `bye` is final. |
| `entry` | `seq, entry` (a pi session entry exactly as pi writes it to JSONL: message, model_change, compaction, custom, ...) | whenever pi appends to the session file (agentd tails the file; this is the durable transcript) |
| `event` | `seq, event` (a raw pi RPC event: agent_start, message_update, tool_execution_start/update/end, agent_end, extension_ui_request, ...) | streamed for live UI; not persisted except `extension_ui_request` |
| `spend` | `keySpend?, keyMax?, modelGroup?, callId?, estimate?, baseline?` | `keySpend`/`keyMax`/`modelGroup`/`callId` from LiteLLM's `x-litellm-key-spend`/`-max-budget`/`-model-group`/`-call-id` response headers (relayed by the `outfitter-spend` pi extension's `after_provider_response` hook, `packages/agentd/pi-extension/outfitter-spend.ts`, loaded only under agentd -- see E2.11); absent fields mean the response carried no LiteLLM headers at all (non-LiteLLM route) or an incomplete set (e.g. no budget cap, so no `-max-budget`). `estimate` is pi's own cumulative cost estimate for the run so far (agentd's running sum of the extension's own per-response `usage` estimates, `packages/agentd/src/pi.ts`'s `SpendTailer`), independent of LiteLLM's headers -- it is what lets `Run.costEstimate` be real even for a guru whose route never returns spend headers. For an auto-router model group (`claude-auto-llm`, `gemini-auto-llm`, `*-agentic`, `*-affinity`, whose `/model/info` price is all zero because the underlying model is only picked per call), the extension's per-response `usage` estimate is instead computed from the newest assistant message's token counts times the *resolved* model's price (from `x-litellm-model-name`, fetched via `/model/info` at `session_start`) plus `x-litellm-classifier-cost`, rather than pi's own (zero) per-message cost estimate -- see E2.11b. `baseline: true` marks exactly one frame per run, sent from the extension's `session_start` handler before any provider call: `keySpend` on it is the LiteLLM key's balance read from `GET /key/info` *before* this run's first call (rather than a post-call balance from a response header), so the api's "pin `Run.keySpendStart` from the first spend frame seen" logic (`agentlink.ts`) baselines correctly and a one-call run's `cost` is no longer under-reported as 0. If `GET /key/info` fails, no baseline frame is sent and the prior first-response-frame-pins-baseline behaviour applies. |
| `checkpoint` | `branch?, head?, pushed?: boolean, snapshotUrl?, workspaceUrl?` | after each checkpoint; repo-less runs upload a workspace tarball (`workspaceUrl`) instead of pushing. For a repo run agentd commits any uncommitted changes, then pushes when HEAD is the session branch or a branch under `repo.branchPrefix` (default `outfitter/`). `branch` is that checked-out branch, and the api copies an allowed one onto `session.branch`. A detached HEAD or any other branch is not pushed; the frame keeps the session branch. `pushed` says whether this checkpoint sent anything |
| `heartbeat` | `idleSeconds, memMb` | every 15 s |
| `bye` | `reason: "idle"\|"stop"\|"sigterm"\|"error", message?` | last frame |
| `mail.ack` | `id` | pi accepted a `mail` down-message (its RPC `prompt` response came back `success: true`); the API marks the mail acked |
| `browser.capture.request` | `requestId` | the Drive's `browser_capture` tool (`outfitter-browser.ts`, no tab id) asked for the session's one shared tab. This is not the laptop tool of the same name in `kernal-chrome`, which is absent from the sandbox image. agentd mints `requestId` once per tool call. The api creates that browser-request row (`requesterEmail` is the session owner), or answers at once with `browser.capture.result` `error:"no_share"`. The same `requestId` does not create a second row |
| `github.request` | `reqId, op, args, idempotencyKey?` | agentd asks the api to run one GitHub operation for this session. Not seq/ack replayed — a dropped link retries the request; it is not replayed from `lastAckedSeq`. See "GitHub broker" |
| `browser.action.request` | `requestId`, `kind` (`click` or `type`), `selector`, `text?` | the Drive's `browser_action` tool asked to click or type in the session's one shared tab. Same shape as capture: agentd mints `requestId` once, the api creates the browser-request row (with `kind` and the CSS `selector`; `text` only for `type`), or answers at once with `browser.action.result`. A selector that is not CSS, including raw JavaScript, is `rejected` and inserts nothing. The same `requestId` does not create a second row. This is not `browser_capture` |
| `browser.inspect.request` | `requestId` | the Drive's `browser_inspect` tool asked to read the console and the element selected in DevTools on the session's one shared tab. No tab id. agentd mints `requestId` once. The api creates a browser-request row with `kind: "inspect"`, or answers at once with `browser.inspect.result`. The same `requestId` does not create a second row. This is not `browser_capture` and not `browser_action`. A body that names a tab id is not this frame |
| `startup` | `phases: [{name, ms}]` | when pi answers agentd's readiness probe ("pi ready"), and again after every reconnect until the run ends (the api keeps the first): agentd's start-up phases since `run.spec` arrived (`run.spec received`, `repo cloned`, `workspace restored`, `session import done`, `pi spawned`, `pi ready`), `ms` counted from `run.spec`. Not seq/ack replayed. See "Start-up timing" below |

Down (api → agentd):

| t | fields | effect |
|---|---|---|
| `run.spec` | `session {id, name, cwd:"/workspace"}, repo? {cloneUrl, branch, baseBranch, createBranch, branchPrefix?} (absent for non-coding sessions: agentd starts with an empty /workspace, or restores `workspace.snapshotUrl`), workspace? {snapshotUrl?}, guru {systemPrompt?, appendSystemPrompt?, model, thinking, tools?, excludeTools?, packages?, env?, playwrightBeforeCheckpoint?, allowExternalHtmlResources?}, snapshot {url?, jsonl?}, secrets {githubToken, litellmKey, litellmBaseUrl?}, author? {name, email, login?}, idleStopSeconds, checkpointEvery` | start the run |
| `ack` | `seq` | agentd may drop buffered frames ≤ seq |
| `prompt` | `text, images?, behavior?: "steer"\|"followUp"` | pi RPC `prompt` (with `streamingBehavior` if pi is busy) |
| `steer` / `follow_up` | `text` | pi RPC same name |
| `abort` | — | pi RPC `abort` |
| `ui_response` | `id, value` | pi RPC `extension_ui_response` |
| `rpc` | `command` (raw pi RPC object) | escape hatch for anything else (`get_state`, `set_model`, `compact`, `bash`) |
| `checkpoint` | `message?` | git push + snapshot now |
| `diff` | `reqId` | agentd replies `diff.result {reqId, base, patch}`; without a repo it replies with the list of changed files in /workspace since the last checkpoint |
| `read` | `reqId, path` | agentd replies `read.result {reqId, content|error}` |
| `stop` | `reason` | checkpoint, then `bye`, exit 0 |
| `mail` | `id, text, behavior?: "followUp"\|"steer"` | E5.5 mailbox message: pi RPC `prompt` with rpc id `mail:<id>` and `streamingBehavior: behavior ?? "followUp"` (starts a turn when idle, queues when busy); agentd sends `mail.ack` once pi accepts it, and re-acks without re-prompting if the same id is redelivered |
| `browser.capture.entry` | `entry` (a pi custom entry, `customType: "outfitter.browser.capture"`, id `browser-capture:<requestId>`, data `{captureId, title, url, requesterEmail}`) | agentd emits one ordinary `entry` up-frame through the same seq counter as every other `entry`/`event`. The api sends this while the run is connected or provisioning (queued on the down-frame queue until the run is ready, same as `prompt`) and does not allocate that seq itself. A second frame for an entry id already stored is not sent |
| `browser.capture.result` | `requestId`, and either `captureId, title, url` or `error` (`no_share`, `skipped`, `permission_denied`, `tab_gone`, `too_large`) | answers the Drive's `browser.capture.request` (up table). Sent when the request is created with no share, when the owner uploads the jpeg (the request is already `done`; this frame does not allocate an entry seq — `browser.capture.entry` does), when a pending request becomes `skipped`, or when the share owner reports `permission_denied`, `tab_gone`, or `too_large` (`POST .../fail` below). A repeat upload or a repeat failure report of the same `requestId` does not send it again and does not create a second row. agentd waits up to 90s and then tells the tool `timeout`. A click or type request that is skipped sends `browser.action.result` instead of this frame. An inspect request that is skipped sends `browser.inspect.result` instead |
| `browser.action.result` | `requestId`, and either no `error` (the extension ran it) or `error` (`no_share`, `skipped`, `denied`, `rejected`, `not_found`, `permission_denied`, `tab_gone`, `not_editable`, `not_shared`) | answers `browser.action.request`. No transcript seq. Sent when there is no share, when the selector is rejected, when a pending action becomes `skipped`, or when the share owner reports the result (`POST .../actions/:requestId/result`). A repeat does not send it again. agentd waits up to 90s and then tells the tool `timeout`. Nothing runs in the page until the owner allows it, unless that share's switch for the kind is on |
| `browser.inspect.result` | `requestId`, and either `messages` (redacted console lines) plus `element` (a short tag/id/class description, or null) or `error` (`no_share`, `skipped`, `denied`, `rejected`, `not_shared`, `tab_gone`, `permission_denied`, `debugger_attached`) | answers `browser.inspect.request`. No transcript seq. Sent when there is no share, when a pending inspect becomes `skipped`, or when the share owner reports the result (`POST .../inspects/:requestId/result`). Cookie and Authorization header values are stripped before this frame is sent. Raw network headers are not on it. A repeat does not send it again. agentd waits up to 90s and then tells the tool `timeout`. The debugger does not attach until the owner allows it |
| `github.result` | `reqId, ok: boolean, data? \| error?` | answer to `github.request` with the same `reqId`. `ok: true` carries `data`; `ok: false` carries `error` (a string, no stack). Not seq/ack replayed |
| `github.credential` | `token, expiresAt?` | a replacement GitHub credential for the git proxy and later checkpoint pushes. The api sends it on each hello, because a reconnect ignores a second `run.spec`, and again before a GitHub App installation token expires. Not seq/ack replayed. An agentd that does not know this frame ignores it |

### GitHub broker (phase 3)

GitHub tool calls do not receive the token. `run.spec.secrets.githubToken` is still delivered for git. These two frames are why `API_PROTOCOL_VERSION` is 2: an agentd whose `hello.protocolVersion` is 1 (or missing) is refused with `4409` until that image is redeployed. agentd forwards a closed list of operations; the api runs them with the run's credential (a per-session PAT, else a GitHub App installation token when that App is configured, else — only when the App is not configured — `outfitter-github-token-default` when `session.repo` is set; the same resolution as `run.spec.secrets.githubToken`). With the App configured, a failed mint fails that one request with a reason instead of using the shared PAT (#158). The token is not logged. There is no `github_pr.wait_ci` and no arbitrary GitHub passthrough: waiting on CI is the agent polling `github_pr.checks`. GraphQL is used only to reply to a review thread and to resolve one.

`args` is a JSON object. `owner`, `repo` and `head` on `args` are ignored. The api uses the session's repository (`session.repo`: an `owner/repo` shorthand or a `github.com` URL) and the session branch (`session.branch`, else `outfitter/<sessionId>`) as the pull request head.

Reads (`github_pr.view`, `github_pr.list`, `github_pr.checks`, `github_issue.list`, `github_issue.view`, `github_repo.view`, `github_repo.search`, `github_repo.releases`) may omit `idempotencyKey`. Writes (`github_pr.create`, `edit`, `comment`, `reply`, `review`, `resolve`, `merge`, and `github_issue.create`, `comment`, `edit`, `close`, `reopen`) require one. A missing key is `error: "idempotencyKey is required"`. The api remembers the last 100 keys per run (on the run record, not on this socket) and returns that result without calling GitHub again, so a retry after a dropped link does not post twice. Reusing a key returns the first result even if `op` differs.

`github_pr.merge` is `error: "not permitted"` unless the session's guru has `mergeFromCloud: true` (absent or false by default). A missing GitHub permission is the same string. An unknown `op` (including `github_pr.wait_ci`) is `error: "unknown op"`.

`data` matches the local github tools' result objects (`normalizePr`, `normalizeIssue`, repo view, search) so a broker can pass the fields through. `github_pr.list` is `{ pullRequests }`, `github_issue.list` is `{ issues }`, and `github_repo.releases` is `{ releases }`, because `data` on this frame is an object. `github_repo.search` is `{ issues, pullRequests }`. When GitHub sent `X-RateLimit-Remaining` and `X-RateLimit-Reset`, `data.rateLimit` is `{ remaining, reset }` (`reset` is the header's unix seconds). The api backs off when that remaining budget is at or below 10, and never sleeps inside one request for more than 3 seconds. Pull request and issue `state` is the uppercase `OPEN` / `CLOSED` / `MERGED` the local tools report; search rows keep the search API's lowercase state. Bodies the api posts carry `Outfitter, on behalf of @login` when the session owner has a `githubLogin`. `github_pr.create`'s `closes` are issues named by the session branch (and `args.closes`, if sent), not by commit messages — those stay in the sandbox. A pull-request view still returns the pull request when the checks or reviews endpoint is not permitted; `github_pr.checks` itself reports `not permitted`.

### Mailbox (E5.5)

Every message for a session's agent — the browser's first prompt, `POST /messages`, and agent
sends — is stored in the `mail` collection before anything else happens, addressed to the
*session*, not a run. So a failed wake, or a run that dies before it is ready, can't lose it.
Delivery is at least once:

- A run receives mail only while `running` or `idle` (never `stopping`: a follow-up accepted by a
  draining run would start a turn the stop cuts off). The link role claims mail oldest-first with an
  atomic `findOneAndUpdate` that sets `delivered` plus a 60 s lease, then sends a `mail` frame. It
  does this when a run becomes ready, from the down-queue poller, and right after a post whose
  recipient's socket is local.
- `mail.ack` marks it `acked` (TTL-deleted after 7 days), but only if it is currently delivered to
  the acking run. Mail that isn't acked before its lease expires is claimable again.
- **Attempts:** 6 per mail. Each claim counts. So does each run whose `hello` actually passes the
  token and protocol-version checks (`Run.protocolAcked`, `agentlink.ts`'s `handleConnection`) --
  charged once per run there, not at wake time (bug 10, `docs/reports/cloud-fixes.md`: charging on
  every wake regardless of outcome meant a run that failed before ever connecting -- a clone
  failure, a missing secret, a Cloud Run scheduling failure, a version-skewed agentd refused with
  `4409` -- still burned a full attempt on a delivery that was never actually attempted, and could
  dead-letter every one of a session's queued messages after just 6 such failed wakes). A session
  whose runs never reach a validated `hello` at all is retried indefinitely rather than exhausting
  the mail's attempts; one whose runs *do* connect but keep dying before they ack still stops being
  woken once attempts run out, same as before. The `/tick` sweep marks exhausted mail `dead` (TTL
  7 days) and bounces agent sends back to their sender.
- On `bye`, mail delivered to that run but not acked goes back to `queued` straight away. Then the
  session is woken again if it holds deliverable mail (e.g. mail that arrived while it was
  stopping), *except* after `bye stop` (an explicit stop). The `/tick` sweep may still wake it
  later.
- agentd drops (doesn't ack) mail that arrives while it is stopping, because pi is about to be
  killed. It forgets an in-flight mail if pi hasn't answered within 30 s.
- Delivery to one run is serialized in the link process, so mail goes out in claim order
  (`createdAt`; ties between the web and link roles are unordered).

**Agent sends.** The `outfitter-mail` pi extension (`packages/agentd/pi-extension/`) gives the model
`outfitter_send {to, text, urgent?}`, which appends a pi `custom` entry
`{customType: "outfitter.mail", data: {to, text, urgent}}`. It reaches the API as an ordinary
`entry` frame (seq/ack replay included). The API turns it into mail for `to`, with id
`sha256(sender session, entry id)` so a replayed frame is a no-op. The recipient sees it as a
user-role message: a one-line note naming the sender and saying the content is another agent's
writing, not instructions (`[outfitter mail from session "<name>" (<id>). … Reply with outfitter_send
to "<id>".]`), then the body between `<<<mail-<nonce>` and `mail-<nonce>>>>`. The nonce is 12
random hex characters per message, so a body can't forge the closing fence, a second header, or
an `[outfitter system]` notice. `urgent` becomes `steer`. The send bounces back to the sender as an
`[outfitter system]` mail instead when:
- the recipient session doesn't exist, or is the sender itself;
- `to` is longer than 64 characters, or the text is empty or longer than 32,000 characters;
- the sender has already sent 30 messages in the last hour.

agentd sets `OUTFITTER_SESSION_ID` in pi's env (after `guru.env`, so a guru can't spoof it) so the
tool can tell the model its own address. Browser text over 32,000 characters gets a 413.

**Wake durability.** A post stores the mail, then schedules one Cloud Task named after the mail id
(env `CLOUD_TASKS_QUEUE`, targeting `POST <link>/api/hooks/tasks/wake`), then tries one inline wake
(in the background for agent sends, so a slow Cloud Run start doesn't stall the sender's frames).
Only the insert can fail the post; a browser post whose wake failed gets 202 with `run: null`, and
must not be resent. `RunManager.wake` is atomic per session (Mongo: partial unique
index `one_active_run_per_session`), so concurrent senders can't start two sandboxes.

Ordering: `seq` is monotonically increasing per run for both `entry` and `event`. The API persists
`entry` frames to Atlas (`entries` collection, unique `{sessionId, entry.id}`), fans `event` frames to
SSE subscribers, and acks.

`run.spec.secrets.litellmBaseUrl` is set by the api from its own `config.litellmBaseUrl`, never from
`guru.env` (security-review-pr15.md finding #1: `guru.env` may not set `LITELLM_BASE_URL` /
`LITELLM_API_KEY` / `LITELLM_AGENT_KEY` at all — denylisted in both `routes/gurus.ts` and agentd's
`guru.ts`). agentd pins it into the spawned pi process's `LITELLM_BASE_URL` env var after `guru.env`
is applied, so the real `secrets.litellmKey` can never be sent to a guru-controlled host.

`run.spec.author` is the session's person, for commit attribution (kernal/docs/git-github-spec.md,
"Attribution"). The api fills it from the session owner's user record, and only when that record has
a `githubEmail` (ideally the person's GitHub noreply address; never the sign-in email, which would
end up in public commit messages): `name` (else the email's local part), `email` (= `githubEmail`)
and `login` (`githubLogin`, when set). Those fields are operator-set for now. Every cloud commit is authored *and* committed by the Outfitter bot
(`Outfitter <noreply@outfitter.invalid>`, pinned as `GIT_AUTHOR_*`/`GIT_COMMITTER_*` both in agentd's
own commits and in pi's environment, after `guru.env`); agentd's checkpoint commits add
`Co-authored-by: <name> <email>` and `On-behalf-of: <name> <email>` trailers, each at most once, and
pi gets the person as `OUTFITTER_AUTHOR_NAME`/`_EMAIL`/`_LOGIN` for tooling that does the same.
`author` is optional: an older api, or a session with no owner, gets the bot alone and no trailers.

`run.spec.guru.model` is the *resolved* model, not necessarily the guru's own `model` field: the
E2.8 laptop preflight (`src/laptop.ts`) substitutes the guru's (or session's) `fallbackModel` (env
`DEFAULT_CLOUD_MODEL` if the guru has none) when the requested model is a laptop-only one (env
`LOCAL_MODELS`) and the laptop tunnel probes offline. When that happens the substitution is also
recorded on the run (`modelFallback: {wanted, used}`, not sent over this socket) so the UI can show
it.

`run.spec.guru.playwrightBeforeCheckpoint` is optional and defaults off. The api copies it from the
guru record of the same name, and only when that value is exactly `true` — a guru saved without the
field (every guru that existed before the field) stays off, and the field is omitted from `run.spec`
rather than sent as false. When it is true, agentd, before the git push or the repo-less workspace
snapshot, runs a Playwright spec already in the workspace against a fresh headless Chromium inside
the Drive. That browser is not the user's Chrome and not the companion extension, and it does not
load laptop cookies. The report is a pi `custom` entry `outfitter.playwright` (`data.status` is
`pass`, `fail`, `skipped`, or `unavailable`; `data.text` is what the transcript shows: the result, a
short log, and `data.screenshotPath` when a screenshot was produced). No spec in the repo is
`skipped` ("nothing to run") and does not fail the checkpoint. If Chromium cannot start, the entry
says so (`unavailable`) and the checkpoint still continues.

`run.spec.guru.allowExternalHtmlResources` (#132) is optional and sent only when true. The api
decides it once per run, from the guru's field of the same name when the run's first `run.spec` is
built, records it on the run, and sends the recorded value on any later `run.spec` for that run.
agentd always appends exactly one HTML preview paragraph to pi's system prompt, inside the single
`--append-system-prompt` argument after the guru's own `appendSystemPrompt` and a blank line: the
external one (http and https stylesheets, scripts, images, and fonts may be linked) when true, the
sealed one (inline CSS only) otherwise. The text lives in
`kernal/.pi/extensions/_shared/html-preview-prompt.ts`, copied to agentd's `src/html-preview-prompt.ts`.
It is never sent as `--system-prompt`, which would replace pi's own prompt. Because any
`--append-system-prompt` stops pi looking for `APPEND_SYSTEM.md` itself, agentd finds that file the
way pi does (the workspace's `.pi/APPEND_SYSTEM.md`, then `$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md`) and,
when the guru has no `appendSystemPrompt` of its own, passes its path as an earlier
`--append-system-prompt`. A guru's own text replaces the file, as it did before.

### Start-up timing

How long a run took to start, recorded on `Run.startup` (`packages/api/src/store/types.ts`) and
summarized by `packages/api/src/startup.ts`:

- api clock, each stamped once: `wakeAt` (the run was created), `providerReturnedAt`
  (`provider.start()` resolved; `warm` from its result when the provider knows), `helloAt` (the
  first accepted `hello`), `specSentAt` (the first `run.spec` sent), `readyAt` (the first status
  that made the run `running`/`idle`: pi spawned, possibly still loading). Plus `provider`.
- agentd clock, relative durations only (so sandbox clock skew doesn't matter): `hello.boot` and the
  `startup` frame's `phases`. `preBooted` is agentd's hint that it waited over a second for its
  assignment (it sat in a warm pool). The api keeps known names only, clamps every number, and bounds the
  list, since the frame is agent-supplied.

Warm or cold: the provider's own `warm` wins. GKE warm mode usually can't tell (it reports true
only if its one GET right after creating the claim already sees it adopted and Ready), so for GKE
the summary derives it (`deriveWarm`): warm when agentd says `preBooted`, or when the pod's boot on
the api clock (`helloAt - boot.bootMs`) came more than two seconds before `wakeAt`. A cold fallback
pod (warm mode, empty pool) finds its assignment at once and boots after the wake, so it reads cold.
Other providers stay unknown.

The summary has four segments that add up to the total: requesting a sandbox (wake -> provider
returned), sandbox starting (-> hello; agentd's own identity-token and connect times nested, and a
warm pod's idle wait left out), preparing the workspace (hello -> run.spec sent, then agentd's clone
/restore/import/spawn phases) and loading pi (pi spawned -> pi ready). The total is wake -> pi ready,
or wake -> ready when agentd sent no phases. `complete` is false only while a newer agentd's
`startup` frame is still expected (at most two minutes after ready). When the phases arrive the link
logs one `{"message":"startup summary", runId, provider, warm, totalMs, requestMs, sandboxMs,
workspaceMs, piMs}` line for Cloud Logging, and every accepted hello logs `agentlink: hello
accepted` (with `reconnect`).

Compatibility: both fields are optional and additive, so no protocol version bump. An api that
predates them ignores `hello.boot` (hello is parsed loosely) and the unknown `startup` frame (unknown
up-frames are ignored); an agentd that predates them just leaves them out and the run gets the
wake -> ready summary. Runs created before `Run.startup` existed get no stamps and show nothing.

## browser ⇄ api (REST)

- `POST /api/sessions` `{guruId, repo?, baseBranch?, branch?, prompt, name?, model?}` → `{session, run}` (`repo` omitted = non-coding session with a scratch workspace; `model` overrides the guru's own model for this session — see the laptop-preflight note above)
- `GET /api/sessions?status=&guru=` → list with `{id, name, status, runState, guru, repo, branch, parentId?, cost, updatedAt}`
- `GET /api/sessions/:id` → metadata + `leafId` + `runState` + `startup` (the reportable run's start-up summary, see "Start-up timing"; `null` before it is ready or for a run that predates it) + `pendingUiRequest` (the active run's `Run.pendingUiRequest`, or `null` when there is none — a stopped or failed run does not keep a stale approval) + `allowExternalHtmlResources` (#132: the HTML preview's starting access, from the same run as `runState`, which keeps it after stopping; the guru's current value when that run has not recorded one yet) + `htmlPreviewAccessByRun` (#147: `{<runId>: boolean}` for every run of the session that recorded a value)
- `GET /api/sessions/:id/entries?after=<entryId>` → pi entries in tree order. An entry an agentd run sent also carries `outfitterRunId` (#147), which is not a pi field; the web picks each HTML preview's starting access from `htmlPreviewAccessByRun` with it, and falls back to `allowExternalHtmlResources`. SSE `entry` events carry the same field. The stored entry and `export.jsonl` stay pi's own.
- `GET /api/sessions/:id/stream` → SSE: `event: entry|event|status|spend|checkpoint|liveness`, `data: <json>`. A `status` event may carry `startup` (the run's start-up summary, see "Start-up timing"): absent means unchanged, `null` means the current run has none (yet), an object replaces it. `liveness` (#182) is `{seenAgoMs?, activityAgoMs?}` for the active run, sent whenever either changes: how long ago agentd last sent any frame (`Run.lastSeenAt`, heartbeats every 15 s) and how long ago pi last wrote an entry or streamed an event (`Run.lastActivityAt`, stamped by the same write that acks a seq frame). Ages, not timestamps, so the browser's clock doesn't matter. Raw `event` frames never cross from the link role to the web role, so this is how the page tells a long LLM call or tool run (quiet, agentd alive: "Working, no output for N min") from a dead one (agentd silent for 60 s: LOAD ERROR).
- `POST /api/sessions/:id/messages` `{text, behavior?}` → stores the text as mail (see "Mailbox"), wakes a run if none is running, returns `{run}`; `behavior` defaults to `followUp`. If the wake fails it returns **202 `{run: null}`**: the mail is queued for Cloud Tasks and `/tick`, so the client must not resend. Text over 32,000 characters is a 413. `POST /api/sessions` behaves the same way for its `prompt` (201 with `run: null` if the first wake failed)
- `POST /api/sessions/:id/abort` · `/stop` (graceful for a `running`/`idle` run: enqueues a `stop`
  down-message through the store and sets `stopping` — see "Run state machine" above; cancels via
  the provider directly for a `queued`/`provisioning` run, which has no live agent to ask) · `/wake`
  · `/ui-response {id,value}`
- `GET /api/sessions/:id/diff` · `GET /api/sessions/:id/export.jsonl`
- `GET|POST|PUT /api/gurus`, `/api/environments`
- `GET /api/me` → `{email}` from `x-goog-iap-jwt-assertion` (dev: `OUTFITTER_DEV=1` → `dev@localhost`)
- `POST /api/hooks/ngrok` → the E2.8 "optional push path": ngrok event subscription delivery for
  `agent_session_start.v0` / `agent_session_stop.v0`, flipping the laptop preflight's cached
  `laptopOnline` immediately instead of waiting out its 60s poll. **Not IAP-gated** — every other
  `/api/*` route requires an IAP session or agentd's Google ID token, but ngrok's own server can
  present neither, so this one route is carved out of that check and instead verifies an
  HMAC-SHA256 signature (env `NGROK_WEBHOOK_SECRET`) over the raw request body in the
  `ngrok-signature` header; an unset secret or bad/missing signature is a 401 with no side effect.

- `POST /api/hooks/tasks/wake` `{sessionId}` and `POST /api/hooks/tick` `{}` (link role; not
  IAP-gated): called by Cloud Tasks and Cloud Scheduler with a Google OIDC token whose audience is
  this service's origin and whose email is env `TASKS_SA_EMAIL`; anything else is a 401 (dev mode:
  the agent dev token). `tasks/wake` wakes the session if it still holds deliverable mail and answers
  `{result: "woken"|"active"|"none"|"held"}` (200 once any run exists, so retries don't stack executions; a
  provider failure is a 500 that Cloud Tasks retries, each retry charged as an attempt). `tick` runs the stale-run and stuck-stopping reconcilers and wakes every
  session with deliverable mail and no active run (held mail is not deliverable: a deploy mismatch,
  or #172's permanent run failure, both released by `POST /api/sessions/:id/mail/retry`; `GET
  /api/sessions/:id`'s `mailNotice` says which) — the in-process `setInterval` loops only run while
  a request keeps a min-instances-0 container alive. Set up by `deploy/mailbox.sh`.

- `POST /api/hooks/warm-pool` `{replicas}` (link role; not IAP-gated): authenticated exactly like
  `/api/hooks/tick` above (Cloud Scheduler's OIDC token, audience = this service's origin, email =
  `TASKS_SA_EMAIL`; dev mode: the agent dev token). Two scheduled jobs (warm-up/warm-down,
  `docs/specs/gke-sandbox-provider.md` §5.3) call this to resize the GKE `SandboxWarmPool`'s
  `spec.replicas` via a merge-patch, clamped to 0..2 regardless of what the caller asks for — the
  API is the only thing that talks to the cluster, so this hook is also the pool's hard ceiling.
  404 when `SANDBOX_PROVIDER=gke` isn't configured here, or the warm pool object itself is missing;
  409 on the rare patch conflict (defensive -- a plain merge-patch of `spec.replicas` has little to
  actually conflict over); 502 if the cluster's endpoint can't be resolved or the patch otherwise
  fails. Returns `{replicas}` (the clamped value actually applied) on success.

Teleport uses `GET /api/sessions/:id/export.jsonl`, `PUT /api/sessions/:id/import` (body: JSONL,
same id, refused while a run is `running`), and `GET /api/sessions` for the picker.

## Personal API tokens (E4.1b)

The "link" role has no IAP session (see "Two origins" above), so it needs its own credential for a
laptop teleport client: a personal API token, format `outf_` + 32 random bytes (base64url),
generated once and shown exactly once. Only its sha256 hash and an 8-char display prefix are ever
stored (`packages/api/src/tokens.ts`, `store/types.ts`'s `ApiToken`) — the plaintext is never
logged or persisted.

- `GET|POST /api/me/tokens`, `DELETE /api/me/tokens/:id` — create/list/revoke, "web"/"all" role
  only (needs an IAP- or already-token-identified caller). A cap of 10 active tokens per owner;
  revoking is owner-scoped (a 404, not 403, for someone else's token id — doesn't confirm it
  exists). The web UI's `/tokens` page is the intended way to create one: it shows the plaintext
  once alongside the exact `OUTFITTER_API`/`OUTFITTER_TOKEN`/`KERNAL_TELEPORT_STORE` lines to set.
- **Verification** (`src/auth.ts`'s `identityFromApiToken`): `Authorization: Bearer outf_...` →
  sha256 hash → store lookup. Unknown and revoked tokens get the same generic 401 (never reveals
  which). `lastUsedAt` is updated at most once a minute per token, best-effort.
- **Where it's accepted**: the **"link" role accepts only this** — no IAP, no dev-mode shortcut
  (`identityFromLinkRequest`), registering the teleport subset of routes
  (`registerTeleportRoutes`: `GET /api/sessions`, `GET /api/sessions/:id`,
  `GET /api/sessions/:id/export.jsonl`, `PUT /api/sessions/:id/import`,
  `POST /api/sessions/:id/stop`, `GET /api/me`), the side-panel session routes and browser
  companion routes (see "Browser companion"), plus `POST /api/hooks/ngrok`. It does not register
  guru, operator, or token-management routes. The **"web"/"all"
  role accepts either an IAP session or an `outf_` token** (`identityFromRequest`) for every route
  above, so a single-process dev/"all" deployment and the token-management routes both work the
  same way; `OUTFITTER_DEV=1` still short-circuits to a fixed `dev@localhost` identity there
  regardless of what's in the header, same as before this story.
- `GET /api/me`'s response includes `linkOrigin` (env `OUTFITTER_LINK_ORIGIN`, "web"/"all" role
  only) — the link service's own origin, so the Tokens page can print the exact `OUTFITTER_API`
  value without the operator having to look it up. Empty by default; the page then says to ask the
  operator for the link URL.

This replaces an earlier `OUTFITTER_IAP_CLIENT_ID` mode in `kernal`'s `OutfitterStore` that tried to
authenticate a laptop client the same way a browser does. That was verified NOT working against a
real deployed API (`docs/reports/critic-review-pr15.md` finding #1): IAP enabled directly on a
Cloud Run service uses Google's managed OAuth client, whose credentials are never available for
programmatic access, so `gcloud auth print-identity-token` could never mint a token IAP would
accept. Personal API tokens on the non-IAP "link" service are the fix; the IAP-token mode has been
removed from `outfitter-store.ts` entirely, not left in as a fallback.

## Browser companion

The Chrome companion (`docs/specs/chrome-companion.md`) calls the **link** role with a Dongle
(`Authorization: Bearer outf_...`), the same credential teleport uses. The web role accepts the
same calls with IAP or that bearer. Identity is the token owner's email or the IAP email
(`req.identity`). An email in the body is ignored.

The link role also registers these existing session routes, unchanged, so the side panel can read
the transcript, steer, answer an approval, Break, and Play without going through IAP:

- `GET /api/sessions/:id/entries`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/ui-response`
- `POST /api/sessions/:id/abort`
- `POST /api/sessions/:id/wake`

`POST /api/sessions/:id/stop` is already on the teleport routes. Play calls `/wake`. Stop calls `/stop`.

`GET /api/sessions` and `GET /api/sessions/:id` were already on the link role. The detail payload
includes `pendingUiRequest` from the active run (`null` when there is none). Guru, operator, and
token-management routes stay off the link role.

One share per session. `PUT` replaces it only when the caller is already the owner; a different
email gets `409`.

| Route | Who | Body / result |
|---|---|---|
| `PUT /api/sessions/:id/browser/share` | caller becomes, or already is, the owner | `{tabTitle, tabUrl}` stored with `ownerEmail` and `createdAt`. A different email already owning the share is `409`. |
| `DELETE /api/sessions/:id/browser/share` | owner | Drops the share. Pending requests become `skipped`. |
| `GET /api/sessions/:id/browser/share` | any authenticated caller | `{tabTitle, tabUrl, ownerEmail, createdAt}` or `404`. No image. |
| `POST /api/sessions/:id/browser/requests` | any authenticated caller | `{id, requesterEmail, status:"pending"}`. `409` when the session has no share. `requesterEmail` is the caller. |
| `GET /api/sessions/:id/browser/requests?status=pending` | owner | Pending requests. Anyone else gets `404` (the queue is not revealed). A capture row is `{id, requesterEmail, status, createdAt}`. An action row also includes `kind`, `selector`, and `text` when the kind is `type`. An inspect row includes `kind: "inspect"` and no console text. |
| `GET /api/sessions/:id/browser/requests/:requestId` | requester or owner | `{id, requesterEmail, status, captureId, createdAt}`. Anyone else gets `404`. |
| `POST /api/sessions/:id/browser/requests/:requestId/revoke` | owner | If not yet `done`, mark `skipped`. |
| `POST /api/sessions/:id/browser/requests/:requestId/fail` | owner | `{error}` is exactly `permission_denied`, `tab_gone`, or `too_large`. A pending request becomes `failed` and the API sends `browser.capture.result` with that error immediately. A repeat of the same `requestId` returns the stored row and does not send another frame or insert another row. `done` or `skipped` is `409`. Anything else is `400`. |
| `POST /api/sessions/:id/browser/captures` | owner | `{requestId, title, url, jpegBase64}` → `{captureId}`. |
| `POST /api/sessions/:id/browser/actions` | any authenticated caller | `{kind:"click", selector}` or `{kind:"type", selector, text}` → `201` `{id, requesterEmail, status:"pending", kind, selector, text?}`. `selector` is a CSS selector. Raw JavaScript is `400` and inserts nothing. `409` when the session has no share. `requesterEmail` is the caller. |
| `POST /api/sessions/:id/browser/actions/:requestId/result` | owner | `{ok:true}` or `{error}` (`denied`, `not_found`, `permission_denied`, `tab_gone`, `not_editable`, `not_shared`). A pending action becomes `done` or `failed`, and the API sends `browser.action.result`. A repeat is `409` and does not send another frame. A capture request is `404`. |
| `POST /api/sessions/:id/browser/inspects` | any authenticated caller | `{}` → `201` `{id, requesterEmail, status:"pending", kind:"inspect"}`. No tab id and no selector. Anything else in the body is `400` and inserts nothing. `409` when the session has no share. `requesterEmail` is the caller. |
| `POST /api/sessions/:id/browser/inspects/:requestId/result` | owner | `{messages, element?}` or `{error}` (`denied`, `not_shared`, `tab_gone`, `permission_denied`, `debugger_attached`). `messages` are console lines. `element` is a short tag/id/class description or null. A pending inspect becomes `done` or `failed`, and the API sends `browser.inspect.result` with Cookie and Authorization header values already stripped. There is no transcript entry and no network-header field. A repeat is `409` and does not send another frame. A capture or action request is `404`. |
| `GET /api/sessions/:id/browser/captures/:captureId` | any authenticated caller, or the session's own sandbox | `Content-Type: image/jpeg` bytes, `X-Content-Type-Options: nosniff`. The Drive downloads with the socket credential: `Authorization: Bearer` the agent id token (dev: `OUTFITTER_DEV_TOKEN`) plus header `x-outfitter-run-token` (that run's `RUN_TOKEN`). That is not a user Dongle, and `OUTFITTER_TOKEN` is not put in the sandbox. A run token for a different session is refused. |

Decoded jpeg over 350,000 bytes is `413`. Bytes live in `browserCaptures`
(`{sessionId, requestId, ownerEmail, requesterEmail, title, url, bytes, createdAt}` plus the
capture `id`). The insert keeps the last 20 captures per session and deletes older ones in that
same write. On success the request is marked `done` and stores `captureId`. The API also appends
one pi custom entry `outfitter.browser.capture` with `{captureId, title, url, requesterEmail}`,
keyed by `requestId` (`entry.id` is `browser-capture:<requestId>`). While a run for the session is
connected or still provisioning, that entry goes to agentd as a `browser.capture.entry` down-frame
and agentd assigns the seq; the api inserts it itself with `maxSeq+1` only when no run is connected
and none is provisioning. Uploading the same `requestId` again returns the original `captureId`
and, once that entry is stored, does not send the down-frame or insert a second entry. `POST
/browser/requests` inserts the pending row in the same store operation that reads the share
(`insertPendingIfShared`); a revoke that has already deleted the share cannot leave a new pending
request behind.

## Run state machine

`queued → provisioning → running ⇄ idle → stopping → stopped | failed`. `idle` means pi is waiting
for input; after `idleStopSeconds` agentd checkpoints and exits (`bye idle`), the API marks the run
`stopped` and the session stays `open`. A new message on an open session with no live run creates a
new run (`wake`) that restores from the last snapshot.

`stopping` is entered by `POST /api/sessions/:id/stop` (see below) while a run is `running`/`idle`:
the graceful path, waiting on agentd to checkpoint and send `bye`. It's an active state (counts for
`findActiveForSession`/`wake`, so no second run starts on the same session while one is stopping) and
a "ready" one for down-message delivery purposes (the agent is still connected, just draining toward
`bye`). If agentd never finishes within `STOP_GRACE_MS` (env, default 60s) of entering `stopping`,
`RunManager.reconcileStoppingOnce` (the same reconciler loop as the stale-run check above) cancels
the sandbox via the provider directly and marks the run `stopped` (`reason: "stop grace expired"`).
A `queued`/`provisioning` run has no live agent to ask gracefully, so `/stop` cancels it via the
provider immediately instead of going through `stopping`.
