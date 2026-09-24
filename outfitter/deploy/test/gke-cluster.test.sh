#!/usr/bin/env bash
# gke-cluster.sh's read-only checks against a fake gcloud, always with DRY_RUN=1. No network, no GCP.
#   bash outfitter/deploy/test/gke-cluster.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "billing projects list"*)
    [[ -n "${FAIL_BILLING:-}" ]] && { echo "Reauthentication failed" >&2; exit 1; }
    printf 'outfitter-509211\nother-proj\n' ;;
  "services list"*cloudbilling*) [[ -n "${BILLING_API_OFF:-}" ]] || echo cloudbilling.googleapis.com ;;
  "services list"*) echo container.googleapis.com ;;
  "container clusters list --project=other-proj"*) [[ -n "${OTHER_CLUSTER:-}" ]] && echo legacy ;;
  "container clusters list"*) echo outfitter ;;
  "container get-server-config"*validVersions*) echo "${FAKE_VALID:-1.36.4-gke.100;1.35.8-gke.1}" ;;
  "container get-server-config"*) echo "${FAKE_VERSION:-1.36.4-gke.100}" ;;
  "container clusters describe"*) echo "ERROR: NOT_FOUND" >&2; exit 1 ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/gcloud"
export PATH="${WORK}/bin:${PATH}"
export DRY_RUN=1
unset GITHUB_ACTIONS GKE_CHANNEL FAIL_BILLING OTHER_CLUSTER FAKE_VERSION FAKE_VALID BILLING_API_OFF

fails=0
# expect <pass|fail> <description> <grep pattern> [args...] -- runs gke-cluster.sh with the current env.
expect() {
  local want="$1" desc="$2" pattern="$3" out status=0
  shift 3
  out="$("${HERE}/../gke-cluster.sh" "$@" 2>&1)" || status=$?
  if [[ "${want}" == pass && ${status} -ne 0 ]] || [[ "${want}" == fail && ${status} -eq 0 ]] \
      || ! grep -q -- "${pattern}" <<<"${out}"; then
    echo "FAIL: ${desc} (exit ${status})"; echo "${out}" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    echo "ok: ${desc}"
  fi
}

expect pass "our own cluster name doesn't count as another cluster" "create-auto outfitter"
expect pass "dry run prints the create with Agent Sandbox and the DNS endpoint" "--enable-agent-sandbox --enable-dns-access$"
expect pass "create-auto writes credentials to its own kubeconfig" "env KUBECONFIG=[^ ]*/.kube/outfitter gcloud beta container clusters create-auto"
expect pass "the maintenance window is a separate update, not a create-auto flag" "clusters update outfitter .* --maintenance-window-start="
BILLING_API_OFF=1 expect fail "a dry run with the Cloud Billing API off says how to enable it" "gcloud services enable cloudbilling"
FAIL_BILLING=1 expect fail "a billing lookup error aborts instead of reading as no clusters" "can't list the projects"
OTHER_CLUSTER=1 expect fail "another cluster on the billing account refuses" "other-proj/legacy"
OTHER_CLUSTER=1 expect pass "--i-know accepts another cluster" "create-auto outfitter" --i-know
expect pass "a new-enough default pins nothing" "default is new enough"
FAKE_VERSION=1.35.8-gke.1036000 FAKE_VALID="1.35.8-gke.1036000;1.36.3-gke.1767000;1.36.4-gke.1082000" \
  expect pass "an old default pins the channel's newest valid version" "--cluster-version=1.36.4-gke.1082000"
FAKE_VERSION=1.35.8-gke.1036000 FAKE_VALID="1.35.8-gke.1036000;1.36.3-gke.1700000" \
  expect fail "a channel with nothing at the minimum refuses" "GKE_CHANNEL=rapid"
FAKE_VERSION=1.36.3-gke.1767000 expect pass "exactly the minimum version passes" "create-auto outfitter"
expect fail "an unknown argument refuses" "unknown argument" --force

(( fails == 0 )) || { echo "${fails} failed"; exit 1; }
echo "all passed"
