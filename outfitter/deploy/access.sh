#!/usr/bin/env bash
# Who can reach Outfitter's two Cloud Run services. Split out of service.sh so a routine deploy
# (release.sh, GitHub Actions) never touches access: run this by hand, as a project owner, after the
# first deploy of a service and whenever IAP_MEMBERS or the OAuth client in config.env changes.
# Idempotent.
#   ./access.sh
#
# - outfitter-link: public (--allow-unauthenticated). It authenticates every request itself
#   (agent tokens, personal API tokens, OIDC on the hooks); see docs/protocol.md "Two origins".
# - outfitter-api: IAP on, no unauthenticated invoker, the IAP service agent allowed to invoke it,
#   IAP pointed at the custom OAuth client, and each IAP_MEMBERS entry granted
#   roles/iap.httpsResourceAccessor.
#
# This only ever ADDS IAP members. Removing someone is README.md Rollback -> "IAP access" (the
# gcloud remove command, then revoking their API tokens).
#
# Docs consulted:
# - IAP directly on Cloud Run (--iap) and the IAP service agent's run.invoker binding:
#   https://cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run
# - A custom OAuth client for members outside the org:
#   https://cloud.google.com/iap/docs/custom-oauth-configuration
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
WEB_SERVICE="outfitter-api"
LINK_SERVICE="outfitter-link"

IFS=',' read -ra IAP_MEMBER_LIST <<<"${IAP_MEMBERS}"
for member in "${IAP_MEMBER_LIST[@]}"; do
  # Only named principals: a typo'd or pasted allUsers/allAuthenticatedUsers would open the app to
  # every Google account, since the custom OAuth client accepts accounts outside the org.
  if [[ ! "${member}" =~ ^(user|group|domain):[^[:space:]]+$ ]]; then
    deploy_fail "IAP_MEMBERS entry '${member}' is not user:, group: or domain:"
  fi
done

# `gcloud run services update` has no --[no-]allow-unauthenticated; that flag is just the allUsers
# run.invoker binding, managed directly here.
has_public_invoker() {
  gcloud run services get-iam-policy "$1" --project="${PROJECT}" --region="${REGION}" \
    --flatten='bindings[].members' \
    --filter='bindings.role=roles/run.invoker AND bindings.members=allUsers' \
    --format='value(bindings.members)' | grep -qx allUsers
}

echo "== ${LINK_SERVICE}: allow unauthenticated invocation (it authenticates requests itself) =="
gcloud run services add-iam-policy-binding "${LINK_SERVICE}" --project="${PROJECT}" --region="${REGION}" \
  --member=allUsers --role=roles/run.invoker --quiet >/dev/null

echo "== ${WEB_SERVICE}: IAP on, unauthenticated invocation off =="
gcloud run services update "${WEB_SERVICE}" --project="${PROJECT}" --region="${REGION}" --iap --quiet >/dev/null
if has_public_invoker "${WEB_SERVICE}"; then
  gcloud run services remove-iam-policy-binding "${WEB_SERVICE}" --project="${PROJECT}" --region="${REGION}" \
    --member=allUsers --role=roles/run.invoker --quiet >/dev/null
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
echo "== Granting the IAP service agent roles/run.invoker on ${WEB_SERVICE} =="
gcloud run services add-iam-policy-binding "${WEB_SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
  --role="roles/run.invoker" \
  --quiet >/dev/null

if [[ -n "${IAP_OAUTH_CLIENT_ID}" ]]; then
  echo "== Pointing IAP on ${WEB_SERVICE} at custom OAuth client ${IAP_OAUTH_CLIENT_ID} =="
  IAP_OAUTH_CLIENT_SECRET="$(gcloud secrets versions access latest --secret=outfitter-iap-oauth-client-secret --project="${PROJECT}")"
  if [[ -z "${IAP_OAUTH_CLIENT_SECRET}" ]]; then
    deploy_fail "secret outfitter-iap-oauth-client-secret is empty; not touching IAP's OAuth settings"
  fi
  q="'"   # YAML single-quoted scalar: a literal ' is written as ''
  IAP_OAUTH_CLIENT_SECRET_YAML="${IAP_OAUTH_CLIENT_SECRET//${q}/${q}${q}}"
  IAP_SETTINGS_FILE="$(mktemp)"   # 0600; holds the client secret only until gcloud has read it
  trap 'rm -f "${IAP_SETTINGS_FILE}"' EXIT INT TERM
  cat >"${IAP_SETTINGS_FILE}" <<YAML
accessSettings:
  oauthSettings:
    clientId: ${IAP_OAUTH_CLIENT_ID}
    clientSecret: '${IAP_OAUTH_CLIENT_SECRET_YAML}'
YAML
  gcloud iap settings set "${IAP_SETTINGS_FILE}" \
    --resource-type=cloud-run \
    --service="${WEB_SERVICE}" \
    --region="${REGION}" \
    --project="${PROJECT}" >/dev/null
fi

for member in "${IAP_MEMBER_LIST[@]}"; do
  echo "== Granting ${member} roles/iap.httpsResourceAccessor on ${WEB_SERVICE} =="
  gcloud iap web add-iam-policy-binding \
    --resource-type=cloud-run \
    --service="${WEB_SERVICE}" \
    --region="${REGION}" \
    --project="${PROJECT}" \
    --member="${member}" \
    --role="roles/iap.httpsResourceAccessor" >/dev/null
done

echo "== Done. IAP admits: ${IAP_MEMBERS} =="
