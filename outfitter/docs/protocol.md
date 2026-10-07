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
`lastAckedSeq`; the API replays anything after it. On a reconnect of a run that already has its
`run.spec` (the proactive 55-minute rotation ahead of Cloud Run's 60-minute cap, or a dropped
socket), agentd sends `hello` alone and holds everything else until the api's first frame arrives
(the api sends `run.spec` on every `hello`); then it resends its unacked seq frames in order, followed
by the newest held non-seq frames. The api buffers at most 256 frames before it has checked `hello`,
and refuses past that with a terminal `4400`, so a model streaming through the rotation used to kill
its run (#185). On any connection agentd also keeps at most 128 seq frames in flight past the last
`ack` and sends more as acks arrive, so a replay plus live streaming stays inside that buffer against
any api version (a release rolls out agentd before the link). The final `bye` is the exception once
the api has answered: the whole unacked backlog goes out ahead of it, since agentd exits right after.
During a reconnect wait it stays inside the window, as the api may not have accepted the connection.

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
| `event` | `seq, event` (a raw pi RPC event: agent_start, message_update, tool_execution_start/update/end, agent_end, agent_settled, extension_ui_request, ...) | streamed for live UI; not persisted except `extension_ui_request`. agentd adds one field of its own: `agent_settled` carries `lastEntryId`, sent only after agentd has read the session file and sent every entry pi wrote before settling (see "Turn settled") |
| `spend` | `keySpend?, keyMax?, modelGroup?, callId?, estimate?, baseline?` | `keySpend`/`keyMax`/`modelGroup`/`callId` from LiteLLM's `x-litellm-key-spend`/`-max-budget`/`-model-group`/`-call-id` response headers (relayed by the `outfitter-spend` pi extension's `after_provider_response` hook, `packages/agentd/pi-extension/outfitter-spend.ts`, loaded only under agentd -- see E2.11); absent fields mean the response carried no LiteLLM headers at all (non-LiteLLM route) or an incomplete set (e.g. no budget cap, so no `-max-budget`). `estimate` is pi's own cumulative cost estimate for the run so far (agentd's running sum of the extension's own per-response `usage` estimates, `packages/agentd/src/pi.ts`'s `SpendTailer`), independent of LiteLLM's headers -- it is what lets `Run.costEstimate` be real even for a guru whose route never returns spend headers. For an auto-router model group (`claude-auto-llm`, `gemini-auto-llm`, `*-agentic`, `*-affinity`, whose `/model/info` price is all zero because the underlying model is only picked per call), the extension's per-response `usage` estimate is instead computed from the newest assistant message's token counts times the *resolved* model's price (from `x-litellm-model-name`, fetched via `/model/info` at `session_start`) plus `x-litellm-classifier-cost`, rather than pi's own (zero) per-message cost estimate -- see E2.11b. `baseline: true` marks exactly one frame per run, sent from the extension's `session_start` handler before any provider call: `keySpend` on it is the LiteLLM key's balance read from `GET /key/info` *before* this run's first call (rather than a post-call balance from a response header), so the api's "pin `Run.keySpendStart` from the first spend frame seen" logic (`agentlink.ts`) baselines correctly and a one-call run's `cost` is no longer under-reported as 0. If `GET /key/info` fails, no baseline frame is sent and the prior first-response-frame-pins-baseline behaviour applies. |
| `checkpoint` | `branch?, head?, pushed?: boolean, snapshotUrl?, workspaceUrl?` | after each checkpoint; repo-less runs upload a workspace tarball (`workspaceUrl`) instead of pushing. For a repo run agentd commits any uncommitted changes, then pushes when HEAD is the session branch or a branch under `repo.branchPrefix` (default `outfitter/`). `branch` is that checked-out branch, and the api copies an allowed one onto `session.branch`. A detached HEAD or any other branch is not pushed; the frame keeps the session branch. `pushed` says whether this checkpoint sent anything |
| `heartbeat` | `idleSeconds, memMb, sandboxMemMb?, sandboxMemLimitMb?` | every 15 s. `memMb` is agentd's own rss. `sandboxMemMb`/`sandboxMemLimitMb` (#187) are the whole sandbox's peak memory since the previous heartbeat (sampled every 5 s) and its limit, in MiB, from the cgroup gVisor emulates inside the sandbox (or `/proc/meminfo`); absent when neither is readable. Usage is the working set: reclaimable file cache (`inactive_file` in `memory.stat`, absent under gVisor) is subtracted. The api keeps the latest report and the run's high-water mark (`Run.sandboxMemLastMb`/`sandboxMemPeakMb`/`sandboxMemLimitMb`), and when the reconciler fails a silent run whose **last** report was at 80% of its limit or more, its note says the sandbox most likely ran out of memory — an OOM kill takes agentd with it, so nothing else reports it. Since #193 that estimate is the fallback: on GKE the api reads the pod's own termination reason (`Run.sandboxExit`, e.g. `OOMKilled` with exit code 137) shortly after agentd goes quiet, and fails the run with it at once. |
| `bye` | `reason: "idle"\|"stop"\|"sigterm"\|"error", message?` | last frame. The api closes the socket with 1000 once it has stored the bye (and released the run's mail), or 1011 if that failed; agentd waits for a 1000 (or a terminal code), up to 30 s (1 s on SIGTERM), before exiting, reconnecting and sending the bye again after any other close. The frames queued ahead of the bye are then handled even when the socket is the last request keeping an api instance alive (#205). |
| `mail.ack` | `id` | pi accepted a `mail` down-message (its RPC `prompt` response came back `success: true`); the API marks the mail acked |
| `browser.capture.request` | `requestId` | the Drive's `browser_capture` tool (`outfitter-browser.ts`, no tab id) asked for the session's one shared tab. This is not the laptop tool of the same name in `kernal-chrome`, which is absent from the sandbox image. agentd mints `requestId` once per tool call. The api creates that browser-request row (`requesterEmail` is the session owner), or answers at once with `browser.capture.result` `error:"no_share"`. The same `requestId` does not create a second row |
| `github.request` | `reqId, op, args, idempotencyKey?` | agentd asks the api to run one GitHub operation for this session. Not seq/ack replayed — a dropped link retries the request; it is not replayed from `lastAckedSeq`. See "GitHub broker" |
| `browser.action.request` | `requestId`, `kind` (`click` or `type`), `selector`, `text?` | the Drive's `browser_action` tool asked to click or type in the session's one shared tab. Same shape as capture: agentd mints `requestId` once, the api creates the browser-request row (with `kind` and the CSS `selector`; `text` only for `type`), or answers at once with `browser.action.result`. A selector that is not CSS, including raw JavaScript, is `rejected` and inserts nothing. The same `requestId` does not create a second row. This is not `browser_capture` |
| `browser.inspect.request` | `requestId` | the Drive's `browser_inspect` tool asked to read the console and the element selected in DevTools on the session's one shared tab. No tab id. agentd mints `requestId` once. The api creates a browser-request row with `kind: "inspect"`, or answers at once with `browser.inspect.result`. The same `requestId` does not create a second row. This is not `browser_capture` and not `browser_action`. A body that names a tab id is not this frame |
| `preview.open` | `requestId, port, internalUrl, share` | the Drive's `preview` tool asked for a public URL for a dev server on `port` (drive-previews.md, #217). agentd has already bound the ngrok internal endpoint `internalUrl` (`https://p<port>.<preview.internalDomain>`) behind a local proxy; the api creates the public `https://<id>.kernal.run` cloud endpoint forwarding there (secure, or an anonymous time-boxed link when `share`) and answers `preview.result`. agentd waits up to 30s and then tells the tool `timeout`. Not seq/ack replayed. The api (`src/previews.ts`) builds the internal URL itself from the run's label and only checks agentd's value; it's idempotent per run, port and mode, and caps a run at 8 open previews |
| `preview.close` | `port` | the preview on `port` ended: the tool closed it, its ngrok agent died, or the run is stopping (sent before `bye`). The api deletes that preview's public endpoint. Not seq/ack replayed. **Phase 1:** ignored |
| `ide.status` | `reqId?, state, detail?, internalUrl?` | browser IDE (browser-ide.md, #242): how an `ide.open` is going, `installing` → `starting` → `ready` (with `internalUrl`, always `https://ide.<preview.internalDomain>`) or `error` (with `detail`), each with the request's `reqId`. `stopped` comes unprompted, without a `reqId`, when code-server or its tunnel dies. The api accepts only the `reqId` it stored on the run when a person clicked; on `ready` it checks the URL and creates the owner-and-sysops cloud endpoint. Not seq/ack replayed |
| `ide.request` | — | the model called Kernal's `vscode` tool (#273), through `POST /ide` on the preview listener; agentd sends at most one per 20 s. The api treats it like the owner's `POST /api/sessions/:id/ide` (`src/ide.ts` `askForIde`): same checks, same owner-and-sysops endpoint, at most 6 per run per hour, nothing new while a request is pending or the IDE is open. Not seq/ack replayed |
| `startup` | `phases: [{name, ms}]` | when pi answers agentd's readiness probe ("pi ready"), and again after every reconnect until the run ends (the api keeps the first): agentd's start-up phases since `run.spec` arrived (`run.spec received`, `repo cloned`, `workspace restored`, `session import done`, `pi spawned`, `pi ready`), `ms` counted from `run.spec`. Not seq/ack replayed. See "Start-up timing" below |

Down (api → agentd):

| t | fields | effect |
|---|---|---|
| `run.spec` | `session {id, name, cwd:"/workspace"}, repo? {cloneUrl, branch, baseBranch, createBranch, branchPrefix?} (absent for non-coding sessions: agentd starts with an empty /workspace, or restores `workspace.snapshotUrl`), workspace? {snapshotUrl?}, guru {systemPrompt?, appendSystemPrompt?, model, thinking, tools?, excludeTools?, packages?, env?, playwrightBeforeCheckpoint?, allowExternalHtmlResources?, adminTools?, memory?, agentEngine?}, snapshot {url?, jsonl?}, secrets {githubToken, litellmKey, litellmBaseUrl?, ngrokAuthtoken?}, author? {name, email, login?}, preview? {internalDomain}, ide? {version, artifacts {amd64?, arm64?}}, telemetry? {sentry {dsn, tracesSampleRate, environment, release?, logs?, metrics?, agentTraces?, agentContent?, profilesSampleRate?}}, idleStopSeconds, checkpointEvery` | start the run. `telemetry` (fleet settings, docs/reports/sentry-integration-plan.md): present only while an operator has Sentry on for the fleet; agentd starts Sentry with it as the spec arrives. Absent: agentd sends nothing to Sentry. The #424 signals are there only while on (absent: off): logs (agentd's INFO-and-up lines), metrics, agentTraces (gen_ai spans per pi agent run, model call and tool call, src/agent-trace.ts), agentContent (their prompts, outputs and tool input/output, redacted, 8 KB a field), profilesSampleRate. `preview` with `secrets.ngrokAuthtoken` (drive-previews.md, #217): agentd starts the preview listener and pins `OUTFITTER_PREVIEW_PORT`/`OUTFITTER_PREVIEW_TOKEN` for the tool; the credential (ACL `bind:*.<internalDomain>`) stays in a root-only ngrok config, never in pi's env. Absent: no previews. `ide` (browser-ide.md, #241; only with `preview`, for a Tape with `browserIde`): agentd downloads that code-server release from GitHub at once, niced, checks the SHA-256 for its architecture, and moves it root-owned to `/opt/code-server` without the bundled Copilot (`src/ide-install.ts`). A failed install is logged and never fails the run |
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
| `preview.result` | `requestId`, and either `url` (plus `expiresAt` for a share link) or `error`: `not-configured` (previews off, or no credential for this run), `port-not-allowed`, `too-many`, `failed` | answers `preview.open`. No transcript seq. On an error agentd stops that preview's ngrok agent and proxy and sends `preview.close` |
| `ide.open` | `reqId` | browser IDE (#242): the floppy's owner or a sysop clicked "Open in VS Code" (`POST /api/sessions/:id/ide`). agentd waits for the code-server install (#241), starts code-server as `agent` in its own process group behind an `Origin`-keeping proxy and an ngrok tunnel on `ide.<internalDomain>`, and answers with `ide.status` frames. On a Drive without the IDE: `ide.status` `error`. A second `ide.open` for a running IDE is answered `ready` at once |
| `github.credential` | `token, expiresAt?` | a replacement GitHub credential for the git proxy and later checkpoint pushes. The api sends it on each hello, because a reconnect ignores a second `run.spec`, and again before a GitHub App installation token expires. Not seq/ack replayed. An agentd that does not know this frame ignores it |

### Drive previews (#217)

The Drive's `preview` tool (Kernal's `kernal-background`) calls agentd's loopback listener, header
`x-outfitter-preview-token: $OUTFITTER_PREVIEW_TOKEN`, on `127.0.0.1:$OUTFITTER_PREVIEW_PORT` (the
same loopback, token and peer-uid checks as the browser listeners):

| call | answer |
|---|---|
| `POST /previews {port, jobId?, share?}` | `200 {url, port, expiresAt?}`, or `{error, detail}`: `nothing-listening` 409, `port-not-allowed` 400 (outside 1024–65535, or one of agentd's own ports), `not-configured` 503, `timeout` 504, `failed` 502 |
| `DELETE /previews/<port>` | `200 {closed: true}`, idempotent |
| `GET /previews` | `200 {previews: [{port, url, jobId?, share?, expiresAt?}]}` |
| `POST /ide` | `202 {requested: true}`; `429 {error: "too-many"}` inside 20 s of the last; `404` on a Drive without the IDE (#273, Kernal's `vscode` tool; the link goes to the person's page, not the model) |

Opening one: agentd checks something listens on `127.0.0.1:<port>`, starts a local proxy that
forwards HTTP and WebSocket upgrades to that port only (Host rewritten to `localhost:<port>`), starts
an ngrok agent binding `https://p<port>.<internalDomain>` to the proxy, then sends `preview.open`.
A page load through the proxy (a navigation, or a request accepting HTML; never WebSocket or asset
traffic) re-arms idle-stop while the last chat activity is younger than `PREVIEW_IDLE_CAP_MS`
(default 2 h). Every preview closes with the run.

### GitHub broker (phase 3)

GitHub tool calls do not receive the token. `run.spec.secrets.githubToken` is still delivered for git. These two frames are why `API_PROTOCOL_VERSION` is 2: an agentd whose `hello.protocolVersion` is 1 (or missing) is refused with `4409` until that image is redeployed. agentd forwards a closed list of operations; the api runs them with the same resolution as `run.spec.secrets.githubToken` (a per-session PAT, else a GitHub App installation token when that App is configured, else — only when the App is not configured — `outfitter-github-token-default` when `session.repo` is set). A PAT is one token for both. An App installation token is minted twice: the token in `run.spec` is only `contents:write` and `metadata:read` (git over smart HTTP), and the broker mints a second token that also has issues, pull requests, checks, and actions. With the App configured, a failed mint fails that one request with a reason instead of using the shared PAT (#158). The token is not logged. There is no `github_pr.wait_ci` and no arbitrary GitHub passthrough: waiting on CI is the agent polling `github_pr.checks`. GraphQL is used only to reply to a review thread and to resolve one.

`args` is a JSON object. `owner`, `repo` and `head` on `args` are ignored. The api uses the session's repository (`session.repo`: an `owner/repo` shorthand or a `github.com` URL) and the session branch (`session.branch`, else `outfitter/<sessionId>`) as the pull request head.

Reads (`github_pr.view`, `github_pr.list`, `github_pr.checks`, `github_issue.list`, `github_issue.view`, `github_repo.view`, `github_repo.search`, `github_repo.releases`) may omit `idempotencyKey`. Writes (`github_pr.create`, `edit`, `comment`, `reply`, `review`, `resolve`, `merge`, and `github_issue.create`, `comment`, `edit`, `close`, `reopen`) require one. A missing key is `error: "idempotencyKey is required"`. The api remembers the last 100 keys per run (on the run record, not on this socket) and returns that result without calling GitHub again, so a retry after a dropped link does not post twice. Reusing a key returns the first result even if `op` differs.

`github_pr.merge` is `error: "not permitted"` unless the session's guru has `mergeFromCloud: true` (absent or false by default). A missing GitHub permission is the same string. An unknown `op` (including `github_pr.wait_ci`) is `error: "unknown op"`.

`data` matches the local github tools' result objects (`normalizePr`, `normalizeIssue`, repo view, search) so a broker can pass the fields through. `github_pr.list` is `{ pullRequests }`, `github_issue.list` is `{ issues }`, and `github_repo.releases` is `{ releases }`, because `data` on this frame is an object. `github_repo.search` is `{ issues, pullRequests }`. When GitHub sent `X-RateLimit-Remaining` and `X-RateLimit-Reset`, `data.rateLimit` is `{ remaining, reset }` (`reset` is the header's unix seconds). The api backs off when that remaining budget is at or below 10, and never sleeps inside one request for more than 3 seconds. Pull request and issue `state` is the uppercase `OPEN` / `CLOSED` / `MERGED` the local tools report; search rows keep the search API's lowercase state. Bodies the api posts carry `Outfitter, on behalf of @login` when the session owner has a `githubLogin`. `github_pr.create`'s `closes` are issues named by the session branch (and `args.closes`, if sent), not by commit messages — those stay in the sandbox. A pull-request view still returns the pull request when the checks or reviews endpoint is not permitted; `github_pr.checks` itself reports `not permitted`.

### Admin broker (Sysop tools, #287)

Kernal's `outfitter-admin` tools in a Drive reach the admin op registry through agentd's admin
socket (`OUTFITTER_ADMIN_SOCKET`, `/run/outfitter/admin.sock` in the image). It is the `admin` kind
of `agentd/src/broker-socket.ts`, which has the GitHub socket's wire rules: one JSON line per
request, reads resent once after a link drop, writes (with `idempotencyKey`) sent at most once.

| Direction | Frame |
|---|---|
| up | `{t: "admin.request", reqId, op, args, idempotencyKey?}` |
| down | `{t: "admin.result", reqId, ok: true, text}` or `{..., ok: false, error, needsApproval?}` |

- agentd opens the socket only when the tape has a capability that uses it: `run.spec.guru.adminTools`
  is `manage` or `operator`, `memory` is `tool` or `auto`, or `agentEngine` is `true` (E9,
  docs/specs/atlas-agent-engine-and-a2a.md §3.3). Each of the three is sent only when on. It pins
  `OUTFITTER_ADMIN_SOCKET` after the tape's env (empty otherwise), like the GitHub socket, and
  `OUTFITTER_ADMIN_CAPS` to those capabilities, comma-separated in the order `admin,memory,agentEngine`
  (empty when the socket is closed). Kernal registers its admin and session-search tools only when
  `admin` is listed (unset means admin only: a laptop, or an agentd from before E9).
- Every op names the tape capability it needs: `admin` (all of `tapes.*`, `environments.*`,
  `sessions.*`), `memory` (`memory.*`, E9 PR3) or `agentEngine` (`ae.*`, E9 PR4). The api refuses an
  op whose capability the tape lacks (`admin tools are off for this tape`, `memory is off for this
  tape`, `Agent Engine is off for this tape`), so a socket opened for memory never reaches `tapes.*`.
  Neither refusal is audited. A Kernal from before E9 ignores `OUTFITTER_ADMIN_CAPS` and offers its
  admin tools on a memory-only Drive; they all fail this way, so ship the E9 Kernal in the image
  before turning memory on for a tape.
- Memory (E9 PR3): `memory.search {query, type?, limit?}` and `memory.context {query}` are reads,
  `memory.save {type, text, label?, shared?}` an audited write. The identity and repo come from the
  session, never from args. With `memory: auto`, agentd also pins `OUTFITTER_MEMORY_RECALL=1`, and
  Kernal's `outfitter-agentengine` extension (recall.ts, the same code a laptop uses) sends
  `memory.context` with the redacted prompt before each turn (3 s at most, skipped on any failure)
  and puts the answer in the system prompt's `memory` section.
  With `memory` `tool` or `auto`, agentd excludes pi-memory's seven tools and pins
  `PI_MEMORY_DIR` (an empty directory) and `PI_MEMORY_EXIT_SUMMARY=0` after the tape's env. The api
  records `auto` sessions' user prompts and settled final assistant messages with `recordTurn`
  (keyed `<session id>:<entry id>`), never for a session with `origin: "a2a"` or an `a2aTokenId`, and
  never for mail another session sent or Outfitter's own notices (or the turns they start). pi
  records each turn's section changes as system patch messages, so the recalled `memory` block is in
  the session's entries too (session search skips system messages). A `memory.save` with
  `shared: true`, or of a taxonomic term, waits for the owner's approval: shared memory is recalled
  into the other users' prompts.
- The model's shell can reach the socket, so the api decides everything. It reads the tape again on
  every call (and again after an approval wait), so turning a capability off takes effect at once. Ops run as the
  session's owner, with sysop rights only when the owner is an operator and the tape says
  `operator`.
- A delete, an operator op, an `approve` op (E9: answering an Agent Engine execution's review
  pause, `ae.resume`), or a change to a tape with memory or Agent Engine (E9) waits for the owner,
  up to 10 minutes; a change to a tape with admin tools is refused outright. `approve` always asks,
  whoever the owner is; such an op must register its own card (what it answers, with remote text
  clipped and labelled, never the agent's words) and a Drive-only capability. The api resolves the target first and names it on the card (name and full id), then acts
  on that exact record. The request is a row in `adminApprovals` (one per run; claim, decide and
  clear are conditional writes). The owner's session page shows it as a confirm card through the
  `pendingUiRequest` channel, ahead of pi's own question, with id `admin:<approvalId>` and
  `source: "outfitter"` (agentlink strips `source` from pi's events, and the page draws these cards
  differently). Only the session's owner, as a person, sees it (GET and SSE) or can answer it (`POST
  /api/sessions/:id/ui-response`); a Dongle caller and other viewers see pi's question only. After a
  yes the api reads the tape and rights again before running the op. `needsApproval: true` on the
  result means declined, unanswered, or replaced.
- `ae.*` (E9 PR4, Kernal's `agent_engine` tool; `src/admin/ae-ops.ts`): `ae.list` (read: the
  allowlist's enabled agents), `ae.invoke {agent, message, wait?}` (write, audited as
  `<agent>/<executionId>`; streams `invokeStream` for up to `wait` seconds, default 120, max 280,
  then reports `completed|running|suspended|failed`), `ae.get {executionId}` (read) and `ae.resume
  {executionId, decision, notes?}` (`approve`: the card names the agent and execution, quotes the
  pause's reason and context JSON-escaped and clipped as the remote agent's words, and shows the
  decision, which must be one of its `allowed_decisions`). Only agents listed and enabled in
  `aeAgents` (Settings → Agent Engine agents: `GET|POST /api/operator/agent-engine/agents`,
  `PUT|DELETE …/:id`, sysops on the web role, changes by a person only, audited `via: "web"`) are
  callable, and `get`/`resume` reach only executions the same session started (`aeSessions`).
  Requests carry `X-Session-ID: outf-<session8>-<agent>` and
  `X-Mdb-Agent-Engine-Custom-Outfitter-Session: <session8>` (a UUID's last 8 characters), never an
  email or the CLI's test-session headers. Results are capped at 8 KB, with the remote part between
  `[from Agent Engine agent <id>]` and `[end of Agent Engine agent <id>]`. When the session has no
  active run, is archived or is formatted, the link role's tick stops the Agent Engine sessions it
  opened (`runtime-sessions/{id}/stop`, best effort; a refusal leaves the agent's idle TTL to
  release it).
- A write's `idempotencyKey` is remembered on the run (hashed, next to the GitHub keys), so a replay
  returns the first result. At most 8 admin requests per run are handled at once.
- No `API_PROTOCOL_VERSION` bump: an older api never sends `adminTools`, `memory` or `agentEngine`,
  so an agentd never opens the socket against it; an older agentd ignores `memory` and
  `agentEngine` (the socket then opens for admin tools only, as before).
- Reads (no `idempotencyKey`, resent once) are the ops ending in `.list`, `.get`, `.meta`,
  `.search`, `.transcript` or `.context` (`memory.context`, the recall before each prompt);
  everything else is a write. `registerAdminOp` refuses an op whose class disagrees with its name.

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

**Run keys and settings (CA-6, #395, docs/specs/central-auth.md §9).** With router key minting on
(`LITELLM_ADMIN_KEY`), a run of a session with an owner gets its own LiteLLM key in
`secrets.litellmKey`: alias `outfitter-run-<runId>`, the owner's `user_id`, LiteLLM `duration` 24 h
(the agent job's task timeout), budget the fleet setting `router.runKey.maxBudgetUsd` (default
20 USD) and models `router.keys.models` (default all) (`central/run-keys.ts`). It is minted once, on the
run's first spec; a reconnect of a running run gets `litellmKey: ""` (agentd keeps its first spec).
A spec re-sent while the run still provisions never deletes a key that may have gone out: it gets the
shared key while the fallback is on, otherwise an additional key `outfitter-run-<runId>-<n>`.
The api deletes all of the run's keys when its `bye` is stored; a run that ends any other way leaves its key
to LiteLLM's expiry and the tick's sweep. Without minting, without an owner, and for an A2A session
the key is the shared one as before; while `OUTFITTER_RUN_KEY_FALLBACK` is on (the api's default when
unset) a failed mint also falls back to it, and with it off (`deploy/config.env` since CA-10, #399)
the spec build fails retryably (1011).

`run.spec.settings?` `{ schemaVersion, profile, values: { "<key>": { value, source, sourceName? } } }`
is the owner's resolved central settings (their default profile, no device level; `router.*` and
`telemetry.*` left out). Absent without an owner, for an A2A session, or when they can't be resolved.
agentd (`src/settings.ts`) fills only what the tape leaves unset: `model.default` → `guru.model` when
it is blank, `model.thinking` → `guru.thinking`, `compaction.summaryModel` → `KERNAL_SUMMARY_MODEL`
in `guru.env`; and it passes the whole set to Kernal as `KERNAL_RUN_SETTINGS` (JSON, values only).
`memory.mode` is not applied in a Drive: Agent Engine memory there is the tape's capability.

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

### Turn settled (E9 §1)

pi's `agent_settled` event means the turn is over: no retry, compaction retry or queued message
remains. agentd tails pi's session file every 250 ms, so the turn's last entry can still be unread
when the event arrives. agentd therefore reads the file first, the way a checkpoint does, and only
then sends the event, with `lastEntryId` (the id of the last `entry` it has sent this run; absent
when pi has written none since the restored transcript). Events pi emits during that read wait
and follow in order. The field needs no protocol version: an api that doesn't know it forwards the
event unchanged, and an api that does treats an older agentd's settle, without the field, as a
settle all the same.

The api records `Session.settledAt` (and `settledEntryId`) and finishes *turn waiters*
(`turnWaiters` collection, `src/turns.ts`), the completion signal for A2A tasks and delegation
(EPIC.md E5.2). A waiter is registered for one mail before the mail is posted and finishes once:

1. **settled**: the first `agent_settled` after pi accepted the mail. Acceptance is pi's
   `response` to `mail:<id>` with `success: true`, taken from the same seq stream as the settle
   (seq restarts every run, so only a settle of the same run at a higher seq counts). The
   unsequenced `mail.ack` frame can overtake an earlier settle, so it isn't used for this, except
   as a provisional fallback two minutes after it, when the `response` never showed (only a settle
   after the run's last recorded one counts, and a late `response` replaces it). A settle is never
   matched to a mail id: other mail can settle the same turn. A replayed settle (seq not above the
   session's `settledSeq` for that run) doesn't rewrite the session.
2. **ended, run_stopped / run_failed**: the run that accepted the mail reached `stopped` or
   `failed` first (on its `bye`, or found by the tick for a run that ended without one).
   **mail_dead / mail_held**: the mail can't reach a run.
3. **ended, deadline**: `deadlineAt` starts 60 minutes out. `/api/hooks/tick` pushes it to ten
   minutes past the run's last activity while the run is `provisioning` (counted from its start)
   or `running` with activity in the last ten minutes, never past four hours from registration.
   At expiry the api stops the run that accepted the mail (`reason: "deadline"`), then ends the
   waiter. A mail no run accepted stops nothing; it stays queued.

A finished waiter is never overwritten. Run state `idle` never counts as completion: agentd is
idle before its first prompt. Finished waiters are TTL-deleted after 7 days.

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

- `POST /api/sessions` `{guruId, repo?, baseBranch?, branch?, prompt, name?, model?}` → `{session, run}` (`repo` omitted = non-coding session with a scratch workspace; `model` is the floppy's model, defaulting to the tape's model as it is now. Either way it is pinned on the floppy as `modelOverride`: the tape only seeds a new floppy, and a later tape edit doesn't move existing ones — see `PUT /api/sessions/:id/model` and the laptop-preflight note above)
- `GET /api/sessions?status=&guru=&runState=&archived=` → list with `{id, name, status, runState, guru, repo, branch, parentId?, cost, archivedAt?, canManage, updatedAt}` (`canManage`: whether the caller may archive, restore or format it; `GET /api/sessions/:id` carries it too). Archived floppies are left out unless `archived=only` (just them) or `archived=all`; anything else is a 400
- `GET /api/sessions/:id` → metadata + `leafId` + `runState` + `startup` (the reportable run's start-up summary, see "Start-up timing"; `null` before it is ready or for a run that predates it) + `pendingUiRequest` (the active run's `Run.pendingUiRequest`, or `null` when there is none — a stopped or failed run does not keep a stale approval) + `allowExternalHtmlResources` (#132: the HTML preview's starting access, from the same run as `runState`, which keeps it after stopping; the guru's current value when that run has not recorded one yet) + `htmlPreviewAccessByRun` (#147: `{<runId>: boolean}` for every run of the session that recorded a value)
- `GET /api/sessions/:id/entries?after=<entryId>` → pi entries in tree order. An entry an agentd run sent also carries `outfitterRunId` (#147), which is not a pi field; the web picks each HTML preview's starting access from `htmlPreviewAccessByRun` with it, and falls back to `allowExternalHtmlResources`. SSE `entry` events carry the same field. The stored entry and `export.jsonl` stay pi's own.
- `GET /api/sessions/:id/sandbox?runId=` (#197, web role) → one of the session's runs' sandbox: `run {id, state, provider, createdAt, lastSeenAt?, reason?}`, `memory {lastMb?, peakMb?, limitMb?}` (agentd's heartbeats), `exit?` (`Run.sandboxExit`), `live?` (the provider's `describe`: pod, node, image, phase, start, resource limits; only while the run is active), and `runs` (the session's runs, newest first, for a picker). No `runId` means the active run, else the latest. A `runId` that isn't a UUID or isn't this session's is a 404.
- `GET /api/sessions/:id/sandbox/logs?runId=&pageToken=&pageSize=` (#197) → agentd's log lines for the run from Cloud Logging, read through the `outfitter-sandboxes` log bucket (a sink copies only agentd's lines into it): `{runId, untrusted: true, lines: [{time, severity, message}], nextPageToken?}`, oldest first within a page, where `nextPageToken` fetches the older page. Lines longer than 4000 characters are truncated. `untrusted` is always true: the lines include the model's own output, and any sandbox can write entries claiming another run's id (its service account has logWriter, which Cloud Run needs; #201), so the page shows them as plain text and says so. Answers are cached 20 s per request.
- `GET /api/sessions/:id/sandbox/metrics?runId=` (#197, GKE runs) → `{runId, podName, series: {memoryMb, cpuCores, diskMb}}`, each a list of `[time, value]` per minute from Cloud Monitoring, over the run's lifetime (from 2 min before it was created). The pod comes from the run's own log entries. A Cloud Run run answers 501.
- `GET /api/sessions/:id/previews` (#217, web role) → `{enabled, canShare, shareMaxSeconds, shareDefaultSeconds, previews: [{id, port, share, url, createdAt, expiresAt?}]}`: the active run's open Drive previews (none once it's stopped). Anyone who can open the session. `canShare`: previews are on and the caller may manage the floppy (owner or sysop).
- `POST /api/sessions/:id/previews/:port/share` `{ttlSeconds?}` (#217) → a public, time-limited link for a port the model already previewed (the private preview must be open, which also proves the tunnel is up): `{id, port, share: true, url, createdAt, expiresAt}`. The only way a share link is made; agentlink refuses `share` from a sandbox. Owner or sysop (403 otherwise); 409 with no running Drive or no preview of that port; 503 when previews are off; 429 at the per-run limits. `ttlSeconds` defaults to `PREVIEW_SHARE_TTL_SECONDS` and is clamped to `PREVIEW_SHARE_MAX_SECONDS`.
- `DELETE /api/sessions/:id/previews/:previewId` (#217) → 204: closes one preview (its ngrok endpoint goes). Owner or sysop; 404 when it's already gone.
- The three answer `501 {unavailable: "not-configured"}` where telemetry isn't set up (dev), `503 {unavailable: "forbidden"}` until `gke-iam.sh` has granted access, and `502 {unavailable: "failed"}` if Google fails, and `400 {unavailable: "bad-request"}` for a malformed page token. Audience: anyone who can open the session (owner decision on #196).
- `GET /api/sessions/:id/stream` → SSE: `event: entry|event|status|spend|checkpoint|liveness|live_thought`, `data: <json>`. A `status` event may carry `startup` (the run's start-up summary, see "Start-up timing"): absent means unchanged, `null` means the current run has none (yet), an object replaces it. `liveness` (#182) is `{seenAgoMs?, activityAgoMs?}` for the active run, sent whenever either changes: how long ago agentd last sent any frame (`Run.lastSeenAt`, heartbeats every 15 s) and how long ago pi last wrote an entry or streamed an event (`Run.lastActivityAt`, stamped by the same write that acks a seq frame). Ages, not timestamps, so the browser's clock doesn't matter. Each frame replaces both: an absent age clears the page's copy, so a new run's first frame drops the previous run's activity. Raw `event` frames never cross from the link role to the web role, except `live_thought` (#285): `{text: string | null}`, the open message's thinking text, throttled onto `Run.liveThought` (null once that message is stored or the run leaves `running`). Liveness is how the page tells a long LLM call or tool run (quiet, agentd alive: "Working, no output for N min") from a dead sandbox (agentd silent for 60 s: LOAD ERROR). A pi that hangs while agentd keeps heartbeating also reads as quiet; the minutes keep counting and Break stays available. `checkpoint` (#501) is the session's stored checkpoint, not agentd's frame: `{t: "checkpoint", branch?, head?, landed?, pushed?, at?, landedAt?, pushedAt?}` (`src/checkpoint-wire.ts`; no snapshot or workspace URLs). `head` is the last commit known to be on GitHub, `pushed` says the latest checkpoint sent commits, and `pushedAt` is when one last did (a turn with nothing new moves only `at`/`landedAt`). The link role publishes it as it stores a checkpoint; the web role's poller republishes it whenever the stored one changes, including on its first poll. The poller's cursor is per session, so a second tab on a session already watched gets no event until the next change: the page seeds from `GET /api/sessions/:id`, which carries the same fact as `lastPush: {sha, branch?, at?, pushed} | null`. `at` is `pushedAt` only; a row from before it has the sha and no time (`landedAt` moves on every checkpoint that found nothing new, so it is never shown as a push time). In a combined-role deployment ("all") both publishers fire, so the page may see the same checkpoint event twice; folding it is idempotent. Session responses (`GET /api/sessions/:id`, archive, restore) carry `checkpoint` without `snapshotUrl`/`workspaceUrl`.
- `POST /api/sessions/:id/messages` `{text, behavior?}` → stores the text as mail (see "Mailbox"), wakes a run if none is running, returns `{run}`; `behavior` defaults to `followUp`. If the wake fails it returns **202 `{run: null}`**: the mail is queued for Cloud Tasks and `/tick`, so the client must not resend. Text over 32,000 characters is a 413. `POST /api/sessions` behaves the same way for its `prompt` (201 with `run: null` if the first wake failed)
- `PUT /api/sessions/:id/model` `{model: "provider/id" | null}` → `{modelOverride, model, applied: "live"|"next-run", modelFallback?}`: switches the floppy's model at any time. It is stored as `Session.modelOverride`, which every later `run.spec` uses. `null` copies the tape's model as it is now: a copy, so later tape edits still don't follow. A floppy from before models were pinned (no `modelOverride`) is pinned once, at its first run start: on the last `model_change` in its transcript (or the model that run wanted, if the laptop preflight had swapped in a fallback), else the tape's. A tape's `:<level>` suffix is never pinned: the floppy keeps the bare model, and the spec's `guru.thinking` is the tape's level (its `thinking` field, else that suffix). `POST /api/sessions {model}` gets the same validation as this route. When a Drive is queued, provisioning, running or idle, the api also resolves it through the laptop preflight (recording `Run.modelFallback`) and sends that Drive an `rpc` down-frame with pi's own `{type: "set_model", provider, modelId}` (the provider is everything before the first `/`); agentd holds it until pi is up. pi then writes a `model_change` entry, so the session header shows the switch and the next run's restore doesn't pass `--model` again. A model pi doesn't know comes back as `pi rejected set_model: …` in the run's `statusDetail`. A stopping Drive is left alone (`applied: "next-run"`). `model` is what pi was told: a laptop model with the laptop offline becomes the tape's fallback. `GET /api/sessions/:id` carries `guruModel` (the tape's model now) next to `modelOverride`. When two switches overlap, each reads the floppy again just before sending, so pi ends on what is stored. 400 for anything but `provider/id` (no whitespace, at most 200 characters, no `:<thinking level>` suffix: the tape sets thinking, and pi's `set_model` takes no suffix) or `null`; 409 on an archived floppy. Anyone who can open the session, like sending it a message.
- `POST /api/sessions/:id/abort` · `/stop` (graceful for a `running`/`idle` run: enqueues a `stop`
  down-message through the store and sets `stopping` — see "Run state machine" above; cancels via
  the provider directly for a `queued`/`provisioning` run, which has no live agent to ask) · `/wake`
  · `/ui-response {id,value}`
- `GET /api/sessions/:id/diff` · `GET /api/sessions/:id/export.jsonl`
- `POST /api/sessions/:id/archive` · `/restore` (#207, web role) → `{session}`. Only the session's
  owner (`ownerEmail`, compared case-insensitively) or a sysop may call them; a session with no
  owner is sysop-only; anyone else gets 403. Both are idempotent. Archive sets `archivedAt` and
  stops an active run the same way `/stop` does. While archived, `/wake`, `/messages`,
  `/mail/retry`, teleport `import` and new browser shares, requests, captures, actions and inspects
  answer 409, and an agent's `outfitter_send` to it bounces. Mail already queued stays queued and
  uncharged (the Cloud Tasks wake answers `archived`, `/tick` skips it); already-held mail keeps
  its hold. Restore clears `archivedAt`, so the next `/tick` delivers the queued mail, which starts
  a run.
- `DELETE /api/sessions/:id` (#208, web role; Format) → 204. Same owner-or-sysop rule as archive.
  409 unless the session is archived, and 409 while a run is still active (stopping). Erases the
  session, its entries, runs, mail addressed to it, browser share, requests and captures, and
  disables its GitHub token secret (`outfitter-github-token-<id>`; the api's custom role can't delete
  secrets). Mail it sent to other sessions and its `outfitter/<id>` branch stay. A
  `formattedSessions` record (`{id, formattedAt, formattedBy}`) keeps the id from being re-imported.
  It first claims the session (`formattingAt`), so a racing `/restore` answers 409 rather than
  being overridden. Open `/stream`s for it are ended. A second call is a 404. Mail for a formatted
  id (a leftover Cloud Tasks wake, a dead-letter bounce) is dropped without waking anything, and
  `/wake` on it is a 404.
- `GET|POST|PUT /api/gurus`, `/api/environments`
- `GET /api/me` → `{email}` from `x-goog-iap-jwt-assertion` (dev: `OUTFITTER_DEV=1` → `dev@localhost`)
- Web voice (#252, epic #256; "web"/"all" role). The browser streams the mic straight to Deepgram
  and sends the transcript with `POST /api/sessions/:id/messages` like typed text; nothing reaches
  agentd or pi any other way.
  - `POST /api/voice/token` → `{token, expiresAt, model, language, tag}`: a Deepgram token from
    `/v1/auth/grant` (TTL `VOICE_TOKEN_TTL_SECONDS`, default 30 s; it only has to be valid while the
    socket opens), minted with the Member key `DEEPGRAM_API_KEY` (Secret Manager
    `outfitter-deepgram-key`). The browser authenticates `wss://api.deepgram.com/v1/listen` with it
    through `Sec-WebSocket-Protocol` and must put `tag` (`outfitter-user-` + 16 hex of sha256 of the
    lower-cased email, so Deepgram never sees the address) on every stream for per-person spend
    (#257). 404 `voice_disabled` without a key (the web then offers only the built-in engine), 429
    `voice_rate_limited` with `retry-after` past `VOICE_TOKENS_PER_MINUTE` (default 20, per person,
    per instance), 502 `voice_upstream` when Deepgram refuses or can't be reached.
  - `GET /api/me/voice` → `{deepgram, model, language, prefs: {afterSpeaking, ttsVoice, handsFree}}`;
    `PUT /api/me/voice` with any of `{afterSpeaking: "send"|"review", ttsVoice, handsFree}` → `{prefs}`
    (the rest stay as they are; 400 for an invalid value or nothing to change). `send` (the default)
    sends the transcript when recording stops; `review` leaves it in the composer. `ttsVoice` (#255) is
    a Deepgram Aura id (`aura-2-<name>-<lang>`), default `aura-2-hermes-en`. `handsFree` (default
    false): after a reply has been read the mic reopens, and a pause after speaking sends.
  - `PUT /api/sessions/:id/voice` with `{engine: "deepgram"|"builtin"}` and/or `{speak: boolean}` →
    `{voiceEngine, voiceSpeak}`: the floppy's engine (the mic and spoken replies both use it) and
    whether its replies are read aloud (#255), also on `GET /api/sessions/:id` (absent = `deepgram`,
    off). Anyone who can open the session, like sending it a message.
  - Spoken replies (#255) use the same token: the browser opens
    `wss://api.deepgram.com/v1/speak?model=<ttsVoice>&encoding=linear16&sample_rate=24000&tag=<tag>`
    with `Sec-WebSocket-Protocol: bearer, <token>`, sends `Speak` per sentence then `Flush`, and plays
    the PCM. Only complete `entry` frames reach the web role (no deltas), so a reply is read once it's
    finished.
  - `GET /api/me/voice/spend` (#257) → `{available: false}` without the key and `DEEPGRAM_PROJECT_ID`,
    else `{available: true, currency: "USD", today, week, month, asOf, rates, capUsd?}`, each period
    `{minutes, ttsCharacters, usd}`: the caller's Deepgram use, read from Deepgram's usage API by their
    tag (cached 60 s per instance) and priced at `VOICE_STT_USD_PER_MINUTE` (default 0.0048, Pay As You Go's current nova-3
    price, a promotion; regular 0.0077) and `VOICE_TTS_USD_PER_1K_CHARS` (default 0.03). Periods are UTC: today, the
    week from Monday, the calendar month. 502 `voice_usage_upstream` when Deepgram can't be read.
  - `GET /api/operator/voice/spend` (#257, sysops) → `{available: false}` when not configured, else
    `{available: true, currency: "USD", users, untagged, total, asOf, rates}`: the month so far per tag
    (`users: [{tag, email?, minutes, ttsCharacters, usd}]`, largest first, `email` when a user here has
    that tag), `untagged` (streams with no tag: the laptop's pi-listen, which shares the Deepgram
    project) and `total`. 502 `voice_usage_upstream` when Deepgram can't be read.
  - `VOICE_MONTHLY_CAP_USD` (default 0, off; plain dollars): at or over it (compared in cents),
    `POST /api/voice/token` answers 403 `{error: "voice_cap_reached", capUsd, monthUsd}` and the mic
    uses the built-in engine. A soft cap: it's checked when a stream starts, against usage up to a
    minute or two old, so one long session can run past it. If the usage can't be read within 1.5 s,
    the token is minted anyway.
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
  `{result: "woken"|"active"|"none"|"held"|"archived"}` (200 once any run exists, so retries don't stack executions; a
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
same id, refused while a run is `running` or the session is archived, and 410 for a formatted id), and `GET /api/sessions` for the picker.

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

(#219: since IAP moved to the custom OAuth client in `deploy/config.env`, a service account's OIDC
token for that client ID *is* accepted, in `Proxy-Authorization`. The live-test identity uses it;
see `deploy/README.md` "Live-test identity". Laptop clients still use personal tokens on link.)

## Device login (#390)

Kernal signs in with the person's Google account through a device-code flow (RFC 8628's shape);
the contract is `docs/specs/central-auth.md` §1, the code `packages/api/src/central/device-login.ts`
(logic), `routes/device.ts` (HTTP) and `store/devices.ts` (collections `deviceCodes`, `devices`).

1. `POST /api/device/code` on link (public: `central/device-tokens.ts` `isPublicDevicePath`)
   `{ deviceName, platform?, kernalVersion? }` → `{ device_code: "kdc_…", user_code: "BCDF-GHJK",
   verification_uri, verification_uri_complete, expires_in: 600, interval: 5 }`. The
   `verification_uri` is `OUTFITTER_WEB_ORIGIN` + `/device`.
2. The person opens it on the web role, already signed in through IAP. `GET
   /api/device/pending?code=` shows the device name, platform, version, the requesting IP and time;
   `POST /api/device/approve { userCode, approve }` decides. Only a person: a Dongle or device token
   gets 403. Approving needs the approver on the login allow-list; the approver owns the device.
3. Kernal polls `POST /api/device/token { grant_type: "urn:ietf:params:oauth:grant-type:device_code",
   device_code }`: `authorization_pending`, `slow_down` (+5 s), `access_denied`, `expired_token` or
   `invalid_grant` (400), or 200 with a 1-hour access token (`kda_`), a 30-day refresh token
   (`kdr_`), the device and account, and what the login hooks delivered (`delivery`, `problems`;
   `central/device-lifecycle.ts`).
4. `POST /api/device/refresh { grant_type: "refresh_token", refresh_token }` rotates both. The
   replaced access token stays valid until its own expiry and the replaced refresh token for 60 s;
   a replaced refresh token used after that revokes the device (`refresh-reuse`). Every refresh
   re-checks the allow-list; an owner no longer on it has every device revoked (`access-removed`)
   and gets `access_denied`.
5. `POST /api/device/revoke { token }` (`kernal logout`): always `200 {}`.

The access token is a bearer on every `/api/*` route of every role, like a Dongle and with the same
generic 401, and is verified even in dev mode (`req.identity.deviceId` is set). Tokens are stored
as sha256 hashes only. The Devices page uses `GET /api/me/devices` and `DELETE /api/me/devices/:id`
(a person, web role); operators have `POST /api/operator/devices/revoke { email | domain }` and
`POST /api/operator/machine-tokens { name }` (a 90-day access token for CI, no refresh).

**Allow-list**: `OUTFITTER_LOGIN_ALLOW`, which `deploy/service.sh` builds from IAP_MEMBERS plus the
operators (PREVIEW_ALLOW's format). Operators always count. Empty outside dev mode: no device login
(`503 login_unavailable`) and Dongles unchanged.

**Dongle changes** (#390): no token (Dongle or device) creates tokens (`POST /api/me/tokens`, either
kind: `403 tokens are created in the web app`); no token is ever an operator, on any role; and once
`OUTFITTER_LOGIN_ALLOW` is set, a Dongle whose owner is not on it gets the generic 401.

**Dongles retired** (#399, CA-10): `POST /api/me/tokens` with `kind: "dongle"` or no `kind` answers
`410` (error "Dongles are retired: sign Kernal in with ...", `routes/tokens.ts` `DONGLES_RETIRED`) and stores nothing;
`kind: "a2a"` is unchanged. Existing Dongles keep authenticating (and listing and revoking) until
they expire or are revoked. Kernal no longer sends one.

**Rate limits**, per instance: `/code` 10 per IP per 10 minutes; `/token` 120 per IP per minute;
`/pending` and `/approve` together 20 per person per 10 minutes. Over the limit: `429 { error:
"rate_limited", retryAfter }`. `GET /api/me` includes `ip` (the last X-Forwarded-For hop, which
Cloud Run appends) so the approve page can warn when the code was requested from elsewhere. Every
per-IP check uses that same hop.

## Local hosts (#382, #383)

A signed-in Kernal can share its machine's local models (LM Studio, Ollama, llama.cpp, mlx-lm,
vLLM) with everyone signed in. The contract is `docs/specs/local-host.md`; the code is
`packages/api/src/local-hosts/registry.ts` (heartbeat, listing, delete, device hook),
`local-hosts/tunnel-credentials.ts` (credentials, traffic policies, sweep), `routes/local-hosts.ts`
(HTTP) and `store/local-hosts.ts` (collection `localHosts`, one record per person per machine,
`_id` `lh_` + 24 hex).

- `POST /api/local-hosts/heartbeat` (link, all; device token only) with the discovery snapshot,
  `shareModels` and the tunnel's state → `{ accepted, id, status, nextHeartbeatSeconds: 300,
  credentials, routerPrefix, routerModels, problems }`. Sent on a change (at most every 10 s), every
  300 s while sharing, and on start and stop. `status`: `online`, `offline` (tunnel not up, or its
  server not answering), `not-sharing`, `stale` (no heartbeat for 960 s) or `revoked`.
  `credentials`: `current`, `fetch` (call the next route), `none` (stop the tunnel) or `unavailable`
  (this deployment provisions none; use interim `.env` credentials). A body that fails validation is
  `400 { error: "invalid_heartbeat", field }`; over 256 KiB, 413. Server URLs are stored, never
  fetched.
- `POST /api/local-hosts/tunnel-credentials { hostId }` (link, all; device token only) → an ngrok
  authtoken whose ACL binds only `https://lh<hex>.internal`, the internal endpoint's traffic policy,
  the per-host bearer (`lhb_…`), the public URL `https://lh-<random>.<LOCAL_HOST_DOMAIN>`, allowed
  paths, rate limit, `issuedAt`/`expiresAt` (advisory, 7 days). `Cache-Control: no-store`; Kernal
  keeps it in memory only. Every call mints a new credential (and deletes the previous one); the
  bearer and the cloud endpoint stay. Errors: `404 host_unknown` (heartbeat first, or the host was
  deleted), `409 sharing_off`, `403 host_revoked`, `409 credentials_busy` (another call for the same
  host is running; retry), `404 device not found` (the device was revoked while the call ran), `503 local_host_tunnels_off` (no `NGROK_API_KEY` or
  `LOCAL_HOST_DOMAIN`, which defaults to `PREVIEW_DOMAIN`), `502 ngrok_failed`.
- The cloud endpoint's policy, written only by the api: rate limit 120 per 60 s per client IP, `401`
  without `Authorization: Bearer <bearer>`, `404` JSON outside `/v1/chat/completions`,
  `/v1/completions`, `/v1/embeddings`, `/v1/models`, then `forward-internal` to the host's internal
  endpoint. The internal policy (applied by the laptop) and Kernal's guard proxy check the bearer and
  paths again. The bearer lives in Secret Manager `outfitter-localhost-<hex>`; Mongo has its sha256.
- `GET /api/local-hosts` (every role; a person, or a device token) → `{ hosts }`: the caller's own
  hosts (any status), then everyone else's sharing hosts that are online, offline, or stale for
  under 7 days. No credential, endpoint, bearer, internal URL, device or user id. Strings with
  control or bidi-override characters are refused at the heartbeat.
- `DELETE /api/local-hosts/:id` (the owner, or an operator on web; anyone else 404) → 204: deletes
  the ngrok endpoint and credential, disables the bearer, and leaves a tombstone (not listed; DELETE
  on it 404) that keeps the router prefix for the same person. The laptop's next heartbeat revives
  it. `bearerVersion` only ever goes up for a record, across revokes and deletes.
- A Dongle or personal API token gets `403 device_token_required` on all four; a machine token `403
  machine_token`.
- Revoking a device deletes its hosts' ngrok resources and bearer and marks them `revoked` until a
  heartbeat from a newer login on that machine. Sharing turned off deletes the cloud endpoint (the
  credential stays). The tick's sweep deletes the endpoint of a host stale for over 24 h, and any
  ngrok endpoint or credential stamped `purpose: "outfitter-local-host"` with this `PREVIEW_ENV` that
  no record references (after a 5-minute grace).
- The E2.8 preflight treats a `local/<prefix>/<model>` name (with or without `litellm/`) as a laptop
  model: it is online while its host is `online` and the model is on the tunnel's server.

## A2A server (E9 §5, PR5)

`docs/specs/atlas-agent-engine-and-a2a.md` §5 is the design; this is what the link role (and
"all") serves today. The web role serves none of it.

- **A2A keys** are `ApiToken`s with `kind: "a2a"` and `a2a: {tapes, repos, maxConcurrent}`, made on
  the Dongles page (`POST /api/me/tokens` with `kind: "a2a"`; a person only, never with a token).
  Same format, hash, 90-day TTL and revocation as a Dongle. **Each kind works on its own routes
  only** (`auth.ts`'s `verifyApiToken`): an A2A key gets 401 on `/api/*`, a Dongle gets 401 on
  `/a2a`. A tape with admin tools, `agentEngine`, `memory: "auto"`, `mergeFromCloud`, a non-empty
  `env`, no `tools` list, or a tool outside `A2A_TAPE_TOOLS` (`read grep find ls bash edit write git
  github_pr memory`; never `subagent*`, `agent_engine`, `github_issue`) can't be on a key, and is
  refused again at every task start and every run spec (`a2a/keys.ts`'s `a2aTapeProblem`). Each
  tape also needs its own `outfitter-litellm-key-<tapeId>` secret: an A2A session never gets the
  org-wide `outfitter-litellm-key-default` (`secrets.ts`); without one the key can't be made, a task
  is REJECTED "tape has no dedicated LiteLLM key", and a run is refused (4412).
- **Revoking** an A2A key (Dongles page, or the operator's offboarding revoke) cancels its open
  tasks ("the A2A key was revoked") and stops every Drive it still holds; the tick sweep does the
  same for a key revoked elsewhere (CANCELED) or expired (FAILED "the A2A key has expired"). A
  bearer that failed lookup is refused from a per-instance cache for 60 s without a store read;
  per-IP limiting (Cloud Armor in front of link) is an owner follow-up.
- **`GET /.well-known/agent-card.json`**: public, `Access-Control-Allow-Origin: *`, `Cache-Control`,
  `ETag`/`Last-Modified` (304 on `If-None-Match`). One generic `coding` skill, never a tape name.
  `capabilities.streaming` is false until PR6.
- **`POST /a2a`** (and `/a2a/`): JSON-RPC 2.0, A2A v1.0 method names, `A2A-Version: 1.0` as a
  header or query parameter (missing → -32009). `Authorization: Bearer <A2A key>`; a bad key is
  HTTP 401, over 60 requests a minute per key HTTP 429, a body over 64 KB HTTP 413. A wrong
  content type is -32005, bad JSON -32700.
- **Methods:** `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`, `GetExtendedAgentCard` (the
  key's usable tapes as skills). Push-notification methods are -32003; `SendStreamingMessage` and
  `SubscribeToTask` are -32004 until PR6.
- **Tasks** live in `a2aTasks` (`store/types.ts`'s `A2ATask`), always looked up by key. A new task
  creates a session as the key's owner (`session-create.ts`, the same path as `POST
  /api/sessions`) with `origin: "a2a"`, `a2aTokenId`, name `A2A: <first line>` and branch
  `outfitter/a2a-<task12>` (12 hex characters of the task id), whatever the client sent; its runs
  may push only that branch (`branch-policy.ts`'s `branchPrefixForSession`), and an A2A session
  whose branch isn't `^outfitter/a2a-[0-9a-f]{12,}$` gets no run, no push prefix and no GitHub
  broker writes (fail closed). `PUT /api/sessions/:id/import` is 409 for an A2A session. The prompt is wrapped as untrusted input. The
  tape and repo come from `message.metadata["https://kernal.one/a2a/ext/outfitter-task/v1"]`
  (`{skill?, repo?, baseBranch?}`); outside the key's lists the task is `TASK_STATE_REJECTED` with
  the reason as `status.message`. `contextId` is server-issued, never a session id.
- **States** come from the session's run and the task's turn waiter: SUBMITTED until a run takes
  the mail, WORKING while it works ("waiting for the owner" while a UI request or approval is
  pending; those are never answered over A2A), COMPLETED on settle (with the final assistant text
  as an artifact), FAILED when the turn ends otherwise, CANCELED by `CancelTask` (the run stopped
  with reason `a2a`, unsent mail marked dead). The tick refreshes open tasks.
- A repeated `messageId` from the same key returns the first task. `maxConcurrent` (default 2)
  per key counts open tasks and finished ones whose Drive is still up; one open task per context.
  A blocking `SendMessage` waits at most 25 s (two at once per key per instance), then returns the
  task as it is. Finished rows expire after 30 days; a rejected one keeps no copy of the message.
- An A2A session's agent can't merge, and through the GitHub broker may only read and open its
  own branch's pull request (`github-broker.ts`'s `A2A_GITHUB_OPS`). Internal errors go back as
  "Internal error" only.
- An A2A session's run.spec never carries the tape's `env`. Its Drive's admin socket refuses every
  op when the tape no longer passes `a2aTapeProblem`, and otherwise reaches `memory` only (never
  `admin` or `agentEngine`, whatever the tape gained since). Result, status and (PR6) question text
  go through `search/redact.ts`'s `redact()` before they leave over A2A.
- **What A2A does not isolate (by design):** whatever the owner, or a teammate who can post into
  the session, writes in an A2A session's web view becomes part of its transcript, and a later
  task's answer in the same context may draw on it: write there only what the remote caller may
  read. The caller's answer to an INPUT_REQUIRED question (PR6) reaches pi as plain text, not
  wrapped as untrusted A2A input like the task prompt. "Private" memory (`a2a:<tokenId>`,
  `agentengine/identity.ts`) means per key and per owner within a trusted team, not isolation from the
  team: anyone who can post into the session can steer what is recorded. The tape's own LiteLLM
  key is in pi's environment, and `redact()` is defence in depth only: the remote caller can read
  that key (shared with the owner's runs of the tape and every A2A key listing it, and not revoked
  with the A2A key). Use A2A-only tapes with a budgeted key, and rotate it when you revoke; per-task
  minted keys are a follow-up.
- An A2A session can't send or receive `outfitter_send` mail (a send is a session-file entry its
  `bash` could forge), its run is refused once its key is revoked or expired, it never gets the
  shared `outfitter-github-token-default` PAT or a per-tape LiteLLM secret that copies the org key,
  and the owner's shared browser never answers its capture/action/inspect requests.

## Admin ops (Sysop tools, #286)

`POST /api/admin/ops`, on both origins, with a personal API token (dev mode also accepts the dev
identity). It is the laptop's way into the admin op registry (`packages/api/src/admin/ops.ts`); a
Drive reaches the same registry through agentd's admin socket (#287), not this route.

Request: `{op, args?, confirmed?, laptop?, approvalId?}`. Reply, always `200` for an authenticated
call: `{ok: true, text, state?}` or `{ok: false, error, needsApproval?, approvalId?}`. `text` is compact, capped text meant
for a model, not JSON to parse. Ops so far: `tapes.list|get|meta|create|update|delete`,
`environments.list|get|create|update`, `sessions.list|get|search|transcript` (#289: session search
and compact transcripts; `search` takes `query`, `mode` text (default)|hybrid|semantic (these two fall back to text when they can't run), `owner:"me"`, `tape`,
`repo`, `role`, `session`, `since`/`until` such as `7d`, `limit`; `transcript` takes `id`, `view`
outline|text, `around`, `window`, `from`, `maxChars`, `toolOutput` none|trimmed|full, `roles`).

- A token caller is never a sysop, so operator ops are refused on both origins.
- `delete`s return `needsApproval: true` unless `confirmed` is true (Kernal sends it after the person
  confirms in the TUI).
- Setting a tape's `adminTools`, or changing or deleting a tape that has them, is refused: only a
  sysop does that, in the web UI.
- Setting or changing a tape's `memory` (`off|tool|auto`) or `agentEngine` (boolean) is refused
  (`memory can only be set in the web UI`): a person sets them in the web UI. A body repeating the
  current value passes. Any other change to a tape that has one of them needs `confirmed`.
- `ae.*` ops (capability `agentEngine`) answer `<op> works only in a Drive`.
- `memory.*` (E9.9, docs/specs/atlas-agent-engine-and-a2a.md §3.5) runs as the token's owner: the
  same identity as their Drives (`sha256(ownerEmail)[:16]`), so laptop and cloud share one memory.
  The body's `laptop: {sessionId, repo?}` binds the call: `sessionId` is `laptop:<pi session id>`
  (`^laptop:[A-Za-z0-9][A-Za-z0-9_-]{7,99}$`), `repo` the working directory's GitHub `owner/name`,
  lowercased. Both are checked before any op runs (`laptop.sessionId must be …`, `laptop.repo must
  be …`) and only scope the owner's own memory. A memory op without it answers `memory from a laptop
  needs a newer Kernal`. Without Agent Engine memory configured, `Agent Engine memory is not
  configured on this Outfitter`.
  - `memory.search {query, type?, limit?}`, `memory.context {query}`: reads, as in a Drive. There is
    no tape, so `context` always answers; Kernal sends it only in its `auto` mode.
  - `memory.save {type, text, label?, shared?}`: audited (`via: "token"`). `shared: true` or
    `type: "taxonomic"` waits for the owner's yes in the web app (Laptop approvals, below);
    `confirmed` doesn't count for it.
  - `memory.record {turns: [{entryId, role: "user"|"assistant", text}]}`: 1 to 20 turns, laptop
    only (a Drive is refused). Each text is redacted and capped; relayed mail and Outfitter notices
    are skipped, and raw text over 32,000 characters is refused. It calls `recordTurn` with
    `idempotencyKey = <user hash>:laptop:<pi session id>:<entry id>`. Not audited. Kernal sends it
    only when the person opted in (`kernal.memoryRecord`).
  - At most 120 `memory.*` calls a minute per owner, per api instance; past that, `too many memory
    calls from this Dongle; try again in a minute`.
  - Saves are audited with the laptop's session id.
- Every non-read op that passes those checks writes an `adminAudit` row, except `memory.record`.

### Laptop approvals (E9.9)

On a laptop the agent's shell runs as the person and can read the Dongle, so `confirmed` is not a
boundary for anything that reaches other people. An op registered with `webApproval: true` (today
`memory.save` when shared or taxonomic; #354's laptop `ae.invoke`/`ae.resume` are meant to use the
same thing) asks the owner in the web app's approval widget instead. A Dongle can't answer it.
Code: `packages/api/src/admin/laptop-approvals.ts`, collection `laptopApprovals`.

1. **Create.** The Dongle calls the op as usual, with `laptop`. If the call needs a yes, the api
   stores a pending approval and answers
   `{ok: false, error: "needs your approval in the Outfitter web app", needsApproval: true, approvalId}`.
   - The approval is bound to the token's owner, the op, `argsDigest` (sha256 of the canonical JSON of
     `{op, args}`: keys sorted at every level, `undefined` dropped) and the laptop origin
     (`laptop.sessionId`, `laptop.repo`).
   - It expires 10 minutes after it is created.
   - The same ask while one is still pending gets the same `approvalId`.
   - At most 10 pending per owner. Past that: `10 approvals are already waiting; answer them in the
     Outfitter web app first`.
   - `confirmed: true` is ignored.
   - An `approvalId` that isn't a string (`null`, say) counts as absent.
   - When the op's `laptopCard` returns `{error}`, the call is refused and nothing is asked. For
     `memory.save`, that covers malformed args and shared text or a label holding invisible or
     control characters (zero-width, bidi, Unicode tags, variation selectors, private use).
   - The card then shows exactly what is saved. A shared save also squeezes runs of blank lines to
     one, in the save and on the card alike.
2. **Poll.** `approvals.get {id}`, a read: `{ok: true, text, state}`, where `state` is
   `pending | approved | denied | expired | used`. An unanswered or unused approval past its
   `expiresAt` reads `expired`. A yes moves `expiresAt` to at least 2 minutes after the decision,
   so a yes in the last seconds can still be used. Another owner's id, or an unknown one, answers `no such approval`. From a
   Drive it is refused. Kernal polls every 3 s for up to 10 minutes.
3. **Run.** Repeat the same op, args and `laptop`, adding `approvalId` at the top level of the body
   (not in `args`). `consumeLaptopApproval(store, {ownerEmail, op, args, approvalId, laptop})`
   checks, in one conditional write, that the approval:
   - is `approved`, and unexpired;
   - belongs to the same owner, with the same op, digest, `laptop.sessionId` and repo (or none).

   It then marks the approval `used` and runs the op once, as approved. The audit row carries
   `approved: true, approvalId`.
   - Otherwise nothing runs, and the error says why: `not approved yet; …`, `denied in the Outfitter
     web app`, `that approval expired; ask again`, `that approval was already used; ask again`,
     `that approval was for a different request (…)`, or `no such approval`.
   - A failed check doesn't use up the approval.
   - If the op itself fails after the check, the approval is still used.

**Widget routes** (web role only, behind IAP; not registered on link). Both need a person: a token
identity gets `403`.
- `GET /api/laptop-approvals` → `{approvals: [{id, op, title, facts?: [{label, value}], summary,
  origin: {laptopSessionId, repo?}, createdAt, expiresAt}]}`: the signed-in person's pending,
  unexpired asks, oldest first.
  - `facts` are the api's own words.
  - `summary` is the content the agent sent, which the widget labels as the agent's.
- `POST /api/laptop-approvals/:id {approve: boolean}` → `{ok: true, state}`. It must be JSON
  (`415` otherwise), and `Sec-Fetch-Site`, when sent, must be `same-origin` (`403` otherwise).
  - Another owner's id: `404`. Already answered or expired: `409`. `approve` not a boolean: `400`.
  - Audited in `adminAudit` as `approvals.approve` or `approvals.deny`, with `via: "web"`. Target
    and `approvalId` are the approval id, `sessionId` is the laptop session, and `detail` is
    `<op> <argsDigest>`, which records what was approved after the row's TTL removes it.
  - A refused attempt by a signed-in caller is audited too (`ok: false`, plus `detail: "via a
    token"` for a Dongle).

**For another op.** Register it with `laptop: true, webApproval: true`, an `asks` (or a class that
always asks: `delete`, `operator`, `approve`), and a `laptopCard(args) → {title, facts?, summary} |
{error}`. `registerAdminOp` refuses a `webApproval` op without both.
- The card is one line of what is asked, the api's facts, and the exact content, redacted as the op
  would act on it.
- Resolve anything a prefix or name could later mean differently, and put the resolved id in the
  args the digest covers, or in the card. The Drive path's `resolveTarget` does this before asking.
- `registerAdminOp` lets a `webApproval` op be laptop-callable whatever its capability, and lets an
  `approve` op be laptop-callable only with it.

**Limits (owner check):** the widget is a boundary against the agent's API calls, not against
everything it can do.
- **Same machine.** The agent's shell runs as the person, often on the machine where their browser
  is signed in to the web app. With OS automation (AppleScript, Accessibility) or a browser
  profile's cookies, it could click Approve itself. A WebAuthn or passkey step-up on the decide
  route would close that; it is a follow-up.
- **Dev mode.** Dev mode (`OUTFITTER_DEV=1`) treats every caller as `dev@localhost`, a Dongle
  included, so there anyone can approve.

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
new run (`wake`) that restores the conversation: `run.spec.snapshot.jsonl` is the session's stored
entries as a pi session file (`session-jsonl.ts`), in insertion order with every entry after its
parent (same-second ObjectIds from two processes can sort out of order), and every later root hung
off the entry before it so pi's leaf sees the whole thread. It is built for every `hello` except when
the run is already `running`, `idle` or `stopping`: only agentd reports those states, after applying
its spec, and agentd ignores every later spec. A run still `provisioning` gets it again on a
reconnect, since its first spec may have been lost. agentd imports it and tails the session file
from the end of that import, so restored entries are not sent back up. `snapshot.url` is unused
(agentd reports no `snapshotUrl`); before `jsonl` was filled, every woken run started pi empty.

`stopping` is entered by `POST /api/sessions/:id/stop` (see below) while a run is `running`/`idle`:
the graceful path, waiting on agentd to checkpoint and send `bye`. It's an active state (counts for
`findActiveForSession`/`wake`, so no second run starts on the same session while one is stopping) and
a "ready" one for down-message delivery purposes (the agent is still connected, just draining toward
`bye`). If agentd never finishes within `STOP_GRACE_MS` (env, default 60s) of entering `stopping`,
`RunManager.reconcileStoppingOnce` (the same reconciler loop as the stale-run check above) cancels
the sandbox via the provider directly and marks the run `stopped` (`reason: "stop grace expired"`).
A `queued`/`provisioning` run has no live agent to ask gracefully, so `/stop` cancels it via the
provider immediately instead of going through `stopping`.
