#!/usr/bin/env bash
# Build outfitter-api's image with Cloud Build and deploy it a *second* time as `outfitter-link`
# (OUTFITTER_ROLE=link, src/config.ts): the "link" role that only registers /agent/ws and
# /api/hooks/* (src/routes/index.ts, src/server.ts). This service is deliberately
# --allow-unauthenticated at the Cloud Run layer and has no IAP — IAP is service-wide on Cloud Run
# and would block agentd's WebSocket (its token's audience is this service's own origin, not IAP's
# client id) and ngrok's unauthenticated webhook delivery before either reached the app. Both
# routes authenticate every request themselves instead (verifyAgentToken / the HMAC check in
# src/routes/hooks.ts). See docs/protocol.md "Two origins" and EPIC.md's components table.
#
# outfitter-api (./api.sh) and outfitter-link (this script) run the exact same image; only
# OUTFITTER_ROLE and the Cloud Run auth setting differ. They share one Atlas store (MONGODB_URI).
#
# DOES NOT RUN ON ITS OWN — run by hand after baseline.sh, the manual Atlas/Secret Manager steps in
# README.md, and api.sh (api.sh's image build is reused if it already ran for this commit):
#   PROJECT=outfitter-509211 REGION=us-central1 ./link.sh
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
AR_REPO="${AR_REPO:-outfitter}"
SERVICE="outfitter-link"
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

# Same secrets outfitter-api mounts (src/secrets.ts's per-run broker and src/laptop.ts's preflight
# both run in this role too — see registerRoutes/buildApp, src/server.ts). GITHUB_PAT and
# LITELLM_ADMIN_KEY aren't read yet (see README.md "Secret Manager" note in api.sh) but are kept
# identical to api.sh's set to avoid two different secret lists to maintain.
# Only mount secrets that exist: Cloud Run refuses the whole deploy when any referenced secret is
# missing, and the API tolerates GITHUB_PAT / LITELLM_ADMIN_KEY being absent until they are needed.
existing_secrets() {
  local out="" pair name
  for pair in "$@"; do
    name="${pair#*=}"; name="${name%%:*}"
    if gcloud secrets describe "${name}" --project="${PROJECT}" &>/dev/null; then
      out="${out:+${out},}${pair}"
    else
      echo "   note: secret ${name} does not exist yet; not mounting ${pair%%=*}" >&2
    fi
  done
  printf '%s' "${out}"
}
SECRETS="$(existing_secrets MONGODB_URI=outfitter-mongodb-uri:latest GITHUB_PAT=outfitter-github-pat:latest LITELLM_ADMIN_KEY=outfitter-litellm-admin:latest LOCAL_TUNNEL_TOKEN=outfitter-local-tunnel-token:latest)"

echo "== Building ${IMAGE} with Cloud Build (reused if api.sh already built this commit) =="
gcloud builds submit "${SOURCE_DIR}" \
  --project="${PROJECT}" \
  --config="${SOURCE_DIR}/deploy/cloudbuild-api.yaml" \
  --substitutions="_IMAGE=${IMAGE}" \
  --timeout=20m

# OUTFITTER_ORIGIN must be *this* service's own URL: it's the audience agentd's Google ID token is
# checked against (auth.ts verifyAgentToken), which is per-service, not shared with outfitter-api.
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

echo "== Deploying ${SERVICE} (OUTFITTER_ROLE=link, unauthenticated at Cloud Run, OUTFITTER_ORIGIN=${ORIGIN}) =="
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --min-instances=0 \
  --cpu=0.5 \
  --memory=512Mi \
  --service-account="${API_SA_EMAIL}" \
  --allow-unauthenticated \
  --set-secrets="${SECRETS}" \
  --set-env-vars="OUTFITTER_ROLE=link,OUTFITTER_ORIGIN=${ORIGIN},AGENT_SA_EMAIL=${AGENT_SA_EMAIL},GCP_PROJECT=${PROJECT},GCP_REGION=${REGION},TUNNEL_DOMAIN_LMSTUDIO=${TUNNEL_DOMAIN_LMSTUDIO}"

echo "== Done: ${ORIGIN} =="
echo "Point agent-job.sh's OUTFITTER_API at this URL, not outfitter-api's. NGROK_WEBHOOK_SECRET"
echo "still needs setting here too (same caveat as api.sh) before POST /api/hooks/ngrok works."
