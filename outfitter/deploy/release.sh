#!/usr/bin/env bash
# The one routine deploy: moves all three Outfitter components -- the outfitter-agent Job,
# outfitter-link, outfitter-api -- to this checkout's commit, which must be on main. GitHub Actions
# runs it when a release tag is pushed (.github/workflows/outfitter-deploy.yml; tag-release.sh makes
# the tag), one run at a time. A hand run isn't in that queue, so it has to be asked for explicitly,
# and only when the workflow is unavailable:
#   MANUAL=1 ./release.sh         # from a clean, up-to-date checkout of main
#   ROLLBACK=1 ./release.sh       # from a checkout of an OLDER main commit, on purpose
#   FORCE_ALL=1 ./release.sh      # redeploy components already at this commit too
#   DRY_RUN=1 ./release.sh        # print what would deploy, change nothing
#
# Always all three, from one commit (docs/reports/cloud-fixes.md bug 9: env.sh's check_deploy_skew
# refuses a fleet at mixed commits). A component whose build-commit label already equals this
# commit is skipped, so a run that failed halfway can simply be re-run.
#
# Order:
# - the Job first: the link role refuses (WS close 4409) any agentd older than its own protocol
#   version, so a new link ahead of the new image would refuse every sandbox that (re)connects in
#   between. A newer agentd against an older link is harmless.
# - link before web: service.sh's web branch reads outfitter-link's deployed OUTFITTER_ORIGIN.
# - then the mailbox tick: its OIDC audience must follow link's OUTFITTER_ORIGIN (below).
# Each service is smoke-checked right after it rolls out, and the script stops at the first failure.
# Access (IAP, invoker bindings) is never touched here -- that is access.sh.
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
ROOT="$(git -C "${DEPLOY_DIR}" rev-parse --show-toplevel)"
deploy_guard kernal outfitter
if [[ -z "${GITHUB_ACTIONS:-}" && "${DRY_RUN:-}" != 1 && "${MANUAL:-}" != 1 && "${ROLLBACK:-}" != 1 ]]; then
  deploy_fail "pushing a release tag deploys (./tag-release.sh). To deploy by hand anyway -- the workflow is down, or ci-setup.sh hasn't run yet -- use MANUAL=1 ./release.sh; DRY_RUN=1 shows the plan."
fi
HEAD_SHORT="$(commit_tag)"
# Tells check_deploy_skew that the components not yet moved are about to follow.
export DEPLOY_ALL_COMMIT="${HEAD_SHORT}"
echo "== Release ${HEAD_SHORT}: $(git -C "${ROOT}" log -1 --format=%s HEAD) =="

# expect_status <url> <description> <acceptable status>... -- one retry loop, since a fresh
# revision can take a few seconds to take traffic.
expect_status() {
  local url="$1" what="$2" code _
  shift 2
  for _ in 1 2 3 4 5 6; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${url}" || true)"
    for ok in "$@"; do
      if [[ "${code}" == "${ok}" ]]; then
        echo "   smoke: ${what} -> ${code}"
        return 0
      fi
    done
    sleep 5
  done
  deploy_fail "smoke check failed: ${what} (${url}) returned ${code}, expected one of: $*"
}

smoke() {
  local url
  url="$(gcloud run services describe "$1" --project="${PROJECT}" --region="${REGION}" --format='value(status.url)')"
  if [[ "$1" == outfitter-link ]]; then
    # Public, but every /api/ route needs a token: 401 proves the auth hook is in front.
    expect_status "${url}/api/sessions" "$1 rejects an unauthenticated API call" 401
  else
    # IAP must still be in front: the service's own flag, and an unauthenticated request redirected
    # to sign-in or refused.
    web_iap_enabled || deploy_fail "smoke check failed: IAP is OFF on $1; run ./access.sh now"
    expect_status "${url}/" "$1 is behind IAP" 302 401 403
  fi
}

DEPLOYED_ANY=""
# step <kind> <name> <script...>
step() {
  local kind="$1" name="$2" current
  shift 2
  current="$(current_build_commit "${kind}" "${name}")"
  if [[ "${FORCE_ALL:-}" != 1 ]] && component_live_at "${kind}" "${name}" "${HEAD_SHORT}"; then
    echo "== ${name}: already at ${HEAD_SHORT}; skipping =="
  elif [[ "${DRY_RUN:-}" == 1 ]]; then
    echo "== DRY_RUN: would deploy ${name} (${current:-unlabelled} -> ${HEAD_SHORT}) =="
    DEPLOYED_ANY=1
  else
    "$@"
    DEPLOYED_ANY=1
  fi
  [[ "${kind}" == services ]] && smoke "${name}"
  return 0
}

step jobs outfitter-agent "${DEPLOY_DIR}/agent-job.sh"
step services outfitter-link "${DEPLOY_DIR}/service.sh" link
step services outfitter-api "${DEPLOY_DIR}/service.sh" web

# The Scheduler tick (mailbox.sh) mints its OIDC token for the audience link had when mailbox.sh last
# ran; after an origin change (service.sh, ALLOW_ORIGIN_CHANGE=1) it must follow. link keeps
# accepting its previous origins (OUTFITTER_ORIGIN_ALIASES), so a stale tick keeps working meanwhile.
# mailbox.sh grants IAM, which the CI deployer can't, so in Actions this only says so.
if gcloud_exists scheduler jobs describe outfitter-tick --project="${PROJECT}" --location="${REGION}"; then
  TICK_AUDIENCE="$(gcloud scheduler jobs describe outfitter-tick --project="${PROJECT}" --location="${REGION}" \
    --format='value(httpTarget.oidcToken.audience)')"
  LINK_ORIGIN_NOW="$(deployed_origin outfitter-link)"
  if [[ "${TICK_AUDIENCE}" == "${LINK_ORIGIN_NOW}" ]]; then
    echo "== mailbox tick: already targets ${LINK_ORIGIN_NOW} =="
  elif [[ "${DRY_RUN:-}" == 1 ]]; then
    echo "== DRY_RUN: would re-run mailbox.sh (tick ${TICK_AUDIENCE} -> ${LINK_ORIGIN_NOW}) =="
  elif [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::warning::mailbox tick still targets ${TICK_AUDIENCE}, link is now ${LINK_ORIGIN_NOW}: the owner should run ./mailbox.sh (link accepts the old audience meanwhile)"
  else
    "${DEPLOY_DIR}/mailbox.sh"
  fi
fi

if [[ "${DRY_RUN:-}" == 1 ]]; then
  echo "== DRY_RUN: nothing was changed =="
elif [[ -n "${DEPLOYED_ANY}" ]]; then
  echo "== Release ${HEAD_SHORT} done: all three components run it =="
else
  echo "== Nothing to deploy: all three components already run ${HEAD_SHORT} =="
fi
