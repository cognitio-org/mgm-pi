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
# The kernal.one landing page (kernal-web) rides along when landing/ changed: it's static, talks to
# nothing and carries no protocol version, so it isn't part of the fleet's one-commit rule.
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
  if [[ "$1" == kernal-web ]]; then
    # Public static page: it must actually serve.
    expect_status "${url}/" "$1 serves the landing page" 200
  elif [[ "$1" == outfitter-link ]]; then
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

# landing first: it shares nothing with the fleet, and a failure here shouldn't leave the three
# components half-deployed.
LANDING_PATHS=(outfitter/landing outfitter/deploy/landing.sh outfitter/deploy/cloudbuild-landing.yaml outfitter/deploy/env.sh)
landing_current="$(current_build_commit services kernal-web)"
landing_image="$(deployed_image service kernal-web)"
if [[ -z "${landing_image}" ]]; then
  # Creating the service (and then its public invoker, access.sh) is a one-time owner step.
  echo "== kernal-web: not deployed; ./landing.sh creates it =="
elif [[ "${FORCE_ALL:-}" == 1 ]]; then
  step services kernal-web "${DEPLOY_DIR}/landing.sh"
elif [[ -z "${landing_current}" ]]; then
  echo "== kernal-web: runs an unlabelled image; deploying once so releases can track it =="
  step services kernal-web "${DEPLOY_DIR}/landing.sh"
elif component_live_at services kernal-web "${HEAD_SHORT}"; then
  echo "== kernal-web: already at ${HEAD_SHORT}; skipping =="
elif ! git -C "${ROOT}" cat-file -e "${landing_current}^{commit}" 2>/dev/null; then
  echo "   WARNING: kernal-web runs '${landing_current}', which isn't a commit here; deploying it to be sure" >&2
  step services kernal-web "${DEPLOY_DIR}/landing.sh"
elif git -C "${ROOT}" diff --quiet "${landing_current}" HEAD -- "${LANDING_PATHS[@]}"; then
  echo "== kernal-web: runs ${landing_current}, no landing changes since; skipping =="
else
  step services kernal-web "${DEPLOY_DIR}/landing.sh"
fi

# The outfitter-api image (link and web both run it) builds in the background while the agent image
# builds below; the two are independent, and one after the other cost about two minutes a release.
# Only the build runs early: link and web still deploy after the Job and the GKE template, in the
# order above. Its output is held in a log and printed where link used to build it.
API_BUILD_PID="" API_BUILD_LOG=""
if [[ "${DRY_RUN:-}" == 1 ]]; then
  echo "== DRY_RUN: would build the outfitter-api image in the background, alongside the agent image =="
elif [[ "${FORCE_ALL:-}" == 1 ]] || ! component_live_at services outfitter-link "${HEAD_SHORT}" \
  || ! component_live_at services outfitter-api "${HEAD_SHORT}"; then
  API_BUILD_LOG="$(mktemp)"
  register_cleanup "${API_BUILD_LOG}"
  echo "== Building the outfitter-api image in the background (its log follows before link deploys) =="
  # No second `git fetch`: release.sh's own deploy_guard just fetched, and agent-job.sh's is about
  # to run concurrently in the same checkout.
  DEPLOY_GUARD_NO_FETCH=1 "${DEPLOY_DIR}/build-api-image.sh" >"${API_BUILD_LOG}" 2>&1 &
  API_BUILD_PID=$!
  # A release that stops early stops the build script. Its gcloud child may outlive it on a laptop;
  # in Actions the runner ends it with the job, and Cloud Build carries on either way (the next run
  # reuses the image). Evaluated at exit, so an already-waited build is left alone.
  register_cleanup_cmd '[[ -n "${API_BUILD_PID}" ]] && kill "${API_BUILD_PID}" 2>/dev/null || true'
fi
# wait_for_api_image -- blocks until the background build is done, prints its log, and stops the
# release if it failed: link and web must never deploy without their image.
wait_for_api_image() {
  [[ -n "${API_BUILD_PID}" ]] || return 0
  local status=0
  wait "${API_BUILD_PID}" || status=$?
  API_BUILD_PID=""
  echo "== outfitter-api image (built in the background) =="
  sed 's/^/   /' "${API_BUILD_LOG}"
  [[ "${status}" -eq 0 ]] \
    || deploy_fail "the outfitter-api image build failed (exit ${status}, log above); link and web were not deployed"
}

step jobs outfitter-agent "${DEPLOY_DIR}/agent-job.sh"

# GKE template/warm pool, between the Job and link (docs/specs/gke-sandbox-provider-plan.md §2): a
# template built from an older image than the about-to-be-deployed link is refused 4409, terminally
# (docs/reports/gke-spike.md S2 attempt 1), so it must never lag a release. Skipped entirely when
# GKE_CLUSTER is empty (config.env) -- GKE stays off by default.
if [[ -n "${GKE_CLUSTER:-}" ]]; then
  if [[ "${DRY_RUN:-}" == 1 ]]; then
    echo "== DRY_RUN: would apply the GKE SandboxTemplate/SandboxWarmPool for ${HEAD_SHORT} (gke-template.sh) =="
    DEPLOYED_ANY=1
  else
    gke_template_current="$(current_build_commit_gke)"
    if [[ "${FORCE_ALL:-}" != 1 && "${gke_template_current}" == "${HEAD_SHORT}" ]]; then
      echo "== GKE template: already at ${HEAD_SHORT}; skipping =="
    else
      "${DEPLOY_DIR}/gke-template.sh"
      DEPLOYED_ANY=1
    fi
  fi
else
  echo "== GKE template: GKE_CLUSTER is empty; skipping =="
fi

wait_for_api_image
step services outfitter-link "${DEPLOY_DIR}/service.sh" link
step services outfitter-api "${DEPLOY_DIR}/service.sh" web

# Both Scheduler ticks mint their OIDC token for the audience link had when they last ran; after an
# origin change (service.sh, ALLOW_ORIGIN_CHANGE=1) they must follow. link keeps accepting its
# previous origins (OUTFITTER_ORIGIN_ALIASES), so a stale job keeps working meanwhile. Both grant
# IAM, which the CI deployer can't, so in Actions this only warns.
# check_scheduler_audience <job> <rerun script...>
check_scheduler_audience() {
  local job="$1"
  shift
  gcloud_exists scheduler jobs describe "${job}" --project="${PROJECT}" --location="${REGION}" || return 0
  local audience link_origin_now display
  audience="$(gcloud scheduler jobs describe "${job}" --project="${PROJECT}" --location="${REGION}" \
    --format='value(httpTarget.oidcToken.audience)')"
  link_origin_now="$(deployed_origin outfitter-link)"
  # A short, script-relative name in messages -- "$*" here would print DEPLOY_DIR's full absolute
  # path, which is meaningless to whoever reads the log outside this checkout (CI's runner path).
  display="./$(basename "$1")"
  if [[ "${audience}" == "${link_origin_now}" ]]; then
    echo "== ${job}: already targets ${link_origin_now} =="
  elif [[ "${DRY_RUN:-}" == 1 ]]; then
    echo "== DRY_RUN: would re-run ${display} (${job} ${audience} -> ${link_origin_now}) =="
  elif [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::warning::${job} still targets ${audience}, link is now ${link_origin_now}: the owner should run ${display} (link accepts the old audience meanwhile)"
  else
    "$@"
  fi
}
check_scheduler_audience outfitter-tick "${DEPLOY_DIR}/mailbox.sh"
if [[ -n "${GKE_CLUSTER:-}" ]]; then
  check_scheduler_audience outfitter-warm-up "${DEPLOY_DIR}/gke-schedule.sh"
  check_scheduler_audience outfitter-warm-down "${DEPLOY_DIR}/gke-schedule.sh"
fi

if [[ "${DRY_RUN:-}" == 1 ]]; then
  echo "== DRY_RUN: nothing was changed =="
elif [[ -n "${DEPLOYED_ANY}" ]]; then
  echo "== Release ${HEAD_SHORT} done: all three components run it =="
else
  echo "== Nothing to deploy: all three components already run ${HEAD_SHORT} =="
fi
