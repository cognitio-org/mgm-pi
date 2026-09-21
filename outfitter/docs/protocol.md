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
(`OUTFITTER_ROLE=link`, `--allow-unauthenticated`) serves only `GET /agent/ws` and
`POST /api/hooks/ngrok`, each authenticating its own requests as described in their own sections.
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
`4401` and no `run.spec` is ever sent. The plaintext token itself is never logged or persisted
anywhere.

Close codes the API can send, and how agentd (`TERMINAL_CLOSE_CODES`, `packages/agentd/src/link.ts`)
treats them:

| code | reason | agentd behavior |
|---|---|---|
| `4400` | missing run query param | terminal, exit 1 (misconfiguration) |
| `4401` | unauthorized, or `hello.runToken` missing/incorrect for this run | terminal, exit 1 (misconfiguration) |
| `4404` | run/session/guru not found | terminal, exit 0 (nothing left to do) |
| `4409` | run is in a terminal state already | terminal, exit 0 (nothing left to do) |
| `4412` | run cannot start: missing secret (a repo session with no usable GitHub token) | terminal, exit 1; the API also marks the run `failed` with a reason before closing |
| `1011` | internal error | transient, agentd keeps reconnecting with backoff |

Any other code is treated as transient too. `4412` exists specifically so a run stuck without a
clonable secret fails fast instead of agentd retrying for up to ten minutes (`maxUnspecMs`) with the
run sitting in `provisioning`.

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
| `hello` | `runId, sessionId, agentdVersion, piVersion, lastAckedSeq, runToken` | first frame after connect; `runToken` is `RUN_TOKEN` echoed back (see "Run token" above) |
| `status` | `state: "cloning"\|"restoring"\|"starting"\|"running"\|"idle"\|"checkpointing"\|"stopping", detail?` | on change; the api maps this to `Run.state` (`agentlink.ts`'s `mapStatusToRunState`): `running`/`idle` map straight across, `checkpointing` leaves the run's current state untouched (a mid-turn checkpoint push, not a state change), `stopping` maps to the `Run.state` of the same name, anything else (`cloning`/`restoring`/`starting`) maps to `provisioning`. A `status`/`heartbeat` frame that arrives after the run has already reached a terminal state (`bye` already processed) is ignored — `bye` is final. |
| `entry` | `seq, entry` (a pi session entry exactly as pi writes it to JSONL: message, model_change, compaction, custom, ...) | whenever pi appends to the session file (agentd tails the file; this is the durable transcript) |
| `event` | `seq, event` (a raw pi RPC event: agent_start, message_update, tool_execution_start/update/end, agent_end, extension_ui_request, ...) | streamed for live UI; not persisted except `extension_ui_request` |
| `spend` | `keySpend?, keyMax?, modelGroup?, callId?, estimate?, baseline?` | `keySpend`/`keyMax`/`modelGroup`/`callId` from LiteLLM's `x-litellm-key-spend`/`-max-budget`/`-model-group`/`-call-id` response headers (relayed by the `outfitter-spend` pi extension's `after_provider_response` hook, `packages/agentd/pi-extension/outfitter-spend.ts`, loaded only under agentd -- see E2.11); absent fields mean the response carried no LiteLLM headers at all (non-LiteLLM route) or an incomplete set (e.g. no budget cap, so no `-max-budget`). `estimate` is pi's own cumulative cost estimate for the run so far (agentd's running sum of the extension's own per-response `usage` estimates, `packages/agentd/src/pi.ts`'s `SpendTailer`), independent of LiteLLM's headers -- it is what lets `Run.costEstimate` be real even for a guru whose route never returns spend headers. For an auto-router model group (`claude-auto-llm`, `gemini-auto-llm`, `*-agentic`, `*-affinity`, whose `/model/info` price is all zero because the underlying model is only picked per call), the extension's per-response `usage` estimate is instead computed from the newest assistant message's token counts times the *resolved* model's price (from `x-litellm-model-name`, fetched via `/model/info` at `session_start`) plus `x-litellm-classifier-cost`, rather than pi's own (zero) per-message cost estimate -- see E2.11b. `baseline: true` marks exactly one frame per run, sent from the extension's `session_start` handler before any provider call: `keySpend` on it is the LiteLLM key's balance read from `GET /key/info` *before* this run's first call (rather than a post-call balance from a response header), so the api's "pin `Run.keySpendStart` from the first spend frame seen" logic (`agentlink.ts`) baselines correctly and a one-call run's `cost` is no longer under-reported as 0. If `GET /key/info` fails, no baseline frame is sent and the prior first-response-frame-pins-baseline behaviour applies. |
| `checkpoint` | `branch?, head?, pushed?: boolean, snapshotUrl?, workspaceUrl?` | after each git push / JSONL upload; repo-less runs upload a workspace tarball (`workspaceUrl`) instead of pushing |
| `heartbeat` | `idleSeconds, memMb` | every 15 s |
| `bye` | `reason: "idle"\|"stop"\|"sigterm"\|"error", message?` | last frame |

Down (api → agentd):

| t | fields | effect |
|---|---|---|
| `run.spec` | `session {id, name, cwd:"/workspace"}, repo? {cloneUrl, branch, baseBranch, createBranch} (absent for non-coding sessions: agentd starts with an empty /workspace, or restores `workspace.snapshotUrl`), workspace? {snapshotUrl?}, guru {systemPrompt?, appendSystemPrompt?, model, thinking, tools?, excludeTools?, packages?, env?}, snapshot {url?, jsonl?}, secrets {githubToken, litellmKey, litellmBaseUrl?}, idleStopSeconds, checkpointEvery` | start the run |
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

Ordering: `seq` is monotonically increasing per run for both `entry` and `event`. The API persists
`entry` frames to Atlas (`entries` collection, unique `{sessionId, entry.id}`), fans `event` frames to
SSE subscribers, and acks.

`run.spec.secrets.litellmBaseUrl` is set by the api from its own `config.litellmBaseUrl`, never from
`guru.env` (security-review-pr15.md finding #1: `guru.env` may not set `LITELLM_BASE_URL` /
`LITELLM_API_KEY` / `LITELLM_AGENT_KEY` at all — denylisted in both `routes/gurus.ts` and agentd's
`guru.ts`). agentd pins it into the spawned pi process's `LITELLM_BASE_URL` env var after `guru.env`
is applied, so the real `secrets.litellmKey` can never be sent to a guru-controlled host.

`run.spec.guru.model` is the *resolved* model, not necessarily the guru's own `model` field: the
E2.8 laptop preflight (`src/laptop.ts`) substitutes the guru's (or session's) `fallbackModel` (env
`DEFAULT_CLOUD_MODEL` if the guru has none) when the requested model is a laptop-only one (env
`LOCAL_MODELS`) and the laptop tunnel probes offline. When that happens the substitution is also
recorded on the run (`modelFallback: {wanted, used}`, not sent over this socket) so the UI can show
it.

## browser ⇄ api (REST)

- `POST /api/sessions` `{guruId, repo?, baseBranch?, branch?, prompt, name?, model?}` → `{session, run}` (`repo` omitted = non-coding session with a scratch workspace; `model` overrides the guru's own model for this session — see the laptop-preflight note above)
- `GET /api/sessions?status=&guru=` → list with `{id, name, status, runState, guru, repo, branch, parentId?, cost, updatedAt}`
- `GET /api/sessions/:id` → metadata + `leafId`
- `GET /api/sessions/:id/entries?after=<entryId>` → pi entries in tree order
- `GET /api/sessions/:id/stream` → SSE: `event: entry|event|status|spend|checkpoint`, `data: <json>`
- `POST /api/sessions/:id/messages` `{text, behavior?}` → wakes a run if none is running
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
  once alongside the exact `OUTFITTER_API`/`OUTFITTER_TOKEN`/`MGM_TELEPORT_STORE` lines to set.
- **Verification** (`src/auth.ts`'s `identityFromApiToken`): `Authorization: Bearer outf_...` →
  sha256 hash → store lookup. Unknown and revoked tokens get the same generic 401 (never reveals
  which). `lastUsedAt` is updated at most once a minute per token, best-effort.
- **Where it's accepted**: the **"link" role accepts only this** — no IAP, no dev-mode shortcut
  (`identityFromLinkRequest`), registering exactly the teleport subset of routes
  (`registerTeleportRoutes`: `GET /api/sessions`, `GET /api/sessions/:id`,
  `GET /api/sessions/:id/export.jsonl`, `PUT /api/sessions/:id/import`,
  `POST /api/sessions/:id/stop`, `GET /api/me`) plus `POST /api/hooks/ngrok`. The **"web"/"all"
  role accepts either an IAP session or an `outf_` token** (`identityFromRequest`) for every route
  above, so a single-process dev/"all" deployment and the token-management routes both work the
  same way; `OUTFITTER_DEV=1` still short-circuits to a fixed `dev@localhost` identity there
  regardless of what's in the header, same as before this story.
- `GET /api/me`'s response includes `linkOrigin` (env `OUTFITTER_LINK_ORIGIN`, "web"/"all" role
  only) — the link service's own origin, so the Tokens page can print the exact `OUTFITTER_API`
  value without the operator having to look it up. Empty by default; the page then says to ask the
  operator for the link URL.

This replaces an earlier `OUTFITTER_IAP_CLIENT_ID` mode in `mgm`'s `OutfitterStore` that tried to
authenticate a laptop client the same way a browser does. That was verified NOT working against a
real deployed API (`docs/reports/critic-review-pr15.md` finding #1): IAP enabled directly on a
Cloud Run service uses Google's managed OAuth client, whose credentials are never available for
programmatic access, so `gcloud auth print-identity-token` could never mint a token IAP would
accept. Personal API tokens on the non-IAP "link" service are the fix; the IAP-token mode has been
removed from `outfitter-store.ts` entirely, not left in as a fallback.

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
