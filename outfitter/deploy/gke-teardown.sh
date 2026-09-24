#!/usr/bin/env bash
# Reverses gke-cluster.sh, gke-iam.sh, gke-schedule.sh and gke-template.sh: scales the warm pool to
# 0, deletes the Scheduler jobs, deletes the cluster, and removes the project-level IAM bindings
# gke-iam.sh added. Owner-run only, never from release.sh or CI.
#   DRY_RUN=1 ./gke-teardown.sh
#   ./gke-teardown.sh              # refuses while a SandboxClaim exists
#   ./gke-teardown.sh --force      # tears down regardless
#
# Limitation: deploy scripts have no Atlas access, so this cannot ask the API "is any run using
# sandboxProvider=gke right now". A live SandboxClaim in the namespace is the closest proxy this
# script can check directly -- every active gke run has exactly one -- but it can't see a run whose
# claim was already deleted (e.g. mid-stop) while the API hasn't yet reconciled it as stopped.
# Check `GET /api/operator/runs?active=1` (PR5) yourself before --force if in doubt.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

FORCE=0
for arg in "$@"; do
  case "${arg}" in
    --force) FORCE=1 ;;
    *) deploy_fail "unknown argument '${arg}' (only --force)" ;;
  esac
done

[[ -n "${GKE_CLUSTER:-}" ]] || deploy_fail "GKE_CLUSTER is empty in config.env; nothing to tear down"
GKE_NAMESPACE="${GKE_NAMESPACE:-outfitter-sandboxes}"
GKE_WARM_POOL="${GKE_WARM_POOL:-outfitter-agent}"
AGENT_SA_EMAIL="outfitter-agent@${PROJECT}.iam.gserviceaccount.com"
API_SA_EMAIL="outfitter-api@${PROJECT}.iam.gserviceaccount.com"

# run <cmd...> -- execute, or with DRY_RUN=1 print it instead (gke-cluster.sh's convention).
run() {
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    printf '   DRY_RUN:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

CLUSTER_EXISTS=0
if gcloud_exists container clusters describe "${GKE_CLUSTER}" --location="${GKE_LOCATION}" --project="${PROJECT}"; then
  CLUSTER_EXISTS=1
fi

if [[ "${CLUSTER_EXISTS}" == 1 ]]; then
  gke_kubeconfig || deploy_fail "could not obtain a kubeconfig for ${GKE_CLUSTER}"

  if [[ "${DRY_RUN:-0}" != 1 ]]; then
    echo "== Checking for live SandboxClaims in ${GKE_NAMESPACE} =="
    claims="$(kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" get sandboxclaims -o name 2>/dev/null || true)"
    if [[ -n "${claims}" ]]; then
      echo "${claims}" >&2
      if [[ "${FORCE}" == 0 ]]; then
        deploy_fail "SandboxClaims exist in ${GKE_NAMESPACE} (above); stop those runs first, or --force to tear down anyway (see the limitation note above this script's header)"
      fi
      echo "   --force set; tearing down anyway" >&2
    else
      echo "   none"
    fi
  fi

  echo "== Scaling ${GKE_WARM_POOL} to 0 =="
  run kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
    patch sandboxwarmpool "${GKE_WARM_POOL}" --type=merge -p '{"spec":{"replicas":0}}'
fi

echo "== Deleting Scheduler jobs =="
for job in outfitter-warm-up outfitter-warm-down; do
  if gcloud_exists scheduler jobs describe "${job}" --project="${PROJECT}" --location="${REGION}"; then
    run gcloud scheduler jobs delete "${job}" --project="${PROJECT}" --location="${REGION}" --quiet
  else
    echo "   ${job}: already gone"
  fi
done

echo "== Deleting cluster ${GKE_CLUSTER} =="
if [[ "${CLUSTER_EXISTS}" == 1 ]]; then
  run gcloud container clusters delete "${GKE_CLUSTER}" --location="${GKE_LOCATION}" --project="${PROJECT}" --quiet
else
  echo "   already gone"
fi

# RBAC (rbac.yaml) and the hardening exemption live in the cluster's own API objects, so they go
# with it. Only the project-level bindings gke-iam.sh added need an explicit remove.
echo "== Removing IAM bindings gke-iam.sh added =="
run gcloud projects remove-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${API_SA_EMAIL}" --role=roles/container.clusterViewer --condition=None --quiet
run gcloud iam service-accounts remove-iam-policy-binding "${AGENT_SA_EMAIL}" \
  --project="${PROJECT}" \
  --member="serviceAccount:${PROJECT}.svc.id.goog[${GKE_NAMESPACE}/outfitter-agent]" \
  --role=roles/iam.workloadIdentityUser --quiet

echo "== Done =="
