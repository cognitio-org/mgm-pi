#!/usr/bin/env bash
# Browser IDE spike, GKE half (issue #240). Owner-run: it creates a throwaway SandboxTemplate, warm
# pool (replicas 0), ConfigMap and one claim in outfitter-sandboxes on the production cluster, then
# deletes them all on exit. It reads the live outfitter-agent template only to copy its image.
#
#   DRY_RUN=1 deploy/ide/spike/gke-run.sh     # print what it would apply; changes nothing
#   deploy/ide/spike/gke-run.sh [phase_seconds]   # default 120; about 20 minutes in all
#
# Needs: ~/.kube/outfitter (deploy/gke-cluster.sh), gcloud configuration `outfitter`, node, and
# CHROMIUM pointing at a Chromium/Chrome binary if playwright-core's own isn't installed.
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
  --from-file=machine-settings.json --dry-run=client -o yaml)
TEMPLATE=$(IMAGE="$IMAGE" envsubst '${IMAGE}' < gke-ide.yaml)
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

PF_PID=""; LOG_PID=""
cleanup() {
  [[ -n "$PF_PID" ]] && kill "$PF_PID" 2>/dev/null || true
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

# S3 under gVisor, through agentd's proxy (Origin kept) on this laptop, over a port-forward.
"${K[@]}" port-forward "pod/$POD" 18081:8080 >/dev/null 2>&1 &
PF_PID=$!
sleep 3
curl -fsS -o /dev/null -w "port-forward: HTTP %{http_code}\n" http://127.0.0.1:18081/ || {
  echo "port-forward to the gVisor pod failed; see README 'If port-forward fails'" >&2; exit 1; }

RESULTS_TAG=gke IDE_EXEC="${K[*]} exec $POD --" node harness.mjs --target 18081 --phase-seconds "$PHASE_S"
echo "results: gke-pod.jsonl s3-results-gke.json s4-results-gke.jsonl"
