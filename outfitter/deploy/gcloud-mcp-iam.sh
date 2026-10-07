#!/usr/bin/env bash
# Google-side IAM for the remote gcloud MCP server (epic #497, GA-5 #495). Run by hand, as the
# owner. Idempotent.
#   GCLOUD_MCP_OAUTH_CLIENT_ID=<router client id> ./gcloud-mcp-iam.sh
#   DRY_RUN=1 ./gcloud-mcp-iam.sh     # read the current state, print the plan, change nothing
#
# What it does, in order:
# 1. Enables the Cloud CLI Execution API (cloudcli.googleapis.com); that is what switches on
#    https://cloudcli.googleapis.com/mcp for the project.
# 2. Grants roles/mcp.toolUser (permission mcp.tools.call) on the project to each sysop, on top of
#    their normal roles. The commands then run as that person, so their own IAM decides what works.
#    Sysops default to OUTFITTER_OPERATORS (config.env, ';'-separated); GCLOUD_MCP_SYSOPS overrides
#    it (';' or ',' separated emails).
# 3. Creates or updates the IAM deny policy "gcloud-mcp-gateway-only" on the project: it denies
#    mcp.googleapis.com/tools.call to every principal unless request.auth.oauth.client_id is the
#    router's Google OAuth client. MCP use then only goes through the gateway (approval cards, audit);
#    a token minted for any other client (the gcloud CLI, a stray Inspector) is refused.
#    request.auth.oauth.client_id is supported in deny policies only, not allow policies.
#    The deny covers every Google remote MCP server in the project, not just gcloud's, so the
#    follow-on per-service servers (logging., monitoring., ...) must use the same OAuth client.
#
# Needs, on the owner account: roles/resourcemanager.projectIamAdmin (grants), roles/iam.denyAdmin
# (deny policies; not part of Owner) and serviceusage.services.enable. Missing denyAdmin shows as
# PERMISSION_DENIED on step 3: grant it to yourself on the project, rerun, and remove it after.
# Docs: https://docs.cloud.google.com/sdk/use-gcloud-mcp
#       https://docs.cloud.google.com/mcp/control-mcp-use-iam
#       https://cloud.google.com/iam/docs/deny-access
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

DRY_RUN="${DRY_RUN:-0}"
CLIENT_ID="${GCLOUD_MCP_OAUTH_CLIENT_ID:-}"
SYSOPS="${GCLOUD_MCP_SYSOPS:-${OUTFITTER_OPERATORS:-}}"
POLICY_ID="gcloud-mcp-gateway-only"
ATTACH="cloudresourcemanager.googleapis.com/projects/${PROJECT}"
TOOL_ROLE="roles/mcp.toolUser"
DENIED_PERMISSION="mcp.googleapis.com/tools.call"

command -v jq >/dev/null || deploy_fail "jq is required"

if [[ -z "${CLIENT_ID}" ]]; then
  [[ "${DRY_RUN}" == 1 ]] || deploy_fail "GCLOUD_MCP_OAUTH_CLIENT_ID is required (the router's Google OAuth client id, <n>-<x>.apps.googleusercontent.com); a deny policy built on a wrong id would lock everyone out of the MCP server"
  CLIENT_ID="<GCLOUD_MCP_OAUTH_CLIENT_ID>"
elif [[ ! "${CLIENT_ID}" =~ ^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$ ]]; then
  deploy_fail "GCLOUD_MCP_OAUTH_CLIENT_ID=${CLIENT_ID} doesn't look like a Google OAuth client id"
fi

MEMBERS=()
IFS=';,' read -ra emails <<<"${SYSOPS}"
for e in "${emails[@]}"; do
  e="${e//[[:space:]]/}"
  [[ -z "${e}" ]] && continue
  [[ "${e}" =~ ^[^@:]+@[^@:]+\.[^@:]+$ ]] || deploy_fail "'${e}' is not an email address (GCLOUD_MCP_SYSOPS / OUTFITTER_OPERATORS)"
  MEMBERS+=("user:${e}")
done
(( ${#MEMBERS[@]} > 0 )) || deploy_fail "no sysops: set GCLOUD_MCP_SYSOPS or OUTFITTER_OPERATORS"

# The deny rule. The condition is true (the deny applies) for every client except ours.
EXPR="!(request.auth.oauth.client_id == '${CLIENT_ID}')"
RULES="$(jq -nc --arg e "${EXPR}" --arg p "${DENIED_PERMISSION}" '[{denyRule: {
  deniedPrincipals: ["principalSet://goog/public:all"],
  deniedPermissions: [$p],
  denialCondition: {title: "Allow MCP tool use only by the router OAuth client", expression: $e}}}]')"

echo "project=${PROJECT} client=${CLIENT_ID} policy=${POLICY_ID} (${ATTACH})"
echo "sysops: ${MEMBERS[*]}"

# 1. The API.
api_on=no
if gcloud services list --enabled --project="${PROJECT}" --filter="config.name=cloudcli.googleapis.com" \
    --format='value(config.name)' | grep -qx cloudcli.googleapis.com; then api_on=yes; fi
echo "cloudcli.googleapis.com enabled: ${api_on}"

# 2. Current grants.
iam="$(gcloud projects get-iam-policy "${PROJECT}" --format=json)"
has_grant() {
  jq -e --arg r "${TOOL_ROLE}" --arg m "$1" \
    '[.bindings[]? | select(.role == $r and (.condition == null) and (.members | index($m)))] | length > 0' <<<"${iam}" >/dev/null
}
for m in "${MEMBERS[@]}"; do
  if has_grant "${m}"; then echo "~ ${m}: ${TOOL_ROLE} already granted"; else echo "+ ${m}: grant ${TOOL_ROLE}"; fi
done

# 3. Current deny policy: absent, same rules, or different rules.
deny_state=create
etag=""
if gcloud_exists iam policies get "${POLICY_ID}" --attachment-point="${ATTACH}" --kind=denypolicies; then
  current="$(gcloud iam policies get "${POLICY_ID}" --attachment-point="${ATTACH}" --kind=denypolicies --format=json)"
  etag="$(jq -r '.etag // empty' <<<"${current}")"
  # Compare only what we set; the API adds uid/timestamps and may reorder keys.
  if [[ "$(jq -cS '[.rules[]? | {denyRule: {deniedPrincipals: .denyRule.deniedPrincipals, deniedPermissions: .denyRule.deniedPermissions, denialCondition: {title: .denyRule.denialCondition.title, expression: .denyRule.denialCondition.expression}}}]' <<<"${current}")" \
        == "$(jq -cS . <<<"${RULES}")" ]]; then
    deny_state=same
  else
    deny_state=update
  fi
fi
case "${deny_state}" in
  create) echo "+ deny policy ${POLICY_ID}: create" ;;
  update) echo "+ deny policy ${POLICY_ID}: update (rules differ)" ;;
  same)   echo "~ deny policy ${POLICY_ID}: already up to date" ;;
esac
echo "deny rule: $(jq -c . <<<"${RULES}")"

if [[ "${DRY_RUN}" == 1 ]]; then
  [[ "${api_on}" == yes ]] || echo "plan: gcloud services enable cloudcli.googleapis.com"
  echo "DRY_RUN=1: no changes."
  exit 0
fi

if [[ "${api_on}" != yes ]]; then
  echo "+ enable cloudcli.googleapis.com"
  gcloud services enable cloudcli.googleapis.com --project="${PROJECT}"
fi

for m in "${MEMBERS[@]}"; do
  has_grant "${m}" && continue
  gcloud projects add-iam-policy-binding "${PROJECT}" --member="${m}" --role="${TOOL_ROLE}" \
    --condition=None --quiet >/dev/null
done

if [[ "${deny_state}" != same ]]; then
  file="$(mktemp)"
  register_cleanup "${file}"
  jq -n --argjson r "${RULES}" '{displayName: "Gcloud MCP: gateway OAuth client only (#495)", rules: $r}' >"${file}"
  if [[ "${deny_state}" == create ]]; then
    gcloud iam policies create "${POLICY_ID}" --attachment-point="${ATTACH}" --kind=denypolicies \
      --policy-file="${file}" --quiet >/dev/null
  else
    gcloud iam policies update "${POLICY_ID}" --attachment-point="${ATTACH}" --kind=denypolicies \
      --policy-file="${file}" ${etag:+--etag="${etag}"} --quiet >/dev/null
  fi
fi

echo "Done. Deny policies take a few minutes to propagate."
echo "Check as a sysop: connect the gcloud MCP through the router and run 'gcloud projects describe ${PROJECT}'."
echo "Data Access logs: protoPayload.serviceName=\"cloudcli.googleapis.com\" in Logs Explorer (enable Data Access logs for it under IAM > Audit Logs if entries are missing)."
