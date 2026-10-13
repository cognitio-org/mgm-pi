#!/usr/bin/env bash
# Register the finance MCP on the LiteLLM router (read-only account tools; Wise is the first upstream).
# The server uses a bearer token that must be kept confidential; no OAuth vault, no per-user grants.
#
#   ./finance-mcp-router.sh                 # show the server if it exists; otherwise needs CONFIRM=1 to register
#   CONFIRM=1 ./finance-mcp-router.sh       # register it
#   CONFIRM=1 FORCE_PURGE=1 ./finance-mcp-router.sh  # change an existing server
#   DRY_RUN=1 ./finance-mcp-router.sh       # print the plan and payload shape; reads no secret, calls nothing
#
# Secrets, never printed or put on a command line:
# - The service bearer token comes from Secret Manager (FINANCE_MCP_TOKEN_SECRET, default
#   kernal-finance-mcp-token) into a shell variable and from there into curl's stdin.
# - The router master key (GSM kernal-litellm-prod-master-key) goes to curl through a process
#   substitution. CONFIRM=1 is therefore required for anything beyond DRY_RUN.
#
# Editing an existing server changes to url or auth type purge every caller's token (like gcloud #482).
# Do not change token-relevant fields in the admin UI.
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ROUTER_URL="${ROUTER_URL:-https://router.kernal.one}"
MASTER_KEY_SECRET="${MASTER_KEY_SECRET:-kernal-litellm-prod-master-key}"
MASTER_KEY_PROJECT="${MASTER_KEY_PROJECT:-${PROJECT}}"
TOKEN_SECRET_NAME="${FINANCE_MCP_TOKEN_SECRET:-kernal-finance-mcp-token}"
SERVER_ID="${FINANCE_MCP_SERVER_ID:-finance}"
FINANCE_MCP_URL="${FINANCE_MCP_URL:-https://kernal-finance-mcp-97916961297.us-central1.run.app/mcp}"
DRY_RUN="${DRY_RUN:-0}"
CONFIRM="${CONFIRM:-0}"
FORCE_PURGE="${FORCE_PURGE:-0}"

command -v jq >/dev/null || deploy_fail "jq is required"
case "${ROUTER_URL}" in
  https://*) ;;
  http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*|http://\[::1\]|http://\[::1\]:*) ;;
  *) deploy_fail "ROUTER_URL=${ROUTER_URL} must be https (or loopback): the master key goes to it" ;;
esac

echo "router=${ROUTER_URL} server=${SERVER_ID} url=${FINANCE_MCP_URL}"
echo "bearer token: gsm:${PROJECT}/${TOKEN_SECRET_NAME} (not printed)"
echo "allow_all_keys=false: must grant via object_permission.mcp_servers on each key"
if [[ "${DRY_RUN}" == 1 ]]; then
  echo "plan: GET /v1/mcp/server; if ${SERVER_ID} is absent, POST it (CONFIRM=1); if present, show it, and PUT only with FORCE_PURGE=1."
  echo "DRY_RUN=1: stopping before reading any secret."
  exit 0
fi

[[ "${CONFIRM}" == 1 ]] || deploy_fail "CONFIRM=1 is required: this reads the router master key and writes to the router's admin API"
gcloud_exists secrets describe "${MASTER_KEY_SECRET}" --project="${MASTER_KEY_PROJECT}" \
  || deploy_fail "secret ${MASTER_KEY_SECRET} not found in ${MASTER_KEY_PROJECT}; set MASTER_KEY_PROJECT"
gcloud_exists secrets describe "${TOKEN_SECRET_NAME}" --project="${PROJECT}" \
  || deploy_fail "secret ${TOKEN_SECRET_NAME} not found in ${PROJECT}; run banking/deploy/finance-mcp.sh first"

# Never trace past this point: xtrace would print the secrets below (and curl's header).
set +x
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
    # Only message text, never the body.
    local msg
    msg="$(jq -r 'if (.detail | type) == "array" then [.detail[]? | .msg // empty] | join("; ")
      elif (.error | type) == "object" then (.error.message // "")
      elif (.error | type) == "string" then .error
      elif (.detail | type) == "string" then .detail
      else "" end' <<<"${out}" 2>/dev/null | head -c 300 || true)"
    [[ -n "${msg}" ]] || msg="(no message)"
    [[ -z "${MASTER:-}" ]] || msg="${msg//"${MASTER}"/[redacted]}"
    echo "router $1 $2 -> HTTP ${code}: ${msg}" >&2
    return 1
  fi
  printf '%s' "${out}"
}

# show -- only fields that carry no secret.
show() {
  jq -c --arg id "${SERVER_ID}" '(if type == "array" then . else (.servers // .data // []) end)
    | map(select(.server_id == $id or .alias == $id))[0]
    | {server_id, alias, url, transport, auth_type, allow_all_keys}'
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
  echo "Nothing changed. Editing it invalidates every caller's token; rerun with FORCE_PURGE=1 CONFIRM=1 if that is the point."
  exit 0
fi

TOKEN="$(gcloud secrets versions access latest --secret="${TOKEN_SECRET_NAME}" --project="${PROJECT}")"
[[ -n "${TOKEN}" ]] || deploy_fail "${TOKEN_SECRET_NAME} is empty"

# The secret reaches jq as a file (process substitution), the body reaches curl on stdin.
build() {
  jq -nc --arg id "${SERVER_ID}" --arg rid "${ROW_ID:-${SERVER_ID}}" --arg url "${FINANCE_MCP_URL}" \
    --rawfile secret <(printf '%s' "${TOKEN}") '{
      server_id: $rid, server_name: $id, alias: $id,
      description: "Finance MCP: read-only banking tools (Wise balances, statements). Bearer token auth.",
      transport: "http", url: $url,
      auth_type: "bearer_token",
      credentials: {auth_value: $secret},
      allow_all_keys: false
    }'
}

if [[ -n "${existing}" ]]; then
  echo "! ${SERVER_ID} exists and FORCE_PURGE=1: updating it invalidates every caller's token."
  [[ -n "${existing_id}" ]] || deploy_fail "the existing row has no server_id"
  ROW_ID="${existing_id}"
  build | api PUT /v1/mcp/server - >/dev/null
else
  echo "+ register ${SERVER_ID}"
  build | api POST /v1/mcp/server - >/dev/null
fi
unset TOKEN

echo "Registered. Now:"
api GET /v1/mcp/server | show
echo "Grant access via object_permission.mcp_servers on individual LiteLLM keys."
