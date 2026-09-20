# Critic review — PR #15 (`outfitter/round-four`)

Operator-perspective review: ran the API + web UI end to end in memory mode, read the IAP auth path
against the real deployed API, and checked EPIC.md's claims against the code. Scope: `git diff
origin/main...HEAD` in this worktree (d6f342d, ab6640f, a3574e8, da97b72, 7f666dd).

## Ranked findings

### 1. CRITICAL — `MGM_TELEPORT_STORE=outfitter` almost certainly cannot authenticate against the deployed IAP-fronted API as configured

`mgm/.pi/extensions/teleport/outfitter-store.ts:10-15` and `mgm/README.md:418-424` both assert, as
settled fact: "Google's Identity-Aware Proxy accepts that header on programmatic (non-browser)
requests: IAP verifies it itself and forwards to the API with `x-goog-iap-jwt-assertion` set." EPIC.md
repeats this under E4.1, marked **done**: "IAP accepts that header on programmatic requests and
verifies it itself, so no API-side change was needed for that path" (EPIC.md diff, E4.1 section).

That claim conflates two different audiences:

- `IAP_AUDIENCE` (`outfitter/deploy/service.sh:116`, `/projects/{num}/locations/{region}/services/
  {service}`) is the audience IAP itself signs into the *internal* `x-goog-iap-jwt-assertion` header
  when it forwards an already-authenticated request to the backend (`packages/api/src/auth.ts:37-54`
  verifies exactly this — correct).
- The audience an **external caller** must put in its own `Authorization: Bearer` token to get past
  IAP in the first place is Google's IAP OAuth 2.0 client ID (a `NNNN-hash.apps.googleusercontent.com`
  value), not the resource path. Per Google's IAP programmatic-authentication docs: "the audience must
  match the IAP OAuth client ID exactly; if you use a different audience, IAP rejects the token with a
  401" (https://docs.cloud.google.com/iap/docs/authentication-howto).
- Worse: `deploy/service.sh:118` deploys with plain `gcloud run deploy --iap` — no `--iap-oauth2-*`
  flags, no custom OAuth brand/client is created anywhere in `deploy/`. That means the service uses
  the **Google-managed OAuth client** (confirmed by Google's own Cloud-Run-IAP codelab: "IAP uses a
  Google-managed OAuth client to authenticate users"). Per Google's docs, a Google-managed IAP OAuth
  client's credentials are not something the caller owns, so it "cannot [be used for] programmatic
  access" at all — only browser/user-consent flows work against it.
- `OUTFITTER_IAP_CLIENT_ID` is never computed, printed, or documented anywhere in `deploy/*.sh` or
  `deploy/README.md` — grepping the whole `deploy/` tree for "oauth-brand"/"oauth-client"/"OAuth
  client" returns nothing. An operator following `mgm/README.md`'s instructions has no way to obtain
  the value the variable is supposed to hold, and even if they minted an identity token for the
  resource-path audience shown in the code comment, it would be rejected by IAP before ever reaching
  `auth.ts`.

EPIC.md's own E4.2 entry admits this was never exercised against the real thing: "end-to-end testing
against a real deployed API (only unit-tested against a fake fetch so far)" — but that caveat is
attached to the wrong story (E4.2, repo/clean-tree verification) while E4.1 (the auth mechanism itself)
is marked flatly "done" with no such caveat, and the auth comment in the source treats the IAP
acceptance claim as verified engineering fact rather than an untested assumption.

- Confidence: HIGH (Google's own docs directly contradict the "IAP accepts that header on programmatic
  requests" claim for a Google-managed-OAuth-client deployment, which is what `deploy/service.sh`
  produces).
- Why this matters: this is the entire "cloud → laptop" pull path for the flagship real deployment
  (`https://outfitter-api-hqt4zwr5za-uc.a.run.app`). `OUTFITTER_TOKEN` (the other auth mode) is
  explicitly dev-only. If IAP mode doesn't work, **`mgm --teleport <id>` has no working auth path
  against the real deployed API at all** — every pull attempt fails with a 401 that `outfitter-store.
  ts:137-144` reports as "sign in with `gcloud auth login`," which is the wrong remediation and will
  send an operator in circles re-authenticating an account that was never the problem.
- Fix: either (a) provision a custom OAuth brand/client for IAP (`gcloud iap oauth-brands create` /
  `gcloud iap oauth-clients create`) in `deploy/baseline.sh` or `service.sh`, print the client ID, and
  have `OUTFITTER_IAP_CLIENT_ID` reference that value with the docs corrected accordingly; or (b) drop
  the IAP-Bearer approach and instead have the store hit the API through a documented service-account
  impersonation flow that Cloud Run's own IAM invoker (not IAP) accepts, with IAP's `httpsResourceAccessor`
  role granted to the caller; or (c) at minimum, mark E4.1 as unverified in EPIC.md and soften the
  auth.ts/README comments from assertion to "expected but unverified — confirm before relying on this
  in prod," and reword the 401 error message to not exclusively blame the gcloud account when the audience
  itself may be wrong.

### 2. MAJOR — `outfitter/EPIC.md` does not mark E3.1/E3.2/E3.4 (this PR's own web UI stories) as done, inconsistent with its own convention

Commit `ab6640f` in this PR ships the fleet list, session view, and new-session dialog — exactly E3.1,
E3.2 and E3.4 per its own commit message ("Outfitter: web UI package (E3.1 fleet list, E3.2 session
view, E3.4 new session dialog)"). Yet `EPIC.md:331-339` still lists these as plain, unannotated
backlog bullets, with no "(done, ...)" marker and no implementation report cross-reference — unlike
every other story touched in this branch (E2.10, E2.11b, E4.1, E2.13 all got a "(done, ...)" prefix and
a report link). `outfitter/docs/reports/web-ui.md` exists (123 lines, added in this PR) but EPIC.md
never links to it from the E3 section.

- Confidence: HIGH (directly comparable diff hunks in the same file, same PR).
- Why this matters: EPIC.md is the project's single source of truth for what's shipped; a reader
  scanning E3 today would conclude none of the web UI exists, when in fact three of five stories are
  built, tested (18 passing tests) and manually verified in this review to render and create sessions
  correctly. This isn't dishonesty in the "overclaiming" direction like finding #1, but it undersells
  real, working progress and will cause someone to re-plan/re-scope work that's already done.
- Fix: annotate E3.1/E3.2/E3.4 as "(done, `docs/reports/web-ui.md`)" the same way the rest of this PR's
  stories are annotated, and note E3.3/E3.5/E3.6 (dashboard) as the remaining open E3 work.

### 3. MINOR — Session page silently shows "stopped, no entries" when the agentd↔API link never connects, no visible error to the user

Exercised via the browser (see below): after `POST /api/sessions` with the in-process provider, the
API log shows agentd repeatedly getting `"link closed"` (code 1006) against `/agent/ws`, and the
session page settles on `stopped` with `No entries yet.` — no error entry, toast, or explanation is
ever surfaced to the operator watching the page. (`link.ts` isn't part of this PR's diff, and the
sandbox here has no `pi` binary installed, so I can't rule out that this specific failure is a local
environment gap rather than a defect in the shipped code — flagging it as an observed UX gap, not a
confirmed regression.)
- Confidence: MEDIUM (root cause not confirmed to be in this PR's diff).
- Why this matters: an operator watching the fleet UI has no way to tell "the run never actually
  started" apart from "the run finished with nothing to say" — both render identically.
- Fix: worth a follow-up to confirm whether a `run.spec` / link-establishment failure should push a
  `custom`/error entry onto the session stream so the UI can distinguish "never connected" from "ran
  and produced nothing."

## What worked

- `npm ci`, `npm run build --workspace=@outfitter/web`, and `npm test` all pass clean across
  `@outfitter/agentd` (140/140), `@outfitter/api` (124/124), `@outfitter/web` (18/18), and `mgm`
  (229/229) at HEAD.
- `GET /api/providers` degrades gracefully with no credentials configured — every row comes back
  `status: "unknown"` with a human `detail` ("not configured", "SANDBOX_PROVIDER is not cloudrun"),
  never a 500 or a thrown error. Matches the task's expectation exactly.
- Fleet list, new-session dialog (guru dropdown populated from `GET /api/gurus`, form fields, submit),
  and session-page navigation all work correctly in a real browser against the memory-mode API —
  verified via screenshots and network trace (`POST /api/sessions` → 201, immediate SSE `GET .../
  stream` → 200, fleet table updates).
- SPA fallback (`packages/api/src/routes/static.ts:22-28`) correctly serves `index.html` for
  client-side routes like `/sessions/<id>` and `/providers` (200, not 404), and correctly still 404s
  `/api/*`/`/agent/*` paths that don't match a real route.
- `GET /api/gurus`, `POST /api/gurus` (with the env-var denylist), and session creation all behaved as
  documented.
- The `OUTFITTER_TOKEN`/dev-mode description in `mgm/README.md` and `auth.ts` is accurate: dev mode
  really does accept any bearer and identify the caller as `dev@localhost`, with no server-side
  personal-token verification — this part of the docs is not overstated.
