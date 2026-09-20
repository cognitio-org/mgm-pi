# Outfitter control-plane API — build/test report (E2.7, E2.8, deploy)

Scope: `packages/api` and `deploy/` only. `packages/agentd` and `image/` belong to a different
agent and were not touched (verified with `git status --untracked-files=all -- packages/agentd
image` — nothing in either tree was modified). Nothing under `mgm/` was touched either. This file
is written, not committed, per instructions.

## Coordinator follow-ups (addressed after the initial pass)

1. **Typecheck**: added `packages/api/tsconfig.json` (strict, `noEmit`, `module`/`moduleResolution`
   `NodeNext`, target `ES2022`, `allowImportingTsExtensions` so it can resolve the `.ts`-suffixed
   imports the package already uses everywhere) and a `typecheck` script (`tsc -p tsconfig.json`)
   wired as `pretest`, so `npm test` now fails on a type error before running anything. Fixed the
   pre-existing errors in `src/store/mongo.ts` properly rather than suppressing them — see
   "mongo.ts fix" below. `tsc -p tsconfig.json` is clean; `npm test` (from `outfitter/`) is still
   65/65 green.
2. **`docs/protocol.md`**: added `POST /api/hooks/ngrok` to the REST bullet list (flagged
   **not IAP-gated**, HMAC-SHA256/`ngrok-signature` instead), the optional `model` field on
   `POST /api/sessions`, and a paragraph after the agentd↔api "Ordering" note explaining that
   `run.spec.guru.model` is the model *after* the E2.8 laptop-preflight substitution, with
   `Run.modelFallback` cited as where the substitution is recorded.
3. **`deploy/README.md`**: rewrote the secrets section into (a) the four secrets `api.sh` actually
   mounts as service env vars (with a table of which are genuinely consumed vs. still unread
   placeholders) and (b) the per-session/per-guru secrets `GcpSecretsBroker.secretsForRun`
   (`src/secrets.ts`) actually fetches dynamically at connect time — different names, different
   creation cadence (per session/guru, not upfront), not touched by `api.sh` at all. Also noted
   that `api.sh` doesn't set `NGROK_WEBHOOK_SECRET`, so the hook route 401s everything until that's
   added deliberately.

### mongo.ts fix (not a cast-suppression)

Root causes, both now fixed at the type level with behavior unchanged:

- `stripId<T extends { id: string }>` was too narrow: `Entry` and `User` don't have an `id` field
  (they key off `sessionId`+`seq` and `email` respectively), so TypeScript silently fell back to
  the constraint's default (`{id: string}`) wherever inference couldn't pin `T` down, making the
  return type wrong at every call site for those two collections (surfacing as the `Entry`/`User`
  cast errors at the old lines 93/228/232). Fixed by dropping the constraint (`stripId<T>`) and
  giving every call site an explicit type argument (`stripId<Session>`, `stripId<Entry>`, ...)
  instead of relying on inference at all. Added a second helper, `stripIdStrict<T>`, for the
  `.find().toArray().map(...)` call sites where the document is never null — this replaced the old
  `stripId(r) as X` double-cast with a single correctly-typed call and removed the need for the
  `as X` afterward.
- `ACTIVE_RUN_STATES` was `const ACTIVE_RUN_STATES = [...]`, inferred as `string[]`, which doesn't
  satisfy the mongodb driver's `Filter<Run>` type for a `$in` query against a literal-union field
  (`Run["state"]`). Fixed by typing it explicitly as `RunState[]` (imported from `store/types.ts`)
  instead of a cast at each of its two use sites.

## Files

### New

- `packages/api/src/laptop.ts` — `LaptopProbe` (the E2.8 preflight: `isOnline()` GETs
  `https://$TUNNEL_DOMAIN_LMSTUDIO/v1/models` with a 3s timeout and a 60s cache; `setOnline()` for
  the webhook push path) and `resolveRunModel()`, the pure fallback-substitution decision.
- `packages/api/src/routes/hooks.ts` — `POST /api/hooks/ngrok`: HMAC-SHA256 signature
  verification (`verifyNgrokSignature`, exported), then `agent_session_stop.v0` /
  `agent_session_start.v0` flip `LaptopProbe.setOnline`.
- `packages/api/test/laptop.test.ts` — `LaptopProbe` with a stubbed `fetch` (online, offline,
  timeout, cache, `setOnline` short-circuit) and `resolveRunModel` (4 substitution scenarios).
- `packages/api/test/hooks.test.ts` — webhook signature accept (`agent_session_stop.v0` →
  offline, `agent_session_start.v0` → online) and reject (wrong signature, missing signature,
  unconfigured secret).
- `packages/api/README.md`, `packages/api/docs/data-model.md`.
- `packages/api/tsconfig.json` — strict, `noEmit`, `NodeNext`, `ES2022` (coordinator follow-up 1).
- `deploy/baseline.sh`, `deploy/api.sh`, `deploy/agent-job.sh`, `deploy/README.md`.
- `docs/reports/api.md` (this file).

### Edited

- `packages/api/src/store/mongo.ts` — `stripId`/`stripIdStrict` generic fix, `ACTIVE_RUN_STATES`
  typed as `RunState[]` (coordinator follow-up 1; see "mongo.ts fix" above). No behavior change.
- `packages/api/package.json` — `typecheck`/`pretest` scripts, `typescript` devDependency
  (coordinator follow-up 1).
- `docs/protocol.md` — `POST /api/hooks/ngrok`, `POST /api/sessions`'s `model` field, the
  `run.spec.guru.model`-is-resolved note (coordinator follow-up 2).
- `deploy/README.md` — secrets section split into env-injected (a) vs. per-run (b), per
  `src/secrets.ts` (coordinator follow-up 3).
- `packages/api/src/store/types.ts` — `Guru.fallbackModel?`, `Session.modelOverride?`,
  `Run.modelFallback?: {wanted, used}` (documented inline as "not in protocol.md", same pattern as
  the existing `Run.pendingUiRequest`).
- `packages/api/src/config.ts` — `tunnelDomainLmstudio`, `localTunnelToken`, `localModels`
  (comma-separated, default `["litellm/local-qwen-mlx"]`), `defaultCloudModel` (default
  `litellm/claude-auto-llm`), `ngrokWebhookSecret`.
- `packages/api/src/agentlink.ts` — `buildRunSpec` now resolves the effective model via
  `LaptopProbe.isOnline()` + `resolveRunModel()` before sending `run.spec`, and persists
  `Run.modelFallback` when a substitution happened. Constructor takes a `LaptopProbe`.
- `packages/api/src/server.ts` — constructs the one `LaptopProbe`, threads it into `AgentLink` and
  `RouteContext`, exposes it on `App` (so tests can call `app.laptopProbe.setOnline()` directly),
  and carves `/api/hooks/` out of the IAP `preHandler` (that endpoint authenticates itself via its
  own signature, not IAP/agent-token — see "IAP bypass" under Deviations).
- `packages/api/src/routes/context.ts`, `packages/api/src/routes/index.ts` — wire `laptopProbe`
  through; register `hooks.ts`.
- `packages/api/src/routes/sessions.ts` — `POST /api/sessions` accepts an optional `model` field,
  stored as `Session.modelOverride`.
- `packages/api/test/helpers.ts` — `buildTestApp` now takes an optional env-overrides map (needed
  for `NGROK_WEBHOOK_SECRET` in `hooks.test.ts`); default call sites unaffected.
- `packages/api/test/agentlink.test.ts` — two new tests: fallback substitution end to end (offline
  → `run.spec.guru.model` is the guru's `fallbackModel`, `Run.modelFallback` recorded) and the
  online no-op case.

## Test summary

```
npm test   (from outfitter/)

@outfitter/agentd:        30 pass, 0 fail   (untouched by this work; confirms nothing broke)
@outfitter/api:            33 pass, 0 fail   (17 pre-existing + 16 new)
@outfitter/provider-local:  2 pass, 0 fail
```

Originally `packages/api` had no `tsconfig.json` (it ran `.ts` directly via Node 24's native TS
stripping, no separate build/typecheck step). An ad-hoc `tsc --noEmit --strict` run over every
`src`/`test` file surfaced real pre-existing errors, all in `src/store/mongo.ts` (untouched by the
initial pass). Per coordinator follow-up 1, `packages/api/tsconfig.json` + a `typecheck` script now
make this a real, permanent gate: `npm run typecheck` (and therefore `npm test`, since
`typecheck` is `pretest`) is clean, and `mongo.ts` itself is fixed properly (see "mongo.ts fix"
above) rather than left as a known-error exception. The pass counts above are from a run with
`pretest`/`typecheck` already in the loop (`npm test`'s `pretest` hook runs it automatically).

## Deviations from `docs/protocol.md`

1. **`POST /api/hooks/ngrok` is not in protocol.md's REST route list.** It's EPIC.md's E2.8
   "Optional push path" story, not part of the wire contract protocol.md documents (agentd↔api and
   browser↔api). Left protocol.md itself unedited since it's the shared source of truth the other
   agent's `packages/agentd` also depends on; flagging the gap here instead.
2. **`Run.modelFallback` and `Session.modelOverride` are store-only fields, not on the wire.**
   `modelFallback` follows the same "not in protocol.md" pattern already used for
   `Run.pendingUiRequest` (see that field's own comment in `store/types.ts`). Neither is sent to
   agentd directly — only the *resolved* `guru.model` in `run.spec` is (protocol.md already
   specs that field; this changes which value ends up in it, not the shape).
3. **`POST /api/sessions` gained an optional `model` field** beyond protocol.md's documented
   `{guruId, repo?, baseBranch?, branch?, prompt, name?}`. This is the "session override" the task
   description asked for; protocol.md doesn't mention per-session model overrides at all.
4. **The IAP `preHandler` in `server.ts` now has a carve-out** (`req.url.startsWith("/api/hooks/")`)
   so the ngrok webhook isn't also required to present an IAP session — it authenticates via its
   own HMAC signature instead. protocol.md's "browser ↔ api (REST)" section implicitly assumes
   every `/api/*` route is IAP-gated; this is the one exception.
5. **`deploy/api.sh`'s `--set-secrets` list doesn't fully match what `src/secrets.ts` reads today.**
   The task (and this script) wire `MONGODB_URI` and `LOCAL_TUNNEL_TOKEN` as Cloud Run env vars —
   both are genuinely consumed (`config.ts`'s `mongodbUri`/`localTunnelToken`). `GITHUB_PAT` and
   `LITELLM_ADMIN_KEY` are deployed the same way but **nothing in the current code reads them**:
   `GcpSecretsBroker.secretsForRun` (`src/secrets.ts`, not touched by this story) instead fetches
   `outfitter-github-token-<sessionId>` and `outfitter-litellm-key-<guruId>` — different secret
   names, fetched per-run via the Secret Manager REST API at connect time, not injected as
   container env vars at all. I left `secrets.ts` alone (out of this story's scope — it's E2.5,
   still a placeholder per its own doc comment) and noted the mismatch in `deploy/README.md`
   rather than silently "fixing" it in a way that might conflict with E2.5's actual design.

## gcloud commands I was least sure about

- **`gcloud run deploy outfitter-api ... --iap`** (`deploy/api.sh`). Confirmed the flag and the
  IAP-service-agent `run.invoker` binding from
  [Configure IAP for Cloud Run](https://cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run)
  — its own example is `gcloud run deploy ... --no-allow-unauthenticated --iap` with no `beta`
  component, which is what the script uses; an earlier web search surfaced `gcloud beta run
  deploy ... --iap` for the same feature, so gcloud channel/version may still gate it — the script
  comments this so a "unrecognized arguments: --iap" failure has an obvious next step.
- **`gcloud iap web add-iam-policy-binding --member=domain:mgmonteleone.com`** (`deploy/api.sh`,
  granting the whole Workspace domain IAP access). Same doc page as above; its own worked example
  only shows `--member=user:<email>`. `domain:` is standard IAM member syntax elsewhere in gcloud,
  but I could not find this exact command demonstrated with a domain member — the script comments
  this and suggests confirming with `gcloud iap web get-iam-policy` before trusting it to gate
  access.
- **`gcloud builds submit packages/api --pack=image=$IMAGE`** (`deploy/api.sh`). `packages/api`
  has no Dockerfile, so I used Cloud Build's buildpacks integration instead of asking `gcloud
  run deploy` to do build+deploy in one step (kept them as two commands per the task's phrasing).
  I did not separately web-search the exact `--pack` flag syntax — it's from prior knowledge of
  `gcloud builds submit --pack=image=IMAGE_NAME,env=...`, not verified against current docs in
  this pass. If it's stale, `gcloud run deploy outfitter-api --source=packages/api ...` (which
  also builds via Cloud Build + buildpacks, in one step) is the fallback.
- **`gcloud billing budgets create --filter-projects="projects/$PROJECT" --threshold-rule=percent=0.5`**
  (`deploy/baseline.sh`). Written from prior knowledge of the `gcloud billing budgets create`
  flag shape (repeated `--threshold-rule=percent=N`, `--filter-projects` taking `projects/ID`
  values); not independently re-verified with a web search this pass. Worth a dry run (it's
  additive/idempotent-checked, but the flag names are the part I'd double check first) before
  trusting it in `baseline.sh`.
- **The `ngrok-signature` header / HMAC-SHA256 scheme for `POST /api/hooks/ngrok`.** This is the
  one I'd flag most strongly. I searched for ngrok's documentation on this and found:
  [Event Destinations](https://ngrok.com/docs/api/resources/event-destinations/) — the API's
  `target` schema only documents `kinesis` / `firehose` / `cloudwatch_logs` / `s3` (AWS),
  `datadog`, and `azure_logs_ingestion`. **There is no generic HTTPS webhook target in ngrok's
  Event Destinations API today.** So EPIC.md's own "Optional push path" (an ngrok event
  subscription delivered straight to `POST /api/hooks/ngrok`) isn't achievable with that product
  as currently documented — it would need an intermediary (e.g. a small relay reading a
  Datadog-forwarded or Kinesis-consumed event and re-POSTing it here). Separately,
  [Verify Webhook Action](https://ngrok.com/docs/traffic-policy/actions/verify-webhook) documents
  ngrok's HMAC-SHA256-over-the-body pattern, but that's for ngrok validating *inbound* webhooks
  passing through an ngrok endpoint (GitHub/Stripe/Slack-style), a different feature from what
  this story needs. I implemented `routes/hooks.ts` to the letter of the task's spec (HMAC-SHA256
  hex digest over the raw body, `ngrok-signature` header, `NGROK_WEBHOOK_SECRET`) so the endpoint
  is ready and fully tested, and documented this gap in the module's own comment and in
  `deploy/README.md`. EPIC.md already names the fallback for this scenario: polling
  `GET https://api.ngrok.com/tunnels`, which is unimplemented (out of scope here) — until either
  a relay is built or the poller lands, `POST /api/hooks/ngrok` has no real sender and
  `LaptopProbe`'s own 60s-cached direct probe is what actually drives `isOnline()` in practice.
