#!/usr/bin/env bash
# Renders and applies the outfitter-agent SandboxTemplate and SandboxWarmPool (docs/specs/
# gke-sandbox-provider.md §3.3-3.4, §5.1). Runs as a release.sh step, between the Job and link, only
# when GKE_CLUSTER is set: an older-image template is refused 4409 by a newer link
# (docs/reports/gke-spike.md S2 attempt 1 -- terminal, not a retry), so the template must never lag
# the release. By hand, from a clean checkout of main:
#   ./gke-template.sh
#
# Idempotent: kubectl apply --server-side, and the pool's current replicas (set by
# gke-schedule.sh's warm-up/warm-down hooks) are read before applying and patched straight back
# after, so a template update never resets the warm pool to 0 or to whatever warm-pool.yaml's own
# default says.
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

if [[ -z "${GKE_CLUSTER:-}" ]]; then
  echo "gke-template: GKE_CLUSTER is empty in config.env; nothing to do." >&2
  exit 0
fi
GKE_NAMESPACE="${GKE_NAMESPACE:-outfitter-sandboxes}"
GKE_WARM_POOL="${GKE_WARM_POOL:-outfitter-agent}"
AR_REPO="${AR_REPO:-outfitter}"
GKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/gke" && pwd)"

deploy_guard kernal outfitter

echo "== Guard: outfitter-agent@ holds no project role beyond roles/logging.logWriter =="
assert_agent_sa_logwriter_only
echo "   ok"

TAG="$(commit_tag)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/outfitter-agent:${TAG}"

# Bug 9 style: refuse (or, with ALLOW_SKEW=1, warn) if the Job/web/link are currently at a different
# commit. During a release.sh run DEPLOY_ALL_COMMIT short-circuits this, same as the other three.
check_deploy_skew "${TAG}" "gke-template"

OUTFITTER_LINK_ORIGIN="${OUTFITTER_LINK_ORIGIN:-$(deployed_origin outfitter-link)}"
[[ -n "${OUTFITTER_LINK_ORIGIN}" ]] \
  || deploy_fail "outfitter-link is not deployed; run ./link.sh first or set OUTFITTER_LINK_ORIGIN"

gke_kubeconfig || deploy_fail "could not obtain a kubeconfig for ${GKE_CLUSTER}"

echo "== Reading ${GKE_CLUSTER}'s kube-dns Service IP (cluster-specific; never hard-coded) =="
KUBE_DNS_SERVICE_IP="$(kubectl --kubeconfig="${KUBECONFIG}" -n kube-system get service kube-dns \
  -o jsonpath='{.spec.clusterIP}')"
[[ -n "${KUBE_DNS_SERVICE_IP}" ]] || deploy_fail "could not read kube-dns's Service ClusterIP from ${GKE_CLUSTER}"
echo "   ${KUBE_DNS_SERVICE_IP}"

RENDERED="$(mktemp -d)"
register_cleanup "${RENDERED}"
export IMAGE OUTFITTER_LINK_ORIGIN GKE_NAMESPACE GKE_WARM_POOL KUBE_DNS_SERVICE_IP
envsubst '${IMAGE} ${OUTFITTER_LINK_ORIGIN} ${GKE_NAMESPACE} ${KUBE_DNS_SERVICE_IP}' \
  <"${GKE_DIR}/sandbox-template.yaml" >"${RENDERED}/sandbox-template.yaml"
envsubst '${GKE_WARM_POOL} ${GKE_NAMESPACE}' \
  <"${GKE_DIR}/warm-pool.yaml" >"${RENDERED}/warm-pool.yaml"

# Preserve whatever the warm-up/warm-down Scheduler hooks (gke-schedule.sh, /api/hooks/warm-pool)
# last set; absent a pool yet, 0 (cold-only) is the safe starting point.
CURRENT_REPLICAS="$(kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
  get sandboxwarmpool "${GKE_WARM_POOL}" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
CURRENT_REPLICAS="${CURRENT_REPLICAS:-0}"

echo "== Applying SandboxTemplate outfitter-agent (image ${IMAGE}) =="
kubectl --kubeconfig="${KUBECONFIG}" apply --server-side --force-conflicts \
  -f "${RENDERED}/sandbox-template.yaml"
kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
  label sandboxtemplate outfitter-agent "build-commit=${TAG}" --overwrite

echo "== Applying SandboxWarmPool ${GKE_WARM_POOL} (preserving replicas=${CURRENT_REPLICAS}) =="
kubectl --kubeconfig="${KUBECONFIG}" apply --server-side --force-conflicts \
  -f "${RENDERED}/warm-pool.yaml"
kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
  patch sandboxwarmpool "${GKE_WARM_POOL}" --type=merge -p "{\"spec\":{\"replicas\":${CURRENT_REPLICAS}}}"

# Image streaming needs one real pull of a brand-new tag before it's fast (docs/reports/
# gke-spike.md S4: 28s the first time a tag is ever pulled, ~2s on every pull after). A throwaway
# cold claim (spec.env, so it never adopts the warm pool) pays that cost here instead of on the
# first real wake. It never reaches a real run: OUTFITTER_LINK_ORIGIN would refuse the bogus token.
WARMUP_NAME="warmup-${TAG}"
echo "== Warming ${IMAGE} with a throwaway cold claim (${WARMUP_NAME}) =="
cat <<YAML | kubectl --kubeconfig="${KUBECONFIG}" apply --server-side -f -
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata:
  name: ${WARMUP_NAME}
  namespace: ${GKE_NAMESPACE}
  labels: { app.kubernetes.io/managed-by: outfitter, outfitter.dev/warmup: "true" }
spec:
  warmPoolRef: { name: ${GKE_WARM_POOL} }
  lifecycle: { shutdownPolicy: Delete, ttlSecondsAfterFinished: 60 }
  env:
    - { name: RUN_ID, value: "${WARMUP_NAME}" }
    - { name: RUN_TOKEN, value: "warmup" }
    - { name: OUTFITTER_API, value: "${OUTFITTER_LINK_ORIGIN}" }
YAML
kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
  wait --for=jsonpath='{.status.sandbox.name}' "sandboxclaim/${WARMUP_NAME}" --timeout=120s \
  || echo "   note: warm-up claim didn't report a Sandbox within 120s; the next real wake pays the pull instead" >&2
kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
  delete sandboxclaim "${WARMUP_NAME}" --ignore-not-found --wait=false

echo "== Done: SandboxTemplate/SandboxWarmPool at ${TAG} =="
