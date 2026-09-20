# Maintainability review — PR #1 (branch `claude/pi-agent-teleport-84d05f`)

Scope: `git diff origin/main...HEAD`, ~13k new lines across `outfitter/packages/{agentd,api,provider-local}`,
`outfitter/deploy`, `outfitter/image`, `mgm/.pi/extensions/teleport`. Question asked: is this code
correctly simple and easy to maintain? Findings below are ranked by maintenance cost, most valuable
first. Read-only review; nothing here was edited. `agentlink.ts`, `secrets.ts`, `server.ts` (api) and
`link.ts` (agentd) and `deploy/*.sh` are being actively edited by another agent for known findings —
I skimmed them for context but did not duplicate that work; only new observations on those files are
included below, clearly marked.

## Overall impression

This is unusually well-documented code for a one-day, multi-agent PR. Nearly every non-trivial
function has a "why", not a "what", comment (`git.ts`'s auth-header rationale, `link.ts`'s backoff/
stability-timer reasoning, `run.ts`'s checkpoint-race handling). Vocabulary is consistent — no
"Guru"/"Expert" leftovers, no stray "session" vs "run" vs "execution" confusion once you read the
comments (each is a distinct, correctly-scoped concept: `Run` is Outfitter's own state machine,
"execution" is literally what the Cloud Run Jobs API calls it, and the three checkpoint fields —
`branch/head`, `snapshotUrl`, `workspaceUrl` — are three different payloads for three different
run shapes, cross-referenced back to `protocol.md` everywhere they appear). `EPIC.md` itself has
already been updated with real measurements from the first cloud run (E2.9), and `docs/reports/*.md`
capture real deploy incidents with root cause and fix, so "EPIC vs reality" is in better shape than
most week-one epics. The main cost centers are duplication across package boundaries (some
acknowledged in comments as deliberate debt, some not), two near-duplicate deploy scripts, and a gap
between the "e2e" language used in commit-report prose and what the test suites actually cover.

## Findings

### [HIGH] `deploy/api.sh` and `deploy/link.sh` are ~85% identical, unfactored

**Files:** `outfitter/deploy/api.sh` (132 lines), `outfitter/deploy/link.sh` (100 lines)

Both scripts: source `env.sh`, read `TUNNEL_DOMAIN_LMSTUDIO` from `~/localllm/.env` with the same
9-line fallback block, define an identical `existing_secrets()` function (17 lines, byte-for-byte
same body) and call it with the same four-secret list, build the same image with the same
`cloudbuild-api.yaml`, and run the same "bootstrap deploy to learn the service URL, then deploy the
real revision" two-step dance — differing only in `SERVICE` name, the IAP/`--allow-unauthenticated`
flag, and a couple of env vars set at the end (`OUTFITTER_ROLE=web` vs `link`, `IAP_AUDIENCE` present
or not). `link.sh`'s own comment even says so: "Only mount secrets that exist... [comment] kept
identical to api.sh's set to avoid two different secret lists to maintain" — the intent to avoid
drift is there, but the mechanism (copy-paste) is exactly what causes drift over time (e.g. if a
fifth secret is added, someone has to remember to edit both files identically).

**Cost:** any future secret, image-build flag, or bootstrap-deploy change has to be made twice by
hand; the two already drifted once (api.sh grants the two IAM bindings at the end for IAP, link.sh
doesn't — correct today, but nothing enforces that the *rest* of the script stays in lockstep as it's
edited).

**Simpler form:** extract a `deploy/_deploy-service.sh` (or a function sourced from `env.sh`) taking
`SERVICE`, `OUTFITTER_ROLE`, and an `AUTH_FLAGS` array (`--no-allow-unauthenticated --iap` vs
`--allow-unauthenticated`) as parameters; `api.sh` and `link.sh` shrink to ~15 lines each (their own
role-specific env vars and, for `api.sh` only, the IAM-binding steps) plus one call into the shared
script. `existing_secrets()` and the tunnel-domain fallback move there too.

### [MEDIUM] Four `SandboxProvider` implementations, two incompatible interfaces, one silently wrong alias

**Files:** `outfitter/packages/api/src/providers/types.ts:1-26`, `.../inprocess.ts`, `.../cloudrun.ts`;
`outfitter/packages/provider-local/src/types.ts:1-27`, `.../in-process.ts`, `.../local-docker.ts`

`api/src/providers/types.ts`'s own doc comment already flags this as known debt ("This shape is
intentionally the same one... provider-local uses... copied here rather than imported... unify the
two once both are stable"), so this isn't a new discovery — but by the time of this PR it's grown to
**four** separate provider implementations, not two:

- `api/src/providers/inprocess.ts` — spawns `node <AGENTD_MAIN>` as a child process.
- `provider-local/src/in-process.ts` — spawns the same thing, slightly more configurable (piBin,
  workspace, piCodingAgentDir), different handle scheme (`inproc-N` string vs raw pid).
- `provider-local/src/local-docker.ts` — the actual E1.3 "local provider" from EPIC.md, runs
  `docker run`.
- `api/src/providers/cloudrun.ts` — the real production provider.

`api/src/providers/index.ts:12-19`'s `createProvider()` maps **both** `SANDBOX_PROVIDER=inprocess`
*and* `SANDBOX_PROVIDER=docker` to `api`'s own `InProcessProvider` — i.e. asking for the docker
provider by name silently gets you no Docker at all; the actual `LocalDockerProvider` in
`provider-local` is never wired up from the api package. The comment explains why ("inprocess covers
local dev for this package until the two are unified") but the config value `"docker"` doing
something other than what it says is a footgun for the next person who sets `SANDBOX_PROVIDER=docker`
expecting a container.

**Cost:** two interfaces to keep mentally in sync (`RunStartInput`/`ProviderStatus`/`handle: unknown`
vs `RunLaunch`/`SandboxStatus`/`handle: SandboxHandle`), two near-identical child-process spawners to
fix bugs in twice, and one config value that lies about what it does.

**Simpler form:** either (a) have `api/src/providers/index.ts` import `provider-local`'s real
`LocalDockerProvider` for `SANDBOX_PROVIDER=docker` (small adapter to bridge the two interfaces is
cheaper than a fourth reimplementation), or (b) rename api's `"docker"` provider value to `"inprocess"`
only and drop the alias, forcing anyone who wants real docker isolation to go through
`provider-local`. Either is a smaller change than the "unify once both are stable" promised in the
comment, and removes the silent footgun now rather than later.

### [MEDIUM] "e2e" is asserted in prose but not backed by an e2e test file

**Files:** `outfitter/docs/reports/agentd.md`, `.../api.md`, `outfitter/EPIC.md:161-163` ("Done when
the local Docker provider runs a full turn end to end against a local API"), `outfitter/EPIC.md:219`
(wake-latency script)

Grep for `e2e`/`end-to-end`/`end to end` across `packages/*/test` turns up nothing; the only hits are
in source comments (`providers/inprocess.ts`, `provider-local/in-process.ts`) and in the narrative
report files. Every test file found (`agentd/test/*.ts`, `api/test/*.ts`,
`provider-local/test/in-process.test.ts`, `mgm/tests/teleport.test.ts`) is a unit test against an
injected fake (`fake-pi.ts`, `NoopProvider`, `MemoryStore`, stubbed `exec`) — which is exactly right
for testing state-machine logic in isolation, but it means the E1.2 "done when" criterion ("the local
Docker provider runs a full turn end to end against a local API") has no test artifact backing it; the
claim lives only in a markdown report, which can silently go stale the next time `run.ts` or `link.ts`
changes.

**Cost:** a real end-to-end regression (e.g. the agentd↔api wire format drifting, or the Docker image
failing to start `pi --mode rpc`) would only be caught by someone manually re-running the smoke test
described in the reports, not by `npm test`.

**Simpler form:** either add one thin integration test (spin up `MemoryStore` + real Fastify app +
`InProcessProvider` + a *real* `pi --mode rpc --version`-style stub binary, drive one prompt through
`POST /api/sessions` to a `bye`) so "full turn end to end" is a `npm test` assertion, not a claim; or,
if that's judged not worth the CI cost yet, soften EPIC.md's "done when" wording to say what was
actually verified (a manual run, dated) rather than "end to end" which reads as a durable guarantee.

### [MEDIUM] `ExecFn`/git-shell-out helpers duplicated between `agentd/git.ts` and `teleport/lib.ts`

**Files:** `outfitter/packages/agentd/src/git.ts:18-44`, `mgm/.pi/extensions/teleport/lib.ts:9-64`

Both files define, nearly verbatim: an `ExecResult` type, an `ExecFn` type with the identical
`(cmd, args, cwd) => Promise<ExecResult>` signature, and a `defaultExec` implementation that wraps
`execFile`/`promisify` with the same try/catch-and-normalize-to-`{stdout,stderr,code}` shape (compare
`git.ts:33-44` to `lib.ts:57-64` — they differ only in variable formatting). `git.ts`'s own comment
acknowledges this ("Matches the shape used elsewhere in mgm (teleport's ExecFn)"), so it's a conscious
choice, not an oversight — the stated reason is that `agentd` can't have a build-order dependency on
`mgm`'s extension code. That's a real constraint, but the *duplicated logic* (not just the type) is
the part worth reconsidering: the 12-line `defaultExec` body is pure boilerplate that could live in a
zero-dependency shared file (e.g. `packages/shared/exec.ts`) both `agentd` and `mgm` depend on without
either depending on the other's domain code.

**Cost:** low today (12 lines, stable, unlikely to need a bugfix) — this is really a MEDIUM-not-HIGH
finding because the duplication is small, self-contained, and already explained in a comment. Flagging
it mainly because the review was asked to look for exactly this pattern, and because it's the kind of
"small acceptable duplication" that tends to accrete a second and third copy (the diff already shows
signs of that — see the provider duplication above) unless someone draws the line once.

**Simpler form:** a `packages/exec-shim` (or similar) package exporting just `ExecFn`/`ExecResult`/
`defaultExec`, with no other dependencies, importable by both `agentd` and `mgm/.pi/extensions`
without creating the build-order coupling the comment worries about.

### [LOW] `api/src/config.ts` is large but not actually sprawling — mostly-earned complexity

**File:** `outfitter/packages/api/src/config.ts` (107 lines, 17 fields)

Worth calling out explicitly since the review brief flagged "config sprawl" as a risk: on inspection
this isn't sprawl in the usual sense (no dead flags, no overlapping toggles). Every field has a
one-line doc comment explaining what reads it and why it exists (`provisioningGraceMs` points at the
Cloud Run cold-start problem it solves, `downQueuePollMs` points at the two-Cloud-Run-services split
in `agentlink.ts`), and `loadConfig()` is a single pure function with small helpers (`envInt`,
`envList`) rather than scattered `process.env` reads throughout the codebase — that's the right shape
for this many knobs. The one thing worth tightening: `OutfitterRole` ("web"/"link"/"all") is
re-derived by string comparison in `envRole()` here and is then checked again ad hoc wherever routes
are registered (`server.ts`) — a single source of truth for "which route groups does each role
register" (e.g. a small table keyed by role) would make it impossible for a future new route to be
added to `server.ts` without a reviewer noticing which role(s) it should belong to. Not urgent; noted
for when route count grows.

### [LOW] `providers/index.ts` doesn't type-check `SANDBOX_PROVIDER` at config-load time

**File:** `outfitter/packages/api/src/config.ts:93`, `outfitter/packages/api/src/providers/index.ts:29-30`

`sandboxProvider: (env.SANDBOX_PROVIDER as SandboxProviderName) ?? "inprocess"` casts an arbitrary
env string to the union type without validation; an unrecognized value (typo, e.g. `SANDBOX_PROIVDER`
vs `SANDBOX_PROVIDER`, or `"Cloudrun"` with wrong casing swallowed by a shell script) passes config
loading silently and only fails later, inside `createProvider()`, with a generic `unknown
SANDBOX_PROVIDER` error thrown at first-run-start time rather than at boot. For a service meant to
scale to zero and cold-start on demand, that error surfaces on whichever request happens to be the
first to call `runs.wake()` after a bad deploy, not on Cloud Run's own health check. Cheap fix:
validate the three literal values in `loadConfig()` itself (or call `createProvider()` once at boot
to fail fast) rather than only at first use.

## Positive observations

- **Comments explain "why", not "what", almost everywhere.** `run.ts`'s `stateAfterCheckpoint` field
  and `link.ts`'s stable/backoff timers are genuinely tricky state-machine races, and the comments
  walk through the failure mode they prevent rather than restating the code.
- **`docs/reports/deploy-gaps.md` and friends are real incident postmortems**, not padding — each one
  names the observed bug, root cause, fix, and which tests now cover it (e.g. the `link.ts` reconnect
  storm from the first live Cloud Run execution). This is exactly the kind of documentation that
  prevents regressions from unwitnessed production incidents.
- **The two-Cloud-Run-services split (`OUTFITTER_ROLE=web`/`link`/`all`)** is a real architectural
  constraint (IAP is service-wide) explained once in `protocol.md` "Two origins" and then referenced
  by pointer from every place it matters (`config.ts`, `deploy/*.sh`, `server.ts`) rather than
  re-explained each time — good discipline for a distributed concern like this.
- **Secrets never touch the image or a job's static env**: the Dockerfile's own comment states this
  invariant, and `run.ts`/`git.ts` corroborate it (tokens travel only over the authenticated
  WebSocket, and `git.ts` goes out of its way to avoid ever writing a token into `.git/config`). This
  is the kind of security-relevant design decision that's easy to erode by accident in later PRs if
  it isn't stated as clearly as it is here.
- **`MemoryStore`/`MongoStore` are kept behaviorally identical on purpose** (same `Store` interface,
  same routes exercised against either), which is what makes `MONGODB_URI=memory` a viable fast test
  mode instead of a second, drifting mock.

## Recommendation

No single finding here blocks shipping — this is unusually well-explained code for its age. The one
item worth doing before the next deploy script change is collapsing `api.sh`/`link.sh` into a shared
script (HIGH), since that duplication will otherwise cost a real incident the next time someone edits
one and forgets the other. The provider duplication (MEDIUM) and the `SANDBOX_PROVIDER=docker` alias
are worth a follow-up story rather than a blocking fix, since they're already flagged as intentional
debt in-repo. The e2e-coverage gap (MEDIUM) is worth closing before the "done when" criteria in
EPIC.md are treated as verified going forward.

## Applied

All five findings/follow-ups from this review were addressed:

- **[HIGH] deploy scripts collapsed**: `deploy/service.sh <web|link>` now holds the build, the
  bootstrap-deploy-to-learn-the-URL dance, `existing_secrets()` (unchanged, still in `env.sh`), and
  the role-specific branches (auth flags, `IAP_AUDIENCE`, the two IAM bindings, `web` only).
  `deploy/api.sh` and `deploy/link.sh` are now two-line wrappers (`exec service.sh web` /
  `exec service.sh link`), so every documented command in `deploy/README.md` still works unchanged.
  `deploy/README.md` documents `service.sh` directly.
- **[MEDIUM] providers unified**: `packages/api/src/providers/types.ts` and `inprocess.ts` are
  deleted. `packages/api` now depends on `@outfitter/provider-local` (workspace dependency) for its
  `SandboxProvider`/`RunLaunch`/`SandboxHandle`/`SandboxStatus` types and for the `inprocess` and
  `docker` provider implementations (`InProcessProvider`, `LocalDockerProvider`); `cloudrun.ts` was
  adapted to provider-local's (smaller) shape instead of the other way round — its `SandboxHandle` is
  now the plain Cloud Run execution name string, and `status()` returns
  `"starting"|"running"|"exited"|"unknown"` instead of a `{state, detail}` object.
  `SANDBOX_PROVIDER=docker` now actually constructs `LocalDockerProvider` (the silent
  `docker`→in-process alias is gone); `inprocess` and `cloudrun` are unaffected in behavior.
  `Run.providerHandle` is now typed `string` to match. `NoopProvider` (tests) kept, updated to the
  same shape. Found and fixed a real bug while wiring this up: `provider-local/package.json`'s
  `main`/`types` pointed at `dist/index.js` but `tsc`'s `rootDir: "."` actually emits to
  `dist/src/index.js` — the package was never actually importable by anything outside its own tests
  until this fix. `packages/api/test/runs.test.ts` and `routes.test.ts` updated for the new shapes;
  `packages/api/test/config.test.ts` (new) and `packages/agentd`/`packages/provider-local` suites
  unaffected. Root `package.json` gained a `pretest` (`npm run build`) so `npm test` always builds
  every workspace — including `provider-local`, now a real runtime dependency of `api` — before any
  workspace's tests run; per-workspace `npm test` still works for provider-local/agentd (both build
  themselves via their own `pretest`), but `packages/api`'s tests assume `provider-local` is already
  built if run standalone without the root script.
- **[LOW] `SANDBOX_PROVIDER`/`OUTFITTER_ROLE` validated in `loadConfig`**: both are now checked
  against their literal value sets at config-load time (a shared `envEnum` helper), throwing a clear
  `invalid <VAR>: "<value>" (expected one of ...)` error at boot instead of the union-type cast
  silently accepting a typo and failing later at first run-start. `packages/api/test/config.test.ts`
  covers both the defaults and the failure case.
- **[MEDIUM] e2e test added**: `packages/api/test/e2e.test.ts` builds a real Fastify app
  (`buildApp`, `MemoryStore`, dev mode, role `all`) on a real listening port and drives a *real
  built* `packages/agentd/dist/src/main.js` (spawned as an actual child process by
  `@outfitter/provider-local`'s `InProcessProvider`) through a full turn over the real WebSocket
  link, with `PI_BIN` pointed at `packages/agentd/test/fake-pi.js` standing in for pi. Creates a
  repo-less session via `POST /api/sessions` with prompt `"ping"`, waits for the run to reach idle
  with an assistant `"pong"` entry landed in the store via the real link, then `POST .../stop` and
  asserts the run reaches `stopped` and the real agentd child process exits `0`. Bounded at 30s.
  Skips (with a clear message, not a failure) if `packages/agentd`'s `dist/` isn't built yet, or if
  `@earendil-works/pi-coding-agent` (deliberately not an agentd dependency — see `session.ts`'s
  module doc — only baked into the real sandbox image) isn't resolvable from a sibling `mgm/`
  checkout's `node_modules` either. `packages/agentd/test/fake-pi.ts` gained a `--version` fast-path
  (agentd's own startup probe was hanging it for its full 5s timeout) and a doc-comment explaining
  its dual use (spawned via `node` in `run.test.ts`, spawned directly as `$PI_BIN` here);
  `packages/agentd`'s `postbuild` now `chmod +x`s the compiled `dist/test/fake-pi.js` so it's
  directly executable as `$PI_BIN`, the same way a real `pi` binary would be. Root `package.json`'s
  new `pretest` (above) wires this into `npm test` from `outfitter/` by building `agentd` first.
- **git.ts / teleport lib.ts duplication**: a one-line pointer comment was added at `ExecFn`'s
  definition in `packages/agentd/src/git.ts` stating the mgm/outfitter build-order constraint
  explicitly (this file was independently touched by a concurrent security-review pass in the same
  session, which preserved and folded in the same note while reworking the auth mechanism from a
  `-c http.extraheader` argv flag to `GIT_CONFIG_*` env vars).

**Deliberately skipped / left for follow-up:**

- `packages/api/test/agentlink.test.ts`'s `"a checkpoint frame with only workspaceUrl stores just
  that field"` test fails on this tree (`file:///tmp/...` no longer round-trips through
  `agentlink.ts`'s checkpoint handling) — this is unrelated to any of the five items above; it's an
  in-flight change from a concurrent security-hardening pass on `agentlink.ts` in this same session
  (SSRF validation on `snapshotUrl`/`workspaceUrl`, per `docs/reports/security-review-pr1.md`
  finding #3) that hadn't updated its own test fixture yet at the time this report was written. Not
  fixed here to avoid colliding with that agent's in-progress edit to the same file.
- The `api/src/config.ts` "route registration by role" table suggestion (LOW, "mostly-earned
  complexity" finding) was left as-is: it's a "when route count grows" suggestion, not a bug, and
  `server.ts`/`routes/index.ts`'s current `if (ctx.config.role !== ...)` checks are still only two
  call sites.
- No changes to `packages/provider-local/src/local-docker.ts` or `in-process.ts` themselves beyond
  fixing the package's own `main`/`types` paths — provider-local's shape won by design (task
  instruction), so it needed no changes to accommodate the unification.
