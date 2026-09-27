#!/usr/bin/env bash
# Read-only check that the live-test identity gets through IAP (#219): mints an ID token for
# E2E_SA_NAME (audience = IAP_OAUTH_CLIENT_ID, email claim included), calls GET /api/me on the web
# origin with it in Proxy-Authorization, and prints what IAP and the app answered. Changes nothing.
# The caller must be one of E2E_TOKEN_MINTERS (e2e-identity.sh).
#   ./iap-probe.sh
#   WEB_ORIGIN=https://app.kernal.one ./iap-probe.sh
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
E2E_SA_EMAIL="${E2E_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
WEB_ORIGIN="${WEB_ORIGIN:-$(deployed_origin outfitter-api)}"
[[ -n "${WEB_ORIGIN}" ]] || deploy_fail "outfitter-api has no OUTFITTER_ORIGIN; set WEB_ORIGIN"

# generateIdToken needs only roles/iam.serviceAccountOpenIdTokenCreator, which is all
# e2e-identity.sh grants. `gcloud auth print-identity-token --impersonate-service-account` would
# fetch an access token for the account first, which needs the broader serviceAccountTokenCreator.
MINTED="$(curl -sS -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d "{\"audience\":\"${IAP_OAUTH_CLIENT_ID}\",\"includeEmail\":true}" \
  "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${E2E_SA_EMAIL}:generateIdToken")"
TOKEN="$(sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' <<<"${MINTED}")"
if [[ -z "${TOKEN}" ]]; then
  echo "${MINTED}" | head -c 600 >&2; echo >&2
  deploy_fail "could not mint an ID token for ${E2E_SA_EMAIL}; has e2e-identity.sh run, and is ${ACCOUNT} in E2E_TOKEN_MINTERS?"
fi

BODY="$(mktemp)"
trap 'rm -f "${BODY}"' EXIT
STATUS="$(curl -sS -o "${BODY}" -w '%{http_code}' -H "Proxy-Authorization: Bearer ${TOKEN}" "${WEB_ORIGIN}/api/me")"
echo "GET ${WEB_ORIGIN}/api/me as ${E2E_SA_EMAIL} -> ${STATUS}"
head -c 400 "${BODY}"; echo
if [[ "${STATUS}" == 200 ]] && grep -q "\"email\":\"${E2E_SA_EMAIL}\"" "${BODY}"; then
  echo "== OK: IAP admitted the live-test identity =="
else
  deploy_fail "IAP did not admit ${E2E_SA_EMAIL} (expected 200 with its email)"
fi
