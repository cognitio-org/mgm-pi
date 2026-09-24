#!/usr/bin/env bash
# env.sh's deploy_guard and regression_guard against a throwaway git repo with its own "origin",
# and a fake gcloud (env.sh checks the pinned account is logged in). No network, no GCP.
#   bash outfitter/deploy/test/guards.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
# Never touch the real home directory: env.sh's gke_kubeconfig defaults to ~/.kube/outfitter, and a
# case that reaches it without KUBECONFIG_OUTFITTER once truncated a developer's real one (#152).
export HOME="${WORK}/home"
mkdir -p "${HOME}"

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
[[ "$1 $2" == "auth list" ]] && echo "${CLOUDSDK_CORE_ACCOUNT}"
exit 0
SH
chmod +x "${WORK}/bin/gcloud"
export PATH="${WORK}/bin:${PATH}"
unset GITHUB_ACTIONS ROLLBACK ALLOW_OFF_MAIN

git init -q --bare "${WORK}/origin.git"
git clone -q "${WORK}/origin.git" "${WORK}/repo" 2>/dev/null
REPO="${WORK}/repo"
git -C "${REPO}" config user.email t@example.com
git -C "${REPO}" config user.name test
git -C "${REPO}" checkout -q -b main
mkdir -p "${REPO}/outfitter/deploy" "${REPO}/kernal"
cp "${HERE}/../env.sh" "${HERE}/../config.env" "${REPO}/outfitter/deploy/"
echo one >"${REPO}/outfitter/app.txt"
echo k >"${REPO}/kernal/k.txt"
git -C "${REPO}" add -A && git -C "${REPO}" commit -q -m one
FIRST="$(git -C "${REPO}" rev-parse --short HEAD)"
echo two >"${REPO}/outfitter/app.txt"
git -C "${REPO}" commit -q -am two
SECOND="$(git -C "${REPO}" rev-parse --short HEAD)"
git -C "${REPO}" push -q origin main

pass=0 fail=0
# check <name> <expect ok|refuse> <shell snippet run after sourcing env.sh, in the repo>
check() {
  local name="$1" want="$2" got out
  out="$(cd "${REPO}" && bash -c "source outfitter/deploy/env.sh >/dev/null && $3" 2>&1)" && got=ok || got=refuse
  if [[ "${got}" == "${want}" ]]; then
    pass=$((pass + 1)); echo "ok   ${name}"
  else
    fail=$((fail + 1)); echo "FAIL ${name}: wanted ${want}, got ${got}: ${out}"
  fi
}

check "clean, up-to-date main" ok "deploy_guard kernal outfitter"
echo dirty >>"${REPO}/outfitter/app.txt"
check "uncommitted change under outfitter/" refuse "deploy_guard outfitter"
check "uncommitted change elsewhere is ignored for kernal/" ok "deploy_guard kernal"
git -C "${REPO}" checkout -q -- outfitter/app.txt
git -C "${REPO}" checkout -q -b feature
echo three >"${REPO}/outfitter/app.txt" && git -C "${REPO}" commit -q -am three
check "commit not on origin/main" refuse "deploy_guard outfitter"
check "ALLOW_OFF_MAIN=1 skips it" ok "ALLOW_OFF_MAIN=1 deploy_guard outfitter"
git -C "${REPO}" checkout -q --detach "${FIRST}"
check "behind origin/main" refuse "deploy_guard outfitter"
check "behind origin/main with ROLLBACK=1" ok "ROLLBACK=1 deploy_guard outfitter"
check "behind origin/main in GitHub Actions (a newer run is queued)" ok "GITHUB_ACTIONS=true deploy_guard outfitter"
check "production runs a newer commit than HEAD" refuse "regression_guard img:${SECOND}"
check "same, with ROLLBACK=1" ok "ROLLBACK=1 regression_guard img:${SECOND}"
git -C "${REPO}" checkout -q main
check "production runs an older commit" ok "regression_guard img:${FIRST}"
check "production tag isn't a commit here" ok "regression_guard img:1690000000"
check "nothing deployed yet" ok "regression_guard ''"

echo "${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
