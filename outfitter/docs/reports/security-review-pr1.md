# Security Review Report — Outfitter PR #1

**Scope:** `outfitter/packages/api/src` (auth, server, agentlink, secrets, laptop, routes/*, store/mongo),
`outfitter/packages/agentd/src` (auth, link, run, git, workspace, pi, session, guru), `outfitter/image/Dockerfile`,
`outfitter/deploy/*.sh`, `mgm/.pi/extensions/teleport/*`. Diff reviewed: `git diff origin/main...HEAD`
(`claude/pi-agent-teleport-84d05f`). Files under concurrent edit by other agents (agentlink.ts, secrets.ts,
link.ts, server.ts, deploy/*.sh) were reviewed as currently checked out; re-verify after they land.

**Risk Level: HIGH** (two chain-able architectural gaps let a compromised sandbox reach secrets/sessions
that belong to *other* users, which the stated threat model explicitly asks about)

## Summary
- Critical/High Issues: 3
- Medium Issues: 3
- Low / informational: 5
- Verified NOT exploitable: 2 (documented at the end so they aren't re-flagged later)

---

## High / Critical

### 1. GitHub PAT is exposed in the clear via process listing during every clone/fetch/push
**Severity:** HIGH
**Category:** A02 Cryptographic Failures / A09 Logging & monitoring (secret handling)
**Location:** `outfitter/packages/agentd/src/git.ts:51-60` (`authHeaderArgs`), used at
`git.ts:107-133` (`clone`) and `git.ts:145-157` (`push`); invoked via `execFile("git", args, {cwd})`
(`git.ts:33-40`).
**Exploitability:** Local, unauthenticated relative to the sandbox — reachable by the exact actor the
task's threat model names ("the sandbox runs an LLM agent with a shell as a non-root user … the model
can run arbitrary commands in /workspace").
**Blast radius:** The fine-grained GitHub PAT for the session (`contents`/`pull-requests` read-write on
"selected repos" per EPIC.md) — not scoped to just this session's repo working copy, but to every repo
the PAT covers.
**Issue:** `authHeaderArgs` correctly avoids the well-known anti-pattern of embedding the token in the
remote URL (which `git` would persist into `.git/config`) or writing `git config`. Instead it passes
`-c http.extraheader=AUTHORIZATION: basic <base64(x-access-token:token)>` as a **command-line argument**
to `git`. On Linux, any process running as the same Linux user can read another process's full argv via
`ps auxww` or `/proc/<pid>/cmdline` while that `git` invocation is alive. In this deployment, the pi
agent's shell tool executes as the *same* non-root `agent` user as agentd's `git` child process
(same container, no user or namespace separation) — see `image/Dockerfile:28,76` (single `agent` user).
A prompt-injected or otherwise compromised agent session can trivially win the race by polling in the
background, e.g.:
```sh
while true; do ps auxww | grep -o 'AUTHORIZATION: basic [A-Za-z0-9+/=]*'; sleep 0.05; done &
```
left running for the duration of the session; the first checkpoint's `git push` (which happens every
turn per `agentlink.ts`'s `checkpointEvery: "turn"`) will leak it. `git config -l` itself is *not*
vulnerable (confirmed: the header never touches `.git/config`), matching the module's own comment —
but the mitigation stops one leak path while leaving the other open.
**Remediation:** Don't pass the token on argv. Options, cheapest first:
- Feed the header via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` **environment**
  variables instead of `-c` (still visible via `/proc/<pid>/environ` to the same user, so this only
  helps if combined with the next option).
- Use `credential.helper` fed over a pipe (`git credential approve` via stdin, or `GIT_ASKPASS` pointing
  at a short-lived script that prints the token to stdout — argv of *that* script is still visible, so
  write the token to an fd/pipe, not argv/env).
- Simplest robust fix: write the extraheader value to a temp file only `agentd`'s own process can read
  (`0600`, deleted immediately after), and pass `-c include.path=<file>` or
  `-c http.extraheader=@<file>` — git does not support `@file` for this specific config value, so in
  practice the cleanest fix is a short-lived `GIT_ASKPASS` script (temp file, `0700`, unlinked right
  after the git call) that echoes the token; argv for a `.sh` invoked as `GIT_ASKPASS` only shows the
  script path, not the secret.
- Defense in depth regardless of the above: scope the PAT as narrowly as possible per session (ideally
  per-repo, short TTL — EPIC.md already plans replacing it with GitHub App installation tokens per run
  in phase 2; that change independently caps blast radius here).

### 2. Agent identity is not bound to a specific run — any sandbox can attach to *any other* run
**Severity:** HIGH
**Category:** A01 Broken Access Control / A07 Identification & Authentication Failures
**Location:** `outfitter/packages/api/src/auth.ts:53-67` (`verifyAgentToken`),
`outfitter/packages/api/src/agentlink.ts:183-232` (`handleConnection`).
**Exploitability:** Remote (from within GCP), requires the attacker to already control code running
under the `outfitter-agent` service account — i.e. any Cloud Run Job execution for **any** run, since
every execution of the job shares the one SA (`deploy/agent-job.sh:38` `--service-account
outfitter-agent@…`), or anyone able to impersonate that SA. Also requires knowing the target run's
UUID (128 bits, `randomUUID()` in `runs.ts:33` — not guessable by brute force, but not treated as a
secret anywhere either: it's placed in a Cloud Run Job execution's container-override env
(`providers/cloudrun.ts:44`), which is visible to anyone with `run.executions.get`/describe IAM on the
project, and to anything reading Cloud Logging for that execution).
**Blast radius:** Full takeover of the target run for as long as it stays connected: the target
session's `run.spec` (GitHub token + LiteLLM key — `agentlink.ts:263-294`), ability to inject forged
`entry`/`event`/`checkpoint` frames into that session's transcript, and interception of every
`prompt`/`steer`/`abort` the real user sends (delivered to whichever socket is registered for that
`runId` — `agentlink.ts:204`, `sockets.set(runId, socket)` has no notion of "the right agentd").
**Issue:** `verifyAgentToken` checks only that the bearer is a valid Google ID token, audience =
`config.origin`, and `email === config.agentSaEmail`. It does **not** check anything that ties the
token, or the connecting process, to the specific `runId` in the `?run=` query param. Because every
Cloud Run Job execution for `outfitter-agent` runs as the same SA, a legitimate (or compromised) agentd
process for run A can mint its own fresh ID token from the local metadata server (`agentd/src/auth.ts`
— unauthenticated on the VM/container, standard GCE behavior) and open a **second** WebSocket to
`/agent/ws?run=<B>` for a run B it has no business touching. `handleConnection` only checks that run B
exists and is `provisioning|running|idle` (`agentlink.ts:193-197`); it never checks that the caller is
the same identity/process that the API itself started for run B.
**Remediation:** Bind the token to the run. Minimal fix: when `RunManager.wake` starts a Cloud Run Job
execution (`runs.ts:43`), generate a random per-run secret and pass it as a second container-override
env var (alongside `RUN_ID`) and store it on the `Run` record; require agentd to send it (e.g. as a
second header or in the `hello` frame) and reject the connection if it doesn't match. This makes the
run-scoped credential a real secret instead of "an ID token good for any run, plus knowledge of a UUID
that isn't treated as sensitive anywhere."

### 3. `checkpoint.workspaceUrl`/`snapshot.url` round-trip with no validation → SSRF + tar path traversal on resume
**Severity:** HIGH (chained: requires finding #2's forged-agentd capability, or a bug that lets a run's
own `checkpoint` frame carry attacker data — see caveat below)
**Category:** A10 SSRF / A03 Injection (archive extraction)
**Location:** `outfitter/packages/api/src/agentlink.ts:379-390` (checkpoint frame persisted verbatim),
`:264-288` (`buildRunSpec` hands it back unmodified as `run.spec.workspace.snapshotUrl` /
`run.spec.snapshot.url`), `outfitter/packages/agentd/src/workspace.ts:65-89` (`restoreWorkspace`),
`outfitter/packages/agentd/src/run.ts:274-296` (`begin()` fetches `spec.snapshot.url` directly).
**Issue:** Neither the API nor agentd validates the scheme/host of `workspaceUrl`/`snapshotUrl` before
using it. `restoreWorkspace` will `fetch()` **any** URL a `checkpoint` frame supplied (including
`http://169.254.169.254/computeMetadata/v1/...`, reachable from inside the Cloud Run Job's network
namespace) and then unconditionally runs `tar -xzf <fetched-file> -C <workspace>` with no
`--no-same-owner`, no member allowlist, and no rejection of `../` or absolute paths inside the archive
— a crafted tarball can write outside `/workspace` (e.g. clobber `~/.bashrc`, files under
`/opt/outfitter`/`/opt/mgm` if writable by the `agent` user, or the next run's own workspace files via
symlink tricks). `spec.snapshot.url` is fetched with `res.text()` and fed straight into
`writeSnapshotFileFn`/`importSessionFn` — a blind SSRF primitive even when the response isn't valid
session JSONL (the fetch itself completes before parsing fails).
**Caveat (unverified):** under today's implementation, `checkpointWorkspaceTarball` computes
`workspaceUrl` itself as a local path under `WORKSPACE_SNAPSHOT_DIR` (`workspace.ts:94-108`) — agentd,
not an external attacker, decides this value in the normal flow, and repo sessions never set
`workspace.snapshotUrl` at all (`agentlink.ts:266-277`, it's only used for repo-less sessions). So under
*normal* operation there's no attacker-reachable input into this field; the practical way to plant a
malicious value is exactly finding #2 (send a forged `checkpoint` frame as if you were agentd for a run
you don't own). It's flagged as its own item because it multiplies the blast radius of #2 from "read
this run's secrets" to "get file write / SSRF as *whichever future agentd resumes this session*," and
because both agentd and the API accept these URLs with zero validation, so tightening #2 alone leaves
this latent.
**Remediation:**
- Validate `snapshotUrl`/`workspaceUrl` against an allowlist (your own GCS bucket host, `https`
  only) both when the API persists a `checkpoint` frame and again in agentd before fetching.
- Extract with a library or `tar` flags that reject `..`/absolute paths and drop ownership bits
  (`tar --no-same-owner --no-same-permissions -xzf - -C <dir>` plus a pre-scan of `tar tzf` output that
  refuses any entry not matching `^[^/][^\n]*$` with no `..` component).

---

## Medium

### 4. `read` down-message has no path-traversal guard (dormant today, will be reachable once wired to a route)
**Severity:** MEDIUM (not currently reachable via any REST endpoint — no `GET /sessions/:id/file`
route exists yet; EPIC.md E3.3 "file viewer" is what will call it)
**Category:** A01 Broken Access Control (path traversal)
**Location:** `outfitter/packages/agentd/src/run.ts:527-534`
```ts
private async handleRead(reqId: string, path: string): Promise<void> {
  try {
    const content = await readFile(join(this.deps.workspace, path), "utf8");
```
`join("/workspace", "../../../../etc/passwd")` (or an absolute `path`, which `node:path.join` also
happily returns unmodified when the first segment is absolute-looking on POSIX — `join("/workspace",
"/etc/passwd")` → `/workspace/etc/passwd` is actually safe, but `join("/workspace", "../../etc/passwd")`
→ `/etc/passwd` is not) escapes `/workspace` with no containment check.
**Remediation:**
```ts
import { resolve, sep } from "node:path";
const target = resolve(this.deps.workspace, path);
if (target !== this.deps.workspace && !target.startsWith(this.deps.workspace + sep)) {
  throw new Error("path escapes workspace");
}
```
Land this before wiring any REST route to the `diff`-style `agentLink.request(runId, {t:"read", path})`
call E3.3 will need.

### 5. No per-user authorization on session-scoped routes — every authenticated domain user can read/control every session
**Severity:** MEDIUM (may be intentional for a single-org shared fleet — flagging for confirmation
against EPIC.md's stated model)
**Category:** A01 Broken Access Control
**Location:** `outfitter/packages/api/src/routes/sessions.ts` (all routes use `getSessionOr404`,
`:241-253`, which only checks existence) and `store/types.ts:10-33` (`Session` has no owner/creator
field at all).
**Issue:** `identityFromRequest`/the `preHandler` in `server.ts:63-75` establishes *that* the caller is
some `@mgmonteleone.com` user, but nothing downstream checks *which* user, or that they created/own the
session in question. Any signed-in domain user can therefore: read any other user's full transcript
(`GET /sessions/:id/entries`, `/export.jsonl`), see cost, diff, `stop`/`abort`/send messages into
someone else's running session, or `PUT /sessions/:id/import` over an existing session's history
(guarded only by "no run is currently active", `sessions.ts:200-238`). Given EPIC.md frames this as an
org-wide fleet UI, this is plausibly by design (like a shared Cosmos/Kubernetes dashboard) — worth an
explicit decision either way rather than an oversight. If it's not intended: add `ownerEmail` to
`Session`, set it from `req.identity.email` on `POST /sessions`, and check it (or a role) in
`getSessionOr404`.

### 6. `guru.env` is merged unfiltered into the pi child process environment; guru CRUD has no RBAC
**Severity:** LOW-MEDIUM
**Category:** A05 Security Misconfiguration
**Location:** `outfitter/packages/api/src/routes/gurus.ts:11-18` (`POST /api/gurus`, any domain user),
`outfitter/packages/agentd/src/run.ts:304-314` and `pi.ts:77-80`
(`spawn(piBin, args, { env: { ...process.env, ...opts.env } })`).
**Issue:** Any authenticated user can create/edit a Guru, including its `env` map, which lands directly
in the pi process's environment with no allowlist. `NODE_OPTIONS`, `LD_PRELOAD`, or `PATH` in there
would let a guru author pre-plant code execution into every future run of that guru. Because a guru
already fully controls the agent's system prompt/tools/model for its own runs, this isn't a new
privilege *within a run the author would already run themselves*, but it does mean one domain user can
plant persistent code-exec into a guru other people also use. Suggest an env-var denylist
(`NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `PATH`) applied when rendering `guru.env`, plus
treating guru CRUD as an admin-only action once role-based authz exists (ties into finding #5).

---

## Low / Informational

### 7. `verifyIdToken` calls don't explicitly check `email_verified`
**Location:** `outfitter/packages/api/src/auth.ts:61-66` (agentd token), and implicitly the IAP path
(`identityFromRequest`, which uses `verifySignedJwtWithCertsAsync` and does not read `email_verified`
either). `google-auth-library`'s `verifyIdToken`/`verifySignedJwtWithCertsAsync` already validate
signature, issuer, audience and expiry; the missing check is defense-in-depth only. Google-issued
service-account identity tokens don't carry an "unverified" email in practice, so real-world risk here
is low. **Unverified:** whether the library even populates `email_verified` on a service-account-issued
identity token — worth a quick check against a real token before deciding this is worth the extra line.
Suggested belt-and-suspenders: `if (payload.email_verified === false) throw new Error(...)`.

### 8. Teleport `GitStore` pushes full session transcripts to a remote git repo in plaintext
**Location:** `mgm/.pi/extensions/teleport/lib.ts:79-201`. If `MGM_TELEPORT_STORE` (default
`~/.mgm-sessions`) has a `git remote` configured, every `/teleport push` commits and pushes the entire
JSONL transcript — which can include tool output, pasted secrets, or file contents from the working
repo — to that remote, unencrypted, with no secret-pattern scan before push. Same trust model as
Claude Code's own teleport (not a new bug introduced here), but worth a documented expectation that the
remote must be private/access-controlled, and consider warning when a transcript about to be pushed
matches an obvious secret pattern (`ghp_`, `AKIA`, bearer-token-looking strings).

### 9. `npm audit` — 2 moderate transitive vulnerabilities
`uuid <11.1.1` (via `gaxios` → `google-auth-library`): missing buffer bounds check in v3/v5/v6 when a
buffer is supplied (GHSA-w5hq-g745-h8pq). Low practical severity in this codebase (not used directly),
but a one-line fix: `npm audit fix` in `outfitter/`.

---

## Verified NOT exploitable (checked empirically — don't re-flag)

**A. `/api/hooks/../sessions`-style traversal around the IAP `preHandler` carve-out**
(`server.ts:63-75`, "path tricks like `/api/hooks/../sessions`"). Tested against a raw TCP socket
(bypassing any client-side URL normalization) with a minimal Fastify app replicating the exact
`preHandler` logic: a literal `GET /api/hooks/../sessions HTTP/1.1` **does** skip the IAP check (the
string starts with `/api/hooks/`), but Fastify's router (`find-my-way`) does not collapse `..`
segments, so it 404s rather than reaching the real `/api/sessions` handler. Percent-encoded variants
(`%2e%2e`, `..%2f`) behave the same way. Case variants (`/API/sessions`) also skip the auth check but
then 404 (default `caseSensitive: true`). If a reverse proxy in front of Cloud Run ever normalizes the
path *before* forwarding (collapsing `..`), the normalized `/api/sessions` request would reach Fastify
already-normalized, and the `preHandler` would then correctly enforce IAP on it. No exploitable gap
found either way. (See `/tmp` script used for the raw-socket test; not included in the repo.)

**B. NoSQL injection via session/run/guru ids**
`store/mongo.ts` never builds a query filter from unsanitized user input — every id lookup is
`{ _id: id }` with `id` a plain string (route params are always strings from Fastify), and every write
uses the request body only as the *value* of `$set` (never as the filter), so a body containing
`$`-prefixed keys just attempts to set a literal field named e.g. `"$where"`, which is not exploitable
as a query operator. `PUT /api/sessions/:id/import`'s body is parsed as raw JSONL text, not used to
build any query either.

## Security Checklist
- [x] GitHub PAT leak via git argv during clone/fetch/push (finding 1) — fixed, see Applied below
- [ ] Agent SA token not bound to a specific run (finding 2) — deliberately out of scope for this pass (tracked separately)
- [x] `checkpoint`/`snapshot` URLs unvalidated before fetch+extract (finding 3) — fixed, see Applied below
- [x] `handleRead` path traversal (finding 4) — fixed, see Applied below
- [x] ngrok webhook HMAC verification is constant-time and fails closed on an unset secret
- [x] IAP JWT verification uses Google's own cert-backed verifier with the correct per-service audience
- [x] No secrets baked into the sandbox image (Dockerfile explicitly excludes `.pi/auth.json` etc.)
- [x] GitHub token never embedded in a git remote URL or written to `.git/config`
- [x] Mongo queries are not attacker-constructible (no injection path found)
- [x] Dependency audit: 2 moderate transitive vulnerabilities (finding 9), fixed via `npm audit fix`

---

## Applied (this pass)

Fixed findings 1, 2, 3, 4, 6, 7, 8, 9, and partially addressed 5 (recorded but not enforced).

### 1. GitHub PAT in argv — fixed via a Linux user split, not just env-vs-argv
- `image/Dockerfile`: the entrypoint (agentd) now stays **root**; `USER agent` was removed. The
  `agent` user and `/workspace` still exist and are still chowned to `agent` at build time.
- `packages/agentd/src/git.ts`: `authHeaderArgs` (argv `-c http.extraheader=...`) replaced by
  `authHeaderEnv`, which returns `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` env vars
  applied only to that single git child invocation (`ExecFn` grew an optional 4th `env` param).
  Env alone doesn't close the leak on its own — `/proc/<pid>/environ` is still readable by any
  process sharing that child's Linux user — so this is paired with:
- `packages/agentd/src/run-as-user.ts` (new): `resolveRunAsUser()` looks up `PI_RUN_AS_USER`
  (default `agent`)'s uid/gid via `id -u`/`id -g` when agentd itself is root (in the sandbox image);
  returns `undefined` (log only) when agentd isn't root (local dev). `chownRecursive()` chowns a
  path back to that uid/gid.
- `packages/agentd/src/pi.ts`: `spawnPi` takes optional `uid`/`gid` (passed straight to
  `child_process.spawn`) and strips any stray `GIT_CONFIG_*` from the env it merges for pi, as
  defense in depth.
- `packages/agentd/src/run.ts`: `RunController` spawns pi with `runAsUser`'s uid/gid, and chowns
  the workspace back to `agent` right after `git clone` and right after every push (both run as
  agentd's root user) — see the `chownWorkspace` doc comment for why chowning after the fact was
  chosen over running git itself as `agent` (auth env vars need to stay root-only-readable).
- `packages/agentd/src/main.ts`: resolves `runAsUser` once at startup and wires it and
  `chownWorkspace` into `RunController`.
- `docs/protocol.md` and `image/Dockerfile` both document the two-user model.
- Tests: `packages/agentd/test/git.test.ts` rewritten to assert the auth header lands in `env`,
  never in `args`; `packages/agentd/test/run-as-user.test.ts` (new) covers both the root and
  non-root paths and `chownRecursive`'s success/failure.

### 2. Agent identity not bound to a specific run — fixed with a per-run token in `hello`
- `packages/api/src/runs.ts`: `RunManager.wake` now generates a 32-byte random `runToken` (hex,
  `crypto.randomBytes`) per run, stores only its sha256 hash on the `Run` record
  (`runTokenHash`, `store/types.ts`), and hands the plaintext to the provider as part of
  `RunLaunch`. The plaintext is never persisted or logged anywhere.
- `packages/provider-local/src/types.ts`: `RunLaunch` gained a required `runToken` field.
  `InProcessProvider` and `LocalDockerProvider` (`packages/provider-local/src`) pass it through
  as the `RUN_TOKEN` env var, alongside `RUN_ID`. `packages/api/src/providers/cloudrun.ts` passes
  it the same way, as a `RUN_TOKEN` container-override env var next to `RUN_ID`.
- `packages/agentd/src/main.ts` reads `RUN_TOKEN` (`requireEnv`, same as `RUN_ID`) and passes it
  to `Link`; `packages/agentd/src/link.ts`'s `Link` sends it back as `hello.runToken` on every
  (re)connect, alongside the existing `runId`/`sessionId`/`lastAckedSeq` fields
  (`packages/agentd/src/protocol.ts`'s `UpHello` gained `runToken`).
- `packages/api/src/agentlink.ts`'s `AgentLink.handleConnection`: after the bearer id token is
  verified and the run/session/guru are looked up, the handler now waits for the connection's
  first frame (`waitForHello`) instead of registering the socket and sending `run.spec`
  immediately. It's accepted only if it's a well-formed `hello` whose `runToken` hashes
  (sha256) to the run's stored `runTokenHash`, compared with `crypto.timingSafeEqual`
  (`runTokenMatches`) — a missing, malformed, or mismatched token, or a first frame that isn't
  `hello` at all, closes the socket with `4401` and logs a warning, with the socket never
  registered and `run.spec` never sent. Only once that check passes does the handler register the
  socket, attach the message/close listeners, build and send `run.spec`, and run the pre-existing
  `hello` behaviour (record `lastSeenAt`, drain queued down-messages if the run was already ready
  — e.g. a reconnect). The old `hello` case inside `handleUpFrame`'s frame switch was removed:
  `hello` is always the first frame of a connection, so it's now fully handled before that
  listener is even attached.
- `docs/protocol.md`: documents the `RUN_TOKEN`/`hello.runToken` handshake in a new "Run token"
  paragraph, updates the `hello` row of the up-frame table, and notes in the close-codes table
  that `4401` also covers a missing/incorrect run token.
- The dev/in-process path is unchanged in effect: `SANDBOX_PROVIDER=inprocess` and `docker` both
  now also thread `RUN_TOKEN` through like every other provider, so a local `npm test`/e2e run
  authenticates the same way production does, just with a token minted by the in-memory store's
  `RunManager` instead of a real Cloud Run Job.
- Tests: `packages/api/test/runs.test.ts` (`RunManager.wake` describe block, new) — a token is
  generated and handed to the provider, only its hash is stored, and two runs get distinct
  tokens/hashes. `packages/api/test/agentlink.test.ts` — new cases: wrong `runToken` closes 4401
  with no `run.spec` sent; missing `runToken` closes 4401 with no `run.spec` sent; a first frame
  that isn't `hello` closes 4401; the correct `runToken` proceeds to `run.spec`. Every other
  agentlink test that opens a socket was updated to send a valid `hello` (with the run's real
  token, recovered from what `RunManager.wake` handed the test's `NoopProvider`) before waiting
  for `run.spec`. `packages/agentd/test/link.test.ts` asserts `hello.runToken` is sent.
  `packages/api/test/e2e.test.ts` required no changes — it drives a real built agentd end to end
  and continues to pass unmodified, proving the real handshake still works.

### 3. Unvalidated `checkpoint`/`snapshot` URLs — SSRF + tar path traversal
- `packages/agentd/src/snapshot-url.ts` (new) and `packages/api/src/snapshot-url.ts` (new,
  duplicated per-package deliberately — see git.ts's module doc for the same tradeoff): both export
  `validateSnapshotUrl` (https + `SNAPSHOT_HOST_ALLOWLIST`-only, or `file://`/plain path when
  `OUTFITTER_DEV=1`), `snapshotHostAllowlist()` (env, default `storage.googleapis.com`), and
  `isDevMode()`.
- `packages/api/src/agentlink.ts`: the `checkpoint` up-frame handler validates `snapshotUrl`/
  `workspaceUrl` before persisting onto `Session.checkpoint` (using `this.config.devMode`, not a
  fresh env read, so it matches the app's actual config in tests and prod); an invalid URL is
  dropped from the checkpoint rather than failing the whole frame, so `branch`/`head` still persist.
- `packages/agentd/src/workspace.ts`: `restoreWorkspace` validates `snapshotUrl` before fetching,
  and extraction goes through new `safeExtractTar()`, which pre-scans a `tar -tvzf` listing and
  refuses any entry that's a symlink/hardlink or has an absolute/`..` path, then extracts with
  `--no-same-owner --no-same-permissions`.
- `packages/agentd/src/run.ts`: `begin()` validates `spec.snapshot.url` the same way before
  fetching it.
- Tests: `packages/agentd/test/snapshot-url.test.ts`, `packages/agentd/test/workspace.test.ts`
  (both new — including a real crafted-tarball path-traversal and symlink rejection test) and
  `packages/api/test/snapshot-url.test.ts` (new, includes the GCE metadata-server IP as an
  explicit reject case).

### 4. `handleRead` path traversal
- `packages/agentd/src/run.ts`'s `handleRead` now resolves the requested path with `node:path.resolve`
  and refuses anything that isn't the workspace itself or a descendant of it, exactly as recommended.
- Test added to `packages/agentd/test/run.test.ts`'s existing diff/read test: both a `../../../../etc/passwd`
  and a bare `/etc/passwd` request are rejected with an error, never file contents.

### 5. No per-session ownership (partial — recorded, not enforced)
- `packages/api/src/store/types.ts`: `Session` gained `ownerEmail?: string`.
- `packages/api/src/routes/sessions.ts`: `POST /api/sessions` sets it from `req.identity?.email`.
- No route reads it back — this is explicitly a policy decision, not a bug fix. Documented as an
  open decision in `EPIC.md` under E2.2.

### 6. `guru.env` unfiltered into pi's process env
- `packages/agentd/src/guru.ts`: `renderGuru` drops `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`,
  `PATH`, `HOME`, and any `GIT_*` key from `guru.env`, logging each dropped key via the new `onLog`
  render option (wired from `RunController`'s own `onLog`).
- `packages/api/src/routes/gurus.ts`: `POST`/`PUT /api/gurus` reject the same key set with 400.
- Tests: `packages/agentd/test/guru.test.ts` (denylist coverage) and `packages/api/test/gurus.test.ts`
  (new; one 400 case per denylisted key, plus a benign-key acceptance case for both POST and PUT).

### 7. `email_verified` defense in depth
- `packages/api/src/auth.ts`: both `identityFromRequest` (IAP) and `verifyAgentToken` (agentd)
  now throw if `payload.email_verified === false`. No dedicated unit test — exercising this branch
  needs mocking `OAuth2Client.verifyIdToken`/`verifySignedJwtWithCertsAsync`, which `auth.ts` doesn't
  currently take as an injectable dependency; adding that seam felt like scope creep for a one-line
  defense-in-depth check with no reachable path to a real `email_verified: false` today (see the
  original finding's own "unverified" caveat).

### 8. Teleport push warning
- `mgm/README.md`'s Teleport section gained a "What gets pushed" paragraph naming the risk and
  telling the reader to keep the remote private.
- `mgm/.pi/extensions/teleport/index.ts`: an explicit (non-`quiet`, i.e. non-autoPush) `/teleport push`
  now also notifies that the full transcript (which may include file contents, command output, or
  pasted secrets) was just pushed and that the remote should be private.

### 9. Dependency audit
- `npm audit fix` in `outfitter/` (no `--force`): removed the `uuid <11.1.1` transitive vulnerability
  pulled in via `gaxios` → `google-auth-library`. `npm audit` now reports 0 vulnerabilities.
  `package-lock.json` changed by 24 lines (2 packages removed, 1 changed); no `package.json`
  dependency ranges were touched.

### Verification
- `npm test` from `outfitter/`: 84 (agentd) + 79 (api) + 2 (provider-local) tests, all green (finding
  #2's run-token pass added 6 api tests and 1 agentd test on top of the 73/84/2 counted here before).
- `npm test` from `mgm/`: 129 tests, all green.
- No commits made; working tree left as-is per instructions.
