#!/usr/bin/env bash
# Checks that the live-test identity gets through IAP (#219): mints an ID token for E2E_SA_NAME
# (audience = IAP_OAUTH_CLIENT_ID, email claim included), calls GET /api/me on the web origin with
# it in Proxy-Authorization, and checks the app saw the account's email. Its only write is the one
# every sign-in makes: GET /api/me records the account in the users store on first use. The caller
# must be one of E2E_TOKEN_MINTERS (e2e-identity.sh).
#   ./iap-probe.sh
#   WEB_ORIGIN=https://app.kernal.one ./iap-probe.sh
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
E2E_SA_EMAIL="${E2E_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
WEB_ORIGIN="${WEB_ORIGIN:-$(deployed_origin outfitter-api)}"
[[ -n "${WEB_ORIGIN}" ]] || deploy_fail "outfitter-api has no OUTFITTER_ORIGIN; set WEB_ORIGIN"

# Its own line, so an expired login stops here (set -e) instead of reading as missing IAM setup.
ACCESS="$(gcloud auth print-access-token)"

# generateIdToken needs only roles/iam.serviceAccountOpenIdTokenCreator, which is all
# e2e-identity.sh grants. `gcloud auth print-identity-token --impersonate-service-account` would
# fetch an access token for the account first, which needs the broader serviceAccountTokenCreator.
# Tokens go to curl on stdin (-H @-), never as arguments `ps` would show.
MINTED="$(printf 'Authorization: Bearer %s\n' "${ACCESS}" | curl -sS -X POST -H @- \
  -H "Content-Type: application/json" \
  -d "{\"audience\":\"${IAP_OAUTH_CLIENT_ID}\",\"includeEmail\":true}" \
  "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${E2E_SA_EMAIL}:generateIdToken")"
TOKEN="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' <<<"${MINTED}" 2>/dev/null || true)"
if [[ -z "${TOKEN}" ]]; then
  echo "${MINTED}" | head -c 600 >&2; echo >&2
  deploy_fail "could not mint an ID token for ${E2E_SA_EMAIL}; has e2e-identity.sh run (bindings take a few minutes), and is ${ACCOUNT} in E2E_TOKEN_MINTERS?"
fi

BODY="$(mktemp)"
trap 'rm -f "${BODY}"' EXIT
STATUS="$(printf 'Proxy-Authorization: Bearer %s\n' "${TOKEN}" | curl -sS -o "${BODY}" -w '%{http_code}' -H @- "${WEB_ORIGIN}/api/me")"
echo "GET ${WEB_ORIGIN}/api/me as ${E2E_SA_EMAIL} -> ${STATUS}"
head -c 400 "${BODY}"; echo
SEEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("email",""))' "${BODY}" 2>/dev/null || true)"
if [[ "${STATUS}" == 200 && "${SEEN}" == "${E2E_SA_EMAIL}" ]]; then
  echo "== OK: IAP admitted the live-test identity =="
else
  deploy_fail "IAP did not admit ${E2E_SA_EMAIL} (expected 200 with its email)"
fi
