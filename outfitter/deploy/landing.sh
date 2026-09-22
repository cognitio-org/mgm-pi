#!/usr/bin/env bash
# Deploys the kernal.one landing page (outfitter/landing/) to Cloud Run as `kernal-web`: static
# files behind nginx, public (--allow-unauthenticated), scaled to zero when nobody's looking.
#   ./landing.sh                 build + deploy
#   ./landing.sh --map-domains   also create the kernal.one / www.kernal.one / app.kernal.one
#                                domain mappings (once; needs kernal.one verified for ACCOUNT)
# README.md "kernal.one" has the DNS records the mappings need.
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
AR_REPO="${AR_REPO:-outfitter}"
SERVICE="kernal-web"

LANDING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../landing" && pwd)"
TAG="$(git -C "${LANDING_DIR}" rev-parse --short HEAD 2>/dev/null || date +%s)-$(date +%s)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/kernal-web:${TAG}"

echo "== Building ${IMAGE} with Cloud Build (landing/Dockerfile) =="
gcloud builds submit "${LANDING_DIR}" --project="${PROJECT}" --tag="${IMAGE}" --timeout=10m

echo "== Deploying ${SERVICE} =="
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --port=8080 \
  --min-instances=0 \
  --max-instances=3 \
  --cpu=1 \
  --memory=128Mi \
  --concurrency=200 \
  --allow-unauthenticated

if [[ "${1:-}" == "--map-domains" ]]; then
  # Cloud Run domain mappings (Preview, available in us-central1): free, Google-managed certs.
  # app.kernal.one fronts outfitter-api (the IAP-protected web role); its IAP_AUDIENCE and
  # OUTFITTER_ORIGIN don't change, since only the link role's origin is a token audience.
  for pair in kernal.one=kernal-web www.kernal.one=kernal-web app.kernal.one=outfitter-api; do
    domain="${pair%%=*}"; svc="${pair#*=}"
    if gcloud beta run domain-mappings describe --domain="${domain}" --region="${REGION}" --project="${PROJECT}" &>/dev/null; then
      echo "== ${domain} already mapped =="
    else
      echo "== Mapping ${domain} -> ${svc} =="
      gcloud beta run domain-mappings create --service="${svc}" --domain="${domain}" \
        --region="${REGION}" --project="${PROJECT}"
    fi
  done
  echo "== DNS records to create at the registrar (Squarespace) =="
  for domain in kernal.one www.kernal.one app.kernal.one; do
    gcloud beta run domain-mappings describe --domain="${domain}" --region="${REGION}" --project="${PROJECT}" \
      --format='table[no-heading](status.resourceRecords[].name,status.resourceRecords[].type,status.resourceRecords[].rrdata)'
  done
fi

echo "== Done: $(gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" --format='value(status.url)') =="
