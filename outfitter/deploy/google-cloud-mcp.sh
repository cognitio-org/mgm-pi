#!/usr/bin/env bash
# Register Google's per-product MCP servers on the LiteLLM router and the curated `google_cloud`
# toolset over them (epic #544, GB-2 #538). Run by hand, as the owner, after gcloud-mcp-router.sh.
#   DRY_RUN=1 ./google-cloud-mcp.sh                       # print the plan; reads no secret, calls nothing
#   CONFIRM=1 GCLOUD_MCP_OAUTH_CLIENT_ID=<id> ./google-cloud-mcp.sh              # servers + toolset
#   CONFIRM=1 FORCE_PURGE=1 GCLOUD_MCP_OAUTH_CLIENT_ID=<id> ./google-cloud-mcp.sh  # also edit existing servers
#   CONFIRM=1 ENABLE_APIS=1 ... ./google-cloud-mcp.sh     # also enable the product APIs in kernal-oauth
#   GOOGLE_CLOUD_FIRESTORE_TOOLS="a,b" ...                # firestore tools in the toolset (default none)
#
# The secondary servers (cloudrun, cloudlogging, cloudmonitoring, firestore) are oauth2
# authorization_code rows with the SAME client, scope and endpoints as `gcloud`, and
# `oauth_grant_server_id: "gcloud"` (router-litellm #49): the stored per-user grant lives on `gcloud`,
# so one sign-in covers all of them. Consequences, which decide how this script behaves:
# - Editing a secondary purges nothing (it owns no credential rows), so FORCE_PURGE=1 is safe for them.
# - Editing `gcloud` purges EVERYONE's grant. This script never touches it; it only requires it to
#   exist (gcloud-mcp-router.sh registers it) and the router checks the client id and scopes match.
# Existing secondaries are shown, not edited, unless FORCE_PURGE=1.
#
# The toolset `google_cloud` (POST/PUT /v1/mcp/toolset) is a list of {server_id, tool_name} with the
# upstream (bare) tool names. It is created if absent and updated in place otherwise; that purges
# nothing. The toolset_id is printed at the end: Outfitter needs it as OUTFITTER_GOOGLE_CLOUD_TOOLSET_ID.
#
# Secrets, never printed or put on a command line: same handling as gcloud-mcp-router.sh. The client
# secret (GSM outfitter-gcloud-mcp-oauth-client-secret) goes into jq via a process substitution and to
# curl on stdin; the master key (GSM kernal-litellm-prod-master-key) goes to curl via a process
# substitution. Router error output is only the message text, scrubbed of both.
# Calls with a person's token are billed to the OAuth client's project, so each API must be enabled in
# kernal-oauth (ENABLE_APIS=1) or Google answers 403 and the server shows 0 tools.
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ROUTER_URL="${ROUTER_URL:-https://router.kernal.one}"
MASTER_KEY_SECRET="${MASTER_KEY_SECRET:-kernal-litellm-prod-master-key}"
MASTER_KEY_PROJECT="${MASTER_KEY_PROJECT:-${PROJECT}}"
CLIENT_SECRET_NAME="${GCLOUD_MCP_SECRET:-outfitter-gcloud-mcp-oauth-client-secret}"
CLIENT_ID="${GCLOUD_MCP_OAUTH_CLIENT_ID:-}"
PRIMARY_ID="${GCLOUD_MCP_SERVER_ID:-gcloud}"
TOOLSET_NAME="${GOOGLE_CLOUD_TOOLSET_NAME:-google_cloud}"
OAUTH_PROJECT="${GCLOUD_MCP_OAUTH_PROJECT:-kernal-oauth}"
FIRESTORE_TOOLS="${GOOGLE_CLOUD_FIRESTORE_TOOLS:-}"
AUTHORIZATION_URL="https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent"
TOKEN_URL="https://oauth2.googleapis.com/token"
SCOPE="https://www.googleapis.com/auth/cloud-platform"
DRY_RUN="${DRY_RUN:-0}"
CONFIRM="${CONFIRM:-0}"
FORCE_PURGE="${FORCE_PURGE:-0}"
ENABLE_APIS="${ENABLE_APIS:-0}"

# server_id|url|API to enable|description
SECONDARIES=(
  "cloudrun|https://run.googleapis.com/mcp|run.googleapis.com|Google Cloud Run"
  "cloudlogging|https://logging.googleapis.com/mcp|logging.googleapis.com|Google Cloud Logging"
  "cloudmonitoring|https://monitoring.googleapis.com/mcp|monitoring.googleapis.com|Google Cloud Monitoring"
  "firestore|https://firestore.googleapis.com/mcp|firestore.googleapis.com|Google Firestore"
)

# Curated tools (upstream names, from live tools/list 2026-10-08), as "server_id:tool,tool". The router
# stores the bare upstream name in a toolset and serves it prefixed.
TOOLS=(
  "${PRIMARY_ID}:run_gcloud_command,run_bq_command"
  "cloudrun:get_service,list_services,deploy_service_from_image,deploy_service_from_archive,deploy_service_from_file_contents"
  "cloudlogging:list_log_entries,list_log_names"
  "cloudmonitoring:query_range,list_timeseries,list_alert_policies,list_alerts,list_metric_descriptors"
  "firestore:${FIRESTORE_TOOLS}"
)

command -v jq >/dev/null || deploy_fail "jq is required"
case "${ROUTER_URL}" in
  https://*) ;;
  http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*|http://\[::1\]|http://\[::1\]:*) ;;
  *) deploy_fail "ROUTER_URL=${ROUTER_URL} must be https (or loopback): the master key goes to it" ;;
esac
[[ "${FIRESTORE_TOOLS}" =~ ^[A-Za-z0-9_,]*$ ]] || deploy_fail "GOOGLE_CLOUD_FIRESTORE_TOOLS must be comma-separated tool names"

if [[ -z "${CLIENT_ID}" ]]; then
  [[ "${DRY_RUN}" == 1 ]] || deploy_fail "GCLOUD_MCP_OAUTH_CLIENT_ID is required (the Internal Web client's id, <n>-<x>.apps.googleusercontent.com)"
  CLIENT_ID="<GCLOUD_MCP_OAUTH_CLIENT_ID>"
elif [[ ! "${CLIENT_ID}" =~ ^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$ ]]; then
  deploy_fail "GCLOUD_MCP_OAUTH_CLIENT_ID=${CLIENT_ID} doesn't look like a Google OAuth client id"
fi

# tools_json -- the toolset's tools array, from TOOLS.
tools_json() {
  local entry sid names t
  local -a arr
  for entry in "${TOOLS[@]}"; do
    sid="${entry%%:*}"; names="${entry#*:}"
    IFS=, read -ra arr <<<"${names}"
    for t in ${arr[@]+"${arr[@]}"}; do
      [[ -z "${t}" ]] || jq -nc --arg s "${sid}" --arg t "${t}" '{server_id: $s, tool_name: $t}'
    done
  done | jq -sc .
}

echo "router=${ROUTER_URL} primary=${PRIMARY_ID} (never edited) toolset=${TOOLSET_NAME}"
echo "oauth2 authorization_code: authorize=${AUTHORIZATION_URL} token=${TOKEN_URL} scope=${SCOPE}"
echo "client_id=${CLIENT_ID} client_secret=gsm:${PROJECT}/${CLIENT_SECRET_NAME} (not printed)"
for row in "${SECONDARIES[@]}"; do
  IFS='|' read -r sid url _ _ <<<"${row}"
  echo "server ${sid} -> ${url} (oauth_grant_server_id=${PRIMARY_ID})"
done
echo "toolset tools: $(tools_json | jq -r 'length') ($(tools_json | jq -r 'group_by(.server_id) | map("\(.[0].server_id)=\(length)") | join(" ")'))"
[[ -n "${FIRESTORE_TOOLS}" ]] || echo "firestore: no tools in the toolset yet; add them once their names are verified live (GOOGLE_CLOUD_FIRESTORE_TOOLS=\"a,b\")."
if [[ "${ENABLE_APIS}" == 1 ]]; then
  apis=""
  for row in "${SECONDARIES[@]}"; do IFS='|' read -r _ _ api _ <<<"${row}"; apis+=" ${api}"; done
  echo "ENABLE_APIS=1: gcloud services enable${apis} --project=${OAUTH_PROJECT}"
fi
if [[ "${DRY_RUN}" == 1 ]]; then
  echo "plan: GET /v1/mcp/server; require ${PRIMARY_ID}; POST each absent secondary (CONFIRM=1), show present ones, PUT them only with FORCE_PURGE=1 (purges nothing)."
  echo "plan: GET /v1/mcp/toolset; POST ${TOOLSET_NAME} if absent, else PUT it; print toolset_id."
  echo "DRY_RUN=1: stopping before reading any secret."
  exit 0
fi

[[ "${CONFIRM}" == 1 ]] || deploy_fail "CONFIRM=1 is required: this reads the router master key and writes to the router's admin API"
gcloud_exists secrets describe "${MASTER_KEY_SECRET}" --project="${MASTER_KEY_PROJECT}" \
  || deploy_fail "secret ${MASTER_KEY_SECRET} not found in ${MASTER_KEY_PROJECT}; set MASTER_KEY_PROJECT"
gcloud_exists secrets describe "${CLIENT_SECRET_NAME}" --project="${PROJECT}" \
  || deploy_fail "secret ${CLIENT_SECRET_NAME} not found in ${PROJECT}; store the OAuth client secret first (docs/runbooks/gcloud-mcp.md)"

MASTER="$(gcloud secrets versions access latest --secret="${MASTER_KEY_SECRET}" --project="${MASTER_KEY_PROJECT}")"
[[ -n "${MASTER}" ]] || deploy_fail "master key secret is empty"

# api METHOD PATH [JSON on stdin] -- prints the response body; fails on HTTP >= 400 and prints only
# the router's error text, never headers or the request body.
api() {
  local out code
  out="$(curl -sS -X "$1" "${ROUTER_URL}$2" \
    -H @<(printf 'Authorization: Bearer %s\n' "${MASTER}") \
    -H 'Content-Type: application/json' ${3:+--data-binary @-} -w '\n%{http_code}')" || {
    # DNS, TLS or connection failure: no answer at all, so nothing can be concluded from it.
    echo "router $1 $2 -> no response (curl failed)" >&2
    return 1
  }
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if [[ ! "${code}" =~ ^[0-9]{3}$ ]] || (( code < 200 || code >= 300 )); then
    # Only message text, never the body: a 422 echoes the request (pydantic `input`), client secret
    # included. Whatever is printed is also scrubbed of the two secrets.
    local msg
    msg="$(jq -r 'if (.detail | type) == "array" then [.detail[]? | .msg // empty] | join("; ")
      elif (.detail | type) == "object" then (.detail.error // "")
      elif (.error | type) == "object" then (.error.message // "")
      elif (.error | type) == "string" then .error
      elif (.detail | type) == "string" then .detail
      else "" end' <<<"${out}" 2>/dev/null | head -c 300 || true)"
    [[ -n "${msg}" ]] || msg="(no message)"
    [[ -z "${MASTER:-}" ]] || msg="${msg//"${MASTER}"/[redacted]}"
    [[ -z "${CLIENT_SECRET:-}" ]] || msg="${msg//"${CLIENT_SECRET}"/[redacted]}"
    echo "router $1 $2 -> HTTP ${code}: ${msg}" >&2
    return 1
  fi
  printf '%s' "${out}"
}

rows() { jq -c 'if type == "array" then . else (.servers // .data // []) end'; }
find_server() { jq -c --arg id "$1" 'map(select(.server_id == $id or .alias == $id))[0] // empty'; }
# Only fields that carry no secret (the router redacts credentials, but don't rely on it).
show() { jq -c '{server_id, alias, url, transport, auth_type, oauth2_flow, oauth_grant_server_id, allow_all_keys}'; }

# A failed or unreadable listing must stop here: treating it as "not registered" would POST blind.
list="$(api GET /v1/mcp/server)" || deploy_fail "couldn't list the router's MCP servers; nothing was changed"
jq -e 'type == "array" or type == "object"' <<<"${list}" >/dev/null 2>&1 \
  || deploy_fail "the router's MCP server list isn't JSON; nothing was changed"
servers="$(rows <<<"${list}")"
[[ -n "$(find_server "${PRIMARY_ID}" <<<"${servers}")" ]] \
  || deploy_fail "primary server ${PRIMARY_ID} isn't registered; run gcloud-mcp-router.sh first (nothing was changed)"

# Decide per secondary before reading the client secret: it is only needed when something is written.
todo=()
for row in "${SECONDARIES[@]}"; do
  IFS='|' read -r sid _ _ _ <<<"${row}"
  existing="$(find_server "${sid}" <<<"${servers}")"
  if [[ -n "${existing}" && "${FORCE_PURGE}" != 1 ]]; then
    echo "~ ${sid} is already registered:"
    show <<<"${existing}"
  else
    todo+=("${row}")
  fi
done

if (( ${#todo[@]} > 0 )); then
  CLIENT_SECRET="$(gcloud secrets versions access latest --secret="${CLIENT_SECRET_NAME}" --project="${PROJECT}")"
  [[ -n "${CLIENT_SECRET}" ]] || deploy_fail "${CLIENT_SECRET_NAME} is empty"
fi

# build ID URL DESCRIPTION -- the client secret reaches jq as a file (process substitution).
build() {
  jq -nc --arg id "$1" --arg url "$2" --arg desc "$3" --arg grant "${PRIMARY_ID}" \
    --arg au "${AUTHORIZATION_URL}" --arg tu "${TOKEN_URL}" --arg cid "${CLIENT_ID}" --arg scope "${SCOPE}" \
    --rawfile secret <(printf '%s' "${CLIENT_SECRET}") '{
      server_id: $id, server_name: $id, alias: $id,
      description: ($desc + " on Google'"'"'s side, as the signed-in user, over the shared gcloud sign-in. Operators only."),
      transport: "http", url: $url,
      auth_type: "oauth2", oauth2_flow: "authorization_code",
      authorization_url: $au, token_url: $tu,
      credentials: {client_id: $cid, client_secret: $secret, scopes: [$scope]},
      oauth_grant_server_id: $grant,
      allow_all_keys: false
    }'
}

for row in "${todo[@]+"${todo[@]}"}"; do
  IFS='|' read -r sid url _ desc <<<"${row}"
  [[ "${sid}" != "${PRIMARY_ID}" ]] || deploy_fail "refusing to edit the primary ${PRIMARY_ID}: that would purge everyone's grant"
  existing="$(find_server "${sid}" <<<"${servers}")"
  if [[ -n "${existing}" ]]; then
    rid="$(jq -r '.server_id // empty' <<<"${existing}")"
    [[ -n "${rid}" ]] || deploy_fail "the existing ${sid} row has no server_id"
    echo "! ${sid} exists and FORCE_PURGE=1: updating it (a secondary owns no grant rows, so nobody is signed out)."
    build "${rid}" "${url}" "${desc}" | api PUT /v1/mcp/server - >/dev/null
  else
    echo "+ register ${sid}"
    build "${sid}" "${url}" "${desc}" | api POST /v1/mcp/server - >/dev/null
  fi
done
unset CLIENT_SECRET

# Toolset: create or update by name. A failed listing stops here, never a blind POST.
tlist="$(api GET /v1/mcp/toolset)" || deploy_fail "couldn't list the router's toolsets; the servers are done, the toolset wasn't touched"
jq -e 'type == "array"' <<<"${tlist}" >/dev/null 2>&1 \
  || deploy_fail "the router's toolset list isn't a JSON array; the toolset wasn't touched"
tid="$(jq -r --arg n "${TOOLSET_NAME}" 'map(select(.toolset_name == $n))[0].toolset_id // empty' <<<"${tlist}")"
tdesc="Google Cloud for operators: gcloud and bq, Cloud Run, Logging, Monitoring and Firestore, behind one sign-in."
tools="$(tools_json)"
if [[ -n "${tid}" ]]; then
  echo "~ update toolset ${TOOLSET_NAME} (${tid})"
  jq -nc --arg id "${tid}" --arg n "${TOOLSET_NAME}" --arg d "${tdesc}" --argjson t "${tools}" \
    '{toolset_id: $id, toolset_name: $n, description: $d, tools: $t}' | api PUT /v1/mcp/toolset - >/dev/null
else
  echo "+ create toolset ${TOOLSET_NAME}"
  resp="$(jq -nc --arg n "${TOOLSET_NAME}" --arg d "${tdesc}" --argjson t "${tools}" \
    '{toolset_name: $n, description: $d, tools: $t}' | api POST /v1/mcp/toolset -)" || deploy_fail "couldn't create the toolset"
  tid="$(jq -r '.toolset_id // empty' <<<"${resp}")"
  [[ -n "${tid}" ]] || deploy_fail "the router created the toolset but returned no toolset_id; read it with GET /v1/mcp/toolset"
fi

if [[ "${ENABLE_APIS}" == 1 ]]; then
  for row in "${SECONDARIES[@]}"; do
    IFS='|' read -r _ _ api _ <<<"${row}"
    gcloud services enable "${api}" --project="${OAUTH_PROJECT}"
  done
fi

echo "Done. Servers sharing the ${PRIMARY_ID} grant:"
api GET /v1/mcp/server | rows | jq -c --arg p "${PRIMARY_ID}" '.[] | select(.oauth_grant_server_id == $p) | {server_id, url, oauth_grant_server_id}'
echo "toolset_id=${tid}"
echo "Set OUTFITTER_GOOGLE_CLOUD_TOOLSET_ID=${tid} for Outfitter. Sysops sign in once with /mcp-auth ${TOOLSET_NAME} (docs/runbooks/gcloud-mcp.md)."
