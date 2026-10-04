# Outfitter deploy

`gcloud` scripts for the GCP side of the control plane (EPIC.md E0.2, E2.7). Every script is
idempotent and **none of them run on their own** — review, then run by hand in this order.

**`env.sh`.** Every script sources `env.sh` right after `set -euo pipefail`. It pins `PROJECT`
(default `outfitter-509211`), `REGION` (default `us-central1`) and `ACCOUNT` (default
`mgm@mgms.eu`) and exports them as `CLOUDSDK_CORE_PROJECT` / `CLOUDSDK_CORE_ACCOUNT` /
`CLOUDSDK_BILLING_QUOTA_PROJECT`, then refuses to run if `ACCOUNT` isn't logged in to `gcloud` or
`PROJECT` doesn't look like an `outfitter-*` project. This exists because the active `gcloud`
config on this laptop can point at an unrelated work project, and a billing-account-scoped call
(budgets) was once charged against it as quota project — nothing here may depend on the active
`gcloud` config again. Every `gcloud` call in these scripts still also passes an explicit
`--project` (or a positional project id); `env.sh` is a second, independent guard, not a
replacement for that.

**Two Cloud Run services, one image.** IAP on a Cloud Run service is service-wide — it can't let
agentd's WebSocket or the unauthenticated ngrok webhook through while still gating the browser
routes. So `packages/api`'s image is deployed twice, picking its routes via `OUTFITTER_ROLE`
(`src/config.ts`, `src/server.ts`): `outfitter-api` (`OUTFITTER_ROLE=web`, IAP on) for browser
REST/SSE, and `outfitter-link` (`OUTFITTER_ROLE=link`, `--allow-unauthenticated`) for `/agent/ws`
and `/api/hooks/*`, each authenticating its own requests instead of relying on IAP. Both share the
same Atlas store. See `docs/protocol.md` "Two origins".

**`service.sh <web|link>`.** Both deploys share one script — the build, the bootstrap-deploy-to-
learn-the-URL dance, and the secret list are otherwise byte-for-byte identical between the two
roles, so `service.sh` takes the role as its one argument and only branches on it for
`IAP_AUDIENCE`, `OUTFITTER_LINK_ORIGIN` and `OUTFITTER_OPERATORS` (`web` only). `api.sh` and
`link.sh` are two-line wrappers (`./service.sh web` / `./service.sh link`). Who can reach each
service (IAP, its OAuth client and members, the public invoker on `link`) is **`access.sh`**, run by
hand; a routine deploy never changes access.

## Deploying

**Merging to `main` runs CI; pushing a release tag deploys.** Merges from parallel sessions pile up
on `main` without touching production until someone cuts a release:

```bash
cd outfitter/deploy
DRY_RUN=1 ./tag-release.sh    # the tag and its changelog
./tag-release.sh              # tag origin/main as outfitter-vYYYY.MM.DD.N and push it
```

The tag push starts `.github/workflows/outfitter-deploy.yml`, which tests that exact commit
(`npm test` plus the deploy-script checks: CI only runs when `outfitter/` or `kernal/` change, so a
tagged commit may never have been tested alone) and then runs **`release.sh`** on it:

- All three components move to that one commit: the `outfitter-agent` Job first, then
  `outfitter-link`, then `outfitter-api` (a newer link refuses an older agentd; the web deploy reads
  link's URL). A component already at that commit (its `build-commit` label) is skipped, so a run
  that failed halfway is safe to re-run. It smoke-checks each service (link returns 401 without a
  token; web still has IAP switched on and redirects to sign-in) and stops at the first failure.
- The `outfitter-api` image (both link and web run it) builds in the background while the agent
  image builds (`build-api-image.sh`); only the build runs early, the deploy order above is
  unchanged, and a failed API build stops the release before link. gcloud itself is still
  downloaded from Google on every run, not restored from the Actions cache: the deploy job holds
  production credentials, and any job that runs `npm ci` could write that cache.
- Deploys run one at a time (a `concurrency` group, never cancelled midway). A newer run waiting
  its turn replaces an older waiting one, so production only moves forward. That includes a
  waiting manual rollback: if a release is pushed while it waits, re-run it afterwards.
- The tag message is the changelog (`git show outfitter-v2026.09.22.1`), and rolling back is
  redeploying the previous tag (see Rollback). Tags only, never GitHub Releases: this repo's
  Releases are Kernal's (`vX.Y.Z`), and `kernal update` and `install.sh` read `releases/latest`,
  so an Outfitter Release marked "latest" would break every Kernal install.
- Only repository admins can create, move or delete `outfitter-v*` tags (a tag ruleset
  `ci-setup.sh` creates, or it refuses to switch the workflow on). That matters: a tag can point at
  any commit, including a branch commit whose own workflow skips `release.sh`'s main-only check,
  and GCP trusts the workflow only when it runs from an `outfitter-v*` tag -- never from `main` or
  a branch, so a collaborator with write access can't start a deploy of their own code either.
- Non-secret settings live in **`config.env`**, checked in, so every deploy sets the same
  environment. `--set-env-vars` replaces a service's whole environment, so a value that only
  existed in one person's shell used to vanish on the next deploy from anywhere else. Change a
  value there, merge it, and release.
- GitHub gets no stored key: Workload Identity Federation to the `outfitter-deployer` service
  account, trusted only for this workflow file of this repository (pinned by name and numeric id),
  run from an `outfitter-v*` tag. Images build as `outfitter-builder` (push and log
  rights only), never as the default build account, which is project Editor. The deployer can't
  change IAM policy, so it can't add invokers or IAP members. It is not harmless, though: it could
  switch IAP off, or ship code that runs as `outfitter-api` with its secret access, so a stolen
  deployer token is about as powerful as a malicious release. **`ci-setup.sh`** creates all of it
  once (run by hand as a project owner); the workflow stays idle until its two repository
  variables exist.

**Agents and people don't deploy from their own checkouts.** Every image-building script
(`service.sh`, `agent-job.sh`, `release.sh`) refuses to run when its inputs have uncommitted
changes, when `HEAD` isn't on `origin/main`, when `HEAD` is behind `origin/main`, or when
production already runs a commit `HEAD` doesn't contain (which would silently roll someone's
released work back; checked again right before each rollout, since a build can take minutes). A
hand run isn't in the workflow's queue, so `release.sh` also wants `MANUAL=1`, and only when the
workflow is unavailable (or before `ci-setup.sh` has run). `deploy-all.sh`, from the earlier
whole-fleet script, is now just `MANUAL=1 ./release.sh`:

```bash
git checkout main && git pull --ff-only
DRY_RUN=1 ./release.sh    # what would deploy
MANUAL=1 ./release.sh
```

Overrides, for emergencies: `ROLLBACK=1` deploys an older `main` commit on purpose (see Rollback),
`ALLOW_OFF_MAIN=1` skips the checkout checks entirely, `FORCE_ALL=1` redeploys components already
at the commit, `ALLOW_SKEW=1` lets a single-component script deploy against a mixed fleet. The
workflow's **Run workflow** button redeploys a release: choose its `outfitter-v*` tag under "Use
workflow from" (runs from anything else are refused), with `rollback` and `force_all`.

The kernal.one landing page (`kernal-web`) rides along: `release.sh` runs `landing.sh` when
anything under `landing/` changed since the commit that page runs, and smoke-checks that it serves
a 200. It is deliberately *not* part of the three-component one-commit rule (`check_deploy_skew`):
it is static, talks to nothing and carries no protocol version, so it can sit at another commit
safely. Its domain mappings (`./landing.sh --map-domains`) stay a one-time owner step.

`landing.sh` deploys the page as `kernal-web@<project>.iam.gserviceaccount.com`, an account with
no project roles. The default Compute account is project Editor, and `outfitter-api` can read
every secret and roll out Cloud Run, so neither is a fit for a public static site.
`baseline.sh` creates the account; `ci-setup.sh` lets `outfitter-deployer` act as it. A release
that ran before that grant (Actions run `35853815936`, tag `outfitter-v2026.09.23.1`) stopped on
the page and never moved the fleet, because `release.sh` deploys the page first. See
`docs/reports/sandbox-git.md`.

## Order of operations

1. **`./baseline.sh`** — enables the required APIs, creates the `outfitter` Artifact Registry
   repo, the `outfitter-api` and `outfitter-agent` service accounts with their IAM roles, and a
   $25/month budget alert (50/90/100%) on billing account `01DEC0-9358E1-C1FF0D`.
2. **Manual: Atlas** (EPIC.md E0.3, no gcloud script — Atlas is not a GCP resource):
   - Create the `outfitter` Atlas org project, an M0 cluster in GCP `us-central1` (same region as
     Cloud Run, to keep egress local).
   - Create a database user (SCRAM), and store its connection string as the
     `outfitter-mongodb-uri` secret (below) — `mongodb+srv://<user>:<password>@<cluster>/outfitter?retryWrites=true&w=majority`.
   - IP access list: allow Cloud Run's egress (0.0.0.0/0 is the pragmatic start for a Job with no
     static egress IP; tighten with a Serverless VPC Connector + Atlas private endpoint later, see
     EPIC.md E7).
   - Enable Google Workspace SAML for org login (`mgmonteleone.com`).
   - Link GCP Marketplace billing when leaving M0 (deferred per EPIC.md "Decisions taken").
3. **Manual: Secret Manager** — two different mechanisms, easy to conflate because `api.sh`
   deploys secrets under both. Read `src/secrets.ts` before creating anything; it's the source of
   truth for what the running API actually fetches, and it does **not** match `api.sh`'s
   `--set-secrets` list one-for-one.

   **a. Env-injected, mounted on the `outfitter-api` service by `api.sh --set-secrets` — create
   these once, up front:**

   | Secret id | Env var | Actually read by | Notes |
   |---|---|---|---|
   | `outfitter-mongodb-uri` | `MONGODB_URI` | `config.ts` (`loadConfig`) → `store/index.ts` (`openStore`) | required; without it the API falls back to `MemoryStore` |
   | `outfitter-local-tunnel-token` | `LOCAL_TUNNEL_TOKEN` | `config.ts` → `src/laptop.ts`'s `LaptopProbe` | required for the E2.8 laptop preflight to mean anything in prod |
   | `outfitter-github-pat` | `GITHUB_PAT` | **nothing yet** | deployed as a placeholder only — see (b) |
   | `outfitter-litellm-admin` | `LITELLM_ADMIN_KEY` | `config.ts` → `src/providers-status.ts`'s LiteLLM probe (E2.10); device/run key minting and model reconciliation (#389, #384). Written only by `litellm-admin.sh` | calls `/health/liveliness`, `/model/info`, `/key/info`; falls back to `outfitter-litellm-key-default` (b) when unset |
   | `outfitter-litellm-admin-key` | `OUTFITTER_LITELLM_ADMIN_KEY` | `config.ts` → `src/central/litellm-keys.ts` (#394), both roles | optional; a LiteLLM key allowed to manage users, keys and teams (only `/user/*`, `/key/*`, `/team/*`, `/spend/*` if LiteLLM allows). Mints each device's router key at `kernal login` and reads spend. Distinct from `outfitter-litellm-admin`. Unset means no minting: logins carry no router key and runs keep the shared keys. Personal provider keys (#393) are written by the api itself as `outfitter-user-<userId>-<provider>`; nothing to create |
   | `outfitter-ngrok-api-key` | `NGROK_API_KEY` | `config.ts` → `src/providers-status.ts`'s ngrok probe (E2.10) | optional; `GET https://api.ngrok.com/endpoints` reconciler. Unset means the "ngrok" row reports `unknown`/"not configured", not a poll failure |
   | `outfitter-deepgram-key` | `DEEPGRAM_API_KEY` | `config.ts` → `src/voice.ts`'s `VoiceService` (#252), **web role only** | optional; a Deepgram **Member** key with `usage:read`, in the same Deepgram project as kernal's bundle key (`DEEPGRAM_PROJECT_ID` in `config.env`). The bundle key is usage-only and can't mint the browser tokens. Unset means `POST /api/voice/token` answers 404 `voice_disabled` |
   | `outfitter-agentengine-memory-sa` | `AGENT_ENGINE_MEMORY_SA` | `config.ts` → `src/agentengine/` (E9), **link role only** | optional; JSON `{client_id, client_secret}` of the Agent Engine service account in the memory project (`AGENT_ENGINE_MEMORY_PROJECT_ID` in `config.env`, the Atlas project `outfitter`). Role `AGENT_DEVELOPER` is enough for memory. Mounted only while that project id is set. Record its expiry in `AGENT_ENGINE_MEMORY_SA_EXPIRES_AT`; the api warns from 14 days before |
   | `outfitter-agentengine-agents-sa` | `AGENT_ENGINE_AGENTS_SA` | same, for the agents project (E9 PR4) | optional; same shape. Mounted only while `AGENT_ENGINE_AGENTS_PROJECT_ID` is set |

   ```bash
   printf '%s' "<mongodb+srv connection string>" | gcloud secrets create outfitter-mongodb-uri --project=outfitter-509211 --data-file=-
   printf '%s' "<LOCAL_TUNNEL_TOKEN from ~/localllm/.env>" | gcloud secrets create outfitter-local-tunnel-token --project=outfitter-509211 --data-file=-
   # outfitter-litellm-admin: never the master key. ./litellm-admin.sh mints a scoped key (see below).
   printf '%s' "<ngrok API key, dashboard -> API keys>" | gcloud secrets create outfitter-ngrok-api-key --project=outfitter-509211 --data-file=-
   # Deepgram Member key (console -> project -> API keys, role Member); copy it, then:
   pbpaste | tr -d ' \r\n' | gcloud secrets create outfitter-deepgram-key --project=outfitter-509211 --replication-policy=automatic --labels=app=outfitter,purpose=voice --data-file=-
   # placeholder only (see (b) below for the secret that actually gates GitHub access today):
   printf '%s' "<fine-grained GitHub PAT>"    | gcloud secrets create outfitter-github-pat    --project=outfitter-509211 --data-file=-
   ```

   Two more E2.10 config vars are plain (non-secret) env vars, not Secret Manager entries —
   `LITELLM_BASE_URL` (default `https://router.kernal.one/v1`, same var name as kernal's
   `.env.example`) and `PROVIDER_POLL_MS` (default 300000 = 5 minutes). `service.sh` sets both in
   `ENV_VARS` from `config.env`; change them there (and merge) so every deploy agrees.

   A third, `OUTFITTER_OPERATORS` (E2.14/E3.7, `docs/reports/operators.md`), is web-role-only:
   emails allowed to manage secrets and deploy-level settings via `/api/operator/*`, separated by
   `;` (not `,` — `gcloud run deploy --set-env-vars` splits its whole value on commas). `service.sh`
   reads it from `config.env` (`mgm@mgms.eu;matej@mgms.eu`); change it there.

   **b. Per-run, fetched dynamically by `GcpSecretsBroker.secretsForRun` (`src/secrets.ts`) — NOT
   mounted as container env vars, and NOT covered by `api.sh`.** Each session and each guru can
   have its own secret, named by id; each also has a shared `-default` fallback, so the two
   `-default` secrets are the ones to create up front and the per-id ones are per session/guru as
   they're needed:

   ```bash
   # the two shared fallbacks — create these once, before any session or guru exists:
   printf '%s' "<a GitHub PAT covering the repos sessions may use>" \
     | gcloud secrets create "outfitter-github-token-default" --project=outfitter-509211 --data-file=-
   printf '%s' "<a LiteLLM virtual key usable by any guru>" \
     | gcloud secrets create "outfitter-litellm-key-default" --project=outfitter-509211 --data-file=-

   # optional, per session: overrides outfitter-github-token-default for that one session.
   # id from `session.id` (e.g. POST /api/sessions's response):
   printf '%s' "<fine-grained GitHub PAT scoped to that session's repo>" \
     | gcloud secrets create "outfitter-github-token-<sessionId>" --project=outfitter-509211 --data-file=-
   # optional, per guru: overrides outfitter-litellm-key-default for that one guru.
   # id from `guru.id`:
   printf '%s' "<that guru's LiteLLM virtual key>" \
     | gcloud secrets create "outfitter-litellm-key-<guruId>" --project=outfitter-509211 --data-file=-
   ```

   **Per-session vs. shared GitHub token.** The per-session secret wins whenever it exists, and it
   is the tighter of the two: a fine-grained PAT scoped to the one repo that session works in (and
   revocable on its own, without touching any other session) beats a single token that every repo
   session can reach — if a sandbox leaks it, an org-wide token leaks every repo it covers. Mint a
   per-session PAT for anything sensitive: a private or production repo, a session with push
   rights somewhere that matters, a session run by someone who shouldn't reach the rest of the org.
   **GitHub App.** When these three secrets are all set, a repo session with no
   `outfitter-github-token-<sessionId>` of its own gets an installation token instead of
   `outfitter-github-token-default`. The token is minted for that session's repo and expires in
   about an hour; the API sends `github.credential` on each hello and again before it expires. The private key stays in
   the API. Once the App is configured, `outfitter-github-token-default` is no longer used (#158):
   a session whose repo the App's installation doesn't cover fails at start with a note saying so
   (or, for a repo outside the installation's account, that Outfitter only uses that one
   installation), and a failed mint (GitHub or Secret Manager unreachable) is retried rather than
   replaced by the shared PAT. A live run keeps its current token until a mint succeeds. The run
   token asks for Contents: read and write, Pull requests: read and write and Metadata: read, which
   the installation must grant, plus Issues: read and write, Checks: read and Actions: read when it
   grants them (#172): without those the token is minted anyway, the API logs a warning once, and
   only the broker tools that need them answer "not permitted". A missing required permission
   fails the run with a note naming it; grant it in the App's settings and accept it on the
   installation. These failures also hold the session's queued messages (the session page shows
   the reason with a Retry button) instead of retrying them every few minutes. If any of
   the three App secrets is set but they aren't usable together (the Client ID pasted as the App
   id, a key that isn't the PEM, a missing installation id), runs fail with a note asking an
   operator to fix them; removing all three (deleting or disabling their versions) goes back to the
   shared PAT. Create one
   App on the `cognitio-org` account (the same App E6 webhooks will use), install it on every repo
   cloud sessions touch, and store:

   ```bash
   printf '%s' "<numeric App id>" \
     | gcloud secrets create outfitter-github-app-id --project=outfitter-509211 --data-file=-
   printf '%s' "<PEM private key, including the BEGIN line>" \
     | gcloud secrets create outfitter-github-app-private-key --project=outfitter-509211 --data-file=-
   printf '%s' "<numeric installation id>" \
     | gcloud secrets create outfitter-github-app-installation-id --project=outfitter-509211 --data-file=-
   # optional, shown on the session page. Not a credential.
   printf '%s' "<app slug>" \
     | gcloud secrets create outfitter-github-app-slug --project=outfitter-509211 --data-file=-
   ```

   Permissions: Contents write, Pull requests write, Issues write, Checks read, Actions read,
   Metadata read. No user-authorization callback in this slice. Until the three required secrets
   exist, runs keep using the PAT path above. A per-session PAT still wins when it is set.

   Store the private key with the gcloud command above. Operator settings does not list it: a PEM
   contains newlines, and the Test button must not send that key to GitHub. The App id, installation
   id, and slug are listed there; their Test button does not call GitHub.

   `outfitter-github-token-default` exists so that *not* doing so is merely looser rather than
   fatal — before it, creating a repo session through the UI was impossible until an operator
   minted a PAT by hand, against a session id that only exists once the session has been created.
   Scope the shared token as narrowly as it can be while still covering the repos sessions actually
   use. Whichever one a run resolves, `secrets.ts` logs it
   (`[secrets] session <id>: using <secretName>`), so a later clone or push failure can be traced
   to the token it actually had.

   Only a session with a repo (`session.repo` set) falls back to the shared token. `run.spec`
   carries `secrets` for every run regardless, so an unconditional fallback would hand the org-wide
   token to sandboxes with nothing to clone or push — more exposure, no capability. A repo-less
   session that has an `outfitter-github-token-<sessionId>` secret of its own still gets it;
   creating that secret is a deliberate grant.

   Since the first real deploy, a *missing* (b) secret is no longer a hard failure at connection
   time: `GcpSecretsBroker` resolves a not-found secret to `""` (logging a warning) instead of
   throwing, and each per-id secret falls back to its `-default` before giving up. The only place
   this is still fatal is a GitHub token for a session that actually has a repo (`session.repo`
   set) when **neither** `outfitter-github-token-<sessionId>` **nor**
   `outfitter-github-token-default` exists — `agentlink.ts`'s `buildRunSpec` checks for that
   specific case and closes the agentd connection with WS code `4412` (terminal for agentd — there
   is nothing to retry) and a `missing github token secret for session <id>` reason, since agentd
   cloning with no credentials would otherwise fail confusingly deep inside the sandbox instead. A
   repo-less session, or a session/guru resolving via a `-default` fallback, is unaffected either
   way.

   You should not need Cloud Logging to find out that this happened: the run is marked `failed` and
   carries a `statusDetail` saying no GitHub token is stored for the session and that an operator has
   to create one, which the session page shows as a note and the Disk Box list shows under the
   floppy's pill (`docs/protocol.md`, "Every refusal explains itself"). The secret's *name* stays in
   the server log rather than going on a page — it is this section's `outfitter-github-token-` plus
   the session id.

   `outfitter-api`'s `secretmanager.secretAccessor` role covers every secret whose name starts with
   `outfitter-` (an IAM condition set by `secret-scope.sh`, which `baseline.sh` runs), so no
   per-secret IAM binding is needed for either group. Since #389's IAM check it is no longer
   project-wide: the LiteLLM router's own secrets (`kernal-litellm-prod-*`) share this project and
   must stay out of reach of the API. `outfitter-api` also has a project-scoped custom role, under the
   same condition, `projects/<PROJECT>/roles/outfitterSecretAdmin` (create/get secrets,
   add/disable/list versions — narrower than `roles/secretmanager.admin`): the operator settings API
   (`/api/operator/*`, E2.14) needs to create a secret the first time an operator sets it, add a new
   version on Replace, and disable all enabled versions on Disable, none of which
   `secretmanager.secretAccessor` covers. (a)/(b) diverging like this is a known gap,
   not the intended end state — EPIC.md's E2.5 "GitHub auth for runs" / "Atlas" decisions describe
   phase 1 as exactly this per-session PAT model, with a GitHub App replacing it in a later phase;
   `LITELLM_ADMIN_KEY` (a) has no consumer today because nothing in this story needed an
   admin-level LiteLLM key yet — only per-guru virtual keys (b). See `docs/reports/api.md`
   "deviations" for the full writeup.
4. **`./api.sh`** — builds `packages/api` with Cloud Build and deploys it to Cloud Run **as the
   `web` role** (`OUTFITTER_ROLE=web`) with IAP enabled directly on the service (on first creation;
   `./access.sh` owns it after that, and grants `IAP_MEMBERS` from `config.env` — see "IAP access
   for users outside the org" below), and the four (a) secrets above mounted as env vars.
   Also sets `IAP_AUDIENCE` automatically, from `gcloud projects describe`'s project number, to
   `/projects/<projectNumber>/locations/<region>/services/outfitter-api` — the `aud` claim IAP
   signs into `x-goog-iap-jwt-assertion` for a service with IAP enabled directly on Cloud Run (see
   `src/auth.ts` and `api.sh`'s own header comment for the doc citation). Prints the service URL.
   The (b) secrets are created per session/guru as needed, not by this script.
5. **`./link.sh`** — deploys the *same* `packages/api` image a second time, **as the `link` role**
   (`OUTFITTER_ROLE=link`), to its own Cloud Run service `outfitter-link`, `--allow-unauthenticated`
   (no IAP — it authenticates `/agent/ws` and `/api/hooks/*` itself). Mounts the same four (a)
   secrets as `api.sh`. Prints the service URL agentd actually dials. Also **not** set by `link.sh`
   today: `NGROK_WEBHOOK_SECRET` — `POST /api/hooks/ngrok` (see `docs/protocol.md`) 401s every
   delivery until it's set, which is the deliberately-safe default while that push path has no
   confirmed real sender (see `docs/reports/api.md`); add
   `NGROK_WEBHOOK_SECRET=$(gcloud secrets versions access latest --secret=<your secret>)` to
   `link.sh`'s `--set-env-vars` once it does.
6. **`./agent-job.sh`** — builds `image/Dockerfile` (repo root context) with Cloud Build and
   deploys/updates the `outfitter-agent` Cloud Run Job, pointed at `outfitter-link`'s URL (looked
   up; agentd only ever dials `outfitter-link`, never `outfitter-api`). The build uses BuildKit
   with the job's current image as its layer cache (`--cache-from`, `BUILDKIT_INLINE_CACHE=1`), so
   unchanged layers (apt, Playwright, unchanged npm installs) are neither rebuilt nor pushed again.
   With no usable cache (first deploy, a new `node` base image, an image from another repo) it
   builds everything, as before.
7. **`./access.sh`** — IAP on `outfitter-api` with its OAuth client and `IAP_MEMBERS`, the IAP
   service agent's invoker binding, and the public invoker on `outfitter-link` and (once it
   exists) `kernal-web`. Re-run it whenever `IAP_MEMBERS` or `IAP_OAUTH_CLIENT_ID` in `config.env`
   changes, and after the landing page's first deploy.
8. **`./ci-setup.sh`** — the GitHub Actions deployer (see "Deploying"). From then on, pushing a release tag deploys.

**Version skew guard (bug 9, `docs/reports/cloud-fixes.md`)**: `service.sh` and `agent-job.sh` each
label what they deploy `build-commit=<git short sha>` and, before deploying, compare that against
the *other* two components' currently-deployed `build-commit` label (`env.sh`'s
`check_deploy_skew`). A mismatch refuses the deploy and prints which component(s) are stale; `ALLOW_SKEW=1`
downgrades that to a warning for a deliberate partial rollout. Separately, agentd announces its
wire protocol version in `hello` (`packages/agentd/src/protocol.ts`'s `WIRE_PROTOCOL_VERSION`); the
link role refuses (WS close `4409`) a sandbox whose version is older than its own
(`packages/api/src/agentlink.ts`'s `API_PROTOCOL_VERSION`) — so even a sandbox that was already
running before a skewed deploy landed, or one started despite `ALLOW_SKEW=1`, fails loudly at
connect time instead of silently ignoring frames it doesn't understand. See `docs/protocol.md`'s
close-codes table and `hello` row.

Common env vars across all the scripts: `PROJECT` (default `outfitter-509211`), `REGION`
(default `us-central1`), `AR_REPO` (default `outfitter`), `ALLOW_SKEW` (default unset — see
above); the rest are in `config.env`. See each script's header for its other inputs.

## GKE provider (optional)

A second `SandboxProvider` (`docs/specs/gke-sandbox-provider.md`, `docs/specs/
gke-sandbox-provider-plan.md`): GKE Autopilot with the Agent Sandbox add-on, gVisor-isolated, with
an optional warm pool to cut wake time to seconds during active hours. **Set up since 2026-09-24**
(`config.env`'s `GKE_CLUSTER` defaults to `outfitter`): every release keeps the SandboxTemplate on the
release's image. **New runs launch on GKE since 2026-09-26** (`SANDBOX_PROVIDER=gke`,
`GKE_LAUNCH_MODE=warm`: a claim takes a warm pod during warm hours, step 5, and gets a fresh pod
otherwise). Runs started earlier finish on Cloud Run. Back to Cloud Run is step 6 in reverse.
`GKE_CLUSTER=` exported empty turns GKE off for one run; with it empty, a deploy ships byte-identical
env vars to before GKE existed.

**Sandbox size:** 1 vCPU and `GKE_SANDBOX_MEMORY` (default `4Gi` since #187, requests == limits) per
pod, set in `config.env` and applied by the next release's `gke-template.sh`. The limit covers every
process in the sandbox (gVisor's own share, pi, and whatever the agent runs); files don't count, since
the rootfs overlay is disk-backed. At 2Gi a build or test suite OOM-killed a run mid-turn. agentd
reports the sandbox's peak memory in each heartbeat, so a run killed that way is failed with an
"ran out of memory" note that gives the numbers. The warm pool's `updateStrategy: Recreate` replaces
idle warm pods with the new size when the template changes; a run already in progress keeps its pod.

**Exit reasons (#193):** with `get` on pods (`rbac.yaml`, applied by `gke-iam.sh`), the api reads how
a sandbox's agentd container ended (`OOMKilled`, or an exit code) from the pod itself. It looks a few
seconds after agentd's socket drops, and every 20 s at runs quiet for 30 s, since the controller
deletes a finished pod about two minutes later. A found exit fails the run at once with that reason,
which beats the memory estimate above. Until `gke-iam.sh` has run, the pod read is a 403, logged once,
and runs fall back to the estimate.

**Sandbox logs and stats (#197):** the session page reads a run's agentd log lines from Cloud Logging
and its memory, CPU and disk history from Cloud Monitoring. `gke-iam.sh` sets up the access:
- a log bucket `outfitter-sandboxes` (30-day retention);
- a sink that copies agentd's lines into it: agentd containers in the sandbox namespace, and the
  Cloud Run agent job;
- `roles/logging.viewAccessor` for outfitter-api@, conditioned on that bucket's `_AllLogs` view, so it
  can read no other log in the project;
- a custom role `outfitterMetricsReader` with only `monitoring.timeSeries.list`.

A log view on `_Default` can't do this: view filters only allow source, resource type and log id,
not a namespace. The lines stay in `_Default` too; the bucket is a small billed copy.

`gke-teardown.sh` removes all of it. Until `gke-iam.sh` has run, the page says the logs and stats
aren't granted yet (a 503 from the api).

The lines are untrusted. Some are the model's own output, and any sandbox can write log entries
through its service account's `logWriter` (Cloud Run needs it), including ones claiming another
run's id. The page shows them as plain text and says so. #202 closes the gap for GKE runs with a
service account of their own.

**Laptop prerequisite for hand deploys:** with GKE set up, every deploy script run by hand (`api.sh`,
`link.sh`, `agent-job.sh`, `service.sh`, `MANUAL=1 ./release.sh`) checks the SandboxTemplate's
`build-commit` label for skew, so the laptop needs `kubectl` and the auth plugin:
`gcloud components install kubectl gke-gcloud-auth-plugin`. Without them the skew check fails
loudly. `GKE_CLUSTER= ./api.sh` skips it for one run. Tag deploys from GitHub Actions install both
themselves.

All of the scripts below are **owner-run**, on the same footing as `access.sh`/`ci-setup.sh`
(`deploy/CLAUDE.md`): none of them run on their own, and an agent runs them only with the owner's
explicit go-ahead in the conversation (`gke-template.sh` is the one exception — see below). Order:

1. **`./gke-cluster.sh`** — creates the Autopilot cluster `outfitter` with Agent Sandbox enabled
   (`--enable-agent-sandbox --enable-dns-access`). Starts GKE billing (about $73/month, normally
   covered by the account's one free-tier credit — the script refuses if another cluster on the
   billing account is already using it, unless `--i-know`). `DRY_RUN=1` first.
Steps 2 and 3 run with `GKE_CLUSTER=outfitter` exported in the shell, **before** `config.env`
changes (each `config.env` line keeps a value already exported). The order matters: once
`config.env` has `GKE_CLUSTER` set, *every* Outfitter release runs the template step (step 4) as
`outfitter-deployer`, so the deployer's cluster access (step 3) must already exist, or any release in
between fails.

2. **`GKE_CLUSTER=outfitter ./gke-iam.sh`** — the `outfitter-sandboxes` namespace and its `outfitter-agent` KSA, the
   Workload Identity binding letting it impersonate the existing `outfitter-agent@` GSA,
   `roles/container.clusterViewer` on the project for `outfitter-api@`, its RBAC Role/RoleBinding in
   the namespace (`deploy/gke/rbac.yaml`), and the `sandbox-hardening-policy` exemption for that one
   namespace (`deploy/gke/hardening-exemption.json` — GKE's binding stays `Deny` everywhere else).
   Also runs two guards: **logWriter-only** (refuses if `outfitter-agent@` holds any project IAM role
   beyond `roles/logging.logWriter`, since the template keeps the metadata server reachable from
   every sandbox — owner decision "option B", `docs/specs/gke-sandbox-provider-plan.md` §1 — that
   account's permissions are the model's permissions) and **no unexpected binding** on
   `outfitter-agent@`'s own IAM policy (only three are expected: `outfitter-api`'s and
   `outfitter-deployer`'s `serviceAccountUser`, from `baseline.sh` and `ci-setup.sh`, and the KSA's
   `workloadIdentityUser`, from this script). Idempotent; safe to re-run (a GKE upgrade can restore
   the hardening binding this un-exempts). `DRY_RUN=1` first.
3. **`GKE_CLUSTER=outfitter ./ci-setup.sh`** (owner-run). With `GKE_CLUSTER` set and the cluster up,
   it applies the namespaced Role letting `outfitter-deployer` create/patch the SandboxTemplate and
   pool, manage the release-time warm-up claim, and read the `kube-dns` Service in `kube-system`. The
   template step (step 4) runs as the deployer in GitHub Actions and needs all of that. With
   `GKE_CLUSTER` empty, or before `gke-cluster.sh`, `ci-setup.sh` just warns and skips that block.
4. **Set `GKE_CLUSTER` in `config.env`, merge, and cut a release** (`tag-release.sh`; leave
   `SANDBOX_PROVIDER=cloudrun` for now). Merging alone only runs CI. From then on, every release runs
   **`gke-template.sh`** as a step
   between the Job and the link deploy: it renders `deploy/gke/sandbox-template.yaml` and
   `warm-pool.yaml` (`envsubst`: the image tag from `commit_tag` and the cluster's own kube-dns
   Service IP, read live rather than hard-coded — `docs/reports/gke-spike.md` S3; the template
   itself carries no static `OUTFITTER_API`/`RUN_ID`/`RUN_TOKEN` env var, since a cold claim setting
   the same name is rejected by agent-sandbox's `Allowed` injection policy), applies them
   server-side, restores the warm pool's current `replicas` (so a template update never undoes what
   the schedule below set), warms the new image with one throwaway cold claim -- `kubectl create`,
   since image streaming needs one real pull of a brand-new tag before it's fast (S4). The release
   doesn't wait on it: the claim's agentd is refused by the link (no such run) and exits, and
   `ttlSecondsAfterFinished` deletes the claim, with a 15-minute `shutdownTime` as the backstop and
   the next release's label sweep for anything left. It then labels the template
   `build-commit=<tag>`, last, so a failure earlier in this step never hides behind a label that
   makes a retry think it's already done. It also re-runs both `gke-iam.sh` guards. `check_deploy_skew`
   (the bug-9 skew guard) now also compares against the template's `build-commit` label: an older
   template is refused `4409` by a newer link, terminally (S2), so it can never lag -- this applies to
   every deploy script, not only `gke-template.sh` itself, once `GKE_CLUSTER` is set. Skipped
   entirely (no kubectl call at all) while `GKE_CLUSTER` is empty.
5. **`./gke-schedule.sh`** (after step 4, so `config.env` has `GKE_CLUSTER`) — Cloud Scheduler jobs `outfitter-warm-up`/`outfitter-warm-down`, calling
   the link role's `POST /api/hooks/warm-pool {"replicas":N}` hook with an OIDC token as
   `outfitter-tasks` (same pattern as `mailbox.sh`'s `outfitter-tick`). Requires `mailbox.sh` and
   `link.sh` to have already run, and the hook itself to exist (`/api/hooks/warm-pool` ships with
   PR2, #128 — the jobs are harmless but ineffective until it merges and outfitter-link redeploys
   with it). Defaults (owner decision, changed 2026-09-26): 00:00 up / 12:00 down every day, `Europe/Zagreb`, 1 replica —
   override with `WARM_UP_CRON`/`WARM_DOWN_CRON`/`WARM_TZ`/`WARM_REPLICAS`. `release.sh`'s
   audience-drift check (above) now also covers these two jobs. `DRY_RUN=1` first.
6. **Switching providers** is a `config.env` edit plus a release, nothing more: set
   `SANDBOX_PROVIDER=gke` (with `GKE_CLUSTER` already set per step 4), merge, tag. Back to Cloud Run
   is the same edit in reverse; the GKE template, pool and schedule are left in place either way (in
   case of a quick switch back) until `gke-teardown.sh`.

**`./gke-teardown.sh`** (owner-run, not part of the order above) reverses all of it: scales the warm
pool to 0, deletes the two Scheduler jobs, deletes the cluster, and removes the project-level IAM
bindings `gke-iam.sh` added (the namespace's own RBAC and hardening exemption go with the cluster).
Refuses while any `SandboxClaim` exists in `outfitter-sandboxes` unless `--force` — the closest proxy
these scripts can check directly for "an active gke run" without Atlas access (every active run has
exactly one claim; a run whose claim was deleted moments before but isn't yet reconciled as stopped
is the one case this can't see). Re-runnable (a missing binding/job/cluster reads as already done).
`DRY_RUN=1` first. **After a real teardown, empty `GKE_CLUSTER` in `config.env` too (and merge)** —
otherwise the next release's `gke-template.sh` step fails trying to reach a cluster that's gone.

CI (`ci-setup.sh`, also owner-run) grants `outfitter-deployer` `container.clusterViewer` at the
project level (`roles/browser`, already granted, covers the IAM-policy read the logWriter guard
needs — no extra role for that), and — once `GKE_CLUSTER` is set and the cluster exists (step 3
above) — a namespaced Role letting it `get`/`create`/`patch` the SandboxTemplate and pool (`create`
too: the very first release applies to an object that doesn't exist yet, which a real apiserver
authorizes against `create`, not `patch`), `get`/`create`/`delete`/`list` the release-time warm-up
claim (`create`, not `apply`: this Role deliberately grants no `patch` on claims; `list` is for
finding and deleting a stale one left by an interrupted previous run) and `get`/`list`/`watch` its
Sandbox, plus a `kube-system` Role letting it `get` the `kube-dns` Service only. The GitHub Actions
deploy workflow installs `kubectl` and `gke-gcloud-auth-plugin` alongside `gcloud beta`, but only
when `config.env` has `GKE_CLUSTER` set (a small step, `gke-workflow-check.sh`, checks before
`setup-gcloud` runs — it never `source`s `config.env` directly, since that references `${REGION}`,
which only `env.sh` ever sets, and a bare CI step under `set -u` would abort before `setup-gcloud`
ever ran otherwise), so `gke-template.sh` can get a kubeconfig (`gcloud container clusters
get-credentials --dns-endpoint`, into a fresh temp file
in CI, `~/.kube/outfitter` locally — never the shared `~/.kube/config`).

## IAP access for users outside the org

The project sits in the `mgmonteleone.com` organization. By default IAP uses a Google-managed OAuth
client, and that client admits **org-internal users only**: an `@serviam-it.hr` or `@gmail.com`
account can be in the IAP policy and still be refused at sign-in. To let them in, IAP needs a custom
OAuth client with an External audience
(https://cloud.google.com/iap/docs/custom-oauth-configuration). This is a one-time console setup; the
IAP OAuth Admin API that `gcloud iap oauth-brands/oauth-clients` wrapped was shut down in March 2026.

1. Console → Google Auth Platform (project `outfitter-509211`) → **Branding**: app name
   `Outfitter`, support email `mgm@mgms.eu`.
2. **Audience**: User type **External**. Either publish the app ("In production"; it only asks for
   basic scopes, so Google won't require verification) or leave it in Testing and add
   `matija.turk@gmail.com` and the serviam-it.hr users as test users.
3. **Clients** → Create client → *Web application*, name `outfitter-iap`. Save it, copy the client
   ID, then add the authorized redirect URI
   `https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect`.
4. Download the client's JSON from the console and store its secret straight from the file, so
   it never passes through your terminal or shell history:
   `python3 -c 'import json,sys; sys.stdout.write(json.load(open(sys.argv[1]))["web"]["client_secret"])' ~/Downloads/client_secret_<CLIENT_ID>.json | gcloud secrets create outfitter-iap-oauth-client-secret --data-file=- --project=outfitter-509211`
   (`outfitter-api@` does not need access to it; only the deployer reads it). Then delete the JSON.
5. Put the client ID in `config.env` (`IAP_OAUTH_CLIENT_ID`, already set for this project) and run
   `./access.sh`. It sets IAP's OAuth settings on `outfitter-api` and grants every `IAP_MEMBERS`
   entry `roles/iap.httpsResourceAccessor`. Routine deploys never touch either.
6. Check with `gcloud iap web get-iam-policy --resource-type=cloud-run --service=outfitter-api --region=us-central1`
   and `gcloud iap settings get ...`, then sign in from a private window as an outside user.

Everyone who gets through IAP is a regular user. Per EPIC.md's session-visibility decision, they can
see and steer every session, which means directing agents that run with the fleet's GitHub and
LiteLLM credentials. Operator rights still come only from `OUTFITTER_OPERATORS`.

A `domain:` member (`domain:serviam-it.hr`) admits every account that domain's Google Workspace
admin creates, now and later, including its secondary domains; use `user:` entries instead when
access should stay with named people. To remove someone later, see Rollback → "IAP access": the
IAP binding is only half of it.

## Live-test identity (#219)

Automated tests reach `outfitter-api` through IAP as the `outfitter-e2e` service account, with no
person signing in. `./e2e-identity.sh` (owner-run, like `access.sh`; `DRY_RUN=1` to preview)
creates it with no project roles and no keys, grants it `roles/iap.httpsResourceAccessor` on
`outfitter-api` only, and lets each `E2E_TOKEN_MINTERS` principal (config.env) mint its ID tokens
(`roles/iam.serviceAccountOpenIdTokenCreator` on that one account).

A test mints an ID token with the IAM Credentials `generateIdToken` API (audience =
`IAP_OAUTH_CLIENT_ID`, `includeEmail: true`) and sends it as `Proxy-Authorization: Bearer
<token>` on every request, pages and assets included. Use the API rather than `gcloud auth
print-identity-token --impersonate-service-account`, which fetches an access token first and so
needs the broader `serviceAccountTokenCreator`. `./iap-probe.sh` is the check: it mints a token and
expects `GET /api/me` to answer 200 with the account's email (that call records the account in the
users store, as any sign-in does).

**CI.** With `E2E_GITHUB_WORKFLOW` set (config.env; the default is
`.github/workflows/outfitter-live.yml`), `e2e-identity.sh` also creates a Workload Identity pool of
its own, `github-live`, whose provider admits only that workflow file of this repo **at an
`outfitter-v*` tag**. Only repository admins can create those (`ci-setup.sh`'s ruleset); `main` is
not trusted, since it has no branch protection and anyone with write access could push a workflow
that leaks the token. The IAM grant is pinned the same way (a mapped `attribute.live_release`), not
only the provider condition, and the script refuses if the pool holds any other provider. It lets
those tokens mint the account's ID tokens (the same narrow role, nothing else) and sets the
repository variables `GCP_LIVE_WIF_PROVIDER`, `E2E_SERVICE_ACCOUNT` and `E2E_IAP_AUDIENCE` that
switch the workflow on. It is deliberately not `ci-setup.sh`'s `github` pool: every principal of
that pool may act as the deployer. The job runs `npm ci --ignore-scripts`, so no dependency install
script runs where the token can be minted.

Emptying `E2E_GITHUB_WORKFLOW` only skips the setup. To switch CI minting off:

    gh variable delete GCP_LIVE_WIF_PROVIDER --repo cognitio-org/mgm-pi
    gcloud iam workload-identity-pools providers delete outfitter-live --workload-identity-pool=github-live \
      --location=global --project=outfitter-509211
    gcloud iam service-accounts remove-iam-policy-binding outfitter-e2e@outfitter-509211.iam.gserviceaccount.com \
      --project=outfitter-509211 --role=roles/iam.serviceAccountOpenIdTokenCreator \
      --member=principalSet://iam.googleapis.com/projects/97916961297/locations/global/workloadIdentityPools/github-live/attribute.live_release/yes

**The suite** (`packages/web/live/app.live.mjs`, `npm run test:live -w @outfitter/web`) runs at the
end of every deploy ("Outfitter deploy" calls "Outfitter live tests" once the release is out, from
the same tag) and on demand (Actions → "Outfitter live tests" → Run workflow, with an
`outfitter-v*` tag under "Use workflow from"). It checks `/api/me`,
renders the main pages, and runs one floppy through create → reply → archive → format on the
"e2e (live tests)" Tape (created on `E2E_MODEL`, default `litellm/gemini-3.5-flash-lite`). That's
one short Drive run and one small LLM turn per deploy; `E2E_SKIP_LIFECYCLE=1` (or the dispatch
checkbox) runs only the page smoke. Locally it mints its own token through gcloud configuration
`outfitter` when `E2E_IAP_TOKEN` is unset. Every run, pass or fail, uploads a screenshot of each step
as the `outfitter-live-screenshots` artifact (kept 14 days, linked from the run's summary): unzip it
and open `index.html` for a gallery of the steps with pass or fail and timings. Each shot masks the
rows of other people's floppies and Tapes before it's taken (`live/shots.mjs`), since artifacts are
readable by anyone with repository read access; only what the suite made is readable. A failure
also leaves its screenshot as `outfitter-live-failure`, and the page text locally.

The app treats the account as an ordinary user: not a sysop, owner only of what it creates, but
like every IAP member it can see and steer every session. It can't create `outf_` personal tokens
(the api refuses them for any `*.gserviceaccount.com` identity). A fresh binding can take a few
minutes to propagate; until then minting answers `IAM_PERMISSION_DENIED`.

Grants are add-only. To take minting away from a principal dropped from `E2E_TOKEN_MINTERS`:

    gcloud iam service-accounts remove-iam-policy-binding outfitter-e2e@outfitter-509211.iam.gserviceaccount.com \
      --project=outfitter-509211 --member=<principal> --role=roles/iam.serviceAccountOpenIdTokenCreator

To retire the identity: revoke any tokens in its name as a belt-and-braces step (Control Panel →
Revoke Dongles, email `outfitter-e2e@outfitter-509211.iam.gserviceaccount.com`), then delete the
account (`gcloud iam service-accounts delete outfitter-e2e@outfitter-509211.iam.gserviceaccount.com
--project=outfitter-509211`); its IAP binding then matches nothing.

## kernal.one

`kernal.one` (registered at Squarespace, DNS in Cloud DNS zone `kernal-one`, project
`cognitio-flow`) fronts two things through Cloud Run domain mappings in `outfitter-509211`:

| Host | Cloud Run service | What |
|---|---|---|
| `kernal.one` | `kernal-web` | landing page (`outfitter/landing/`), public |
| `www.kernal.one` | `kernal-web` | 301 to `https://kernal.one` (nginx.conf) |
| `app.kernal.one` | `outfitter-api` | the Outfitter web UI, behind IAP as before |
| `link.kernal.one` | `outfitter-link` | what sandboxes and laptops dial (`/agent/ws`, teleport, hooks) |

`./landing.sh` builds and deploys the landing page; `./landing.sh --map-domains` also creates any
missing mappings and prints the DNS records they need.

Each service's `OUTFITTER_ORIGIN` (for the link role, the token audience sandboxes and Cloud
Tasks mint for) changes only on purpose:

- `service.sh` keeps the deployed `OUTFITTER_ORIGIN` unless `ALLOW_ORIGIN_CHANGE=1` is set, and
  then takes the service's custom domain once its mapping is Ready (`env.sh` `public_origin`; a
  failed lookup aborts the deploy rather than falling back to run.app). Without the flag it says
  which origin is available.
- Every deploy also sets `OUTFITTER_ORIGIN_ALIASES` to the service's other origins (run.app URL,
  custom domain, the origin it had before), and link accepts tokens for any of them
  (`config.ts` `tokenAudiences`). So running sandboxes and queued Cloud Tasks minted for the old
  origin keep working through a change, and the order below only matters for tidiness.
- Everything that mints tokens *for* link reads link's deployed `OUTFITTER_ORIGIN`
  (`deployed_origin`): the web role's `OUTFITTER_LINK_ORIGIN`, the Scheduler tick (`mailbox.sh`)
  and the agent job's default `OUTFITTER_API`.

Switching link to `link.kernal.one`, once its mapping is Ready:

1. Check WebSockets through the mapping: a `curl --http1.1` upgrade request to
   `https://link.kernal.one/agent/ws` should get `101 Switching Protocols`, as run.app does.
2. From a clean, up-to-date `main`: `ALLOW_ORIGIN_CHANGE=1 FORCE_ALL=1 ./deploy-all.sh` (a hand
   run of `release.sh`: job, link, web, then the mailbox tick). `FORCE_ALL=1` because the
   components usually already run that commit, and `release.sh` would otherwise skip them. One-off
   scripts work too, in that order, but `check_deploy_skew` refuses a single component whose
   commit differs from the others unless `ALLOW_SKEW=1`.
3. Wake a session and check its sandbox connects. Laptops keep working on the old run.app URL
   (their `outf_` tokens aren't audience-bound) but should switch `OUTFITTER_API` to the new one
   shown on the Tokens page.

`kernal.one` sends `Strict-Transport-Security` with `includeSubDomains` (no `preload`): browsers that
have visited it will insist on HTTPS for every `*.kernal.one` host for a year, so never put a
plain-HTTP service under the domain. The records in the `kernal-one` zone:
`kernal.one` A `216.239.32.21 216.239.34.21 216.239.36.21 216.239.38.21` and AAAA
`2001:4860:4802:{32,34,36,38}::15`; `www`, `app` and `link` CNAME `ghs.googlehosted.com.`. Google
provisions the certificates once DNS resolves (15 min to 24 h).

`app.kernal.one` needs nothing from `outfitter-api`'s own config: IAP's audience is the service
path, not the hostname, and the API never checks a request's host or Origin header. `OUTFITTER_ORIGIN`
(the service's own run.app URL: the agent-token audience, and the base for links the UI prints) can
stay as it is. IAP's OAuth redirect stays on `iap.googleapis.com`, so the OAuth client needs no new
redirect URI. The landing page's CSP pins the hash of its inline theme script
(`landing/security-headers.conf`); recompute it if that script changes.

## Rollback

- **Preferred: redeploy the previous release.** Actions → "Outfitter deploy" → Run workflow, "Use
  workflow from" the previous `outfitter-v*` tag, `rollback` ticked (or `ROLLBACK=1 ./release.sh`
  from a checkout of that tag). The next release rolls forward again. This only reaches commits
  from after the deploy pipeline merged: older commits have no `release.sh`, and their `service.sh`
  still changes IAP, which the deployer can't. Go further back by shifting traffic (below).
- **Faster, services only: shift traffic.** `outfitter-api` and **`outfitter-link`** (both Cloud Run *services*, so each keeps prior
  revisions): list them with `gcloud run revisions list --service=<service> --region=us-central1`,
  then shift traffic back with
  `gcloud run services update-traffic <service> --region=us-central1 --to-revisions=<prior-revision>=100`.
  While traffic is pinned like that, new deploys roll out revisions that get **no traffic**; undo
  it with `gcloud run services update-traffic <service> --region=us-central1 --to-latest` once
  the fix is merged.
  To turn IAP off on `outfitter-api` entirely in an emergency:
  `gcloud run services update outfitter-api --region=us-central1 --no-iap` (or
  `gcloud beta run services update ... --no-iap` if `--no-iap` isn't on your GA channel yet — see
  `api.sh`'s header). `outfitter-link` has no IAP to toggle; its equivalent emergency lever is
  redeploying `outfitter-api` with `OUTFITTER_ROLE=all` and pointing `agent-job.sh`'s
  `OUTFITTER_API` back at it, collapsing both roles onto the one IAP-protected service again (loses
  the ngrok webhook and agentd's connection until IAP is disabled too, so only as a last resort).
- **`outfitter-agent`** (a Cloud Run *Job*, no traffic split): the rollback workflow run above, or
  `gcloud run jobs update outfitter-agent --image=<prior image>` directly — new executions pick up
  the change immediately; a Job has no live traffic to shift.
- **IAP access**: `./access.sh` only ever *adds* members, so dropping one from `IAP_MEMBERS` in
  `config.env` doesn't revoke it. Removing someone takes these steps:
  1. Remove the member (e.g. `user:matija.turk@gmail.com`) with
     `gcloud iap web remove-iam-policy-binding --resource-type=cloud-run --service=outfitter-api --region=us-central1 --member=<member> --role=roles/iap.httpsResourceAccessor`.
  2. Revoke their `outf_` API tokens. `outfitter-link` (public, authenticated only by the token)
     accepts them for session list/get/export/import/stop without going through IAP, so step 1
     alone doesn't cut off teleport. As an operator, open **Control Panel → Access → Revoke
     Dongles** in the web UI, or call `POST /api/operator/tokens/revoke` on `outfitter-api` with
     `{"email": "name@example.com"}` for a `user:` member or `{"domain": "@example.com"}` for a
     `domain:` member. It returns the tokens it revoked and their owners; a repeat returns none.
     Domains match exactly (not subdomains), and shared mail providers such as `@gmail.com` are
     refused: revoke those users by email. Tokens also expire on their own 90 days after creation
     (`TOKEN_TTL_MS` in `packages/api/src/tokens.ts`), so this is the fast path, not the only one.
     Dongles are deprecated (`kernal login` replaces them, central-auth.md §12); new Kernals warn
     while one is still in use.
  3. Signed-in Kernals (`kernal login`, central-auth.md §1.6): with `OUTFITTER_LOGIN_ALLOW` set by
     the deploy, a person dropped from `IAP_MEMBERS` loses every device at its next token refresh
     (within an hour), and their Dongles are refused too. To cut them off at once, revoke their
     devices: `POST /api/operator/devices/revoke` on `outfitter-api` with the same `{"email"}` or
     `{"domain"}` body.
- **Full teardown** (reverse of `baseline.sh`): delete both Cloud Run services (`outfitter-api`,
  `outfitter-link`) and the job (`outfitter-agent`), then the AR repo
  (`gcloud artifacts repositories delete outfitter --location=us-central1`), then the two
  service accounts, then the budget (`gcloud billing budgets delete <name>`); leave the enabled
  APIs (harmless, and other work in the project may depend on them) unless decommissioning the
  whole project.

## Router admin key (`litellm-admin.sh`, owner-run)

Outfitter mints per-user/per-device router keys and short-lived run keys (#389, #394, #395) and
keeps the router's model list in step with laptop hosts (#384). It does this with a **scoped** key,
never the master key:

- LiteLLM user `outfitter-svc` with `user_role: proxy_admin`, so it may mint keys for other users;
- a key for that user with `allowed_routes` limited to key, user, team, spend and model routes
  (enforced for every role, no enterprise licence needed); `/key/regenerate` is not included.

```bash
DRY_RUN=1 ./litellm-admin.sh                      # shows the plan, reads nothing secret
./litellm-admin.sh                                # first time: creates the user + key, stores it
ROTATE=1 ./litellm-admin.sh                       # new key, old secret versions disabled, old key deleted
MASTER_KEY_PROJECT=<project> ./litellm-admin.sh   # if kernal-litellm-prod-master-key lives elsewhere
```

The master key goes to curl through a process substitution and the new key straight into
`gcloud secrets versions add`; neither is printed. Running services pick the new version up on their
next revision. Test: `bash test/litellm-admin.test.sh`.
