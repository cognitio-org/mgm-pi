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
#
# Re-runnable: every step below tolerates "already gone"/"already removed", so a re-run after a
# partial failure (or just running it twice) is safe. After a real teardown, empty GKE_CLUSTER in
# config.env too (and merge) -- otherwise the next release's gke-template.sh step tries to apply a
# template to a cluster that no longer exists and fails the whole release.
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

# remove_binding_if_present <cmd...> -- like run(), but treats "the binding/member was never there"
# as success rather than a failure, so a re-run (or running this twice by mistake) is safe. Any
# other failure still fails loudly.
remove_binding_if_present() {
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    printf '   DRY_RUN:'; printf ' %q' "$@"; printf '\n'
    return 0
  fi
  local out
  if out="$("$@" 2>&1)"; then
    [[ -n "${out}" ]] && echo "${out}"
    return 0
  fi
  if grep -qiE 'not found|does not exist|NOT_FOUND|no such' <<<"${out}"; then
    echo "   already removed"
    return 0
  fi
  echo "${out}" >&2
  deploy_fail "$1 failed (see above)"
}

CLUSTER_EXISTS=0
if gcloud_exists container clusters describe "${GKE_CLUSTER}" --location="${GKE_LOCATION}" --project="${PROJECT}"; then
  CLUSTER_EXISTS=1
fi

if [[ "${CLUSTER_EXISTS}" == 1 ]]; then
  gke_kubeconfig || deploy_fail "could not obtain a kubeconfig for ${GKE_CLUSTER}"

  if [[ "${DRY_RUN:-0}" != 1 ]]; then
    echo "== Checking for live SandboxClaims in ${GKE_NAMESPACE} =="
    claims_err="$(mktemp)"
    if ! claims="$(kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" get sandboxclaims -o name 2>"${claims_err}")"; then
      # A real lookup failure (Forbidden, a network error, ...) must never read as "no claims": that
      # would delete the cluster out from under any active run without --force ever being given.
      cat "${claims_err}" >&2
      rm -f "${claims_err}"
      deploy_fail "could not list SandboxClaims in ${GKE_NAMESPACE} (see above); refusing to guess whether any run is active"
    fi
    rm -f "${claims_err}"
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
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    run kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
      patch sandboxwarmpool "${GKE_WARM_POOL}" --type=merge -p '{"spec":{"replicas":0}}'
  else
    # Idempotent: gke-cluster.sh and gke-iam.sh may have run with no release yet, so the pool may
    # not exist at all -- that must read as "nothing to scale", same tolerance as gke-template.sh's
    # replicas read, not a hard failure. Any other error still refuses loudly.
    patch_err="$(mktemp)"
    if kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
        patch sandboxwarmpool "${GKE_WARM_POOL}" --type=merge -p '{"spec":{"replicas":0}}' 2>"${patch_err}"; then
      rm -f "${patch_err}"
    elif is_kubectl_notfound "$(cat "${patch_err}")"; then
      rm -f "${patch_err}"
      echo "   ${GKE_WARM_POOL}: doesn't exist yet (no release has run); nothing to scale"
    else
      cat "${patch_err}" >&2
      rm -f "${patch_err}"
      deploy_fail "could not scale ${GKE_WARM_POOL} to 0 (see above)"
    fi
  fi
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
remove_binding_if_present gcloud projects remove-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${API_SA_EMAIL}" --role=roles/container.clusterViewer --condition=None --quiet
# #197's sandbox logs and stats grants, and the log view they read through.
remove_binding_if_present gcloud projects remove-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${API_SA_EMAIL}" --role=roles/logging.viewAccessor --all --quiet
remove_binding_if_present gcloud projects remove-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${API_SA_EMAIL}" --role=roles/monitoring.viewer --condition=None --quiet
remove_binding_if_present gcloud logging views delete outfitter-sandboxes --bucket=_Default --location=global \
  --project="${PROJECT}" --quiet
remove_binding_if_present gcloud iam service-accounts remove-iam-policy-binding "${AGENT_SA_EMAIL}" \
  --project="${PROJECT}" \
  --member="serviceAccount:${PROJECT}.svc.id.goog[${GKE_NAMESPACE}/outfitter-agent]" \
  --role=roles/iam.workloadIdentityUser --quiet

echo "== Done. Empty GKE_CLUSTER in config.env (and merge) before the next release, or gke-template.sh fails trying to reach a cluster that no longer exists. =="
