#!/usr/bin/env bash
# Limit outfitter-api's Secret Manager roles to Outfitter's own secrets (names starting
# "outfitter-"). Run by hand, as the owner; baseline.sh calls it too, so a re-run never widens it
# again. Idempotent.
#   DRY_RUN=1 ./secret-scope.sh   # show current and planned bindings, change nothing
#   ./secret-scope.sh
#
# Why (#389 IAM check, 2026-10-04): baseline.sh granted roles/secretmanager.secretAccessor and the
# outfitterSecretAdmin custom role project-wide. The LiteLLM router's secrets live in this project
# too (kernal-litellm-prod-master-key, -db-password, -salt-key, ...), so outfitter-api -- the
# account behind both the IAP-fronted web role and the public link role -- could read the router
# master key and add or disable versions of it. The router's secrets already grant their own runtime
# accounts access per secret, so they don't depend on these project bindings.
#
# Order matters: the conditional binding is added and verified before the unconditional one is
# removed, so outfitter-api never loses access to its own secrets in between.
#
# Conditions:
# - secretAccessor: resource.name starts with projects/<number>/secrets/outfitter- (versions are
#   named projects/<number>/secrets/<secret>/versions/<n>).
# - outfitterSecretAdmin: the same, OR the resource is the project itself, because
#   secretmanager.secrets.create is checked on the parent project. None of that role's
#   secret- or version-level permissions apply to the project resource, so this clause grants only
#   "create a secret" (GcpSecretAdmin creates outfitter-* names only).
# Docs: https://cloud.google.com/secret-manager/docs/access-control#conditions
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
DRY_RUN="${DRY_RUN:-0}"
API_SA_EMAIL="outfitter-api@${PROJECT}.iam.gserviceaccount.com"
MEMBER="serviceAccount:${API_SA_EMAIL}"
ADMIN_ROLE="projects/${PROJECT}/roles/outfitterSecretAdmin"

NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
[[ "${NUMBER}" =~ ^[0-9]+$ ]] || deploy_fail "could not read the project number of ${PROJECT}"
PREFIX="projects/${NUMBER}/secrets/outfitter-"
ACCESSOR_EXPR="resource.name.startsWith(\"${PREFIX}\")"
ADMIN_EXPR="resource.name.startsWith(\"${PREFIX}\") || resource.type == \"cloudresourcemanager.googleapis.com/Project\""
TITLE="outfitter-secrets-only"

policy() { gcloud projects get-iam-policy "${PROJECT}" --format=json; }
# has_binding ROLE MODE -- MODE "plain" (no condition) or "scoped" (condition titled $TITLE).
has_binding() {
  jq -e --arg r "$1" --arg m "${MEMBER}" --arg mode "$2" --arg t "${TITLE}" '
    [.bindings[] | select(.role == $r and (.members | index($m)))
      | select(if $mode == "plain" then (.condition == null) else (.condition.title == $t) end)]
    | length > 0' <<<"$3" >/dev/null
}

current="$(policy)"
for role in roles/secretmanager.secretAccessor "${ADMIN_ROLE}"; do
  plain=no; scoped=no
  has_binding "${role}" plain "${current}" && plain=yes
  has_binding "${role}" scoped "${current}" && scoped=yes
  echo "${role}: project-wide=${plain} scoped-to-outfitter-*=${scoped}"
done
if [[ "${DRY_RUN}" == 1 ]]; then
  echo "plan: add the scoped bindings (${PREFIX}*), then remove the project-wide ones."
  echo "DRY_RUN=1: no changes."
  exit 0
fi

# 1. Scoped bindings first.
for pair in "roles/secretmanager.secretAccessor|${ACCESSOR_EXPR}" "${ADMIN_ROLE}|${ADMIN_EXPR}"; do
  role="${pair%%|*}"; expr="${pair#*|}"
  if has_binding "${role}" scoped "$(policy)"; then
    echo "~ ${role}: scoped binding already present"
  else
    echo "+ ${role}: scoped to ${PREFIX}*"
    gcloud projects add-iam-policy-binding "${PROJECT}" --member="${MEMBER}" --role="${role}" \
      --condition="expression=${expr},title=${TITLE},description=Outfitter secrets only (#389)" \
      --quiet >/dev/null
  fi
done

# 2. Verify, then drop the project-wide bindings.
after="$(policy)"
for role in roles/secretmanager.secretAccessor "${ADMIN_ROLE}"; do
  has_binding "${role}" scoped "${after}" || deploy_fail "${role}: scoped binding missing after add; not removing the project-wide one"
done
for role in roles/secretmanager.secretAccessor "${ADMIN_ROLE}"; do
  if has_binding "${role}" plain "${after}"; then
    echo "- ${role}: removing the project-wide binding"
    gcloud projects remove-iam-policy-binding "${PROJECT}" --member="${MEMBER}" --role="${role}" \
      --condition=None --quiet >/dev/null
  fi
done

# 3. Spot-check with the Policy Troubleshooter (best effort: needs the troubleshooter API).
check() {
  local secret="$1" want="$2" got
  got="$(gcloud policy-intelligence troubleshoot-policy iam \
    "//secretmanager.googleapis.com/projects/${PROJECT}/secrets/${secret}" \
    --principal-email="${API_SA_EMAIL}" --permission=secretmanager.versions.access \
    --format='value(access)' 2>/dev/null || true)"
  echo "  check ${secret}: ${got:-unknown} (want ${want})"
  [[ -z "${got}" || "${got}" == "${want}"* ]] || deploy_fail "unexpected access for ${secret}: ${got}"
}
echo "verify:"
check outfitter-litellm-admin GRANTED
check kernal-litellm-prod-master-key NOT_GRANTED
echo "Done. IAM changes can take a few minutes to apply everywhere."
