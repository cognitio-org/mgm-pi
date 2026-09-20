# Outfitter deploy

`gcloud` scripts for the GCP side of the control plane (EPIC.md E0.2, E2.7). Every script is
idempotent and **none of them run on their own** — review, then run by hand in this order.

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
   | `outfitter-litellm-admin` | `LITELLM_ADMIN_KEY` | **nothing yet** | deployed as a placeholder only — see (b) |

   ```bash
   printf '%s' "<mongodb+srv connection string>" | gcloud secrets create outfitter-mongodb-uri --project=outfitter-509211 --data-file=-
   printf '%s' "<LOCAL_TUNNEL_TOKEN from ~/localllm/.env>" | gcloud secrets create outfitter-local-tunnel-token --project=outfitter-509211 --data-file=-
   # placeholders only (see (b) below for the secrets that actually gate GitHub/LiteLLM access today):
   printf '%s' "<fine-grained GitHub PAT>"    | gcloud secrets create outfitter-github-pat    --project=outfitter-509211 --data-file=-
   printf '%s' "<LiteLLM admin/master key>"   | gcloud secrets create outfitter-litellm-admin  --project=outfitter-509211 --data-file=-
   ```

   **b. Per-run, fetched dynamically by `GcpSecretsBroker.secretsForRun` (`src/secrets.ts`) — NOT
   mounted as container env vars, and NOT covered by `api.sh`.** Each session and each guru needs
   its own secret, named by id, created before that session/guru's first run (or the run's
   `agentlink.ts` connection fails when `buildRunSpec` calls the broker):

   ```bash
   # one per session, id from `session.id` (e.g. POST /api/sessions's response):
   printf '%s' "<fine-grained GitHub PAT scoped to that session's repo>" \
     | gcloud secrets create "outfitter-github-token-<sessionId>" --project=outfitter-509211 --data-file=-
   # one per guru, id from `guru.id`:
   printf '%s' "<that guru's LiteLLM virtual key>" \
     | gcloud secrets create "outfitter-litellm-key-<guruId>" --project=outfitter-509211 --data-file=-
   ```

   `outfitter-api`'s `secretmanager.secretAccessor` role from `baseline.sh` is project-wide, so no
   per-secret IAM binding is needed for either group. (a)/(b) diverging like this is a known gap,
   not the intended end state — EPIC.md's E2.5 "GitHub auth for runs" / "Atlas" decisions describe
   phase 1 as exactly this per-session PAT model, with a GitHub App replacing it in a later phase;
   `LITELLM_ADMIN_KEY` (a) has no consumer today because nothing in this story needed an
   admin-level LiteLLM key yet — only per-guru virtual keys (b). See `docs/reports/api.md`
   "deviations" for the full writeup.
4. **`./api.sh`** — builds `packages/api` with Cloud Build and deploys it to Cloud Run with IAP
   enabled directly on the service, IAP access restricted to `domain:mgmonteleone.com`, and the
   four (a) secrets above mounted as env vars. Prints the service URL. The (b) secrets are created
   per session/guru as needed, not by this script. Also **not** set by `api.sh` today:
   `NGROK_WEBHOOK_SECRET` — `POST /api/hooks/ngrok` (see `docs/protocol.md`) 401s every delivery
   until it's set, which is the deliberately-safe default while that push path has no confirmed
   real sender (see `docs/reports/api.md`); add
   `NGROK_WEBHOOK_SECRET=$(gcloud secrets versions access latest --secret=<your secret>)` to
   `api.sh`'s `--set-env-vars` once it does.
5. **`./agent-job.sh`** — builds `image/Dockerfile` (repo root context) with Cloud Build and
   deploys/updates the `outfitter-agent` Cloud Run Job. Needs `OUTFITTER_API` set to the URL
   `api.sh` printed.

Common env vars across all three scripts: `PROJECT` (default `outfitter-509211`), `REGION`
(default `us-central1`), `AR_REPO` (default `outfitter`). See each script's header for its other
inputs and their defaults.

## Rollback

- **`outfitter-api`** (a Cloud Run *service*, so it keeps prior revisions): list them with
  `gcloud run revisions list --service=outfitter-api --region=us-central1`, then shift traffic
  back with
  `gcloud run services update-traffic outfitter-api --region=us-central1 --to-revisions=<prior-revision>=100`.
  To turn IAP off entirely in an emergency: `gcloud run services update outfitter-api --region=us-central1 --no-iap`
  (or `gcloud beta run services update ... --no-iap` if `--no-iap` isn't on your GA channel yet —
  see `api.sh`'s header).
- **`outfitter-agent`** (a Cloud Run *Job*, no traffic split): re-run `agent-job.sh` with `IMAGE`
  pointed at a prior tag (`IMAGE=us-central1-docker.pkg.dev/outfitter-509211/outfitter/outfitter-agent:<old-tag> ./agent-job.sh`
  after commenting out the build step, or `gcloud run jobs update outfitter-agent --image=<prior image>`
  directly) — new executions pick up the change immediately; a Job has no live traffic to shift.
- **IAP domain access**: remove it with
  `gcloud iap web remove-iam-policy-binding --resource-type=cloud-run --service=outfitter-api --region=us-central1 --member=domain:mgmonteleone.com --role=roles/iap.httpsResourceAccessor`.
- **Full teardown** (reverse of `baseline.sh`): delete the Cloud Run service and job, then the AR
  repo (`gcloud artifacts repositories delete outfitter --location=us-central1`), then the two
  service accounts, then the budget (`gcloud billing budgets delete <name>`); leave the enabled
  APIs (harmless, and other work in the project may depend on them) unless decommissioning the
  whole project.
