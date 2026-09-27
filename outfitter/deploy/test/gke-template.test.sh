#!/usr/bin/env bash
# gke-template.sh against a throwaway git repo (deploy_guard needs one, same setup as
# guards.test.sh) and fake gcloud/kubectl. No network, no GCP.
#
# The fake kubectl enforces exactly the RBAC ci-setup.sh grants outfitter-deployer for this
# namespace (get/create/patch on sandboxtemplates and sandboxwarmpools, create only for a missing
# object; get/create/delete/list on sandboxclaims -- no patch, so a regression to `apply` on a claim
# is caught; get/list/watch on sandboxes), denying anything else. That makes "the script only uses verbs it's actually granted"
# part of what this test checks, not just an assumption.
#   bash outfitter/deploy/test/gke-template.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SRC="$(cd "${HERE}/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
# Never touch the real home directory: env.sh's gke_kubeconfig defaults to ~/.kube/outfitter, and a
# case that reaches it without KUBECONFIG_OUTFITTER once truncated a developer's real one (#152).
export HOME="${WORK}/home"
mkdir -p "${HOME}"

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"${GCLOUD_CALLS}"
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "artifacts docker images describe"*)
    [[ -n "${FAKE_IMAGE_MISSING:-}" ]] && exit 1
    exit 0 ;;
  "projects get-iam-policy"*)
    [[ -n "${FAKE_AGENT_EXTRA_ROLES:-}" ]] && printf '%s\n' "${FAKE_AGENT_EXTRA_ROLES}"
    ;;
  "iam service-accounts get-iam-policy outfitter-agent@"*)
    printf 'roles/iam.serviceAccountUser,serviceAccount:outfitter-deployer@outfitter-509211.iam.gserviceaccount.com\n'
    printf 'roles/iam.serviceAccountUser,serviceAccount:outfitter-api@outfitter-509211.iam.gserviceaccount.com\n'
    printf 'roles/iam.workloadIdentityUser,serviceAccount:outfitter-509211.svc.id.goog[outfitter-sandboxes/outfitter-agent]\n'
    ${FAKE_EXTRA_SA_BINDING:+printf '%s\n' "${FAKE_EXTRA_SA_BINDING}"}
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

# Capture -f content (file or stdin): for RENDERED_LOG (envsubst checks) and to identify the piped
# object's kind, since a create/apply -f call names no resource type in its own arguments.
prev="" f_arg="" body=""
for a in "$@"; do
  [[ "${prev}" == "-f" ]] && f_arg="${a}"
  prev="${a}"
done
if [[ -n "${f_arg}" && "${f_arg}" != "-" && -f "${f_arg}" ]]; then
  body="$(cat "${f_arg}")"
  { printf '%s\n' "${body}"; echo "---"; } >>"${RENDERED_LOG}"
elif [[ "${f_arg}" == "-" ]]; then
  body="$(cat)"
  { printf '%s\n' "${body}"; echo "---"; } >>"${RENDERED_LOG}"
fi

resource=""
case "$*" in
  *sandboxtemplate*) resource=sandboxtemplates ;;
  *sandboxwarmpool*) resource=sandboxwarmpools ;;
  *sandboxclaim*) resource=sandboxclaims ;;
  *"get service"*) resource=services ;;
  *" sandbox/"*) resource=sandboxes ;;
esac
if [[ -z "${resource}" && -n "${body}" ]]; then
  case "${body}" in
    *"kind: SandboxClaim"*) resource=sandboxclaims ;;
    *"kind: SandboxTemplate"*) resource=sandboxtemplates ;;
    *"kind: SandboxWarmPool"*) resource=sandboxwarmpools ;;
  esac
fi

verb=""
case " $* " in
  *" apply "*)
    # A real apiserver authorizes `apply --server-side` against `create` when the target object
    # doesn't exist yet (the very first GKE release: neither the SandboxTemplate nor the pool has
    # been applied before) and against `patch` once it does. FAKE_FIRST_RELEASE simulates "doesn't
    # exist yet" for both, so a test can prove the Role's `create` verb is what makes that work.
    if [[ -n "${FAKE_FIRST_RELEASE:-}" && ( "${resource}" == sandboxtemplates || "${resource}" == sandboxwarmpools ) ]]; then
      verb=create
    else
      verb=patch
    fi
    ;;
  *" create "*) verb=create ;;
  *" patch "*) verb=patch ;;
  *" delete "*) verb=delete ;;
  *" label "*) verb=patch ;;   # kubectl label issues a patch
  *" wait "*) verb=watch ;;
  *" get "*) verb=get ;;
esac

deny() {
  echo "Error from server (Forbidden): ${resource:-<unknown>} is forbidden: User \"outfitter-deployer\" cannot ${verb:-<unknown>} resource \"${resource:-<unknown>}\"" >&2
  exit 1
}
case "${resource}:${verb}" in
  sandboxtemplates:get | sandboxtemplates:patch) ;;
  sandboxtemplates:create) [[ -z "${FAKE_ROLE_NO_CREATE:-}" ]] || deny ;;
  sandboxwarmpools:get | sandboxwarmpools:patch) ;;
  sandboxwarmpools:create) [[ -z "${FAKE_ROLE_NO_CREATE:-}" ]] || deny ;;
  sandboxclaims:get | sandboxclaims:create | sandboxclaims:delete | sandboxclaims:list) ;;
  sandboxes:get | sandboxes:list | sandboxes:watch) ;;
  services:get) ;;
  *) deny ;;
esac

# Glob patterns below check substrings without relying on their relative order in "$*" (a `case`
# pattern like *A*B* only matches when A appears before B, which the real argument order doesn't
# always agree with) -- an [[ ]] with separate * tests instead.
case "$*" in
  *"-n kube-system get service kube-dns"*) printf '%s' "${FAKE_KUBE_DNS_IP:-10.1.2.3}" ;;
  *"get sandboxwarmpool"*)
    [[ -n "${FAKE_POOL_MISSING:-}" ]] && { echo "Error from server (NotFound)" >&2; exit 1; }
    [[ -n "${FAKE_POOL_READ_FAILS:-}" ]] && { echo "Error from server (InternalError): etcd timeout" >&2; exit 1; }
    printf '%s' "${FAKE_CURRENT_REPLICAS:-0}"
    ;;
  *"get sandboxclaims -l"*"warmup=true"*)
    [[ -n "${FAKE_STALE_WARMUPS:-}" ]] && printf '%s\n' "${FAKE_STALE_WARMUPS}"
    ;;
esac
if [[ "$*" == *"create -f -"* && "$*" == *"jsonpath={.metadata.name}"* ]]; then
  if [[ -n "${FAKE_WARMUP_CREATE_FAILS:-}" ]]; then
    echo "Error from server (Forbidden): quota exceeded" >&2
    exit 1
  fi
  printf '%s' "${FAKE_WARMUP_NAME:-warmup-fakeabc123}"
  exit 0
fi
case "$*" in
  *"get sandboxclaim "*"jsonpath={.status.sandbox.name}"*)
    [[ -n "${FAKE_NO_SANDBOX_ASSIGNED:-}" ]] || printf '%s' "${FAKE_SANDBOX_NAME:-warmup-sandbox-1}"
    ;;
  *"wait --for=condition=Ready sandbox/"*)
    [[ -n "${FAKE_SANDBOX_NOT_READY:-}" ]] && exit 1
    ;;
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
  KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" WARMUP_POLL_INTERVAL_S=0
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
  FAKE_JOB_LABELS="build-commit=${TAG}" FAKE_IMAGE_MISSING=1 \
  expect fail "a standalone run with no built image refuses" "doesn't exist in Artifact Registry"

FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" \
  expect fail "an unexpected binding on outfitter-agent@'s own IAM policy refuses" \
  "unexpected bindings" FAKE_EXTRA_SA_BINDING="roles/iam.serviceAccountTokenCreator,user:someone@example.com"

FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" \
  expect fail "outfitter-link not deployed refuses" "outfitter-link is not deployed" \
  FAKE_LINK_ORIGIN=

FAKE_WEB_LABELS="build-commit=old000000001" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" \
  expect fail "a mismatched web deploy refuses (check_deploy_skew)" "outfitter-api (web) is at old000000001"

FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" \
  expect fail "a pool-replica read error other than NotFound refuses, never falls back to 0" \
  "could not read outfitter-agent's current replicas" FAKE_POOL_READ_FAILS=1
if grep -q '"replicas":0' "${KUBECTL_CALLS}"; then
  echo "FAIL:   a pool read error must never result in a replicas:0 patch"; fails=$((fails + 1))
else
  echo "ok:   ... and no replicas:0 patch was sent"
fi

FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" \
  expect fail "#187: a malformed GKE_SANDBOX_MEMORY refuses before touching the cluster" \
  "GKE_SANDBOX_MEMORY must look like 4Gi" GKE_SANDBOX_MEMORY="4 GB"
if [[ -s "${KUBECTL_CALLS}" ]]; then
  echo "FAIL:   a bad GKE_SANDBOX_MEMORY must not reach kubectl"; fails=$((fails + 1))
else
  echo "ok:   ... and kubectl was never called"
fi

FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" FAKE_CURRENT_REPLICAS=2 \
  expect pass "happy path applies the template and pool, warms up, and labels build-commit" \
  "Done: SandboxTemplate/SandboxWarmPool at ${TAG}"

echo "== rendered content =="
grep -q "image: us-central1-docker.pkg.dev/outfitter-509211/outfitter/outfitter-agent:${TAG}" "${RENDERED_LOG}" \
  && echo "ok: the image tag is this commit's TAG" \
  || { echo "FAIL: expected the rendered image to carry ${TAG}"; fails=$((fails + 1)); }
grep -q "cidr: 10.1.2.3/32" "${RENDERED_LOG}" \
  && echo "ok: the cluster's kube-dns Service IP was read live and substituted, not hard-coded" \
  || { echo "FAIL: expected 10.1.2.3/32 (kube-dns) in the rendered network policy"; fails=$((fails + 1)); }
grep -q "namespace: outfitter-sandboxes" "${RENDERED_LOG}" \
  && echo "ok: GKE_NAMESPACE was substituted" \
  || { echo "FAIL: expected namespace: outfitter-sandboxes in the rendered YAML"; fails=$((fails + 1)); }
[[ "$(grep -c 'memory: 4Gi,' "${RENDERED_LOG}")" == 2 ]] \
  && echo "ok: #187: sandbox memory defaults to 4Gi, requests and limits alike" \
  || { echo "FAIL: expected memory: 4Gi in both requests and limits"; grep -n "memory:" "${RENDERED_LOG}" | sed 's/^/    /'; fails=$((fails + 1)); }
if grep -qE '\$\{[A-Z_][A-Z0-9_]*\}' "${RENDERED_LOG}"; then
  echo "FAIL: a template placeholder was left unrendered:"; grep -nE '\$\{[A-Z_][A-Z0-9_]*\}' "${RENDERED_LOG}" | sed 's/^/    /'
  fails=$((fails + 1))
else
  echo "ok: no \${VAR} placeholder was left unrendered"
fi

# env_name_collides <text> -- true if <text> defines OUTFITTER_API/RUN_ID/RUN_TOKEN as a `name:`
# key, in either YAML flow style (`{ name: OUTFITTER_API, value: ... }`, the comma or brace
# immediately after) or block style (`- name: OUTFITTER_API` on its own line, nothing after but
# whitespace).
env_name_collides() {
  grep -qE 'name: (OUTFITTER_API|RUN_ID|RUN_TOKEN)( ?[,}]|[[:space:]]*$)' <<<"$1"
}
# Low (review round 2): prove the check above actually catches block style, not only flow style --
# a regex that only matched `name: X,`/`name: X}` would silently pass a block-style regression.
if env_name_collides "$(printf '  env:\n    - name: OUTFITTER_API\n      value: x\n')"; then
  echo "ok: env_name_collides also catches block-style YAML (- name: OUTFITTER_API on its own line)"
else
  echo "FAIL: env_name_collides missed a block-style '- name: OUTFITTER_API'"; fails=$((fails + 1))
fi

# RENDERED_LOG also holds the warm-up SandboxClaim's own piped body (which legitimately sets these
# three as claim env) -- check only the first "---"-delimited section, the rendered
# sandbox-template.yaml file itself.
RENDERED_TEMPLATE_ONLY="$(awk '/^---$/{exit} {print}' "${RENDERED_LOG}")"
if env_name_collides "${RENDERED_TEMPLATE_ONLY}"; then
  echo "FAIL: the rendered SandboxTemplate defines OUTFITTER_API/RUN_ID/RUN_TOKEN as a static env var -- a cold claim setting the same name is REJECTED by agent-sandbox's Allowed injection policy"
  fails=$((fails + 1))
else
  echo "ok: the rendered template's env names don't collide with the claim's (OUTFITTER_API/RUN_ID/RUN_TOKEN)"
fi

if grep -q '"replicas":2' "${KUBECTL_CALLS}"; then
  echo "ok: the pool's existing replicas (2) were preserved through the reapply"
else
  echo "FAIL: expected a patch restoring replicas to 2"; fails=$((fails + 1))
fi

if grep -q "create -f -" "${KUBECTL_CALLS}"; then
  echo "ok: the warm-up claim is created with 'kubectl create', not 'apply' (the deployer's Role has no patch on sandboxclaims)"
else
  echo "FAIL: expected 'kubectl create -f -' for the warm-up claim"; fails=$((fails + 1))
fi

if grep -q "delete sandboxclaim warmup-fakeabc123" "${KUBECTL_CALLS}"; then
  echo "ok: the warm-up claim was deleted"
else
  echo "FAIL: expected the warm-up claim to be deleted"; fails=$((fails + 1))
fi

# head -1: the registered EXIT-trap cleanup also deletes the claim again (harmless,
# --ignore-not-found) once this whole test process exits, adding a second "delete" line later in
# the same call log -- only the first (in-script) occurrence matters for ordering here.
LABEL_LINE="$(grep -n "label sandboxtemplate outfitter-agent build-commit=${TAG}" "${KUBECTL_CALLS}" | head -1 | cut -d: -f1 || true)"
DELETE_LINE="$(grep -n "delete sandboxclaim warmup-fakeabc123" "${KUBECTL_CALLS}" | head -1 | cut -d: -f1 || true)"
if [[ -n "${LABEL_LINE}" && -n "${DELETE_LINE}" && "${LABEL_LINE}" -gt "${DELETE_LINE}" ]]; then
  echo "ok: the build-commit label is applied LAST, after the pool patch and the warm-up"
else
  echo "FAIL: expected the build-commit label (line ${LABEL_LINE:-?}) after the warm-up delete (line ${DELETE_LINE:-?})"
  fails=$((fails + 1))
fi

# HIGH (review round 2): a real apiserver authorizes `apply --server-side` on a not-yet-existing
# object against `create`, not `patch` -- the very first GKE release applies a SandboxTemplate and
# SandboxWarmPool that have never existed before. ci-setup.sh's Role must grant `create` on both, or
# the first release fails outright.
FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" FAKE_FIRST_RELEASE=1 FAKE_POOL_MISSING=1 \
  expect pass "the first release (neither object exists yet) succeeds: the Role grants create" \
  "Done: SandboxTemplate/SandboxWarmPool at ${TAG}"

FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" FAKE_FIRST_RELEASE=1 FAKE_POOL_MISSING=1 FAKE_ROLE_NO_CREATE=1 \
  expect fail "... and fails if the Role's create verb is removed" "Forbidden"

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
  FAKE_JOB_LABELS="build-commit=${TAG}" FAKE_NO_SANDBOX_ASSIGNED=1 \
  expect pass "a warm-up claim that never gets a Sandbox assigned still finishes" \
  "never got a Sandbox assigned within 60s"

FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" FAKE_SANDBOX_NOT_READY=1 \
  expect pass "a Sandbox that never reports Ready still finishes (next real wake pays the pull)" \
  "didn't report Ready within 120s"

# Medium (review round 2): a stale warm-up claim (left by an interrupted previous run) is cleaned up
# by label before creating a new one, and a failed create (quota, AlreadyExists, anything) is
# best-effort -- it must never fail the release.
FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" FAKE_STALE_WARMUPS="sandboxclaim/warmup-stale1" \
  expect pass "a stale warm-up claim is deleted by label before creating a new one" \
  "Done: SandboxTemplate/SandboxWarmPool at ${TAG}"
if grep -q "delete sandboxclaim/warmup-stale1" "${KUBECTL_CALLS}"; then
  echo "ok:   ... and the stale claim was deleted"
else
  echo "FAIL:   expected the stale claim (sandboxclaim/warmup-stale1) to be deleted"; fails=$((fails + 1))
fi

FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" FAKE_WARMUP_CREATE_FAILS=1 \
  expect pass "a failed warm-up claim create is best-effort and never fails the release" \
  "couldn't create a warm-up claim"
if grep -q "wait " "${KUBECTL_CALLS}"; then
  echo "FAIL:   expected no wait calls after a failed create"; fails=$((fails + 1))
else
  echo "ok:   ... and no wait calls were made (nothing to wait on)"
fi

# #187: a non-default size renders as given, and one outside Autopilot's 1 vCPU range is refused.
FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
  FAKE_JOB_LABELS="build-commit=${TAG}" FAKE_CURRENT_REPLICAS=2 \
  expect pass "#187: GKE_SANDBOX_MEMORY=3072Mi renders into requests and limits" \
  "Done: SandboxTemplate/SandboxWarmPool at ${TAG}" GKE_SANDBOX_MEMORY=3072Mi
[[ "$(grep -c 'memory: 3072Mi,' "${RENDERED_LOG}")" == 2 ]] \
  && echo "ok: #187: a non-default sandbox memory is substituted, requests and limits alike" \
  || { echo "FAIL: expected memory: 3072Mi in both requests and limits"; grep -n "memory:" "${RENDERED_LOG}" | sed 's/^/    /'; fails=$((fails + 1)); }
for too in 512Mi 8Gi; do
  FAKE_WEB_LABELS="build-commit=${TAG}" FAKE_LINK_LABELS="build-commit=${TAG}" \
    FAKE_JOB_LABELS="build-commit=${TAG}" \
    expect fail "#187: GKE_SANDBOX_MEMORY=${too} is outside 1Gi-6656Mi and refused before touching the cluster" \
    "must be 1Gi-6656Mi for a 1 vCPU sandbox" GKE_SANDBOX_MEMORY="${too}"
  if [[ -s "${KUBECTL_CALLS}" ]]; then
    echo "FAIL:   an out-of-range GKE_SANDBOX_MEMORY must not reach kubectl"; fails=$((fails + 1))
  fi
done

echo "${fails} failed"
[[ "${fails}" -eq 0 ]]
