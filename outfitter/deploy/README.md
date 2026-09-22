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
roles, so `service.sh` takes the role as its one argument and only branches on it for the
IAP/`--allow-unauthenticated` flags, `IAP_AUDIENCE`, and the two IAM bindings (`web` only).
`api.sh` and `link.sh` are two-line wrappers (`./service.sh web` / `./service.sh link`) kept around
so the commands below still work unchanged.

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
   `ENV_VARS` with those same defaults; override by exporting them before running it.

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
   per-secret IAM binding is needed for either group. (a)/(b) diverging like this is a known gap,
   not the intended end state — EPIC.md's E2.5 "GitHub auth for runs" / "Atlas" decisions describe
   phase 1 as exactly this per-session PAT model, with a GitHub App replacing it in a later phase;
   `LITELLM_ADMIN_KEY` (a) has no consumer today because nothing in this story needed an
   admin-level LiteLLM key yet — only per-guru virtual keys (b). See `docs/reports/api.md`
   "deviations" for the full writeup.
4. **`./api.sh`** — builds `packages/api` with Cloud Build and deploys it to Cloud Run **as the
   `web` role** (`OUTFITTER_ROLE=web`) with IAP enabled directly on the service, IAP access
   restricted to `domain:mgmonteleone.com`, and the four (a) secrets above mounted as env vars.
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
   deploys/updates the `outfitter-agent` Cloud Run Job. Needs `OUTFITTER_API` set to the URL
   `link.sh` printed (not `api.sh`'s — agentd only ever dials `outfitter-link`).

Common env vars across all four scripts: `PROJECT` (default `outfitter-509211`), `REGION`
(default `us-central1`), `AR_REPO` (default `outfitter`). See each script's header for its other
inputs and their defaults.

## Rollback

- **`outfitter-api`** and **`outfitter-link`** (both Cloud Run *services*, so each keeps prior
  revisions): list them with `gcloud run revisions list --service=<service> --region=us-central1`,
  then shift traffic back with
  `gcloud run services update-traffic <service> --region=us-central1 --to-revisions=<prior-revision>=100`.
  To turn IAP off on `outfitter-api` entirely in an emergency:
  `gcloud run services update outfitter-api --region=us-central1 --no-iap` (or
  `gcloud beta run services update ... --no-iap` if `--no-iap` isn't on your GA channel yet — see
  `api.sh`'s header). `outfitter-link` has no IAP to toggle; its equivalent emergency lever is
  redeploying `outfitter-api` with `OUTFITTER_ROLE=all` and pointing `agent-job.sh`'s
  `OUTFITTER_API` back at it, collapsing both roles onto the one IAP-protected service again (loses
  the ngrok webhook and agentd's connection until IAP is disabled too, so only as a last resort).
- **`outfitter-agent`** (a Cloud Run *Job*, no traffic split): re-run `agent-job.sh` with `IMAGE`
  pointed at a prior tag (`IMAGE=us-central1-docker.pkg.dev/outfitter-509211/outfitter/outfitter-agent:<old-tag> ./agent-job.sh`
  after commenting out the build step, or `gcloud run jobs update outfitter-agent --image=<prior image>`
  directly) — new executions pick up the change immediately; a Job has no live traffic to shift.
- **IAP domain access**: remove it with
  `gcloud iap web remove-iam-policy-binding --resource-type=cloud-run --service=outfitter-api --region=us-central1 --member=domain:mgmonteleone.com --role=roles/iap.httpsResourceAccessor`.
- **Full teardown** (reverse of `baseline.sh`): delete both Cloud Run services (`outfitter-api`,
  `outfitter-link`) and the job (`outfitter-agent`), then the AR repo
  (`gcloud artifacts repositories delete outfitter --location=us-central1`), then the two
  service accounts, then the budget (`gcloud billing budgets delete <name>`); leave the enabled
  APIs (harmless, and other work in the project may depend on them) unless decommissioning the
  whole project.
