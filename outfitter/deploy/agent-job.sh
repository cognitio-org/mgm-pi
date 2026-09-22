#!/usr/bin/env bash
# Build the outfitter-agent sandbox image and deploy/update it as a Cloud Run Job (EPIC.md E1.1,
# E2.3, "Decisions taken": 1 vCPU / 2 GiB default sandbox size). One execution per run; agentd
# itself owns checkpointing and idle-stop, so this job never retries a failed execution.
#
# OUTFITTER_API must be the `outfitter-link` origin, NOT outfitter-api's (defaults to link's own
# deployed OUTFITTER_ORIGIN, e.g. https://link.kernal.one; RunManager also passes it per execution):
# agentd only ever dials /agent/ws, which lives on the unauthenticated "link" role service, not the
# IAP-protected "web" role one — see link.sh and docs/protocol.md "Two origins".
# Routine deploys go through release.sh (a pushed outfitter-v* tag), which runs this first. By
# hand, from a clean checkout of main:
#   ./agent-job.sh
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
AR_REPO="${AR_REPO:-outfitter}"
JOB="outfitter-agent"
AGENT_SA_EMAIL="outfitter-agent@${PROJECT}.iam.gserviceaccount.com"
OUTFITTER_API="${OUTFITTER_API:-$(deployed_origin outfitter-link)}"
OUTFITTER_API="${OUTFITTER_API:?outfitter-link is not deployed; run ./link.sh first or set OUTFITTER_API}"

# image/Dockerfile COPYs both kernal/ (the pi build) and outfitter/ (agentd), so the build context is
# the repo root, one level above this outfitter/ checkout -- matching image/build.sh's own cd logic.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The image COPYs from kernal/ and outfitter/, so both must be committed main (env.sh deploy_guard).
deploy_guard kernal outfitter
CURRENT_IMAGE="$(deployed_image job "${JOB}")"
regression_guard "${CURRENT_IMAGE}"
TAG="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/outfitter-agent:${TAG}"

# `gcloud builds submit --tag` can't point at a Dockerfile outside the source root, and ours lives
# at outfitter/image/Dockerfile with the repo root as context, so we hand it an inline config
# instead of a bare --tag build.
CONFIG_FILE="$(mktemp)"
trap 'rm -f "${CONFIG_FILE}"' EXIT
cat >"${CONFIG_FILE}" <<YAML
steps:
  - name: gcr.io/cloud-builders/docker
    args: ["build", "-f", "outfitter/image/Dockerfile", "-t", "${IMAGE}", "."]
images: ["${IMAGE}"]
options:
  logging: CLOUD_LOGGING_ONLY
YAML

if image_exists "${IMAGE}"; then
  echo "== Reusing ${IMAGE} (already built for this commit) =="
else
  echo "== Building ${IMAGE} with Cloud Build (context: ${REPO_ROOT}) =="
  build_submit "${REPO_ROOT}" "${CONFIG_FILE}"
fi

# Again, right before rolling out: a newer job image may have gone out during the build.
CURRENT_IMAGE="$(deployed_image job "${JOB}")"
regression_guard "${CURRENT_IMAGE}"

# Bug 9 (docs/reports/cloud-fixes.md): same skew guard as service.sh -- refuse (or, with
# ALLOW_SKEW=1, warn) if outfitter-api/outfitter-link are currently deployed at a different commit.
check_deploy_skew "${TAG}" "job"

echo "== Deploying job ${JOB} (build-commit=${TAG}) =="
gcloud run jobs deploy "${JOB}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --cpu=1 \
  --memory=2Gi \
  --task-timeout=24h \
  --max-retries=0 \
  --service-account="${AGENT_SA_EMAIL}" \
  --labels="build-commit=${TAG}" \
  --set-env-vars="OUTFITTER_API=${OUTFITTER_API}"

echo "== Done: ${JOB} deployed with ${IMAGE} =="
echo "RunManager (src/runs.ts via CloudRunProvider) overrides RUN_ID/RUN_TOKEN per execution; OUTFITTER_API is the only fixed job env var."
