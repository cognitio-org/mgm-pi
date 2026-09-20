# Code-review fixes: packages/api and deploy

Four findings from code review, fixed in `packages/api`, `deploy/`, `docs/protocol.md` and
`EPIC.md`. `npm test` is green in `packages/api` and from `outfitter/` (the workspace-level run
fails only in `packages/agentd`, which another agent is concurrently editing — untouched here).

## 1. IAP blocks agentd and the ngrok hook (`auth.ts:57`, `deploy/api.sh`)

**Problem:** IAP on a Cloud Run service is service-wide. It can't let agentd's WebSocket (its
Google ID token's audience is the API's own origin, not IAP's OAuth client id) or the
unauthenticated ngrok webhook through while still gating the browser routes — IAP would reject
both before they ever reached the Fastify app.

**Fix:** split the single process into two roles that share the same image and store, picked by a
new env var:

- `packages/api/src/config.ts` — new `OutfitterRole` (`"all" | "web" | "link"`, env
  `OUTFITTER_ROLE`, default `"all"` for local dev where there's one process and no IAP anyway).
- `packages/api/src/server.ts` — the IAP `preHandler` is only installed when `role !== "link"`;
  `agentLink.register(fastify)` (which adds `GET /agent/ws`) only happens when `role !== "web"`.
- `packages/api/src/routes/index.ts` — `registerRoutes` only registers the browser REST/SSE routes
  (sessions, gurus, environments, me, static UI) when `role !== "link"`, and only registers the
  hooks route (`POST /api/hooks/ngrok`) when `role !== "web"`.
- `deploy/api.sh` — now deploys `outfitter-api` with `OUTFITTER_ROLE=web` (still IAP-on,
  `--no-allow-unauthenticated`).
- `deploy/link.sh` (new) — deploys the same image a second time as `outfitter-link`,
  `OUTFITTER_ROLE=link`, `--allow-unauthenticated`, min-instances 0. Each request on this service
  authenticates itself (`verifyAgentToken` for `/agent/ws`, HMAC for `/api/hooks/ngrok`); there is
  no IAP to rely on.
- `deploy/agent-job.sh` — header/required-var message updated: `OUTFITTER_API` must now be the
  `outfitter-link` URL (printed by `link.sh`), not `outfitter-api`'s.
- `deploy/README.md` — order of operations now includes `link.sh` as step 5 (before
  `agent-job.sh`), plus a "two Cloud Run services, one image" note up top, an updated rollback
  section, and full-teardown now lists both services.
- `docs/protocol.md` — new "Two origins" section explaining the split.

Mid-task, the coordinator added a related guard: `deploy/env.sh` (added by another concurrent
agent, who wired it into `baseline.sh`) pins `PROJECT`/`REGION`/`ACCOUNT` and exports them as
`CLOUDSDK_CORE_PROJECT`/`CLOUDSDK_CORE_ACCOUNT`/`CLOUDSDK_BILLING_QUOTA_PROJECT`, refusing to run
if the pinned account isn't logged in or `PROJECT` isn't `outfitter-*` — so a script never silently
bills against whatever project happens to be active in the local `gcloud` config. `api.sh`,
`link.sh` and `agent-job.sh` (the three deploy scripts this task owns) now `source env.sh` right
after `set -euo pipefail` and no longer set their own `PROJECT`/`REGION` defaults; every `gcloud`
call in them still also passes an explicit `--project`/`--region` (or positional project id), so
nothing relies on the active `gcloud` config either way. `deploy/README.md` documents `env.sh`.
- `EPIC.md` — components table now has separate rows for `outfitter-api` (web role) and
  `outfitter-link` (link role).

**Tests** (`packages/api/test/roles.test.ts`, new):
- `role=web` registers `/api/sessions` but not `/agent/ws` (`fastify.hasRoute`).
- `role=link` does not register `/api/sessions` (404) and serves `POST /api/hooks/ngrok`
  successfully even with `devMode` off and IAP unconfigured — proving the IAP preHandler isn't
  installed at all for this role, not just that this one route is carved out of it.
- `role` unset (default `"all"`) still registers both, matching prior behavior.

## 2. `agentlink.ts` delivered prompts during provisioning

**Problem:** a down-message (e.g. the initial prompt from `POST /api/sessions`) could be sent to
agentd as soon as a socket connected and sent `hello`, even though the run was still
`provisioning` — before pi actually existed to receive it.

**Fix** (`packages/api/src/agentlink.ts`):
- New `isReadyState(state)` helper: a run is "ready" once it's `running` or `idle`.
- `AgentLink.send()` now also checks the run's current state; if the socket is live but the run
  isn't ready yet, the message is queued in the store instead of sent.
- The `hello` handler only drains the queue if the run was *already* ready when hello arrived (a
  reconnect after running/idle) — a first-connect hello (run still provisioning) no longer drains.
- The `status` handler now drains the queue exactly once, the first time it observes a transition
  into `running`/`idle` (comparing the run's state immediately before vs. after applying the new
  status).

**Test** (`packages/api/test/agentlink.test.ts`, new case): two prompts queued while `provisioning`
stay queued through `hello`, then are delivered in order on the first `status: idle` frame; a
subsequent `send()` after that delivers straight over the socket.

## 3. `runs.ts:98` reconciler orphaned Cloud Run Job executions

**Problem:** when the reconciler marked a stale run `failed`, it never told the provider to stop
the underlying Job execution — a reconciled run could keep running (and billing) forever.
`CloudRunProvider.status()` also only distinguished "still provisioning" from "stopped" by
`completionTime`, collapsing an execution that hadn't started yet and one actively running into the
same `"running"` bucket, and had no explicit protection for a run that's simply still cold-starting.

**Fix:**
- `packages/api/src/runs.ts` — `reconcileOnce` now calls `provider.stop(run.providerHandle)`
  (best-effort, `.catch()`'d) before marking a run `failed`. It also skips a run outright if
  `now - run.createdAt < config.provisioningGraceMs` (new config field, env
  `PROVISIONING_GRACE_MS`, default 10 minutes) — a cold Cloud Run Job start can outlast the 90s
  heartbeat staleness window with no heartbeat yet, and that's not a failure.
- `packages/api/src/config.ts` — added `provisioningGraceMs`.
- `packages/api/src/providers/cloudrun.ts` — `status()` now reads the Cloud Run v2 Execution
  resource's `startTime`/`completionTime`/`runningCount`/`failedCount` fields directly (verified
  against
  https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions#Execution,
  cited in a comment): no `startTime` yet → `"provisioning"`; `completionTime` set → `"stopped"`;
  `runningCount > 0` → `"running"`; otherwise (started but no running/completed tasks yet, e.g.
  between retries) → `"provisioning"`.

**Tests** (`packages/api/test/runs.test.ts`, new, using `NoopProvider`):
- A stale run (old enough to be past both staleness and the grace window) with `provider.status`
  reporting `"running"` gets `provider.stop()` called before being marked `failed`.
- A run created moments ago (well inside the grace window) is never failed even when immediately
  stale by heartbeat (`staleAfterMs=0`); the grace check runs before any provider call.
- A run the provider still reports as `"provisioning"` is left alone (no stop, no fail) — existing
  behavior, still covered.

## 4. `agentlink.ts:270` session cost used the key's cumulative spend

**Problem:** `spend.keySpend` is the LiteLLM *key's* running total, shared across every run/session
using that guru's key — not this run's own spend. The old code did
`session.cost = max(session.cost, keySpend)`, which for any session after the key had accumulated
spend from other sessions/runs would show an inflated, essentially made-up cost.

**Fix:**
- `packages/api/src/store/types.ts` — `Run` gets two new optional fields: `keySpendStart` (the
  key's balance the first time this run saw a spend frame) and `cost` (this run's own delta above
  that baseline). `MemoryRuns`/`MongoRuns` need no code changes — both apply `Partial<Run>` patches
  generically, so the new fields flow through the existing `update()` methods.
- `packages/api/src/agentlink.ts` — the `spend` handler now: pins `keySpendStart` on first sight
  per run; computes `cost = max(0, keySpend - keySpendStart)`; and updates `session.cost` by
  applying this run's cost *delta* (`cost - previousCost`) to the existing session cost, so
  `session.cost` stays the sum of its runs' `cost` fields without a separate "list runs by
  session" store query.

**Test** (`packages/api/test/agentlink.test.ts`, new case): a session runs two sequential runs
sharing one LiteLLM key whose balance keeps climbing (5 → 8 → 8 → 12). Session cost tracks
3 (run 1's delta) + 4 (run 2's delta) = 7, not `max(3, 12) = 12` (what the old bug would have
computed).

## Fixes for PR #15 review

Findings from the three verified review reports (`docs/reports/security-review-pr15.md`,
`docs/reports/code-review-pr15.md`, `docs/reports/critic-review-pr15.md`), fixed on
`outfitter/round-four` in worktree `pi-agent-teleport-84d05f`. Not covered here: critic finding #1
(IAP auth in `outfitter-store.ts`) beyond the docs correction — out of scope per the task.

### 1. Security #1 (HIGH) — guru-controlled `LITELLM_BASE_URL` credential exfiltration + SSRF

**What changed:**
- `outfitter/packages/api/src/routes/gurus.ts:8-27` — added `LITELLM_BASE_URL`, `LITELLM_API_KEY`,
  `LITELLM_AGENT_KEY` to `DENYLISTED_GURU_ENV_KEYS`.
- `outfitter/packages/agentd/src/guru.ts:33-52` — same three keys added to agentd's own denylist
  (belt and suspenders).
- `outfitter/packages/agentd/src/protocol.ts:165-172` — `RunSpecSecrets` gets an optional
  `litellmBaseUrl?: string`, server-controlled, never guru-editable.
- `outfitter/packages/api/src/agentlink.ts:60-63,403` — `RunSpecMessage.secrets` carries
  `litellmBaseUrl` (non-optional on the wire), populated from `this.config.litellmBaseUrl` in
  `buildRunSpec`.
- `outfitter/packages/agentd/src/run.ts:384-389` — `secretEnv.LITELLM_BASE_URL` is now pinned from
  `spec.secrets.litellmBaseUrl` when present, spread after `rendered.env` (guru.env), so a
  guru-supplied value can never win.
- `outfitter/docs/protocol.md:82,91-95` — documents the new field and why it's server-controlled.
- Noted in the fix commit: the pre-existing mgm connect extension
  (`mgm/.pi/extensions/connect/lib.ts`) has the same `LITELLM_BASE_URL`-to-Bearer-key pattern, but
  it isn't guru-configurable, so the denylist here is the actual fix for the exploitable path.

**Tests:** `outfitter/packages/api/test/gurus.test.ts` (3 new denylisted-key cases in the existing
loop), `outfitter/packages/agentd/test/guru.test.ts` (extended the existing denylist test with the
3 new keys, updated the expected dropped-key count).

### 2. Security #3 (MEDIUM) — `POST /api/providers/refresh` had no rate limit

**What changed:** `outfitter/packages/api/src/routes/providers.ts:9-29` — added a 10s global
cooldown (`REFRESH_COOLDOWN_MS`); a call inside the window returns `429` instead of triggering
another poll.

**Tests:** `outfitter/packages/api/test/providers-status.test.ts` — new case: a second
`POST /api/providers/refresh` immediately after the first returns 429.

### 3. Security #2 (MEDIUM) — ngrok webhook replay: deferred, per the reviewer's own recommendation

**What changed:** no code change. Added the deviation/deferral note to
`outfitter/docs/reports/api.md`'s "Deviations from `docs/protocol.md`" section (item 6), recording
why (the real ngrok event-destination envelope isn't confirmed yet, and the blast radius — a
status flag, not a privileged action — is low) and what to do once it is (timestamp-skew check +
short-TTL seen-signature cache in `verifyNgrokSignature`).

### 4. Code review M1 (Major) — fleet run-state filter matched nothing

**What changed:**
- `outfitter/packages/api/src/routes/sessions.ts:96-105` — `GET /api/sessions` now accepts
  `?runState=<RunState>`, filtered post-hoc on the computed `runState` field after `summarize()`
  (it isn't a store-level field); `status` (`open`/`closed`) still filters at the store as before.
- `outfitter/packages/web/src/api/client.ts:159-167` — `api.sessions()` takes and sends `runState`.
- `outfitter/packages/web/src/pages/FleetPage.tsx` — the run-state dropdown now drives a
  `runStateFilter` state var sent as `runState`, not overloaded onto `status`.

**Tests:** `outfitter/packages/api/test/routes.test.ts` (new `GET /api/sessions?runState=`
describe block: filters correctly, `status`-based listing still works unfiltered), and
`outfitter/packages/web/test/client.test.ts` (new case: `api.sessions({runState, guru})` builds
`?guru=...&runState=...`, not `status=`).

### 5. Code review M2 (Major) — `/stop` could force-kill an already-stopping run

**What changed:**
- `outfitter/packages/api/src/routes/sessions.ts:154-176` — `/stop` now branches explicitly:
  `running`/`idle` → graceful stop (unchanged); `queued`/`provisioning` → direct provider cancel
  (unchanged); already `stopping` → no-op, returns the current run so a second caller can't force a
  cancel mid-checkpoint/mid-drain.
- `mgm/.pi/extensions/teleport/outfitter-store.ts` (`ensureStopped`) — skips re-`POST`ing `/stop`
  when the session's observed `runState` is already `"stopping"`, going straight to the poll loop;
  removed the dead `409`-tolerance branch (N2) — `POST .../stop` only ever returns `404` or `200`.

**Tests:** `outfitter/packages/api/test/stop.test.ts` (new case: a second `/stop` call while the
run is already `stopping` returns the run unchanged and calls `provider.stop()` zero times), and
`mgm/tests/teleport-outfitter.test.ts` (new case: `ensureStopped` against a session already
`stopping` never calls `/stop`, only polls).

### 6. Code review N1 (Minor) — `useSessionStream` could clobber SSE entries with the initial fetch

**What changed:** `outfitter/packages/web/src/hooks/useSessionStream.ts` — factored the merge into
a pure `mergeEntries(current, initial)` function (union by id; `initial`'s tree order is
authoritative, anything already in `current` but missing from `initial` — i.e. streamed in over
SSE before the fetch resolved — is appended after) and used it instead of `setEntries(initial)`.

**Tests:** `outfitter/packages/web/test/session-stream.test.ts` (new file): no-race case, the
race case (SSE entry not dropped), a dedup case, and an empty-current case.

### 7. Code review N6 (Minor) — CI's image smoke test never exercised the web bundle

**What changed:** `.github/workflows/outfitter-ci.yml` (`images` job) — added a second boot of the
same API image with `OUTFITTER_ROLE=web`, `MONGODB_URI=memory`, `OUTFITTER_DEV=1` (no IAP),
`SANDBOX_PROVIDER=inprocess`; asserts `GET /` returns 200 with a `<title>` tag, `GET /sessions/x`
returns 200 (SPA fallback for a client-side route), and `GET /api/nope` returns 404 JSON.

**Verification:** built `outfitter/packages/api/Dockerfile` locally and ran the exact commands
against the resulting image before committing (see commit message for the manual run's output).

### 8. Docs honesty — critic #2 (E3.1/E3.2/E3.4 undersold) and critic #1 (E4.1 overclaimed)

**What changed:**
- `outfitter/EPIC.md` — E3.1, E3.2, E3.4 marked done with one-line summaries pointing at
  `docs/reports/web-ui.md` (noting the pi-web-ui decision, and that parent/child grouping,
  markdown rendering, and a real repo picker aren't built). E4.1's status changed from a flat
  "done" to: done for dev-token auth; IAP identity-token mode verified NOT working on 2026-09-21
  (gcloud can't mint an audience-specific identity token for a user account against IAP's
  Google-managed OAuth client, and the OAuth-brand admin APIs needed for a custom client are being
  shut down); auth design for the laptop path left as an open decision (personal API tokens on the
  link service is the leading option).
- `mgm/README.md` (teleport section) — same correction: `OUTFITTER_IAP_CLIENT_ID` marked not yet
  supported against a real deployment; the 401 troubleshooting line no longer sends the reader in
  circles re-running `gcloud auth login`.
- `mgm/.pi/extensions/teleport/outfitter-store.ts` — header comment corrected (code unchanged,
  left in place per the task); the 401 error message now differs by auth mode: `OUTFITTER_TOKEN`
  mode points at `OUTFITTER_TOKEN`/`OUTFITTER_DEV`, IAP mode says it's not yet supported and points
  at `OUTFITTER_TOKEN` for dev instead of suggesting `gcloud auth login`.

**Tests:** `mgm/tests/teleport-outfitter.test.ts` — updated the old "401 surfaces a gcloud auth
login hint" test into two cases, one per auth mode, matching the new messages.

### 9. Code review N3 (Minor) — providers SSE channel unused by the web strip

**What changed:** added a one-line follow-up under E3.6 in `outfitter/EPIC.md`: `GET
/api/providers/stream` is already fully implemented server-side (E2.10); the web strip/dashboard
should subscribe to it once E3.6 is built (`useProviders` currently only polls once on mount).

## Verification (PR #15 fixes)

```
cd outfitter && npm test   # all workspaces (agentd 140, api 130, provider-local 2, web 23): 0 fail
cd mgm && npm test         # 231/231 pass
```
