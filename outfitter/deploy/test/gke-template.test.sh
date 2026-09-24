#!/usr/bin/env bash
# gke-template.sh against a throwaway git repo (deploy_guard needs one, same setup as
# guards.test.sh) and fake gcloud/kubectl. No network, no GCP.
#   bash outfitter/deploy/test/gke-template.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SRC="$(cd "${HERE}/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"${GCLOUD_CALLS}"
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "projects get-iam-policy"*)
    [[ -n "${FAKE_AGENT_EXTRA_ROLES:-}" ]] && printf '%s\n' "${FAKE_AGENT_EXTRA_ROLES}"
    ;;
  "container clusters get-credentials"*) : >"${KUBECONFIG}" ;;
  *"run services describe outfitter-link"*"OUTFITTER_ORIGIN"*)
    printf '%s\n' "${FAKE_LINK_ORIGIN:-}" ;;
  *"--format=value(metadata.labels)"*)
    case "$*" in
      *outfitter-api*) printf '%s\n' "${FAKE_WEB_LABELS:-}" ;;
      *outfitter-link*) printf '%s\n' "${FAKE_LINK_LABELS:-}" ;;
      *outfitter-agent*) printf '%s\n' "${FAKE_JOB_LABELS:-}" ;;
    esac
    ;;
  "run services describe"*) exit 0 ;;
  "run jobs describe"*) exit 0 ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/gcloud"

cat >"${WORK}/bin/kubectl" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"${KUBECTL_CALLS}"
prev="" f_arg=""
for a in "$@"; do
  [[ "${prev}" == "-f" ]] && f_arg="${a}"
  prev="${a}"
done
if [[ -n "${f_arg}" && "${f_arg}" != "-" && -f "${f_arg}" ]]; then
  { cat "${f_arg}"; echo "---"; } >>"${RENDERED_LOG}"
elif [[ "${f_arg}" == "-" ]]; then
  { cat; echo "---"; } >>"${RENDERED_LOG}"
fi
case "$*" in
  *"-n kube-system get service kube-dns"*) printf '%s' "${FAKE_KUBE_DNS_IP:-10.1.2.3}" ;;
  *"get sandboxwarmpool"*)
    [[ -n "${FAKE_POOL_MISSING:-}" ]] && { echo "Error from server (NotFound)" >&2; exit 1; }
    printf '%s' "${FAKE_CURRENT_REPLICAS:-0}"
    ;;
  *"wait --for="*"sandboxclaim/"*) [[ -n "${FAKE_WAIT_FAILS:-}" ]] && exit 1 ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/kubectl"

# A throwaway repo with its own "origin" (deploy_guard's committed-main checks), same shape as
# guards.test.sh: outfitter/deploy holds this PR's scripts, kernal/ and outfitter/ both exist and
# are clean.
git init -q --bare "${WORK}/origin.git"
git clone -q "${WORK}/origin.git" "${WORK}/repo" 2>/dev/null
REPO="${WORK}/repo"
git -C "${REPO}" config user.email t@example.com
git -C "${REPO}" config user.name test
git -C "${REPO}" checkout -q -b main
mkdir -p "${REPO}/outfitter/deploy/gke" "${REPO}/kernal"
cp "${DEPLOY_SRC}/env.sh" "${DEPLOY_SRC}/config.env" "${DEPLOY_SRC}/gke-template.sh" "${REPO}/outfitter/deploy/"
cp "${DEPLOY_SRC}/gke/sandbox-template.yaml" "${DEPLOY_SRC}/gke/warm-pool.yaml" "${REPO}/outfitter/deploy/gke/"
echo k >"${REPO}/kernal/k.txt"
git -C "${REPO}" add -A && git -C "${REPO}" commit -q -m one
git -C "${REPO}" push -q origin main
TAG="$(git -C "${REPO}" rev-parse --short=12 HEAD)"

export PATH="${WORK}/bin:${PATH}"
export GCLOUD_CALLS="${WORK}/gcloud-calls" KUBECTL_CALLS="${WORK}/kubectl-calls" \
  RENDERED_LOG="${WORK}/rendered-log" GKE_CLUSTER=outfitter FAKE_LINK_ORIGIN=https://link.example.com \
  KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter"
unset GITHUB_ACTIONS ROLLBACK ALLOW_OFF_MAIN ALLOW_SKEW DEPLOY_ALL_COMMIT

fails=0
OUT=""
# run_it [env=val ...] -- runs gke-template.sh from the fake repo's outfitter/deploy.
run_it() {
  (cd "${REPO}/outfitter/deploy" && env "$@" ./gke-template.sh)
}
expect() {
  local want="$1" desc="$2" pattern="$3"
  shift 3
  : >"${GCLOUD_CALLS}"; : >"${KUBECTL_CALLS}"; : >"${RENDERED_LOG}"
  local status=0
  OUT="$(run_it "$@" 2>&1)" || status=$?
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

expect pass "GKE off: nothing to do" "GKE_CLUSTER is empty" GKE_CLUSTER=

FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" \
  expect fail "outfitter-link not deployed refuses" "outfitter-link is not deployed" \
  FAKE_LINK_ORIGIN=

FAKE_WEB_LABELS="build-commit=old000000001" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" \
  expect fail "a mismatched web deploy refuses (check_deploy_skew)" "outfitter-api (web) is at old000000001"

FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" FAKE_CURRENT_REPLICAS=2 \
  expect pass "happy path applies the template and pool, warms up, and labels build-commit" \
  "Done: SandboxTemplate/SandboxWarmPool at ${TAG}"

echo "== rendered content =="
grep -q "image: us-central1-docker.pkg.dev/outfitter-509211/outfitter/outfitter-agent:${TAG}" "${RENDERED_LOG}" \
  && echo "ok: the image tag is this commit's TAG" \
  || { echo "FAIL: expected the rendered image to carry ${TAG}"; fails=$((fails + 1)); }
grep -q 'value: "https://link.example.com"' "${RENDERED_LOG}" \
  && echo "ok: OUTFITTER_LINK_ORIGIN was substituted" \
  || { echo "FAIL: expected https://link.example.com in the rendered template"; fails=$((fails + 1)); }
grep -q "cidr: 10.1.2.3/32" "${RENDERED_LOG}" \
  && echo "ok: the cluster's kube-dns Service IP was read live and substituted, not hard-coded" \
  || { echo "FAIL: expected 10.1.2.3/32 (kube-dns) in the rendered network policy"; fails=$((fails + 1)); }
grep -q "namespace: outfitter-sandboxes" "${RENDERED_LOG}" \
  && echo "ok: GKE_NAMESPACE was substituted" \
  || { echo "FAIL: expected namespace: outfitter-sandboxes in the rendered YAML"; fails=$((fails + 1)); }

if grep -q '"replicas":2' "${KUBECTL_CALLS}"; then
  echo "ok: the pool's existing replicas (2) were preserved through the reapply"
else
  echo "FAIL: expected a patch restoring replicas to 2"; fails=$((fails + 1))
fi

if grep -q "label sandboxtemplate outfitter-agent build-commit=${TAG}" "${KUBECTL_CALLS}"; then
  echo "ok: the template was labelled with this release's build-commit"
else
  echo "FAIL: expected a build-commit label matching ${TAG}"; fails=$((fails + 1))
fi

if grep -q "delete sandboxclaim warmup-${TAG}" "${KUBECTL_CALLS}"; then
  echo "ok: the warm-up claim was deleted afterwards"
else
  echo "FAIL: expected the warm-up claim to be deleted"; fails=$((fails + 1))
fi

FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" FAKE_POOL_MISSING=1 \
  expect pass "a brand-new pool (no current replicas) defaults to 0" \
  "Done: SandboxTemplate/SandboxWarmPool at ${TAG}"
if grep -q '"replicas":0' "${KUBECTL_CALLS}"; then
  echo "ok:   ... patched to 0"
else
  echo "FAIL:   expected a patch to replicas:0"; fails=$((fails + 1))
fi

FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" FAKE_WAIT_FAILS=1 \
  expect pass "a warm-up claim that never reports Ready still finishes (next real wake pays the pull)" \
  "didn't report a Sandbox within 120s"

echo "${fails} failed"
[[ "${fails}" -eq 0 ]]
