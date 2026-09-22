# Review: `outfitter/round-five-v2` vs `origin/main`

Adversarial review of 34 commits / 175 files (operator role + settings API, Gurus page +
`DELETE /api/gurus`, the retro UI redesign, Manual page + tour, static-file fallback changes).
Read-only review; only this file was written. All findings verified by reading the actual code
(not just the linked reports) and by running the test suite and production build myself.

## Verification performed

- `npm ci && npm run build` — clean build, all four workspaces (`agentd`, `api`, `provider-local`,
  `web`) compile with `tsc --noEmit` and Vite builds successfully.
- `npm test` (all workspaces) — **158/158** web tests, **196/196** api tests (1 pre-existing skip),
  agentd and provider-local suites all green. No failures.
- Read `packages/api/src/{auth,operator,secrets,config,server}.ts`, `routes/{operator,gurus,static,
  index}.ts`, `deploy/baseline.sh`'s IAM section, `packages/web/src/components/{Markdown,
  SystemErrorDialog,ErrorBoundary,UiRequestPanel,Composer}.tsx`, `lib/{retro-errors,thinking,
  session-header}.ts`, `hooks/useSessionStream.ts`, `App.tsx`, `pages/{DeskPage,ManualPage,
  GurusPage}.tsx`, `components/tour/{TourOffer,TourAnimation}.tsx`, `styles/mobile.css`, and the
  relevant test files (`operator.test.ts`, `gurus.test.ts`, `static.test.ts`).
- Grepped for `dangerouslySetInnerHTML`, `localStorage`/`sessionStorage`, CORS/CSRF setup, and
  hard-coded UI copy that should have gone through `vocabulary.ts`.

## Findings

### [MINOR] Single 519 KB (158 KB gzip) JS bundle, no code-splitting
File: `outfitter/packages/web` build output (`dist/assets/index-BLYxOa55.js`, 519.62 kB / 158.05 kB
gzip); Vite itself warns about it after `npm run build`.
Confidence: HIGH
Failure scenario: every visitor downloads and parses the entire tour animation (`TourAnimation.tsx`,
`scenes.tsx`, `tour-timeline.ts` — ~680 lines plus per-scene SVG components) and `react-markdown` +
`remark-gfm` on first paint, even if they never open `/manual` or a session transcript. On a slow
mobile connection (which `mobile-desk.md` explicitly targets) this is extra time-to-interactive for
zero benefit to that visit.
Fix: `React.lazy()` + `<Suspense>` around the `/manual` route (`App.tsx:136`) and/or around
`Markdown.tsx`'s usage in `SessionPage.tsx`/`EntryItem.tsx`, so the tour and markdown-rendering code
split into separate chunks loaded on demand. Not a blocker — 158 KB gzipped is still reasonable for
an internal tool — but worth doing before this grows further (glossary, more scenes, etc.).

### [MINOR] `TourOffer`'s default `tourPath` doesn't autoplay when triggered from the Manual page itself
File: `outfitter/packages/web/src/pages/ManualPage.tsx:34` (`<TourOffer />`, no `tourPath` prop) vs.
`outfitter/packages/web/src/components/tour/TourOffer.tsx:31` (`tourPath = "/manual"` default) vs.
`outfitter/packages/web/src/pages/DeskPage.tsx:351` (`tourPath="/manual?autoplay=1"`).
Confidence: MEDIUM
Failure scenario: a user who lands on `/manual` directly (e.g. a bookmark, or a link from outside
the app) before ever visiting the desk sees the "Take the 75-second tour?" dialog. Clicking "Take
the tour" calls `navigate("/manual")` — already the current route, so react-router does nothing,
and the animation does not start (no `autoplay=1`) and `markOffered()` has already fired, so the
offer won't reappear. The user has to notice and press the manual Play control themselves. This is
a real (if small) gap between "Take the tour" and the tour actually starting on this one path; it
works correctly when the offer originates from the desk.
Fix: give `ManualPage.tsx:34` the same `tourPath="/manual?autoplay=1"` DeskPage uses, or have
`takeTour()` in `TourOffer.tsx` set the query param itself via `useSearchParams` rather than relying
on `navigate` to a URL that may equal the current one.

### [LOW / style] `masked` secret value exposed to any operator regardless of which secret they're looking at, by design — confirmed sound, not a finding
Checked `secrets.ts:168-171` (`maskTail`) and `operators.md`'s explicit "Security choices": masking
threshold (>12 chars, last 4) is a deliberate, documented tradeoff, not an oversight. No action
needed — noting only because it was explicitly in scope to verify.

## Verified sound (no issue found)

**Security**
- **Operator gate**: every route in `routes/operator.ts` (`GET /settings`, `PUT/DELETE
  /secrets/:name`, `POST /secrets/:name/test`) carries `{ preHandler: requireOperator }`
  (`operator.ts:109,123,140,164`). `requireOperator` (`auth.ts:164`) 403s unless
  `req.identity.operator` — and that identity was already set by the auth preHandler in
  `server.ts:97` which runs first for every `/api/*` path except `/api/hooks/*`. An unauthenticated
  caller gets a plain 401 before ever reaching the operator check, matching `operators.md`'s claim.
- **Link-role tokens can never be operators**: `identityFromLinkRequest` (`auth.ts:101`) always
  calls `identityFromApiToken`, which unconditionally returns `operator: false`
  (`auth.ts:92`) — the `isOperator`/`OUTFITTER_OPERATORS` upgrade only happens inside
  `identityFromRequest` (`auth.ts:113-135`), which the "link" role never calls. Belt-and-suspenders:
  `routes/index.ts:22-37` never registers `registerOperatorRoutes` at all when `role === "link"`.
  Confirmed by `operator.test.ts:83-89` (`hasRoute` returns `false`) and by
  `auth.test.ts` (grepped: link-role identities tested as always non-operator).
- **Secret values never leak**: `GET /api/operator/settings` and every `secretRow()` response only
  ever include `masked` (last 4 chars, only over 12 chars long, `secrets.ts:168-171`) — the actual
  value is never serialized to a response. `PUT`/`DELETE`/`test` log only `{ operator: email,
  secretName }` (`operator.ts:136,160`), never the value. The `test` endpoint's request/response
  cycle uses the value in-memory only, never persists or logs it (`operator.ts:164-176`). No
  secret value appears in a URL anywhere (routes take the value from the body only).
- **Secret Manager name validation**: `isManagedSecretName` (`operator.ts:89-95`) is checked before
  every `PUT`/`DELETE`/`test` acts on a name — rejects anything not in the static list and not a
  `outfitter-litellm-key-<existing-guru-id>` pattern, explicitly excluding the bare `-default`
  suffix from the dynamic branch (would otherwise double-count the static entry). An attacker (an
  operator, since this is already gated) cannot write to an arbitrary Secret Manager secret name.
- **Custom IAM role** (`deploy/baseline.sh:90-109`, `outfitterSecretAdmin`): exactly
  `secretmanager.{secrets.create,secrets.get,versions.add,versions.disable,versions.list}` — no
  `versions.access` is *not* in the list, which is correct: the REST calls in `GcpSecretAdmin`
  actually use `:access` on a version, which needs `secretmanager.versions.access`... **checked
  more closely**: `secretAccessor` (the predefined role, still granted to `outfitter-api` at
  `baseline.sh:71-72`) already carries `secretmanager.versions.access`, so the custom role
  correctly omits it to avoid overlap — the two roles compose. Idempotent: `describe` before
  `create`, `update` on a re-run (`baseline.sh:93-108`), matching the rest of the script's pattern.
  Least-privilege: no `secrets.delete`, no `secrets.setIamPolicy`/`getIamPolicy` — matches
  `operators.md`'s stated rationale and is narrower than both alternatives it rejects.
- **CSRF/CORS**: no `@fastify/cors` is registered anywhere in `server.ts`, so there's no
  `Access-Control-Allow-Origin` header — cross-origin `fetch`/XHR reads of API responses from a
  third-party page are blocked by the browser regardless of credentials. State-changing routes
  authenticate via `Authorization: Bearer <outf_...>` (never auto-attached cross-site by a browser)
  or an IAP-signed header set by Cloud Run's IAP layer itself (not application-controlled cookies).
  I could not verify IAP's own cookie `SameSite` attribute from this repo (it's GCP-managed,
  outside this codebase) — flagging as an open question below rather than a finding, since nothing
  in this diff controls that behavior.
- **XSS / markdown**: `Markdown.tsx` uses plain `ReactMarkdown` with `remarkGfm` only — no
  `rehype-raw` or `rehype-sanitize` plugin is registered, so react-markdown's default behavior
  (never rendering raw HTML found in source text; showing it escaped as text) applies. Verified via
  `package.json`/imports: no `rehype-raw` dependency exists in the tree at all, so raw HTML embedded
  in a transcript literally cannot be turned into DOM nodes. The custom `a` renderer
  (`Markdown.tsx:9-13`) passes `href` straight to React's `<a>`, which relies on react-markdown's
  own `urlTransform` (defangs `javascript:`/unknown schemes before the component even sees them) —
  confirmed this is the library's documented default, not something this diff had to implement.
  Grepped the entire `packages/web/src` tree for `dangerouslySetInnerHTML`: zero matches.
- **Error boundary "copy details"**: `ErrorBoundary.tsx:9-11,21-29` only ever serializes
  `error.name`, `error.message`, and `error.stack` from a client-side render error already thrown
  in-browser — there is no path from server secrets (never sent to the browser in the first place,
  per the findings above) into an `Error` object here. Safe.
- **localStorage use**: `ThemeToggle`, `SoundToggle` (floppy-sound.ts), `TourOffer`, and
  `client.ts`'s dev-mode token are the only users, all wrapped in `try/catch` for unavailable
  storage, all storing non-sensitive UI preferences except the dev token — which only exists when
  `OUTFITTER_DEV=1`/local dev and is documented as such (`client.ts:4`). No production secret is
  ever written to `localStorage`.
- **Guru env denylist**: `DENYLISTED_GURU_ENV_KEYS`/`_PREFIXES` (`gurus.ts:29-41`) block
  `LITELLM_BASE_URL`/`LITELLM_API_KEY`/`LITELLM_AGENT_KEY`/`NODE_OPTIONS`/`LD_PRELOAD`/
  `LD_LIBRARY_PATH`/`PATH`/`HOME`/`GIT_*` on both `POST` and `PUT` (`gurus.ts:109-112,124-127`) —
  matches the credential-exfiltration/SSRF fix documented inline and in `security-review-pr15.md`.
  Confirmed by `gurus.test.ts`'s `LD_PRELOAD` rejection test on `PUT`.

**Correctness**
- **Guru CRUD is intentionally *not* operator-gated**: any signed-in user can create/edit/delete a
  gurus (`routes/gurus.ts` has no `requireOperator` on any handler). Initially flagged this as a
  possible gap, then confirmed against `EPIC.md`'s Decisions table (line 125: "Any signed-in user
  can still create sessions and edit gurus — the org-shared policy above is unchanged; operator is
  an additional capability, not a replacement for it") and `operators.md`'s opening paragraph — this
  is deliberate, not an oversight.
- **`DELETE /api/gurus/:id` rules**: 404 for unknown id, 400 for the reserved `"default"` id
  (checked *before* the reference check, so the default guru's 400 message is stable even if
  sessions reference it), 409 with an accurate `count` when sessions still reference the guru, 204
  on success. All four paths have a passing test (`gurus.test.ts`, `describe("DELETE
  /api/gurus/:id")`). Matches the story's design (`gurus.ts:135-155`).
- **SPA fallback (`servesSpaShell`)**: GET-only; `/api/`, `/agent/`, `/assets/` always excluded;
  anything whose last path segment contains a `.` (a file) gets a real 404 instead of the shell —
  correctly handles both `/sessions/:id` (shell) and `/sessions/a/b.map` (404, from a stale
  service-worker/cache asking for an old sourcemap). `static.test.ts` covers exactly this matrix,
  including the "only GET" case. Registered last in `routes/index.ts:31`, after every API route, so
  it can't shadow them.
- **`/` routing**: on this branch `/` is the desk (`DeskPage`) and `/fleet` is the session list —
  not a `/` → `/fleet` *move* as the task brief assumed, but a new split: the old fleet-at-`/`
  behavior moved to `/fleet` while `/` became the new desk. Checked every `navigate()`/`<Link
  to="/">`/`<NavLink to="/">` call site: `App.tsx:66` (logo → desk, correct), `NotFoundError.tsx:20`
  ("Back to the {desk}" → `/`, correct), `ErrorBoundary.tsx:88` ("Back to the desk" button →
  `window.location.assign("/")`, correct), `TourAnimation.tsx:232` (end-of-tour CTA → `/`, correct
  — returns to the desk, not the fleet). No stale `/fleet`-shaped link points at `/` or vice versa.
- **`apiErrorKind` mapping and call sites**: `retro-errors.ts:27-33` maps `>=500` or no status →
  `"system"` (bomb dialog), `401` → `"signedOut"`, `403` → `"sysopOnly"`, `404` → `"notFound"`,
  everything else `400-499` → `"refused"` (calm notice). Every `<SystemErrorDialog>` call site
  (`NewSessionDialog`, `GuruForm`, `TokensPage`, `SettingsPage` ×2, `SessionPage`, `FleetPage`,
  `GurusPage`) passes the same `ApiErrorState { status, message }` shape from `api-error.ts`, so the
  mapping applies uniformly. `retro-errors.test.ts` (20 tests) covers the boundary values (399/400/
  401/403/404/499/500) directly.
- **Thinking-block grouping**: `groupThinkingBlocks` (`thinking.ts:60-81`) correctly buffers
  consecutive `assistant-thinking` views into one group, flushing on any other view type or at the
  end; a lone thinking block still becomes a one-element group (documented, and correct — keeps
  `EntryItem` to one shape). `thinking.test.ts` (18 tests) exercises multi-run, single-block, and
  interleaved cases.
- **Session header derivation**: `deriveSessionHeader` (`session-header.ts:62-104`) correctly skips
  `aborted`/`error` stop reasons so a failed turn's zeroed/missing usage never overwrites a
  previously-good context reading, and only computes `percent` when a window is resolved and
  positive. Mirrors pi's own `calculateContextTokens` (native `totalTokens` preferred, else sum of
  components, `undefined` — not `0` — when nothing usable exists, so "no usage yet" is
  distinguishable from "usage was zero"). `session-header.test.ts` (11 tests) covers this.
- **`useSessionStream` merge**: `mergeEntries` (`useSessionStream.ts:20-24`) correctly treats the
  `GET .../entries` fetch as authoritative for anything it contains and appends only the entries
  that arrived over SSE in the race window before it resolved, preserving arrival order. The
  `cancelled` guard (`useSessionStream.ts:36,44`) is checked *before* `entryIds.current` is mutated
  in the `.then()` callback, so a stale response for a since-abandoned `sessionId` can't corrupt the
  new session's dedup set. `session-stream.test.ts` (4 tests) passes.
- **Composer send modes**: `Composer.tsx`'s `<select>` (desktop) and segmented `role="radiogroup"`
  buttons (mobile) both write the same `behavior` state (`""`/`"steer"`/`"followUp"`), and `send()`
  passes `behavior || undefined` so the plain-prompt case sends no `behavior` field at all rather
  than an empty string — matches `protocol.md`'s `prompt.behavior` being optional.
- **Tour offer shown once**: `TourOffer` reads/writes the same `localStorage["outfitterTourOffered"]`
  key regardless of which page mounts it (`DeskPage`/`ManualPage`), and only one of those pages is
  ever mounted at a time (they're different routes), so there's no double-render race — dismissing
  or taking the tour from either page suppresses it everywhere after. (See the MINOR autoplay
  finding above for the one real gap in this flow.)

**Mobile** (`styles/mobile.css`, `index.html`)
- `viewport-fit=cover` present in `index.html:5` alongside `width=device-width, initial-scale=1.0`.
- `env(safe-area-inset-{top,bottom,left,right})` used on the composer, header, and desk chrome
  (`mobile.css:75-76,103-105,312,414,430`).
- 16px input font confirmed with the documented rationale (iOS Safari auto-zooms inputs under 16px)
  at `mobile.css:20-28`.
- `100dvh` used for the mobile desk layout with a comment explaining why (`mobile.css:261,404`) —
  correctly targets iOS Safari's dynamic toolbar instead of the stale `100vh`.
- Composer `position: sticky` at both `mobile.css:307` and `:426`, paired with safe-area bottom
  padding at `:312`/`:430` — matches the sticky-composer claim.

**Maintainability**
- Grepped for hard-coded `"Guru"`/`"Session"`/`"Fleet"`/`"Providers"`/`"Tokens"`/`"Settings"` in
  user-facing JSX: the only matches are `glossary.ts`'s `codeName` fields (deliberately the
  *code* name shown next to the plain-language label in the Manual's glossary table, e.g. `<td>Tape
  </td><td><code>Guru</code></td>`) and a code comment in `Logo.tsx`. No page component hard-codes
  a label that should have come from `vocabulary.ts`.
- No `dangerouslySetInnerHTML`, no obvious dead code or duplicated logic spotted in the files read
  above; `operator.ts`/`secrets.ts`/`routes/operator.ts` cleanly separate the managed-secret catalog,
  the Secret Manager access layer, and the HTTP layer as the design doc describes.

## Open questions (not blocking)

- **IAP cookie `SameSite` / CSRF posture**: this diff adds no CORS/CSRF middleware, which is
  consistent with bearer-token auth, but the browser path also accepts an IAP-signed header that
  Cloud Run's IAP layer manages via its own session cookie. Whether that cookie is `SameSite=Lax`
  (blocks cross-site POST) is a GCP/IAP configuration detail outside this repo and this diff — I
  could not verify it by reading code. Worth a quick manual check (`document.cookie` /
  `Set-Cookie` header on the IAP login redirect) against the deployed service, but nothing in this
  PR changes that surface.

## Recommendation

**APPROVE.** No CRITICAL or HIGH-severity issues found at any confidence level. The operator gate,
link-role exclusion, secret masking/validation, custom IAM role, and markdown XSS posture all check
out under direct inspection. Both findings above are MINOR (bundle splitting, one tour-autoplay
edge case) and can be fixed in a fast-follow rather than blocking this branch. Full test suite
(354 total tests across agentd/api/provider-local/web) and production build are green.
