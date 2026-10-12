#!/usr/bin/env bash
# billing-export.sh against a fake gcloud and bq that keep the enabled services, the project IAM
# policy and the dataset in files. Checks: DRY_RUN changes nothing and prints the console link and
# table name; the first run enables both APIs, creates the dataset in US, adds a dataset READER and
# roles/bigquery.jobUser per operator; a rerun changes nothing; a dataset in another location is
# refused; a bq error other than "not found" stops before any write; BILLING_EXPORT_READERS overrides
# the operators. No network, no GCP.
#   bash outfitter/deploy/test/billing-export.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../billing-export.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
export HOME="${WORK}/home"; mkdir -p "${HOME}"
export STATE="${WORK}/state"

reset() {
  rm -rf "${STATE}"; mkdir -p "${STATE}"
  echo '{"bindings":[{"role":"roles/owner","members":["user:mgm@mgms.eu"]}]}' >"${STATE}/iam.json"
  : >"${STATE}/services"; : >"${STATE}/calls"
}
reset

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
# Mutating calls are logged to ${STATE}/calls; reads are not.
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "services list"*) cat "${STATE}/services" ;;
  "services enable "*)
    echo "$*" >>"${STATE}/calls"
    for a in "$@"; do if [[ "$a" == *.googleapis.com ]]; then echo "$a" >>"${STATE}/services"; fi; done ;;
  "projects get-iam-policy "*) cat "${STATE}/iam.json" ;;
  "projects add-iam-policy-binding "*)
    echo "$*" >>"${STATE}/calls"
    [[ "$*" == *--condition=None* ]] || { echo "fake gcloud: binding without --condition=None" >&2; exit 1; }
    member="" role=""
    for a in "$@"; do case "$a" in --member=*) member="${a#--member=}" ;; --role=*) role="${a#--role=}" ;; esac; done
    jq --arg m "${member}" --arg r "${role}" '.bindings += [{role: $r, members: [$m]}]' "${STATE}/iam.json" >"${STATE}/iam.tmp"
    mv "${STATE}/iam.tmp" "${STATE}/iam.json" ;;
  "billing projects describe "*) echo "billingAccounts/01DEC0-9358E1-C1FF0D" ;;
  *) echo "fake gcloud: unexpected $*" >&2; exit 1 ;;
esac
SH
cat >"${WORK}/bin/bq" <<'SH'
#!/usr/bin/env bash
[[ "$*" == *--project_id=outfitter-509211* ]] || { echo "fake bq: no --project_id: $*" >&2; exit 1; }
case "$1" in
  show)
    [[ -f "${STATE}/bq-error" ]] && { cat "${STATE}/bq-error" >&2; exit 1; }
    [[ -f "${STATE}/dataset.json" ]] || { echo "BigQuery error in show operation: Not found: Dataset outfitter-509211:billing_export" >&2; exit 2; }
    cat "${STATE}/dataset.json" ;;
  mk)
    echo "bq $*" >>"${STATE}/calls"
    [[ "$*" == *--dataset* && "$*" == *--location=US* ]] || { echo "fake bq: bad mk: $*" >&2; exit 1; }
    echo '{"location":"US","access":[{"role":"OWNER","userByEmail":"mgm@mgms.eu"}]}' >"${STATE}/dataset.json" ;;
  update)
    echo "bq $*" >>"${STATE}/calls"
    for a in "$@"; do if [[ "$a" == --source=* ]]; then f="${a#--source=}"; fi; done
    cp "${f}" "${STATE}/dataset.json" ;;
  *) echo "fake bq: unexpected $*" >&2; exit 1 ;;
esac
SH
chmod +x "${WORK}/bin/gcloud" "${WORK}/bin/bq"
export PATH="${WORK}/bin:${PATH}"
unset GITHUB_ACTIONS DRY_RUN BILLING_EXPORT_READERS BILLING_EXPORT_DATASET BILLING_EXPORT_LOCATION

fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "${SCRIPT}" >"${WORK}/out" 2>&1 || { cat "${WORK}/out"; fail "script exited non-zero"; }; }
calls() { wc -l <"${STATE}/calls" | tr -d ' '; }
reader() { jq -e --arg e "$1" '[.access[] | select(.role == "READER" and .userByEmail == $e)] | length == 1' "${STATE}/dataset.json" >/dev/null; }
job() { jq -e --arg m "user:$1" '[.bindings[] | select(.role == "roles/bigquery.jobUser" and (.members | index($m)))] | length == 1' "${STATE}/iam.json" >/dev/null; }

# DRY_RUN: nothing mutated; the plan, the console link and the table name are printed.
DRY_RUN=1 run
[[ "$(calls)" == 0 ]] || fail "DRY_RUN mutated: $(cat "${STATE}/calls")"
grep -q "+ enable bigquerydatatransfer.googleapis.com" "${WORK}/out" || fail "plan lacks the API enable"
grep -q "+ create dataset outfitter-509211:billing_export in US" "${WORK}/out" || fail "plan lacks the dataset"
grep -q "+ matej@mgms.eu: dataset READER on billing_export" "${WORK}/out" || fail "plan lacks a READER"
grep -q "+ matej@mgms.eu: grant roles/bigquery.jobUser" "${WORK}/out" || fail "plan lacks the job role"
grep -q "https://console.cloud.google.com/billing/01DEC0-9358E1-C1FF0D/export" "${WORK}/out" || fail "no console link"
grep -q "billing_export.gcp_billing_export_v1_01DEC0_9358E1_C1FF0D" "${WORK}/out" || fail "no table name"

# First run.
run
grep -q "services enable bigquery.googleapis.com bigquerydatatransfer.googleapis.com" "${STATE}/calls" || fail "APIs not enabled: $(cat "${STATE}/calls")"
[[ "$(head -1 "${STATE}/calls")" == "services enable"* ]] || fail "the APIs weren't enabled before the dataset was touched"
jq -e '.location == "US"' "${STATE}/dataset.json" >/dev/null || fail "dataset not in US"
reader matej@mgms.eu || fail "matej@mgms.eu not a dataset READER"
# mgm@ already owns the dataset (its creator): no READER entry on top, and the OWNER entry is kept.
! reader mgm@mgms.eu || fail "added a READER for the dataset's OWNER"
jq -e '[.access[] | select(.role == "OWNER" and .userByEmail == "mgm@mgms.eu")] | length == 1' "${STATE}/dataset.json" >/dev/null || fail "the update dropped the existing OWNER entry"
for who in mgm@mgms.eu matej@mgms.eu; do job "${who}" || fail "${who} lacks roles/bigquery.jobUser"; done
[[ "$(calls)" == 5 ]] || fail "expected 5 mutating calls (enable, mk, update, 2 grants), got $(calls): $(cat "${STATE}/calls")"

# Rerun: nothing.
before="$(calls)"
run
[[ "$(calls)" == "${before}" ]] || fail "rerun mutated: $(tail -n +$((before + 1)) "${STATE}/calls")"
grep -q "~ dataset outfitter-509211:billing_export exists (US)" "${WORK}/out" || fail "rerun didn't see the dataset"

# BILLING_EXPORT_READERS overrides the operators; one new reader adds exactly one entry.
BILLING_EXPORT_READERS="new@example.com" run
reader new@example.com || fail "new@example.com not a READER"
job new@example.com || fail "new@example.com lacks the job role"
BILLING_EXPORT_READERS="not-an-email" bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "accepted a bad reader"

# A dataset in another location is refused before any write.
reset
echo "bigquery.googleapis.com" >"${STATE}/services"; echo "bigquerydatatransfer.googleapis.com" >>"${STATE}/services"
echo '{"location":"EU","access":[]}' >"${STATE}/dataset.json"
bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "accepted a dataset in EU"
grep -q "exists in EU, not US" "${WORK}/out" || { cat "${WORK}/out"; fail "wrong message for the location"; }
[[ "$(calls)" == 0 ]] || fail "wrote despite the wrong location"

# A bq error that isn't "not found" (a permission error) stops: never a blind create.
reset
echo "bigquery.googleapis.com" >"${STATE}/services"; echo "bigquerydatatransfer.googleapis.com" >>"${STATE}/services"
echo "BigQuery error in show operation: Access Denied: Dataset outfitter-509211:billing_export" >"${STATE}/bq-error"
bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "a bq permission error didn't fail the run"
grep -q "Access Denied" "${WORK}/out" || fail "the bq error wasn't shown"
[[ "$(calls)" == 0 ]] || fail "wrote after a bq error"

# A bad dataset id is refused.
BILLING_EXPORT_DATASET="a-b" DRY_RUN=1 bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "accepted a bad dataset id"

echo "billing-export.test.sh: ok"
