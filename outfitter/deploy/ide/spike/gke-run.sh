#!/usr/bin/env bash
# Browser IDE spike, GKE half (issue #240). Owner-run: it creates a throwaway SandboxTemplate, warm
# pool (replicas 0), ConfigMap and one claim in outfitter-sandboxes on the production cluster, then
# deletes them all on exit. It reads the live outfitter-agent template only to copy its image.
#
#   DRY_RUN=1 deploy/ide/spike/gke-run.sh     # print what it would apply; changes nothing
#   deploy/ide/spike/gke-run.sh [phase_seconds]   # default 120; about 20 minutes in all
#
# Needs: ~/.kube/outfitter (deploy/gke-cluster.sh) and gcloud configuration `outfitter`. The harness
# runs inside the pod with the image's own Playwright, so nothing runs a browser on this machine.
# Writes: gke-pod.jsonl (install timing, memory every 15 s), s3-results-gke.json, s4-results-gke.jsonl.
set -euo pipefail
cd "$(dirname "$0")"
PHASE_S=${1:-120}
export CLOUDSDK_ACTIVE_CONFIG_NAME=outfitter
K=(kubectl --kubeconfig "$HOME/.kube/outfitter" -n outfitter-sandboxes)
CLAIM="ide-spike-$(date +%s)"

IMAGE=$("${K[@]}" get sandboxtemplate outfitter-agent -o jsonpath='{.spec.podTemplate.spec.containers[0].image}')
[[ -n "$IMAGE" ]] || { echo "couldn't read the outfitter-agent template's image" >&2; exit 1; }
echo "image: $IMAGE"

CM=$("${K[@]}" create configmap ide-spike-scripts --from-file=install.sh --from-file=run-in-pod.sh \
  --from-file=machine-settings.json --from-file=harness.mjs \
  --from-file=preview-proxy.ts=../../../packages/agentd/src/preview-proxy.ts --dry-run=client -o yaml)
TEMPLATE=$(IMAGE="$IMAGE" PHASE_S="$PHASE_S" envsubst '${IMAGE} ${PHASE_S}' < gke-ide.yaml)
CLAIM_YAML="apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata: { name: $CLAIM, namespace: outfitter-sandboxes }
spec:
  warmPoolRef: { name: ide-spike }
  lifecycle: { shutdownPolicy: Delete }"

if [[ -n "${DRY_RUN:-}" ]]; then
  printf -- '--- would apply:\n%s\n---\n%s\n---\n%s\n' "$CM" "$TEMPLATE" "$CLAIM_YAML"
  exit 0
fi

LOG_PID=""
cleanup() {
  [[ -n "$LOG_PID" ]] && kill "$LOG_PID" 2>/dev/null || true
  "${K[@]}" delete sandboxclaim "$CLAIM" --ignore-not-found --wait=false >/dev/null || true
  "${K[@]}" delete sandboxwarmpool ide-spike --ignore-not-found >/dev/null || true
  "${K[@]}" delete sandboxtemplate ide-spike --ignore-not-found >/dev/null || true
  "${K[@]}" delete configmap ide-spike-scripts --ignore-not-found >/dev/null || true
  echo "cleaned up"
}
trap cleanup EXIT

echo "$CM" | "${K[@]}" apply -f - >/dev/null
echo "$TEMPLATE" | "${K[@]}" apply -f - >/dev/null
t0=$(date +%s)
echo "$CLAIM_YAML" | "${K[@]}" create -f - >/dev/null

POD=""
until [[ -n "$POD" ]]; do
  sleep 2
  POD=$("${K[@]}" get pods -l app=ide-spike -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' 2>/dev/null || true)
  (( $(date +%s) - t0 > 600 )) && { echo "no running pod after 10 minutes" >&2; "${K[@]}" get pods -l app=ide-spike; exit 1; }
done
echo "pod $POD running after $(( $(date +%s) - t0 )) s"

: > gke-pod.jsonl
"${K[@]}" logs -f "$POD" >> gke-pod.jsonl 2>&1 &
LOG_PID=$!
until grep -q '"ready"' gke-pod.jsonl; do
  sleep 3
  grep -qE 'checksum mismatch|unsupported arch|Error from server' gke-pod.jsonl && { cat gke-pod.jsonl; exit 1; }
  (( $(date +%s) - t0 > 900 )) && { echo "code-server not ready after 15 minutes" >&2; cat gke-pod.jsonl; exit 1; }
done
grep -E '"installed"|"listening"' gke-pod.jsonl
echo "harness running in the pod (about $(( PHASE_S * 6 / 60 + 3 )) minutes)..."
until grep -q '"event":"done"' gke-pod.jsonl; do
  sleep 10
  (( $(date +%s) - t0 > 2600 )) && { echo "harness didn't finish" >&2; tail -20 gke-pod.jsonl; exit 1; }
done
# Split the pod log into the result files.
awk '/^=== s3-results-gke.json/ {f="s3-results-gke.json"; next} /^=== s4-results-gke.jsonl/ {f="s4-results-gke.jsonl"; next}
     /^=== / {f=""; next} f {print > f}' gke-pod.jsonl
sed -n '/^=== harness.log/,/^=== s3-results/p' gke-pod.jsonl | grep -E '^s3\.|headless|Error' || true
echo "results: gke-pod.jsonl s3-results-gke.json s4-results-gke.jsonl"
