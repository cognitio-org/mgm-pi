# Shared guard for every Outfitter deploy script. Source it right after `set -euo pipefail`.
#
# Outfitter lives in ONE project under ONE personal account. Nothing here may ever depend on the
# active gcloud configuration, which on this laptop can point at an unrelated work project. So:
# pin the project and account through CLOUDSDK_* (they override `gcloud config` for every command
# in this process, including the quota project used by billing-account-scoped APIs), and refuse to
# run if the pinned account is not logged in.
PROJECT="${PROJECT:-outfitter-509211}"
REGION="${REGION:-us-central1}"
ACCOUNT="${ACCOUNT:-mgm@mgms.eu}"

export CLOUDSDK_CORE_PROJECT="${PROJECT}"
export CLOUDSDK_CORE_ACCOUNT="${ACCOUNT}"
export CLOUDSDK_BILLING_QUOTA_PROJECT="${PROJECT}"

if ! gcloud auth list --filter="account:${ACCOUNT}" --format="value(account)" 2>/dev/null | grep -qx "${ACCOUNT}"; then
  echo "deploy: ${ACCOUNT} is not logged in to gcloud (gcloud auth login ${ACCOUNT}); refusing to run." >&2
  exit 1
fi
case "${PROJECT}" in
  outfitter-*) ;;
  *) echo "deploy: PROJECT=${PROJECT} is not an Outfitter project; refusing to run." >&2; exit 1 ;;
esac
echo "deploy: account=${ACCOUNT} project=${PROJECT} region=${REGION}"
