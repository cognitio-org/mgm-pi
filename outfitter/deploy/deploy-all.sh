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
# - link before web: service.sh's "web" branch reads outfitter-link's deployed OUTFITTER_ORIGIN for
#   OUTFITTER_LINK_ORIGIN.
# - mailbox last: the Scheduler tick's audience follows link's OUTFITTER_ORIGIN.
# An origin change (e.g. to link.kernal.one) needs ALLOW_ORIGIN_CHANGE=1 in the environment; link
# keeps accepting tokens for its previous origins (OUTFITTER_ORIGIN_ALIASES), so nothing in flight
# breaks while the other components catch up. README.md "kernal.one".
#
#   PROJECT=outfitter-509211 REGION=us-central1 ./deploy-all.sh
#
# On a brand-new project deploy link.sh once by hand first, then run this.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "${DIR}/env.sh"

DEPLOY_ALL_COMMIT="$(git -C "${DIR}" rev-parse --short HEAD)"
export DEPLOY_ALL_COMMIT
if [[ -n "$(git -C "${DIR}" status --porcelain 2>/dev/null)" ]]; then
  echo "warning: uncommitted changes -- they will be deployed labelled build-commit=${DEPLOY_ALL_COMMIT}" >&2
fi

# OUTFITTER_API: agent-job.sh defaults it to outfitter-link's deployed OUTFITTER_ORIGIN (env.sh
# deployed_origin). It's only the Job's fallback; every run gets the web role's current link
# origin per execution (providers/cloudrun.ts), so it doesn't matter that link redeploys after.
if [[ -z "$(deployed_origin outfitter-link)" && -z "${OUTFITTER_API:-}" ]]; then
  echo "error: outfitter-link not found; deploy it once with ./link.sh (or set OUTFITTER_API)" >&2
  exit 1
fi

echo "== deploy-all ${DEPLOY_ALL_COMMIT}: 1/4 agent Job =="
"${DIR}/agent-job.sh"

echo "== deploy-all ${DEPLOY_ALL_COMMIT}: 2/4 link =="
"${DIR}/link.sh"

echo "== deploy-all ${DEPLOY_ALL_COMMIT}: 3/4 web =="
"${DIR}/api.sh"

# The Scheduler tick's OIDC audience is link's OUTFITTER_ORIGIN at the time mailbox.sh ran; re-run
# it (idempotent) so an origin change (ALLOW_ORIGIN_CHANGE=1) reaches the tick too. Skipped when
# the mailbox was never set up, rather than creating it here.
if gcloud scheduler jobs describe outfitter-tick --project="${PROJECT}" --location="${REGION}" &>/dev/null; then
  echo "== deploy-all ${DEPLOY_ALL_COMMIT}: 4/4 mailbox tick =="
  "${DIR}/mailbox.sh"
else
  echo "== deploy-all ${DEPLOY_ALL_COMMIT}: 4/4 mailbox tick: not set up, skipped =="
fi

echo "== deploy-all: done, all components deployed from ${DEPLOY_ALL_COMMIT} =="
