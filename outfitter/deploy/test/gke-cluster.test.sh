#!/usr/bin/env bash
# gke-cluster.sh's read-only checks against a fake gcloud, always with DRY_RUN=1. No network, no GCP.
# The fake records every call, and any call that would change something (enable, create, update,
# delete) fails the test: in a dry run those may only be printed, never run.
#   bash outfitter/deploy/test/gke-cluster.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"${GCLOUD_CALLS}"
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "billing projects describe"*)
    printf '%s\tbillingAccounts/%s\n' "${FAKE_BILLING_ENABLED:-True}" "${FAKE_BILLING_ACCOUNT-01DEC0-9358E1-C1FF0D}" ;;
  "billing projects list"*)
    [[ -n "${FAIL_BILLING:-}" ]] && { echo "Reauthentication failed" >&2; exit 1; }
    printf 'outfitter-509211\nother-proj\n' ;;
  "services list"*cloudbilling*) [[ -n "${BILLING_API_OFF:-}" ]] || echo cloudbilling.googleapis.com ;;
  "services list"*)
    [[ -n "${FAIL_SERVICES:-}" ]] && { echo "PERMISSION_DENIED" >&2; exit 1; }
    echo container.googleapis.com ;;
  "container clusters list --project=other-proj"*) [[ -n "${OTHER_CLUSTER:-}" ]] && echo legacy ;;
  "container clusters list"*) echo outfitter ;;
  "container get-server-config"*validVersions*) echo "${FAKE_VALID:-1.36.4-gke.100;1.35.8-gke.1}" ;;
  "container get-server-config"*) echo "${FAKE_VERSION:-1.36.4-gke.100}" ;;
  "container clusters describe"*) [[ -n "${FAKE_EXISTS:-}" ]] || { echo "ERROR: NOT_FOUND" >&2; exit 1; } ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/gcloud"
export PATH="${WORK}/bin:${PATH}"
export DRY_RUN=1 GCLOUD_CALLS="${WORK}/calls" KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter"
unset GITHUB_ACTIONS GKE_CHANNEL FAIL_BILLING FAIL_SERVICES OTHER_CLUSTER FAKE_VERSION FAKE_VALID \
  BILLING_API_OFF FAKE_EXISTS FAKE_BILLING_ENABLED FAKE_BILLING_ACCOUNT

fails=0
OUT=""
# expect <pass|fail> <description> <grep pattern> [args...] -- runs gke-cluster.sh with the current env.
# Also fails if the dry run actually called anything that changes state, or created the kube dir.
expect() {
  local want="$1" desc="$2" pattern="$3" status=0 problem=""
  shift 3
  : >"${GCLOUD_CALLS}"
  OUT="$("${HERE}/../gke-cluster.sh" "$@" 2>&1)" || status=$?
  if [[ "${want}" == pass && ${status} -ne 0 ]] || [[ "${want}" == fail && ${status} -eq 0 ]]; then
    problem="exit ${status}"
  elif ! grep -q -- "${pattern}" <<<"${OUT}"; then
    problem="no match for: ${pattern}"
  elif grep -E -q '(services enable|clusters (create|update|delete|get-credentials))' "${GCLOUD_CALLS}"; then
    problem="a dry run called: $(grep -E '(enable|create|update|delete|get-credentials)' "${GCLOUD_CALLS}" | head -1)"
  elif [[ -e "${WORK}/kube" ]]; then
    problem="a dry run created ${WORK}/kube"
  fi
  if [[ -n "${problem}" ]]; then
    echo "FAIL: ${desc} (${problem})"; echo "${OUT}" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    echo "ok: ${desc}"
  fi
}
# refute <description> <grep pattern> -- the previous expect's output must NOT contain the pattern.
refute() {
  if grep -q -- "$2" <<<"${OUT}"; then
    echo "FAIL: $1 (unexpected: $2)"; fails=$((fails + 1))
  else
    echo "ok: $1"
  fi
}

expect pass "our own cluster name doesn't count as another cluster" "create-auto outfitter"
expect pass "dry run prints the create with Agent Sandbox and the DNS endpoint" "--enable-agent-sandbox --enable-dns-access$"
expect pass "create-auto writes credentials to its own kubeconfig" "env KUBECONFIG=[^ ]*/kube/outfitter gcloud beta container clusters create-auto"
expect pass "the maintenance window is a separate update, not a create-auto flag" "clusters update outfitter .* --maintenance-window-start="
expect pass "the billing account comes from the project" "billing account 01DEC0-9358E1-C1FF0D: other GKE clusters"
FAKE_BILLING_ACCOUNT=ABC-123 expect pass "a different billing account is the one checked" "billing account ABC-123:"
FAKE_BILLING_ENABLED=False expect fail "a project without billing refuses" "has no billing account enabled"
FAKE_BILLING_ACCOUNT="" expect fail "an empty billing account refuses" "has no billing account enabled"
BILLING_API_OFF=1 expect fail "a dry run with the Cloud Billing API off says how to enable it" "gcloud services enable cloudbilling"
FAIL_BILLING=1 expect fail "a billing lookup error aborts instead of reading as no clusters" "can't list the projects"
FAIL_SERVICES=1 expect fail "an API-list error aborts instead of reading as API off" "can't list enabled APIs"
OTHER_CLUSTER=1 expect fail "another cluster on the billing account refuses" "other-proj/legacy"
OTHER_CLUSTER=1 expect pass "--i-know accepts another cluster" "create-auto outfitter" --i-know
expect pass "a new-enough default pins nothing" "default is new enough"
refute "  ... and passes no --cluster-version" "--cluster-version"
FAKE_VERSION=1.36.3-gke.1767000 expect pass "exactly the minimum version counts as new enough" "default is new enough"
refute "  ... and passes no --cluster-version" "--cluster-version"
FAKE_VERSION=1.35.8-gke.1036000 FAKE_VALID="1.35.8-gke.1036000;1.36.3-gke.1767000;1.36.4-gke.1082000" \
  expect pass "an old default pins the channel's newest valid version" "--cluster-version=1.36.4-gke.1082000"
FAKE_VERSION=1.35.8-gke.1036000 FAKE_VALID="1.35.8-gke.1036000;1.36.3-gke.1700000" \
  expect fail "a channel with nothing at the minimum refuses" "GKE_CHANNEL=rapid"
FAKE_EXISTS=1 expect pass "an existing cluster only gets Agent Sandbox switched on" "exists; making sure Agent Sandbox is on"
refute "  ... and is not created again" "create-auto"
expect fail "an unknown argument refuses" "unknown argument" --force

(( fails == 0 )) || { echo "${fails} failed"; exit 1; }
echo "all passed"
