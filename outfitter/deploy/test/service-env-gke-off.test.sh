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
# depend on the default's value or on its expansion form (`-` vs `:-`). GKE off means Cloud Run is
# the provider too (the checked-in default is gke since 2026-09-26), so force that line as well.
CFG="${REPO}/outfitter/deploy/config.env"
# Previews (#217) and web voice's DEEPGRAM_PROJECT_ID (#252) off too by default here, so the GKE-off list below stays the pre-GKE one; the
# previews and voice cases at the end turn them on from the environment.
sed -e 's/^GKE_CLUSTER=.*/GKE_CLUSTER=""/' -e 's/^SANDBOX_PROVIDER=.*/SANDBOX_PROVIDER="cloudrun"/' \
  -e 's/^PREVIEW_DOMAIN=.*/PREVIEW_DOMAIN="${PREVIEW_DOMAIN-}"/' \
  -e 's/^DEEPGRAM_PROJECT_ID=.*/DEEPGRAM_PROJECT_ID="${DEEPGRAM_PROJECT_ID-}"/' \
  "${CFG}" >"${CFG}.tmp" && mv "${CFG}.tmp" "${CFG}"
grep -qx 'GKE_CLUSTER=""' "${CFG}" || { echo "FAIL: couldn't force GKE_CLUSTER off in the test's config.env"; exit 1; }
grep -qx 'SANDBOX_PROVIDER="cloudrun"' "${CFG}" || { echo "FAIL: couldn't force SANDBOX_PROVIDER=cloudrun in the test's config.env"; exit 1; }
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
# GITHUB_REF_NAME/OUTFITTER_RELEASE too: in the release workflow the ref is the outfitter-v* tag, and
# service.sh would add OUTFITTER_RELEASE to the baseline list below (the release case sets it itself).
unset GITHUB_REF_NAME OUTFITTER_RELEASE
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

EXPECTED="OUTFITTER_ROLE=web,OUTFITTER_ORIGIN=https://outfitter-api-abc.run.app,OUTFITTER_ORIGIN_ALIASES=,AGENT_SA_EMAIL=outfitter-agent@outfitter-509211.iam.gserviceaccount.com,GCP_PROJECT=outfitter-509211,GCP_REGION=us-central1,TUNNEL_DOMAIN_LMSTUDIO=mgm-lmstudio.ngrok.app,SANDBOX_PROVIDER=cloudrun,CLOUDRUN_JOB=outfitter-agent,IDLE_STOP_SECONDS=1800,LITELLM_BASE_URL=https://router.kernal.one/v1,PROVIDER_POLL_MS=300000,OUTFITTER_LOGIN_ALLOW=domain:mgmonteleone.com;domain:serviam-it.hr;user:matija.turk@gmail.com;user:matej@mgms.eu;mgm@mgms.eu;matej@mgms.eu,IAP_AUDIENCE=/projects/123456789012/locations/us-central1/services/outfitter-api,OUTFITTER_LINK_ORIGIN=https://outfitter-link-abc.run.app,OUTFITTER_OPERATORS=mgm@mgms.eu;matej@mgms.eu,OUTFITTER_BUILD_COMMIT=${TAG}"
if [[ "${ENV_VARS_ARG}" == "--set-env-vars=${EXPECTED}" ]]; then
  echo "ok: --set-env-vars is exactly config.env's pre-GKE list, unchanged"
else
  echo "FAIL: --set-env-vars doesn't match the expected pre-GKE list"
  echo "  got:      ${ENV_VARS_ARG}"
  echo "  expected: --set-env-vars=${EXPECTED}"
  fails=$((fails + 1))
fi

# #217: with PREVIEW_DOMAIN set, both preview variables are added, and PREVIEW_ALLOW is IAP_MEMBERS
# plus the operators with ';' separators (--set-env-vars splits on commas).
: >"${GCLOUD_CALLS}"
status=0
OUT="$(cd "${REPO}/outfitter/deploy" && PREVIEW_DOMAIN=kernal.run ./service.sh web 2>&1)" || status=$?
PREVIEW_ENV="$(grep '^run deploy outfitter-api' "${GCLOUD_CALLS}" | grep -oE -- '--set-env-vars=[^ ]*' || true)"
WANT_PREVIEW="PREVIEW_DOMAIN=kernal.run,PREVIEW_ALLOW=domain:mgmonteleone.com;domain:serviam-it.hr;user:matija.turk@gmail.com;user:matej@mgms.eu;mgm@mgms.eu;matej@mgms.eu"
if [[ ${status} -eq 0 && "${PREVIEW_ENV}" == *",${WANT_PREVIEW},"* ]]; then
  echo "ok: previews on: PREVIEW_DOMAIN and PREVIEW_ALLOW (IAP members + operators, ';'-separated) are set"
else
  echo "FAIL: previews on: expected ${WANT_PREVIEW} in --set-env-vars (exit ${status})"
  echo "  got: ${PREVIEW_ENV}"
  fails=$((fails + 1))
fi

# #252 web voice: DEEPGRAM_PROJECT_ID is a web-role env var, and the Deepgram key is mounted on web
# only (the fake gcloud reports every secret as existing). Link gets neither.
: >"${GCLOUD_CALLS}"
status=0
OUT="$(cd "${REPO}/outfitter/deploy" && DEEPGRAM_PROJECT_ID=dg-project ./service.sh web 2>&1)" || status=$?
VOICE_CALL="$(grep '^run deploy outfitter-api' "${GCLOUD_CALLS}" || true)"
if [[ ${status} -eq 0 && "${VOICE_CALL}" == *",DEEPGRAM_PROJECT_ID=dg-project,"* && "${VOICE_CALL}" == *"DEEPGRAM_API_KEY=outfitter-deepgram-key:latest"* ]]; then
  echo "ok: web voice: DEEPGRAM_PROJECT_ID set and outfitter-deepgram-key mounted on web"
else
  echo "FAIL: web voice: expected DEEPGRAM_PROJECT_ID and the outfitter-deepgram-key mount on web (exit ${status})"
  echo "  got: ${VOICE_CALL}"
  fails=$((fails + 1))
fi
: >"${GCLOUD_CALLS}"
status=0
OUT="$(cd "${REPO}/outfitter/deploy" && DEEPGRAM_PROJECT_ID=dg-project ./service.sh link 2>&1)" || status=$?
LINK_CALL="$(grep '^run deploy outfitter-link' "${GCLOUD_CALLS}" || true)"
if [[ ${status} -eq 0 && -n "${LINK_CALL}" && "${LINK_CALL}" != *DEEPGRAM* ]]; then
  echo "ok: web voice: link gets neither DEEPGRAM_PROJECT_ID nor the Deepgram key"
else
  echo "FAIL: web voice: link deploy should carry no DEEPGRAM_* (exit ${status})"
  echo "  got: ${LINK_CALL:-<no deploy call>}"
  echo "${OUT}" | tail -5 | sed 's/^/    /'
  fails=$((fails + 1))
fi

# The release tag rides along when the deploy came from one (GITHUB_REF_NAME in the deploy workflow).
: >"${GCLOUD_CALLS}"
OUT="$(cd "${REPO}/outfitter/deploy" && GITHUB_REF_NAME=outfitter-v2026.09.28.1 ./service.sh web 2>&1)" || true
REL_ENV="$(grep '^run deploy outfitter-api' "${GCLOUD_CALLS}" | grep -oE -- '--set-env-vars=[^ ]*' || true)"
if [[ "${REL_ENV}" == *",OUTFITTER_BUILD_COMMIT=${TAG},OUTFITTER_RELEASE=outfitter-v2026.09.28.1"* ]]; then
  echo "ok: a release deploy also sets OUTFITTER_RELEASE"
else
  echo "FAIL: expected OUTFITTER_RELEASE=outfitter-v2026.09.28.1 after OUTFITTER_BUILD_COMMIT; got: ${REL_ENV}"
  fails=$((fails + 1))
fi

echo "${fails} failed"
[[ "${fails}" -eq 0 ]]
