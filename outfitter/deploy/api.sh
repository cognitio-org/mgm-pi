#!/usr/bin/env bash
# Build outfitter-api with Cloud Build and deploy it to Cloud Run with IAP enabled directly on the
# service (EPIC.md E2.7). DOES NOT RUN ON ITS OWN — run by hand after baseline.sh and the manual
# Atlas/Secret Manager steps in README.md:
#   PROJECT=outfitter-509211 REGION=us-central1 ./api.sh
#
# Docs consulted (also see docs/reports/api.md "gcloud commands you were least sure about"):
# - Enabling IAP directly on a Cloud Run service (the --iap flag) and granting the IAP service
#   agent run.invoker: https://cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run
#   That page's own example gcloud command is `gcloud run deploy ... --no-allow-unauthenticated
#   --iap` (no `beta` component); some gcloud versions still gate --iap behind
#   `gcloud beta run deploy` / `gcloud beta run services update --iap` -- if this script's `gcloud
#   run deploy --iap` errors with "unrecognized arguments: --iap", rerun with `gcloud beta` instead.
# - Domain-level IAP access via `gcloud iap web add-iam-policy-binding`: same page; its own example
#   only shows `--member=user:...`. `domain:mgmonteleone.com` is the standard IAM member syntax
#   used everywhere else in gcloud, but this exact command with a domain member is unconfirmed by
#   the doc text itself -- verify the binding actually took (`gcloud iap web get-iam-policy`)
#   before relying on it to gate real access.
set -euo pipefail

PROJECT="${PROJECT:-outfitter-509211}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-outfitter}"
SERVICE="outfitter-api"
IAP_DOMAIN="${IAP_DOMAIN:-mgmonteleone.com}"
CLOUDRUN_JOB="${CLOUDRUN_JOB:-outfitter-agent}"
TUNNEL_DOMAIN_LMSTUDIO="${TUNNEL_DOMAIN_LMSTUDIO:-mgm-lmstudio.ngrok.app}"

API_SA_EMAIL="outfitter-api@${PROJECT}.iam.gserviceaccount.com"
AGENT_SA_EMAIL="outfitter-agent@${PROJECT}.iam.gserviceaccount.com"

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/api" && pwd)"
TAG="$(git -C "${SOURCE_DIR}" rev-parse --short HEAD 2>/dev/null || date +%s)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/outfitter-api:${TAG}"

SECRETS="MONGODB_URI=outfitter-mongodb-uri:latest,GITHUB_PAT=outfitter-github-pat:latest,LITELLM_ADMIN_KEY=outfitter-litellm-admin:latest,LOCAL_TUNNEL_TOKEN=outfitter-local-tunnel-token:latest"

echo "== Building ${IMAGE} with Cloud Build (buildpacks: packages/api has no Dockerfile yet) =="
gcloud builds submit "${SOURCE_DIR}" \
  --project="${PROJECT}" \
  --pack="image=${IMAGE}"

# OUTFITTER_ORIGIN is the API's own URL: agentd's token audience (auth.ts verifyAgentToken) and the
# base for any links the UI prints. Cloud Run only hands out that URL once the service exists, so a
# brand-new service gets one bootstrap deploy first (unauthenticated, no IAP, no secrets) purely to
# learn it. Every later run just reads the existing service's URL and skips straight to the real
# deploy below.
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

echo "== Deploying ${SERVICE} with IAP on (OUTFITTER_ORIGIN=${ORIGIN}) =="
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --min-instances=0 \
  --cpu=0.5 \
  --memory=512Mi \
  --service-account="${API_SA_EMAIL}" \
  --no-allow-unauthenticated \
  --iap \
  --set-secrets="${SECRETS}" \
  --set-env-vars="OUTFITTER_ORIGIN=${ORIGIN},AGENT_SA_EMAIL=${AGENT_SA_EMAIL},CLOUDRUN_JOB=${CLOUDRUN_JOB},GCP_PROJECT=${PROJECT},GCP_REGION=${REGION},TUNNEL_DOMAIN_LMSTUDIO=${TUNNEL_DOMAIN_LMSTUDIO}"

echo "== Granting the IAP service agent roles/run.invoker on ${SERVICE} =="
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
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
