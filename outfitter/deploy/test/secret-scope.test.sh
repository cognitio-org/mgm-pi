#!/usr/bin/env bash
# secret-scope.sh against a fake gcloud holding a JSON IAM policy. Checks: DRY_RUN changes nothing;
# a real run adds both scoped bindings before removing either project-wide one; the conditions
# name the outfitter- prefix (and the project clause only on the admin role); a rerun is a no-op.
# No network, no GCP.
#   bash outfitter/deploy/test/secret-scope.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../secret-scope.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
export HOME="${WORK}/home"; mkdir -p "${HOME}"
export POLICY="${WORK}/policy.json" CALLS="${WORK}/calls"
SA="serviceAccount:outfitter-api@outfitter-509211.iam.gserviceaccount.com"
ADMIN="projects/outfitter-509211/roles/outfitterSecretAdmin"
jq -n --arg m "${SA}" --arg a "${ADMIN}" '{bindings: [
  {role: "roles/secretmanager.secretAccessor", members: [$m]},
  {role: $a, members: [$m]},
  {role: "roles/run.developer", members: [$m]}]}' >"${POLICY}"
: >"${CALLS}"

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
arg() { for a in "$@"; do [[ "${a}" == "$1"=* ]] && { echo "${a#*=}"; return; }; done; }
val() { local k="$1"; shift; for a in "$@"; do [[ "${a}" == "${k}="* ]] && { echo "${a#*=}"; return; }; done; }
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "projects describe"*) echo 97916961297 ;;
  "projects get-iam-policy"*) cat "${POLICY}" ;;
  "projects add-iam-policy-binding"*)
    m="$(val --member "$@")"; r="$(val --role "$@")"; c="$(val --condition "$@")"
    expr="${c#expression=}"; expr="${expr%%,title=*}"; title="${c#*,title=}"; title="${title%%,*}"
    echo "add ${r} ${expr}" >>"${CALLS}"
    jq --arg m "$m" --arg r "$r" --arg e "$expr" --arg t "$title" \
      '.bindings += [{role: $r, members: [$m], condition: {expression: $e, title: $t}}]' "${POLICY}" >"${POLICY}.n" && mv "${POLICY}.n" "${POLICY}" ;;
  "projects remove-iam-policy-binding"*)
    m="$(val --member "$@")"; r="$(val --role "$@")"
    echo "remove ${r}" >>"${CALLS}"
    jq --arg m "$m" --arg r "$r" '.bindings |= map(select(.role != $r or .condition != null))' "${POLICY}" >"${POLICY}.n" && mv "${POLICY}.n" "${POLICY}" ;;
  "policy-intelligence troubleshoot-policy"*) exit 1 ;;
  *) echo "fake gcloud: unexpected $*" >&2; exit 1 ;;
esac
SH
chmod +x "${WORK}/bin/gcloud"
export PATH="${WORK}/bin:${PATH}"
unset GITHUB_ACTIONS
fail() { echo "FAIL: $*" >&2; exit 1; }

DRY_RUN=1 bash "${SCRIPT}" >/dev/null
[[ ! -s "${CALLS}" ]] || fail "DRY_RUN changed the policy"

bash "${SCRIPT}" >"${WORK}/out" 2>&1 || { cat "${WORK}/out"; fail "script failed"; }
[[ "$(sed -n 1p "${CALLS}")" == add\ roles/secretmanager.secretAccessor* ]] || fail "first call is not the scoped accessor add"
[[ "$(sed -n 2p "${CALLS}")" == add\ ${ADMIN}* ]] || fail "second call is not the scoped admin add"
[[ "$(sed -n 3p "${CALLS}")" == remove* && "$(sed -n 4p "${CALLS}")" == remove* ]] || fail "removals must come after both adds"
grep -q 'add roles/secretmanager.secretAccessor resource.name.startsWith("projects/97916961297/secrets/outfitter-")$' "${CALLS}" \
  || fail "accessor condition wrong (must be the prefix only)"
grep -q "add ${ADMIN} .*secrets/outfitter-\").*cloudresourcemanager.googleapis.com/Project" "${CALLS}" || fail "admin condition wrong"
jq -e --arg m "${SA}" '[.bindings[] | select((.members|index($m)) and .condition == null and (.role|test("secret")))] | length == 0' "${POLICY}" >/dev/null \
  || fail "a project-wide secret binding is left"
jq -e '[.bindings[] | select(.role == "roles/run.developer")] | length == 1' "${POLICY}" >/dev/null || fail "unrelated binding touched"

: >"${CALLS}"
bash "${SCRIPT}" >/dev/null 2>&1
[[ ! -s "${CALLS}" ]] || fail "rerun changed the policy"
echo "secret-scope.test.sh: ok"
