# Code Review: PR #18 — Outfitter providers: poll on read, not on a background timer

**Branch:** `outfitter/providers-on-read` → `main`
**Reviewer:** code-reviewer (adversarial pass)
**Scope:** `git diff origin/main...origin/outfitter/providers-on-read` limited to `outfitter/packages/api/{src/providers-status.ts, src/routes/providers.ts, src/server.ts, src/config.ts, test/providers-status.test.ts}` plus `outfitter/EPIC.md`.

## Summary

**Files reviewed:** 5 code/test files (EPIC.md is a trivial doc-only change, not reviewed in depth)
**Total issues:** 3

### By severity
- CRITICAL: 0
- HIGH: 0
- MEDIUM: 1 (consider fixing)
- LOW: 2 (optional)

## Issues

### [MEDIUM] Store failure during an on-read poll now 500s the request, where a background-poller failure previously didn't
**File:** `outfitter/packages/api/src/routes/providers.ts:21-23`, `outfitter/packages/api/src/providers-status.ts:400-411`
**Confidence:** MEDIUM

**Issue:** Before this PR, `GET /api/providers` only called `getCurrent()` (a pure store read); a failing background poll was caught and logged separately (old `server.ts` code: `providerStatus.pollOnce().catch(err => fastify.log.error(...))` on a `setInterval` timer), so it never surfaced to a browser request. After this PR, `refreshIfStale` calls `pollOnce()` → `runPoll()` directly inside the request, and `runPoll()` calls `this.store.providers.findById`/`upsert` (inside `reconcileRow`) and `getCurrent()` with no try/catch around the store I/O. I verified `outfitter/packages/api/src/store/mongo.ts`'s provider-collection methods (`findById`, `list`, and the upsert path) are plain MongoDB driver calls with no wrapping try/catch. A transient Mongo error (network blip, auth hiccup) during `reconcileRow` now rejects `runPoll()` → `pollOnce()` → the route handler's promise, turning a transient store failure into a 500 for the dashboard, instead of serving the last-known-good stored rows as before.

One thing that *is* correct here: `lastPollAt` is only set at the very end of `runPoll()` (providers-status.ts:409), so if the store throws partway through, `lastPollAt` stays stale and the next request will retry the poll rather than getting stuck believing it's fresh.

**Failure scenario:** Mongo Atlas has a brief connection hiccup (network partition, auth token refresh, primary failover) at the moment a Cloud Run "web" instance's cached provider data goes stale. The next browser request for `GET /api/providers` triggers `refreshIfStale` → `pollOnce` → `runPoll`, which throws inside `reconcileRow`'s `store.providers.upsert`. The promise rejects all the way up through the Fastify handler, and the dashboard gets a 500 instead of the rows it had a few minutes ago (which are still sitting in the store, readable via `getCurrent()`).

**Fix:** Wrap `runPoll()`'s reconcile/`getCurrent()` calls (or `pollOnce()` itself) in a try/catch that logs the error and falls back to `getCurrent()` (last stored rows), matching the old poller's failure-swallowing behavior. E.g.:
```ts
async refreshIfStale(maxAgeMs: number): Promise<ProviderRow[]> {
  if (Date.now() - this.lastPollAt < maxAgeMs) return this.getCurrent();
  try {
    return await this.pollOnce();
  } catch (err) {
    console.error("[providers] poll failed", err);
    return this.getCurrent();
  }
}
```

### [LOW] Stale doc language describing a background poller that no longer exists
**File:** `outfitter/docs/reports/providers-status.md:20-21,35-36`
**Confidence:** HIGH

**Issue:** The doc still reads "`ProviderStatusService.pollOnce()`... `Promise.allSettled` as a backstop... so a bug in one probe can't wedge **the poller**" and "...**not on every 5-minute tick**" — language that assumes a running background timer. Not factually wrong (`pollOnce` still exists and is still a backstop), but it reads as describing the removed timer-based model rather than the new poll-on-read model this PR ships.

**Fix:** Update the doc to describe the poll-on-read / single-flight model, mirroring the good in-code comments already added in `providers-status.ts` (e.g. around `refreshIfStale`).

### [LOW] Timeout test depends on a real 20ms wall-clock timer
**File:** `outfitter/packages/api/test/providers-status.test.ts:320-327`
**Confidence:** MEDIUM

**Issue:** `"a LiteLLM health check that times out says so instead of reporting HTTP 0"` passes `timeoutMs = 20` to `probeLitellm` and relies on the real `AbortController` timeout firing in 20ms of wall-clock time (no fake timers). This is a pre-existing pattern (mirrors `probeCloudRun`'s own timeout test elsewhere in the same file), not introduced fresh by this PR, but it is exercised more now since this PR added timeout-detail assertions on top of it. Under a sufficiently loaded CI runner, 20ms could in theory elapse before the fetch mock's `abort` listener is registered, making the assertion occasionally flaky.

**Fix:** Optional — not blocking. Could use fake timers or a slightly larger margin if this test is ever observed to flake.

## Checked and found sound

- **`inFlight` never gets stuck on rejection.** `this.inFlight ??= this.runPoll().finally(() => { this.inFlight = undefined; })` (providers-status.ts:382-388) — `.finally()` runs on both fulfillment and rejection, so a failing poll (see MEDIUM above) does not wedge single-flight; the next caller starts a fresh `runPoll()`.
- **`lastPollAt` semantics on partial probe failure.** Every individual probe (`probeNgrok`, `probeLaptop`, `probeLitellm`, `probeCloudRun`) already has its own internal try/catch and never throws, with `Promise.allSettled` as an additional backstop in `runPoll`. A probe reporting "down"/"unknown" still lets `runPoll` reach `this.lastPollAt = Date.now()` at the end — correct. Only a *store* I/O throw skips updating `lastPollAt`, which is the right behavior for that case (forces a retry on the next read).
- **SSE handshake is not broken by the read-time poll.** `routes/providers.ts:25-29` calls `ctx.sse.subscribe("providers", reply)` *before* `await refreshIfStale(...)`. `SseHub.subscribe` (`src/sse.ts`) writes response headers and calls `flushHeaders?.()` synchronously, so the client sees the stream open immediately; only the first `status` data frame is delayed by up to ~3s (bounded by `DEFAULT_TIMEOUT_MS`) while probes run. This is an accepted, documented tradeoff (explicitly called out in the PR description), not a handshake break.
- **Latency of a stale read stays parallel where it should.** The four probes run in parallel via `Promise.allSettled` (unchanged from before this PR), and inside `probeLitellm` the three sub-calls (`/health/liveliness`, `/model/info`, `/key/info`) also run via `Promise.all`. The only new work is `reconcileRow`'s per-row store round trips, which are already run in parallel across rows via `Promise.all(rows.map(...))`, followed by one `getCurrent()` call. Nothing was introduced that runs sequentially when it should be parallel.
- **Refresh cooldown vs. single-flight compose correctly.** `POST /api/providers/refresh` calls `pollOnce()` directly, bypassing the `lastPollAt` staleness check, but still shares the same `inFlight` promise with any concurrent GET-triggered poll. Verified via the "concurrent reads share one in-flight poll" test (`test/providers-status.test.ts:355-366`), which genuinely proves sharing: `refreshIfStale`/`pollOnce` have no `await` before assigning `this.inFlight`, so all three callers (`a`, `b`, `c`) synchronously join the same in-flight promise within one JS tick, before the gate is released. The 10s `REFRESH_COOLDOWN_MS` only throttles repeated manual-refresh clicks at the route layer; it does not fight or duplicate the single-flight mechanism.
- **No other code relies on the removed `startPolling`/`stopProviderPoller`.** Grepped the whole `outfitter/` tree (web, deploy, docs, scripts) for `startPolling`, `stopProviderPoller`, `providerPoll` — only remaining references are in `config.ts`'s doc comment (now updated to describe the new semantics), `routes/providers.ts`'s comment, and two docs files (`security-review-pr15.md`, `providers-status.md` — the latter flagged LOW above). `server.ts`'s `stopBackgroundTasks` correctly drops the `stopProviderPoller?.()` call along with the field.
- **Link role's webhook path is unaffected.** `noteLaptopTransition` (invoked by `routes/hooks.ts`'s ngrok webhook handler) is untouched by this diff and does not go through `pollOnce`/`refreshIfStale` at all — it reconciles the "laptop" row directly from the webhook event.
- **`failedResponse`/timeout-detail change is correct and consistent.** Distinguishes `AbortError` (timeout) from other network errors via `err.name === "AbortError"`, applied consistently in both `probeLaptop` (providers-status.ts:189-193) and `probeLitellm` (providers-status.ts:270-288). A real non-2xx response still reports `HTTP {status}` rather than the new error text — verified via the `health.ok` / `health.error` check ordering (`detail: health.ok ? undefined : health.error ? ... : \`health check HTTP ${health.status}\``), matching the PR description's claim that "real non-2xx responses still report their status."
- **Test coverage is adequate for the core claims.** New tests cover: timeout detail vs. HTTP-0 (providers-status.test.ts:320-327), network-error detail (329-334), non-2xx still reported (336-339), poll-on-first-read (343-353), fresh reads skip probing (349-350), stale reads poll (351-352), and single-flight sharing across `refreshIfStale` and `pollOnce` (355-366). The route test (`test/providers-status.test.ts:443-458`) now proves a plain `GET /api/providers` populates rows with no prior background poll having run, directly validating the PR's headline fix.

## Recommendation

**COMMENT** — No CRITICAL or HIGH issues at HIGH confidence. The MEDIUM finding (store-failure resilience regression) is worth a follow-up fix but does not block merging: it narrows failure isolation for a pre-existing (if now more directly reachable) failure mode, it does not break the core read-on-poll/single-flight/SSE design, and the adversarial checks against every specific concern raised (in-flight leakage, `lastPollAt` semantics, SSE handshake timing, probe parallelism, cooldown/single-flight interaction, removed-poller references, test adequacy) all held up under inspection.
