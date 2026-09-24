#!/usr/bin/env bash
# DRY_RUN=1 ./release.sh with GKE_CLUSTER empty (config.env's default) must never call kubectl or
# any `gcloud container` command -- GKE-off releases are byte-for-byte what they were before this
# PR. Against a throwaway git repo (deploy_guard needs one, same setup as guards.test.sh) and fake
# gcloud/kubectl/curl. No network, no GCP.
#   bash outfitter/deploy/test/release-gke-off.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SRC="$(cd "${HERE}/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"${GCLOUD_CALLS}"
case "$*" in
  "auth list"*) echo "${CLOUDSDK_CORE_ACCOUNT}" ;;
  "run services describe kernal-web"*) echo "ERROR: NOT_FOUND" >&2; exit 1 ;;
  *"run services describe"*"--format=value(status.url)"*)
    case "$*" in
      *outfitter-link*) printf 'https://outfitter-link-abc.run.app\n' ;;
      *) printf 'https://outfitter-api-abc.run.app\n' ;;
    esac ;;
  *"run services describe outfitter-api"*iap-enabled*) printf 'true\n' ;;
  *"run services describe"*"--format=value(metadata.labels)"*) printf 'build-commit=old000000001\n' ;;
  *"run services describe"*"--format=value(spec.template.spec.containers[0].image)"*)
    printf 'us-central1-docker.pkg.dev/outfitter-509211/outfitter/outfitter-api:old000000001\n' ;;
  *"run services describe"*"--format=value(status.latestReadyRevisionName)"*) printf 'rev1\n' ;;
  *"run services describe"*"--format=value(status.latestCreatedRevisionName)"*) printf 'rev1\n' ;;
  "run services describe"*) exit 0 ;;
  "run jobs describe outfitter-agent"*"--format=value(metadata.labels)"*) printf 'build-commit=old000000001\n' ;;
  "run jobs describe outfitter-agent"*"--format=value(spec.template.spec.template.spec.containers[0].image)"*)
    printf 'us-central1-docker.pkg.dev/outfitter-509211/outfitter/outfitter-agent:old000000001\n' ;;
  "run jobs describe"*) exit 0 ;;
  "scheduler jobs describe outfitter-tick"*) echo "ERROR: NOT_FOUND" >&2; exit 1 ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/gcloud"

# Present but must never be called: any invocation is recorded, and the test fails if the log is
# non-empty.
cat >"${WORK}/bin/kubectl" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"${KUBECTL_CALLS}"
exit 0
SH
chmod +x "${WORK}/bin/kubectl"

cat >"${WORK}/bin/curl" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *"/api/sessions"*) printf '401' ;;
  *) printf '302' ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/curl"

# A throwaway repo with its own "origin" (deploy_guard's committed-main checks), same shape as
# guards.test.sh. release.sh's DRY_RUN path never actually executes service.sh/agent-job.sh/
# mailbox.sh/landing.sh/gke-template.sh (only prints what it would run), so none of those need to
# exist here -- just env.sh, config.env and release.sh itself.
git init -q --bare "${WORK}/origin.git"
git clone -q "${WORK}/origin.git" "${WORK}/repo" 2>/dev/null
REPO="${WORK}/repo"
git -C "${REPO}" config user.email t@example.com
git -C "${REPO}" config user.name test
git -C "${REPO}" checkout -q -b main
mkdir -p "${REPO}/outfitter/deploy" "${REPO}/kernal"
cp "${DEPLOY_SRC}/env.sh" "${DEPLOY_SRC}/config.env" "${DEPLOY_SRC}/release.sh" "${REPO}/outfitter/deploy/"
echo k >"${REPO}/kernal/k.txt"
git -C "${REPO}" add -A && git -C "${REPO}" commit -q -m one
git -C "${REPO}" push -q origin main

export PATH="${WORK}/bin:${PATH}"
export GCLOUD_CALLS="${WORK}/gcloud-calls" KUBECTL_CALLS="${WORK}/kubectl-calls" DRY_RUN=1
unset GITHUB_ACTIONS ROLLBACK ALLOW_OFF_MAIN ALLOW_SKEW FORCE_ALL MANUAL GKE_CLUSTER
: >"${GCLOUD_CALLS}"; : >"${KUBECTL_CALLS}"

fails=0
status=0
OUT="$(cd "${REPO}/outfitter/deploy" && ./release.sh 2>&1)" || status=$?
if [[ ${status} -ne 0 ]]; then
  echo "FAIL: DRY_RUN=1 ./release.sh with GKE off exited ${status}"
  echo "${OUT}" | sed 's/^/    /'
  fails=$((fails + 1))
else
  echo "ok: DRY_RUN=1 ./release.sh with GKE off exits 0"
fi

if [[ -s "${KUBECTL_CALLS}" ]]; then
  echo "FAIL: kubectl was called while GKE is off:"
  sed 's/^/    /' "${KUBECTL_CALLS}"
  fails=$((fails + 1))
else
  echo "ok: kubectl was never called"
fi

if grep -qE '^container ' "${GCLOUD_CALLS}"; then
  echo "FAIL: a 'gcloud container ...' call was made while GKE is off:"
  grep -E '^container ' "${GCLOUD_CALLS}" | sed 's/^/    /'
  fails=$((fails + 1))
else
  echo "ok: no 'gcloud container ...' call was made"
fi

if grep -q "GKE_CLUSTER is empty; skipping" <<<"${OUT}"; then
  echo "ok: the GKE template step reports itself skipped"
else
  echo "FAIL: expected the GKE template step to announce it's skipped"
  fails=$((fails + 1))
fi

echo "${fails} failed"
[[ "${fails}" -eq 0 ]]
