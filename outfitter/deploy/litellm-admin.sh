#!/usr/bin/env bash
# Mint one of Outfitter's scoped LiteLLM keys and store it in Secret Manager. Run by hand, as the
# owner. Idempotent. KEY picks which:
#   KEY=admin (default)  outfitter-litellm-admin, mounted as LITELLM_ADMIN_KEY on both roles by
#                        service.sh: device/run key minting, spend, the router probe (#389)
#   KEY=local-hosts      outfitter-litellm-admin-key, mounted as LOCAL_HOST_ROUTER_KEY on the link
#                        role only: the Local Host router entries, /model/* routes only (#384,
#                        docs/specs/local-host.md §3.5). It can't mint or delete keys.
#   ./litellm-admin.sh                       # create the service user + key if the key doesn't exist yet
#   KEY=local-hosts ./litellm-admin.sh       # the same for the Local Host key
#   ROTATE=1 ./litellm-admin.sh              # mint a new key, add it as a new secret version, delete the old key
#   DRY_RUN=1 ./litellm-admin.sh             # show what would happen; reads nothing secret, writes nothing
#
# Why a scoped key instead of the master key (epic #389, #394; #378/#384):
# - The key belongs to the LiteLLM user `outfitter-svc` with user_role proxy_admin, so it may mint
#   keys for other users (device keys, run keys). LiteLLM takes the role from the user row, not
#   the key (auth/auth_checks.py `_is_user_proxy_admin`).
# - `allowed_routes` limits it to the routes the api calls (see ALLOWED_ROUTES). It is enforced for every
#   role, admins included (auth/route_checks.py), and needs no enterprise license. Only a
#   proxy_admin caller (the master key here) can set it.
# - /key/regenerate is premium-only, so rotation mints a new key under a new alias and deletes the
#   old one.
#
# The master key is read from Secret Manager into a shell variable and goes to curl through a
# process substitution, never argv or the terminal. The new key goes from curl's JSON straight
# into `gcloud secrets versions add --data-file=-`.
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ROUTER_URL="${ROUTER_URL:-https://router.kernal.one}"
MASTER_KEY_SECRET="${MASTER_KEY_SECRET:-kernal-litellm-prod-master-key}"
MASTER_KEY_PROJECT="${MASTER_KEY_PROJECT:-${PROJECT}}"
SVC_USER="outfitter-svc"
DRY_RUN="${DRY_RUN:-0}"
ROTATE="${ROTATE:-0}"
KEY="${KEY:-admin}"

# Each key's routes are exactly the routes the api calls with it; test/litellm-admin.test.sh fails
# if a list and the code drift apart in either direction.
case "${KEY}" in
  admin)
    # litellm-keys.ts, providers-status.ts, models.ts. Mounted on both roles, the public link
    # service included, so nothing beyond these: no /key/update, /key/list, /key/block or any
    # /model/new|update|delete (those are the local-hosts key's).
    ADMIN_SECRET="outfitter-litellm-admin"
    ALIAS_PREFIX="outfitter-admin"
    PURPOSE="device/run key minting, router probe"
    EPIC="389"
    ALLOWED_ROUTES='[
      "/key/generate", "/key/delete", "/key/info",
      "/user/new", "/user/info", "/user/list",
      "/team/new", "/team/list",
      "/spend/logs",
      "/model/info",
      "/health/liveliness"
    ]'
    ;;
  local-hosts)
    # local-hosts/router-sync.ts: the Local Host router entries (local/<user>-<host>/<model>).
    # Mounted on the link role only. allowed_routes is route-level, so the key itself could rewrite
    # any deployment: router-sync.ts only touches entries whose model_info.metadata it wrote
    # (outfitter: "local-host", env), and a router-fork guard limiting this key to those is a
    # follow-up (#466, local-host.md §3.5). A separate key from outfitter-litellm-admin (owner decision
    # 2026-10-05): that one mints keys and is on both roles.
    ADMIN_SECRET="outfitter-litellm-admin-key"
    ALIAS_PREFIX="outfitter-localhosts"
    PURPOSE="local host model entries (local/*), link role only"
    EPIC="384"
    ALLOWED_ROUTES='[
      "/model/info", "/model/new", "/model/update", "/model/delete"
    ]'
    ;;
  *) deploy_fail "KEY must be admin or local-hosts, not ${KEY}" ;;
esac

command -v jq >/dev/null || deploy_fail "jq is required"

gcloud_exists secrets describe "${MASTER_KEY_SECRET}" --project="${MASTER_KEY_PROJECT}" \
  || deploy_fail "secret ${MASTER_KEY_SECRET} not found in ${MASTER_KEY_PROJECT}; set MASTER_KEY_PROJECT"
secret_exists=0
gcloud_exists secrets describe "${ADMIN_SECRET}" --project="${PROJECT}" && secret_exists=1

echo "router=${ROUTER_URL} master=${MASTER_KEY_PROJECT}/${MASTER_KEY_SECRET} target=${PROJECT}/${ADMIN_SECRET} (exists=${secret_exists})"
echo "key=${KEY} service user=${SVC_USER} (proxy_admin), alias=${ALIAS_PREFIX}-*, routes=$(jq -c . <<<"${ALLOWED_ROUTES}")"
if [[ "${DRY_RUN}" == 1 ]]; then
  echo "DRY_RUN=1: stopping before reading the master key."
  exit 0
fi

MASTER="$(gcloud secrets versions access latest --secret="${MASTER_KEY_SECRET}" --project="${MASTER_KEY_PROJECT}")"
[[ -n "${MASTER}" ]] || deploy_fail "master key secret is empty"

# api METHOD PATH [JSON] -- prints the response body; fails on HTTP >= 400 without printing headers.
api() {
  local out code
  out="$(curl -sS -X "$1" "${ROUTER_URL}$2" \
    -H @<(printf 'Authorization: Bearer %s\n' "${MASTER}") \
    -H 'Content-Type: application/json' ${3:+--data-binary "$3"} -w '\n%{http_code}')"
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if (( code >= 400 )); then
    echo "router $1 $2 -> HTTP ${code}: $(jq -c '.error // .detail // .' <<<"${out}" 2>/dev/null | head -c 300)" >&2
    return 1
  fi
  printf '%s' "${out}"
}

# 1. The proxy_admin service user.
if api GET "/user/info?user_id=${SVC_USER}" >/dev/null 2>&1; then
  echo "~ user ${SVC_USER} exists"
else
  echo "+ create user ${SVC_USER}"
  api POST /user/new "$(jq -nc --arg u "${SVC_USER}" \
    '{user_id: $u, user_role: "proxy_admin", auto_create_key: false, metadata: {owner: "outfitter", epic: "389"}}')" >/dev/null
fi

# 2. Existing keys of that user under this key's alias prefix (the two prefixes don't overlap).
existing="$(api GET "/key/list?user_id=${SVC_USER}&return_full_object=true&size=100" \
  | jq -r --arg p "${ALIAS_PREFIX}-" '[.keys[]? | select((.key_alias // "") | startswith($p)) | .key_alias] | join(" ")')"
if [[ -n "${existing}" && "${ROTATE}" != 1 ]]; then
  echo "~ key(s) already exist: ${existing}. Nothing to do (ROTATE=1 to replace)."
  [[ "${secret_exists}" == 1 ]] || echo "  warning: ${ADMIN_SECRET} does not exist; the key value can't be recovered, rerun with ROTATE=1." >&2
  exit 0
fi

# 3. Mint. The alias carries a timestamp so a rotation never collides with the old alias.
alias="${ALIAS_PREFIX}-$(date -u +%Y%m%d%H%M%S)"
echo "+ mint key ${alias}"
new_key="$(api POST /key/generate "$(jq -nc --arg u "${SVC_USER}" --arg a "${alias}" --argjson r "${ALLOWED_ROUTES}" \
  --arg p "${PURPOSE}" --arg e "${EPIC}" \
  '{user_id: $u, key_alias: $a, allowed_routes: $r, metadata: {owner: "outfitter", purpose: $p, epic: $e}}')" \
  | jq -r '.key // empty')"
[[ "${new_key}" == sk-* ]] || deploy_fail "router returned no key"

# 4. Store it. A failure here leaves an orphan key on the router, so delete it before stopping.
if [[ "${secret_exists}" == 1 ]]; then
  store=(gcloud secrets versions add "${ADMIN_SECRET}" --project="${PROJECT}" --data-file=-)
else
  # shellcheck disable=SC2054 # the commas belong to --labels, not array separators
  store=(gcloud secrets create "${ADMIN_SECRET}" --project="${PROJECT}" --replication-policy=automatic \
    --labels=app=outfitter,purpose=litellm-${KEY} --data-file=-)
fi
if ! printf '%s' "${new_key}" | "${store[@]}" >/dev/null; then
  api POST /key/delete "$(jq -nc --arg a "${alias}" '{key_aliases: [$a]}')" >/dev/null || true
  deploy_fail "could not store the key in ${ADMIN_SECRET}; the new router key was deleted"
fi
unset new_key
echo "  stored as a new version of ${PROJECT}/${ADMIN_SECRET}"

# Older versions hold either the previous scoped key or, from README.md's original setup, the full
# master key. Disable them so nothing can mount them again (versions are kept, not destroyed).
latest="$(gcloud secrets versions list "${ADMIN_SECRET}" --project="${PROJECT}" --filter=state=enabled \
  --sort-by=~createTime --limit=1 --format='value(name)')"
for v in $(gcloud secrets versions list "${ADMIN_SECRET}" --project="${PROJECT}" --filter=state=enabled --format='value(name)'); do
  [[ "${v##*/}" == "${latest##*/}" ]] && continue
  echo "- disable old secret version ${v##*/}"
  gcloud secrets versions disable "${v##*/}" --secret="${ADMIN_SECRET}" --project="${PROJECT}" --quiet >/dev/null
done

# 5. Rotation: drop the old keys only after the new one is stored.
if [[ -n "${existing}" ]]; then
  echo "- delete old key(s): ${existing}"
  api POST /key/delete "$(jq -nc --arg s "${existing}" '{key_aliases: ($s | split(" "))}')" >/dev/null
fi

echo "Done. Running services pick it up on their next revision (release, or service.sh)."
