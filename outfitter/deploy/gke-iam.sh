#!/usr/bin/env bash
# GKE identities and RBAC for the sandbox provider (docs/specs/gke-sandbox-provider.md §3.2, §5.1;
# gke-sandbox-provider-plan.md §1 "option B"). One time, by hand, after gke-cluster.sh has created
# the cluster and api.sh/link.sh have created outfitter-api@'s Cloud Run services. Idempotent and
# safe to re-run (e.g. a GKE upgrade can restore the hardening binding this un-exempts, or the owner
# wants to re-check the logWriter guard below):
#   DRY_RUN=1 ./gke-iam.sh
#   ./gke-iam.sh
#
# Creates/checks:
# - the outfitter-sandboxes namespace and its outfitter-agent KSA (deploy/gke/namespace.yaml)
# - roles/iam.workloadIdentityUser on outfitter-agent@ for that KSA (Workload Identity, GSA
#   impersonation form -- keeps agentd's ID token `email` unchanged, spec §3.2)
# - roles/container.clusterViewer on the project for outfitter-api@ (both Cloud Run roles dial the
#   cluster's DNS endpoint as this account)
# - the outfitter-sandboxes log bucket and the sink that copies agentd's logs into it,
#   roles/logging.viewAccessor on that bucket alone, and a custom outfitterMetricsReader role
#   (monitoring.timeSeries.list), for outfitter-api@ (#197: the session page's sandbox logs and stats)
# - the outfitter-api Role/RoleBinding in outfitter-sandboxes (deploy/gke/rbac.yaml; since #193
#   it includes `get` on pods, for termination reasons)
# - the sandbox-hardening-policy exemption for outfitter-sandboxes only (hardening-exemption.json),
#   patched in only when missing -- GKE's binding stays Deny everywhere else
#
# Guards (always run, even under DRY_RUN=1 -- they only read):
# - outfitter-agent@ must hold no project IAM role beyond roles/logging.logWriter, and no unexpected
#   binding on its own IAM policy: with the metadata server reachable from every sandbox (option B),
#   that account's permissions ARE the model's permissions inside a run. See env.sh's
#   assert_agent_sa_logwriter_only and assert_agent_sa_no_unexpected_bindings for exactly what these
#   do and do NOT cover (folder/org-level grants are a known gap, documented there).
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
[[ -n "${GKE_CLUSTER:-}" ]] || deploy_fail "GKE_CLUSTER is empty in config.env; set it and run ./gke-cluster.sh first"
GKE_NAMESPACE="${GKE_NAMESPACE:-outfitter-sandboxes}"
# hardening-exemption.json's "add" op is a literal "outfitter-sandboxes", not a template: a
# different GKE_NAMESPACE would need a different patch file, which nothing here generates.
[[ "${GKE_NAMESPACE}" == outfitter-sandboxes ]] || deploy_fail "GKE_NAMESPACE=${GKE_NAMESPACE}, but deploy/gke/hardening-exemption.json only exempts 'outfitter-sandboxes'; use that namespace, or update the patch file to match"
AGENT_SA_EMAIL="outfitter-agent@${PROJECT}.iam.gserviceaccount.com"
API_SA_EMAIL="outfitter-api@${PROJECT}.iam.gserviceaccount.com"
GKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/gke" && pwd)"

# run <cmd...> -- execute, or with DRY_RUN=1 print it instead (gke-cluster.sh's convention).
run() {
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    printf '   DRY_RUN:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

echo "== Guard: ${AGENT_SA_EMAIL} holds no project role beyond roles/logging.logWriter =="
assert_agent_sa_logwriter_only
echo "   ok: logging.logWriter only"

echo "== Guard: ${AGENT_SA_EMAIL} has no unexpected binding on its own IAM policy =="
assert_agent_sa_no_unexpected_bindings
echo "   ok"

echo "== Namespace and KSA (${GKE_NAMESPACE}/outfitter-agent) =="
gke_kubeconfig || deploy_fail "could not obtain a kubeconfig for ${GKE_CLUSTER}"
run kubectl --kubeconfig="${KUBECONFIG}" apply --server-side -f "${GKE_DIR}/namespace.yaml"

echo "== Workload Identity: ${AGENT_SA_EMAIL} impersonated by ${PROJECT}.svc.id.goog[${GKE_NAMESPACE}/outfitter-agent] =="
run gcloud iam service-accounts add-iam-policy-binding "${AGENT_SA_EMAIL}" \
  --project="${PROJECT}" \
  --member="serviceAccount:${PROJECT}.svc.id.goog[${GKE_NAMESPACE}/outfitter-agent]" \
  --role=roles/iam.workloadIdentityUser --quiet

echo "== ${API_SA_EMAIL}: roles/container.clusterViewer (project-wide, permanent) =="
run gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${API_SA_EMAIL}" --role=roles/container.clusterViewer \
  --condition=None --quiet

# #197: the session page shows a run's sandbox logs and its memory/CPU/disk history.
# Logs: a log view on _Default can only filter by source, resource type and log id (LogView docs), not
# by namespace, so the sandboxes get their own log bucket instead. A sink copies agentd's lines (the
# sandbox namespace's agentd containers, and the Cloud Run agent job) into it, and outfitter-api@'s
# grant is roles/logging.viewAccessor conditioned on that bucket's _AllLogs view: it can read nothing
# else in the project (not project-wide roles/logging.viewer; PR #199 and #201 reviews). The bucket
# id is SANDBOX_LOG_BUCKET_ID in packages/api/src/sandbox-telemetry.ts. The lines stay in _Default
# too; this is a copy, billed as a second destination.
LOG_BUCKET_ID=outfitter-sandboxes
LOG_BUCKET="projects/${PROJECT}/locations/global/buckets/${LOG_BUCKET_ID}"
LOG_SINK_FILTER="(resource.type=\"k8s_container\" AND resource.labels.namespace_name=\"${GKE_NAMESPACE}\" AND resource.labels.container_name=\"agentd\") OR (resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${CLOUDRUN_JOB:-outfitter-agent}\")"
echo "== Log bucket ${LOG_BUCKET_ID} (30 days) and the sink that fills it: sandbox logs only (#197) =="
if [[ "${DRY_RUN:-0}" == 1 ]]; then
  echo "   DRY_RUN: would create log bucket ${LOG_BUCKET_ID} (global, 30-day retention) if missing"
  echo "   DRY_RUN: would create or update log sink ${LOG_BUCKET_ID} -> ${LOG_BUCKET} with filter: ${LOG_SINK_FILTER}"
else
  gcloud logging buckets describe "${LOG_BUCKET_ID}" --location=global --project="${PROJECT}" >/dev/null 2>&1 \
    || gcloud logging buckets create "${LOG_BUCKET_ID}" --location=global --project="${PROJECT}" --retention-days=30 \
         --description="Outfitter sandbox logs (agentd), read by the session page" --quiet
  if gcloud logging sinks describe "${LOG_BUCKET_ID}" --project="${PROJECT}" >/dev/null 2>&1; then
    gcloud logging sinks update "${LOG_BUCKET_ID}" "logging.googleapis.com/${LOG_BUCKET}" --project="${PROJECT}" \
      --log-filter="${LOG_SINK_FILTER}" --quiet
  else
    gcloud logging sinks create "${LOG_BUCKET_ID}" "logging.googleapis.com/${LOG_BUCKET}" --project="${PROJECT}" \
      --log-filter="${LOG_SINK_FILTER}" --description="Outfitter sandbox logs for the session page (#197)" --quiet
  fi
fi

echo "== ${API_SA_EMAIL}: roles/logging.viewAccessor on the ${LOG_BUCKET_ID} bucket's _AllLogs view only (#197) =="
run gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${API_SA_EMAIL}" --role=roles/logging.viewAccessor \
  --condition="expression=resource.name == \"${LOG_BUCKET}/views/_AllLogs\",title=outfitter-sandbox-logs,description=Only the outfitter-sandboxes log bucket" \
  --quiet

# Metrics: a custom role with timeSeries.list alone, not roles/monitoring.viewer (which also reads
# dashboards, alert policies and notification channels; #201 security review).
METRICS_ROLE_ID=outfitterMetricsReader
echo "== Custom role ${METRICS_ROLE_ID} (monitoring.timeSeries.list only) and its grant to ${API_SA_EMAIL} (#197) =="
if [[ "${DRY_RUN:-0}" == 1 ]]; then
  echo "   DRY_RUN: would create or update projects/${PROJECT}/roles/${METRICS_ROLE_ID} with monitoring.timeSeries.list"
elif gcloud iam roles describe "${METRICS_ROLE_ID}" --project="${PROJECT}" >/dev/null 2>&1; then
  gcloud iam roles update "${METRICS_ROLE_ID}" --project="${PROJECT}" --permissions=monitoring.timeSeries.list --quiet >/dev/null
else
  gcloud iam roles create "${METRICS_ROLE_ID}" --project="${PROJECT}" --permissions=monitoring.timeSeries.list \
    --title="Outfitter metrics reader" --description="Read sandbox metrics for the session page (#197)" --quiet >/dev/null
fi
run gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${API_SA_EMAIL}" --role="projects/${PROJECT}/roles/${METRICS_ROLE_ID}" --condition=None --quiet

echo "== RBAC: ${API_SA_EMAIL} in ${GKE_NAMESPACE} (deploy/gke/rbac.yaml) =="
run kubectl --kubeconfig="${KUBECONFIG}" apply --server-side -f "${GKE_DIR}/rbac.yaml"

echo "== sandbox-hardening-policy exemption for ${GKE_NAMESPACE} =="
if [[ "${DRY_RUN:-0}" == 1 ]]; then
  echo "   DRY_RUN: would check validatingadmissionpolicybinding/sandbox-hardening-binding and patch it if ${GKE_NAMESPACE} is missing from the NotIn list"
else
  current_binding_json="$(kubectl --kubeconfig="${KUBECONFIG}" get validatingadmissionpolicybinding sandbox-hardening-binding -o json)" \
    || deploy_fail "could not read validatingadmissionpolicybinding/sandbox-hardening-binding"
  # Exact list membership via json.load, not grep -w against jsonpath's space-joined values: a
  # substring/word match could be fooled by (or miss) a namespace name that shares a hyphenated
  # segment with another entry.
  if printf '%s' "${current_binding_json}" | python3 -c "
import json, sys
obj = json.load(sys.stdin)
values = obj.get('spec', {}).get('matchResources', {}).get('namespaceSelector', {}).get('matchExpressions', [{}])[0].get('values', [])
sys.exit(0 if sys.argv[1] in values else 1)
" "${GKE_NAMESPACE}"; then
    echo "   already exempted"
  else
    # hardening-exemption.json's own "test" ops check operator == NotIn and key ==
    # kubernetes.io/metadata.name first; if GKE ever changes the binding's shape, this fails loudly
    # instead of silently patching the wrong thing.
    kubectl --kubeconfig="${KUBECONFIG}" patch validatingadmissionpolicybinding sandbox-hardening-binding \
      --type=json --patch-file="${GKE_DIR}/hardening-exemption.json"
  fi
fi

echo "== Done =="
