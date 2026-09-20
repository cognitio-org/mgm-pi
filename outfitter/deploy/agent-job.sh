#!/usr/bin/env bash
# Build the outfitter-agent sandbox image and deploy/update it as a Cloud Run Job (EPIC.md E1.1,
# E2.3, "Decisions taken": 1 vCPU / 2 GiB default sandbox size). One execution per run; agentd
# itself owns checkpointing and idle-stop, so this job never retries a failed execution.
#
# OUTFITTER_API must be the `outfitter-link` service URL (link.sh prints it), NOT outfitter-api's:
# agentd only ever dials /agent/ws, which lives on the unauthenticated "link" role service, not the
# IAP-protected "web" role one — see link.sh and docs/protocol.md "Two origins".
# DOES NOT RUN ON ITS OWN — run by hand after baseline.sh, api.sh, and link.sh:
#   PROJECT=outfitter-509211 REGION=us-central1 OUTFITTER_API=https://outfitter-link-xyz.run.app ./agent-job.sh
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
AR_REPO="${AR_REPO:-outfitter}"
JOB="outfitter-agent"
AGENT_SA_EMAIL="outfitter-agent@${PROJECT}.iam.gserviceaccount.com"
OUTFITTER_API="${OUTFITTER_API:?set OUTFITTER_API to the outfitter-link service URL (link.sh prints it)}"

# image/Dockerfile COPYs both mgm/ (the pi build) and outfitter/ (agentd), so the build context is
# the repo root, one level above this outfitter/ checkout -- matching image/build.sh's own cd logic.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAG="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || date +%s)"
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
YAML

echo "== Building ${IMAGE} with Cloud Build (context: ${REPO_ROOT}) =="
gcloud builds submit "${REPO_ROOT}" \
  --project="${PROJECT}" \
  --config="${CONFIG_FILE}"

echo "== Deploying job ${JOB} =="
gcloud run jobs deploy "${JOB}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --cpu=1 \
  --memory=2Gi \
  --task-timeout=24h \
  --max-retries=0 \
  --service-account="${AGENT_SA_EMAIL}" \
  --set-env-vars="OUTFITTER_API=${OUTFITTER_API}"

echo "== Done: ${JOB} deployed with ${IMAGE} =="
echo "RunManager (src/runs.ts via CloudRunProvider) overrides RUN_ID/RUN_TOKEN per execution; OUTFITTER_API is the only fixed job env var."
