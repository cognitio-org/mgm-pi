#!/usr/bin/env bash
# Outfitter GCP baseline (EPIC.md E0.2 / "Decisions taken"): enable APIs, create the Artifact
# Registry repo, the two service accounts and their IAM bindings, and the monthly budget alert.
# Idempotent: every step checks for the existing resource first, so re-running after a partial
# failure (or to pick up a role added later) is safe. DOES NOT RUN ON ITS OWN — review, then run by
# hand: `PROJECT=outfitter-509211 REGION=us-central1 ./baseline.sh`.
#
# Run this before api.sh and agent-job.sh; both assume the service accounts and AR repo it creates.
set -euo pipefail

PROJECT="${PROJECT:-outfitter-509211}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-outfitter}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-01DEC0-9358E1-C1FF0D}"
BUDGET_AMOUNT_USD="${BUDGET_AMOUNT_USD:-25}"
BUDGET_DISPLAY_NAME="${BUDGET_DISPLAY_NAME:-outfitter-monthly}"

API_SA="outfitter-api"
AGENT_SA="outfitter-agent"
API_SA_EMAIL="${API_SA}@${PROJECT}.iam.gserviceaccount.com"
AGENT_SA_EMAIL="${AGENT_SA}@${PROJECT}.iam.gserviceaccount.com"

echo "== Outfitter baseline: project=${PROJECT} region=${REGION} =="

echo "-- Enabling APIs (run, artifactregistry, secretmanager, iap, cloudscheduler, cloudbuild, pubsub, iamcredentials, billingbudgets) --"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iap.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com \
  pubsub.googleapis.com \
  iamcredentials.googleapis.com \
  billingbudgets.googleapis.com \
  --project="${PROJECT}"

echo "-- Artifact Registry repo '${AR_REPO}' (docker, ${REGION}) --"
if gcloud artifacts repositories describe "${AR_REPO}" \
  --project="${PROJECT}" --location="${REGION}" &>/dev/null; then
  echo "   already exists, skipping"
else
  gcloud artifacts repositories create "${AR_REPO}" \
    --project="${PROJECT}" \
    --location="${REGION}" \
    --repository-format=docker \
    --description="Outfitter control-plane API and agent sandbox images"
fi

create_service_account() {
  local name="$1" display="$2" email="${1}@${PROJECT}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "${email}" --project="${PROJECT}" &>/dev/null; then
    echo "   ${email} already exists, skipping"
  else
    gcloud iam service-accounts create "${name}" \
      --project="${PROJECT}" \
      --display-name="${display}"
  fi
}

echo "-- Service account: ${API_SA_EMAIL} --"
create_service_account "${API_SA}" "Outfitter control-plane API"

echo "-- Service account: ${AGENT_SA_EMAIL} --"
create_service_account "${AGENT_SA}" "Outfitter agent sandbox (Cloud Run Job)"

# add-iam-policy-binding is itself idempotent (re-adding an existing binding is a no-op), so these
# don't need their own existence checks.

echo "-- IAM roles for ${API_SA_EMAIL}: run.developer, secretmanager.secretAccessor, logging.logWriter --"
for role in roles/run.developer roles/secretmanager.secretAccessor roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${API_SA_EMAIL}" \
    --role="${role}" \
    --condition=None \
    --quiet >/dev/null
done

# Scoped to the outfitter-agent resource, not project-wide: the API only needs to impersonate this
# one service account to start Cloud Run Job executions as it (RunManager.wake -> CloudRunProvider).
echo "-- IAM role for ${API_SA_EMAIL} on ${AGENT_SA_EMAIL}: iam.serviceAccountUser --"
gcloud iam service-accounts add-iam-policy-binding "${AGENT_SA_EMAIL}" \
  --project="${PROJECT}" \
  --member="serviceAccount:${API_SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser" \
  --quiet >/dev/null

echo "-- IAM role for ${AGENT_SA_EMAIL}: logging.logWriter --"
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${AGENT_SA_EMAIL}" \
  --role="roles/logging.logWriter" \
  --condition=None \
  --quiet >/dev/null

echo "-- Budget alert: ${BUDGET_AMOUNT_USD} USD/month at 50/90/100%, billing account ${BILLING_ACCOUNT} --"
existing_budget="$(gcloud billing budgets list --billing-account="${BILLING_ACCOUNT}" \
  --format='value(displayName)' 2>/dev/null | grep -Fx "${BUDGET_DISPLAY_NAME}" || true)"
if [[ -n "${existing_budget}" ]]; then
  echo "   '${BUDGET_DISPLAY_NAME}' already exists, skipping (edit amount/thresholds in the console if they've changed)"
else
  gcloud billing budgets create \
    --billing-account="${BILLING_ACCOUNT}" \
    --display-name="${BUDGET_DISPLAY_NAME}" \
    --budget-amount="${BUDGET_AMOUNT_USD}USD" \
    --threshold-rule=percent=0.5 \
    --threshold-rule=percent=0.9 \
    --threshold-rule=percent=1.0 \
    --filter-projects="projects/${PROJECT}"
fi

cat <<SUMMARY

== Baseline complete ==
API service account:   ${API_SA_EMAIL}
Agent service account: ${AGENT_SA_EMAIL}
AR repo:                ${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}

Next: create the Atlas cluster and the four Secret Manager secrets by hand (see README.md), then
run api.sh and agent-job.sh.
SUMMARY
