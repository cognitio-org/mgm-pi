# Outfitter — epic plan

A self-hosted, low-cost "Cosmos-like" cloud agent system: a fleet of **kernal** agents (pi under the hood)
running in GCP sandboxes, a web UI to start, watch, steer and review them, and two-way **teleport**
between a laptop terminal and the cloud.

Status: planning. Project `outfitter-509211` (org mgmonteleone.com, billing `main-personal`) exists and is
empty. gcloud MCP and ADC are signed in as mgm@mgms.eu.

## 1. Reference points

**Augment Cosmos** (what we are imitating, by priority): event-driven agent wake-up; a sandboxed VM per
session; reusable agent configs (Cosmos calls them "Experts"; Outfitter calls them **Gurus** to keep its own vocabulary); a delegation graph where any guru can launch workers;
shared memory and a codebase context engine; a PR review pipeline with human checkpoints; a session UI
with live transcript plus Terminal/Files/Diffs tabs and queued mid-run steering; multi-model routing;
per-session cost analytics. Cosmos conversations persist forever while the environment pauses after
inactivity and restarts on demand, losing uncommitted state; Cosmos charges $0.19/h compute.

**Claude Code teleport**: transcript stored server-side; pull side verifies same repo, clean tree,
fetches and checks out the pushed branch, imports the transcript as its own copy. `--cloud` clones the
GitHub remote at the current branch, or uploads a `git bundle` when no remote is usable.

**What pi already gives us**: `--mode rpc` (JSON lines over stdio: prompt, steer, follow_up, abort,
events, `extension_ui_request/response` for questions and approvals), JSONL sessions with a `cwd` header
and tree entries, `SessionManager.forkFrom(src, cwd, dir, { id })`, extensions (commands, tools, hooks),
the connect extension's provider registry and LiteLLM spend parsing, and a containerization story
(Docker, OpenShell, Docker Sandboxes, Gondolin). pi 0.86 adds experimental `@earendil-works/pi-server`
and `pi-agent-core` (durable Session, multi-presentation attachment, worker retirement). We speak RPC
today behind one adapter so we can move to pi-server when it stabilises.

## 2. Architecture

```
  laptop (kernal CLI)                     GCP project outfitter-509211                     laptop
  /teleport push|pull  ──HTTPS──▶  ┌───────────────────────────────────────┐  ◀── LM Studio via ngrok
                                   │ outfitter-api  (Cloud Run service)     │      (local-qwen-mlx)
  browser ──IAP (Workspace)──────▶ │  REST + SSE for UI · WS ingress for   │
                                   │  agentd · Jobs provider · secrets     │──▶ LiteLLM router (existing
                                   │  broker · IAP JWT check · static UI   │    Cloud Run, per-guru keys)
                                   └──────┬──────────────┬─────────────────┘
                                          │ Atlas (M0→Flex→M10)   │ GCS (blobs, JSONL snapshots)
                                          ▼                       ▼
                                   ┌───────────────────────────────────────┐
                                   │ outfitter-agent (Cloud Run Job, one   │
                                   │ execution per run)                    │
                                   │  agentd ⇄ pi --mode rpc (kernal image)   │
                                   │  git clone/push · idle-stop · ckpt    │
                                   └───────────────────────────────────────┘
```

### Components

| Component | Runs as | Responsibility |
|---|---|---|
| `outfitter-api` | Cloud Run service, min-instances 0, request-based billing, IAP on the service (`OUTFITTER_ROLE=web`) | Sessions, runs, gurus, environments CRUD; SSE stream to browsers; starts and stops Cloud Run Job executions; serves the built web UI |
| `outfitter-link` | Cloud Run service, min-instances 0, request-based billing, `--allow-unauthenticated` (`OUTFITTER_ROLE=link`) | WebSocket ingress from agentd (auth by the job service account's ID token, audience = this service's own origin); brokers per-session secrets over that socket; persists transcript entries to Atlas; `POST /api/hooks/ngrok` (HMAC-verified). Same image and store as `outfitter-api`, deployed a second time — IAP is service-wide, so it can't gate `outfitter-api`'s browser routes without also gating agentd's WebSocket and ngrok's unauthenticated webhook (see `docs/protocol.md` "Two origins") |
| `outfitter-agent` image | Artifact Registry; executed as a Cloud Run Job (2 vCPU/4 GiB default, 1/2 for cheap gurus) | `agentd` dials the API, clones the repo at the branch, restores the session JSONL, runs `pi --mode rpc` with the guru's flags, forwards events up and prompts down, pushes checkpoints, stops itself after N idle minutes |
| `outfitter-web` | static files served by the API | Fleet list, new session, transcript (pi-web-ui components), steer/queue, questions and approvals, diff tab, cost, teleport command |
| kernal `teleport` extension | laptop | `Store` interface with `GitStore` (phase 1) and `OutfitterStore` (this epic) |
| Sandbox provider interface | library in the API | `local-docker` (dev), `cloudrun-job` (primary), later `gce-spot` and `cloudrun-workerpool` |

### Key decisions and why

- **Cloud Run Jobs, not services, for agents.** A service bills CPU for any held WebSocket and caps a
  request at 60 min. A Job has no ingress, can hold an outbound socket for up to 7 days, and is billed
  only while the execution exists. Idle policy makes the system scale to zero: after N minutes with no
  user activity the run stops; the conversation persists; the next message starts a new execution that
  re-clones and resumes (the Cosmos and Claude Code "environment expired" model).
- **Git is the workspace store for coding sessions; GCS for the rest.** No Filestore, no persistent
  disk. A session may have no repository at all (research, writing, ops work against MCP servers): it
  gets an empty `/workspace` that is tarred to GCS at checkpoints and restored on wake. Coding runs
  clone at start and push to the session branch at checkpoints (after each turn with changes, on
  idle-stop, on abort). Large artifacts go to the GCS bucket either way. Uncommitted changes at a
  forced stop are pushed to `outfitter/<session>` refs.
- **Transcript lives in Atlas as pi entries.** One document per session entry (`{sessionId, id,
  parentId, type, ...}`), so a session is exactly a pi JSONL file and teleport is a query plus concat.
  Blobs over 100 KB (tool output) are offloaded to GCS with a pointer. Snapshot JSONL to GCS every
  checkpoint for cheap full restores.
- **All LLM calls go through the existing LiteLLM router.** Per-guru virtual keys give budgets and
  spend; the connect extension already reads `x-litellm-key-spend`. `local-qwen-mlx` still reaches the
  laptop through the ngrok tunnel, so cloud agents can use the free local model when the laptop is up.
- **ADC everywhere, no shared secrets between our components.** agentd authenticates to the API with
  the job's service-account identity token (audience = API URL). The API then hands the run its
  per-session GitHub token and LiteLLM key over that channel. Humans hit the API through IAP restricted
  to `IAP_MEMBERS` (`mgmonteleone.com`, `serviam-it.hr`, and `matija.turk@gmail.com` as of 2026-09-22;
  outside-org members need IAP's custom OAuth client, `deploy/README.md`); the API reads `x-goog-iap-jwt-assertion` for identity.
- **Atlas tier by phase.** M0 (free) for phases 0–3 with a SCRAM user whose password is in Secret
  Manager; the connection is a single `MONGODB_URI` seam. Move to M10 and `MONGODB-OIDC` with
  `ENVIRONMENT:gcp` (Cloud Run supported, no key material) when uptime matters. Atlas org login via
  Google Workspace SAML is an org setting with no tier requirement and is done in phase 0. Bill Atlas
  through the GCP Marketplace so it is one invoice.
- **Guru = pi configuration.** An guru is stored as YAML (also committable to a repo under
  `.outfitter/gurus/`) and rendered to pi flags and files: `--system-prompt`/`--append-system-prompt`,
  `--model provider/id:thinking`, `--tools`, packages and skills in the run's `PI_CODING_AGENT_DIR`.
  Delegation is a kernal extension tool `outfitter_delegate(guru, prompt)` that creates a child session
  and returns its result; the fleet view groups parent and children.
- **Build vs reuse.** Reuse pi RPC, pi-web-ui for the transcript, the connect extension, LiteLLM,
  gh CLI. Steal designs from OpenHands (action server per sandbox), Vibe Kanban (worktree per agent
  plus adapter), Paperclip (budgets, tickets). Do not adopt OpenHands, Daytona (AGPL parts), E2B
  (self-hosting Firecracker on GCP is a project of its own) or Temporal (ops cost) for v1.

### Cost model (us-central1, from the research)

| Item | Idle | Active |
|---|---|---|
| Agent run, 2 vCPU/4 GiB Job | $0 | ~$0.16/h (1 vCPU/2 GiB ~$0.08/h) |
| API, 0.5 vCPU/512 MiB, request billing | $0 | ~$0.05/h while any agent socket or browser stream is open; first 180k vCPU-s/month free |
| Atlas | M0 $0; Flex ≤ $30/mo; M10 ~$57/mo | same |
| Secret Manager | 6 versions free, then $0.06/version/mo | negligible |
| Artifact Registry, GCS, Pub/Sub, Cloud Build | within free tiers at this scale | |
| LLM tokens | $0 | via LiteLLM; `local-qwen-mlx` free |

Ten agent-hours a day is roughly $2/day of compute. Set a GCP budget alert at $25/month on day one.

### Decisions taken (2026-09-20)

| Topic | Decision |
|---|---|
| Default sandbox size | 1 vCPU / 2 GiB (~$0.08/h). Gurus that build or test override to 2 vCPU / 4 GiB. |
| GitHub auth for runs | Fine-grained PAT in Secret Manager now (contents and pull-requests read/write on selected repos); GitHub App installation tokens in E6. |
| Atlas | M0 in GCP us-central1 (same region as Cloud Run). GCP Marketplace billing link deferred until leaving M0. |
| Idle-stop | 30 min for human-driven sessions, 5 min for delegated worker sessions, plus wake-on-open in the UI. Revisit after measuring real wake times (E2.9). |
| Laptop model in the cloud | Allowed, opt-in per guru or per session, never the default. Guarded by the preflight in E2.8. |
| Vocabulary | Reusable agent configs are **Gurus** (not "Experts"). |
| Session visibility | Org-shared: every signed-in user IAP admits can see and steer every session (as Cosmos treats shared sessions). `Session.ownerEmail` is recorded but not enforced; per-user privacy is a later, one-line check if ever wanted. |
| Operator role (2026-09-22, `docs/reports/operators.md`) | Operators are a config list (`OUTFITTER_OPERATORS`), currently `mgm@mgms.eu` and `matej@mgms.eu`. Operators manage Secret Manager keys and deploy-level settings via `/api/operator/*`. Any signed-in user can still create sessions and edit gurus -- the org-shared policy above is unchanged; operator is an additional capability, not a replacement for it. |
| Outside users (2026-09-22, `docs/reports/kernal-one.md`) | IAP admits `mgmonteleone.com`, `serviam-it.hr` and `user:matija.turk@gmail.com` (`IAP_MEMBERS`). Users outside the org need IAP on a custom External OAuth client (`IAP_OAUTH_CLIENT_ID`, secret `outfitter-iap-oauth-client-secret`), because the Google-managed client admits org-internal users only. They get the same org-shared access as everyone else; none are operators. |
| kernal.one (2026-09-22, `docs/reports/kernal-one.md`) | `app.kernal.one` is the Outfitter web UI (Cloud Run domain mapping onto `outfitter-api`, IAP unchanged); `kernal.one` is a public C64-style landing page (`landing/`, Cloud Run `kernal-web`); DNS in Cloud DNS zone `kernal-one` (project `cognitio-flow`). Cloud Run domain mappings rather than a global load balancer, so idle cost stays at zero. |


## 3. Epics and stories

Each story has a done-when. Stories marked ⇄ can run in parallel with subagents (executor on Sonnet;
research on Sonnet; review on Opus).

### E0 Foundations (this week)

- **E0.1 Repo layout** ⇄: `outfitter/` in this repo with `packages/api`, `packages/agentd`,
  `packages/web`, `image/` (Dockerfile baking `kernal/`), `deploy/` (gcloud scripts, same style as
  litellm-config), `docs/`. Done when `npm test` runs in each package.
- **E0.2 GCP baseline** (user approves before it runs): enable run, artifactregistry, secretmanager,
  iap, cloudscheduler, cloudbuild, pubsub; AR repo `outfitter`; service accounts `outfitter-api` and
  `outfitter-agent` with least-privilege roles (agent: none on GCP beyond logging; api: run.jobs
  executor, secretAccessor on its secrets); budget alert $25; region `us-central1`. Done when
  `deploy/baseline.sh` is idempotent.
- **E0.3 Atlas** (user actions): org project `outfitter`, M0 cluster in GCP us-central1, database user
  in Secret Manager, IP access list open for Cloud Run egress (or Atlas private endpoint later),
  Google Workspace SAML for org login, GCP Marketplace billing link. Done when the API connects with
  ADC-read secret.
- **E0.4 LiteLLM** ⇄: team `outfitter`, virtual key template per guru with budgets, model list.
  Done when `apply-teams.sh` includes it.
- **E0.5 Teleport phase 1–2** (in progress, subagent): `Store` interface, `GitStore`, `/teleport
  push|pull|list`, `kernal --teleport`. Done when the e2e test passes between two directories.

### E1 Sandbox image and agentd

- **E1.1 Image** ⇄: `node:24-bookworm-slim` + git, ripgrep, gh, `kernal/` with packages preinstalled,
  `PI_CODING_AGENT_DIR=/opt/kernal/.pi`, `PI_OFFLINE=1`, non-root user, `/workspace`. Done when
  `docker run … pi --version` and `pi --mode rpc` respond.
- **E1.2 agentd** ⇄: TypeScript, no framework. Reads `OUTFITTER_API`, `RUN_ID`; gets ID token from the
  metadata server (or a dev token locally); opens WebSocket; receives `run.spec` (repo, branch, guru,
  session snapshot URL, secrets); clones; writes session JSONL and opens it with the original id
  (`forkFrom` with `{ id }` into `/workspace`); spawns `pi --mode rpc` with rendered flags; pipes RPC
  events up as `{t:"event", …}` and API messages down (`prompt`, `steer`, `follow_up`, `abort`,
  `ui_response`, `stop`); heartbeat every 15 s; idle timer; checkpoint (git push + JSONL upload) on
  `agent_end`, idle-stop, SIGTERM (Cloud Run gives 10 s; keep pushes small). Done when the local Docker
  provider runs a full turn end to end against a local API.
- **E1.3 Local provider** ⇄: `docker run` with the same env, for development. Done when E1.2's test uses it.
- **E1.4 Model remap on resume**: reuse `pickModelForHost` from the teleport extension.

### E2 Control plane API

- **E2.1 Data model** ⇄ (Atlas): `sessions`, `entries`, `runs`, `gurus`, `environments`, `users`,
  `events` (audit). Indexes on `{sessionId, id}` and `{sessionId, timestamp}`. Done with a schema doc
  and a migration script.
- **E2.2 HTTP API** ⇄: `POST /sessions` (guru, repo, branch or new branch, prompt), `GET /sessions`,
  `GET /sessions/:id` (metadata + leaf), `GET /sessions/:id/entries?after=`, `GET /sessions/:id/stream`
  (SSE), `POST /sessions/:id/messages` (prompt, steer, follow_up), `POST /sessions/:id/abort`,
  `POST /sessions/:id/ui-response`, `POST /sessions/:id/stop`, `GET /sessions/:id/export.jsonl`,
  `GET /sessions/:id/diff`, gurus and environments CRUD. Identity from IAP header; a dev bypass
  only when `OUTFITTER_DEV=1`.
  - **Open decision (finding #5, docs/reports/security-review-pr1.md):** every session route
    currently checks only that a session exists (`getSessionOr404`), not who's asking -- any signed-in
    domain user can read/steer/stop/import over any other user's session. `Session.ownerEmail`
    (store/types.ts) is now recorded from `req.identity.email` on `POST /sessions`, but nothing reads
    it back yet. Plausible either way for an org-wide fleet UI (like a shared Cosmos/Kubernetes
    dashboard) -- decide explicitly whether to add an ownership/role check in `getSessionOr404`
    before this ships past internal use, rather than leaving it as an unreviewed default.
- **E2.3 Run lifecycle**: state machine `queued → provisioning → running → idle → stopped | failed`;
  "wake" creates a new Cloud Run Job execution with per-execution env overrides (`RUN_ID`); "stop"
  cancels the execution after a checkpoint ack; reconciler every minute against
  `gcloud run jobs executions list` for orphans.
- **E2.4 WebSocket ingress for agentd**: verify the Google ID token (audience = API URL, email =
  agent SA); reconnect tolerant (Cloud Run 60 min cap: agentd reconnects at 55 min, API resumes from
  the last acked entry id).
- **E2.5 Secrets broker**: per-session GitHub token (phase 2: GitHub App installation token minted per
  run and repo; phase 1: fine-grained PAT from Secret Manager) and LiteLLM key; never in job env, only
  over the authenticated socket.
- **E2.5b MCP OAuth for cloud runs**: non-coding sessions lean on MCP servers. Gateway servers
  (`ce_knowledge_base`, `headroom`) work with the LiteLLM key. `google_admin` and `augment_admin` use
  OAuth tokens that live in the laptop keychain today; in the cloud the broker holds the refresh
  token per user in Secret Manager (obtained once through the web UI with the same PKCE flow
  pi-mcp-adapter runs), mints an access token per run and passes it in `run.spec.secrets.mcp[server]`,
  which agentd writes into the run's `mcp.json` as a bearer header.
- **E2.6 Cost**: read LiteLLM spend headers relayed by agentd (`after_provider_response` event from
  the connect extension) and Cloud Run execution duration; store per run; expose per session and per
  guru.
- **E2.8 Laptop model preflight**: before a run starts with (or switches to) `litellm/local-qwen-mlx`,
  the API probes the tunnel directly: `GET https://<TUNNEL_DOMAIN_LMSTUDIO>/v1/models` with the
  `LOCAL_TUNNEL_TOKEN` bearer, 3 s timeout, result cached 60 s. ngrok answers with its offline error page
  when the agent is down, LM Studio answers with the model list when up, so one probe covers both. If it
  fails, the session falls back to the guru's cloud model and says so in the transcript as a `custom`
  entry. Optional push path: an ngrok event subscription for `agent_session_start.v0` /
  `agent_session_stop.v0` delivered to `POST /api/hooks/ngrok` flips a cached `laptopOnline` flag
  instantly and steers running sessions off the local model (`set_model` over RPC) when it stops.
  Polling `GET https://api.ngrok.com/tunnels` (online tunnels only, needs an ngrok API key in Secret
  Manager) is the fallback if event destinations are not available on the Hobbyist plan.
- **E2.10 Provider status service** (done, `docs/reports/providers-status.md`): one place that
  knows whether every model and tool provider is usable right now, feeding both the preflight
  (E2.8) and the dashboard (E3.6). `src/providers-status.ts`'s `ProviderStatusService` owns four
  probes -- ngrok (`GET /endpoints` with `NGROK_API_KEY`, one row per online endpoint), laptop
  (reuses the same `LaptopProbe` instance the E2.8 preflight already probes, so no extra network
  round trip beyond its own 60s cache, plus `/api/v0/models` through the tunnel for loaded models
  and context length), LiteLLM (`/health/liveliness`, `/model/info` -- `parseModelInfo` copied
  from `kernal/.pi/extensions/connect/lib.ts` per the story's instruction, not imported -- and
  `/key/info` for spend against budget, keyed by `LITELLM_ADMIN_KEY` or
  `SecretsBroker.defaultLitellmKey()`), and Cloud Run (`CloudRunProvider.countRunningExecutions`,
  new `listExecutions` call, only when `SANDBOX_PROVIDER=cloudrun`). Every probe times out at 3s
  and never throws (Promise.allSettled is a backstop on top of each probe's own try/catch); a
  missing credential or an inapplicable probe (Cloud Run when the provider isn't cloudrun) is
  `"unknown"` with a `detail`, not a poll failure. State lives in a new `providers` Mongo
  collection (memory + Mongo `Store` implementations) as the current row plus a 7-day-bounded
  history of status transitions. `GET /api/providers`, `GET /api/providers/stream` (SSE, pushes on
  transition only), `POST /api/providers/refresh`; the poller (`PROVIDER_POLL_MS`, default 5 min)
  runs only in the "web" role, with a non-blocking first pass at startup; the "link" role still
  gets a `ProviderStatusService` instance so `POST /api/hooks/ngrok` (`routes/hooks.ts`) can call
  `noteLaptopTransition` and update the "laptop" row immediately, same HMAC verification as
  before. Deviations from the story sketch above (scoped down to what E2.8/E3.6 actually need,
  confirm before building further): no OpenRouter probe or `/team/info` (no OpenRouter/team
  usage in this codebase yet); one summary LiteLLM row rather than one per model group (the
  per-model breakdown lives in the row's `meta.models`); no automatic `custom` transcript entry on
  running sessions (E2.10's own scope is the status service and its routes, not steering running
  sessions -- E2.8's existing `set_model` RPC path is the natural place to wire that in later,
  left as a follow-up since it touches agentlink.ts's live-session logic rather than this story's
  files).
  **Poll on read (2026-09-22).** The first deploy showed LiteLLM "down, health check HTTP 0" and the
  laptop's model list unavailable, while both answered in under 0.5 s from a laptop. Cause: the
  web role polled from a background timer, but Cloud Run's default request-based CPU allocation
  (with scale-to-zero) throttles a container between requests, so a poll started at startup stalled
  until its 3 s timeouts fired. There is no background poller now: `GET /api/providers` and the
  stream's first snapshot re-poll when this instance's data is older than `PROVIDER_POLL_MS`, in
  the request, single-flight. Always-allocated CPU would also fix it but costs money for no gain.
  Failure details now name the cause (`timed out after 3000 ms`, `fetch failed`) instead of HTTP 0.
- **E2.12 Image smoke in CI** (done, `.github/workflows/outfitter-ci.yml`): the repo's CI only ran
  on `kernal/**`, so no Outfitter PR had run its tests in CI at all, and image or deploy-env errors
  only surfaced when Cloud Run rejected a revision. The workflow now runs every suite and builds
  both images, boots the API in the link role with the deploy script's environment, and starts pi
  in the sandbox image as the agent user checking that every extension loads.
- **E2.9 Wake latency measurement**: script that wakes a stopped session ten times against the real
  Cloud Run Job and records time to `status running`; sets the idle-stop defaults from data.
  First measurements (2026-09-20, 2.16 GB image, 1 vCPU/2 GiB): execution created to Cloud Run
  start time 38 to 46 s; start time to first WebSocket connect about 3 min (image pull happens
  after start time); prompt to answer 3 s; idle-stop and clean exit verified. Cold wake is about
  4 min today and is dominated by image size, so E1.5 (trim the image) comes before any tuning.
  Ten wakes on the trimmed 681 MB image (2026-09-20, same session woken and stopped ten times):
  93, 97, 111, 113, 118, 128, 134, 145, 172, 177 s; median 123 s. Breakdown of one wake: 32 s
  Cloud Run scheduling, 97 s image pull and container start, 3.5 s agentd to run.spec, 13 s
  session restore, then pi's own extension loading about 15 s. Stop takes 1 to 2 s. Decisions
  from the data: IDLE_STOP_SECONDS=1800 for the deployed services (a 2 min wake is worth avoiding
  far more often than 4 cents of idle); next levers are pi's startup (kernal extensions doing network
  discovery at load) and the image pull, not the API.
- **E1.5 Trim the agent image** (done, `docs/reports/image-trim.md`): multi-stage Dockerfile
  (builder stages for kernal's deps and agentd's build never reach the runtime stage); `pi update`
  (silently failing the whole time -- every image shipped so far had **none** of settings.json's
  packages installed, a correctness bug this also fixes) replaced with `npm ci` against
  `kernal/.pi/npm`'s committed lockfile; TUI/laptop-only packages (`pi-listen`, `pi-powerline-footer`,
  `pi-lsp`, and `open-codebase-index`, whose embeddings point at the laptop's LM Studio) dropped from
  an image-only `settings.json` derived from the real one
  (`image/render-settings.sh`); every platform's native binaries stripped except the build's own
  (`image/strip-native-binaries.sh`; esbuild alone: 285 MB → 11 MB); `COPY --chown` instead of a
  trailing `chown -R` (was costing +461 MB by itself, overlayfs copy-up of every file's metadata).
  Result: **2.16 GB → 681 MB actual content** (932 MB before dropping the index; see report
  section 7), verified on
  both `linux/arm64` and `linux/amd64` (the real Cloud Run target -- `build.sh` now defaults to it;
  an arm64 dev-machine build hits an unrelated glibc gap, `libmvec` never having been built for
  aarch64, that only affects `open-codebase-index`'s native addon and doesn't reproduce on amd64).
  **Did not hit the 600 MB target**: `node:24-bookworm-slim` + git/ripgrep/gh alone is ~500 MB
  before any application code, and the four packages named as required (pi-mcp-adapter,
  pi-web-access, pi-memory, pi-subagents) plus their own provider-SDK weight in
  `@earendil-works/pi-coding-agent` account for the rest; see the report's "Why 600 MB isn't
  reachable" for the full breakdown and the remaining levers (`open-codebase-index` is ~140 MB
  including its deps and is the biggest one left, kept because it's genuinely useful for a cloud
  guru and wasn't on the required-or-excluded list -- left as a product decision, not folded into
  this size pass). Cold-wake-near-one-minute follow-up needs a re-run of E2.9's measurement against
  this image once it's deployed.
- **E1.6 Job container logs** (done, `docs/reports/cost-and-logs.md`): agentd now has a structured
  JSON logger (`packages/agentd/src/logger.ts`) -- one `{"severity":...,"message":...,runId,
  sessionId?,state?,...}` line per event on stdout (human-readable when stdout is a TTY, e.g. local
  dev); `RUN_TOKEN` and `run.spec.secrets` are registered with it so they can never appear in a log
  line, plus unconditional URL-userinfo/secret-query-param redaction. pi's own stderr is routed
  through the same logger at DEBUG (`source: "pi"`), tagged separately from agentd's own INFO lines.
  Still needs confirming against a real Cloud Run Job execution's Logs tab once E1.5/deploy land.
- **E2.11 Spend frames from cloud runs** (done, `docs/reports/cost-and-logs.md`): a new pi extension,
  `packages/agentd/pi-extension/outfitter-spend.ts`, loaded via `-e <path>` only under agentd
  (`renderGuru`'s `spendExtensionPath`, gated on `RunControllerDeps.spendFile`), relays LiteLLM's
  `x-litellm-key-spend` etc. headers plus pi's own per-response cost estimate to
  `OUTFITTER_SPEND_FILE`; agentd tails it (`pi.ts`'s `SpendTailer`, same approach as `SessionTailer`)
  and emits `spend` up-frames with a new `estimate` field (agentd's running total of pi's own cost
  estimate, independent of the LiteLLM headers). The API stores `estimate` on `Run.costEstimate`
  (plain overwrite) alongside the existing `keySpend`-delta `cost`/session-cost logic, so cost is real
  even for a route with no LiteLLM headers at all. `image/Dockerfile` still needs to `COPY` the new
  `pi-extension/` directory and set `OUTFITTER_SPEND_EXTENSION`/wire a real `spendFile` path -- left
  to the image/build-scripts workstream (see the report's "Follow-up").
  **Confirmed on Cloud Run 2026-09-21** (image `b8de53b`, repo-less session, guru `default` on
  `litellm/claude-auto-llm`): spend frames arrive, `keySpendStart` pins to the key's real balance,
  and the second call moved `Run.cost` by ~$0.007. The two accounting defects that run exposed
  (one-call runs showing $0; auto-router gurus estimated at $0) are fixed in E2.11b below.
- **E2.11b Auto-router pricing and first-call baseline** (done, `docs/reports/spend-fix.md`): two
  defects verified against the live LiteLLM router. (1) `/model/info` prices an auto-router group
  (`claude-auto-llm`, `gemini-auto-llm`, `*-agentic`, `*-affinity`) at $0 since its model is picked
  per call, so pi's own per-message cost estimate was $0 for those gurus -- `outfitter-spend.ts` now
  fetches `/model/info` once at `session_start`, and when the requested group's price is
  zero/unknown but the resolved model (`x-litellm-model-name` header) is priced, computes that
  response's cost from the newest assistant message's token counts times the resolved model's price
  plus `x-litellm-classifier-cost`, instead of the (zero) delta. kernal's `connect/lib.ts` gets the same
  fix for the interactive `/budget` panel: an all-zero-priced id containing "auto" is priced as
  unknown-paid (`DEFAULT_PAID`) instead of free. (2) `Run.keySpendStart` used to pin from the first
  real spend frame, which already carries the *post-call* balance, so a one-call run's cost showed
  $0 -- the extension now probes `GET /key/info` at `session_start`, before any provider call, and
  appends a `{ baseline: true, keySpend }` line; agentd forwards it as a `spend` frame with no
  `usage`, and the API's existing "pin from the first frame seen" logic then baselines correctly.
  Both fixes degrade to the prior behaviour on any network failure (logged once to stderr, never
  thrown). `npm test`: agentd 140/140, api 93/93, kernal 219/219.
- **E2.13 Graceful stop confirmed on Cloud Run** (done): `POST /sessions/:id/stop` from the web
  role while the link role holds the socket: `stopping` → `stopped` in 8 s, agentd checkpointed
  (workspace tarball skipped for the repo-less run), sent `bye`, and the Job execution ended
  `Completed` with `succeededCount=1` rather than cancelled. Round two closes here.
- **E2.7 Deploy** ⇄: `deploy/api.sh` builds with Cloud Build, deploys, enables IAP with the domain
  principal. Done when the URL prompts for Google login and rejects a non-domain account.
- **E2.14 Operator role and settings API** (done, `docs/reports/operators.md`): `OUTFITTER_OPERATORS`
  (config.ts) names the operator emails (Decisions table above); `Identity.operator` is computed
  once, in `identityFromRequest` (auth.ts), for the "web"/"all" role only -- link-role token
  identities are always `operator: false`, and `GET /api/me` returns the flag so the web UI's App
  shell can show the Settings nav link. `requireOperator` (auth.ts) is a Fastify preHandler 403ing
  `{error:"operator role required"}`; every `/api/operator/*` route (routes/operator.ts, "web"/"all"
  only) uses it. `GET /api/operator/settings` lists the deployment values (LiteLLM base URL,
  sandbox provider/job, tunnel domain, the operator list) and one row per managed secret (the
  static list plus one `outfitter-litellm-key-<guruId>` per existing guru) -- never a full value,
  only `masked` (last 4 characters, only past 12) and `set`/`updatedAt`/`appliesAt` ("next run" for
  a secret read live via `SecretsBroker` at run start, "next deploy" for one mounted as a container
  env var). `PUT`/`DELETE .../secrets/:name` and `POST .../secrets/:name/test` round out the API;
  `secrets.ts` gained a `SecretAdmin` interface (`GcpSecretAdmin` over the Secret Manager REST API,
  `MemorySecretAdmin` for tests) alongside the existing `SecretsBroker`. `deploy/baseline.sh` grants
  the API service account a new project-scoped custom role (`outfitterSecretAdmin`: create/get
  secrets, add/disable/list versions) instead of `roles/secretmanager.admin`, which is broader than
  needed (secret deletion, IAM policy changes). Web: a `/settings` page (operators only; a
  non-operator opening it directly sees "Operator role required") with the Replace/Test/Disable
  flow from mgm-admin's Connections page, adapted to this codebase's own components.

### E3 Web UI

- **E3.1 Shell** ⇄ — done, `docs/reports/web-ui.md`. Vite + React, served from the API. Fleet list
  with status, guru, repo/branch, cost, last activity, and filters (status/guru; run-state filtering
  fixed in the PR #15 review pass, `docs/reports/review-fixes-api.md`). Not built: parent/child
  grouping.
- **E3.2 Session view** — done, `docs/reports/web-ui.md`. Transcript fed from SSE, composer with
  send/steer/follow-up, abort, stop and wake, questions and permission prompts rendered from
  `extension_ui_request`. Deviation from the sketch below: renders via a lightweight custom
  `EntryItem` component, not `@earendil-works/pi-web-ui` (that package wasn't pulled in) -- see
  `web-ui.md`'s "pi-web-ui" decision. Not built: markdown rendering of message text (rendered as
  plain text/`<pre>` today).
- **E3.3 Diff and files tabs**: `GET /sessions/:id/diff` (agentd runs `git diff base...HEAD` plus
  working tree) rendered with a diff component; file viewer via agentd `read`.
- **E3.4 New session dialog** — done, `docs/reports/web-ui.md`. Guru dropdown, optional repository,
  base branch, prompt; "run locally" hint that prints `kernal --teleport <id>`. Not built: repository
  picker from a configured list or GitHub search via the broker (a plain text field today).
- **E3.5 Cost page**: per session, per guru, per day; LiteLLM key budget bars (reuse the budget
  panel logic from connect/lib.ts).
- **E3.6 Providers dashboard**: a status page (also the landing page's header strip) listing every
  provider from E2.10: ngrok endpoints (online/offline, since when, region, which laptop/host, forwards
  to), the LM Studio models behind each with loaded state, LiteLLM model groups with health, price
  and budget bars, OpenRouter credits, and sandbox capacity (running jobs versus limit). Live via SSE,
  with a 7-day uptime sparkline per endpoint and a "wake laptop model" hint when a guru wants it and
  it is offline. Designed to grow: providers are rows in a table keyed by kind, not hard-coded panels.
  Follow-up (code review N3, `docs/reports/code-review-pr15.md`): `GET /api/providers/stream` is
  already fully implemented server-side (E2.10), but nothing in `packages/web` subscribes to it yet
  (`useProviders` polls once on mount) -- the web strip/dashboard should open it once E3.6 is built.
- **E3.7 Gurus page** (done, `docs/reports/gurus-ui.md`): `/gurus` (nav link "Gurus", org-shared,
  any signed-in user) lists gurus and lets a user create/edit/delete them, with a filterable
  model/fallback-model picker fed by a new `GET /api/models` (LiteLLM `/model/info`, reusing
  providers-status.ts's fetch/parse code, 5 min in-memory cache, plus `LOCAL_MODELS` marked
  `local: true`, auto-router groups marked `auto: true`) and a `GET /api/gurus/meta` for the env
  denylist and valid thinking levels. `DELETE /api/gurus/:id` 409s with a count if any session
  still references the guru and 400s for the `default` guru (a reserved, not-yet-seeded id).
- **E3.8 Session header: model/thinking/context** (done, `docs/reports/gurus-ui.md`): the session
  page's header now shows the model, thinking level and a context-used percentage bar, derived
  entirely from transcript entries the page already has (`packages/web/src/lib/session-header.ts`'s
  `deriveSessionHeader`, a pure function with unit tests) -- zero protocol change. Model from the
  newest of a `model_change` entry or an assistant message's own `provider`/`model`; thinking from
  the newest `thinking_level_change`; context tokens from the newest (non-aborted/error) assistant
  message's `usage`, mirroring pi's own `calculateContextTokens` (`totalTokens` or the
  input+output+cacheRead+cacheWrite sum); the window comes from `GET /api/models`.
- **E3.9 Operator settings page** (done, `docs/reports/operators.md`, E2.14): `/settings`, nav link
  shown only when `GET /api/me`'s `operator` flag is true. Read-only deployment values plus a
  secrets table (masked value, when a change applies, Replace/Test/Disable), following the same
  "no value in URLs, clear the input after save" care as `pages/TokensPage.tsx`.

### E4 Teleport, both directions

- **E4.1 `OutfitterStore`** (done, `docs/reports/api-tokens.md`) — the IAP identity-token mode
  flagged as broken above (verified NOT working 2026-09-21: gcloud cannot mint audience-specific
  identity tokens for user accounts, and IAP's Google-managed OAuth client never accepts
  programmatic access at all) has been **removed entirely**, replaced by personal API tokens
  (E4.1b) on the non-IAP "link" service: `Authorization: Bearer outf_...`, verified by sha256 hash
  lookup (`packages/api/src/tokens.ts`, `src/auth.ts`'s `identityFromApiToken`). The "link" role
  now registers exactly the teleport subset of routes it needs
  (`registerTeleportRoutes`/`registerMeRoute` in `routes/index.ts`) behind a token-only preHandler
  (`identityFromLinkRequest`, no IAP, no dev-mode shortcut); the "web"/"all" role accepts either an
  IAP session or a token (`identityFromRequest`) for the same routes plus token management
  (`GET|POST /api/me/tokens`, `DELETE /api/me/tokens/:id`, capped at 10 active tokens/owner). The
  web UI's `/tokens` page creates and revokes tokens and shows the plaintext once with the exact
  `OUTFITTER_API`/`OUTFITTER_TOKEN`/`KERNAL_TELEPORT_STORE` lines (`OUTFITTER_API` = the link
  service's own origin, surfaced on `GET /api/me` as `linkOrigin` from env `OUTFITTER_LINK_ORIGIN`).
  `kernal/.pi/extensions/teleport/outfitter-store.ts` implements the same `Store` interface as
  `GitStore` (`list`/`get`/`put`) against `OUTFITTER_API`, selected by
  `KERNAL_TELEPORT_STORE=outfitter` via `kernal/.pi/extensions/teleport/store-factory.ts`;
  `OUTFITTER_TOKEN` is now the *only* auth mode (constructing the store without it throws). Neither
  the token nor anything derived from it touches disk. `list()` maps `GET /api/sessions`; `get()`
  pulls `GET /api/sessions/:id/export.jsonl`; `put()` is `PUT /api/sessions/:id/import`, which
  already creates the session server-side when the id doesn't exist yet. Tests: api
  (`test/tokens.test.ts` — creation/list/revoke, the cap, link-role bearer auth incl. malformed and
  revoked tokens, `lastUsedAt` throttling, teleport routes reachable on the link role; `test/
  roles.test.ts` updated for the link role now serving a token-gated route set instead of 404),
  web (`test/client.test.ts` — token client calls, `linkOrigin`), kernal
  (`tests/teleport-outfitter.test.ts` — construction requires both env vars, the corrected 401
  message, list/get/put mapping, stop-then-poll flow, `--force`, timeout) — all against fakes
  (in-memory store / fake fetch), never a real deployed API end to end.
- **E4.2 Cloud → laptop** — store half done, CLI verification not yet wired up. `OutfitterStore.get`
  does the "stop the cloud run first" part: if the session has an active run it calls `POST
  /api/sessions/:id/stop` and polls `GET /api/sessions/:id`'s new `runState` field (small API
  addition, `outfitter/packages/api/src/routes/sessions.ts`, tested in
  `outfitter/packages/api/test/routes.test.ts`) until it's no longer active, 90s timeout, skippable
  with `--force` (threaded through `kernal --teleport <id> --force` and `/teleport pull <id> --force`).
  What `kernal --teleport <id>` does **not** yet do for an Outfitter-backed pull specifically: repo and
  clean-tree verification. That logic already exists in `cli.ts`/`index.ts` and runs unconditionally
  for any store whose manifest carries a `repo` section (same code path GitStore uses) -- it isn't
  Outfitter-specific, and OutfitterStore's `get()` does populate `manifest.repo` (from the session's
  `repo`/`branch`/`checkpoint.head`) when the cloud session has a repo, so the existing check does
  cover it. What's still open is model remap fidelity beyond what `pickModelForHost` already does
  (unchanged, reused as-is) and end-to-end testing against a real deployed API (only unit-tested
  against a fake fetch so far).
- **E4.3 Laptop → cloud** (the direction Claude Code lacks): `/teleport push --cloud [guru]` pushes
  the branch and transcript and asks the API to wake a run that continues the conversation.
- **E4.4 Web "Open in terminal"**: copies the `kernal --teleport` command; and `/teleport` typed inside a
  cloud session replies with it (pi command inside the sandbox).

### E5 Multi-agent

- **E5.1 Gurus as YAML**: schema, validation, `outfitter gurus apply`, repo-local
  `.outfitter/gurus/*.yaml` discovered at run start.
- **E5.2 Delegation tool**: kernal extension `outfitter_delegate` available only in cloud runs; creates a
  child session (same repo, worktree branch `outfitter/<child>`), waits, returns the child's final
  message and diff summary; parent transcript records a `custom` entry with the child id.
- **E5.3 Fleet limits and budgets**: max concurrent runs per guru and globally; LiteLLM budget per
  guru; refuse wake when exceeded, surface in UI.
- **E5.4 Shared memory**: reuse `pi-memory` with its directory backed by a GCS bucket mounted read-write
  (Cloud Run GCS FUSE volume on the Job); org-wide notes that every run sees.
- **E5.5 Agent mailbox** — built 2026-09-22 (protocol.md "Mailbox (E5.5)"; research and decisions
  in `docs/reports/agent-messaging.md`). Peer-to-peer messaging between separate sessions, durable on
  Mongo plus Cloud Tasks. Closes four gaps the old wake path had: `Run.pending` died with a run that
  failed before ready; delivery was at-most-once; a `wake()` error lost the message; and two senders
  could double-wake a session.
  - `mail` collection, addressed to the session: claim with a 60 s lease, and `mail.ack` from agentd
    once pi accepts the prompt (accepted only from the run the mail was delivered to).
  - Re-claim after the lease, or at once on that run's `bye`. 6 attempts, and each mail-driven wake
    counts too, so a session whose runs die before they are ready stops being woken. Exhausted mail
    goes `dead` and bounces to its sender. TTL on acked and dead mail.
  - The browser's first prompt and `POST /messages` use it too, not just agent sends. A failed wake
    answers 202 rather than 500, so the browser doesn't resend.
  - Insert first, then wake. `runs.insertIfNoActive` plus a partial unique index
    `one_active_run_per_session` makes `wake()` atomic. The index is created non-fatally, so existing
    duplicate active runs log a warning instead of failing boot.
  - Wake durability: one named Cloud Task per mail → `POST /api/hooks/tasks/wake`. A Cloud Scheduler
    `POST /api/hooks/tick` every 5 min runs the reconcilers and a mail sweep. Both are OIDC-verified
    against `TASKS_SA_EMAIL`, and `deploy/mailbox.sh` sets them up. No change streams.
  - Agent side: the `outfitter-mail` pi extension adds **`outfitter_send(to, text, urgent?)`** only.
    A send is a pi `custom` entry that rides the existing entry stream, so it survives socket drops
    and dedupes by entry id. Bad sends bounce back as system mail, and so does anything past 30 sends
    per hour per session. **Default delivery is `follow_up`**; `urgent` maps to `steer`.
  - The body reaches the recipient inside a nonce fence and is labelled as another agent's writing.
    It is still a user-role message in an agent with its owner's repo and token; see the open
    decisions below.
  - Open decisions, not built:
    - Whether a user's Stop should pause mail wakes. Today the `bye` after a stop doesn't re-wake,
      but the `/tick` sweep will wake the session for held mail.
    - Whether agent mail may use `steer` at all.
    - Same-owner-only messaging, which needs E2.2's ownership model.
  - Changed from the plan: no `outfitter_inbox` (mail is pushed into the conversation, so an inbox
    would only repeat it). `outfitter_peers` is deferred to E5.2, because it needs a request/response
    channel from pi to the API that delegation needs too. Until then, addresses come from the
    prompt, from a received message's header, or from the delegation that created the child.
  - Pub/Sub is not this layer: it is fan-out of events with no addressing, delay or per-message
    dedupe. Its slot stays E7's socket replacement.
  - Rollout: deploy agentd image and API together. A run on an older agentd ignores `mail` frames,
    so its mail is retried up to 5 attempts and then stops.
- **E5.6 Durable workflows** (multi-step, multi-agent: plan → fan out → gather → next; survives API
  restarts; same store and transport as E5.5, additive not a rewrite). Hand-rolled on Mongo: no engine
  runs on Mongo as its sole store (DBOS/Hatchet/pg-boss are Postgres; Restate/Inngest/Trigger.dev are
  their own servers; LangGraph and Mastra only checkpoint), and Temporal stays rejected (§2). Revisit
  Vercel Workflow DevKit + community `@workflow-worlds/mongodb` once its queueing and scale-to-zero
  story is documented.
  - `workflows` document `{type, version, status, cursor, steps:[{id, status, attempts, input, output,
    idempotencyKey, runAt, lockedUntil}], fanout:{expected, done}}`. Every advance is
    `findOneAndUpdate({_id, version})` + `$inc version`; losers re-read. Side effects keyed by
    `idempotencyKey` (unique index) so a rerun after a crash is a no-op.
  - A step that runs an agent is "E5.5 send + register a completion hook"; the child's `agent_end`
    writes an `outbox` row in the same transaction as `$inc fanout.done`; the updater that observes
    `done == expected` schedules the gather step. Multi-document transactions work on M0.
  - One Cloud Task per step is the timer and retry; `/tick` sweeps orphaned fan-ins and stale leases.
    Zero always-on compute; roughly 500–800 lines of TypeScript.

### E6 Triggers and PR workflows

- **E6.1 Scheduler**: Cloud Scheduler → `POST /automations/:id/fire` with OIDC. Three jobs are free.
- **E6.2 GitHub webhooks**: HMAC-verified endpoint; events (PR opened, check failed, review comment)
  matched to automations; PR Fixer and Reviewer gurus; `gh pr create` from runs.
- **E6.3 Slack** (optional): incoming slash command to start a session, outgoing summary on finish.

### E7 Hardening and cost tuning

- Pub/Sub transport option (agentd publishes events, API consumes via push) to remove held sockets.
- Evaluate Cloud Run worker pools (GA April 2026) for warm agents; `gce-spot` provider for long builds.
- Atlas M10 + OIDC workload identity; Atlas private endpoint.
- Sandbox hardening: OpenShell or Docker Sandboxes inside the job image if untrusted repos are run;
  egress allowlist via VPC connector only if needed (it costs).
- Log retention 30 days; error reporting; uptime check on the API; budget alerts at 50/90/100 %.
- Migrate the RPC adapter to `pi-server` when it leaves experimental.

## 4. MVP cut

E0 + E1 + E2.1–2.4 + E3.1–3.2 + E4.2 gives: start an agent from the browser, with or without a repo, watch and
steer it, stop and wake it, and pull it to the laptop. That is Cosmos capabilities 2, 3 (minimal), 8
and the teleport story, at near-zero idle cost.

## 5. Open questions for the owner

1. Sandbox size default: 1 vCPU/2 GiB ($0.08/h) or 2/4 ($0.16/h)?
2. GitHub auth for runs: start with a fine-grained PAT, or set up a GitHub App from the start?
3. Atlas region and whether to link GCP Marketplace billing now.
4. Idle-stop default: 10 minutes?
5. Do cloud runs get access to `local-qwen-mlx` by default when the laptop tunnel is up?
