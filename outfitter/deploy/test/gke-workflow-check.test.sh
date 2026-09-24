#!/usr/bin/env bash
# gke-workflow-check.sh (outfitter-deploy.yml's "Check whether GKE is configured" step) run exactly
# as the workflow runs it: `set -euo pipefail`, and -- the point of this test -- in a genuinely
# clean environment (env -i, no REGION, no PATH beyond what's rebuilt below), since the bug it
# guards against was config.env referencing ${REGION} (only ever set by env.sh) and aborting the
# step on "REGION: unbound variable" before setup-gcloud ever ran. No network, no GCP.
#   bash outfitter/deploy/test/gke-workflow-check.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../gke-workflow-check.sh"
DEFAULT_CONFIG="${HERE}/../config.env"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

fails=0

# run_clean <config.env path> [extra env NAME=val ...] -- runs the script with an empty
# environment plus only PATH (rebuilt to just what grep/bash need) and whatever extra vars are
# given, exactly as `set -euo pipefail` would run it with no REGION and no env.sh.
run_clean() {
  local config="$1"
  shift
  env -i PATH="/usr/bin:/bin" "$@" bash "${SCRIPT}" "${config}"
}

status=0
OUT="$(run_clean "${DEFAULT_CONFIG}")" || status=$?
if [[ ${status} -eq 0 && "${OUT}" == "beta" ]]; then
  echo "ok: GKE off (the repo's own config.env): succeeds under a clean env, prints 'beta'"
else
  echo "FAIL: GKE off: expected exit 0 and 'beta', got exit ${status}: ${OUT}"
  fails=$((fails + 1))
fi

ON_CONFIG="${WORK}/config-on.env"
printf 'GKE_CLUSTER="${GKE_CLUSTER:-outfitter}"\n' >"${ON_CONFIG}"
status=0
OUT="$(run_clean "${ON_CONFIG}")" || status=$?
if [[ ${status} -eq 0 && "${OUT}" == "beta,kubectl,gke-gcloud-auth-plugin" ]]; then
  echo "ok: GKE on: succeeds under a clean env, prints the kubectl components"
else
  echo "FAIL: GKE on: expected exit 0 and the kubectl components, got exit ${status}: ${OUT}"
  fails=$((fails + 1))
fi

GITHUB_OUTPUT_FILE="${WORK}/github_output"
: >"${GITHUB_OUTPUT_FILE}"
run_clean "${ON_CONFIG}" GITHUB_OUTPUT="${GITHUB_OUTPUT_FILE}" >/dev/null
if grep -qx "components=beta,kubectl,gke-gcloud-auth-plugin" "${GITHUB_OUTPUT_FILE}"; then
  echo "ok: GITHUB_OUTPUT gets a components= line the workflow step can read"
else
  echo "FAIL: expected a components= line in GITHUB_OUTPUT, got:"; sed 's/^/    /' "${GITHUB_OUTPUT_FILE}"
  fails=$((fails + 1))
fi

MISSING_CONFIG="${WORK}/config-missing.env"
printf 'SOME_OTHER_VAR=1\n' >"${MISSING_CONFIG}"
status=0
run_clean "${MISSING_CONFIG}" >/dev/null 2>&1 || status=$?
if [[ ${status} -ne 0 ]]; then
  echo "ok: a config.env with no GKE_CLUSTER= line fails loudly instead of guessing"
else
  echo "FAIL: expected a non-zero exit when GKE_CLUSTER= is missing entirely"
  fails=$((fails + 1))
fi

# Direct check of config.env itself (not just this one script): sourcing the whole file under
# `set -u` with REGION unset -- what env.sh's own sourcing order guarantees never happens in
# practice, but what a bare CI step (or any other future caller) could do -- must not abort.
status=0
OUT="$(env -i PATH="/usr/bin:/bin" bash -c "set -euo pipefail; source '${DEFAULT_CONFIG}'; echo \"GKE_LOCATION=\${GKE_LOCATION}\"" 2>&1)" || status=$?
if [[ ${status} -eq 0 && "${OUT}" == "GKE_LOCATION=us-central1" ]]; then
  echo "ok: config.env sources cleanly under set -u with no REGION (GKE_LOCATION defaults to us-central1)"
else
  echo "FAIL: sourcing config.env under set -u with no REGION should succeed with GKE_LOCATION=us-central1, got exit ${status}: ${OUT}"
  fails=$((fails + 1))
fi

echo "${fails} failed"
[[ "${fails}" -eq 0 ]]
