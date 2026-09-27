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
  # DEPLOY_GUARD_NO_FETCH=1: every check still runs, against the origin/main already fetched. Only
  # release.sh's background API build sets it: release.sh itself has just fetched, and a second
  # fetch in the same checkout, concurrent with agent-job.sh's, could fail on the ref lock.
  [[ "${DEPLOY_GUARD_NO_FETCH:-}" == 1 ]] || git -C "${root}" fetch --quiet origin main
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
  local web_commit link_commit job_commit template_commit=""
  web_commit="$(current_build_commit services outfitter-api)"
  link_commit="$(current_build_commit services outfitter-link)"
  job_commit="$(current_build_commit jobs outfitter-agent)"
  [[ -n "${GKE_CLUSTER:-}" ]] && template_commit="$(current_build_commit_gke)"

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
  if [[ "${this_component}" != "gke-template" && -n "${GKE_CLUSTER:-}" && -n "${template_commit}" \
        && "${template_commit}" != "${this_commit}" ]]; then
    mismatches+=("the GKE SandboxTemplate is at ${template_commit}")
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

# --- GKE (docs/specs/gke-sandbox-provider-plan.md; deploy/gke-*.sh) -----------------------------
# A file, never the shared ~/.kube/config: every kubectl call across these scripts pins it
# explicitly with --kubeconfig, matching gke-cluster.sh's own get-credentials.
CLEANUP_PATHS=()
CLEANUP_CMDS=()
CLEANUP_TRAP_SET=""
_deploy_cleanup() {
  local c p
  # Commands (e.g. deleting a release-time warm-up claim) before paths: an interrupt mid-wait must
  # still delete the claim, whether or not a temp dir also needs removing.
  for c in ${CLEANUP_CMDS[@]+"${CLEANUP_CMDS[@]}"}; do
    eval "${c}" || true
  done
  for p in ${CLEANUP_PATHS[@]+"${CLEANUP_PATHS[@]}"}; do
    rm -rf "${p}"
  done
}
# register_cleanup <path> -- removed on exit. A script that also wants its own EXIT trap for
# something else must register that cleanup here too (a second `trap ... EXIT` would replace this
# one, dropping the kubeconfig/temp-file cleanup silently).
#
# `trap _deploy_cleanup EXIT` runs only ONCE per process, guarded by CLEANUP_TRAP_SET -- this is
# deliberate, not an optimization. Every `$(...)`/`(...)` a script runs inherits both the trap
# already set AND a *copy* of the arrays above (fork semantics), but bash (confirmed on 3.2, macOS's
# default /bin/bash, where this actually bit us) does NOT act on an EXIT trap it merely inherited
# unchanged when that subshell exits -- it only does so if something *re-runs* `trap ... EXIT` while
# already inside that subshell. So calling register_cleanup a second time from inside a command
# substitution (e.g. check_deploy_skew's `x="$(current_build_commit_gke)"`, which calls
# gke_kubeconfig -> register_cleanup) must NOT call `trap` again, or that subshell starts treating
# ITS OWN exit as "time to clean up" and deletes everything registered so far -- including paths the
# top-level script (still running) hasn't used yet. $BASHPID would be the obvious alternative fix
# but isn't available on bash 3.2 either (always empty there, silently useless). Skipping the
# redundant `trap` call sidesteps needing any of that: the array append still happens (harmless if
# it's inside a subshell -- that copy is discarded when the subshell exits, since subshells can't
# write back to the parent's variables), and only the ORIGINAL process, the one that first called
# register_cleanup, ever has a live trap to fire.
register_cleanup() {
  CLEANUP_PATHS+=("$1")
  if [[ -z "${CLEANUP_TRAP_SET}" ]]; then
    CLEANUP_TRAP_SET=1
    trap _deploy_cleanup EXIT
  fi
}
# register_cleanup_cmd <command string> -- run on exit (eval'd; only ever called with this repo's
# own fixed strings, never external input). Same trap-sharing caveat, and the same "set the trap
# only once" reasoning, as register_cleanup.
register_cleanup_cmd() {
  CLEANUP_CMDS+=("$1")
  if [[ -z "${CLEANUP_TRAP_SET}" ]]; then
    CLEANUP_TRAP_SET=1
    trap _deploy_cleanup EXIT
  fi
}

# is_kubectl_notfound <error text> -- true only for kubectl's actual "the object doesn't exist" API
# response ("Error from server (NotFound): ... \"name\" not found"), never for a broader "not
# found"/"does not exist" match: kubectl itself fails with "exec: \"gke-gcloud-auth-plugin\":
# executable file not found in $PATH" when the auth plugin isn't installed, and a looser regex would
# misread that as "the resource doesn't exist" instead of failing loudly on a broken kubectl setup.
is_kubectl_notfound() {
  grep -qF 'Error from server (NotFound)' <<<"$1"
}

# gke_kubeconfig -- ensures a kubeconfig for GKE_CLUSTER exists and exports KUBECONFIG to it, then
# returns 0. Returns 1 (no kubeconfig touched) if GKE_CLUSTER is empty -- callers use that to skip
# GKE-only work cleanly. Locally, a dedicated persistent file (KUBECONFIG_OUTFITTER, default
# ~/.kube/outfitter, same as gke-cluster.sh); in GitHub Actions, a fresh temp file removed on exit
# (register_cleanup), never a checked-out or repo-relative path. In a dry run this only prints the
# command it would have run (gke-cluster.test.sh's convention: get-credentials never runs under
# DRY_RUN=1), so callers must not depend on the file actually existing in that case.
gke_kubeconfig() {
  [[ -z "${GKE_CLUSTER:-}" ]] && return 1
  local kubeconfig location="${GKE_LOCATION:-${REGION}}"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    kubeconfig="$(mktemp)"
    register_cleanup "${kubeconfig}"
  else
    kubeconfig="${KUBECONFIG_OUTFITTER:-${HOME}/.kube/outfitter}"
  fi
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    echo "   DRY_RUN: gcloud container clusters get-credentials ${GKE_CLUSTER} --location=${location} --project=${PROJECT} --dns-endpoint (KUBECONFIG=${kubeconfig})" >&2
  else
    mkdir -p "$(dirname "${kubeconfig}")"
    # Explicit if/return, not `cmd || return 1`: this function is almost always itself called as
    # `gke_kubeconfig || ...`, which suspends -e for everything evaluated while running it -- so a
    # failing get-credentials must be caught here, or the unconditional `export` below would make
    # the function return 0 regardless and every caller would proceed against a kubeconfig that was
    # never actually written.
    if ! KUBECONFIG="${kubeconfig}" gcloud container clusters get-credentials "${GKE_CLUSTER}" \
        --location="${location}" --project="${PROJECT}" --dns-endpoint >&2; then
      return 1
    fi
  fi
  export KUBECONFIG="${kubeconfig}"
}

# current_build_commit_gke -- the outfitter-agent SandboxTemplate's build-commit label (gke-
# template.sh sets it, mirroring current_build_commit for the three Cloud Run components), or "" if
# GKE isn't configured, the template doesn't exist yet, or this is a dry run (no real kubeconfig to
# read from -- see gke_kubeconfig). Used by check_deploy_skew.
#
# Unlike current_build_commit (which treats gcloud_exists's NOT_FOUND/permission split the same
# way), a *lookup* failure here (a bad kubeconfig, Forbidden, a network error) must not read as "the
# template doesn't exist" while GKE is on: that would make check_deploy_skew silently skip the one
# check meant to catch a stale template, and gke-template.sh silently decide the template "already
# matches" and skip re-applying it. So this fails loudly (deploy_fail) on anything other than a
# real NotFound, mirroring gcloud_exists's own contract. GKE-off (GKE_CLUSTER empty) is unaffected:
# the first line returns "" before touching kubectl at all.
current_build_commit_gke() {
  [[ -z "${GKE_CLUSTER:-}" ]] && return 0
  gke_kubeconfig || deploy_fail "could not obtain a kubeconfig for ${GKE_CLUSTER}"
  [[ "${DRY_RUN:-0}" == 1 ]] && return 0
  local out err_file
  err_file="$(mktemp)"
  if out="$(kubectl --kubeconfig="${KUBECONFIG}" -n "${GKE_NAMESPACE:-outfitter-sandboxes}" \
      get sandboxtemplate outfitter-agent -o jsonpath='{.metadata.labels.build-commit}' 2>"${err_file}")"; then
    rm -f "${err_file}"
    printf '%s' "${out}"
    return 0
  fi
  if is_kubectl_notfound "$(cat "${err_file}")"; then
    rm -f "${err_file}"
    return 0
  fi
  cat "${err_file}" >&2
  rm -f "${err_file}"
  deploy_fail "could not read the GKE SandboxTemplate's build-commit label (see above)"
}

# sandbox_sa_email -- the GKE sandboxes' own Google service account (#202). Unlike outfitter-agent@
# (Cloud Run's job identity, which needs roles/logging.logWriter for Cloud Run to ingest its stdout),
# it holds no project role at all: GKE ships container logs through the node's agent, and with the
# metadata server reachable from every sandbox (option B), a logWriter token let the model forge log
# entries for other runs. gke-iam.sh creates it and moves the sandbox KSA's Workload Identity onto it.
sandbox_sa_email() {
  echo "outfitter-sandbox@${PROJECT}.iam.gserviceaccount.com"
}

# assert_sandbox_sa_no_project_roles -- outfitter-sandbox@ must hold no project role at all: its
# permissions are the sandbox model's permissions (option B). Passes before gke-iam.sh has created
# the account (no bindings). Same scope limits as assert_agent_sa_logwriter_only (project level
# only). Needs only resourcemanager.projects.getIamPolicy, so release.sh's gke-template.sh step runs
# it too.
assert_sandbox_sa_no_project_roles() {
  local sandbox_sa roles
  sandbox_sa="$(sandbox_sa_email)"
  roles="$(gcloud projects get-iam-policy "${PROJECT}" \
    --flatten="bindings[].members" \
    --filter="bindings.members:serviceAccount:${sandbox_sa}" \
    --format="value(bindings.role)")" \
    || deploy_fail "could not read ${PROJECT}'s IAM policy (needs resourcemanager.projects.getIamPolicy; roles/browser includes it)"
  if [[ -n "${roles}" ]]; then
    deploy_fail "${sandbox_sa} holds project role(s): $(tr '\n' ' ' <<<"${roles}") -- it must hold none (#202): with the metadata server reachable (option B), its permissions are the sandbox model's permissions; remove them before continuing"
  fi
}

# assert_sandbox_sa_no_unexpected_bindings -- who holds a role ON outfitter-sandbox@: only the
# sandbox KSA's roles/iam.workloadIdentityUser (gke-iam.sh). Anything else could mint its tokens.
# Needs roles/iam.serviceAccountViewer on it, which the owner has and outfitter-deployer doesn't, so
# only gke-iam.sh runs this one.
assert_sandbox_sa_no_unexpected_bindings() {
  local sandbox_sa rows role member unexpected=()
  sandbox_sa="$(sandbox_sa_email)"
  local expected_wi_member="serviceAccount:${PROJECT}.svc.id.goog[${GKE_NAMESPACE:-outfitter-sandboxes}/outfitter-agent]"
  rows="$(gcloud iam service-accounts get-iam-policy "${sandbox_sa}" --project="${PROJECT}" \
    --flatten="bindings[].members" --format="csv[no-heading](bindings.role,bindings.members)")" \
    || deploy_fail "could not read ${sandbox_sa}'s own IAM policy (needs roles/iam.serviceAccountViewer)"
  while IFS=',' read -r role member; do
    [[ -z "${role}" ]] && continue
    [[ "${role}:${member}" == "roles/iam.workloadIdentityUser:${expected_wi_member}" ]] && continue
    unexpected+=("${role} -> ${member}")
  done <<<"${rows}"
  if [[ "${#unexpected[@]}" -gt 0 ]]; then
    deploy_fail "${sandbox_sa} has unexpected bindings on its own IAM policy: ${unexpected[*]} -- only the sandbox KSA's workloadIdentityUser belongs there (#202); remove them"
  fi
}

# assert_agent_sa_logwriter_only -- owner decision "option B" (gke-sandbox-provider-plan.md §1): the
# GKE template keeps the metadata server reachable from every sandbox (S7 found Autopilot's Warden
# rejects the per-uid NET_ADMIN block Cloud Run's finding 3 wanted), so outfitter-agent@'s own IAM
# roles ARE the model's permissions inside a run. Fails loudly if it holds any project role beyond
# roles/logging.logWriter (baseline.sh grants only that one). Read-only; called on every release
# when GKE is configured (gke-template.sh) and stand-alone from gke-iam.sh. Needs
# resourcemanager.projects.getIamPolicy -- roles/browser (already granted to outfitter-deployer,
# ci-setup.sh) includes it, so no separate role is needed.
#
# Scope: this checks only PROJECT-level bindings on the service account -- exactly what baseline.sh
# and ci-setup.sh ever grant it. It does NOT see a role granted at the folder or organization level
# (which would also apply to this account and isn't visible in `projects get-iam-policy`), nor a
# custom role with a different id that happens to include a permission logging.logWriter doesn't
# grant `roles/logging.logWriter` itself. assert_agent_sa_no_unexpected_bindings (below) narrows the
# other half of the gap -- what's granted directly ON the service account resource -- but neither
# reaches folder/org policy; there is no gcloud call from a project-scoped credential that does.
assert_agent_sa_logwriter_only() {
  local agent_sa_email="outfitter-agent@${PROJECT}.iam.gserviceaccount.com" extra_roles
  extra_roles="$(gcloud projects get-iam-policy "${PROJECT}" \
    --flatten="bindings[].members" \
    --filter="bindings.members:serviceAccount:${agent_sa_email} AND NOT bindings.role:roles/logging.logWriter" \
    --format="value(bindings.role)")" \
    || deploy_fail "could not read ${PROJECT}'s IAM policy (needs resourcemanager.projects.getIamPolicy; roles/browser includes it)"
  if [[ -n "${extra_roles}" ]]; then
    deploy_fail "${agent_sa_email} holds project role(s) beyond roles/logging.logWriter: $(tr '\n' ' ' <<<"${extra_roles}") -- with the metadata server reachable (option B), its permissions are the sandbox model's permissions; remove the extra role(s) before continuing"
  fi
}

# assert_agent_sa_no_unexpected_bindings -- the resource-level half of the same option-B guard: who
# holds a role ON outfitter-agent@ itself (`iam service-accounts get-iam-policy`), as opposed to a
# project role granted TO it (assert_agent_sa_logwriter_only, above). Anything beyond the three known
# bindings below -- another principal granted serviceAccountUser/TokenCreator on it, for instance --
# could mint credentials as this account and is worth failing loudly over. Needs
# roles/iam.serviceAccountViewer (already granted to outfitter-deployer, ci-setup.sh).
#
# Expected bindings and where each comes from:
#   roles/iam.serviceAccountUser  outfitter-api@     baseline.sh    -- RunManager.wake impersonates
#                                                                       it to start Cloud Run Job
#                                                                       executions (CloudRunProvider)
#   roles/iam.serviceAccountUser  outfitter-deployer@ ci-setup.sh   -- deploys the Job as this account
#   roles/iam.workloadIdentityUser <the KSA>          gke-iam.sh    -- GKE sandboxes impersonated it
#                                                                       before #202 moved them to
#                                                                       outfitter-sandbox@; tolerated
#                                                                       until `DROP_LEGACY_WI=1
#                                                                       ./gke-iam.sh` removes it
assert_agent_sa_no_unexpected_bindings() {
  local agent_sa_email="outfitter-agent@${PROJECT}.iam.gserviceaccount.com"
  local expected_wi_member="serviceAccount:${PROJECT}.svc.id.goog[${GKE_NAMESPACE:-outfitter-sandboxes}/outfitter-agent]"
  local expected_deployer_member="serviceAccount:outfitter-deployer@${PROJECT}.iam.gserviceaccount.com"
  local expected_api_member="serviceAccount:outfitter-api@${PROJECT}.iam.gserviceaccount.com"
  local rows role member unexpected=()
  rows="$(gcloud iam service-accounts get-iam-policy "${agent_sa_email}" --project="${PROJECT}" \
    --flatten="bindings[].members" --format="csv[no-heading](bindings.role,bindings.members)")" \
    || deploy_fail "could not read ${agent_sa_email}'s own IAM policy (needs roles/iam.serviceAccountViewer)"
  while IFS=',' read -r role member; do
    [[ -z "${role}" ]] && continue
    case "${role}:${member}" in
      "roles/iam.serviceAccountUser:${expected_deployer_member}") continue ;;
      "roles/iam.serviceAccountUser:${expected_api_member}") continue ;;
      "roles/iam.workloadIdentityUser:${expected_wi_member}") continue ;;
    esac
    unexpected+=("${role} -> ${member}")
  done <<<"${rows}"
  if [[ "${#unexpected[@]}" -gt 0 ]]; then
    deploy_fail "outfitter-agent@ has unexpected bindings on its own IAM policy: ${unexpected[*]} -- anyone who can mint credentials as this account can act with the sandbox model's permissions (option B); remove them or update this check's expected list if they're deliberate"
  fi
}
