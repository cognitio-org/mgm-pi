#!/usr/bin/env bash
# Build outfitter-api's image with Cloud Build and deploy it to Cloud Run as one of the two roles
# (EPIC.md E2.7, src/config.ts's OutfitterRole, docs/protocol.md "Two origins"): IAP is service-wide
# on Cloud Run, so it can't gate just the browser routes while still letting agentd's WebSocket and
# the unauthenticated ngrok webhook through -- the same image is deployed twice instead, picking its
# routes by OUTFITTER_ROLE. `web` (`outfitter-api`) serves browser REST/SSE behind IAP; `link`
# (`outfitter-link`) serves only `/agent/ws` and `/api/hooks/*`, `--allow-unauthenticated`, each
# authenticating its own requests.
#
# NOT RUN DIRECTLY -- api.sh and link.sh are the two-line wrappers you actually run:
#   PROJECT=outfitter-509211 REGION=us-central1 ./api.sh
#   PROJECT=outfitter-509211 REGION=us-central1 ./link.sh
# ./service.sh web|link works too, for anyone reading this script directly.
#
# Docs consulted (also see docs/reports/api.md "gcloud commands you were least sure about"):
# - Enabling IAP directly on a Cloud Run service (the --iap flag) and granting the IAP service
#   agent run.invoker: https://cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run.
#   `gcloud run deploy --iap` worked as-is (no `gcloud beta` needed).
# - Domain-level IAP access via `gcloud iap web add-iam-policy-binding`: same page; its own example
#   only shows `--member=user:...`. `domain:mgmonteleone.com` is the standard IAM member syntax
#   used everywhere else in gcloud, but this exact command with a domain member is unconfirmed by
#   the doc text itself -- verify the binding actually took (`gcloud iap web get-iam-policy`)
#   before relying on it to gate real access.
# - IAP_AUDIENCE: the `aud` claim IAP signs into x-goog-iap-jwt-assertion for a service with IAP
#   enabled directly on Cloud Run is `/projects/PROJECT_NUMBER/locations/REGION/services/SERVICE`
#   (JWT payload claims table, "aud (Audience)" row, "Cloud Run") --
#   https://cloud.google.com/iap/docs/signed-headers-howto. See src/auth.ts for where it's
#   verified. Computed below from `gcloud projects describe`, not hand-set.
set -euo pipefail

ROLE="${1:-}"
if [[ "${ROLE}" != "web" && "${ROLE}" != "link" ]]; then
  echo "usage: $(basename "${BASH_SOURCE[0]}") <web|link>" >&2
  exit 1
fi

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
AR_REPO="${AR_REPO:-outfitter}"
CLOUDRUN_JOB="${CLOUDRUN_JOB:-outfitter-agent}"
IAP_DOMAIN="${IAP_DOMAIN:-mgmonteleone.com}"

if [[ "${ROLE}" == "web" ]]; then
  SERVICE="outfitter-api"
else
  SERVICE="outfitter-link"
fi

# The laptop tunnel domain lives in ~/localllm/.env (same value tunnel.sh uses); read it from there
# unless overridden, so the preflight probes the real endpoint.
if [[ -z "${TUNNEL_DOMAIN_LMSTUDIO:-}" && -f "${HOME}/localllm/.env" ]]; then
  TUNNEL_DOMAIN_LMSTUDIO="$(grep -E '^TUNNEL_DOMAIN_LMSTUDIO=' "${HOME}/localllm/.env" | cut -d= -f2- | tr -d '"'"'"'"' )"
fi
TUNNEL_DOMAIN_LMSTUDIO="${TUNNEL_DOMAIN_LMSTUDIO:?set TUNNEL_DOMAIN_LMSTUDIO (see ~/localllm/.env)}"

API_SA_EMAIL="outfitter-api@${PROJECT}.iam.gserviceaccount.com"
AGENT_SA_EMAIL="outfitter-agent@${PROJECT}.iam.gserviceaccount.com"

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # outfitter/, the workspace root
TAG="$(git -C "${SOURCE_DIR}" rev-parse --short HEAD 2>/dev/null || date +%s)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/outfitter-api:${TAG}"

# existing_secrets() is defined in env.sh (sourced above); the secret list is identical for both
# roles -- see README.md's Secret Manager section for what each role actually reads.
#
# E2.10 provider status service (src/providers-status.ts, src/config.ts) adds three env vars beyond
# what was already here: NGROK_API_KEY (secret, below -- ngrok's /endpoints reconciler poll; the
# ngrok webhook itself keeps using NGROK_WEBHOOK_SECRET, unrelated), LITELLM_BASE_URL (plain, in
# ENV_VARS below -- same var name/default as kernal's .env.example), and PROVIDER_POLL_MS (plain, ENV_VARS,
# default 5 minutes). LITELLM_ADMIN_KEY was already mounted here (it predates E2.10) and is now also
# read by the provider status service's LiteLLM probe, falling back to the default guru LiteLLM key
# (outfitter-litellm-key-default, secrets.ts's SecretsBroker.defaultLitellmKey) when unset.
SECRETS="$(existing_secrets MONGODB_URI=outfitter-mongodb-uri:latest GITHUB_PAT=outfitter-github-pat:latest LITELLM_ADMIN_KEY=outfitter-litellm-admin:latest LOCAL_TUNNEL_TOKEN=outfitter-local-tunnel-token:latest NGROK_API_KEY=outfitter-ngrok-api-key:latest)"

echo "== Building ${IMAGE} with Cloud Build (packages/api/Dockerfile, context outfitter/; reused if the other role already built this commit) =="
gcloud builds submit "${SOURCE_DIR}" \
  --project="${PROJECT}" \
  --config="${SOURCE_DIR}/deploy/cloudbuild-api.yaml" \
  --substitutions="_IMAGE=${IMAGE}" \
  --timeout=20m

# OUTFITTER_ORIGIN is this service's own URL: agentd's token audience (auth.ts verifyAgentToken,
# per-service, not shared between outfitter-api and outfitter-link) and the base for any links the
# UI prints. Cloud Run only hands out that URL once the service exists, so a brand-new service gets
# one bootstrap deploy first (unauthenticated, no IAP, no secrets) purely to learn it. Every later
# run just reads the existing service's URL and skips straight to the real deploy below.
ORIGIN="${OUTFITTER_ORIGIN:-}"
if [[ -z "${ORIGIN}" ]]; then
  ORIGIN="$(gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" \
    --format='value(status.url)' 2>/dev/null || true)"
fi
if [[ -z "${ORIGIN}" ]]; then
  echo "== Bootstrap deploy (no prior revision, no OUTFITTER_ORIGIN given) to learn the service URL =="
  gcloud run deploy "${SERVICE}" \
    --project="${PROJECT}" \
    --region="${REGION}" \
    --image="${IMAGE}" \
    --min-instances=0 \
    --cpu=0.5 \
    --memory=512Mi \
    --service-account="${API_SA_EMAIL}" \
    --allow-unauthenticated
  ORIGIN="$(gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" \
    --format='value(status.url)')"
fi

# ROLE-specific pieces: auth flags at deploy time, and OUTFITTER_ROLE/IAP_AUDIENCE in the env.
# SANDBOX_PROVIDER and CLOUDRUN_JOB go to BOTH roles: the provider is constructed at boot (config
# validation), even though only the web role ever wakes a run. Without them the API defaults to the
# in-process dev provider and refuses to start (the link revision 00005 failure).
ENV_VARS="OUTFITTER_ROLE=${ROLE},OUTFITTER_ORIGIN=${ORIGIN},AGENT_SA_EMAIL=${AGENT_SA_EMAIL},GCP_PROJECT=${PROJECT},GCP_REGION=${REGION},TUNNEL_DOMAIN_LMSTUDIO=${TUNNEL_DOMAIN_LMSTUDIO},SANDBOX_PROVIDER=cloudrun,CLOUDRUN_JOB=${CLOUDRUN_JOB},IDLE_STOP_SECONDS=${IDLE_STOP_SECONDS:-1800},LITELLM_BASE_URL=${LITELLM_BASE_URL:-https://litellm.augment-code.support/v1},PROVIDER_POLL_MS=${PROVIDER_POLL_MS:-300000}"
# E5.5 (deploy/mailbox.sh): both roles need these -- web schedules wake tasks, link verifies the
# OIDC token on /api/hooks/tasks/wake and /api/hooks/tick. Unset keeps the mailbox on its
# inline-wake-only path.
if [[ -n "${CLOUD_TASKS_QUEUE:-}" && -n "${TASKS_SA_EMAIL:-}" ]]; then
  ENV_VARS="${ENV_VARS},CLOUD_TASKS_QUEUE=${CLOUD_TASKS_QUEUE},TASKS_SA_EMAIL=${TASKS_SA_EMAIL}"
fi
if [[ "${ROLE}" == "web" ]]; then
  # Needed both for IAP_AUDIENCE (below) and for the run.invoker binding further down.
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
  # See the "IAP_AUDIENCE" doc comment above.
  IAP_AUDIENCE="/projects/${PROJECT_NUMBER}/locations/${REGION}/services/${SERVICE}"
  ENV_VARS="${ENV_VARS},IAP_AUDIENCE=${IAP_AUDIENCE}"
  # OUTFITTER_LINK_ORIGIN (E4.1b, src/config.ts): the outfitter-link service's own URL, surfaced on
  # GET /api/me so the web UI's Tokens page can print the exact OUTFITTER_API value a laptop needs
  # (env.sh has no way to know it from inside this "web" deploy -- it's a different Cloud Run
  # service). Chicken-and-egg on a brand-new project: deploy the "link" role once first (its own
  # bootstrap deploy above learns its URL the same way OUTFITTER_ORIGIN does here), then re-run
  # `./api.sh` with OUTFITTER_LINK_ORIGIN set (or exported in the shell) so it lands in this env
  # list; omitted or empty, the Tokens page just tells the operator to ask for the link URL.
  if [[ -n "${OUTFITTER_LINK_ORIGIN:-}" ]]; then
    ENV_VARS="${ENV_VARS},OUTFITTER_LINK_ORIGIN=${OUTFITTER_LINK_ORIGIN}"
  fi
  # OUTFITTER_OPERATORS (EPIC.md Decisions table, src/config.ts): emails allowed to manage secrets
  # and deploy-level settings via /api/operator/* (src/auth.ts's requireOperator). Separated by
  # ';' here, not ',' -- `gcloud run deploy --set-env-vars` splits its whole value on commas, so a
  # comma-separated operator list would be sliced into separate env vars; config.ts's parser also
  # accepts ',' and whitespace for a locally-set env var, but this script must use ';'. Defaults to
  # the two current operators (see the same Decisions table entry); override by exporting
  # OUTFITTER_OPERATORS before running this script.
  ENV_VARS="${ENV_VARS},OUTFITTER_OPERATORS=${OUTFITTER_OPERATORS:-mgm@mgms.eu;matej@mgms.eu}"
  AUTH_FLAGS=(--no-allow-unauthenticated --iap)
else
  AUTH_FLAGS=(--allow-unauthenticated)
fi

echo "== Deploying ${SERVICE} (OUTFITTER_ROLE=${ROLE}, OUTFITTER_ORIGIN=${ORIGIN}) =="
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --min-instances=0 \
  --cpu=0.5 \
  --memory=512Mi \
  --service-account="${API_SA_EMAIL}" \
  "${AUTH_FLAGS[@]}" \
  --set-secrets="${SECRETS}" \
  --set-env-vars="${ENV_VARS}"

if [[ "${ROLE}" == "web" ]]; then
  echo "== Granting the IAP service agent roles/run.invoker on ${SERVICE} =="
  gcloud run services add-iam-policy-binding "${SERVICE}" \
    --project="${PROJECT}" \
    --region="${REGION}" \
    --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
    --role="roles/run.invoker" \
    --quiet

  echo "== Granting domain:${IAP_DOMAIN} roles/iap.httpsResourceAccessor on ${SERVICE} =="
  gcloud iap web add-iam-policy-binding \
    --resource-type=cloud-run \
    --service="${SERVICE}" \
    --region="${REGION}" \
    --project="${PROJECT}" \
    --member="domain:${IAP_DOMAIN}" \
    --role="roles/iap.httpsResourceAccessor"

  echo "== Done: ${ORIGIN} =="
  echo "Visiting it should now prompt Google sign-in and reject any account outside ${IAP_DOMAIN}."
else
  echo "== Done: ${ORIGIN} =="
  echo "Point agent-job.sh's OUTFITTER_API at this URL, not outfitter-api's. NGROK_WEBHOOK_SECRET"
  echo "still needs setting here too (same caveat as README.md's Secret Manager section) before"
  echo "POST /api/hooks/ngrok works."
fi
