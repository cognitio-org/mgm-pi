#!/usr/bin/env bash
# gke-teardown.sh against fake gcloud/kubectl. No network, no GCP. DRY_RUN=1 must never call
# anything that mutates (patch/delete/remove-iam-policy-binding).
#   bash outfitter/deploy/test/gke-teardown.test.sh
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
  "container clusters describe"*) [[ "${FAKE_CLUSTER_EXISTS:-1}" == 1 ]] || { echo "ERROR: NOT_FOUND" >&2; exit 1; } ;;
  "container clusters get-credentials"*) : >"${KUBECONFIG}" ;;
  "scheduler jobs describe outfitter-warm-up"*)
    [[ "${FAKE_UP_EXISTS_EXIT:-0}" == 0 ]] || { echo "ERROR: NOT_FOUND" >&2; exit 1; } ;;
  "scheduler jobs describe outfitter-warm-down"*)
    [[ "${FAKE_DOWN_EXISTS_EXIT:-0}" == 0 ]] || { echo "ERROR: NOT_FOUND" >&2; exit 1; } ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/gcloud"

cat >"${WORK}/bin/kubectl" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"${KUBECTL_CALLS}"
case "$*" in
  *"get sandboxclaims -o name"*) [[ -n "${FAKE_CLAIMS:-}" ]] && printf '%s\n' "${FAKE_CLAIMS}" ;;
  *"patch sandboxwarmpool"*)
    [[ -n "${FAKE_POOL_MISSING:-}" ]] && { echo "Error from server (NotFound)" >&2; exit 1; }
    [[ -n "${FAKE_POOL_PATCH_FAILS:-}" ]] && { echo "Error from server (InternalError): etcd timeout" >&2; exit 1; }
    ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/kubectl"

export PATH="${WORK}/bin:${PATH}"
export GCLOUD_CALLS="${WORK}/gcloud-calls" KUBECTL_CALLS="${WORK}/kubectl-calls" \
  GKE_CLUSTER=outfitter KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" FAKE_CLUSTER_EXISTS=1
unset GITHUB_ACTIONS

fails=0
OUT=""
expect() {
  local want="$1" desc="$2" pattern="$3"
  shift 3
  : >"${GCLOUD_CALLS}"; : >"${KUBECTL_CALLS}"
  local status=0
  OUT="$(env "$@" "${HERE}/../gke-teardown.sh" ${EXTRA_ARGS:-} 2>&1)" || status=$?
  local problem=""
  if [[ "${want}" == pass && ${status} -ne 0 ]] || [[ "${want}" == fail && ${status} -eq 0 ]]; then
    problem="exit ${status}"
  elif [[ -n "${pattern}" ]] && ! grep -q -- "${pattern}" <<<"${OUT}"; then
    problem="no match for: ${pattern}"
  fi
  if [[ -n "${problem}" ]]; then
    echo "FAIL: ${desc} (${problem})"; echo "${OUT}" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    echo "ok: ${desc}"
  fi
}
mutation_calls() {
  grep -E 'patch|clusters delete|jobs delete|remove-iam-policy-binding' "${GCLOUD_CALLS}" "${KUBECTL_CALLS}" 2>/dev/null || true
}

expect fail "GKE_CLUSTER empty refuses" "nothing to tear down" GKE_CLUSTER=
EXTRA_ARGS="--bogus" expect fail "an unknown argument refuses" "unknown argument"

DRY_RUN=1 FAKE_CLAIMS="sandboxclaim/run-abc" expect pass "DRY_RUN=1: never mutates, even with live claims" ""
found="$(mutation_calls)"
[[ -z "${found}" ]] && echo "ok:   ... and calls nothing destructive" \
  || { echo "FAIL:   ... a dry run called: ${found}"; fails=$((fails + 1)); }

FAKE_CLAIMS="sandboxclaim/run-abc" expect fail "live SandboxClaims refuse without --force" \
  "SandboxClaims exist in outfitter-sandboxes"
found="$(mutation_calls)"
[[ -z "${found}" ]] && echo "ok:   ... and calls nothing destructive before refusing" \
  || { echo "FAIL:   ... called: ${found}"; fails=$((fails + 1)); }

EXTRA_ARGS="--force" FAKE_CLAIMS="sandboxclaim/run-abc" \
  expect pass "--force tears down despite live claims" "Done"
grep -q "patch sandboxwarmpool outfitter-agent --type=merge" "${KUBECTL_CALLS}" \
  && echo "ok:   ... scaled the pool to 0" || { echo "FAIL: expected a pool patch"; fails=$((fails + 1)); }
grep -q "container clusters delete outfitter" "${GCLOUD_CALLS}" \
  && echo "ok:   ... deleted the cluster" || { echo "FAIL: expected a cluster delete"; fails=$((fails + 1)); }
grep -q "remove-iam-policy-binding.*roles/container.clusterViewer" "${GCLOUD_CALLS}" \
  && echo "ok:   ... removed outfitter-api@'s clusterViewer" || { echo "FAIL: expected a clusterViewer removal"; fails=$((fails + 1)); }
grep -q "remove-iam-policy-binding.*roles/iam.workloadIdentityUser" "${GCLOUD_CALLS}" \
  && echo "ok:   ... removed the Workload Identity binding" || { echo "FAIL: expected a workloadIdentityUser removal"; fails=$((fails + 1)); }

expect pass "no live claims proceeds without --force" "Done"

FAKE_CLUSTER_EXISTS=0 expect pass "cluster already gone: skips the pool/claims steps, still cleans up scheduler and IAM" \
  "already gone"
grep -q "get-credentials" "${GCLOUD_CALLS}" \
  && { echo "FAIL: shouldn't fetch a kubeconfig for a cluster that doesn't exist"; fails=$((fails + 1)); } \
  || echo "ok:   ... never fetches a kubeconfig for a gone cluster"
grep -q "remove-iam-policy-binding.*roles/container.clusterViewer" "${GCLOUD_CALLS}" \
  && echo "ok:   ... still removes the IAM bindings" || { echo "FAIL: expected IAM bindings removed regardless"; fails=$((fails + 1)); }

FAKE_UP_EXISTS_EXIT=1 FAKE_DOWN_EXISTS_EXIT=1 expect pass "scheduler jobs already gone are reported, not re-deleted" \
  "outfitter-warm-up: already gone"
grep -q "scheduler jobs delete" "${GCLOUD_CALLS}" \
  && { echo "FAIL: shouldn't call delete on an absent scheduler job"; fails=$((fails + 1)); } \
  || echo "ok:   ... no delete call made"

# Medium (review round 2): the cluster and gke-iam.sh may have run with no release yet, so the pool
# may not exist at all. That must be idempotent (like the replicas read in gke-template.sh), not a
# hard failure.
FAKE_POOL_MISSING=1 expect pass "a missing warm pool (no release has run yet) is not a failure" \
  "doesn't exist yet (no release has run); nothing to scale"

FAKE_POOL_PATCH_FAILS=1 expect fail "a real pool-patch error (not NotFound) still refuses loudly" \
  "could not scale outfitter-agent to 0"

echo "${fails} failed"
[[ "${fails}" -eq 0 ]]
