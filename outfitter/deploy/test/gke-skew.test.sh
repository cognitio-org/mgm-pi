#!/usr/bin/env bash
# env.sh's GKE helpers (gke_kubeconfig, current_build_commit_gke, assert_agent_sa_logwriter_only,
# and check_deploy_skew's gke-template branch) against fake gcloud/kubectl, always sourcing the real
# env.sh. No network, no GCP.
#   bash outfitter/deploy/test/gke-skew.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${HERE}/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"${GCLOUD_CALLS}"
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "container clusters get-credentials"*)
    [[ -n "${FAIL_GET_CREDENTIALS:-}" ]] && { echo "ERROR: not found" >&2; exit 1; }
    : >"${KUBECONFIG}" ;;
  "projects get-iam-policy"*)
    [[ -n "${FAIL_IAM_POLICY:-}" ]] && { echo "PERMISSION_DENIED" >&2; exit 1; }
    [[ -n "${FAKE_AGENT_EXTRA_ROLES:-}" ]] && printf '%s\n' "${FAKE_AGENT_EXTRA_ROLES}"
    ;;
  "iam service-accounts get-iam-policy outfitter-agent@"*)
    [[ -n "${FAIL_SA_POLICY:-}" ]] && { echo "PERMISSION_DENIED" >&2; exit 1; }
    printf 'roles/iam.serviceAccountUser,serviceAccount:outfitter-deployer@outfitter-509211.iam.gserviceaccount.com\n'
    printf 'roles/iam.serviceAccountUser,serviceAccount:outfitter-api@outfitter-509211.iam.gserviceaccount.com\n'
    printf 'roles/iam.workloadIdentityUser,serviceAccount:outfitter-509211.svc.id.goog[outfitter-sandboxes/outfitter-agent]\n'
    if [[ -n "${FAKE_EXTRA_SA_BINDING:-}" ]]; then printf '%s\n' "${FAKE_EXTRA_SA_BINDING}"; fi
    ;;
  *"run services describe"*"--format=value(metadata.labels)"*)
    case "$*" in
      *outfitter-api*) printf '%s\n' "${FAKE_WEB_LABELS:-}" ;;
      *outfitter-link*) printf '%s\n' "${FAKE_LINK_LABELS:-}" ;;
    esac
    ;;
  *"run jobs describe"*"--format=value(metadata.labels)"*) printf '%s\n' "${FAKE_JOB_LABELS:-}" ;;
  "run services describe"*) exit "${FAKE_SERVICE_DESCRIBE_EXIT:-0}" ;;
  "run jobs describe"*) exit "${FAKE_JOB_DESCRIBE_EXIT:-0}" ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/gcloud"

cat >"${WORK}/bin/kubectl" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"${KUBECTL_CALLS}"
case "$*" in
  *"get sandboxtemplate outfitter-agent"*)
    [[ -n "${FAKE_TEMPLATE_MISSING:-}" ]] && { echo "Error from server (NotFound)" >&2; exit 1; }
    [[ -n "${FAKE_TEMPLATE_READ_FAILS:-}" ]] && { echo "Error from server (Forbidden): outfitter-deployer cannot get sandboxtemplates" >&2; exit 1; }
    [[ -n "${FAKE_AUTH_PLUGIN_MISSING:-}" ]] && { echo 'Unable to connect to the server: getting credentials: exec: executable gke-gcloud-auth-plugin not found' >&2; exit 1; }
    printf '%s' "${FAKE_TEMPLATE_COMMIT:-}"
    ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/kubectl"

export PATH="${WORK}/bin:${PATH}"
export GCLOUD_CALLS="${WORK}/gcloud-calls" KUBECTL_CALLS="${WORK}/kubectl-calls"
unset GITHUB_ACTIONS FAIL_GET_CREDENTIALS FAIL_IAM_POLICY FAKE_AGENT_EXTRA_ROLES FAKE_WEB_LABELS \
  FAKE_LINK_LABELS FAKE_JOB_LABELS FAKE_TEMPLATE_COMMIT FAKE_TEMPLATE_MISSING FAKE_TEMPLATE_READ_FAILS \
  ALLOW_SKEW DEPLOY_ALL_COMMIT KUBECONFIG_OUTFITTER GKE_CLUSTER FAIL_SA_POLICY FAKE_EXTRA_SA_BINDING \
  FAKE_AUTH_PLUGIN_MISSING

fails=0
# run_expr <snippet> -- sources the real env.sh from its own directory, then runs the snippet.
run_expr() {
  (cd "${DEPLOY_DIR}" && bash -c "source ./env.sh >/dev/null 2>&1 && $1")
}
# expect <pass|fail> <description> <pattern> <snippet>
expect() {
  local want="$1" desc="$2" pattern="$3" snippet="$4" status=0 out
  : >"${GCLOUD_CALLS}"; : >"${KUBECTL_CALLS}"
  out="$(run_expr "${snippet}" 2>&1)" || status=$?
  local problem=""
  if [[ "${want}" == pass && ${status} -ne 0 ]] || [[ "${want}" == fail && ${status} -eq 0 ]]; then
    problem="exit ${status}"
  elif [[ -n "${pattern}" ]] && ! grep -q -- "${pattern}" <<<"${out}"; then
    problem="no match for: ${pattern}"
  fi
  if [[ -n "${problem}" ]]; then
    echo "FAIL: ${desc} (${problem})"; echo "${out}" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    echo "ok: ${desc}"
  fi
}
calls_lack() {
  if grep -q -- "$2" "$3"; then
    echo "FAIL: $1 (unexpected call: $2)"; fails=$((fails + 1))
  else
    echo "ok: $1"
  fi
}

expect pass "GKE off: gke_kubeconfig skips" "skipped" \
  "if gke_kubeconfig; then echo called; else echo skipped; fi"
calls_lack "  ... and calls no gcloud" "container clusters get-credentials" "${GCLOUD_CALLS}"

expect pass "GKE off: current_build_commit_gke is empty, no kubectl call" "^END$" \
  "current_build_commit_gke; echo END"
calls_lack "  ... and calls no kubectl" "sandboxtemplate" "${KUBECTL_CALLS}"

GKE_CLUSTER=outfitter DRY_RUN=1 expect pass "dry run: gke_kubeconfig prints instead of calling get-credentials" \
  "DRY_RUN: gcloud container clusters get-credentials" "gke_kubeconfig"
calls_lack "  ... and never actually calls it" "container clusters get-credentials" "${GCLOUD_CALLS}"

GKE_CLUSTER=outfitter KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" \
  expect pass "real run: gke_kubeconfig uses --dns-endpoint against the persistent local file" \
  "container clusters get-credentials outfitter .*--dns-endpoint" \
  "gke_kubeconfig; grep -h . '${GCLOUD_CALLS}'"

GKE_CLUSTER=outfitter GITHUB_ACTIONS=true KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" \
  expect pass "CI: gke_kubeconfig uses a temp file, not the persistent local path" "pass" \
  "gke_kubeconfig; [[ \"\${KUBECONFIG}\" != '${WORK}/kube/outfitter' ]] && echo pass"

GKE_CLUSTER=outfitter FAKE_TEMPLATE_COMMIT=abc123def456 KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" \
  expect pass "current_build_commit_gke reads the SandboxTemplate's build-commit label" "^abc123def456$" \
  "current_build_commit_gke"

# M7: a real lookup failure while GKE is ON must fail loudly, never silently read as "the template
# doesn't exist" -- only a genuine NotFound (the template hasn't been applied yet) does that.
GKE_CLUSTER=outfitter FAKE_TEMPLATE_READ_FAILS=1 KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" \
  expect fail "current_build_commit_gke fails loudly on a non-NotFound kubectl error" \
  "could not read the GKE SandboxTemplate" "current_build_commit_gke"
GKE_CLUSTER=outfitter FAKE_TEMPLATE_MISSING=1 KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" \
  expect pass "current_build_commit_gke still reads a genuine NotFound as empty, not a failure" "^$" \
  "current_build_commit_gke"
# Low (review round 2): kubectl's own "executable gke-gcloud-auth-plugin not found" error contains
# the words "not found" too -- a loose regex would misread a broken kubectl setup as "the template
# doesn't exist" instead of failing loudly.
GKE_CLUSTER=outfitter FAKE_AUTH_PLUGIN_MISSING=1 KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" \
  expect fail "current_build_commit_gke fails loudly on the auth-plugin-missing message, not NotFound" \
  "could not read the GKE SandboxTemplate" "current_build_commit_gke"
GKE_CLUSTER=outfitter FAIL_GET_CREDENTIALS=1 KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" \
  expect fail "current_build_commit_gke fails loudly when it can't even get a kubeconfig" \
  "could not obtain a kubeconfig" "current_build_commit_gke"

: >"${KUBECTL_CALLS}"
dry_run_stdout="$(GKE_CLUSTER=outfitter DRY_RUN=1 run_expr "current_build_commit_gke" 2>/dev/null)"
if [[ -z "${dry_run_stdout}" ]]; then
  echo "ok: dry run: current_build_commit_gke's stdout is empty (no real kubeconfig to read)"
else
  echo "FAIL: dry run: current_build_commit_gke's stdout is empty (got: ${dry_run_stdout})"; fails=$((fails + 1))
fi
calls_lack "  ... and calls no kubectl" "sandboxtemplate" "${KUBECTL_CALLS}"

# check_deploy_skew: this_commit=zzz999999999 throughout.
FAKE_JOB_LABELS="build-commit=zzz999999999" GKE_CLUSTER=outfitter FAKE_TEMPLATE_COMMIT=old111111111 \
  KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" \
  expect fail "check_deploy_skew: a stale GKE template refuses a job deploy" "GKE SandboxTemplate is at old111111111" \
  "check_deploy_skew zzz999999999 job"

FAKE_JOB_LABELS="build-commit=zzz999999999" GKE_CLUSTER=outfitter FAKE_TEMPLATE_COMMIT=old111111111 \
  ALLOW_SKEW=1 KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" \
  expect pass "check_deploy_skew: ALLOW_SKEW=1 downgrades the template mismatch to a warning" "deploying anyway" \
  "check_deploy_skew zzz999999999 job"

FAKE_WEB_LABELS="build-commit=old222222222" GKE_CLUSTER=outfitter FAKE_TEMPLATE_COMMIT=zzz999999999 \
  KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" \
  expect fail "check_deploy_skew: deploying the gke-template itself checks web/link/job too" "outfitter-api (web) is at old222222222" \
  "check_deploy_skew zzz999999999 gke-template"

FAKE_JOB_LABELS="build-commit=zzz999999999" FAKE_TEMPLATE_COMMIT=old111111111 \
  expect pass "check_deploy_skew: GKE off never checks the template" "" \
  "check_deploy_skew zzz999999999 job"
calls_lack "  ... and calls no kubectl" "sandboxtemplate" "${KUBECTL_CALLS}"

DEPLOY_ALL_COMMIT=zzz999999999 GKE_CLUSTER=outfitter FAKE_TEMPLATE_COMMIT=old111111111 \
  expect pass "check_deploy_skew: a release.sh run (DEPLOY_ALL_COMMIT set) skips the check entirely" "" \
  "check_deploy_skew zzz999999999 job"
calls_lack "  ... and calls no kubectl" "sandboxtemplate" "${KUBECTL_CALLS}"

FAKE_AGENT_EXTRA_ROLES="" expect pass "assert_agent_sa_logwriter_only passes with no extra roles" "^ok$" \
  "assert_agent_sa_logwriter_only && echo ok"
FAKE_AGENT_EXTRA_ROLES="roles/editor" expect fail "assert_agent_sa_logwriter_only refuses an extra role" \
  "holds project role.*roles/editor" "assert_agent_sa_logwriter_only"
FAIL_IAM_POLICY=1 expect fail "assert_agent_sa_logwriter_only refuses loudly on a read error" \
  "could not read .*IAM policy" "assert_agent_sa_logwriter_only"

expect pass "assert_agent_sa_no_unexpected_bindings passes with only the three expected bindings" "^ok$" \
  "assert_agent_sa_no_unexpected_bindings && echo ok"
FAKE_EXTRA_SA_BINDING="roles/iam.serviceAccountTokenCreator,user:someone@example.com" \
  expect fail "assert_agent_sa_no_unexpected_bindings refuses an unexpected binding" \
  "unexpected bindings.*roles/iam.serviceAccountTokenCreator" "assert_agent_sa_no_unexpected_bindings"
FAIL_SA_POLICY=1 expect fail "assert_agent_sa_no_unexpected_bindings refuses loudly on a read error" \
  "could not read .*own IAM policy" "assert_agent_sa_no_unexpected_bindings"

# Low (review round 2): a command-substitution subshell (e.g. check_deploy_skew's own
# `template_commit="$(current_build_commit_gke)"`, which calls gke_kubeconfig -> register_cleanup)
# inherits the EXIT trap and a *copy* of CLEANUP_PATHS/CLEANUP_CMDS. Without the BASH_SUBSHELL guard,
# that subshell's own exit would delete every path registered so far -- including ones the top-level
# script (still running) hasn't used yet.
MARKER_FILE="${WORK}/subshell-marker"
GKE_CLUSTER=outfitter GITHUB_ACTIONS=true KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter" \
  expect pass "a command-substitution subshell doesn't delete cleanup paths registered before it" \
  "survived" \
  "touch '${MARKER_FILE}'; register_cleanup '${MARKER_FILE}'; : \"\$(gke_kubeconfig)\"; if [[ -f '${MARKER_FILE}' ]]; then echo survived; else echo deleted; fi"
if [[ -f "${MARKER_FILE}" ]]; then
  echo "FAIL:   ... yet the marker was never cleaned up once the top-level process actually exited"
  fails=$((fails + 1))
  rm -f "${MARKER_FILE}"
else
  echo "ok:   ... and it WAS deleted once the top-level process actually exited"
fi

echo "${fails} failed"
[[ "${fails}" -eq 0 ]]
