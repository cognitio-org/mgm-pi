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
# default says. The build-commit label is applied LAST, after the pool patch and the warm-up --
# a failure partway through must leave the label unset, or release.sh's "already at this commit"
# check would skip re-running this script on the retry and never finish the botched apply.
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

echo "== Guard: outfitter-agent@ has no unexpected binding on its own IAM policy =="
assert_agent_sa_no_unexpected_bindings
echo "   ok"

TAG="$(commit_tag)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/outfitter-agent:${TAG}"

# Standalone runs (by hand, not from release.sh right after agent-job.sh built it) must not render a
# template pointing at an image that was never pushed.
image_exists "${IMAGE}" || deploy_fail "${IMAGE} doesn't exist in Artifact Registry; run ./agent-job.sh first (it builds this same tag) or wait for release.sh's Job step"

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
# OUTFITTER_LINK_ORIGIN is NOT a sandbox-template.yaml placeholder (the template must define no
# static OUTFITTER_API -- see its header comment); it's only used below, for the warm-up claim.
export IMAGE GKE_NAMESPACE GKE_WARM_POOL KUBE_DNS_SERVICE_IP
envsubst '${IMAGE} ${GKE_NAMESPACE} ${KUBE_DNS_SERVICE_IP}' \
  <"${GKE_DIR}/sandbox-template.yaml" >"${RENDERED}/sandbox-template.yaml"
envsubst '${GKE_WARM_POOL} ${GKE_NAMESPACE}' \
  <"${GKE_DIR}/warm-pool.yaml" >"${RENDERED}/warm-pool.yaml"
# Identifier-shaped only (${UPPER_SNAKE}): the source files' own header comments describe the
# placeholder syntax in prose (literally "${...}"), which envsubst -- a plain text substitution --
# never touches and isn't itself a leftover variable.
if grep -qE '\$\{[A-Z_][A-Z0-9_]*\}' "${RENDERED}/sandbox-template.yaml" "${RENDERED}/warm-pool.yaml"; then
  grep -nE '\$\{[A-Z_][A-Z0-9_]*\}' "${RENDERED}/sandbox-template.yaml" "${RENDERED}/warm-pool.yaml" >&2
  deploy_fail "a template placeholder above was left unrendered (see above); check the envsubst variable list"
fi

# Preserve whatever the warm-up/warm-down Scheduler hooks (gke-schedule.sh, /api/hooks/warm-pool)
# last set. A real read error here must refuse, not fall back to 0: that would scale a busy warm
# pool to 0 mid-day on a transient API hiccup. Absent a pool yet (NotFound), 0 (cold-only) is the
# correct starting point, not a fallback for "couldn't tell".
CURRENT_REPLICAS_ERR="$(mktemp)"
register_cleanup "${CURRENT_REPLICAS_ERR}"
if CURRENT_REPLICAS="$(kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
    get sandboxwarmpool "${GKE_WARM_POOL}" -o jsonpath='{.spec.replicas}' 2>"${CURRENT_REPLICAS_ERR}")"; then
  CURRENT_REPLICAS="${CURRENT_REPLICAS:-0}"
elif grep -qiE 'NotFound|not found|does not exist' "${CURRENT_REPLICAS_ERR}"; then
  CURRENT_REPLICAS=0
else
  cat "${CURRENT_REPLICAS_ERR}" >&2
  deploy_fail "could not read ${GKE_WARM_POOL}'s current replicas (see above); refusing to apply a template that might reset it to 0"
fi

echo "== Applying SandboxTemplate outfitter-agent (image ${IMAGE}) =="
kubectl --kubeconfig="${KUBECONFIG}" apply --server-side --force-conflicts \
  -f "${RENDERED}/sandbox-template.yaml"

echo "== Applying SandboxWarmPool ${GKE_WARM_POOL} (preserving replicas=${CURRENT_REPLICAS}) =="
kubectl --kubeconfig="${KUBECONFIG}" apply --server-side --force-conflicts \
  -f "${RENDERED}/warm-pool.yaml"
kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
  patch sandboxwarmpool "${GKE_WARM_POOL}" --type=merge -p "{\"spec\":{\"replicas\":${CURRENT_REPLICAS}}}"

# Image streaming needs one real pull of a brand-new tag before it's fast (docs/reports/
# gke-spike.md S4: 28s the first time a tag is ever pulled, ~2s on every pull after). A throwaway
# cold claim pays that cost here instead of on the first real wake. `create`, not `apply`: the
# deployer's Role only grants create/get/delete/list/watch on sandboxclaims, not patch, and a
# one-off object that's never reapplied doesn't need server-side apply's merge semantics anyway.
# Deletion is a registered cleanup command, not a plain call at the end: an interrupt (or a failed
# wait) must still remove it on exit, and a repeat of this same warmup name (RENDERED/TAG-scoped)
# must never be left dangling.
WARMUP_NAME="warmup-${TAG}"
echo "== Warming ${IMAGE} with a throwaway cold claim (${WARMUP_NAME}) =="
cat <<YAML | kubectl --kubeconfig="${KUBECONFIG}" create -f -
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
register_cleanup_cmd "kubectl --kubeconfig='${KUBECONFIG}' -n '${GKE_NAMESPACE}' delete sandboxclaim '${WARMUP_NAME}' --ignore-not-found --wait=false >/dev/null 2>&1"

# Best-effort, bounded: a slow node/image pull here delays the release a little, never fails it --
# the next real wake just pays whatever wasn't warmed. First wait for the controller to assign a
# Sandbox, then for that Sandbox to actually report Ready (i.e. the image pulled and the container
# started), not merely "a name was assigned". register_cleanup_cmd above deletes the claim
# regardless of how this comes out.
SANDBOX_NAME="$(kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
  wait --for=jsonpath='{.status.sandbox.name}' "sandboxclaim/${WARMUP_NAME}" --timeout=60s \
  --output=jsonpath='{.status.sandbox.name}' 2>/dev/null || true)"
if [[ -z "${SANDBOX_NAME}" ]]; then
  SANDBOX_NAME="$(kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
    get sandboxclaim "${WARMUP_NAME}" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)"
fi
if [[ -n "${SANDBOX_NAME}" ]]; then
  kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
    wait --for=condition=Ready "sandbox/${SANDBOX_NAME}" --timeout=120s \
    || echo "   note: the warm-up Sandbox didn't report Ready within 120s; the next real wake pays whatever wasn't warmed" >&2
else
  echo "   note: the warm-up claim never got a Sandbox assigned within 60s; the next real wake pays the pull instead" >&2
fi
# Delete now, in the normal flow (not only via the register_cleanup_cmd trap above, which stays as
# the crash-safety net for an interrupt mid-wait): the label right below must come strictly after
# this in the script's own order.
kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
  delete sandboxclaim "${WARMUP_NAME}" --ignore-not-found --wait=false >/dev/null 2>&1 || true

# Only now: a failure above must leave the template unlabelled, so a re-run of this script (release
# retrying a failed step) doesn't see "already at this commit" and skip re-applying.
kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
  label sandboxtemplate outfitter-agent "build-commit=${TAG}" --overwrite

echo "== Done: SandboxTemplate/SandboxWarmPool at ${TAG} =="
