#!/usr/bin/env bash
# Register (or show) Google's remote gcloud MCP server on the LiteLLM router (epic #497, GA-1 #491,
# GA-5 #495). Run by hand, as the owner.
#   ./gcloud-mcp-router.sh                  # show the server if it exists; otherwise needs CONFIRM=1 to register
#   CONFIRM=1 GCLOUD_MCP_OAUTH_CLIENT_ID=<id> ./gcloud-mcp-router.sh              # register it
#   CONFIRM=1 FORCE_PURGE=1 GCLOUD_MCP_OAUTH_CLIENT_ID=<id> ./gcloud-mcp-router.sh  # change an existing server
#   DRY_RUN=1 ./gcloud-mcp-router.sh        # print the plan and payload shape; reads no secret, calls nothing
#
# The server is an `oauth2` authorization_code server on the router's per-user vault, the same mode
# as `sentry` (#482): each person signs in with their own Google account and their token stays in the
# router. Google has no dynamic client registration, so this needs a static OAuth client: an INTERNAL
# Web client in its own project (e.g. kernal-oauth), because outfitter-509211's consent screen
# must stay External for IAP; the secret stays in outfitter-509211 (docs/runbooks/gcloud-mcp.md). The redirect URI to register
# on it is ${ROUTER_URL}/callback (discoverable_endpoints.py builds it from the request base URL).
#
# Secrets, never printed or put on a command line:
# - The client secret comes from Secret Manager (GCLOUD_MCP_SECRET, default
#   outfitter-gcloud-mcp-oauth-client-secret) into a shell variable and from there into curl's stdin.
# - The router master key (GSM kernal-litellm-prod-master-key; admin routes need a proxy_admin key,
#   and this one-off isn't worth a scoped key) goes to curl through a process substitution, like
#   litellm-admin.sh. CONFIRM=1 is therefore required for anything beyond DRY_RUN.
#
# Editing an existing server (PUT /v1/mcp/server) that changes the url, auth type/flow, endpoints,
# client id/secret or scopes PURGES EVERY USER'S STORED GRANT (#482 finding 5): everyone must sign in
# again. So an existing server is only ever shown, unless FORCE_PURGE=1 says that is the point.
# Settle the config before anyone connects.
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ROUTER_URL="${ROUTER_URL:-https://router.kernal.one}"
MASTER_KEY_SECRET="${MASTER_KEY_SECRET:-kernal-litellm-prod-master-key}"
MASTER_KEY_PROJECT="${MASTER_KEY_PROJECT:-${PROJECT}}"
CLIENT_SECRET_NAME="${GCLOUD_MCP_SECRET:-outfitter-gcloud-mcp-oauth-client-secret}"
CLIENT_ID="${GCLOUD_MCP_OAUTH_CLIENT_ID:-}"
SERVER_ID="${GCLOUD_MCP_SERVER_ID:-gcloud}"
MCP_URL="https://cloudcli.googleapis.com/mcp"
# access_type=offline and prompt=consent make Google issue a refresh token. The router keeps any query
# string on authorization_url (authorize_with_server merges it), and router-litellm #45 also defaults
# both for accounts.google.com; stating them here keeps the registration correct on its own.
AUTHORIZATION_URL="https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent"
TOKEN_URL="https://oauth2.googleapis.com/token"
SCOPE="https://www.googleapis.com/auth/cloud-platform"
DRY_RUN="${DRY_RUN:-0}"
CONFIRM="${CONFIRM:-0}"
FORCE_PURGE="${FORCE_PURGE:-0}"

command -v jq >/dev/null || deploy_fail "jq is required"
case "${ROUTER_URL}" in
  https://*) ;;
  http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*|http://\[::1\]|http://\[::1\]:*) ;;
  *) deploy_fail "ROUTER_URL=${ROUTER_URL} must be https (or loopback): the master key goes to it" ;;
esac

if [[ -z "${CLIENT_ID}" ]]; then
  [[ "${DRY_RUN}" == 1 ]] || deploy_fail "GCLOUD_MCP_OAUTH_CLIENT_ID is required (the Internal Web client's id, <n>-<x>.apps.googleusercontent.com)"
  CLIENT_ID="<GCLOUD_MCP_OAUTH_CLIENT_ID>"
elif [[ ! "${CLIENT_ID}" =~ ^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$ ]]; then
  deploy_fail "GCLOUD_MCP_OAUTH_CLIENT_ID=${CLIENT_ID} doesn't look like a Google OAuth client id"
fi

echo "router=${ROUTER_URL} server=${SERVER_ID} url=${MCP_URL}"
echo "oauth2 authorization_code: authorize=${AUTHORIZATION_URL} token=${TOKEN_URL} scope=${SCOPE}"
echo "client_id=${CLIENT_ID} client_secret=gsm:${PROJECT}/${CLIENT_SECRET_NAME} (not printed)"
echo "redirect URI to register on the client: ${ROUTER_URL}/callback"
if [[ "${DRY_RUN}" == 1 ]]; then
  echo "plan: GET /v1/mcp/server; if ${SERVER_ID} is absent, POST it (CONFIRM=1); if present, show it, and PUT only with FORCE_PURGE=1 (purges every user's grant)."
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

# show -- only fields that carry no secret (the router redacts credentials, but don't rely on it).
show() {
  jq -c --arg id "${SERVER_ID}" '(if type == "array" then . else (.servers // .data // []) end)
    | map(select(.server_id == $id or .alias == $id))[0]
    | {server_id, alias, url, transport, auth_type, oauth2_flow, authorization_url, token_url, allow_all_keys}'
}

# A failed or unreadable listing must stop here: treating it as "not registered" would POST blind.
list="$(api GET /v1/mcp/server)" || deploy_fail "couldn't list the router's MCP servers; nothing was changed"
jq -e 'type == "array" or type == "object"' <<<"${list}" >/dev/null 2>&1 \
  || deploy_fail "the router's MCP server list isn't JSON; nothing was changed"
existing="$(jq -c --arg id "${SERVER_ID}" '(if type == "array" then . else (.servers // .data // []) end)
  | map(select(.server_id == $id or .alias == $id))[0] // empty' <<<"${list}")"
existing_id="$(jq -r '.server_id // empty' <<<"${existing:-null}")"

if [[ -n "${existing}" && "${FORCE_PURGE}" != 1 ]]; then
  echo "~ ${SERVER_ID} is already registered:"
  show <<<"${list}"
  echo "Nothing changed. Editing it purges every user's stored grant; rerun with FORCE_PURGE=1 CONFIRM=1 if that is the point."
  exit 0
fi

CLIENT_SECRET="$(gcloud secrets versions access latest --secret="${CLIENT_SECRET_NAME}" --project="${PROJECT}")"
[[ -n "${CLIENT_SECRET}" ]] || deploy_fail "${CLIENT_SECRET_NAME} is empty"

# The secret reaches jq as a file (process substitution), the body reaches curl on stdin.
build() {
  jq -nc --arg id "${SERVER_ID}" --arg rid "${ROW_ID:-${SERVER_ID}}" --arg url "${MCP_URL}" --arg au "${AUTHORIZATION_URL}" --arg tu "${TOKEN_URL}" \
    --arg cid "${CLIENT_ID}" --arg scope "${SCOPE}" \
    --rawfile secret <(printf '%s' "${CLIENT_SECRET}") '{
      server_id: $rid, server_name: $id, alias: $id,
      description: "Google Cloud CLI (gcloud, bq) on Google'"'"'s side, as the signed-in user. Operators only.",
      transport: "http", url: $url,
      auth_type: "oauth2", oauth2_flow: "authorization_code",
      authorization_url: $au, token_url: $tu,
      credentials: {client_id: $cid, client_secret: $secret, scopes: [$scope]},
      allow_all_keys: false
    }'
}

if [[ -n "${existing}" ]]; then
  echo "! ${SERVER_ID} exists and FORCE_PURGE=1: updating it purges every user's stored grant."
  [[ -n "${existing_id}" ]] || deploy_fail "the existing row has no server_id"
  ROW_ID="${existing_id}"
  build | api PUT /v1/mcp/server - >/dev/null
else
  echo "+ register ${SERVER_ID}"
  build | api POST /v1/mcp/server - >/dev/null
fi
unset CLIENT_SECRET

echo "Registered. Now:"
api GET /v1/mcp/server | show
echo "Each sysop connects with their own Google account (docs/runbooks/gcloud-mcp.md)."
