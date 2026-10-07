#!/usr/bin/env bash
# Build outfitter-api's image for this commit with Cloud Build, unless it already exists. Nothing is
# deployed. release.sh runs this in the background while the agent image builds, so link and web find
# their image ready instead of building it after the agent job (about two minutes of every release);
# service.sh still builds it itself when run on its own, and reuses it when it's there.
#   ./build-api-image.sh
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
AR_REPO="${AR_REPO:-outfitter}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # outfitter/, the workspace root
deploy_guard outfitter
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/outfitter-api:$(commit_tag)"

if image_exists "${IMAGE}"; then
  echo "== Reusing ${IMAGE} (already built for this commit) =="
else
  echo "== Building ${IMAGE} with Cloud Build (packages/api/Dockerfile, context outfitter/) =="
  build_api_image "${SOURCE_DIR}" "${IMAGE}"
fi
