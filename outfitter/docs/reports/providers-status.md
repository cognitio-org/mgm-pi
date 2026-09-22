# E2.10 Provider status service

Backend half of E3.6. One place that knows whether every model/tool provider is usable right now,
feeding both the E2.8 laptop preflight and the (not-yet-built) E3.6 dashboard.

## What was built

**`packages/api/src/providers-status.ts`** — `ProviderStatusService` plus four standalone,
individually-testable probe functions:

| Probe | Source | Notes |
|---|---|---|
| `probeNgrok` | `GET https://api.ngrok.com/endpoints` (`NGROK_API_KEY`) | One row per online endpoint (`ngrok:<id>`). No key → single `unknown` row, "not configured". Empty (but successful) response → single `down` row, "no endpoints online". |
| `probeLaptop` | The **same `LaptopProbe` instance** the E2.8 preflight already uses, plus `GET /api/v0/models` through the tunnel when reachable | Reusing the instance means this probe never causes an extra network round trip beyond LaptopProbe's own 60s cache — it only adds the `/api/v0/models` call, and only once LaptopProbe already says online. |
| `probeLitellm` | `GET /health/liveliness`, `/model/info`, `/key/info` in parallel, `LITELLM_ADMIN_KEY` or `SecretsBroker.defaultLitellmKey()` | `parseModelInfo` is a straight copy (not an import) of `mgm/.pi/extensions/connect/lib.ts`'s function, per the story's instruction. Each of the three calls can fail independently without failing the others — a `/model/info` or `/key/info` hiccup still reports `up` with less `meta`, only `/health/liveliness` failing flips the row to `down`. |
| `probeCloudRun` | `CloudRunProvider.countRunningExecutions()` (new method, `listExecutions`) | `unknown` (not a probe failure) when `SANDBOX_PROVIDER` isn't `cloudrun` — there's nothing to count. |

Every probe is bounded by a 3s `AbortController` timeout on each fetch and wrapped in its own
try/catch, so it resolves instead of throwing on any failure (missing credential, network error,
non-2xx, malformed body). `ProviderStatusService.pollOnce()` adds `Promise.allSettled` as a
backstop on top of that, so a bug in one probe can't wedge a poll.

**Store**: a new `ProvidersCollection` (`src/store/types.ts`), implemented for both `MemoryStore`
and `MongoStore` (`_id: <row id>`, e.g. `"laptop"`, `"litellm"`, `"cloudrun"`, `"ngrok:<endpoint
id>"`). Each stored `ProviderRecord` is the current row plus a `history: {status, at}[]` array,
bounded to the last 7 days by `ProviderStatusService`'s own `reconcileRow` (the store doesn't
compute history). Writers are polls (from any web instance) and the ngrok webhook; a race between
two of them is last-write-wins on a status flag, which the next poll corrects). `GET /api/providers` strips `history` before returning current rows.

**Routes** (`src/routes/providers.ts`, registered alongside sessions/gurus/environments, so
browser-role only):
- `GET /api/providers` → `{ providers: ProviderRow[] }`
- `GET /api/providers/stream` → SSE on the `"providers"` channel, `status` event type (reusing
  `SseHub`'s existing union rather than widening it for one more channel), pushed **only when a
  poll produced at least one status transition** — not on every poll.
- `POST /api/providers/refresh` → forces `pollOnce()`, returns the resulting rows.

**Webhook refactor** (`src/routes/hooks.ts`): `POST /api/hooks/ngrok` now calls both
`laptopProbe.setOnline(...)` (unchanged, feeds E2.8) and the new
`providerStatus.noteLaptopTransition(...)` (feeds E2.10) — the same HMAC verification as before,
just one more consumer of the already-verified event. `noteLaptopTransition` updates the "laptop"
row directly from the event without re-probing anything, so the dashboard sees a laptop
online/offline flip immediately instead of waiting up to 5 minutes for the next poll.

**Polling on read** (updated 2026-09-22, PR #18): there is no background poller. The first
version ran `startPolling(PROVIDER_POLL_MS)` plus a fire-and-forget pass at startup, and on Cloud
Run every row came back as a false "down": the web role gets CPU only during requests and scales
to zero, so a poll started between requests stalled until its 3 s timeouts fired.
`GET /api/providers` and the stream's first snapshot now call `refreshIfStale(PROVIDER_POLL_MS)`,
which polls inside the request when this instance's last completed poll is older than the interval.
Polls are single-flight, so concurrent readers and `POST /refresh` share one. If the store fails
mid-poll the read serves the last stored rows and the next read retries. The "link" role still
constructs a `ProviderStatusService` for the webhook but never polls.

**Cloud Run**: `CloudRunProvider.countRunningExecutions()` (`src/providers/cloudrun.ts`) is new —
counts executions of the configured Job with no `completionTime` yet (still starting or running).
`ExecutionsClientLike.listExecutions` is optional so the existing `status()`/`stop()`-only test
stubs in `cloudrun.test.ts` didn't need to grow a method they never call.

**Config** (`src/config.ts`): `NGROK_API_KEY`, `LITELLM_BASE_URL` (default
`https://litellm.augment-code.support/v1`, same var name as mgm's `.env.example`),
`LITELLM_ADMIN_KEY` (already deployed as a secret per `deploy/service.sh`, just not read until
now), `PROVIDER_POLL_MS` (default 300000).

**Secrets** (`src/secrets.ts`): `SecretsBroker` grew one method, `defaultLitellmKey(): Promise<string>`
— "the default guru key from config/secrets" the story asks the LiteLLM probe to fall back to
when `LITELLM_ADMIN_KEY` isn't set. `MemorySecretsBroker` returns its existing dev key;
`GcpSecretsBroker` reads `outfitter-litellm-key-default` (the same secret
`litellmKeyForGuru`'s per-guru fallback already used — that method now just calls this).

## Deviations from the EPIC.md sketch

Documented in the updated E2.10 entry itself; summarized here:

- **No OpenRouter probe, no `/team/info`** — this codebase has no OpenRouter or LiteLLM-team usage
  today, so there's nothing real to probe; adding a probe with no live target to point at would be
  untestable and untrusted the moment it shipped. Left out rather than stubbed.
- **One LiteLLM row, not one per model group** — `GET /health` and `/model/info` are proxy-wide;
  the per-model price/context breakdown is still there, just nested under `meta.models` on the one
  `litellm` row instead of being split into N rows. Matches the granularity the other three
  provider kinds already use (one row per *reachability boundary*: one tunnel, one job, one
  proxy — ngrok is the exception, since each endpoint really is independently reachable).
- **No automatic `custom` transcript entry on running sessions when a provider transitions** —
  that's steering a *live* session (agentlink.ts / the RPC `set_model` path E2.8 already has), a
  different concern from "know current status and expose it," which is what this story's files
  (`providers-status.ts`, the new routes, the store) are scoped to. Left as a follow-up that
  reuses E2.8's existing steering path rather than something new in this file.

## Testing

`packages/api/test/providers-status.test.ts` (30 new tests): parsing (`parseNgrokEndpoints`,
`parseModelInfo`, `parseKeyInfo`, `parseLmStudioModels`), each probe's success/failure/unconfigured
paths with a fake `fetch` and a fake clock where relevant (the Cloud Run timeout test asserts wall
time), `ProviderStatusService.pollOnce`'s reconcile-and-publish-on-transition-only behavior, 7-day
history bounding (by rewriting a stored record's transition timestamps to 8 days old and asserting
they're pruned on the next poll), and the three routes including the webhook's immediate laptop
update surfacing through `GET /api/providers`.

`npm test` in `packages/api`: **122 tests, 121 pass, 1 skipped** (pre-existing skip, unrelated to
this change) — up from the pre-existing 92-test baseline (91 pass, 1 skipped). `npm run typecheck`
is clean.

One pre-existing environment gap fixed in passing: `packages/provider-local`'s `dist/` wasn't
built in this worktree, which made `tsc` fail on every `@outfitter/provider-local` import
(unrelated to this change — `npm run build` in that package fixed it, no source changes there).

## Files touched

- `packages/api/src/providers-status.ts` (new)
- `packages/api/src/routes/providers.ts` (new)
- `packages/api/src/store/types.ts`, `memory.ts`, `mongo.ts` (`ProvidersCollection`)
- `packages/api/src/routes/hooks.ts`, `context.ts`, `index.ts`
- `packages/api/src/server.ts`, `src/config.ts`, `src/secrets.ts`
- `packages/api/src/providers/cloudrun.ts` (`countRunningExecutions`)
- `packages/api/test/providers-status.test.ts` (new), `test/agentlink.test.ts`, `test/stop.test.ts`
  (both needed a one-line update for the `SecretsBroker`/`Store` interface additions, not new
  behavior)
- `deploy/service.sh`, `deploy/README.md` (env var / secret documentation)
- `EPIC.md` (E2.10 marked done)
