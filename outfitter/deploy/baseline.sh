#!/usr/bin/env bash
# Outfitter GCP baseline (EPIC.md E0.2 / "Decisions taken"): enable APIs, create the Artifact
# Registry repo, the two service accounts and their IAM bindings, and the monthly budget alert.
# Idempotent: every step checks for the existing resource first, so re-running after a partial
# failure (or to pick up a role added later) is safe. DOES NOT RUN ON ITS OWN — review, then run by
# hand: `PROJECT=outfitter-509211 REGION=us-central1 ./baseline.sh`.
#
# Run this before api.sh and agent-job.sh; both assume the service accounts and AR repo it creates.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
AR_REPO="${AR_REPO:-outfitter}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-01DEC0-9358E1-C1FF0D}"
BUDGET_AMOUNT_USD="${BUDGET_AMOUNT_USD:-25}"
BUDGET_DISPLAY_NAME="${BUDGET_DISPLAY_NAME:-outfitter-monthly}"

API_SA="outfitter-api"
AGENT_SA="outfitter-agent"
API_SA_EMAIL="${API_SA}@${PROJECT}.iam.gserviceaccount.com"
AGENT_SA_EMAIL="${AGENT_SA}@${PROJECT}.iam.gserviceaccount.com"

echo "== Outfitter baseline: project=${PROJECT} region=${REGION} =="

echo "-- Enabling APIs (run, artifactregistry, secretmanager, iap, cloudscheduler, cloudbuild, pubsub, iamcredentials, billingbudgets, cloudresourcemanager, iam) --"
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
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com \
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

# The public landing page must not run as the default Compute account (project Editor) or as
# outfitter-api (secrets and run.developer). No project roles: nginx only writes stdout, which the
# Cloud Run service agent ships. ci-setup.sh lets outfitter-deployer act as this account.
echo "-- Service account: kernal-web@${PROJECT}.iam.gserviceaccount.com (no project roles) --"
create_service_account "kernal-web" "kernal.one landing page (static, no project roles)"

# add-iam-policy-binding is itself idempotent (re-adding an existing binding is a no-op), so these
# don't need their own existence checks.

# secretmanager.secretAccessor is granted below by secret-scope.sh, limited to outfitter-* secrets.
echo "-- IAM roles for ${API_SA_EMAIL}: run.developer, logging.logWriter --"
for role in roles/run.developer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${API_SA_EMAIL}" \
    --role="${role}" \
    --condition=None \
    --quiet >/dev/null
done

# Operator settings API (routes/operator.ts, src/secrets.ts's GcpSecretAdmin): create a secret the
# first time an operator sets it, add a new version on every Replace, disable all enabled versions
# on Disable, and list/access versions to show the masked value and "next run"/"next deploy" state.
# secretmanager.secretAccessor (granted by secret-scope.sh, below) only covers reading the *latest* version, not any of that.
# No predefined role is both broad enough and this narrow: roles/secretmanager.secretVersionAdder
# can add versions but can't create a secret or disable a version, and
# roles/secretmanager.admin also grants IAM policy changes and secret deletion the API never
# needs. A project-scoped custom role with exactly the permissions used gets both -- create once,
# update in place on re-run (gcloud iam roles create/update is not itself idempotent the way
# add-iam-policy-binding is, hence the describe-first check).
SECRET_ADMIN_ROLE_ID="outfitterSecretAdmin"
SECRET_ADMIN_PERMISSIONS="secretmanager.secrets.create,secretmanager.secrets.get,secretmanager.versions.add,secretmanager.versions.disable,secretmanager.versions.list"
echo "-- Custom IAM role '${SECRET_ADMIN_ROLE_ID}' (create/get secrets, add/disable/list versions -- operator settings API) --"
if gcloud iam roles describe "${SECRET_ADMIN_ROLE_ID}" --project="${PROJECT}" &>/dev/null; then
  gcloud iam roles update "${SECRET_ADMIN_ROLE_ID}" \
    --project="${PROJECT}" \
    --title="Outfitter Secret Admin" \
    --description="Create secrets and add/disable/list versions for the Outfitter operator settings API (routes/operator.ts). Narrower than roles/secretmanager.admin: no secret deletion, no IAM policy changes." \
    --permissions="${SECRET_ADMIN_PERMISSIONS}" \
    --stage=GA \
    --quiet >/dev/null
else
  gcloud iam roles create "${SECRET_ADMIN_ROLE_ID}" \
    --project="${PROJECT}" \
    --title="Outfitter Secret Admin" \
    --description="Create secrets and add/disable/list versions for the Outfitter operator settings API (routes/operator.ts). Narrower than roles/secretmanager.admin: no secret deletion, no IAM policy changes." \
    --permissions="${SECRET_ADMIN_PERMISSIONS}" \
    --stage=GA \
    --quiet >/dev/null
fi

# Both secret roles (secretAccessor and this custom role) are bound only to outfitter-* secrets: the
# LiteLLM router's secrets share this project (#389 IAM check). secret-scope.sh owns those bindings.
echo "-- Secret roles for ${API_SA_EMAIL}, scoped to outfitter-* secrets (secret-scope.sh) --"
"$(dirname "${BASH_SOURCE[0]}")/secret-scope.sh"

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
# The Budgets API is billing-account scoped, so gcloud bills the call to the *quota project*, which
# defaults to the active gcloud config project (possibly an unrelated one). Pin it to this project,
# where billingbudgets.googleapis.com was enabled above.
existing_budget="$(gcloud billing budgets list --billing-account="${BILLING_ACCOUNT}" --billing-project="${PROJECT}" \
  --format='value(displayName)' 2>/dev/null | grep -Fx "${BUDGET_DISPLAY_NAME}" || true)"
if [[ -n "${existing_budget}" ]]; then
  echo "   '${BUDGET_DISPLAY_NAME}' already exists, skipping (edit amount/thresholds in the console if they've changed)"
else
  gcloud billing budgets create \
    --billing-account="${BILLING_ACCOUNT}" \
    --billing-project="${PROJECT}" \
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
Custom role:            projects/${PROJECT}/roles/${SECRET_ADMIN_ROLE_ID} (bound to ${API_SA_EMAIL},
                        for the operator settings API -- see docs/reports/operators.md)

Next: create the Atlas cluster and the four Secret Manager secrets by hand (see README.md), then
run api.sh and agent-job.sh. Set OUTFITTER_OPERATORS before running api.sh if the default operator
list (mgm@mgms.eu;matej@mgms.eu) isn't right for this deployment.
SUMMARY
