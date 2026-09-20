# Outfitter — epic plan

A self-hosted, low-cost "Cosmos-like" cloud agent system: a fleet of **mgm** agents (pi under the hood)
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
  laptop (mgm CLI)                     GCP project outfitter-509211                     laptop
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
                                   │  agentd ⇄ pi --mode rpc (mgm image)   │
                                   │  git clone/push · idle-stop · ckpt    │
                                   └───────────────────────────────────────┘
```

### Components

| Component | Runs as | Responsibility |
|---|---|---|
| `outfitter-api` | Cloud Run service, min-instances 0, request-based billing, IAP on the service | Sessions, runs, gurus, environments CRUD; SSE stream to browsers; WebSocket ingress from agentd (auth by the job service account's ID token); starts and stops Cloud Run Job executions; brokers per-session secrets; persists transcript entries to Atlas; serves the built web UI |
| `outfitter-agent` image | Artifact Registry; executed as a Cloud Run Job (2 vCPU/4 GiB default, 1/2 for cheap gurus) | `agentd` dials the API, clones the repo at the branch, restores the session JSONL, runs `pi --mode rpc` with the guru's flags, forwards events up and prompts down, pushes checkpoints, stops itself after N idle minutes |
| `outfitter-web` | static files served by the API | Fleet list, new session, transcript (pi-web-ui components), steer/queue, questions and approvals, diff tab, cost, teleport command |
| mgm `teleport` extension | laptop | `Store` interface with `GitStore` (phase 1) and `OutfitterStore` (this epic) |
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
  to the `mgmonteleone.com` domain; the API reads `x-goog-iap-jwt-assertion` for identity.
- **Atlas tier by phase.** M0 (free) for phases 0–3 with a SCRAM user whose password is in Secret
  Manager; the connection is a single `MONGODB_URI` seam. Move to M10 and `MONGODB-OIDC` with
  `ENVIRONMENT:gcp` (Cloud Run supported, no key material) when uptime matters. Atlas org login via
  Google Workspace SAML is an org setting with no tier requirement and is done in phase 0. Bill Atlas
  through the GCP Marketplace so it is one invoice.
- **Guru = pi configuration.** An guru is stored as YAML (also committable to a repo under
  `.outfitter/gurus/`) and rendered to pi flags and files: `--system-prompt`/`--append-system-prompt`,
  `--model provider/id:thinking`, `--tools`, packages and skills in the run's `PI_CODING_AGENT_DIR`.
  Delegation is an mgm extension tool `outfitter_delegate(guru, prompt)` that creates a child session
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


## 3. Epics and stories

Each story has a done-when. Stories marked ⇄ can run in parallel with subagents (executor on Sonnet;
research on Sonnet; review on Opus).

### E0 Foundations (this week)

- **E0.1 Repo layout** ⇄: `outfitter/` in this repo with `packages/api`, `packages/agentd`,
  `packages/web`, `image/` (Dockerfile baking `mgm/`), `deploy/` (gcloud scripts, same style as
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
  push|pull|list`, `mgm --teleport`. Done when the e2e test passes between two directories.

### E1 Sandbox image and agentd

- **E1.1 Image** ⇄: `node:24-bookworm-slim` + git, ripgrep, gh, `mgm/` with packages preinstalled,
  `PI_CODING_AGENT_DIR=/opt/mgm/.pi`, `PI_OFFLINE=1`, non-root user, `/workspace`. Done when
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
- **E2.10 Provider status service**: one place that knows whether every model and tool provider is
  usable right now, feeding both the preflight (E2.8) and the dashboard (E3.6). Sources: ngrok
  `agent_session_start/stop.v0` webhooks (all agent sessions on the account, so new tunnels appear
  automatically) plus `GET https://api.ngrok.com/tunnels` and `/endpoints` polled every 5 min as the
  reconciler; LM Studio `/api/v0/models` through each tunnel (which models are downloaded and which
  are loaded, context length, quantisation); LiteLLM `/health` per model group, `/model/info` for
  prices and limits, `/key/info` and `/team/info` for spend against budget (reuse the parsing in
  `mgm/.pi/extensions/connect/lib.ts`); OpenRouter `/api/v1/key` for credits; Cloud Run Job quota and
  currently running executions. Stored in a `providers` collection as the current state plus a
  bounded history (last 7 days of transitions) so the dashboard can show uptime. Exposed as
  `GET /api/providers` and an SSE stream; each transition is a `custom` entry on any running session
  that depends on that provider.
- **E2.9 Wake latency measurement**: script that wakes a stopped session ten times against the real
  Cloud Run Job and records time to `status running`; sets the idle-stop defaults from data.
- **E2.7 Deploy** ⇄: `deploy/api.sh` builds with Cloud Build, deploys, enables IAP with the domain
  principal. Done when the URL prompts for Google login and rejects a non-domain account.

### E3 Web UI

- **E3.1 Shell** ⇄: Vite + React, served from the API. Fleet list with status, guru, repo/branch,
  cost, last activity; filters; parent/child grouping.
- **E3.2 Session view**: transcript with `@earendil-works/pi-web-ui` message components fed from SSE;
  composer with send/steer/follow-up (queued while running, like Cosmos and pi's queue); abort; stop
  and wake; questions and permission prompts rendered from `extension_ui_request`.
- **E3.3 Diff and files tabs**: `GET /sessions/:id/diff` (agentd runs `git diff base...HEAD` plus
  working tree) rendered with a diff component; file viewer via agentd `read`.
- **E3.4 New session dialog**: guru, optional repository (from a configured list or GitHub search
  via the broker; "no repository" for non-coding work), base branch, prompt; "run locally" hint that prints `mgm --teleport <id>`.
- **E3.5 Cost page**: per session, per guru, per day; LiteLLM key budget bars (reuse the budget
  panel logic from connect/lib.ts).
- **E3.6 Providers dashboard**: a status page (also the landing page's header strip) listing every
  provider from E2.10: ngrok endpoints (online/offline, since when, region, which laptop/host, forwards
  to), the LM Studio models behind each with loaded state, LiteLLM model groups with health, price
  and budget bars, OpenRouter credits, and sandbox capacity (running jobs versus limit). Live via SSE,
  with a 7-day uptime sparkline per endpoint and a "wake laptop model" hint when a guru wants it and
  it is offline. Designed to grow: providers are rows in a table keyed by kind, not hard-coded panels.

### E4 Teleport, both directions

- **E4.1 `OutfitterStore`** in the mgm teleport extension: `list/get/put` against the API using the
  user's Google identity (gcloud ADC user token with the IAP client audience, or a personal API token
  issued by the API). Selected by `MGM_TELEPORT_STORE=outfitter`.
- **E4.2 Cloud → laptop**: `mgm --teleport <id>` verifies repo and clean tree, fetches the session
  branch, imports the transcript with the same id, remaps the model. The cloud run is stopped first
  (the API refuses pull while a run is `running` unless `--force`).
- **E4.3 Laptop → cloud** (the direction Claude Code lacks): `/teleport push --cloud [guru]` pushes
  the branch and transcript and asks the API to wake a run that continues the conversation.
- **E4.4 Web "Open in terminal"**: copies the `mgm --teleport` command; and `/teleport` typed inside a
  cloud session replies with it (pi command inside the sandbox).

### E5 Multi-agent

- **E5.1 Gurus as YAML**: schema, validation, `outfitter gurus apply`, repo-local
  `.outfitter/gurus/*.yaml` discovered at run start.
- **E5.2 Delegation tool**: mgm extension `outfitter_delegate` available only in cloud runs; creates a
  child session (same repo, worktree branch `outfitter/<child>`), waits, returns the child's final
  message and diff summary; parent transcript records a `custom` entry with the child id.
- **E5.3 Fleet limits and budgets**: max concurrent runs per guru and globally; LiteLLM budget per
  guru; refuse wake when exceeded, surface in UI.
- **E5.4 Shared memory**: reuse `pi-memory` with its directory backed by a GCS bucket mounted read-write
  (Cloud Run GCS FUSE volume on the Job); org-wide notes that every run sees.

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
