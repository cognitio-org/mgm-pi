# shellcheck shell=bash
# Shared guard for every Outfitter deploy script. Source it right after `set -euo pipefail`.
#
# Outfitter lives in ONE project under ONE personal account. Nothing here may ever depend on the
# active gcloud configuration, which on this laptop can point at an unrelated work project. So:
# pin the project and account through CLOUDSDK_* (they override `gcloud config` for every command
# in this process, including the quota project used by billing-account-scoped APIs), and refuse to
# run if the pinned account is not logged in.
PROJECT="${PROJECT:-outfitter-509211}"
REGION="${REGION:-us-central1}"
ACCOUNT="${ACCOUNT:-mgm@mgms.eu}"

export CLOUDSDK_CORE_PROJECT="${PROJECT}"
export CLOUDSDK_BILLING_QUOTA_PROJECT="${PROJECT}"

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  # outfitter-deploy.yml: google-github-actions/auth hands gcloud short-lived Workload Identity
  # credentials for the outfitter-deployer service account; there's no other account to confuse.
  ACCOUNT="github-actions (workload identity)"
else
  export CLOUDSDK_CORE_ACCOUNT="${ACCOUNT}"
  if ! gcloud auth list --filter="account:${ACCOUNT}" --format="value(account)" 2>/dev/null | grep -qx "${ACCOUNT}"; then
    echo "deploy: ${ACCOUNT} is not logged in to gcloud (gcloud auth login ${ACCOUNT}); refusing to run." >&2
    exit 1
  fi
fi
case "${PROJECT}" in
  outfitter-*) ;;
  *) echo "deploy: PROJECT=${PROJECT} is not an Outfitter project; refusing to run." >&2; exit 1 ;;
esac
echo "deploy: account=${ACCOUNT} project=${PROJECT} region=${REGION}"

# Shared by api.sh and link.sh: builds a --set-secrets value from "ENV_VAR=secret:version" pairs,
# dropping any pair whose secret doesn't exist yet in this project. Cloud Run refuses the whole
# deploy when any referenced secret is missing, and the API tolerates GITHUB_PAT / LITELLM_ADMIN_KEY
# being absent until they're actually needed.
# gcloud_exists <gcloud args...> -- 0 if the describe succeeds, 1 if the resource is NOT_FOUND,
# and a hard stop on any other error. A permission error must never read as "doesn't exist":
# callers drop env vars and secret mounts on "doesn't exist", and --set-env-vars/--set-secrets
# replace the whole list, so a missing role would silently strip production's config.
gcloud_exists() {
  local err
  if err="$(gcloud "$@" 2>&1 >/dev/null)"; then
    return 0
  fi
  if grep -qiE 'NOT_FOUND|not found|does not exist|cannot find' <<<"${err}"; then
    return 1
  fi
  deploy_fail "gcloud $* failed: ${err}"
}

existing_secrets() {
  local out="" pair name
  for pair in "$@"; do
    name="${pair#*=}"; name="${name%%:*}"
    if gcloud_exists secrets describe "${name}" --project="${PROJECT}"; then
      out="${out:+${out},}${pair}"
    else
      echo "   note: secret ${name} does not exist yet; not mounting ${pair%%=*}" >&2
    fi
  done
  printf '%s' "${out}"
}

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.env
source "${DEPLOY_DIR}/config.env"

# --- Only merged main reaches production -------------------------------------------------------
# gcloud builds submit uploads the working directory as it is on disk, so a deploy from a feature
# worktree (or with uncommitted edits) used to ship that code under a main-looking commit tag and
# silently drop whatever else main had. deploy_guard makes every image-building script refuse
# unless its inputs are committed and on origin/main; regression_guard refuses to replace a
# production revision with a commit that doesn't contain it. Overrides, for emergencies only:
# ROLLBACK=1 (deploy an older main commit on purpose) and ALLOW_OFF_MAIN=1 (skip both checks).

deploy_fail() {
  echo "deploy: $*" >&2
  exit 1
}

# deploy_guard <path>... -- paths are relative to the repo root: the build context the caller uploads.
deploy_guard() {
  if [[ "${ALLOW_OFF_MAIN:-}" == 1 ]]; then
    echo "deploy: ALLOW_OFF_MAIN=1 -- skipping the committed-main checks" >&2
    return 0
  fi
  local root
  root="$(git -C "${DEPLOY_DIR}" rev-parse --show-toplevel)"
  if [[ -n "$(git -C "${root}" status --porcelain -- "$@")" ]]; then
    git -C "${root}" status --short -- "$@" >&2
    deploy_fail "uncommitted changes under $* would be uploaded; commit and merge them, or deploy from a clean checkout of main."
  fi
  git -C "${root}" fetch --quiet origin main
  if ! git -C "${root}" merge-base --is-ancestor HEAD origin/main; then
    deploy_fail "HEAD ($(git -C "${root}" rev-parse --short HEAD)) is not on origin/main. Merge it first; only main deploys."
  fi
  if [[ "$(git -C "${root}" rev-parse HEAD)" != "$(git -C "${root}" rev-parse origin/main)" \
        && -z "${GITHUB_ACTIONS:-}" && "${ROLLBACK:-}" != 1 ]]; then
    deploy_fail "HEAD is behind origin/main; run git pull --ff-only (or ROLLBACK=1 to deploy this older commit on purpose)."
  fi
}

# deployed_image service <name> | job <name> -- the image production runs now, or "" if none.
# Call it as an assignment (current="$(deployed_image ...)"), never inline as another command's
# argument: only an assignment makes set -e stop on its failure.
deployed_image() {
  local kind=services field='spec.template.spec.containers[0].image'
  if [[ "$1" == job ]]; then
    kind=jobs field='spec.template.spec.template.spec.containers[0].image'
  fi
  if ! gcloud_exists run "${kind}" describe "$2" --project="${PROJECT}" --region="${REGION}"; then
    return 0   # not deployed yet
  fi
  gcloud run "${kind}" describe "$2" --project="${PROJECT}" --region="${REGION}" --format="value(${field})"
}

# regression_guard <deployed image> -- its tag is the commit it was built from (service.sh,
# agent-job.sh). Refuses when HEAD doesn't contain that commit: deploying would roll back work that
# is live, most often because this checkout is stale or a newer deploy already went out.
regression_guard() {
  local image="$1" tag root
  [[ -z "${image}" || "${ROLLBACK:-}" == 1 || "${ALLOW_OFF_MAIN:-}" == 1 ]] && return 0
  tag="${image##*:}"
  root="$(git -C "${DEPLOY_DIR}" rev-parse --show-toplevel)"
  if ! git -C "${root}" cat-file -e "${tag}^{commit}" 2>/dev/null; then
    echo "deploy: WARNING: production's image '${image}' isn't tagged with a commit on main here; can't check for a rollback" >&2
    return 0
  fi
  if ! git -C "${root}" merge-base --is-ancestor "${tag}" HEAD; then
    deploy_fail "production runs ${tag}, which HEAD ($(git -C "${root}" rev-parse --short HEAD)) doesn't contain; deploying would roll it back. Pull main, or ROLLBACK=1 if that's the point."
  fi
}

# commit_tag -- this checkout's commit as image tag and build-commit label. A fixed 12 characters,
# not `--short`: that grows with the clone's object count, so a laptop and an Actions checkout could
# label the same commit differently and never see each other's deploys as "already there".
commit_tag() {
  git -C "${DEPLOY_DIR}" rev-parse --short=12 HEAD
}

# component_live_at <services|jobs> <name> <commit> -- whether that component really runs <commit>:
# its image is tagged with it and, for a service, the revision carrying it became ready. The
# build-commit label alone isn't enough: `gcloud run deploy` sets it even when the new revision then
# fails to start, and release.sh would skip that service on a re-run.
component_live_at() {
  local kind="$1" name="$2" commit="$3" image ready created
  image="$(deployed_image "${kind%s}" "${name}")"
  [[ "${image##*:}" == "${commit}" ]] || return 1
  [[ "${kind}" == jobs ]] && return 0
  ready="$(gcloud run services describe "${name}" --project="${PROJECT}" --region="${REGION}" --format='value(status.latestReadyRevisionName)')"
  created="$(gcloud run services describe "${name}" --project="${PROJECT}" --region="${REGION}" --format='value(status.latestCreatedRevisionName)')"
  [[ -n "${ready}" && "${ready}" == "${created}" ]]
}

image_exists() {
  gcloud artifacts docker images describe "$1" --project="${PROJECT}" &>/dev/null
}

# build_service_account -- the service account Cloud Build runs our builds as. ci-setup.sh creates
# outfitter-builder with only what a build needs (push to the outfitter repo, write logs). The
# project's default build account (the Compute default SA) holds roles/editor, so anyone allowed to
# build as it could run arbitrary gcloud as project Editor from a build step. Until ci-setup.sh has
# run, hand deploys fall back to the default, as before.
build_service_account() {
  local sa="outfitter-builder@${PROJECT}.iam.gserviceaccount.com"
  if gcloud_exists iam service-accounts describe "${sa}" --project="${PROJECT}"; then
    printf 'projects/%s/serviceAccounts/%s' "${PROJECT}" "${sa}"
  elif [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    deploy_fail "${sa} doesn't exist; run ci-setup.sh"
  fi
}

# build_submit <source dir> <config file> [extra gcloud args...] -- gcloud builds submit as
# build_service_account. The build configs set logging: CLOUD_LOGGING_ONLY: a user-chosen build
# account requires it, and gcloud can only stream legacy bucket logs for project Viewers.
#
# --gcs-source-staging-dir is not cosmetic: left to its default, gcloud first *ensures* the
# gs://<project>_cloudbuild bucket exists, and that path needs more than the deployer's
# objectCreator/objectViewer/legacyBucketReader on it. It fails as "The user is forbidden from
# accessing the bucket [<project>_cloudbuild] ... serviceusage.services.use", which sends you
# looking at Service Usage and bucket IAM, neither of which is the problem. Naming the staging
# directory skips that check and uploads straight to a bucket the deployer can already write
# (verified 2026-09-23 impersonating outfitter-deployer: the same build fails by default and
# succeeds with this flag, with no extra IAM).
build_submit() {
  local src="$1" config="$2" sa
  shift 2
  sa="$(build_service_account)"
  gcloud builds submit "${src}" --project="${PROJECT}" --config="${config}" \
    --gcs-source-staging-dir="gs://${PROJECT}_cloudbuild/source" \
    ${sa:+--service-account="${sa}"} "$@"
}

# web_iap_enabled -- whether outfitter-api still has IAP switched on (release.sh's smoke check; a
# 302 alone could be the app's own redirect).
web_iap_enabled() {
  [[ "$(gcloud run services describe outfitter-api --project="${PROJECT}" --region="${REGION}" \
    --format='value(metadata.annotations["run.googleapis.com/iap-enabled"])')" == true ]]
}

# Bug 9 (docs/reports/cloud-fixes.md): version skew across the three components silently broke
# messaging before (a web role on a newer build sent `mail` frames an older agentd ignored). Every
# deploy script (service.sh, agent-job.sh) labels what it deploys with `build-commit=<git short
# sha>` (see each script's `--labels`/`--update-labels`) and, before deploying, compares that
# against the OTHER two components' currently-deployed build-commit -- refusing (or, with
# ALLOW_SKEW=1, loudly warning) on a mismatch instead of deploying into a known-skewed fleet.
#
# current_build_commit <kind> <name>: prints the currently deployed build-commit label for a Cloud
# Run service (kind=service) or job (kind=job), or "" if it has no revision yet / no such label
# (e.g. never deployed by a build carrying this label -- treated as "unknown", not a match, so a
# first deploy after adding this guard still warns rather than silently skipping the check).
current_build_commit() {
  local kind="$1" name="$2"
  # Read the whole label map ("k=v;k=v") and pick build-commit out in shell, rather than projecting
  # metadata.labels.build-commit: gcloud's projection grammar isn't documented to accept a hyphen in a key.
  local labels
  # gcloud_exists (above): not deployed yet reads as "", a permission error stops the deploy.
  gcloud_exists run "${kind}" describe "${name}" --project="${PROJECT}" --region="${REGION}" || return 0
  labels="$(gcloud run "${kind}" describe "${name}" \
    --project="${PROJECT}" --region="${REGION}" \
    --format='value(metadata.labels)')"
  build_commit_from_labels "${labels}"
}

# build_commit_from_labels "<k=v;k=v...>": prints the build-commit value, or "" if absent.
build_commit_from_labels() {
  local pair
  local IFS=';'
  for pair in $1; do
    if [[ "${pair}" == build-commit=* ]]; then
      printf '%s' "${pair#build-commit=}"
      return 0
    fi
  done
}

# check_deploy_skew <this_commit> <this_component>: this_component is one of "web", "link", "job" --
# the component about to be deployed at this_commit. Compares against the other two's currently
# deployed build-commit; prints which must be redeployed and exits 1 unless ALLOW_SKEW=1 is set, in
# which case it only warns.
check_deploy_skew() {
  local this_commit="$1" this_component="$2"
  # release.sh (and deploy-all.sh, its wrapper) is moving all three components to this commit, one after another; the ones not yet
  # deployed are expected to differ.
  if [[ -n "${DEPLOY_ALL_COMMIT:-}" && "${DEPLOY_ALL_COMMIT}" == "${this_commit}" ]]; then
    return 0
  fi
  local web_commit link_commit job_commit
  web_commit="$(current_build_commit services outfitter-api)"
  link_commit="$(current_build_commit services outfitter-link)"
  job_commit="$(current_build_commit jobs outfitter-agent)"

  local mismatches=()
  if [[ "${this_component}" != "web" && -n "${web_commit}" && "${web_commit}" != "${this_commit}" ]]; then
    mismatches+=("outfitter-api (web) is at ${web_commit}")
  fi
  if [[ "${this_component}" != "link" && -n "${link_commit}" && "${link_commit}" != "${this_commit}" ]]; then
    mismatches+=("outfitter-link is at ${link_commit}")
  fi
  if [[ "${this_component}" != "job" && -n "${job_commit}" && "${job_commit}" != "${this_commit}" ]]; then
    mismatches+=("outfitter-agent (Job) is at ${job_commit}")
  fi

  if [[ "${#mismatches[@]}" -eq 0 ]]; then
    return 0
  fi

  echo "== version skew: deploying ${this_component} at ${this_commit}, but: ==" >&2
  local m
  for m in "${mismatches[@]}"; do echo "   ${m}" >&2; done
  echo "   redeploy the mismatched component(s) to ${this_commit} too (deploy-all.sh does all three from one commit)." >&2
  if [[ "${ALLOW_SKEW:-0}" == "1" ]]; then
    echo "   ALLOW_SKEW=1 set -- deploying anyway." >&2
    return 0
  fi
  echo "   refusing to deploy a known-skewed fleet; set ALLOW_SKEW=1 to override." >&2
  exit 1
}

# A Cloud Run service's public origin: https://<its custom domain> when a domain mapping routes to
# it and its Ready condition is True (certificate issued), otherwise its run.app URL; empty if the
# service doesn't exist. Exits non-zero if the mapping lookup itself fails, so a transient gcloud
# error can never quietly pass for "no mapping" (callers must check). A mapping that isn't Ready
# is ignored, so a hostname can only be picked once HTTPS works.
public_origin() {
  local service="$1" json domain
  json="$(gcloud beta run domain-mappings list --project="${PROJECT}" --region="${REGION}" --format=json)" || {
    echo "error: could not list domain mappings (gcloud beta installed and logged in?)" >&2
    return 1
  }
  # Pick the Ready condition by type, not by position; first matching domain in name order.
  domain="$(printf '%s' "${json}" | python3 -c '
import json, sys
service = sys.argv[1]
ready = sorted(
    m["metadata"]["name"] for m in json.load(sys.stdin)
    if m.get("spec", {}).get("routeName") == service
    and any(c.get("type") == "Ready" and c.get("status") == "True"
            for c in m.get("status", {}).get("conditions", []))
)
print(ready[0] if ready else "")
' "${service}")" || return 1
  if [[ -n "${domain}" ]]; then
    printf 'https://%s' "${domain}"
  elif gcloud_exists run services describe "${service}" --project="${PROJECT}" --region="${REGION}"; then
    gcloud run services describe "${service}" --project="${PROJECT}" --region="${REGION}" \
      --format='value(status.url)'
  fi
}

# The origin a deployed service actually verifies token audiences against: its OUTFITTER_ORIGIN env
# var. Anything that mints tokens *for* outfitter-link (the web role's OUTFITTER_LINK_ORIGIN, the
# Scheduler tick in mailbox.sh) reads it from here instead of recomputing it, so the two sides can't
# disagree even if a domain mapping turns Ready between deploys. Empty if not deployed.
# Only NOT_FOUND reads as "not deployed" (gcloud_exists): a permission error mistaken for that would
# make service.sh treat the service as origin-less and move its token audience.
deployed_origin() {
  gcloud_exists run services describe "$1" --project="${PROJECT}" --region="${REGION}" || return 0
  gcloud run services describe "$1" --project="${PROJECT}" --region="${REGION}" \
    --format='value(spec.template.spec.containers[0].env.filter(name=OUTFITTER_ORIGIN).extract(value).flatten())'
}
