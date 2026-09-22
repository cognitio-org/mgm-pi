# Personal API tokens (E4.1b)

Replaces the never-working `OUTFITTER_IAP_CLIENT_ID` auth mode (critic review #1,
`docs/reports/critic-review-pr15.md`) with personal API tokens verified by the "link" role, so
`mgm --teleport`/`/teleport` has a real auth path against a real deployed Outfitter API.

## What

**Store** (`packages/api/src/store/types.ts`, `store/memory.ts`, `store/mongo.ts`): a new `tokens`
collection, `ApiToken { id, ownerEmail, name, prefix, hash, createdAt, lastUsedAt?, revokedAt? }`.
Plaintext format `outf_` + 32 random bytes (base64url), generated in
`packages/api/src/tokens.ts` (`generateToken`/`hashToken`/`tokenPrefix`) and never stored or
logged — only the sha256 hash and an 8-char display prefix persist. Mongo gets a unique index on
`hash` and a plain index on `ownerEmail`.

**Auth** (`packages/api/src/auth.ts`): `identityFromApiToken` resolves a bearer token to its
owner via a hash lookup, rejecting unknown and revoked tokens with the same generic message (never
reveals which), and updates `lastUsedAt` at most once a minute, best-effort. Two entry points sit
on top of it:
- `identityFromLinkRequest` — the **"link" role's only** `/api/*` credential. No IAP, no dev-mode
  shortcut: `OUTFITTER_TOKEN` is meant to behave identically in dev and prod.
- `identityFromRequest` — extended for **"web"/"all"**: tries an `outf_`-prefixed bearer first,
  falls back to the existing IAP header check. `OUTFITTER_DEV=1` still short-circuits to
  `dev@localhost` before either check runs, unchanged from before this story.

**Routes**: `packages/api/src/routes/tokens.ts` (new) — `GET|POST /api/me/tokens`,
`DELETE /api/me/tokens/:id`, "web"/"all" role only, capped at 10 active tokens per owner, owner-
scoped revoke (404, not 403, for someone else's token — doesn't confirm it exists). `POST` returns
the plaintext exactly once (`{ token, record }`); every other response strips `hash`.
`routes/sessions.ts` is refactored: the exact subset teleport needs (`GET /api/sessions`,
`GET /api/sessions/:id`, `GET /api/sessions/:id/export.jsonl`, `PUT /api/sessions/:id/import`,
`POST /api/sessions/:id/stop`) now lives in an exported `registerTeleportRoutes`, called once by
`registerSessionRoutes` (web/all, unchanged behavior) and once directly by `routes/index.ts` for
the "link" role (no duplicated handler logic). `routes/index.ts`'s link branch also registers
`registerMeRoute` so a teleport client can sanity-check its token via `GET /api/me`.
`routes/me.ts` now returns `linkOrigin` (from new config `OUTFITTER_LINK_ORIGIN`, env-only, "web"
role) so the Tokens page can print the exact `OUTFITTER_API` value.

**server.ts**: the auth preHandler is now unconditional (previously skipped entirely for
`config.role === "link"`) and branches by role: `identityFromLinkRequest` for "link",
`identityFromRequest` otherwise. `/api/hooks/*` stays carved out either way.

**Web UI** (`packages/web`): `src/api/client.ts` gains `listTokens`/`createToken`/`revokeToken`
and `me()`'s return type gains `linkOrigin`. New `src/pages/TokensPage.tsx` at `/tokens` (nav link
"Tokens" in `App.tsx`): lists name/prefix/created/last-used with a Revoke button, a create form
that shows the plaintext once with a "Copy token" button and the exact
`OUTFITTER_API`/`OUTFITTER_TOKEN`/`MGM_TELEPORT_STORE` lines (falls back to "ask your operator for
the link URL" when `linkOrigin` is empty) plus a "Copy env lines" button.

**mgm** (`mgm/.pi/extensions/teleport/outfitter-store.ts`): the `OUTFITTER_IAP_CLIENT_ID` mode —
`gcloud`-shelling, `GcloudTokenFn`, cached IAP token, the whole branch — is removed, not just
disabled. The constructor now throws immediately if `OUTFITTER_TOKEN` is unset (previously it
would construct fine and only fail on first use with neither auth mode configured). The 401
message is now always: *"OUTFITTER_TOKEN was rejected; create a new token on the Outfitter Tokens
page."* `mgm/README.md`'s Outfitter store section rewritten to match: `OUTFITTER_API` is
documented as the **link** service's origin (not the browser-facing `outfitter-api` service), the
three env lines, and a short paragraph on why the removed IAP mode never worked (so a reader who
remembers seeing it doesn't wonder if it was silently broken).

**deploy/service.sh**: documents and wires `OUTFITTER_LINK_ORIGIN` for the "web" role deploy
(optional; chicken-and-egg on a brand-new project — deploy "link" first to learn its URL, then
re-run `./api.sh` with it set).

**Docs**: `outfitter/docs/protocol.md` gets a "Personal API tokens (E4.1b)" section (format,
routes, verification, which role accepts what, `linkOrigin`, and a note on what this replaces).
`EPIC.md`'s E4.1 entry rewritten: done, points at this report, describes the token mechanism and
that the IAP mode is fully removed (not just flagged broken).

## How verified

- `cd outfitter && npm test` — **all packages pass**: agentd 140/140, api 147/147 (new
  `test/tokens.test.ts`: creation/list/revoke, the 10-token cap, link-role bearer auth including a
  missing/malformed/revoked token, `lastUsedAt` throttling, dev-mode-gives-no-free-pass on the link
  role, every teleport route reachable on the link role with a valid token, and the web/all role
  accepting an `outf_` token alongside IAP), provider-local 2/2, web 27/27 (new client tests for
  `listTokens`/`createToken`/`revokeToken`/`me().linkOrigin`).
- `cd outfitter && npm run build` — clean (agentd, provider-local, web all build; api has no
  separate build step, exercised via its own typecheck+test).
- `npx tsc --noEmit` clean in both `packages/api` and `packages/web`.
- `cd mgm && npm test` — **230/230 pass**, including the rewritten
  `tests/teleport-outfitter.test.ts` (construction requires `OUTFITTER_API` *and*
  `OUTFITTER_TOKEN`, the corrected 401 message, and the unchanged list/get/put/stop-poll/`--force`/
  timeout behavior).
- Updated one pre-existing test (`packages/api/test/roles.test.ts`'s "OUTFITTER_ROLE=link" describe
  block) that asserted the *old* intended behavior (404 for `GET /api/sessions` on the link role);
  it now asserts the link role registers the route but rejects an unauthenticated request (401),
  and added a companion test confirming web-only routes (`POST /api/sessions`, `/api/gurus`,
  `/api/sessions/:id/entries`) are still absent there.
- Not exercised: a real deployed link + web pair (Cloud Run). Everything above is against
  in-memory `Store`/`light-my-request` (api) and a fake `fetch` (mgm) — same caveat E4.1's original
  entry already carried for the (now-removed) IAP mode, and consistent with how every other E4.x
  story in this codebase has been verified so far.

## What's left

- End-to-end verification against a real deployed `outfitter-link` + `outfitter-api` pair: create a
  token via the real web UI, set the three env vars, run `mgm --teleport <id>` against it. Nothing
  in this change is mocked in a way that should make that fail, but it hasn't been run.
- `deploy/service.sh` documents `OUTFITTER_LINK_ORIGIN` but doesn't auto-discover it (the web role
  deploy has no way to look up a *different* Cloud Run service's URL without extra IAM/API calls
  this change didn't add) — an operator has to pass it explicitly after the link role's first
  deploy. Automating that lookup would remove one manual step.
- No token expiry or rotation UI (revoke is manual, no "expires in N days"). Not requested by this
  story's design; flagged for awareness only. *Later:* tokens now expire 90 days after creation
  (`TOKEN_TTL_MS`, checked in `identityFromApiToken`), and operators can revoke every token for an
  email or @domain via `POST /api/operator/tokens/revoke` (deploy/README.md Rollback).
- `packages/web`'s `TokensPage` has no dedicated component test (the client-layer calls it makes
  are tested in `test/client.test.ts`, matching how `NewSessionDialog`/`FleetPage` etc. are — none
  of this package's pages have their own render tests today).
