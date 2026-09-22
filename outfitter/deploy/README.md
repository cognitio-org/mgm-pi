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
- Deploys run one at a time (a `concurrency` group, never cancelled midway). A newer run waiting
  its turn replaces an older waiting one, so production only moves forward. That includes a
  waiting manual rollback: if a release is pushed while it waits, re-run it afterwards.
- The tag message is the changelog (`git show outfitter-v2026.09.22.1`), and rolling back is
  redeploying the previous tag (see Rollback). Tags only, never GitHub Releases: this repo's
  Releases are Kernal's (`vX.Y.Z`), and `kernal update` and `install.sh` read `releases/latest`,
  so an Outfitter Release marked "latest" would break every Kernal install.
- Only repository admins can create, move or delete `outfitter-v*` tags (a tag ruleset
  `ci-setup.sh` creates). That matters: a tag can point at any commit, including a branch commit
  whose own workflow skips `release.sh`'s main-only check, and GCP trusts the workflow at any
  `outfitter-v*` tag.
- Non-secret settings live in **`config.env`**, checked in, so every deploy sets the same
  environment. `--set-env-vars` replaces a service's whole environment, so a value that only
  existed in one person's shell used to vanish on the next deploy from anywhere else. Change a
  value there, merge it, and release.
- GitHub gets no stored key: Workload Identity Federation to the `outfitter-deployer` service
  account, trusted only for this workflow file of this repository (pinned by name and numeric id),
  run from an `outfitter-v*` tag or from `main`. Images build as `outfitter-builder` (push and log
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
workflow's **Run workflow** button (run it from `main`) takes a release tag or `main` commit,
`rollback` and `force_all`.

`landing.sh` (`kernal-web`, the kernal.one page) is not part of this yet; it still deploys by hand.

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
   | `outfitter-litellm-admin` | `LITELLM_ADMIN_KEY` | `config.ts` → `src/providers-status.ts`'s LiteLLM probe (E2.10) | calls `/health/liveliness`, `/model/info`, `/key/info`; falls back to `outfitter-litellm-key-default` (b) when unset |
   | `outfitter-ngrok-api-key` | `NGROK_API_KEY` | `config.ts` → `src/providers-status.ts`'s ngrok probe (E2.10) | optional; `GET https://api.ngrok.com/endpoints` reconciler. Unset means the "ngrok" row reports `unknown`/"not configured", not a poll failure |

   ```bash
   printf '%s' "<mongodb+srv connection string>" | gcloud secrets create outfitter-mongodb-uri --project=outfitter-509211 --data-file=-
   printf '%s' "<LOCAL_TUNNEL_TOKEN from ~/localllm/.env>" | gcloud secrets create outfitter-local-tunnel-token --project=outfitter-509211 --data-file=-
   printf '%s' "<LiteLLM admin/master key>"   | gcloud secrets create outfitter-litellm-admin  --project=outfitter-509211 --data-file=-
   printf '%s' "<ngrok API key, dashboard -> API keys>" | gcloud secrets create outfitter-ngrok-api-key --project=outfitter-509211 --data-file=-
   # placeholder only (see (b) below for the secret that actually gates GitHub access today):
   printf '%s' "<fine-grained GitHub PAT>"    | gcloud secrets create outfitter-github-pat    --project=outfitter-509211 --data-file=-
   ```

   Two more E2.10 config vars are plain (non-secret) env vars, not Secret Manager entries —
   `LITELLM_BASE_URL` (default `https://litellm.augment-code.support/v1`, same var name as kernal's
   `.env.example`) and `PROVIDER_POLL_MS` (default 300000 = 5 minutes). `service.sh` sets both in
   `ENV_VARS` from `config.env`; change them there (and merge) so every deploy agrees.

   A third, `OUTFITTER_OPERATORS` (E2.14/E3.7, `docs/reports/operators.md`), is web-role-only:
   emails allowed to manage secrets and deploy-level settings via `/api/operator/*`, separated by
   `;` (not `,` — `gcloud run deploy --set-env-vars` splits its whole value on commas). `service.sh`
   reads it from `config.env` (`mgm@mgms.eu;matej@mgms.eu`); change it there.

   **b. Per-run, fetched dynamically by `GcpSecretsBroker.secretsForRun` (`src/secrets.ts`) — NOT
   mounted as container env vars, and NOT covered by `api.sh`.** Each session and each guru needs
   its own secret, named by id, ideally created before that session/guru's first run:

   ```bash
   # one per session, id from `session.id` (e.g. POST /api/sessions's response):
   printf '%s' "<fine-grained GitHub PAT scoped to that session's repo>" \
     | gcloud secrets create "outfitter-github-token-<sessionId>" --project=outfitter-509211 --data-file=-
   # one per guru, id from `guru.id`:
   printf '%s' "<that guru's LiteLLM virtual key>" \
     | gcloud secrets create "outfitter-litellm-key-<guruId>" --project=outfitter-509211 --data-file=-
   # optional: a shared fallback used by any guru whose own outfitter-litellm-key-<guruId> secret
   # doesn't exist yet (e.g. a newly created guru). Not required, but recommended so a fresh guru's
   # first run doesn't wake up with an empty LiteLLM key.
   printf '%s' "<a LiteLLM virtual key usable by any guru>" \
     | gcloud secrets create "outfitter-litellm-key-default" --project=outfitter-509211 --data-file=-
   ```

   Since the first real deploy, a *missing* (b) secret is no longer a hard failure at connection
   time: `GcpSecretsBroker` resolves a not-found secret to `""` (logging a warning) instead of
   throwing, and `outfitter-litellm-key-<guruId>` falls back to `outfitter-litellm-key-default`
   before giving up. The only place this is still fatal is `outfitter-github-token-<sessionId>`
   for a session that actually has a repo (`session.repo` set) — `agentlink.ts`'s `buildRunSpec`
   checks for that specific case and closes the agentd connection with WS code 1011 and a
   `missing github token secret for session <id>` reason, since agentd cloning with no credentials
   would otherwise fail confusingly deep inside the sandbox instead. A repo-less session, or a
   guru whose key resolves via the default fallback, is unaffected either way.

   `outfitter-api`'s `secretmanager.secretAccessor` role from `baseline.sh` is project-wide, so no
   per-secret IAM binding is needed for either group. `baseline.sh` also grants `outfitter-api` a
   project-scoped custom role, `projects/<PROJECT>/roles/outfitterSecretAdmin` (create/get secrets,
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
   up; agentd only ever dials `outfitter-link`, never `outfitter-api`).
7. **`./access.sh`** — IAP on `outfitter-api` with its OAuth client and `IAP_MEMBERS`, the IAP
   service agent's invoker binding, and the public invoker on `outfitter-link`. Re-run it whenever
   `IAP_MEMBERS` or `IAP_OAUTH_CLIENT_ID` in `config.env` changes.
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

- **Preferred: redeploy the previous release.** Actions → "Outfitter deploy" → Run workflow (from
  `main`), with `ref` set to the previous `outfitter-v*` tag and `rollback` ticked (or
  `ROLLBACK=1 ./release.sh` from a checkout of that tag). The next release rolls forward again. This only reaches commits
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
  `config.env` doesn't revoke it. Removing someone takes two steps:
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
- **Full teardown** (reverse of `baseline.sh`): delete both Cloud Run services (`outfitter-api`,
  `outfitter-link`) and the job (`outfitter-agent`), then the AR repo
  (`gcloud artifacts repositories delete outfitter --location=us-central1`), then the two
  service accounts, then the budget (`gcloud billing budgets delete <name>`); leave the enabled
  APIs (harmless, and other work in the project may depend on them) unless decommissioning the
  whole project.
