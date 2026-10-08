#!/usr/bin/env bash
# Check the router's identity rows that per-user MCP grants depend on (MO-7 #489,
# docs/specs/mcp-connections.md §6, docs/runbooks/mcp-grants.md). Read-only. Run by hand, as the owner.
#   ./mcp-identity-check.sh             # list router users, print violations, exit 1 on any
#   DRY_RUN=1 ./mcp-identity-check.sh   # print what it checks; reads no secret, calls nothing
#
# A Drive's run key authenticates as the Outfitter user u_<hash>; a browser sign-in stores the grant on
# the IAP user. The router links the two by email (router-litellm PR #40), so for every user with
# metadata.source == "outfitter":
#   - user_email is empty (user_email is unique, and the IAP row owns the address)
#   - metadata.email is set
#   - user_id == userIdFor(metadata.email) (packages/api/src/central/user-id.ts)
#   - at most one other user has that address as user_email
# Only user ids and the failed check are printed, never a key.
#
# Uses Outfitter's scoped admin key (outfitter-litellm-admin, allowed /user/list), not the master key.
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ROUTER_URL="${ROUTER_URL:-https://router.kernal.one}"
ADMIN_SECRET="${ADMIN_SECRET:-outfitter-litellm-admin}"
PAGE_SIZE="${PAGE_SIZE:-100}"
DRY_RUN="${DRY_RUN:-0}"

command -v jq >/dev/null || deploy_fail "jq is required"
case "${ROUTER_URL}" in
  https://*) ;;
  http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) ;;
  *) deploy_fail "ROUTER_URL=${ROUTER_URL} must be https (or loopback): the admin key goes to it" ;;
esac

echo "router=${ROUTER_URL} key=${PROJECT}/${ADMIN_SECRET}: checking outfitter identity rows via GET /user/list"
if [[ "${DRY_RUN}" == 1 ]]; then
  echo "DRY_RUN=1: stopping before reading the admin key."
  exit 0
fi

KEY="$(gcloud secrets versions access latest --secret="${ADMIN_SECRET}" --project="${PROJECT}")"
[[ -n "${KEY}" ]] || deploy_fail "admin key secret is empty"

# users_page N -- one /user/list page as JSON; fails without printing the body.
users_page() {
  local out code
  out="$(curl -sS "${ROUTER_URL}/user/list?page=$1&page_size=${PAGE_SIZE}" \
    -H @<(printf 'Authorization: Bearer %s\n' "${KEY}") -w '\n%{http_code}')" || { echo "router /user/list -> no response" >&2; return 1; }
  code="${out##*$'\n'}"
  [[ "${code}" == 200 ]] || { echo "router /user/list -> HTTP ${code}" >&2; return 1; }
  printf '%s' "${out%$'\n'*}"
}

all="[]"
page=1
while :; do
  body="$(users_page "${page}")" || deploy_fail "couldn't list router users; nothing was checked"
  batch="$(jq -c '.users // []' <<<"${body}")"
  all="$(jq -c --argjson b "${batch}" '. + $b' <<<"${all}")"
  [[ "$(jq 'length' <<<"${batch}")" -ge "${PAGE_SIZE}" ]] || break
  page=$((page + 1))
done

user_id_for() { printf 'outfitter-user:%s' "$1" | sha256sum | cut -c1-24 | sed 's/^/u_/'; }
lower() { tr '[:upper:]' '[:lower:]' <<<"$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'; }

violations=0
checked=0
while IFS=$'\x1f' read -r uid column meta_email; do
  checked=$((checked + 1))
  email="$(lower "${meta_email}")"
  [[ -z "${column}" ]] || { echo "VIOLATION ${uid}: user_email is set on an outfitter row"; violations=$((violations + 1)); }
  if [[ -z "${email}" ]]; then
    echo "VIOLATION ${uid}: metadata.email is missing"; violations=$((violations + 1)); continue
  fi
  [[ "${uid}" == "$(user_id_for "${email}")" ]] || { echo "VIOLATION ${uid}: user_id is not userIdFor(metadata.email)"; violations=$((violations + 1)); }
  owners="$(jq --arg e "${email}" '[.[] | select(((.user_email // "") | ascii_downcase | ltrimstr(" ") | rtrimstr(" ")) == $e)] | length' <<<"${all}")"
  (( owners <= 1 )) || { echo "VIOLATION ${uid}: ${owners} users have this address as user_email"; violations=$((violations + 1)); }
done < <(jq -r '.[] | select((.metadata.source // "") == "outfitter") | [.user_id, (.user_email // ""), (.metadata.email // "")] | join("\u001f")' <<<"${all}")

echo "checked ${checked} outfitter user(s) of $(jq 'length' <<<"${all}"): ${violations} violation(s)"
(( violations == 0 ))
