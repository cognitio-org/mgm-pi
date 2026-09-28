#!/usr/bin/env bash
# Browser IDE spike S1 (issue #240): cold-start cost of baking code-server into the agent image.
# Owner-run: pushes one spike tag to Artifact Registry and makes throwaway cold claims in
# outfitter-sandboxes, like gke-spike.md S4, for the production image and for production + code-server.
#
#   DRY_RUN=1 deploy/ide/spike/s1-run.sh
#   deploy/ide/spike/s1-run.sh [rounds]     # default 5 per image
#
# Writes s1-prod.jsonl and s1-baked.jsonl (deploy/gke/spike/s4_measure.py's output format).
# Compare the first round of the baked image (its tag's first pull) with gke-spike.md S4's 28.4 s,
# and the rest (node up, image cached or streamed) with the production rounds.
set -euo pipefail
cd "$(dirname "$0")"
ROUNDS=${1:-5}
export CLOUDSDK_ACTIVE_CONFIG_NAME=outfitter
K=(kubectl --kubeconfig "$HOME/.kube/outfitter" -n outfitter-sandboxes)
BASE=$("${K[@]}" get sandboxtemplate outfitter-agent -o jsonpath='{.spec.podTemplate.spec.containers[0].image}')
BAKED="${BASE%:*}:ide-spike-s1-$(date +%Y%m%d%H%M)"
echo "base:  $BASE"; echo "baked: $BAKED"

if [[ -n "${DRY_RUN:-}" ]]; then
  echo "would: build Dockerfile.s1 for linux/amd64 FROM the base, push $BAKED,"
  echo "       then $ROUNDS cold rounds each of base and baked via s4_measure.py, then delete both templates."
  exit 0
fi

[[ -f code-server-4.139.1-linux-amd64.tar.gz ]] || curl -fsSL -o code-server-4.139.1-linux-amd64.tar.gz \
  https://github.com/coder/code-server/releases/download/v4.139.1/code-server-4.139.1-linux-amd64.tar.gz
echo "53029be6c5781b7bca49b815fcc9a2a3fc111813ad8c9965b2c0f0d2985a0674  code-server-4.139.1-linux-amd64.tar.gz" | shasum -a 256 -c -
gcloud --configuration=outfitter auth print-access-token | docker login -u oauth2accesstoken --password-stdin https://us-central1-docker.pkg.dev >/dev/null
docker buildx build --platform linux/amd64 --build-arg BASE="$BASE" -f Dockerfile.s1 -t "$BAKED" --push .

measure() { # <name> <image> <out>
  local name=$1 image=$2 out=$3 tmpl tool
  tmpl=$(sed -e "s/s4-coldstart/$name/g" -e "s|image: .*outfitter-agent:.*|image: $image|" ../../gke/spike/s4.yaml)
  tool=$(mktemp); sed "s/s4-coldstart/$name/g" ../../gke/spike/s4_measure.py > "$tool"
  echo "$tmpl" | "${K[@]}" apply -f - >/dev/null
  python3 "$tool" "$ROUNDS" | tee "$out"
  "${K[@]}" delete sandboxwarmpool "$name" --ignore-not-found >/dev/null
  "${K[@]}" delete sandboxtemplate "$name" --ignore-not-found >/dev/null
  rm -f "$tool"
}
trap 'for n in ide-s1-prod ide-s1-baked; do "${K[@]}" delete sandboxwarmpool,sandboxtemplate "$n" --ignore-not-found >/dev/null 2>&1 || true; done' EXIT
measure ide-s1-prod "$BASE" s1-prod.jsonl
measure ide-s1-baked "$BAKED" s1-baked.jsonl
echo "done. The spike tag $BAKED can be deleted from Artifact Registry afterwards:"
echo "  gcloud --configuration=outfitter artifacts docker images delete $BAKED --quiet"
