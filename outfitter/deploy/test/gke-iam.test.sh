#!/usr/bin/env bash
# gke-iam.sh against fake gcloud/kubectl, always with DRY_RUN=1 except where noted. No network, no
# GCP. The fake records every call; a dry run must never call anything that mutates (add-iam-
# policy-binding, kubectl apply/patch).
#   bash outfitter/deploy/test/gke-iam.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
  "projects get-iam-policy"*)
    [[ -n "${FAIL_IAM_POLICY:-}" ]] && { echo "PERMISSION_DENIED" >&2; exit 1; }
    if [[ "$*" == *outfitter-sandbox@* ]]; then
      [[ -n "${FAKE_SANDBOX_ROLES:-}" ]] && printf '%s\n' "${FAKE_SANDBOX_ROLES}"
    else
      [[ -n "${FAKE_AGENT_EXTRA_ROLES:-}" ]] && printf '%s\n' "${FAKE_AGENT_EXTRA_ROLES}"
    fi
    ;;
  "iam service-accounts get-iam-policy outfitter-agent@"*)
    [[ -n "${FAIL_SA_POLICY:-}" ]] && { echo "PERMISSION_DENIED" >&2; exit 1; }
    printf 'roles/iam.serviceAccountUser,serviceAccount:outfitter-deployer@outfitter-509211.iam.gserviceaccount.com\n'
    printf 'roles/iam.serviceAccountUser,serviceAccount:outfitter-api@outfitter-509211.iam.gserviceaccount.com\n'
    [[ -z "${FAKE_NO_LEGACY_WI:-}" ]] && printf 'roles/iam.workloadIdentityUser,serviceAccount:outfitter-509211.svc.id.goog[outfitter-sandboxes/outfitter-agent]\n'
    if [[ -n "${FAKE_EXTRA_SA_BINDING:-}" ]]; then printf '%s\n' "${FAKE_EXTRA_SA_BINDING}"; fi
    ;;
  "iam service-accounts describe outfitter-sandbox@"*)
    [[ -n "${FAKE_SANDBOX_SA_MISSING:-}" ]] && { echo "NOT_FOUND" >&2; exit 1; }
    ;;
  "iam service-accounts get-iam-policy outfitter-sandbox@"*)
    printf 'roles/iam.workloadIdentityUser,serviceAccount:outfitter-509211.svc.id.goog[outfitter-sandboxes/outfitter-agent]\n'
    if [[ -n "${FAKE_EXTRA_SANDBOX_BINDING:-}" ]]; then printf '%s\n' "${FAKE_EXTRA_SANDBOX_BINDING}"; fi
    ;;
  "run services describe "*)
    # gcloud's value() rendering of the container env, as on the real services.
    printf "{'name': 'AGENT_SA_EMAIL', 'value': 'outfitter-agent@outfitter-509211.iam.gserviceaccount.com'}"
    [[ -z "${FAKE_API_NO_SANDBOX:-}" ]] && printf ";{'name': 'SANDBOX_SA_EMAIL', 'value': 'outfitter-sandbox@outfitter-509211.iam.gserviceaccount.com'}"
    printf '\n'
    ;;
  "container clusters get-credentials"*)
    [[ -n "${FAIL_GET_CREDENTIALS:-}" ]] && { echo "ERROR: not found" >&2; exit 1; }
    : >"${KUBECONFIG}"
    ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/gcloud"

cat >"${WORK}/bin/kubectl" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"${KUBECTL_CALLS}"
case "$*" in
  *"get validatingadmissionpolicybinding sandbox-hardening-binding -o json"*)
    printf '{"spec":{"matchResources":{"namespaceSelector":{"matchExpressions":[{"key":"kubernetes.io/metadata.name","operator":"NotIn","values":%s}]}}}}' \
      "${FAKE_HARDENING_VALUES:-[\"outfitter-other\"]}"
    ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/kubectl"

export PATH="${WORK}/bin:${PATH}"
export GCLOUD_CALLS="${WORK}/gcloud-calls" KUBECTL_CALLS="${WORK}/kubectl-calls" \
  GKE_CLUSTER=outfitter KUBECONFIG_OUTFITTER="${WORK}/kube/outfitter"
unset GITHUB_ACTIONS FAIL_IAM_POLICY FAKE_AGENT_EXTRA_ROLES FAIL_GET_CREDENTIALS FAKE_HARDENING_VALUES \
  FAIL_SA_POLICY FAKE_EXTRA_SA_BINDING FAKE_SANDBOX_ROLES FAKE_NO_LEGACY_WI FAKE_SANDBOX_SA_MISSING \
  FAKE_EXTRA_SANDBOX_BINDING FAKE_API_NO_SANDBOX DROP_LEGACY_WI

fails=0
OUT=""
# expect <pass|fail> <description> <pattern> [env=val ...] -- runs gke-iam.sh with DRY_RUN=1 unless
# NO_DRY_RUN=1 is one of the given env assignments.
expect() {
  local want="$1" desc="$2" pattern="$3" status=0 problem=""
  shift 3
  : >"${GCLOUD_CALLS}"; : >"${KUBECTL_CALLS}"
  OUT="$(env DRY_RUN="${DRY_RUN_OVERRIDE:-1}" "$@" "${HERE}/../gke-iam.sh" 2>&1)" || status=$?
  if [[ "${want}" == pass && ${status} -ne 0 ]] || [[ "${want}" == fail && ${status} -eq 0 ]]; then
    problem="exit ${status}"
  elif ! grep -q -- "${pattern}" <<<"${OUT}"; then
    problem="no match for: ${pattern}"
  fi
  if [[ -n "${problem}" ]]; then
    echo "FAIL: ${desc} (${problem})"; echo "${OUT}" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    echo "ok: ${desc}"
  fi
}
mutations_in_dry_run() {
  grep -E 'add-iam-policy-binding|remove-iam-policy-binding|service-accounts create|apply|patch' "${GCLOUD_CALLS}" "${KUBECTL_CALLS}" 2>/dev/null || true
}

expect fail "GKE_CLUSTER empty refuses" "GKE_CLUSTER is empty" GKE_CLUSTER=
expect fail "an unexpected GKE_NAMESPACE refuses (hardening-exemption.json is fixed to one namespace)" \
  "only exempts 'outfitter-sandboxes'" GKE_NAMESPACE=something-else

FAKE_AGENT_EXTRA_ROLES="roles/editor" expect fail "the logWriter-only guard refuses an extra role" \
  "holds project role.*roles/editor"
found="$(mutations_in_dry_run)"; [[ -z "${found}" ]] && echo "ok:   ... and never reaches any mutation" \
  || { echo "FAIL:   ... and never reaches any mutation (${found})"; fails=$((fails + 1)); }

FAIL_IAM_POLICY=1 expect fail "an IAM policy read error aborts instead of reading as no extra roles" \
  "could not read"

FAKE_EXTRA_SA_BINDING="roles/iam.serviceAccountTokenCreator,user:someone@example.com" \
  expect fail "an unexpected binding on outfitter-agent@'s own IAM policy refuses" "unexpected bindings"
found="$(mutations_in_dry_run)"; [[ -z "${found}" ]] && echo "ok:   ... and never reaches any mutation" \
  || { echo "FAIL:   ... and never reaches any mutation (${found})"; fails=$((fails + 1)); }

FAIL_SA_POLICY=1 expect fail "a service-account IAM policy read error aborts instead of reading as no unexpected bindings" \
  "could not read"

expect pass "dry run: passes both guards, applies namespace, WI binding, clusterViewer, RBAC" \
  "ok: logging.logWriter only"
found="$(mutations_in_dry_run)"
if [[ -z "${found}" ]]; then
  echo "ok:   a dry run calls no mutation"
else
  echo "FAIL:   a dry run calls a mutation: ${found}"; fails=$((fails + 1))
fi

expect pass "dry run mentions the namespace apply" "DRY_RUN:.*kubectl.*apply.*namespace.yaml"
expect pass "dry run mentions the WI binding" "DRY_RUN:.*iam service-accounts add-iam-policy-binding"

# #202: the sandboxes' own GSA, with no project roles.
expect pass "#202: the WI binding is on outfitter-sandbox@, not outfitter-agent@" \
  "DRY_RUN: gcloud iam service-accounts add-iam-policy-binding outfitter-sandbox@outfitter-509211.iam.gserviceaccount.com"
if grep -q "add-iam-policy-binding outfitter-agent@" <<<"${OUT}"; then
  echo "FAIL:   ... yet it still grants the legacy binding on outfitter-agent@"; fails=$((fails + 1))
else
  echo "ok:   ... and never grants the legacy binding on outfitter-agent@ any more"
fi
grep -q 'outfitter-sandbox@' "${HERE}/../gke/namespace.yaml" && ! grep -q 'gcp-service-account: outfitter-agent@' "${HERE}/../gke/namespace.yaml" \
  && echo "ok: #202: namespace.yaml points the KSA at outfitter-sandbox@" \
  || { echo "FAIL: #202: namespace.yaml must point the KSA at outfitter-sandbox@"; fails=$((fails + 1)); }
FAKE_SANDBOX_SA_MISSING=1 expect pass "#202: a missing outfitter-sandbox@ is created (dry run)" \
  "DRY_RUN: gcloud iam service-accounts create outfitter-sandbox"
expect pass "#202: an existing outfitter-sandbox@ is not created again" "^   exists$"
FAKE_SANDBOX_ROLES="roles/logging.logWriter" expect fail "#202: outfitter-sandbox@ holding any project role refuses" \
  "outfitter-sandbox@.*holds project role.*roles/logging.logWriter"
found="$(mutations_in_dry_run)"; [[ -z "${found}" ]] && echo "ok:   ... and never reaches any mutation" \
  || { echo "FAIL:   ... and never reaches any mutation (${found})"; fails=$((fails + 1)); }
FAKE_EXTRA_SANDBOX_BINDING="roles/iam.serviceAccountTokenCreator,user:someone@example.com" \
  expect fail "#202: an unexpected binding on outfitter-sandbox@'s own IAM policy refuses" "outfitter-sandbox@.*unexpected bindings"
FAKE_API_NO_SANDBOX=1 expect pass "#202: a dry run says it would refuse while the api lacks SANDBOX_SA_EMAIL" \
  "DRY_RUN: would refuse: outfitter-api doesn't have SANDBOX_SA_EMAIL"
DRY_RUN_OVERRIDE=0 FAKE_API_NO_SANDBOX=1 expect fail "#202: a real run refuses to move the KSA while the api lacks SANDBOX_SA_EMAIL" \
  "release first"
if grep -qE 'namespace.yaml|service-accounts create|add-iam-policy-binding' "${KUBECTL_CALLS}" "${GCLOUD_CALLS}"; then
  echo "FAIL:   ... yet it changed something before refusing"; fails=$((fails + 1))
else
  echo "ok:   ... before creating, binding or applying anything"
fi
DRY_RUN_OVERRIDE=0 FAKE_HARDENING_VALUES='["outfitter-sandboxes"]' expect pass "#202: without DROP_LEGACY_WI the legacy binding stays, with a reminder" \
  "DROP_LEGACY_WI=1 ./gke-iam.sh"
if grep -q 'remove-iam-policy-binding' "${GCLOUD_CALLS}"; then
  echo "FAIL:   ... yet it removed it"; fails=$((fails + 1))
else
  echo "ok:   ... and nothing was removed"
fi
DRY_RUN_OVERRIDE=0 DROP_LEGACY_WI=1 FAKE_HARDENING_VALUES='["outfitter-sandboxes"]' expect pass "#202: DROP_LEGACY_WI=1 removes the legacy binding" ""
if grep -q 'iam service-accounts remove-iam-policy-binding outfitter-agent@outfitter-509211.iam.gserviceaccount.com.*outfitter-sandboxes/outfitter-agent.*roles/iam.workloadIdentityUser' "${GCLOUD_CALLS}"; then
  echo "ok:   ... from outfitter-agent@, for the sandbox KSA only"
else
  echo "FAIL:   ... expected a remove-iam-policy-binding on outfitter-agent@"; fails=$((fails + 1))
fi
DRY_RUN_OVERRIDE=0 FAKE_NO_LEGACY_WI=1 FAKE_HARDENING_VALUES='["outfitter-sandboxes"]' expect pass "#202: a legacy binding that's already gone is reported, not removed" "already gone"
expect pass "dry run mentions clusterViewer" "DRY_RUN:.*roles/container.clusterViewer"
expect pass "#197: dry run creates the sandbox log bucket" \
  'DRY_RUN: would create log bucket outfitter-sandboxes (global, 30-day retention)'
expect pass "#197: the sink copies only agentd containers in the sandbox namespace, and the Cloud Run agent job" \
  'DRY_RUN: would create or update log sink outfitter-sandboxes -> projects/outfitter-509211/locations/global/buckets/outfitter-sandboxes with filter: (resource.type="k8s_container" AND resource.labels.namespace_name="outfitter-sandboxes" AND resource.labels.container_name="agentd") OR (resource.type="cloud_run_job"'
expect pass "#197: logging.viewAccessor is conditioned on that bucket's _AllLogs view alone" \
  'DRY_RUN:.*roles/logging.viewAccessor.*resource.name.*buckets/outfitter-sandboxes/views/_AllLogs'
expect pass "#197: metrics come from a custom role with timeSeries.list only" \
  'DRY_RUN: would create or update projects/outfitter-509211/roles/outfitterMetricsReader with monitoring.timeSeries.list'
expect pass "#197: dry run grants that custom role" "DRY_RUN:.*outfitter-api@.*roles/outfitterMetricsReader"
dry_out="$(env DRY_RUN=1 "${HERE}/../gke-iam.sh" 2>&1)"
if grep -qE 'role(=| )roles/(logging\.viewer|monitoring\.viewer)' <<<"${dry_out}"; then
  echo "FAIL: #197 must never grant project-wide roles/logging.viewer or roles/monitoring.viewer"; fails=$((fails + 1))
else
  echo "ok: #197: no project-wide logging.viewer or monitoring.viewer"
fi
expect pass "dry run mentions the RBAC apply" "DRY_RUN:.*kubectl.*apply.*rbac.yaml"
expect pass "dry run doesn't touch the hardening binding" "DRY_RUN: would check.*sandbox-hardening-binding"

DRY_RUN_OVERRIDE=0 FAKE_HARDENING_VALUES='["outfitter-other","outfitter-sandboxes"]' \
  expect pass "already-exempted namespace is not patched again" "already exempted"
if grep -q 'patch validatingadmissionpolicybinding' "${KUBECTL_CALLS}"; then
  echo "FAIL:   ... yet it patched anyway"; fails=$((fails + 1))
else
  echo "ok:   ... and no patch call was made"
fi

# Exact list membership, not a substring/word match: "outfitter-sandboxes-other" must NOT count as
# already exempting "outfitter-sandboxes".
DRY_RUN_OVERRIDE=0 FAKE_HARDENING_VALUES='["outfitter-sandboxes-other"]' \
  expect pass "a namespace that only shares a prefix is not mistaken for an exact match" ""
if grep -q "patch validatingadmissionpolicybinding sandbox-hardening-binding --type=json --patch-file=.*hardening-exemption.json" "${KUBECTL_CALLS}"; then
  echo "ok:   ... and it patches anyway (the prefix match doesn't count as exempted)"
else
  echo "FAIL:   ... expected a patch call (the existing entry only shares a prefix)"; fails=$((fails + 1))
fi

DRY_RUN_OVERRIDE=0 FAKE_HARDENING_VALUES='["outfitter-other"]' \
  expect pass "a missing exemption is patched" ""
if grep -q "patch validatingadmissionpolicybinding sandbox-hardening-binding --type=json --patch-file=.*hardening-exemption.json" "${KUBECTL_CALLS}"; then
  echo "ok:   ... using the checked-in patch file"
else
  echo "FAIL:   ... expected a patch call using hardening-exemption.json"; fails=$((fails + 1))
fi

DRY_RUN_OVERRIDE=0 FAIL_GET_CREDENTIALS=1 expect fail "a kubeconfig failure aborts loudly" \
  "could not obtain a kubeconfig"

echo "${fails} failed"
[[ "${fails}" -eq 0 ]]
