#!/usr/bin/env bash
# The identity live tests use to reach outfitter-api through IAP without a person signing in (#219).
# Run by hand, as a project owner, like access.sh. Idempotent.
#   ./e2e-identity.sh
#   DRY_RUN=1 ./e2e-identity.sh   # print what would change, change nothing
#
# - Creates the E2E_SA_NAME service account, with no project roles and no keys.
# - Grants it roles/iap.httpsResourceAccessor on outfitter-api, so IAP admits its ID tokens. Kept
#   out of IAP_MEMBERS on purpose: access.sh only accepts user:/group:/domain: there, so a pasted
#   allUsers can't slip in.
# - Grants each E2E_TOKEN_MINTERS principal roles/iam.serviceAccountOpenIdTokenCreator on that one
#   account, so it can mint the account's ID tokens (gcloud auth print-identity-token
#   --impersonate-service-account). That is all it can do as the account: no access tokens.
#
# A test then sends `Proxy-Authorization: Bearer <id token>`, audience = IAP_OAUTH_CLIENT_ID with
# the email claim included (iap-probe.sh shows how), and the app sees the account's email as the
# signed-in user: not a sysop, owner only of what it creates.
#
# Docs: https://cloud.google.com/iap/docs/authentication-howto (a service account's OIDC token,
# audience = the OAuth client ID, accepted in Proxy-Authorization).
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
WEB_SERVICE="outfitter-api"
E2E_SA_EMAIL="${E2E_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

# run <cmd...> -- execute, or with DRY_RUN=1 print it instead (gke-cluster.sh's convention). The
# print goes to stderr: the callers send gcloud's own output to /dev/null.
run() {
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    { printf '   DRY_RUN:'; printf ' %q' "$@"; printf '\n'; } >&2
  else
    "$@"
  fi
}

IFS=',' read -ra MINTERS <<<"${E2E_TOKEN_MINTERS}"
for minter in "${MINTERS[@]}"; do
  if [[ ! "${minter}" =~ ^(user|group|serviceAccount):[^[:space:]]+$ ]]; then
    deploy_fail "E2E_TOKEN_MINTERS entry '${minter}' is not user:, group: or serviceAccount:"
  fi
done

echo "== Service account ${E2E_SA_EMAIL} =="
if gcloud_exists iam service-accounts describe "${E2E_SA_EMAIL}" --project="${PROJECT}"; then
  echo "   exists"
else
  run gcloud iam service-accounts create "${E2E_SA_NAME}" --project="${PROJECT}" \
    --display-name="Outfitter live tests" \
    --description="Signs in to outfitter-api through IAP for automated live tests (#219). No project roles." >/dev/null
fi

echo "== Granting ${E2E_SA_EMAIL} roles/iap.httpsResourceAccessor on ${WEB_SERVICE} =="
run gcloud iap web add-iam-policy-binding \
  --resource-type=cloud-run \
  --service="${WEB_SERVICE}" \
  --region="${REGION}" \
  --project="${PROJECT}" \
  --member="serviceAccount:${E2E_SA_EMAIL}" \
  --role="roles/iap.httpsResourceAccessor" >/dev/null

for minter in "${MINTERS[@]}"; do
  echo "== Letting ${minter} mint ID tokens for ${E2E_SA_EMAIL} =="
  run gcloud iam service-accounts add-iam-policy-binding "${E2E_SA_EMAIL}" \
    --project="${PROJECT}" \
    --member="${minter}" \
    --role="roles/iam.serviceAccountOpenIdTokenCreator" \
    --quiet >/dev/null
done

echo "== Done. Check it with ./iap-probe.sh =="
