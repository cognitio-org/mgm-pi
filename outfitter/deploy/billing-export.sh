#!/usr/bin/env bash
# The BigQuery side of Cloud Billing export (actual spend for the google_cloud toolset). Run by hand,
# as the owner. Idempotent.
#   DRY_RUN=1 ./billing-export.sh     # read the current state, print the plan, change nothing
#   ./billing-export.sh               # do it
#
# Neither Cloud Billing API reports spend; the export is the only machine-readable source, and an
# agent reads it with `run_bq_command` (docs/runbooks/gcloud-mcp.md, "Billing export").
#
# What it does, in order:
# 1. Enables bigquery.googleapis.com and bigquerydatatransfer.googleapis.com (billing export needs
#    both on the project that holds the dataset).
# 2. Creates the dataset BILLING_EXPORT_DATASET (default billing_export) in BILLING_EXPORT_LOCATION
#    (default US, a multi-region). An existing dataset in another location is an error: a dataset
#    can't move, and the export's location is fixed by it.
# 3. Gives each reader READER on that dataset only (not the project's other datasets), and
#    roles/bigquery.jobUser on the project so their queries can run. Readers default to
#    OUTFITTER_OPERATORS (config.env, ';'-separated); BILLING_EXPORT_READERS overrides it.
#
# What it can't do: switch the export on. Google offers no API for that, only the console (Billing,
# Billing export, BigQuery export, "Standard usage cost", pick this project and dataset). The script
# prints the link and the table name the export will write.
#
# Needs, on the owner account: roles/resourcemanager.projectIamAdmin, BigQuery admin on the project
# (Owner covers both), serviceusage.services.enable, and billing.accounts.get on the billing account
# (for the link; without it the link is printed with a placeholder).
# Docs: https://cloud.google.com/billing/docs/how-to/export-data-bigquery-setup
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

DRY_RUN="${DRY_RUN:-0}"
DATASET="${BILLING_EXPORT_DATASET:-billing_export}"
LOCATION="${BILLING_EXPORT_LOCATION:-US}"
READERS="${BILLING_EXPORT_READERS:-${OUTFITTER_OPERATORS:-}}"
JOB_ROLE="roles/bigquery.jobUser"
APIS=(bigquery.googleapis.com bigquerydatatransfer.googleapis.com)

command -v jq >/dev/null || deploy_fail "jq is required"
command -v bq >/dev/null || deploy_fail "bq is required (it ships with the Google Cloud SDK)"
# No {m,n} bound: macOS's bash 3.2 regex rejects counts over 255 (so nothing would ever match).
[[ "${DATASET}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && ${#DATASET} -le 1024 ]] || deploy_fail "BILLING_EXPORT_DATASET=${DATASET} isn't a BigQuery dataset id"
[[ "${LOCATION}" =~ ^[A-Za-z0-9-]+$ ]] || deploy_fail "BILLING_EXPORT_LOCATION=${LOCATION} isn't a location"

EMAILS=()
IFS=';,' read -ra raw <<<"${READERS}"
for e in ${raw[@]+"${raw[@]}"}; do
  e="${e//[[:space:]]/}"
  [[ -z "${e}" ]] && continue
  [[ "${e}" =~ ^[^@:]+@[^@:]+\.[^@:]+$ ]] || deploy_fail "'${e}' is not an email address (BILLING_EXPORT_READERS / OUTFITTER_OPERATORS)"
  EMAILS+=("${e}")
done
(( ${#EMAILS[@]} > 0 )) || deploy_fail "no readers: set BILLING_EXPORT_READERS or OUTFITTER_OPERATORS"

# Lower-case without bash 4's case-change expansion: macOS ships bash 3.2.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

REF="${PROJECT}:${DATASET}"
echo "dataset=${REF} location=${LOCATION}"
echo "readers: ${EMAILS[*]}"

# 1. APIs.
enabled="$(gcloud services list --enabled --project="${PROJECT}" --format='value(config.name)')"
missing_apis=()
for api in "${APIS[@]}"; do
  if grep -qx "${api}" <<<"${enabled}"; then echo "~ ${api} enabled"; else echo "+ enable ${api}"; missing_apis+=("${api}"); fi
done
# A real run enables them first, so the dataset below is read with the API on.
if [[ "${DRY_RUN}" != 1 ]] && (( ${#missing_apis[@]} > 0 )); then
  gcloud services enable "${missing_apis[@]}" --project="${PROJECT}"
fi

# 2. Dataset: absent, or present in the right location. Only "Not found" reads as absent; any other
# error (permissions, the API off) stops here rather than trying to create over it.
dataset_json=""
if out="$(bq show --format=json --project_id="${PROJECT}" "${REF}" 2>&1)"; then
  dataset_json="${out}"
  have="$(jq -r '.location // empty' <<<"${dataset_json}")"
  [[ "$(lower "${have}")" == "$(lower "${LOCATION}")" ]] \
    || deploy_fail "${REF} exists in ${have:-an unknown location}, not ${LOCATION}; set BILLING_EXPORT_LOCATION=${have} or pick another BILLING_EXPORT_DATASET"
  echo "~ dataset ${REF} exists (${have})"
elif grep -qi "not found" <<<"${out}"; then
  echo "+ create dataset ${REF} in ${LOCATION}"
elif (( ${#missing_apis[@]} > 0 )) && [[ "${DRY_RUN}" == 1 ]]; then
  # The BigQuery API is off, so nothing can be read yet; the real run enables it first.
  echo "? dataset ${REF}: unknown until the BigQuery API is on (will be created if absent)"
else
  deploy_fail "bq show ${REF} failed: ${out}"
fi

# 3. Access: dataset READER entries and the project job role.
has_reader() {
  [[ -n "${dataset_json}" ]] && jq -e --arg e "$1" \
    '[.access[]? | select((.role == "READER" or .role == "roles/bigquery.dataViewer" or .role == "WRITER" or .role == "OWNER") and (.userByEmail // "" | ascii_downcase) == ($e | ascii_downcase))] | length > 0' \
    <<<"${dataset_json}" >/dev/null
}
iam="$(gcloud projects get-iam-policy "${PROJECT}" --format=json)"
has_job_role() {
  jq -e --arg r "${JOB_ROLE}" --arg m "user:$1" \
    '[.bindings[]? | select(.role == $r and (.condition == null) and (.members | index($m)))] | length > 0' <<<"${iam}" >/dev/null
}
for e in "${EMAILS[@]}"; do
  if has_reader "${e}"; then echo "~ ${e}: dataset READER already"; else echo "+ ${e}: dataset READER on ${DATASET}"; fi
  if has_job_role "${e}"; then echo "~ ${e}: ${JOB_ROLE} already"; else echo "+ ${e}: grant ${JOB_ROLE}"; fi
done

# The billing account, for the console link and the table name (best effort: a read only).
account="$(gcloud billing projects describe "${PROJECT}" --format='value(billingAccountName)' 2>/dev/null || true)"
account="${account#billingAccounts/}"
[[ "${account}" =~ ^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$ ]] || account=""

next_steps() {
  local id="${account:-<BILLING_ACCOUNT_ID>}"
  echo "Next, in the console (no API for this): https://console.cloud.google.com/billing/${id}/export"
  echo "  BigQuery export, Standard usage cost, Edit settings: project ${PROJECT}, dataset ${DATASET}. Save."
  echo "  Data starts arriving within a day as table ${DATASET}.gcp_billing_export_v1_${id//-/_}."
}

if [[ "${DRY_RUN}" == 1 ]]; then
  echo "DRY_RUN=1: no changes."
  next_steps
  exit 0
fi

if [[ -z "${dataset_json}" ]]; then
  bq mk --dataset --location="${LOCATION}" --project_id="${PROJECT}" \
    --description="Cloud Billing export (Standard usage cost). Read by operators through run_bq_command." "${REF}" >/dev/null
  dataset_json="$(bq show --format=json --project_id="${PROJECT}" "${REF}")"
fi

todo=()
for e in "${EMAILS[@]}"; do has_reader "${e}" || todo+=("${e}"); done
if (( ${#todo[@]} > 0 )); then
  file="$(mktemp)"
  register_cleanup "${file}"
  # The whole dataset resource with the new entries appended; bq update --source replaces .access.
  jq --args '.access = ((.access // []) + [$ARGS.positional[] | {role: "READER", userByEmail: .}])' "${todo[@]}" \
    <<<"${dataset_json}" >"${file}"
  bq update --source="${file}" --project_id="${PROJECT}" "${REF}" >/dev/null
fi

for e in "${EMAILS[@]}"; do
  has_job_role "${e}" && continue
  gcloud projects add-iam-policy-binding "${PROJECT}" --member="user:${e}" --role="${JOB_ROLE}" \
    --condition=None --quiet >/dev/null
done

echo "Done: ${REF} is ready for the export."
next_steps
