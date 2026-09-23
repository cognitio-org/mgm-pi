#!/usr/bin/env bash
# Deploys the kernal.one landing page (outfitter/landing/) to Cloud Run as `kernal-web`: static
# files behind nginx, public, scaled to zero when nobody's looking. release.sh runs this when
# landing/ changed, so a release ships the page like everything else; by hand, from a clean
# checkout of main:
#   ./landing.sh                 build + deploy
#   ./landing.sh --map-domains   also create the kernal.one / www / app / link.kernal.one
#                                domain mappings (once; needs kernal.one verified for ACCOUNT)
# README.md "kernal.one" has the DNS records the mappings need. Being public is an access setting,
# so access.sh owns it (the allUsers invoker), not this script -- see README.md "Deploying".
#
# Not part of the three-component fleet (env.sh check_deploy_skew): the page is static and talks to
# nothing, so it carries no protocol version and can sit at a different commit safely.
set -euo pipefail

MAP_DOMAINS=0
case "${1:-}" in
  "") ;;
  --map-domains) MAP_DOMAINS=1 ;;
  *) echo "usage: $(basename "${BASH_SOURCE[0]}") [--map-domains]" >&2; exit 1 ;;
esac

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
AR_REPO="${AR_REPO:-outfitter}"
SERVICE="kernal-web"

LANDING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../landing" && pwd)"
deploy_guard outfitter/landing outfitter/deploy
CURRENT_IMAGE="$(deployed_image service "${SERVICE}")"
regression_guard "${CURRENT_IMAGE}"
# The tag is the commit the image was built from, like the other services (env.sh commit_tag), so
# release.sh can tell what kernal-web runs and regression_guard can refuse a rollback.
TAG="$(commit_tag)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/kernal-web:${TAG}"

if image_exists "${IMAGE}"; then
  echo "== Reusing ${IMAGE} (already built for this commit) =="
else
  echo "== Building ${IMAGE} with Cloud Build (landing/Dockerfile) =="
  build_submit "${LANDING_DIR}" "$(dirname "${BASH_SOURCE[0]}")/cloudbuild-landing.yaml" \
    --substitutions="_IMAGE=${IMAGE}" --timeout=10m
fi

# Again, right before rolling out: the build can take minutes, and a newer revision may have gone
# out meanwhile.
CURRENT_IMAGE="$(deployed_image service "${SERVICE}")"
regression_guard "${CURRENT_IMAGE}"

echo "== Deploying ${SERVICE} (build-commit=${TAG}) =="
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
  --update-labels="build-commit=${TAG}"

if [[ "${MAP_DOMAINS}" == 1 ]]; then
  # Cloud Run domain mappings (Preview, available in us-central1): free, Google-managed certs.
  # app.kernal.one fronts outfitter-api (the IAP-protected web role) with no config change there:
  # IAP_AUDIENCE is the service path, and the API never checks the request's host or Origin.
  for pair in kernal.one=kernal-web www.kernal.one=kernal-web app.kernal.one=outfitter-api link.kernal.one=outfitter-link; do
    domain="${pair%%=*}"; svc="${pair#*=}"
    if gcloud beta run domain-mappings describe --domain="${domain}" --region="${REGION}" --project="${PROJECT}" &>/dev/null; then
      echo "== ${domain} already mapped =="
    else
      echo "== Mapping ${domain} -> ${svc} =="
      gcloud beta run domain-mappings create --service="${svc}" --domain="${domain}" \
        --region="${REGION}" --project="${PROJECT}"
    fi
  done
  echo "== DNS records these mappings need (Cloud DNS zone kernal-one, project cognitio-flow) =="
  for domain in kernal.one www.kernal.one app.kernal.one link.kernal.one; do
    gcloud beta run domain-mappings describe --domain="${domain}" --region="${REGION}" --project="${PROJECT}" \
      --flatten=status.resourceRecords \
      --format="table[no-heading](status.resourceRecords.name.yesno(no=@),status.resourceRecords.type,status.resourceRecords.rrdata)"
  done
fi

echo "== Done: $(gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" --format='value(status.url)') =="
