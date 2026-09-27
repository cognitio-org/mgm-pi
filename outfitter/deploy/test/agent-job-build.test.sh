#!/usr/bin/env bash
# agent-job.sh's Cloud Build config: BuildKit with an inline layer cache, taken from the image the
# job runs now, but only when that image is ours and still exists; otherwise the same build with
# no cache. Runs the real agent-job.sh against a throwaway git repo (deploy_guard needs one, same
# setup as guards.test.sh) and a fake gcloud that saves the config `builds submit` is handed. No
# network, no GCP.
#   bash outfitter/deploy/test/agent-job-build.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SRC="$(cd "${HERE}/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
# Never touch the real home directory (#152).
export HOME="${WORK}/home"
mkdir -p "${HOME}"

AR="us-central1-docker.pkg.dev/outfitter-509211/outfitter"
mkdir -p "${WORK}/bin"
# FAKE_CURRENT: the job's deployed image ("" = job not deployed). FAKE_CURRENT_EXISTS=1: it is
# still in Artifact Registry. The image being built never exists yet, so a build always runs.
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "run jobs describe outfitter-agent"*)
    [[ -n "${FAKE_CURRENT}" ]] || { echo "ERROR: NOT_FOUND" >&2; exit 1; }
    case "$*" in *"containers[0].image"*) echo "${FAKE_CURRENT}" ;; esac ;;
  "artifacts docker images describe "*)
    [[ "$5" == "${FAKE_CURRENT}" && "${FAKE_CURRENT_EXISTS}" == 1 ]] || exit 1 ;;
  "builds submit"*)
    for a in "$@"; do [[ "${a}" == --config=* ]] && cp "${a#--config=}" "${BUILD_CONFIG}"; done ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/gcloud"
export PATH="${WORK}/bin:${PATH}"
unset GITHUB_ACTIONS ROLLBACK ALLOW_OFF_MAIN ALLOW_SKEW

git init -q --bare "${WORK}/origin.git"
git clone -q "${WORK}/origin.git" "${WORK}/repo" 2>/dev/null
REPO="${WORK}/repo"
git -C "${REPO}" config user.email t@example.com
git -C "${REPO}" config user.name test
git -C "${REPO}" checkout -q -b main
mkdir -p "${REPO}/outfitter/deploy" "${REPO}/kernal"
cp "${DEPLOY_SRC}/env.sh" "${DEPLOY_SRC}/config.env" "${DEPLOY_SRC}/agent-job.sh" "${REPO}/outfitter/deploy/"
echo k >"${REPO}/kernal/k.txt"
git -C "${REPO}" add -A && git -C "${REPO}" commit -q -m one
git -C "${REPO}" push -q origin main
TAG="$(git -C "${REPO}" rev-parse --short=12 HEAD)"

pass=0 fail=0
# build <name> <FAKE_CURRENT> <FAKE_CURRENT_EXISTS>: runs agent-job.sh, leaving the config in
# ${BUILD_CONFIG} and the output in ${OUT}.
BUILD_CONFIG="${WORK}/cloudbuild.yaml" OUT="${WORK}/out.txt"
build() {
  rm -f "${BUILD_CONFIG}"
  if ! (cd "${REPO}/outfitter/deploy" && FAKE_CURRENT="$2" FAKE_CURRENT_EXISTS="$3" \
      BUILD_CONFIG="${BUILD_CONFIG}" OUTFITTER_API=https://link.example DEPLOY_ALL_COMMIT="${TAG}" \
      bash ./agent-job.sh) >"${OUT}" 2>&1; then
    fail=$((fail + 1)); echo "FAIL $1: agent-job.sh failed:"; cat "${OUT}"; return 1
  fi
  [[ -f "${BUILD_CONFIG}" ]] || { fail=$((fail + 1)); echo "FAIL $1: no build submitted"; return 1; }
}
check() {  # check <name> <grep -E pattern> <want: yes|no> [file]
  local got=no
  grep -qE -- "$2" "${4:-${BUILD_CONFIG}}" && got=yes
  if [[ "${got}" == "$3" ]]; then pass=$((pass + 1)); echo "ok   $1"
  else fail=$((fail + 1)); echo "FAIL $1: wanted '$2' present=$3 in:"; cat "${4:-${BUILD_CONFIG}}"; fi
}
# The args line is a YAML flow sequence built by string concatenation: parse it, where a YAML
# parser is at hand, so a stray comma or quote fails here instead of in Cloud Build.
parses() {
  local ok=""
  if python3 -c 'import yaml' 2>/dev/null; then
    python3 -c 'import sys, yaml; a = yaml.safe_load(open(sys.argv[1]))["steps"][0]["args"]; assert a[0] == "build" and a[-1] == ".", a' "${BUILD_CONFIG}" && ok=yes || ok=no
  elif command -v ruby >/dev/null; then
    ruby -ryaml -e 'a = YAML.safe_load(File.read(ARGV[0]))["steps"][0]["args"]; exit(a[0] == "build" && a[-1] == "." ? 0 : 1)' "${BUILD_CONFIG}" && ok=yes || ok=no
  fi
  case "${ok}" in
    yes) pass=$((pass + 1)); echo "ok   $1: config parses as YAML" ;;
    no) fail=$((fail + 1)); echo "FAIL $1: config doesn't parse:"; cat "${BUILD_CONFIG}" ;;
    *) echo "skip $1: no YAML parser (python3 yaml or ruby)" ;;
  esac
}

CURRENT="${AR}/outfitter-agent:old000000001"
if build "cached" "${CURRENT}" 1; then
  parses "cached"
  check "cached: BuildKit on" '"DOCKER_BUILDKIT=1"' yes
  check "cached: inline cache written" '"BUILDKIT_INLINE_CACHE=1"' yes
  check "cached: --cache-from the deployed image" "\"--cache-from\", \"${CURRENT}\"" yes
  check "cached: builds this commit's tag" "\"-t\", \"${AR}/outfitter-agent:${TAG}\"" yes
  check "cached: log names the cache" "layer cache: ${CURRENT}" yes "${OUT}"
fi
if build "first deploy" "" 0; then
  parses "first deploy"
  check "first deploy: no --cache-from" '--cache-from' no
  check "first deploy: inline cache still written" '"BUILDKIT_INLINE_CACHE=1"' yes
  check "first deploy: log says no cache" 'layer cache: none' yes "${OUT}"
fi
if build "deployed image deleted" "${CURRENT}" 0; then
  check "deployed image deleted: no --cache-from" '--cache-from' no
fi
if build "deployed image from elsewhere" "gcr.io/someone-else/outfitter-agent:x" 1; then
  check "deployed image from elsewhere: no --cache-from" '--cache-from' no
fi

echo "${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
