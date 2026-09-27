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
GKE_SANDBOX_MEMORY="${GKE_SANDBOX_MEMORY:-4Gi}"
# A Kubernetes quantity in Mi or Gi only: it lands unquoted in the template's resources, and a
# typo there would fail the apply mid-release (release.sh runs this after the agent Job has moved to
# the new image, before link and web). Checked here, before anything touches the cluster.
[[ "${GKE_SANDBOX_MEMORY}" =~ ^([1-9][0-9]*)(Mi|Gi)$ ]] \
  || { echo "gke-template: GKE_SANDBOX_MEMORY must look like 4Gi or 4096Mi, got '${GKE_SANDBOX_MEMORY}'" >&2; exit 1; }
# Autopilot allows 1-6.5 GiB per vCPU and adjusts anything outside that (more CPU, a bigger bill)
# rather than refusing it; the sandbox is 1 vCPU, so hold the value to that range here.
SANDBOX_MEMORY_MI="${BASH_REMATCH[1]}"
if [[ "${BASH_REMATCH[2]}" == "Gi" ]]; then SANDBOX_MEMORY_MI=$(( SANDBOX_MEMORY_MI * 1024 )); fi
(( SANDBOX_MEMORY_MI >= 1024 && SANDBOX_MEMORY_MI <= 6656 )) \
  || { echo "gke-template: GKE_SANDBOX_MEMORY must be 1Gi-6656Mi for a 1 vCPU sandbox, got '${GKE_SANDBOX_MEMORY}'" >&2; exit 1; }
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
export IMAGE GKE_NAMESPACE GKE_WARM_POOL KUBE_DNS_SERVICE_IP GKE_SANDBOX_MEMORY
envsubst '${IMAGE} ${GKE_NAMESPACE} ${KUBE_DNS_SERVICE_IP} ${GKE_SANDBOX_MEMORY}' \
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
elif is_kubectl_notfound "$(cat "${CURRENT_REPLICAS_ERR}")"; then
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
# deployer's Role only grants create/get/delete/list on sandboxclaims, not patch, and a
# one-off object that's never reapplied doesn't need server-side apply's merge semantics anyway.
#
# `app.kubernetes.io/managed-by: outfitter-release`, not `outfitter`: PR2's GkeProvider counts
# active sandboxes toward GKE_MAX_ACTIVE by listing claims labelled managed-by=outfitter
# (packages/api/src/providers/gke.ts's countActive) -- this claim must not eat into that budget.
#
# Best-effort, entirely: this is a nice-to-have that must never fail the release. A stale claim from
# an interrupted previous run (SIGKILL, or one still terminating) is cleaned up by label first, so
# it can't collide; the new claim itself uses generateName (not a fixed name), so even a concurrent
# or leftover claim can never cause AlreadyExists. A create failure (quota, a rejected admission,
# anything) just skips the rest of this section with a note.
echo "== Warming ${IMAGE} with a throwaway cold claim =="
# Every warm-up kubectl call carries --request-timeout: the loops below are bounded by count, but a
# single call to a hung API server otherwise isn't, and this section must never hang the release.
WARMUP_KUBECTL_TIMEOUT="--request-timeout=10s"
sweep_warmup_claims() {
  local stale claims
  claims="$(kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" "${WARMUP_KUBECTL_TIMEOUT}" \
    get sandboxclaims -l app.kubernetes.io/managed-by=outfitter-release,outfitter.dev/warmup=true -o name 2>/dev/null || true)"
  for stale in ${claims}; do
    kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" "${WARMUP_KUBECTL_TIMEOUT}" \
      delete "${stale}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
}
sweep_warmup_claims

WARMUP_CREATE_ERR="$(mktemp)"
register_cleanup "${WARMUP_CREATE_ERR}"
WARMUP_CLAIM=""
if WARMUP_CLAIM="$(cat <<YAML | kubectl --kubeconfig="${KUBECONFIG}" "${WARMUP_KUBECTL_TIMEOUT}" create -f - -o jsonpath='{.metadata.name}' 2>"${WARMUP_CREATE_ERR}"
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata:
  generateName: warmup-
  namespace: ${GKE_NAMESPACE}
  labels: { app.kubernetes.io/managed-by: outfitter-release, outfitter.dev/warmup: "true" }
spec:
  warmPoolRef: { name: ${GKE_WARM_POOL} }
  lifecycle: { shutdownPolicy: Delete, ttlSecondsAfterFinished: 60 }
  env:
    - { name: RUN_ID, value: "warmup-${TAG}" }
    - { name: RUN_TOKEN, value: "warmup" }
    - { name: OUTFITTER_API, value: "${OUTFITTER_LINK_ORIGIN}" }
YAML
)" && [[ -n "${WARMUP_CLAIM}" ]]; then
  echo "   created ${WARMUP_CLAIM}"
  register_cleanup_cmd "kubectl --kubeconfig='${KUBECONFIG}' -n '${GKE_NAMESPACE}' delete sandboxclaim '${WARMUP_CLAIM}' --ignore-not-found --wait=false >/dev/null 2>&1"

  # Bounded: a slow node/image pull here delays the release a little, never fails it -- the next
  # real wake just pays whatever wasn't warmed. First wait for the controller to assign a Sandbox,
  # then for that Sandbox to actually report Ready (image pulled, container started), not merely "a
  # name was assigned". register_cleanup_cmd above deletes the claim regardless of how this comes out.
  #
  # A plain bounded poll over `kubectl get`, not `kubectl wait --for=jsonpath=... ` with no
  # comparison value: that value-less form (wait for a field to merely exist/be non-empty, as
  # opposed to `--for=jsonpath=...=value`) is a newer kubectl feature, and this script has no way to
  # confirm which kubectl version `gcloud components install kubectl` puts on a given machine or CI
  # runner. `get` alone is universally supported and needs only the `get` verb (already granted),
  # not `list`/`watch` on sandboxclaims.
  WARMUP_POLL_INTERVAL_S="${WARMUP_POLL_INTERVAL_S:-2}"
  SANDBOX_NAME=""
  for _ in $(seq 1 30); do
    SANDBOX_NAME="$(kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" "${WARMUP_KUBECTL_TIMEOUT}" \
      get sandboxclaim "${WARMUP_CLAIM}" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)"
    [[ -n "${SANDBOX_NAME}" ]] && break
    sleep "${WARMUP_POLL_INTERVAL_S}"
  done
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
  kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" "${WARMUP_KUBECTL_TIMEOUT}" \
    delete sandboxclaim "${WARMUP_CLAIM}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
else
  echo "   note: couldn't create a warm-up claim (see below); skipping the warm-up entirely -- the next real wake pays the pull instead" >&2
  sed 's/^/   /' "${WARMUP_CREATE_ERR}" >&2
  # The server may have created the claim even though kubectl reported failure (a connection
  # dropped after the POST): sweep by label so it doesn't sit holding a sandbox until next release.
  sweep_warmup_claims
fi

# Only now: a failure above must leave the template unlabelled, so a re-run of this script (release
# retrying a failed step) doesn't see "already at this commit" and skip re-applying.
kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE}" \
  label sandboxtemplate outfitter-agent "build-commit=${TAG}" --overwrite

echo "== Done: SandboxTemplate/SandboxWarmPool at ${TAG} =="
