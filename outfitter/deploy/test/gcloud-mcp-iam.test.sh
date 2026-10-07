#!/usr/bin/env bash
# gcloud-mcp-iam.sh against a fake gcloud that keeps the project IAM policy, the enabled services and
# the deny policy in files. Checks: DRY_RUN changes nothing and needs no client id; a real run needs
# the client id (and rejects a malformed one); the first run enables cloudcli, grants
# roles/mcp.toolUser to each operator and creates the deny policy with the documented permission and
# condition; a rerun changes nothing; a different client id updates the policy with its etag;
# GCLOUD_MCP_SYSOPS overrides the operators. No network, no GCP.
#   bash outfitter/deploy/test/gcloud-mcp-iam.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../gcloud-mcp-iam.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
export HOME="${WORK}/home"; mkdir -p "${HOME}"
export STATE="${WORK}/state"; mkdir -p "${STATE}"
echo '{"bindings":[{"role":"roles/owner","members":["user:mgm@mgms.eu"]}]}' >"${STATE}/iam.json"
: >"${STATE}/services"
: >"${STATE}/calls"

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
# Mutating calls are logged to ${STATE}/calls; reads are not.
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "services list"*) cat "${STATE}/services" ;;
  "services enable "*) echo "$*" >>"${STATE}/calls"; echo "$3" >"${STATE}/services" ;;
  "projects get-iam-policy "*) cat "${STATE}/iam.json" ;;
  "projects add-iam-policy-binding "*)
    echo "$*" >>"${STATE}/calls"
    [[ "$*" == *--condition=None* ]] || { echo "fake gcloud: add-iam-policy-binding without --condition=None" >&2; exit 1; }
    member="" role=""
    for a in "$@"; do case "$a" in --member=*) member="${a#--member=}" ;; --role=*) role="${a#--role=}" ;; esac; done
    jq --arg m "${member}" --arg r "${role}" '.bindings += [{role: $r, members: [$m]}]' "${STATE}/iam.json" >"${STATE}/iam.tmp"
    mv "${STATE}/iam.tmp" "${STATE}/iam.json" ;;
  "iam policies get "*)
    [[ -f "${STATE}/deny.json" ]] || { echo "ERROR: NOT_FOUND: policy does not exist" >&2; exit 1; }
    cat "${STATE}/deny.json" ;;
  "iam policies create "*|"iam policies update "*)
    echo "$*" >>"${STATE}/calls"
    [[ "$*" == *--kind=denypolicies* && "$*" == *--attachment-point=cloudresourcemanager.googleapis.com/projects/outfitter-509211* ]] \
      || { echo "fake gcloud: bad policies flags: $*" >&2; exit 1; }
    for a in "$@"; do [[ "$a" == --policy-file=* ]] && f="${a#--policy-file=}"; done
    n=$(( $(cat "${STATE}/etag" 2>/dev/null || echo 0) + 1 )); echo "${n}" >"${STATE}/etag"
    jq --arg e "etag-${n}" '. + {etag: $e, uid: "u"}' "${f}" >"${STATE}/deny.json" ;;
  *) echo "fake gcloud: unexpected $*" >&2; exit 1 ;;
esac
SH
chmod +x "${WORK}/bin/gcloud"
export PATH="${WORK}/bin:${PATH}"
unset GITHUB_ACTIONS DRY_RUN GCLOUD_MCP_OAUTH_CLIENT_ID GCLOUD_MCP_SYSOPS

fail() { echo "FAIL: $*" >&2; exit 1; }
CLIENT=111111111111-abcdef0ghi.apps.googleusercontent.com
run() { bash "${SCRIPT}" >"${WORK}/out" 2>&1 || { cat "${WORK}/out"; fail "script exited non-zero"; }; }
calls() { wc -l <"${STATE}/calls" | tr -d ' '; }

# DRY_RUN: no client id needed, nothing mutated, plan printed.
DRY_RUN=1 run
[[ "$(calls)" == 0 ]] || fail "DRY_RUN mutated: $(cat "${STATE}/calls")"
grep -q "+ user:mgm@mgms.eu: grant roles/mcp.toolUser" "${WORK}/out" || fail "plan lacks the grant"
grep -q "+ deny policy gcloud-mcp-gateway-only: create" "${WORK}/out" || fail "plan lacks the deny policy"
grep -q "gcloud services enable cloudcli.googleapis.com" "${WORK}/out" || fail "plan lacks the API enable"

# A real run needs a well-formed client id.
bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "ran without GCLOUD_MCP_OAUTH_CLIENT_ID"
grep -q "GCLOUD_MCP_OAUTH_CLIENT_ID is required" "${WORK}/out" || fail "wrong error without a client id"
GCLOUD_MCP_OAUTH_CLIENT_ID="x'] || true || ['" bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "accepted a malformed client id"
[[ "$(calls)" == 0 ]] || fail "a refused run mutated"

# First run.
export GCLOUD_MCP_OAUTH_CLIENT_ID="${CLIENT}"
run
for who in mgm@mgms.eu matej@mgms.eu; do
  jq -e --arg m "user:${who}" '[.bindings[] | select(.role == "roles/mcp.toolUser" and (.members | index($m)))] | length == 1' "${STATE}/iam.json" >/dev/null \
    || fail "${who} not granted roles/mcp.toolUser"
done
grep -q "services enable cloudcli.googleapis.com" "${STATE}/calls" || fail "cloudcli not enabled"
grep -q "iam policies create gcloud-mcp-gateway-only" "${STATE}/calls" || fail "deny policy not created"
rule="$(jq -c '.rules[0].denyRule' "${STATE}/deny.json")"
[[ "$(jq -r '.deniedPermissions[0]' <<<"${rule}")" == "mcp.googleapis.com/tools.call" ]] || fail "wrong denied permission"
[[ "$(jq -r '.deniedPrincipals[0]' <<<"${rule}")" == "principalSet://goog/public:all" ]] || fail "wrong denied principals"
[[ "$(jq -r '.denialCondition.expression' <<<"${rule}")" == "!(request.auth.oauth.client_id == '${CLIENT}')" ]] || fail "wrong condition: ${rule}"
[[ "$(calls)" == 4 ]] || fail "expected 4 mutating calls (enable, 2 grants, create), got $(calls)"

# Rerun: nothing.
before="$(calls)"
run
[[ "$(calls)" == "${before}" ]] || fail "rerun mutated: $(tail -n +$((before + 1)) "${STATE}/calls")"
grep -q "already up to date" "${WORK}/out" || fail "rerun didn't report the policy as current"

# A different client id updates the policy, passing the etag.
GCLOUD_MCP_OAUTH_CLIENT_ID=222222222222-zzzz.apps.googleusercontent.com run
tail -1 "${STATE}/calls" | grep -q "iam policies update gcloud-mcp-gateway-only .*--etag=etag-1" || fail "no etag update: $(tail -1 "${STATE}/calls")"
jq -r '.rules[0].denyRule.denialCondition.expression' "${STATE}/deny.json" | grep -q 222222222222-zzzz || fail "policy not updated"

# GCLOUD_MCP_SYSOPS overrides the operators (',' or ';').
GCLOUD_MCP_SYSOPS="new@example.com, other@example.com" run
for who in new@example.com other@example.com; do
  jq -e --arg m "user:${who}" '[.bindings[] | .members[] | select(. == $m)] | length == 1' "${STATE}/iam.json" >/dev/null || fail "${who} not granted"
done
GCLOUD_MCP_SYSOPS="not-an-email" bash "${SCRIPT}" >"${WORK}/out" 2>&1 && fail "accepted a bad sysop"

echo "gcloud-mcp-iam.test.sh: ok"
