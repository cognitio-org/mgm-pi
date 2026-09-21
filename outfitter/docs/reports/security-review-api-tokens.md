# Security Review — Personal API Tokens (E4.1b)

**Scope:** `git diff outfitter/round-four...outfitter/api-tokens`, worktree
`pi-agent-teleport-84d05f`. Focus: `packages/api/src/{tokens.ts,auth.ts,server.ts,routes/tokens.ts,
routes/sessions.ts,routes/index.ts,routes/me.ts,store/memory.ts,store/mongo.ts,store/types.ts,
config.ts}`, `packages/web/src/pages/TokensPage.tsx`, `packages/web/src/api/client.ts`,
`mgm/.pi/extensions/teleport/outfitter-store.ts`, `.github/workflows/outfitter-ci.yml`.

**Risk Level:** LOW — the token mechanism itself is sound; findings below are pre-existing
authorization-model gaps this change extends to a new credential type (already known/accepted
design), plus a low-severity TOCTOU on the token cap.

## Summary
- Critical Issues: 0
- High Issues: 0
- Medium Issues: 0
- Low Issues: 2

---

## Low Issues

### 1. `POST /api/me/tokens`'s 10-token cap has a TOCTOU race
**Severity:** LOW
**Category:** A04 (Insecure Design) — business-rule race, not an authz bypass
**Location:** `packages/api/src/routes/tokens.ts:34-37` (count-then-insert, no transaction/atomic
guard); `store/mongo.ts:311-313` (`countDocuments` is a separate operation from the later
`insertOne` at `:291`); `store/memory.ts:251-253` (same shape in-memory).
**Exploitability:** Remote, authenticated as the token owner only (their own account) — an attacker
cannot use this against another user's cap, only inflate their own.
**Blast Radius:** A caller firing N concurrent `POST /api/me/tokens` requests can end up with more
than 10 active tokens (each request reads `countActiveForOwner` before any of the concurrent
inserts commit). This is a self-inflicted limit bypass, not a privilege escalation — the cap is a
UX/hygiene guard ("revoke one before creating another"), not a security boundary; extra tokens are
still owner-scoped and individually revocable.
**Issue:** `countActiveForOwner` + `insert` is check-then-act with no lock, unique constraint, or
transaction tying the two together. Mongo's `tokens` collection only has a unique index on `hash`
(`store/mongo.ts:369`), nothing on `(ownerEmail, revokedAt)` count.
**Remediation:** Low priority given the limited blast radius; if it's worth closing, wrap the
check+insert in a Mongo transaction, or accept up to N+concurrent-requests and rely on the
existing revoke UI, or (simplest) re-check the count inside a `findOneAndUpdate`-style atomic
upsert pattern is overkill here — a documented "the cap is best-effort, not a hard security
boundary" note in `tokens.ts`'s comment would be a cheaper fix than code.

### 2. `PUT /api/sessions/:id/import` has no per-line size/count bound beyond Fastify's default `bodyLimit`
**Severity:** LOW
**Category:** A04 (Insecure Design) / A05 (resource exhaustion)
**Location:** `packages/api/src/routes/sessions.ts:126-164` (unchanged logic, now reachable by any
token holder via the link role, not just IAP browser sessions); `server.ts:43` (`Fastify({ logger:
true, forceCloseConnections: true })` — no explicit `bodyLimit` override, so Fastify's built-in
default of 1 MiB applies to every route including this one, since `addContentTypeParser` for
`application/x-ndjson`/`application/jsonl` at `server.ts:47-51` does not change the size limit,
only how the body is parsed).
**Exploitability:** Remote, authenticated with any valid personal token (or IAP session) — same
population that can already create/stop/export sessions.
**Blast Radius:** Bounded by Fastify's 1 MiB default `bodyLimit` (confirmed no override exists in
this diff or pre-existing code) — a request over that limit is rejected with `413` before the
handler runs, so this is not an unbounded-memory DoS vector. Within that 1 MiB, `body.split("\n")`
and a `JSON.parse` per line run with no cap on line count — a 1 MiB body of many short lines is
cheap to parse (no algorithmic blowup: `JSON.parse` is linear, `insertIfNew` is O(1) per entry), so
the practical impact of this path is negligible. This is *not a new gap* introduced by this diff —
the import handler's body/line handling is byte-for-byte unchanged from before the tokens work,
just refactored into `registerTeleportRoutes` so both roles share it (confirmed via `git diff
outfitter/round-four...outfitter/api-tokens -- packages/api/src/routes/sessions.ts`, which shows a
pure move, no logic change). What *is* new is that this endpoint is now reachable with a personal
API token instead of only an IAP session — same authenticated-user population, so no new attacker
population is enabled, but worth stating explicitly since the review was asked to check it.
**Remediation:** No action required given the existing 1 MiB cap and the population being
unchanged. If large real-world sessions ever need imports over 1 MiB, raising `bodyLimit`
explicitly (rather than leaving it implicit) would be the moment to also add an explicit line-count
guard; not warranted today.

---

## What Was Checked and Found Sound

- **Token entropy and generation** (`packages/api/src/tokens.ts:11-13`): `generateToken()` is
  `"outf_" + randomBytes(32).toString("base64url")` — `randomBytes` is Node's CSPRNG
  (`crypto.randomBytes`, backed by OpenSSL/BoringSSL's RNG), 32 bytes = 256 bits of entropy,
  base64url-encoded to ~43 chars. This is far beyond brute-forceable (2^256 keyspace) and uses a
  cryptographically secure source, not `Math.random()` or a weak PRNG.
- **Hashing at rest** (`tokens.ts:16-18`, `store/types.ts:142-158`): only `sha256(token)` (hex) and
  an 8-char display `prefix` (computed once, at creation, from the plaintext) are ever persisted;
  the plaintext itself is never written to the store, logs, or any field returned by
  `POST /api/me/tokens` after the initial 201 response (`routes/tokens.ts:52`, immediately followed
  by `publicToken()` stripping `hash` from every other response at `:16-19`). Grepped the full diff
  for `console.log|logger\.|fastify\.log` touching `token`/`record.hash`/`plaintext` — no match;
  the only place the plaintext string exists server-side is the local `plaintext` variable in the
  `POST` handler, which goes out of scope after the response is sent.
- **Timing of hash lookup vs. compare** (`auth.ts:64-77`): `identityFromApiToken` computes
  `hashToken(bearer)` (a full SHA-256 over attacker input, itself timing-safe with respect to the
  *unknown* stored hash — SHA-256 has no data-dependent branching that leaks preimage bits) then
  looks the digest up by exact match: `store.tokens.findByHash(hash)` — a Mongo indexed query
  (`store/mongo.ts:299-301`, `findOne({ hash })`) or, in `MemoryStore`, a linear scan doing
  `row.hash === hash` string equality (`store/memory.ts:237-242`). Neither comparison is
  constant-time against the *hash value*, but that is not exploitable here: unlike comparing a
  plaintext secret byte-by-byte (where early-exit timing leaks which prefix bytes are correct), the
  attacker being timed would need to already possess a candidate whose SHA-256 collides/matches a
  stored digest — timing differences in a hash-value comparison leak nothing about the underlying
  256-bit token that isn't already protected by SHA-256's preimage resistance. This is the same
  threat model as looking up any hashed API key/password hash by exact-match index (the general
  best practice `timingSafeEqual` guidance applies to comparing *secrets*, e.g. HMAC signatures or
  raw tokens, not to indexed hash-digest lookups) — sound as implemented, and consistent with how
  `runTokenHash` is compared for agentd's run token per `docs/reports/security-review-pr1.md`
  finding #2 (that one *does* use `timingSafeEqual` because it's comparing two hash buffers
  directly rather than going through a store index — a stricter but equally sound approach; this
  code's approach is not weaker in any way that matters).
- **Revoked-token rejection on every path**: `identityFromApiToken` throws the same generic "invalid
  or revoked API token" for both an unknown hash and a `record.revokedAt` hit (`auth.ts:65-66`) —
  confirmed by `test/tokens.test.ts:131-147` ("a revoked token is rejected the same way an unknown
  one is (401, generic message)"). Both the link role (`identityFromLinkRequest`, unconditional) and
  the web/all role's bearer branch (`identityFromRequest`, `auth.ts:93-94`) route through this same
  function — there is exactly one place a token is checked against `revokedAt`, not two independently
  maintained checks that could drift. Verified web/all-role rejection isn't separately tested in
  `tokens.test.ts`, but the shared-function structure makes divergence between roles structurally
  impossible (both call `identityFromApiToken`, not a role-specific copy).
- **Link-role route surface**: enumerated via `routes/index.ts:19-33` and confirmed at runtime by
  `test/roles.test.ts:37-45` — the `"link"` role registers exactly `registerTeleportRoutes` (`GET
  /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/export.jsonl`, `PUT
  /api/sessions/:id/import`, `POST /api/sessions/:id/stop`) + `registerMeRoute` (`GET /api/me`) +
  `registerHookRoutes` (`POST /api/hooks/ngrok`, unauthenticated by design, unrelated to tokens).
  Confirmed *absent*: `POST /api/sessions`, `GET /api/gurus`, `GET /api/sessions/:id/entries`,
  `/api/sessions/:id/stream`, `/api/sessions/:id/messages`, `/api/sessions/:id/abort`,
  `/api/sessions/:id/wake`, `/api/sessions/:id/ui-response`, `/api/sessions/:id/diff`,
  `/api/environments*`, `/api/providers*`, `/api/me/tokens*` (token management, deliberately
  web/all-only per `routes/tokens.ts`'s own module comment), and `/agent/ws` (registered separately
  in `server.ts:101-104`, gated on role `!== "web"`, so `"link"` *does* get it — by design, that's
  the agentd socket, not a token-auth route, and it authenticates via `verifyAgentToken`, a wholly
  separate path never touched by this diff). CI's `images` job (`outfitter-ci.yml:43-47`)
  independently confirms `GET /api/sessions` on the link role is 401 unauthenticated / 401 with a
  garbage bearer, and `GET /api/gurus` is 404 (route not registered at all) — a live, black-box
  check that the route surface matches the source-level enumeration. No route beyond the intended
  teleport subset is reachable with a link-role token.
- **`PUT /api/sessions/:id/import` — can it overwrite another user's session?**: the route has no
  ownership check (`sessions.ts:126-164`), so yes, in principle — but this is the pre-existing,
  already-documented "every session route is open to every authenticated domain user, ownership
  recorded but not enforced" gap (`store/types.ts:13-17`'s `Session.ownerEmail` doc comment,
  `security-review-pr1.md` finding #5, tracked as an open decision under EPIC.md's E2.2). This
  diff does not introduce that gap; it extends the *existing* population (any IAP-authenticated
  domain user) to also include anyone holding a valid personal API token for that same population
  (a token can only be created by an already-authenticated web/all-role caller — `routes/tokens.ts`
  requires `req.identity`, which on the web/all role still means IAP or an existing token). So the
  set of principals who can overwrite/import into any session id is unchanged in *size* (still "any
  org member with API access"), only in *credential type* (now also a personal token, not just an
  IAP cookie). Flagging explicitly per the task's request, but this is not a new finding —
  restating the existing E2.2 gap in this diff's context, not a regression.
- **Body size on import**: see Low Issue #2 above — bounded by Fastify's 1 MiB default `bodyLimit`,
  no override present.
- **JSONL validation on import**: `header = JSON.parse(lines[0])` and each `entry = JSON.parse(line)`
  are not wrapped in `try/catch` (`sessions.ts:135,157`) — a malformed line throws, which Fastify's
  default error handler turns into a `500` with a generic JSON error body (no stack trace or
  internal detail leaked to the client; Fastify's default `SyntaxError` handling does not echo the
  parse input back). This is unchanged from the pre-existing (web/all-role-only) behavior of this
  route — not a new gap, and not an information-disclosure issue as implemented (confirmed no
  custom error handler in this diff echoes request bodies). Structural validation beyond "first line
  is type:session with matching id" is intentionally minimal, consistent with `docs/protocol.md`'s
  description of this endpoint as accepting "same id" JSONL re-imports from a trusted (self-authored,
  self-exported) round trip — worth noting as a design choice, not re-flagging as a bug since it's
  unchanged by this diff.
- **`POST /api/sessions/:id/stop` reachable with a token — can any token holder stop anyone's run?**:
  Yes — same pre-existing no-ownership-check population as above (`getSessionOr404` has no owner
  filter; `sessions.ts:79-115` unchanged logic, confirmed via diff, just relocated into
  `registerTeleportRoutes`). This matches the org-shared visibility policy already in effect for
  every other session route on the web/all role; the task asked to flag explicitly if the token
  path goes *beyond* that policy — it does not. A token can stop any session in the shared org
  store, same as an IAP-authenticated browser request already could. No new authorization boundary
  is crossed; stating this for the record rather than as a new finding.
- **Dev-mode interactions**: `identityFromLinkRequest` (`auth.ts:82-86`) takes no `Config` parameter
  at all and never checks `devMode` — confirmed by reading the function body and by
  `server.ts:89-90`'s call site (`config.role === "link" ? await identityFromLinkRequest(req,
  store) : ...` — `config` is passed to the *other* branch only). `OUTFITTER_DEV=1` on the link
  role therefore grants **no** free identity; a request still needs a real, unrevoked `outf_` token
  or gets 401. Verified live by `test/tokens.test.ts:149-158` ("dev mode gives no free pass on the
  link role"). On web/all, `identityFromRequest`'s devMode short-circuit (`auth.ts:91`) fires
  *before* the bearer check, so in dev mode a bearer token (real or garbage) is silently ignored
  and every caller is `dev@localhost` regardless — confirmed by
  `test/tokens.test.ts:232-242`. This is intentional and pre-existing dev-mode behavior (not new),
  and is only reachable when an operator has explicitly set `OUTFITTER_DEV=1`, which is documented
  as a local/dev-only flag.
- **Does the new bearer path shadow or weaken the web-role IAP check?**: No —
  `identityFromRequest`'s order is (1) devMode fixed identity, (2) `outf_`-prefixed bearer via
  `identityFromApiToken`, (3) IAP JWT verification (`auth.ts:90-109`), unchanged from before this
  diff in every respect except the new step (2) being inserted between (1) and (3). Step (2) only
  triggers when `bearer?.startsWith(TOKEN_PREFIX)` (`auth.ts:94`) — a bearer token that is present
  but does *not* start with `outf_` (e.g. a stray/malformed `Authorization` header) falls through to
  the unchanged IAP path, so a browser session presenting both an IAP cookie and some unrelated
  bearer header still gets verified by IAP exactly as before. The IAP verification code itself
  (`OAuth2Client`, `getIapPublicKeys`, `verifySignedJwtWithCertsAsync`, the `email_verified` check)
  is byte-for-byte unchanged by this diff (confirmed via `git diff` — the only change to that
  function is the new early-return branch for the token case). No weakening or shadowing found.
- **Log/detail leakage of plaintext tokens or hashes**: `Fastify({ logger: true, ... })`
  (`server.ts:43`) uses Fastify's default Pino request/response serializers, which log
  `{ method, url, host, remoteAddress, remotePort }` and response `{ statusCode }` by default — not
  headers, and specifically not `Authorization` — confirmed no custom `serializers`/`redact` config
  was added or needed to be added in this diff (no pre-existing custom serializer that logs headers
  either). Grepped every new/changed file for `console.log|\.log(|logger\.` touching a token/hash
  variable — none found; the only logging call in the tokens path family is Fastify's own request
  logger, which never sees the parsed `bearer`/`hash`/`plaintext` values (those live in application
  code, not the HTTP layer's log fields). `routes/tokens.ts`'s `publicToken()` helper
  (`:16-19`) strips `hash` before every response body that isn't the one-time `POST` response, and
  `record.hash` is never destructured into anything logged.
- **Web page (token shown once, clipboard, no token in URL)**:
  `TokensPage.tsx:81-109` — the plaintext (`justCreated.token`) is held only in React component
  state (`useState`), rendered in a `<code>` element, copied via `navigator.clipboard.writeText`
  (`copyToClipboard`, `:11-15`, wrapped in `.catch()` so a clipboard-permission failure doesn't
  throw), and never appears in any URL (`createToken` posts a fresh generated token, the response is
  consumed and stored purely client-side — `client.ts:157-159`'s `createToken` uses a `POST` with a
  JSON body, no query string). `justCreated` is only cleared by the explicit "Done" button or a
  full reload — a legitimate UX tradeoff (so the user has time to copy it) with no code path that
  persists it (no `localStorage`/`sessionStorage` write of the token found in the diff — confirmed
  via grep for `localStorage`/`sessionStorage` in `TokensPage.tsx`, zero matches; the only
  `localStorage` use in the whole web package is the unrelated `outfitterDevToken` dev-mode key in
  `client.ts:117`, pre-existing and out of scope).
- **mgm store (token in error messages, argv, logs)**:
  `outfitter-store.ts` — `this.token` is read once from `OUTFITTER_TOKEN`/`opts.token`
  (constructor, `:83-89`) and used only inside `authHeader()` (`:106-108`) to build the
  `Authorization` header for `fetchFn`. Grepped every error-throwing branch in `request()`
  (`:110-127`) — the 401/403/generic-failure messages interpolate `method`, `path`, `res.status`,
  and `res.text()` (the *server's* response body), never `this.token` or `this.authHeader()`. No
  `console.log`/`process.argv` manipulation of the token anywhere in the file (confirmed — the
  module never touches `process.argv` at all; `execFile`/`gcloud`-shelling from the old IAP mode is
  fully removed, not just disabled, so there's no argv-based credential exposure surface left
  either). No `fs.writeFile`/disk persistence of the token (confirmed no `node:fs` import in the
  file).
- **10-token cap race**: see Low Issue #1.
- **Mongo unique index on `hash`**: `store/mongo.ts:369` — `createIndex({ hash: 1 }, { unique: true
  })`. Since `hashToken` is a deterministic SHA-256 of 256 bits of CSPRNG entropy, a real hash
  collision between two independently generated tokens is cryptographically infeasible (this index
  exists as a defense-in-depth invariant, not because collisions are expected); on the
  vanishingly-unlikely event of a collision, `insertOne` would throw a duplicate-key error (code
  `11000`) that `TokensCollection.insert` does not catch (unlike `MongoEntries.insertIfNew`'s
  `isDuplicateKeyError` handling at `:96-98`) — an uncaught exception would surface as a `500` to
  the token-creation caller rather than silently overwriting or misattributing an existing token to
  a new owner. That fail-closed behavior (error, not silent data corruption) is the sound outcome
  for an event this improbable; no remediation needed.
- **Secrets scan**: grepped the full diff for `api[_-]?key|password|secret|token` literals — every
  match is a field/variable/env-var name, a doc-comment reference, or a synthetic test value
  (`"tok-123"`, `"bad"`, `outf_not_a_real_token`, `outf_not-a-real-token` — all clearly-fake test
  fixtures, never a real generated token). No hardcoded credential values in source or CI.
- **Dependency audit**: `npm audit --omit=dev` against `outfitter/package-lock.json` (covers every
  package touched by this diff — `packages/api`, `packages/web`, `mgm`) reports **0
  vulnerabilities**.
- **CI's black-box auth assertions** (`.github/workflows/outfitter-ci.yml:43-47`): boots the real
  built image in the link role and confirms, against the running server (not just unit tests):
  unauthenticated `GET /api/sessions` → 401, garbage-bearer `GET /api/sessions` → 401, `GET
  /api/gurus` → 404 (route absent). This is an independent, deployment-shaped confirmation of the
  route-surface and auth-rejection findings above, not just in-process `light-my-request` coverage.

## Security Checklist
- [x] No hardcoded secrets
- [x] All inputs validated (token creation `name` required and trimmed; import/stop routes'
  pre-existing validation unchanged by this diff)
- [x] Injection prevention verified (hash lookups are indexed-field equality, not
  string-concatenated queries; no SQL/NoSQL injection surface introduced)
- [x] Authentication/authorization verified (token generation, hashing, revocation, dev-mode
  isolation, route-surface enumeration all confirmed sound; pre-existing lack of session-ownership
  enforcement noted as unchanged, not introduced, by this diff)
- [x] Dependencies audited (`npm audit`: 0 vulnerabilities)
