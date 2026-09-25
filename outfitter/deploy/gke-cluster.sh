#!/usr/bin/env bash
# The GKE Autopilot cluster for the gke sandbox provider (docs/specs/gke-sandbox-provider.md §3.1,
# §5.1; plan in docs/specs/gke-sandbox-provider-plan.md). One time, by hand: never from release.sh or
# GitHub Actions. An agent runs it only with the owner's explicit go-ahead in the conversation (it
# starts GKE billing), as deploy/CLAUDE.md asks for tag-release.sh. Idempotent: an existing cluster
# only gets Agent Sandbox switched on and the maintenance window set again (both meant as no-ops when
# already so; not yet confirmed against the live cluster).
#   DRY_RUN=1 ./gke-cluster.sh     # read-only: prints the checks and the commands it would run
#   ./gke-cluster.sh               # creates the cluster (billed; see the cost note below)
#   ./gke-cluster.sh --i-know      # proceed even if another GKE cluster shares the billing account
#
# Cost: the cluster fee is $0.10/h ($73/month), covered by the $74.40/month GKE free-tier credit ONLY
# if this is the billing account's only credit-consuming cluster, hence the refusal below. Pod compute
# is billed per pod on top (spec §3.7: about $17.60/month at the default warm schedule).
#
# Docs consulted:
# - Agent Sandbox on Autopilot (--enable-agent-sandbox, region-only, 1.36.3-gke.1767000 or later):
#   https://docs.cloud.google.com/kubernetes-engine/docs/how-to/how-install-agent-sandbox
# - DNS-based control-plane endpoint:
#   https://cloud.google.com/blog/products/containers-kubernetes/new-dns-based-endpoint-for-the-gke-control-plane
# - Image streaming (containerfilesystem.googleapis.com):
#   https://docs.cloud.google.com/kubernetes-engine/docs/how-to/image-streaming
# - Free-tier credit: https://cloud.google.com/kubernetes-engine/pricing
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

CLUSTER="${GKE_CLUSTER:-outfitter}"
CHANNEL="${GKE_CHANNEL:-regular}"
MIN_VERSION="1.36.3-gke.1767000"
KUBECONFIG_OUTFITTER="${KUBECONFIG_OUTFITTER:-${HOME}/.kube/outfitter}"
# Outside the warm window (00:00-12:00 Europe/Zagreb, daily): 13:00-18:00 UTC daily, which is
# 14:00/15:00-19:00/20:00 Zagreb depending on DST, so it never overlaps warm hours. Autopilot
# wants at least 48 h of maintenance availability per 32 days; 5 h a day is well over that.
MAINT_START="2026-01-01T13:00:00Z"
MAINT_END="2026-01-01T18:00:00Z"
MAINT_RECURRENCE="FREQ=DAILY"

I_KNOW=0
for arg in "$@"; do
  case "${arg}" in
    --i-know) I_KNOW=1 ;;
    *) deploy_fail "unknown argument '${arg}' (only --i-know)" ;;
  esac
done

# run <cmd...> -- execute, or with DRY_RUN=1 print it instead. Checks above this line always run:
# they only read.
run() {
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    printf '   DRY_RUN:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# api_enabled <project> <service> -- fails loudly: a permission or auth error must never read as "not
# enabled" (or, below, as "no other clusters"), or the credit guard passes without checking anything.
api_enabled() {
  local enabled
  enabled="$(gcloud services list --project="$1" --enabled \
    --filter="config.name=$2" --format='value(config.name)')" \
    || deploy_fail "can't list enabled APIs in $1"
  [[ -n "${enabled}" ]]
}

# Billing-account calls are billed to the quota project (env.sh pins it to PROJECT), so the Cloud
# Billing API must be on there first, as baseline.sh does for billingbudgets.
echo "== API: cloudbilling (for the credit check below) =="
if api_enabled "${PROJECT}" cloudbilling.googleapis.com; then
  echo "   already enabled"
elif [[ "${DRY_RUN:-0}" == 1 ]]; then
  deploy_fail "cloudbilling.googleapis.com is off in ${PROJECT}, so a dry run can't check the billing account; run without DRY_RUN (it enables it first), or: gcloud services enable cloudbilling.googleapis.com --project=${PROJECT}"
else
  gcloud services enable cloudbilling.googleapis.com --project="${PROJECT}"
fi

# The account PROJECT is actually billed to, never an assumed one: checking a different account's
# clusters would pass while the real account's credit is already used.
billing_info="$(gcloud billing projects describe "${PROJECT}" --billing-project="${PROJECT}" \
  --format='value(billingEnabled,billingAccountName)')" \
  || deploy_fail "can't read ${PROJECT}'s billing account"
read -r billing_enabled billing_account_name <<<"${billing_info}"
BILLING_ACCOUNT="${billing_account_name#billingAccounts/}"
if [[ "${billing_enabled}" != "True" || -z "${BILLING_ACCOUNT}" ]]; then
  deploy_fail "${PROJECT} has no billing account enabled (${billing_info:-nothing returned})"
fi

echo "== billing account ${BILLING_ACCOUNT}: other GKE clusters (the free credit covers one) =="
billing_projects="$(gcloud billing projects list --billing-account="${BILLING_ACCOUNT}" \
  --format='value(projectId)' --billing-project="${PROJECT}")" || deploy_fail "can't list the projects on billing account ${BILLING_ACCOUNT}"
others=()
for project in ${billing_projects}; do
  # A project without the GKE API has no clusters; never enable it just to ask.
  if ! api_enabled "${project}" container.googleapis.com; then
    echo "   ${project}: GKE API off, no clusters"
    continue
  fi
  clusters="$(gcloud container clusters list --project="${project}" --format='value(name)')" \
    || deploy_fail "can't list GKE clusters in ${project}"
  echo "   ${project}: ${clusters:-no clusters}"
  for name in ${clusters}; do
    [[ "${project}" == "${PROJECT}" && "${name}" == "${CLUSTER}" ]] && continue
    others+=("${project}/${name}")
  done
done
if (( ${#others[@]} > 0 )); then
  echo "   other clusters on this billing account: ${others[*]}" >&2
  if (( I_KNOW == 0 )); then
    deploy_fail "the GKE credit may already be used, so this cluster could cost \$73/month on its own; rerun with --i-know to accept"
  fi
fi

echo "== APIs: container, containerfilesystem (image streaming) =="
run gcloud services enable container.googleapis.com containerfilesystem.googleapis.com --project="${PROJECT}"

# In a dry run the API may still be off: then no cluster can exist and the version can't be read yet.
container_on=1
if [[ "${DRY_RUN:-0}" == 1 ]] && ! api_enabled "${PROJECT}" container.googleapis.com; then
  container_on=0
fi

echo "== ${CHANNEL} channel: default Autopilot version vs ${MIN_VERSION} =="
# version_at_least <a> <b> -- sort -V orders GKE versions correctly:
# 1.36.3-gke.1767000 < 1.36.3-gke.1800000 < 1.36.4-gke.100.
version_at_least() {
  [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$2" ]]
}
# Below the minimum, pin the channel's newest valid version at create (spec §5.1). The cluster stays
# on the channel and auto-upgrades from there; GKE never downgrades it. bash 3.2 (macOS) treats an
# empty "${a[@]}" as unset under set -u, hence the ${a[@]+...} form where it's expanded.
version_args=()
if (( container_on == 0 )); then
  echo "   (container API not enabled yet; skipping the version check in a dry run)"
else
  channel_upper="$(tr '[:lower:]' '[:upper:]' <<<"${CHANNEL}")"
  default_version="$(gcloud container get-server-config --location="${REGION}" \
    --flatten=channels --filter="channels.channel=${channel_upper}" \
    --format='value(channels.defaultVersion)')"
  echo "   ${CHANNEL} default: ${default_version:-unknown}"
  if [[ -n "${default_version}" ]] && version_at_least "${default_version}" "${MIN_VERSION}"; then
    echo "   default is new enough"
  else
    newest="$(gcloud container get-server-config --location="${REGION}" \
      --flatten=channels --filter="channels.channel=${channel_upper}" \
      --format='value(channels.validVersions)' | tr ';,' '\n\n' | sed '/^$/d' | sort -V | tail -1)"
    if [[ -z "${newest}" ]] || ! version_at_least "${newest}" "${MIN_VERSION}"; then
      deploy_fail "the ${CHANNEL} channel offers nothing at or above ${MIN_VERSION} (newest: ${newest:-none}); rerun with GKE_CHANNEL=rapid (spec §9.6)"
    fi
    echo "   pinning ${newest}, the channel's newest valid version"
    version_args=(--cluster-version="${newest}")
  fi
fi

if (( container_on == 1 )) && gcloud_exists container clusters describe "${CLUSTER}" --location="${REGION}" --project="${PROJECT}"; then
  echo "== ${CLUSTER}: exists; making sure Agent Sandbox is on =="
  run gcloud beta container clusters update "${CLUSTER}" --location="${REGION}" --project="${PROJECT}" \
    --enable-agent-sandbox
else
  echo "== ${CLUSTER}: creating (Autopilot, ${REGION}, ${CHANNEL}, Agent Sandbox, DNS endpoint) =="
  # create-auto also writes a kubeconfig entry and makes it current: point it at our own file, or it
  # switches ~/.kube/config's current-context under every other open shell.
  run mkdir -p "$(dirname "${KUBECONFIG_OUTFITTER}")"
  run env KUBECONFIG="${KUBECONFIG_OUTFITTER}" \
    gcloud beta container clusters create-auto "${CLUSTER}" --location="${REGION}" --project="${PROJECT}" \
    --release-channel="${CHANNEL}" \
    ${version_args[@]+"${version_args[@]}"} \
    --enable-agent-sandbox \
    --enable-dns-access
fi

# create-auto has no maintenance-window flags, and update takes one kind of change per call, so the
# window is its own step, run every time (setting the same window again is meant to be a no-op).
echo "== ${CLUSTER}: maintenance window ${MAINT_START:11:5}-${MAINT_END:11:5} UTC, ${MAINT_RECURRENCE} =="
run gcloud container clusters update "${CLUSTER}" --location="${REGION}" --project="${PROJECT}" \
  --maintenance-window-start="${MAINT_START}" \
  --maintenance-window-end="${MAINT_END}" \
  --maintenance-window-recurrence="${MAINT_RECURRENCE}"

if [[ "${DRY_RUN:-0}" != 1 ]]; then
  echo "== ${CLUSTER}: Agent Sandbox CRDs (spike S0); credentials in ${KUBECONFIG_OUTFITTER} =="
  # Its own kubeconfig: get-credentials otherwise rewrites ~/.kube/config's current-context, which
  # every other open shell shares.
  mkdir -p "$(dirname "${KUBECONFIG_OUTFITTER}")"
  KUBECONFIG="${KUBECONFIG_OUTFITTER}" gcloud container clusters get-credentials "${CLUSTER}" \
    --location="${REGION}" --project="${PROJECT}" --dns-endpoint
  kubectl --kubeconfig="${KUBECONFIG_OUTFITTER}" get crd -o name | grep -E 'agents\.x-k8s\.io' \
    || deploy_fail "no agents.x-k8s.io CRDs yet; Agent Sandbox didn't install"
fi
echo "== done =="
