#!/usr/bin/env bash
# Bug 9 (docs/reports/cloud-fixes.md): deploys the agent Job, then link, then web, all from one
# commit. Each of those scripts runs env.sh's check_deploy_skew, which refuses a single-component
# deploy against components at another commit; this script is the sanctioned way to move all three
# at once, so it tells the guard (DEPLOY_ALL_COMMIT) that the other components are about to follow.
# Without that, step 1 of any real upgrade would see the other two still at the old commit and
# refuse. A partial run (e.g. the Job and link succeed, web fails) can simply be re-run.
#
# Order matters:
# - the Job first: the link role refuses (WS close 4409) any agentd older than its own
#   API_PROTOCOL_VERSION, so a new link ahead of the new image would refuse every sandbox that
#   (re)connects in between -- including running ones, which all reconnect when link redeploys.
#   A newer agentd against an older link is harmless (the old link ignores hello.protocolVersion).
# - link before web: service.sh's "web" branch reads outfitter-link's URL for OUTFITTER_LINK_ORIGIN.
#
#   PROJECT=outfitter-509211 REGION=us-central1 ./deploy-all.sh
#
# OUTFITTER_API (agent-job.sh) defaults to the deployed outfitter-link URL. On a brand-new project
# deploy link.sh once by hand first, then run this.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "${DIR}/env.sh"

DEPLOY_ALL_COMMIT="$(git -C "${DIR}" rev-parse --short HEAD)"
export DEPLOY_ALL_COMMIT
if [[ -n "$(git -C "${DIR}" status --porcelain 2>/dev/null)" ]]; then
  echo "warning: uncommitted changes -- they will be deployed labelled build-commit=${DEPLOY_ALL_COMMIT}" >&2
fi

if [[ -z "${OUTFITTER_API:-}" ]]; then
  OUTFITTER_API="$(gcloud run services describe outfitter-link --project="${PROJECT}" --region="${REGION}" \
    --format='value(status.url)' 2>/dev/null || true)"
fi
if [[ -z "${OUTFITTER_API:-}" ]]; then
  echo "error: outfitter-link not found; deploy it once with ./link.sh (or set OUTFITTER_API)" >&2
  exit 1
fi
export OUTFITTER_API

echo "== deploy-all ${DEPLOY_ALL_COMMIT}: 1/3 agent Job =="
"${DIR}/agent-job.sh"

echo "== deploy-all ${DEPLOY_ALL_COMMIT}: 2/3 link =="
"${DIR}/link.sh"

echo "== deploy-all ${DEPLOY_ALL_COMMIT}: 3/3 web =="
"${DIR}/api.sh"

echo "== deploy-all: done, all three components deployed from ${DEPLOY_ALL_COMMIT} =="
