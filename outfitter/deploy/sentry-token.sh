#!/usr/bin/env bash
# Store the Sentry auth token the api image build uses to upload the web app's source maps (#423).
# Owner-run (deploy/CLAUDE.md). Idempotent: the same token again changes nothing.
#   pbpaste | DRY_RUN=1 ./sentry-token.sh   # check the token and show the plan; writes nothing
#   pbpaste | ./sentry-token.sh
#
# The token comes on stdin only, never as an argument (shell history, ps), and is piped straight
# into gcloud: it is never printed. Use an organization auth token (Sentry: Settings > Developer
# Settings > Organization Tokens), which carries the release and source-map upload scopes.
#
# What it does:
# 1. Secret Manager secret sentry-release-token: created with the token, or a new version added
#    when the token differs from the latest one. The name has no outfitter- prefix on purpose:
#    outfitter-api's Secret Manager roles are scoped to outfitter-* (secret-scope.sh), so the
#    running app can't read the build's token.
# 2. Older enabled versions are disabled (kept, not destroyed), so only the newest token works.
# 3. roles/secretmanager.secretAccessor on this secret only, for outfitter-builder@: the account
#    every outfitter-api image build runs as (env.sh build_service_account -> build_submit
#    --service-account; ci-setup.sh creates it). Not the legacy <number>@cloudbuild account, which
#    a build with a user-chosen service account doesn't use, and not the Compute default account
#    that hand deploys fell back to before ci-setup.sh ran: it is project Editor and gets nothing
#    more here. So this refuses until outfitter-builder exists.
#
# From then on, every outfitter-api build (env.sh build_api_image) uses cloudbuild-api-sentry.yaml
# because the secret exists. To stop uploading, delete the secret: builds go back to
# cloudbuild-api.yaml on their own.
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
DRY_RUN="${DRY_RUN:-0}"
SECRET="${SENTRY_TOKEN_SECRET}"
BUILDER_EMAIL="outfitter-builder@${PROJECT}.iam.gserviceaccount.com"

[[ -t 0 ]] && deploy_fail "pipe the token on stdin: pbpaste | $0"
token="$(cat)"
token="${token%$'\n'}"
token="${token%$'\r'}"
[[ -n "${token}" ]] || deploy_fail "no token on stdin"
[[ "${token}" =~ ^[[:graph:]]+$ ]] || deploy_fail "the token has spaces or control characters; paste only the token"
case "${token}" in
  sntrys_*) ;;
  *) echo "   note: not an organization token (sntrys_...); make sure it can upload source maps" >&2 ;;
esac

gcloud_exists iam service-accounts describe "${BUILDER_EMAIL}" --project="${PROJECT}" \
  || deploy_fail "${BUILDER_EMAIL} doesn't exist; run ci-setup.sh first (builds run as it)"

secret_exists=0
gcloud_exists secrets describe "${SECRET}" --project="${PROJECT}" && secret_exists=1
echo "secret ${PROJECT}/${SECRET}: $([[ "${secret_exists}" == 1 ]] && echo exists || echo "doesn't exist yet")"

if [[ "${DRY_RUN}" == 1 ]]; then
  if [[ "${secret_exists}" == 1 ]]; then
    echo "plan: add the token as a new version unless it equals the latest, disable older versions"
  else
    echo "plan: create ${SECRET} with the token"
  fi
  echo "plan: grant roles/secretmanager.secretAccessor on ${SECRET} to ${BUILDER_EMAIL}"
  echo "DRY_RUN=1: no changes."
  exit 0
fi

# 1. Store, unless the latest version already holds this token.
if [[ "${secret_exists}" == 1 ]]; then
  if [[ "$(gcloud secrets versions access latest --secret="${SECRET}" --project="${PROJECT}" 2>/dev/null)" == "${token}" ]]; then
    echo "~ the latest version already holds this token"
  else
    printf '%s' "${token}" | gcloud secrets versions add "${SECRET}" --project="${PROJECT}" --data-file=- >/dev/null
    echo "+ added a new version of ${SECRET}"
  fi
else
  # shellcheck disable=SC2054 # the commas belong to --labels, not array separators
  printf '%s' "${token}" | gcloud secrets create "${SECRET}" --project="${PROJECT}" \
    --replication-policy=automatic --labels=app=outfitter,purpose=sentry-sourcemaps --data-file=- >/dev/null
  echo "+ created ${SECRET}"
fi
unset token

# 2. Only the newest version stays enabled.
latest="$(gcloud secrets versions list "${SECRET}" --project="${PROJECT}" --filter=state=enabled \
  --sort-by=~createTime --limit=1 --format='value(name)')"
[[ -n "${latest}" ]] || deploy_fail "${SECRET} has no enabled version after storing the token"
for v in $(gcloud secrets versions list "${SECRET}" --project="${PROJECT}" --filter=state=enabled --format='value(name)'); do
  [[ "${v##*/}" == "${latest##*/}" ]] && continue
  echo "- disable old version ${v##*/}"
  gcloud secrets versions disable "${v##*/}" --secret="${SECRET}" --project="${PROJECT}" --quiet >/dev/null
done

# 3. The build account may read this one secret (an existing binding is a no-op).
gcloud secrets add-iam-policy-binding "${SECRET}" --project="${PROJECT}" \
  --member="serviceAccount:${BUILDER_EMAIL}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
echo "= ${BUILDER_EMAIL} has roles/secretmanager.secretAccessor on ${SECRET}"

echo "Done. The next outfitter-api image build (the next release) uploads the web source maps."
