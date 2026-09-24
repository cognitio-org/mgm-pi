#!/usr/bin/env bash
# One-time setup so GitHub Actions can deploy Outfitter (.github/workflows/outfitter-deploy.yml)
# without a stored key: Workload Identity Federation from GitHub's OIDC tokens to a dedicated
# `outfitter-deployer` service account. Run by hand, as a project owner, then it's done. Idempotent.
#   ./ci-setup.sh
#
# Trust is pinned to exactly one workflow file of this repo, run from an `outfitter-v*` release tag
# (the provider's attribute condition): main, a PR branch, a fork, or any other workflow in the
# repo gets no GCP token. A tag can point at any commit, including one whose workflow skips
# release.sh's main-only check, so this also creates a tag ruleset: only repository admins can
# create, move or delete `outfitter-v*` tags. That makes cutting a release exactly as privileged as
# administering the repo.
#
# The deployer can build images (as outfitter-builder, created here with only push and log rights --
# never the default build account, which is project Editor), roll out revisions of the existing
# services and job, and read what service.sh looks up. It has no IAM-policy rights (no run.admin, no
# IAM or IAP admin), so it can't add invokers or IAP members; access.sh stays a human step.
#
# Be clear about what that does NOT make it: run.developer includes run.services.update, which can
# flip --no-iap on a service, and deploying as outfitter-api means shipping code that runs with
# that account's secret access. So a stolen deployer token is roughly as powerful as a malicious
# merge to main. release.sh checks IAP is still on after every deploy; the real boundary is who can
# merge to main and edit this workflow file.
#
# Docs: https://github.com/google-github-actions/auth#preferred-direct-workload-identity-federation
# and https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines
set -euo pipefail

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
GITHUB_REPO="${GITHUB_REPO:-cognitio-org/mgm-pi}"
WORKFLOW="${GITHUB_REPO}/.github/workflows/outfitter-deploy.yml"
# Numeric ids too, so the trust doesn't follow the name if the repo is renamed or re-registered.
REPO_ID="$(gh api "repos/${GITHUB_REPO}" --jq .id)"
OWNER_ID="$(gh api "repos/${GITHUB_REPO}" --jq .owner.id)"
POOL="github"
PROVIDER="outfitter-deploy"
SA_NAME="outfitter-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
BUILDER_NAME="outfitter-builder"
BUILDER_EMAIL="${BUILDER_NAME}@${PROJECT}.iam.gserviceaccount.com"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
BUILD_BUCKET="${PROJECT}_cloudbuild"

ensure_sa() {
  if ! gcloud_exists iam service-accounts describe "$1@${PROJECT}.iam.gserviceaccount.com" --project="${PROJECT}"; then
    gcloud iam service-accounts create "$1" --project="${PROJECT}" --display-name="$2"
  fi
}

echo "== APIs for token exchange =="
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project="${PROJECT}"

echo "== Service accounts =="
ensure_sa "${SA_NAME}" "Outfitter deploys from GitHub Actions (release.sh)"
ensure_sa "${BUILDER_NAME}" "Outfitter image builds (Cloud Build)"
# Runtime identity for the public landing page. No project roles (baseline.sh). The deployer has
# to act as it, or a landing/ change stops the whole release on the default Compute account.
ensure_sa "kernal-web" "kernal.one landing page (static, no project roles)"

echo "== ${BUILDER_EMAIL}: read build sources, push to the outfitter repo, write build logs =="
gcloud artifacts repositories add-iam-policy-binding outfitter --location="${REGION}" --project="${PROJECT}" \
  --member="serviceAccount:${BUILDER_EMAIL}" --role=roles/artifactregistry.writer --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUILD_BUCKET}" \
  --member="serviceAccount:${BUILDER_EMAIL}" --role=roles/storage.objectViewer --quiet >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT}" --member="serviceAccount:${BUILDER_EMAIL}" \
  --role=roles/logging.logWriter --condition=None --quiet >/dev/null

echo "== ${SA_EMAIL}: project roles =="
# run.developer: deploy revisions and jobs, no IAM policy changes. The rest are read-only lookups
# the scripts make (domain mappings for env.sh public_origin, which run.developer can't list;
# secrets metadata; the mailbox queue, tick and service account; the project number), streaming
# Cloud Build logs, and using the project as quota project (env.sh sets
# CLOUDSDK_BILLING_QUOTA_PROJECT).
for role in roles/run.developer roles/run.viewer roles/cloudbuild.builds.editor roles/logging.viewer \
    roles/serviceusage.serviceUsageConsumer roles/secretmanager.viewer roles/cloudtasks.viewer \
    roles/cloudscheduler.viewer roles/iam.serviceAccountViewer roles/browser \
    roles/container.clusterViewer; do
  gcloud projects add-iam-policy-binding "${PROJECT}" --member="serviceAccount:${SA_EMAIL}" \
    --role="${role}" --condition=None --quiet >/dev/null
  echo "   ${role}"
done
# container.clusterViewer: release.sh's gke-template.sh step reads the cluster's DNS endpoint and
# kube-dns Service IP (container.clusters.connect/get) when GKE_CLUSTER is set (config.env).
# assert_agent_sa_logwriter_only (env.sh), run on every release when GKE is configured, needs
# resourcemanager.projects.getIamPolicy to check outfitter-agent@'s roles (gke-sandbox-provider-
# plan.md §1 "option B" -- that account's permissions are the sandbox model's permissions).
# roles/browser above already includes that permission (verified 2026-09-24 against its included-
# permissions list), so no separate role (e.g. iam.securityReviewer, which would also hand out
# every OTHER principal's IAM-policy-read access project-wide) is needed for it.

# container.clusterViewer only gets the deployer to the cluster's API server -- what it may do once
# there is separate Kubernetes RBAC, same split as outfitter-api's own deploy/gke/rbac.yaml. Only
# when GKE_CLUSTER is set (config.env) and the cluster already exists: run ./gke-cluster.sh first if
# this warns, then re-run ci-setup.sh.
if [[ -n "${GKE_CLUSTER:-}" ]]; then
  GKE_NAMESPACE="${GKE_NAMESPACE:-outfitter-sandboxes}"
  echo "== ${SA_EMAIL}: RBAC in ${GKE_NAMESPACE} (get/create/patch the SandboxTemplate and pool, get/create/delete/list the release-time warm-up claim, get/list/watch its Sandbox) =="
  if gke_kubeconfig; then
    cat <<YAML | kubectl --kubeconfig="${KUBECONFIG}" apply --server-side -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: outfitter-deployer, namespace: ${GKE_NAMESPACE} }
rules:
  - apiGroups: ["extensions.agents.x-k8s.io"]
    resources: ["sandboxtemplates"]
    # create, not just get/patch: `kubectl apply --server-side` on an object that doesn't exist yet
    # (the very first GKE release) is authorized against `create`, not only `patch` -- the apiserver
    # checks create for a missing object even under a patch-shaped request. `create` can't be
    # narrowed by resourceNames, so this covers any SandboxTemplate name in the namespace, not just
    # "outfitter-agent"; nothing else in this namespace creates one.
    verbs: ["get", "create", "patch"]
  - apiGroups: ["extensions.agents.x-k8s.io"]
    resources: ["sandboxwarmpools"]
    # Same reasoning as sandboxtemplates above: the first release's `apply --server-side` needs
    # create too.
    verbs: ["get", "create", "patch"]
  - apiGroups: ["extensions.agents.x-k8s.io"]
    resources: ["sandboxclaims"]
    # get/create/delete: the warm-up claim itself (kubectl create -f -, not apply -- this Role
    # deliberately grants no patch on sandboxclaims; get is polled instead of `kubectl wait`, see
    # gke-template.sh). list: finding a stale warm-up claim left by an interrupted previous run,
    # by label, before creating a new one.
    verbs: ["get", "create", "delete", "list"]
  - apiGroups: ["agents.x-k8s.io"]
    resources: ["sandboxes"]
    # Read-only: waiting for the warm-up claim's assigned Sandbox to report Ready.
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: outfitter-deployer, namespace: ${GKE_NAMESPACE} }
subjects: [{ kind: User, name: ${SA_EMAIL}, apiGroup: rbac.authorization.k8s.io }]
roleRef: { kind: Role, name: outfitter-deployer, apiGroup: rbac.authorization.k8s.io }
YAML
    echo "== ${SA_EMAIL}: RBAC in kube-system (get the kube-dns Service only) =="
    cat <<YAML | kubectl --kubeconfig="${KUBECONFIG}" apply --server-side -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: outfitter-deployer-kube-dns, namespace: kube-system }
rules:
  - apiGroups: [""]
    resources: ["services"]
    resourceNames: ["kube-dns"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: outfitter-deployer-kube-dns, namespace: kube-system }
subjects: [{ kind: User, name: ${SA_EMAIL}, apiGroup: rbac.authorization.k8s.io }]
roleRef: { kind: Role, name: outfitter-deployer-kube-dns, apiGroup: rbac.authorization.k8s.io }
YAML
  else
    echo "   GKE_CLUSTER is set but no cluster reachable yet; run ./gke-cluster.sh, then re-run ci-setup.sh" >&2
  fi
fi

echo "== ${SA_EMAIL}: read the outfitter repo (image-exists checks) =="
gcloud artifacts repositories add-iam-policy-binding outfitter --location="${REGION}" --project="${PROJECT}" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/artifactregistry.reader --quiet >/dev/null

echo "== ${SA_EMAIL}: upload build sources to gs://${BUILD_BUCKET} =="
# legacyBucketWriter, not objectCreator + legacyBucketReader: `gcloud builds submit` also lists and
# replaces objects in the staging bucket, and the first CI release failed with "The user is
# forbidden from accessing the bucket" until this was granted by hand.
for role in roles/storage.legacyBucketWriter roles/storage.objectViewer; do
  gcloud storage buckets add-iam-policy-binding "gs://${BUILD_BUCKET}" \
    --member="serviceAccount:${SA_EMAIL}" --role="${role}" --quiet >/dev/null
done

echo "== ${SA_EMAIL}: act as the runtime accounts and the builder (never the default Compute or build account) =="
for sa in "outfitter-api@${PROJECT}.iam.gserviceaccount.com" "outfitter-agent@${PROJECT}.iam.gserviceaccount.com" "kernal-web@${PROJECT}.iam.gserviceaccount.com" "${BUILDER_EMAIL}"; do
  gcloud iam service-accounts add-iam-policy-binding "${sa}" --project="${PROJECT}" \
    --member="serviceAccount:${SA_EMAIL}" --role=roles/iam.serviceAccountUser --quiet >/dev/null
  echo "   ${sa}"
done

echo "== Workload identity pool '${POOL}' and provider '${PROVIDER}' =="
if ! gcloud_exists iam workload-identity-pools describe "${POOL}" --location=global --project="${PROJECT}"; then
  gcloud iam workload-identity-pools create "${POOL}" --location=global --project="${PROJECT}" \
    --display-name="GitHub Actions"
fi
PROVIDER_FLAGS=(
  --location=global --project="${PROJECT}" --workload-identity-pool="${POOL}"
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.job_workflow_ref=assertion.job_workflow_ref"
  --attribute-condition="assertion.repository_id == '${REPO_ID}' && assertion.repository_owner_id == '${OWNER_ID}' && assertion.repository == '${GITHUB_REPO}' && assertion.job_workflow_ref.startsWith('${WORKFLOW}@refs/tags/outfitter-v')"
)
if gcloud_exists iam workload-identity-pools providers describe "${PROVIDER}" --location=global \
    --workload-identity-pool="${POOL}" --project="${PROJECT}"; then
  gcloud iam workload-identity-pools providers update-oidc "${PROVIDER}" "${PROVIDER_FLAGS[@]}" >/dev/null
else
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER}" "${PROVIDER_FLAGS[@]}" \
    --issuer-uri="https://token.actions.githubusercontent.com"
fi

echo "== Let that workflow impersonate ${SA_EMAIL} =="
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" --project="${PROJECT}" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}" \
  --quiet >/dev/null

echo "== Tag ruleset: only admins create, move or delete outfitter-v* tags =="
# Without it any collaborator with write access could tag their own commit and deploy it, so this
# script stops here -- before the repository variables that switch the workflow on -- if the
# ruleset can't be created or isn't active (rulesets on a private repo can need a paid plan).
RULESET_NAME="outfitter release tags"
RULESET_ENFORCEMENT="$(gh api "repos/${GITHUB_REPO}/rulesets" \
  --jq ".[] | select(.name == \"${RULESET_NAME}\") | .enforcement")"
if [[ -z "${RULESET_ENFORCEMENT}" ]]; then
  # actor_id 5 = the repository admin role.
  gh api -X POST "repos/${GITHUB_REPO}/rulesets" --input - >/dev/null <<JSON || deploy_fail "couldn't create the tag ruleset (see above); the deploy workflow stays off"
{
  "name": "${RULESET_NAME}",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/outfitter-v*"], "exclude": [] } },
  "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" } ],
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ]
}
JSON
  echo "   created"
elif [[ "${RULESET_ENFORCEMENT}" != active ]]; then
  deploy_fail "ruleset '${RULESET_NAME}' exists but is '${RULESET_ENFORCEMENT}', not active; fix it in the repo settings, then re-run"
else
  echo "   already active"
fi

WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
echo "== GitHub repository variables (the workflow stays idle until these exist) =="
gh variable set GCP_WIF_PROVIDER --repo "${GITHUB_REPO}" --body "${WIF_PROVIDER}"
gh variable set GCP_DEPLOY_SA --repo "${GITHUB_REPO}" --body "${SA_EMAIL}"
echo "== Done. Pushing a release tag now deploys: ./tag-release.sh =="
