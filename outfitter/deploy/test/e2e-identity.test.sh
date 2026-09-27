#!/usr/bin/env bash
# e2e-identity.sh against a fake gcloud, with DRY_RUN=1. No network, no GCP. The fake records every
# call; a dry run must never call anything that mutates (create, add-iam-policy-binding).
#   bash outfitter/deploy/test/e2e-identity.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
export HOME="${WORK}/home"
mkdir -p "${HOME}" "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >>"${GCLOUD_CALLS}"
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "iam service-accounts describe"*)
    [[ -n "${FAKE_SA_EXISTS:-}" ]] && exit 0
    echo "ERROR: NOT_FOUND: Unknown service account" >&2; exit 1 ;;
  "iam service-accounts keys list"*) [[ -n "${FAKE_SA_KEY:-}" ]] && echo "projects/p/serviceAccounts/x/keys/k1" ;;
  "projects get-iam-policy"*) [[ -n "${FAKE_SA_ROLE:-}" ]] && echo "${FAKE_SA_ROLE}" ;;
esac
exit 0
FAKE
chmod +x "${WORK}/bin/gcloud"
export PATH="${WORK}/bin:${PATH}" GCLOUD_CALLS="${WORK}/gcloud-calls"
unset GITHUB_ACTIONS FAKE_SA_EXISTS FAKE_SA_KEY FAKE_SA_ROLE E2E_TOKEN_MINTERS E2E_SA_NAME

fails=0
OUT=""
# expect <pass|fail> <description> <pattern> [env=val ...] -- always DRY_RUN=1.
expect() {
  local want="$1" desc="$2" pattern="$3" status=0 problem=""
  shift 3
  : >"${GCLOUD_CALLS}"
  OUT="$(env DRY_RUN=1 "$@" "${HERE}/../e2e-identity.sh" 2>&1)" || status=$?
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
no_mutations() {
  local found
  found="$(grep -E 'create|add-iam-policy-binding' "${GCLOUD_CALLS}" || true)"
  if [[ -z "${found}" ]]; then echo "ok:   $1"; else echo "FAIL:   $1 (${found})"; fails=$((fails + 1)); fi
}

expect fail "a minter that isn't user:/group:/serviceAccount: refuses" "is not user:, group: or serviceAccount:" \
  E2E_TOKEN_MINTERS=allUsers
no_mutations "... and changes nothing"

expect pass "dry run creates the account when it's missing" \
  "DRY_RUN: gcloud iam service-accounts create outfitter-e2e"
no_mutations "a dry run calls no mutation"
expect pass "dry run grants IAP access on outfitter-api only" \
  "DRY_RUN: gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=outfitter-api .*--member=serviceAccount:outfitter-e2e@outfitter-509211.iam.gserviceaccount.com --role=roles/iap.httpsResourceAccessor"
expect pass "dry run lets the default minter mint ID tokens, and nothing broader" \
  "DRY_RUN: gcloud iam service-accounts add-iam-policy-binding outfitter-e2e@outfitter-509211.iam.gserviceaccount.com .*--member=user:mgm@mgms.eu --role=roles/iam.serviceAccountOpenIdTokenCreator"
if grep -q "serviceAccountTokenCreator\|projects add-iam-policy-binding" <<<"${OUT}"; then
  echo "FAIL:   never grants access-token minting or a project role"; fails=$((fails + 1))
else
  echo "ok:   never grants access-token minting or a project role"
fi

FAKE_SA_EXISTS=1 expect pass "an existing account is left alone" "   exists"
if grep -q "service-accounts create" <<<"${OUT}"; then
  echo "FAIL:   ... and isn't created again"; fails=$((fails + 1))
else
  echo "ok:   ... and isn't created again"
fi

expect pass "several minters each get the binding" \
  "--member=group:outfitter-testers@example.com" \
  E2E_TOKEN_MINTERS=user:mgm@mgms.eu,group:outfitter-testers@example.com

FAKE_SA_EXISTS=1 FAKE_SA_KEY=1 expect fail "an existing account with a user-managed key refuses" "has user-managed keys"
no_mutations "... and changes nothing"
FAKE_SA_EXISTS=1 FAKE_SA_ROLE=roles/editor expect fail "an existing account with a project role refuses" "holds project roles (roles/editor)"
no_mutations "... and changes nothing"

if [[ ${fails} -gt 0 ]]; then
  echo "${fails} failure(s)"; exit 1
fi
echo "all passed"
