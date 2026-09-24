#!/usr/bin/env bash
# service.sh's --set-env-vars list with GKE_CLUSTER empty (forced off in the test's config.env copy,
# whatever the checked-in default is) must be exactly
# what it was before GKE_* existed: no GKE_ substring anywhere in it. Against a throwaway git repo
# (deploy_guard needs one, same setup as guards.test.sh) and fake gcloud (build/deploy skipped by
# reporting the image as already built). No network, no GCP.
#   bash outfitter/deploy/test/service-env-gke-off.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SRC="$(cd "${HERE}/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
# Never touch the real home directory: env.sh's gke_kubeconfig defaults to ~/.kube/outfitter, and a
# case that reaches it without KUBECONFIG_OUTFITTER once truncated a developer's real one (#152).
export HOME="${WORK}/home"
mkdir -p "${HOME}"

# A throwaway repo with its own "origin" (deploy_guard's committed-main checks). commit_tag/
# regression_guard need real git; the fake TAG below is deliberately not a real commit here, so
# regression_guard's "not a commit on main" branch (a soft warning, not a refusal) is what fires.
git init -q --bare "${WORK}/origin.git"
git clone -q "${WORK}/origin.git" "${WORK}/repo" 2>/dev/null
REPO="${WORK}/repo"
git -C "${REPO}" config user.email t@example.com
git -C "${REPO}" config user.name test
git -C "${REPO}" checkout -q -b main
mkdir -p "${REPO}/outfitter/deploy"
cp "${DEPLOY_SRC}/env.sh" "${DEPLOY_SRC}/config.env" "${DEPLOY_SRC}/service.sh" "${REPO}/outfitter/deploy/"
# Force GKE off in this copy's file line, whatever the checked-in default is, so the test doesn't
# depend on the default's value or on its expansion form (`-` vs `:-`).
CFG="${REPO}/outfitter/deploy/config.env"
sed 's/^GKE_CLUSTER=.*/GKE_CLUSTER=""/' "${CFG}" >"${CFG}.tmp" && mv "${CFG}.tmp" "${CFG}"
grep -qx 'GKE_CLUSTER=""' "${CFG}" || { echo "FAIL: couldn't force GKE_CLUSTER off in the test's config.env"; exit 1; }
git -C "${REPO}" add -A && git -C "${REPO}" commit -q -m one
git -C "${REPO}" push -q origin main
TAG="$(git -C "${REPO}" rev-parse --short=12 HEAD)"

mkdir -p "${WORK}/bin"
cat >"${WORK}/bin/gcloud" <<SH
#!/usr/bin/env bash
echo "\$*" >>"\${GCLOUD_CALLS}"
case "\$*" in
  "auth list"*) echo "\${CLOUDSDK_CORE_ACCOUNT}" ;;
  "artifacts docker images describe"*) exit 0 ;;   # image_exists: already built, skip Cloud Build
  *"run services describe outfitter-api"*"--format=value(spec.template.spec.containers[0].image)"*)
    printf 'us-central1-docker.pkg.dev/outfitter-509211/outfitter/outfitter-api:notarealcommit1\n' ;;
  *"run services describe outfitter-api"*"--format=value(spec.template.spec.containers[0].env.filter(name=OUTFITTER_ORIGIN)"*)
    printf 'https://outfitter-api-abc.run.app\n' ;;
  *"run services describe outfitter-api"*"--format=value(status.url)"*)
    printf 'https://outfitter-api-abc.run.app\n' ;;
  *"run services describe outfitter-api"*"--format=value(metadata.labels)"*)
    printf 'build-commit=${TAG}\n' ;;
  "run services describe outfitter-api"*) exit 0 ;;
  *"run services describe outfitter-link"*"--format=value(metadata.labels)"*)
    printf 'build-commit=${TAG}\n' ;;
  "run services describe outfitter-link"*) exit 0 ;;
  *"run jobs describe outfitter-agent"*"--format=value(metadata.labels)"*)
    printf 'build-commit=${TAG}\n' ;;
  "run jobs describe outfitter-agent"*) exit 0 ;;
  "beta run domain-mappings list"*) printf '[]' ;;
  "tasks queues describe outfitter-wake"*) echo "ERROR: NOT_FOUND" >&2; exit 1 ;;
  "iam service-accounts describe outfitter-tasks"*) echo "ERROR: NOT_FOUND" >&2; exit 1 ;;
  "projects describe"*) printf '123456789012\n' ;;
  "run deploy outfitter-api"*) exit 0 ;;
esac
exit 0
SH
chmod +x "${WORK}/bin/gcloud"

export PATH="${WORK}/bin:${PATH}"
export GCLOUD_CALLS="${WORK}/gcloud-calls" OUTFITTER_LINK_ORIGIN=https://outfitter-link-abc.run.app
unset GITHUB_ACTIONS ROLLBACK ALLOW_OFF_MAIN ALLOW_SKEW ALLOW_ORIGIN_CHANGE GKE_CLUSTER \
  CLOUD_TASKS_QUEUE TASKS_SA_EMAIL DEPLOY_ALL_COMMIT
: >"${GCLOUD_CALLS}"

fails=0
status=0
OUT="$(cd "${REPO}/outfitter/deploy" && ./service.sh web 2>&1)" || status=$?
if [[ ${status} -ne 0 ]]; then
  echo "FAIL: service.sh web (GKE off) exited ${status}"
  echo "${OUT}" | sed 's/^/    /'
  fails=$((fails + 1))
else
  echo "ok: service.sh web (GKE off) exits 0"
fi

DEPLOY_CALL="$(grep '^run deploy outfitter-api' "${GCLOUD_CALLS}" || true)"
if [[ -z "${DEPLOY_CALL}" ]]; then
  echo "FAIL: no 'gcloud run deploy outfitter-api ...' call was recorded"
  echo "${OUT}" | sed 's/^/    /'
  fails=$((fails + 1))
  echo "${fails} failed"
  exit 1
fi
echo "ok: gcloud run deploy outfitter-api was called"

ENV_VARS_ARG="$(grep -oE -- '--set-env-vars=[^ ]*' <<<"${DEPLOY_CALL}" || true)"
if [[ -z "${ENV_VARS_ARG}" ]]; then
  echo "FAIL: no --set-env-vars= argument found in the deploy call"
  fails=$((fails + 1))
else
  echo "ok: --set-env-vars was passed"
fi

if grep -q 'GKE_' <<<"${ENV_VARS_ARG}"; then
  echo "FAIL: --set-env-vars contains a GKE_ variable while GKE is off: ${ENV_VARS_ARG}"
  fails=$((fails + 1))
else
  echo "ok: --set-env-vars has no GKE_ variable while GKE is off"
fi

EXPECTED="OUTFITTER_ROLE=web,OUTFITTER_ORIGIN=https://outfitter-api-abc.run.app,OUTFITTER_ORIGIN_ALIASES=,AGENT_SA_EMAIL=outfitter-agent@outfitter-509211.iam.gserviceaccount.com,GCP_PROJECT=outfitter-509211,GCP_REGION=us-central1,TUNNEL_DOMAIN_LMSTUDIO=mgm-lmstudio.ngrok.app,SANDBOX_PROVIDER=cloudrun,CLOUDRUN_JOB=outfitter-agent,IDLE_STOP_SECONDS=1800,LITELLM_BASE_URL=https://litellm.augment-code.support/v1,PROVIDER_POLL_MS=300000,IAP_AUDIENCE=/projects/123456789012/locations/us-central1/services/outfitter-api,OUTFITTER_LINK_ORIGIN=https://outfitter-link-abc.run.app,OUTFITTER_OPERATORS=mgm@mgms.eu;matej@mgms.eu"
if [[ "${ENV_VARS_ARG}" == "--set-env-vars=${EXPECTED}" ]]; then
  echo "ok: --set-env-vars is exactly config.env's pre-GKE list, unchanged"
else
  echo "FAIL: --set-env-vars doesn't match the expected pre-GKE list"
  echo "  got:      ${ENV_VARS_ARG}"
  echo "  expected: --set-env-vars=${EXPECTED}"
  fails=$((fails + 1))
fi

echo "${fails} failed"
[[ "${fails}" -eq 0 ]]
