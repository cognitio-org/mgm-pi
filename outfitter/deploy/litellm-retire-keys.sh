#!/usr/bin/env bash
# Retire the shared LiteLLM router keys (#399 CA-10, docs/specs/central-auth.md §12, §14). Run by
# hand, as the owner, in this order:
#   ./litellm-retire-keys.sh system-key      # Outfitter's own calls move to an outfitter-system key
#   ./litellm-retire-keys.sh block           # then block the old shared keys
#   ./litellm-retire-keys.sh unblock ALIAS   # undo one block
#   DRY_RUN=1 ./litellm-retire-keys.sh ...   # show what would happen; reads nothing secret, writes nothing
#   ROTATE=1 ./litellm-retire-keys.sh system-key   # mint a fresh system key even if one is stored
#
# system-key: Outfitter's own model calls (gurus, summaries, extraction, the router probe when
# LITELLM_ADMIN_KEY is unset) read the secret outfitter-litellm-key-default (secrets.ts
# SecretsBroker.defaultLitellmKey). It held `MGM-Pi`, a key of the owner's proxy_admin login, so
# every Drive that fell back to it held an admin-capable key. This step:
#   1. ensures the LiteLLM user `outfitter-system` with user_role internal_user (a key's role comes
#      from its user, auth_checks.py `_is_user_proxy_admin`, so never proxy_admin);
#   2. finds the team with alias `outfitter-system` (run-keys.ts ensureSystemTeam made it; created
#      here if missing) and makes the user a member;
#   3. mints a key for that user in that team (alias outfitter-system-<UTC time>);
#   4. stores it as a new version of outfitter-litellm-key-default (created if missing) and
#      disables the older versions. A failed store deletes the new key again.
#   Idempotent: when the stored (latest) version already is an outfitter-system-* key (checked with
#   /key/info as that key; only the alias is printed), nothing happens unless ROTATE=1.
#
# block: blocks exactly BLOCK_ALIASES with the master key's POST /key/block, after looking each
# one up by alias (/key/list?key_alias=). Refuses to block MGM-Pi while outfitter-litellm-key-default
# still holds it (run system-key first). Prints blocked / already blocked / not found per alias.
#
# The master key is read from Secret Manager into a shell variable and goes to curl through a
# process substitution, never argv or the terminal; so does the stored system key when it is
# checked. A new key goes from curl's JSON straight into `gcloud secrets ... --data-file=-`.
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ROUTER_URL="${ROUTER_URL:-https://router.kernal.one}"
MASTER_KEY_SECRET="${MASTER_KEY_SECRET:-kernal-litellm-prod-master-key}"
MASTER_KEY_PROJECT="${MASTER_KEY_PROJECT:-${PROJECT}}"
DEFAULT_SECRET="outfitter-litellm-key-default"
SYSTEM_USER="outfitter-system"
SYSTEM_TEAM="outfitter-system"
ALIAS_PREFIX="outfitter-system"
# Kept out of the nested $(...) below: bash 3.2 (macOS /bin/bash) misparses an apostrophe there.
SYSTEM_KEY_PURPOSE="Outfitter's own model calls (gurus, summaries, extraction)"
# The owner's list (2026-10-05, #399). Not blocked for now: UPSTREAM_LITELLM_API_KEY,
# ROUTER_ADMIN_KEY, local-test, cognitio-mgmsr.
BLOCK_ALIASES=("MGM-Pi" "agent-testing" "litellm-autorouter-testing-c")
DRY_RUN="${DRY_RUN:-0}"
ROTATE="${ROTATE:-0}"

usage() { echo "usage: $0 system-key | block | unblock ALIAS   (DRY_RUN=1 to preview; ROTATE=1 with system-key)" >&2; exit 2; }
STEP="${1:-}"
case "${STEP}" in
  system-key | block) [[ $# -eq 1 ]] || usage ;;
  unblock) [[ $# -eq 2 && -n "$2" ]] || usage ;;
  *) usage ;;
esac

command -v jq >/dev/null || deploy_fail "jq is required"

echo "router=${ROUTER_URL} master=${MASTER_KEY_PROJECT}/${MASTER_KEY_SECRET} step=${STEP}"
case "${STEP}" in
  system-key)
    echo "plan: user ${SYSTEM_USER} (internal_user) in team ${SYSTEM_TEAM}; key ${ALIAS_PREFIX}-<UTC time> -> ${PROJECT}/${DEFAULT_SECRET} (older versions disabled)"
    [[ "${ROTATE}" == 1 ]] && echo "ROTATE=1: mint a new key even if the secret already holds an ${ALIAS_PREFIX}-* key" ;;
  block) echo "plan: block ${BLOCK_ALIASES[*]} (MGM-Pi only once ${DEFAULT_SECRET} no longer holds it)" ;;
  unblock) echo "plan: unblock $2" ;;
esac
if [[ "${DRY_RUN}" == 1 ]]; then
  echo "DRY_RUN=1: stopping before reading the master key."
  exit 0
fi

gcloud_exists secrets describe "${MASTER_KEY_SECRET}" --project="${MASTER_KEY_PROJECT}" \
  || deploy_fail "secret ${MASTER_KEY_SECRET} not found in ${MASTER_KEY_PROJECT}; set MASTER_KEY_PROJECT"
MASTER="$(gcloud secrets versions access latest --secret="${MASTER_KEY_SECRET}" --project="${MASTER_KEY_PROJECT}")"
[[ -n "${MASTER}" ]] || deploy_fail "master key secret is empty"

# call BEARER METHOD PATH [JSON] -- prints the response body; fails on HTTP >= 400 without
# printing headers. The bearer goes through a process substitution, never argv.
call() {
  local bearer="$1" out code
  out="$(curl -sS -X "$2" "${ROUTER_URL}$3" \
    -H @<(printf 'Authorization: Bearer %s\n' "${bearer}") \
    -H 'Content-Type: application/json' ${4:+--data-binary "$4"} -w '\n%{http_code}')"
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if (( code >= 400 )); then
    echo "router $2 $3 -> HTTP ${code}: $(jq -c '.error // .detail // .' <<<"${out}" 2>/dev/null | sed 's/sk-[A-Za-z0-9_-]*/sk-…/g' | head -c 300)" >&2
    return 1
  fi
  printf '%s' "${out}"
}
api() { call "${MASTER}" "$@"; }

# The alias of the key outfitter-litellm-key-default holds now (its latest enabled version), asked
# as that key itself (/key/info without a key parameter describes the caller's key). Empty when the
# secret is missing or empty; "?" when the router won't say (revoked, blocked, unreachable).
stored_alias() {
  gcloud_exists secrets describe "${DEFAULT_SECRET}" --project="${PROJECT}" || return 0
  local value info
  value="$(gcloud secrets versions access latest --secret="${DEFAULT_SECRET}" --project="${PROJECT}" 2>/dev/null || true)"
  [[ -n "${value}" ]] || return 0
  if ! info="$(call "${value}" GET /key/info 2>/dev/null)"; then
    echo "?"
    return 0
  fi
  jq -r '.info.key_alias // .key_alias // "?"' <<<"${info}"
}

# Hashed tokens of the keys whose alias is exactly $1, one per line, with "blocked"/"active".
# /key/list filters by key_alias on LiteLLM 1.103; the exact match is checked here again.
keys_by_alias() {
  local enc
  enc="$(jq -rn --arg a "$1" '$a | @uri')"
  api GET "/key/list?key_alias=${enc}&return_full_object=true&size=100" \
    | jq -r --arg a "$1" '.keys[]? | select(type == "object" and .key_alias == $a) | "\(.token) \(if .blocked == true then "blocked" else "active" end)"'
}

system_key() {
  # 0. Already done?
  local current
  current="$(stored_alias)"
  if [[ "${current}" == "${ALIAS_PREFIX}-"* && "${ROTATE}" != 1 ]]; then
    echo "~ ${DEFAULT_SECRET} already holds ${current}. Nothing to do (ROTATE=1 to replace)."
    return 0
  fi
  echo "  ${DEFAULT_SECRET} holds: ${current:-<nothing>}"

  # 1. The internal_user (never proxy_admin: the key would inherit admin rights).
  local info role
  if info="$(api GET "/user/info?user_id=${SYSTEM_USER}" 2>/dev/null)" && [[ "$(jq -r '.user_info // empty | .user_id // empty' <<<"${info}")" == "${SYSTEM_USER}" ]]; then
    role="$(jq -r '.user_info.user_role // empty' <<<"${info}")"
    if [[ "${role}" == internal_user ]]; then
      echo "~ user ${SYSTEM_USER} exists (internal_user)"
    else
      echo "* user ${SYSTEM_USER} has role ${role:-<none>}; setting internal_user"
      api POST /user/update "$(jq -nc --arg u "${SYSTEM_USER}" '{user_id: $u, user_role: "internal_user"}')" >/dev/null
    fi
  else
    echo "+ create user ${SYSTEM_USER} (internal_user)"
    api POST /user/new "$(jq -nc --arg u "${SYSTEM_USER}" \
      '{user_id: $u, user_role: "internal_user", auto_create_key: false, metadata: {owner: "outfitter", purpose: "Outfitter system calls", issue: "399"}}')" >/dev/null
  fi

  # 2. The team, by alias, and the user in it.
  local team_id
  team_id="$(api GET /team/list | jq -r --arg a "${SYSTEM_TEAM}" '[(if type == "array" then . else (.teams // .data // []) end)[] | select(.team_alias == $a) | .team_id][0] // empty')"
  if [[ -z "${team_id}" ]]; then
    echo "+ create team ${SYSTEM_TEAM}"
    team_id="$(api POST /team/new "$(jq -nc --arg a "${SYSTEM_TEAM}" '{team_alias: $a, metadata: {owner: "outfitter", purpose: "Outfitter system calls"}}')" | jq -r '.team_id // empty')"
    [[ -n "${team_id}" ]] || deploy_fail "router returned no team id for ${SYSTEM_TEAM}"
  else
    echo "~ team ${SYSTEM_TEAM} exists (${team_id})"
  fi
  local members
  members="$(api GET "/team/info?team_id=${team_id}" | jq -r '[(.team_info.members_with_roles // [])[] | .user_id] | join(" ")')"
  if [[ " ${members} " == *" ${SYSTEM_USER} "* ]]; then
    echo "~ ${SYSTEM_USER} is a member of ${SYSTEM_TEAM}"
  else
    echo "+ add ${SYSTEM_USER} to ${SYSTEM_TEAM}"
    api POST /team/member_add "$(jq -nc --arg t "${team_id}" --arg u "${SYSTEM_USER}" '{team_id: $t, member: {role: "user", user_id: $u}}')" >/dev/null
  fi

  # 3. Mint. The alias carries a timestamp so a rotation never collides with the old alias.
  local alias new_key
  alias="${ALIAS_PREFIX}-$(date -u +%Y%m%d%H%M%S)"
  echo "+ mint key ${alias} (user ${SYSTEM_USER}, team ${SYSTEM_TEAM})"
  new_key="$(api POST /key/generate "$(jq -nc --arg u "${SYSTEM_USER}" --arg t "${team_id}" --arg a "${alias}" \
    --arg p "${SYSTEM_KEY_PURPOSE}" \
    '{user_id: $u, team_id: $t, key_alias: $a, metadata: {owner: "outfitter", purpose: $p, issue: "399"}}')" \
    | jq -r '.key // empty')"
  [[ "${new_key}" == sk-* ]] || deploy_fail "router returned no key"

  # 4. Store it. A failure here leaves an orphan key on the router, so delete it before stopping.
  local store
  if gcloud_exists secrets describe "${DEFAULT_SECRET}" --project="${PROJECT}"; then
    store=(gcloud secrets versions add "${DEFAULT_SECRET}" --project="${PROJECT}" --data-file=-)
  else
    # shellcheck disable=SC2054 # the commas belong to --labels, not array separators
    store=(gcloud secrets create "${DEFAULT_SECRET}" --project="${PROJECT}" --replication-policy=automatic \
      --labels=app=outfitter,purpose=litellm-default --data-file=-)
  fi
  if ! printf '%s' "${new_key}" | "${store[@]}" >/dev/null; then
    api POST /key/delete "$(jq -nc --arg a "${alias}" '{key_aliases: [$a]}')" >/dev/null || true
    deploy_fail "could not store the key in ${DEFAULT_SECRET}; the new router key was deleted"
  fi
  unset new_key
  echo "  stored as a new version of ${PROJECT}/${DEFAULT_SECRET}"

  # Older versions hold the previous key (MGM-Pi): disable them so nothing reads them again
  # (versions are kept, not destroyed; the api reads :latest live).
  local latest v
  latest="$(gcloud secrets versions list "${DEFAULT_SECRET}" --project="${PROJECT}" --filter=state=enabled \
    --sort-by=~createTime --limit=1 --format='value(name)')"
  for v in $(gcloud secrets versions list "${DEFAULT_SECRET}" --project="${PROJECT}" --filter=state=enabled --format='value(name)'); do
    [[ "${v##*/}" == "${latest##*/}" ]] && continue
    echo "- disable old secret version ${v##*/}"
    gcloud secrets versions disable "${v##*/}" --secret="${DEFAULT_SECRET}" --project="${PROJECT}" --quiet >/dev/null
  done

  if [[ -n "${current}" && "${current}" != "?" ]]; then
    echo "The previous key (${current}) is still live on the router: '$0 block' blocks MGM-Pi; an older ${ALIAS_PREFIX}-* key can be deleted once Outfitter uses the new one."
  fi
  echo "Done. The api reads ${DEFAULT_SECRET} live; check Outfitter's own calls, then run '$0 block'."
}

block() {
  local current
  current="$(stored_alias)"
  local alias rows token state
  for alias in "${BLOCK_ALIASES[@]}"; do
    if [[ "${alias}" == "MGM-Pi" && ( -z "${current}" || "${current}" == "?" || "${current}" == "MGM-Pi" ) ]]; then
      echo "${alias}: refused -- ${DEFAULT_SECRET} holds ${current:-nothing} ('?': the router did not say), not an ${ALIAS_PREFIX}-* key. Run '$0 system-key' first."
      continue
    fi
    rows="$(keys_by_alias "${alias}")"
    if [[ -z "${rows}" ]]; then
      echo "${alias}: not found"
      continue
    fi
    while read -r token state; do
      [[ -n "${token}" ]] || continue
      if [[ "${state}" == blocked ]]; then
        echo "${alias}: already blocked"
      else
        api POST /key/block "$(jq -nc --arg k "${token}" '{key: $k}')" >/dev/null
        echo "${alias}: blocked"
      fi
    done <<<"${rows}"
  done
  echo "Undo one with: $0 unblock <alias>   (master-key POST /key/unblock)"
}

unblock() {
  local alias="$1" rows token state
  rows="$(keys_by_alias "${alias}")"
  if [[ -z "${rows}" ]]; then
    echo "${alias}: not found"
    return 0
  fi
  while read -r token state; do
    [[ -n "${token}" ]] || continue
    if [[ "${state}" == blocked ]]; then
      api POST /key/unblock "$(jq -nc --arg k "${token}" '{key: $k}')" >/dev/null
      echo "${alias}: unblocked"
    else
      echo "${alias}: not blocked"
    fi
  done <<<"${rows}"
}

case "${STEP}" in
  system-key) system_key ;;
  block) block ;;
  unblock) unblock "$2" ;;
esac
