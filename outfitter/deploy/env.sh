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
export CLOUDSDK_CORE_ACCOUNT="${ACCOUNT}"
export CLOUDSDK_BILLING_QUOTA_PROJECT="${PROJECT}"

if ! gcloud auth list --filter="account:${ACCOUNT}" --format="value(account)" 2>/dev/null | grep -qx "${ACCOUNT}"; then
  echo "deploy: ${ACCOUNT} is not logged in to gcloud (gcloud auth login ${ACCOUNT}); refusing to run." >&2
  exit 1
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
existing_secrets() {
  local out="" pair name
  for pair in "$@"; do
    name="${pair#*=}"; name="${name%%:*}"
    if gcloud secrets describe "${name}" --project="${PROJECT}" &>/dev/null; then
      out="${out:+${out},}${pair}"
    else
      echo "   note: secret ${name} does not exist yet; not mounting ${pair%%=*}" >&2
    fi
  done
  printf '%s' "${out}"
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
  labels="$(gcloud run "${kind}" describe "${name}" \
    --project="${PROJECT}" --region="${REGION}" \
    --format='value(metadata.labels)' 2>/dev/null || true)"
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
  # deploy-all.sh is moving all three components to this commit, one after another; the ones not yet
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
