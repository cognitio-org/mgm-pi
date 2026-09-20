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

## Verification

```
cd packages/api && npm test   # typecheck (pretest) + node --test: 42/42 pass
cd outfitter && npm test      # packages/api and provider-local green;
                               # packages/agentd fails to build — pre-existing, mid-edit by
                               # another concurrent agent, not touched by this change
```
