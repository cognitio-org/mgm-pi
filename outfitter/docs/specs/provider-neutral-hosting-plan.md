# Plan: provider-neutral hosting (GCP today, AWS next)

Status: planning (2026-10-17), at `main` `843e8e050332`. This file is the plan only. It does not
change deploy scripts, workflows, application code, or any cloud project. Production stays on GCP
until a later phase, run by the owner, says otherwise.

Companion to `deploy/README.md` (what the scripts do today) and
`docs/specs/gke-sandbox-provider-plan.md` (why Drives run on GKE). Where this file names a future
config key, that key does not exist yet.

How to read it: §2 is the inventory of what the repo actually depends on. §3 maps each dependency
to AWS and records the choice where there is more than one. §4 is the config and code shape that
keeps the GCP path working. §5 is the order of work, how to test it, and how to undo it. §6 is
the risk list. §7 is the list of questions only Matthew can answer; the recommendations above
them stand until those answers change them.

---

## 1. What production is

Outfitter's control plane is one GCP project, `outfitter-509211`, region `us-central1`, account
`mgm@mgms.eu` (`deploy/env.sh`). There is no Terraform and no Cloud Deployment Manager. The
infrastructure is idempotent bash that shells out to `gcloud` and `kubectl`, plus a handful of
Kubernetes manifests under `deploy/gke/`.

Two Cloud Run services run one image, chosen by `OUTFITTER_ROLE` (`packages/api/src/config.ts`):

- `outfitter-api` (`web`) is behind Identity-Aware Proxy. Browsers hit it at `app.kernal.one`.
- `outfitter-link` (`link`) is public. It authenticates each request itself: the agent WebSocket,
  hooks, and device tokens. Laptops and Drives use `link.kernal.one`.

A third service, `kernal-web`, is the static landing page at `kernal.one` and `www.kernal.one`.

New Drives launch on GKE Autopilot (`SANDBOX_PROVIDER=gke` in `deploy/config.env`, since
2026-09-26). The Cloud Run Job `outfitter-agent` is still deployed and still registered, so a run
that started on Cloud Run can be stopped after a switch. The Job is the rollback target named in
`config.env`: set `SANDBOX_PROVIDER=cloudrun` and tag a release.

GitHub Actions deploys an `outfitter-v*` tag through Workload Identity Federation. Merging to
`main` only runs CI. Atlas (MongoDB) holds the store; the scripts do not create it. DNS for
`kernal.one` is Cloud DNS in a different project, `cognitio-flow`.

The $25/month budget alert (`deploy/baseline.sh`, `BUDGET_AMOUNT_USD`) is a guardrail, not a
description of a fleet that can be copied onto EKS at the same price. §3 and §7 say so again
because it changes the recommendation.

---

## 2. Inventory

Paths are in this repo. Resource names are the ones the scripts create when run against the
defaults. This pass did not call `gcloud` against the live project; a name below is what the
code will create or look up, which the runbooks treat as what production is.

### 2.1 Compute and runtime

| Piece | Where | What it is |
|---|---|---|
| Cloud Run service `outfitter-api` | `deploy/service.sh` (`./api.sh`), `deploy/access.sh` | Web role. 0.5 vCPU, 512 MiB, timeout 3600s, min instances 0, service account `outfitter-api`. IAP on, no `allUsers` invoker. |
| Cloud Run service `outfitter-link` | `deploy/service.sh` (`./link.sh`), `deploy/access.sh` | Link role, same size and timeout, `allUsers` as `roles/run.invoker`. The 3600s timeout is there so the agent WebSocket (agentd reconnects at 55 min) and the browser SSE stream are not cut at Cloud Run's 300s default (`service.sh`). |
| Cloud Run service `kernal-web` | `deploy/landing.sh` | Static nginx. 1 vCPU, 128 MiB, min 0, max 3, concurrency 200, service account `kernal-web` with no project roles. |
| Cloud Run Job `outfitter-agent` | `deploy/agent-job.sh` | One execution per Drive on the `cloudrun` provider. `packages/api/src/providers/cloudrun.ts` uses `@google-cloud/run`. Still rolled out on every release so in-flight Cloud Run runs remain stoppable (`config.env`). |
| GKE Autopilot cluster `outfitter` | `deploy/gke-cluster.sh` | Regional `us-central1`, release channel `regular`, `--enable-agent-sandbox`, `--enable-dns-access`, image streaming (`containerfilesystem.googleapis.com`). Cluster fee called out in the script header: $0.10/h, covered by the GKE free-tier credit only when it is the billing account's only credit-consuming cluster. |
| Sandbox namespace, template, warm pool | `deploy/gke/namespace.yaml`, `sandbox-template.yaml`, `warm-pool.yaml`, applied by `deploy/gke-template.sh` from `release.sh` | Namespace `outfitter-sandboxes`. Template and pool `outfitter-agent`. Pod memory `GKE_SANDBOX_MEMORY` (4 GiB). Launch mode `warm`. Cap `GKE_MAX_ACTIVE` (3). Ingress denied. Egress is public 443/80 plus the metadata server and DNS (`sandbox-template.yaml`). |
| Warm-pool clock | `deploy/gke-schedule.sh` | Cloud Scheduler jobs `outfitter-warm-up` (00:00) and `outfitter-warm-down` (12:00), `Europe/Zagreb`, calling `POST /api/hooks/warm-pool` on link as `outfitter-tasks`. |
| In-process and Docker providers | `packages/api/src/providers/` | Local only (`inprocess`, `docker`). No cloud calls. |

`packages/api/src/providers/gke.ts` talks to the cluster's DNS endpoint
(`container.googleapis.com` `clusters.get`, then the Kubernetes API on a `*.gke.goog` host) with
a Google access token. Scopes are `cloud-platform` and `userinfo.email`; without the email scope
GKE authorizes the numeric unique id and the RoleBinding for `outfitter-api@` misses. There is
no `@kubernetes/client-node` dependency.

### 2.2 Container registry and image builds

| Piece | Where |
|---|---|
| Artifact Registry docker repo `outfitter` in `us-central1` | `deploy/baseline.sh`. Images are `${REGION}-docker.pkg.dev/${PROJECT}/outfitter/<name>:<12-char commit>` (`env.sh` `commit_tag`). |
| Images | `outfitter-agent` (`deploy/agent-job.sh`, context is the repo root, `outfitter/image/Dockerfile`), `outfitter-api` (`deploy/cloudbuild-api.yaml` and `cloudbuild-api-sentry.yaml`, context `outfitter/`, `packages/api/Dockerfile`), `kernal-web` (`deploy/cloudbuild-landing.yaml`). |
| Cloud Build | `env.sh` `build_submit`. Runs as `outfitter-builder`, not the default Cloud Build account (that account is project Editor). Logging mode `CLOUD_LOGGING_ONLY`. Source is staged in `gs://${PROJECT}_cloudbuild`; `build_submit` sets `--gcs-source-staging-dir` so the deployer does not need to create that bucket. |
| Sentry source maps | `cloudbuild-api-sentry.yaml` when secret `sentry-release-token` exists (`env.sh` `build_api_image`). The token is stored by owner-run `deploy/sentry-token.sh`. |

CI already builds both Dockerfiles and throws the images away (`.github/workflows/outfitter-ci.yml`,
the `images` job). Production builds happen only inside Cloud Build, on a release tag.

### 2.3 Secrets

Two mechanisms, as `deploy/README.md` "Secret Manager" already warns. Env-injected secrets are
mounted by `service.sh` `--set-secrets` when the secret exists. Everything a Drive needs is read
at runtime by `GcpSecretsBroker` and handed over the WebSocket, never as container env.

**Mounted on the services** (`deploy/service.sh` `existing_secrets`):

| Secret id | Env var | Who |
|---|---|---|
| `outfitter-mongodb-uri` | `MONGODB_URI` | both roles |
| `outfitter-github-pat` | `GITHUB_PAT` | both; placeholder, the broker does not read this name |
| `outfitter-litellm-admin` | `LITELLM_ADMIN_KEY` | both |
| `outfitter-local-tunnel-token` | `LOCAL_TUNNEL_TOKEN` | both |
| `outfitter-ngrok-api-key` | `NGROK_API_KEY` | both |
| `outfitter-ngrok-google-oauth` | `NGROK_GOOGLE_OAUTH` | both |
| `outfitter-deepgram-key` | `DEEPGRAM_API_KEY` | web |
| `outfitter-litellm-admin-key` | `LOCAL_HOST_ROUTER_KEY` | link |
| `outfitter-agentengine-memory-sa` | `AGENT_ENGINE_MEMORY_SA` | link, when the memory project id is set |
| `outfitter-agentengine-agents-sa` | `AGENT_ENGINE_AGENTS_SA` | link, when the agents project id is set |

**Read and written through the Secret Manager REST API** (`packages/api/src/secrets.ts`,
`google-auth-library`, ADC, no `@google-cloud/secret-manager` package):

| Name | Code |
|---|---|
| `outfitter-github-token-default` | `GITHUB_TOKEN_DEFAULT_SECRET`. Shared fallback when a repo session has no token of its own and the GitHub App is not configured. |
| `outfitter-github-token-<sessionId>` | per-session PAT |
| `outfitter-litellm-key-<guruId>`, `outfitter-litellm-key-default` | tape key, then the shared default |
| `outfitter-github-app-id`, `outfitter-github-app-private-key`, `outfitter-github-app-installation-id`, `outfitter-github-app-slug` | `packages/api/src/github-app.ts` |
| `outfitter-user-<userId>-<provider>` | `packages/api/src/central/provider-keys.ts` |
| `outfitter-user-<userId>-subscription-<vendor>` | `packages/api/src/central/subscription-secrets.ts` |

`GcpSecretAdmin` (same file, interface `SecretAdmin`) creates a secret, adds a version, disables
every enabled version, and lists versions for the operator settings page. The custom role
`outfitterSecretAdmin` (`deploy/baseline.sh`) is exactly those permissions.
`deploy/secret-scope.sh` binds `secretAccessor` and that custom role to `outfitter-*` names only,
because other apps' secrets share the project.

**Deploy-time secrets the API process does not read:**

| Secret | Who reads it |
|---|---|
| `outfitter-iap-oauth-client-secret` | `deploy/access.sh`, to point IAP at the custom OAuth client |
| `sentry-release-token` | Cloud Build, as `outfitter-builder` |

GitHub Actions holds `SENTRY_AUTH_TOKEN` for the release marker (`.github/workflows/outfitter-deploy.yml`
job `sentry-release`). That secret is not in GCP.

### 2.4 Storage

| Piece | Live? |
|---|---|
| `gs://outfitter-509211_cloudbuild` | Yes. Cloud Build staging. `deploy/ci-setup.sh` grants the builder `objectViewer` and the deployer `legacyBucketWriter` plus `objectViewer`. |
| GCS for Drive snapshots and for tool-output blobs | No. `packages/agentd/src/protocol.ts` and `workspace.ts` say GCS comes later. `packages/api/src/store/types.ts` has a TODO for offloading blobs over 100 KB. `snapshot-url.ts` (api and agentd) defaults `SNAPSHOT_HOST_ALLOWLIST` to `storage.googleapis.com`, which is an allowlist default, not a bucket this repo creates. |
| Cloud Logging bucket `outfitter-sandboxes` | Yes. `deploy/gke-iam.sh` creates it (global, 30 days) and a sink of agentd lines from the sandbox namespace and from the Cloud Run Job. `outfitter-api@` has `roles/logging.viewAccessor` on that bucket's `_AllLogs` view only. |
| BigQuery dataset `billing_export` | Owner-run `deploy/billing-export.sh`. The billing export itself is a console step. Operators get dataset READER and `roles/bigquery.jobUser`. |

### 2.5 Networking and DNS

| Piece | Where |
|---|---|
| Cloud Run domain mappings (Preview, `us-central1`, Google-managed certificates) | `deploy/landing.sh --map-domains`: `kernal.one` and `www.kernal.one` → `kernal-web`, `app.kernal.one` → `outfitter-api`, `link.kernal.one` → `outfitter-link`. |
| Cloud DNS zone `kernal-one` in project `cognitio-flow` | `docs/reports/kernal-one.md` and the echo at the end of `landing.sh`. Apex A/AAAA to Google's frontend addresses; `www`, `app`, and `link` CNAME `ghs.googlehosted.com`. The Outfitter project does not own the zone. |
| `kernal.run` | ngrok wildcard for Drive previews and Local Host (`deploy/config.env` `PREVIEW_DOMAIN`). The zone `kernal-run` is also in `cognitio-flow`. Traffic is ngrok's, not Cloud Run's. |
| GKE DNS-based control-plane endpoint | `gke-cluster.sh` `--enable-dns-access`. The API reaches it as `outfitter-api` with `roles/container.clusterViewer`. No authorized-networks list, which is what lets Cloud Run's changing egress work (`gke-sandbox-provider.md`). |
| Sandbox egress | `deploy/gke/sandbox-template.yaml`. No ingress. Public 80/443 except RFC1918. Metadata `169.254.169.254` is allowed on purpose (owner decision "option B" in the GKE plan): Autopilot rejects the per-uid `NET_ADMIN` block, so `outfitter-agent@` is kept at `roles/logging.logWriter` only and `env.sh` checks that on every release. |
| Serverless VPC connector, Cloud NAT, static egress | Not built. `deploy/README.md` still lists `0.0.0.0/0` on the Atlas access list as the pragmatic start, and a connector plus an Atlas private endpoint as later work. |
| IAP | `deploy/access.sh`. Custom OAuth client id in `deploy/config.env` `IAP_OAUTH_CLIENT_ID` (external audience, so members outside the Workspace org can sign in). Redirect stays on `iap.googleapis.com`. Members in `IAP_MEMBERS`. The API verifies `x-goog-iap-jwt-assertion` itself (`packages/api/src/auth.ts`); audience is the Cloud Run resource path `/projects/<number>/locations/<region>/services/outfitter-api`, which `service.sh` computes from the project number. |

### 2.6 IAM and service accounts

All in `outfitter-509211` unless noted.

| Account | Created by | Rights that matter |
|---|---|---|
| `outfitter-api@` | `baseline.sh` | `roles/run.developer`, `roles/logging.logWriter`, secret access scoped to `outfitter-*`, custom role `outfitterSecretAdmin`, `roles/iam.serviceAccountUser` on `outfitter-agent@` and on `outfitter-tasks@`, `roles/container.clusterViewer`, `roles/cloudtasks.enqueuer` on queue `outfitter-wake`, `roles/logging.viewAccessor` on the sandbox log view, custom role `outfitterMetricsReader` (`monitoring.timeSeries.list` only, `gke-iam.sh`). Runtime identity of both Cloud Run services. |
| `outfitter-agent@` | `baseline.sh` | Project role `roles/logging.logWriter` only. That limit is load-bearing: the sandbox can reach the metadata server, so this account's permissions are the model's permissions. Workload Identity user on the Kubernetes service account `outfitter-sandboxes/outfitter-agent`. |
| `kernal-web@` | `baseline.sh` | No project roles. |
| `outfitter-builder@` | `ci-setup.sh` | `roles/artifactregistry.writer` on repo `outfitter`, `roles/logging.logWriter`, read on the Cloud Build bucket. Cloud Build runs as this account. |
| `outfitter-deployer@` | `ci-setup.sh` | `roles/run.developer`, `roles/run.viewer`, `roles/cloudbuild.builds.editor`, `roles/logging.viewer`, `roles/serviceusage.serviceUsageConsumer`, `roles/secretmanager.viewer`, `roles/cloudtasks.viewer`, `roles/cloudscheduler.viewer`, `roles/iam.serviceAccountViewer`, `roles/browser`, `roles/container.clusterViewer`, Artifact Registry reader, write on the Cloud Build bucket, `roles/iam.serviceAccountUser` on `outfitter-api`, `outfitter-agent`, `kernal-web`, and `outfitter-builder`. No IAM-policy admin. `run.developer` can still turn IAP off; `release.sh` checks IAP is still on after a web deploy. Namespaced Role `outfitter-deployer` in `outfitter-sandboxes` for the template, the pool, and the warm-up claim. |
| `outfitter-tasks@` | `mailbox.sh` | No project roles. Cloud Tasks and Cloud Scheduler mint OIDC tokens as this account. The hooks accept no other email (`auth.ts` `verifyTasksToken`). |
| `outfitter-e2e@` | `e2e-identity.sh` | No project roles. `roles/iap.httpsResourceAccessor` on `outfitter-api`. Live tests mint its ID token. |
| KSA `outfitter-agent` | `deploy/gke/namespace.yaml` | Annotated for Workload Identity onto `outfitter-agent@`. |

Workload Identity pools:

- Pool `github`, provider `outfitter-deploy` (`ci-setup.sh`). Trust is this repo's numeric id, owner id, and `job_workflow_ref` starting with `.github/workflows/outfitter-deploy.yml@refs/tags/outfitter-v`. Repository variables `GCP_WIF_PROVIDER` and `GCP_DEPLOY_SA` turn the workflow on.
- Pool `github-live` (`e2e-identity.sh`). Separate pool so a live-test principal cannot act as the deployer. Variable `GCP_LIVE_WIF_PROVIDER`.

`ci-setup.sh` also creates the tag ruleset `outfitter release tags`: only repository admins can
create, move, or delete `outfitter-v*` tags. The OIDC condition is not enough on its own, because
a tag can point at any commit.

APIs `baseline.sh` enables: `run`, `artifactregistry`, `secretmanager`, `iap`, `cloudscheduler`,
`cloudbuild`, `pubsub`, `iamcredentials`, `billingbudgets`, `cloudresourcemanager`, `iam`.
`ci-setup.sh` adds `sts`. `mailbox.sh` adds `cloudtasks`. `gke-cluster.sh` adds `container` and
`containerfilesystem`. `billing-export.sh` adds `bigquery` and `bigquerydatatransfer`.

`pubsub.googleapis.com` is enabled and unused. Mail wakes are Cloud Tasks
(`packages/api/src/mail.ts`), not Pub/Sub. An early design note in
`docs/reports/agent-messaging.md` mentions Pub/Sub; the code that shipped is the queue
`outfitter-wake`.

Budget: billing account pinned in `baseline.sh` `BILLING_ACCOUNT`, display name
`outfitter-monthly`, $25, thresholds 50/90/100%, filtered to this project.

### 2.7 CI/CD

| Workflow | GCP? |
|---|---|
| `.github/workflows/outfitter-deploy.yml` | Yes. `google-github-actions/auth@v2` with the deployer provider, then `setup-gcloud`, then `deploy/release.sh`. `kubectl` and `gke-gcloud-auth-plugin` only when `deploy/gke-workflow-check.sh` sees `GKE_CLUSTER` set. Environment `production`. Concurrency group `outfitter-deploy`. |
| `.github/workflows/outfitter-live.yml` | Yes. Separate WIF provider, mints an IAP ID token, no deploy rights. |
| `.github/workflows/outfitter-ci.yml` | No live GCP. It runs the deploy-script tests and `docker build`s both images. One test exports `GCP_PROJECT=ci` as a dummy. |
| `release.yml`, `ci.yml`, `chrome-ci.yml`, `code-server-release.yml`, `outfitter-a2a-tck.yml`, `outfitter-agent-engine.yml` | No GCP deploy. Runners are Blacksmith (or `LINUX_RUNNER`), documented in `docs/ci-runners.md`. |

`deploy/release.sh` order: landing page if `landing/` changed, agent Job, GKE template and warm
pool, link, web. A component already at that commit is skipped. Smoke checks: link returns 401
without a token; web still redirects to sign-in.

### 2.8 GCP calls in application code

| Call | File |
|---|---|
| Secret Manager REST, read | `GcpSecretsBroker` in `packages/api/src/secrets.ts`. Wired in `main.ts` whenever `devMode` is off. |
| Secret Manager REST, operator write | `GcpSecretAdmin`, same files. |
| Cloud Run Jobs API | `packages/api/src/providers/cloudrun.ts` (`@google-cloud/run`, lazy import). |
| GKE connect + Kubernetes CRDs | `packages/api/src/providers/gke.ts`. |
| Cloud Tasks `queues.tasks.create` | `CloudTasksWakeScheduler` in `packages/api/src/mail.ts`. Hook `POST /api/hooks/tasks/wake` (`routes/hooks.ts`). |
| Cloud Logging `entries:list`, Cloud Monitoring `timeSeries` | `GcpSandboxTelemetry` in `packages/api/src/sandbox-telemetry.ts`. |
| IAP JWT, Google ID token (agent), Google OIDC (tasks) | `packages/api/src/auth.ts` `identityFromRequest`, `verifyAgentToken`, `verifyTasksToken`. `google-auth-library` `OAuth2Client`. |
| Metadata-server ID token | `packages/agentd/src/auth.ts` `getIdToken`. `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity`. Falls back to `OUTFITTER_DEV_TOKEN` when the metadata server is unreachable. |
| Live-test ID token mint | `packages/web/live/iap-token.mjs` calls `iamcredentials.googleapis.com` `generateIdToken`. |

Dependencies in `packages/api/package.json`: `@google-cloud/run`, `google-auth-library`. No
`@google-cloud/secret-manager`, no `@google-cloud/storage`, no Pub/Sub client.

Config env vars the process treats as GCP coordinates: `GCP_PROJECT`, `GCP_REGION`,
`IAP_AUDIENCE`, `AGENT_SA_EMAIL`, `CLOUDRUN_JOB`, `CLOUD_TASKS_QUEUE`, `TASKS_SA_EMAIL`,
`GKE_CLUSTER`, `GKE_LOCATION`, `GKE_NAMESPACE`, `GKE_WARM_POOL`, `GKE_LAUNCH_MODE`,
`GKE_MAX_ACTIVE`, `GKE_ENDPOINT`, `SANDBOX_PROVIDER`. `service.sh` sets the ones production needs.
`SNAPSHOT_HOST_ALLOWLIST` defaults to `storage.googleapis.com` when unset.

### 2.9 GCP-shaped product features that are not the hosting plane

These talk to Google because the product does, not because the fleet runs there. A hosting move
leaves them in place.

- The router's `gcloud` MCP server and the `google_cloud` toolset (`OUTFITTER_GOOGLE_CLOUD_TOOLSET_ID`
  in `config.env`). Registration scripts: `deploy/gcloud-mcp-iam.sh`, `gcloud-mcp-router.sh`,
  `google-cloud-mcp.sh`. Runbook: `docs/runbooks/gcloud-mcp.md`. Some product APIs are enabled in
  project `kernal-oauth`. Kernal's skill `kernal/skills/gcloud-mcp/` is the laptop side.
- ngrok's Google OAuth client (`outfitter-ngrok-google-oauth`), used by preview sign-in.
- The IAP OAuth client itself, while IAP still fronts `app.kernal.one`.

### 2.10 Neighbouring systems that are not GCP resources

Leave these out of the provider adapter. They are already vendor-neutral configuration:

- MongoDB Atlas, including Agent Engine (`AGENT_ENGINE_*` in `config.env`, `deploy/atlas.md`).
  The store cluster was created in GCP `us-central1` so Cloud Run egress stayed local
  (`deploy/README.md`). That region coupling is real, and it is not a `gcloud` resource.
- LiteLLM at `router.kernal.one`, Deepgram, Sentry, the GitHub App, ngrok.
- Blacksmith runners (`docs/ci-runners.md`).

---

## 3. AWS equivalents, and the choice where there are several

The recommendation in each subsection is what §5 builds. §7 can overrule it.

### 3.1 Control plane: ECS on Fargate, App Runner, or EKS

The control plane is two long-lived processes from one image, one of them public and holding
WebSockets for up to an hour, the other behind a Google login, both at 0.5 vCPU and 512 MiB,
both allowed to scale to zero today.

**ECS on Fargate behind one ALB** is the match. Two ECS services, two task definitions, two
target groups, host-based routing (`app.kernal.one` vs `link.kernal.one`). Each task definition
gets its own role, which is the split `outfitter-api` vs a future link role would want, and the
ALB idle timeout can be set to 3600s to match `service.sh` `DEPLOY_TIMEOUT`. WebSockets and SSE
are ordinary ALB traffic. The task role is the AWS shape of the Cloud Run service account.

**App Runner** is the closer Cloud Run analogue for scale-to-zero and for "here is an image".
It is the wrong first choice for this fleet while the link process needs a one-hour request:
`service.sh` sets 3600s because Cloud Run's 300s default was cutting the agent socket and the
SSE stream. App Runner's documented request timeout has been far below an hour. Re-check the
current limit before revisiting the choice; if it is still under 3600s, App Runner cannot host
link. Two services with different front-door auth are also a poor fit for one App Runner
service.

**EKS for the API and link** spends a control-plane fee and a node (or Fargate) profile on a
process that is not a cluster workload today. The cluster belongs with the sandboxes (§3.2),
not with the two HTTP roles.

Cost consequence, so it is not a surprise in phase 4: ECS does not scale to zero the way
`min-instances=0` does. Plan on one small task per service while they are serving, or confirm
whatever scale-to-zero feature ECS has at the time and test a cold WebSocket against it. An ALB
is a standing charge. Cloud Run domain mappings and certificates are free (`docs/reports/kernal-one.md`);
ACM certificates are free, the ALB is not.

### 3.2 Sandboxes: EKS with the agent-sandbox controller, or a Fargate task per Drive

Production left Cloud Run Jobs as the default because a Job cannot keep a warm pod
(`docs/specs/gke-sandbox-provider.md`, `config.env`). The browser IDE spec records the same
decision (GKE only, 2026-09-27). A new provider that is "one Fargate task per Drive" recreates
the Job model: cold start, no warm pool, a new `SandboxProvider` the size of `cloudrun.ts`.
Fargate's isolation is Firecracker, which is a real boundary, and it would drop the GKE
cluster fee. It throws away the warm-pool work, the template, the scheduler, and the CRD client.

**EKS plus the upstream agent-sandbox controller** (`extensions.agents.x-k8s.io` /
`agents.x-k8s.io`, the CRDs `gke.ts` already hard-codes for v1.0.3) keeps the claim, the warm
pool, and the template. GKE's `--enable-agent-sandbox` is a managed install of that controller;
on EKS the controller is something this repo installs and upgrades. The provider id should be
`eks`, not a rename of `gke`, so a run's recorded `sandboxProvider` still routes stop and
reconcile to the cluster it started on (the registry in `providers/registry.ts` exists for that).

The CRD client in `gke.ts` can be shared. The token mint cannot: GKE wants a Google access token
with `userinfo.email`, EKS wants an IAM-signed STS URL (`aws eks get-token` shape). Two
authenticators, one claim body.

gVisor comes with Autopilot. On EKS it is an extra install, and it needs nodes that can run it
(not Fargate). The open question in §7 is whether that isolation is required. Until it is
answered, the plan assumes ordinary EKS nodes, a denied ingress, and IMDS locked down harder
than GKE allowed: hop limit 1 on the nodes, no node role that a pod can use, pod identity for
`outfitter-agent` with log write only. That is the AWS version of the `logWriter`-only guard.
If the platform allows a per-uid block of the metadata address, do it; Autopilot's Warden is
why GKE could not (`gke-sandbox-provider-plan.md` §1).

Running the API on ECS and the sandboxes on EKS is one more hop than Cloud Run to GKE, and it
is still inside one VPC. Leaving the sandboxes on GKE while the API moves to AWS keeps Google
ID tokens working and avoids a new provider, at the cost of a cross-cloud WebSocket and a GCP
credential on the AWS task for `container.googleapis.com`. That is an acceptable staging
shortcut and a poor end state. §5 does not end there.

EKS control plane is $0.10/h, about $73/month, and there is no equivalent of the GKE free-tier
credit `gke-cluster.sh` is written around. Pod compute is on top, in the same shape as today's
warm pod. This is the line item most likely to break the $25 budget.

### 3.3 Registry, builds, CI identity

**ECR** is the registry. One repository `outfitter`, image names and the 12-character commit tag
unchanged, so `regression_guard` and `component_live_at` keep their meaning.

**Build split.** `ci-setup.sh` is careful: the deployer can start a build, the builder can push
and write logs, and the default build account (project Editor) is never used. Keep that split.

- Role `outfitter-builder`, assumable from GitHub OIDC, can push to that ECR repo and nothing else.
- Role `outfitter-deployer` can roll services and read what the scripts look up, and cannot push
  images or change IAM.
- The build runs in a GitHub Actions job that assumes only the builder role. CI already runs
  `docker build` for both Dockerfiles, so Cloud Build does not need an AWS twin on day one.
  **CodeBuild** is the fallback if the agent image (Playwright, the pi build) outgrows the
  runner or if the builder job must not hold a docker socket on a shared runner. Prefer the
  Actions job until that shows up.

**GitHub OIDC → IAM.** One IAM OIDC provider for `token.actions.githubusercontent.com`. Two
roles, mirroring the two Workload Identity pools:

- Deploy role: trust policy requires the repo, and `job_workflow_ref` for the AWS workflow at
  `refs/tags/outfitter-v*`. The existing tag ruleset stays the admin gate.
- Live-test role: a different role, able to mint whatever the staging login needs, unable to
  deploy. Do not attach it to the deploy provider the way a shared pool would.

No stored AWS keys in GitHub.

### 3.4 Secrets: Secrets Manager, not SSM Parameter Store

`SecretAdmin` creates a secret, appends a version, disables a version, and reads a chosen
version back (`secrets.ts`). Operators recover a disabled version from the console
(`docs/reports/operators.md`). That is Secrets Manager's version model, not Parameter Store's.

The mapping is not free:

- `addVersion` → `PutSecretValue`. Versions are UUIDs with staging labels (`AWSCURRENT`,
  `AWSPREVIOUS`), not integers starting at 1. The operator page shows a version number today.
  Store the integer in a version stage label (`v12`) so the page's contract holds, and keep the
  real version id next to it.
- `disableVersion` → remove the stage label. The version remains until the recovery window,
  which is the property the operator page relies on. Secrets Manager will not keep arbitrary
  old versions forever the way a disabled Secret Manager version sits until someone destroys it;
  set the recovery window explicitly and test a disable/restore from the settings page before
  cutover.
- Name prefix `outfitter-*` stays. The task role's IAM condition on `secretsmanager:Name` is
  `secret-scope.sh`.

SSM Parameter Store is cheaper for a handful of plain strings and has no version-disable
operation that matches `GcpSecretAdmin`. Use it for nothing in this fleet.

Runtime reads stay behind `SecretsBroker`. `main.ts` already chooses `MemorySecretsBroker` or
`GcpSecretsBroker`. An `AwsSecretsBroker` joins that choice. Env-injected secrets (the Mongo
URI, the LiteLLM admin key, and the rest of the `service.sh` list) become ECS `secrets` from
the same names, which is the same split as `--set-secrets` versus the broker.

Copy direction until cutover: GCP is the source, AWS is a replica. Operators keep writing
through the GCP admin API until the DNS flip. A dual-write during the bake will fork versions
the moment someone edits a key on one side only.

### 3.5 Mail wakes and clocks

`WakeScheduler` is already the seam (`mail.ts`): `CloudTasksWakeScheduler` in production,
`NoopWakeScheduler` in dev. The 5-minute `outfitter-tick` sweep is the backstop when a wake
never lands (`mailbox.sh`).

| GCP | AWS | Use it for |
|---|---|---|
| Cloud Scheduler `outfitter-tick`, `outfitter-warm-up`, `outfitter-warm-down` | EventBridge Scheduler rate and cron, target the link URL | The three clocks. Direct replacement. Sign the request as the tasks identity (§3.6). |
| Cloud Tasks queue `outfitter-wake`, one named task per mail, retry until 2xx | SQS queue `outfitter-wake`, plus the tick | The poke. A named HTTP task per mail is Cloud Tasks' strength; a one-time EventBridge schedule per mail will hit schedule quotas if agents mail each other freely (`MAIL_SENDS_PER_HOUR` is 30 per session). SQS is the durable poke. The tick already recovers anything the poke missed. |

`verifyTasksToken` learns a second verifier. The GCP verifier stays, so a GCP scheduler and an
AWS scheduler can be told apart during the bake.

### 3.6 Identity

Three different Google tokens, three replacements.

**Browsers.** IAP on Cloud Run has no AWS product that is the same thing. The app does not trust
the network: it verifies the IAP JWT (`auth.ts`). On AWS the ALB authenticate-oidc action, with
Google as the issuer and the existing OAuth client, puts a JWT in `x-amzn-oidc-data`. The app
verifies that JWT (ALB signer, client id, email) and then applies `IAP_MEMBERS` / the operators
the way IAP's binding does today. A new `BrowserAuth` with implementations `iap` and `alb-oidc`
keeps `identityFromRequest` the only caller. `IAP_MEMBERS` is already copied into
`PREVIEW_ALLOW` and `OUTFITTER_LOGIN_ALLOW`; those stay the allow-list, and the ALB rule is the
edge.

This needs a new redirect URI on the Google OAuth client. That client lives in Google Auth
Platform (the IAP OAuth Admin API is gone; `docs/reports/kernal-one.md`). Adding a redirect URI
must not disturb the IAP redirect `https://iap.googleapis.com/v1/oauth/clientIds/<id>:handleRedirect`
while both fronts are up. §7 asks Matthew to confirm the client can grow that URI.

AWS Verified Access and Cognito are extra products in front of a login that is already "a Google
account on a list". They are worth it only if the ALB action cannot express `domain:` members.
The app-level allow-list can, because it already parses `domain:` for previews and device login.

**Drives.** `agentd` `getIdToken` reads the GCE metadata server. `verifyAgentToken` requires a
Google ID token whose email is `AGENT_SA_EMAIL` and whose audience is the link origin. On EKS,
pod identity (or a projected service-account token audience-bound to the link origin) is the
mint. `getIdToken` dispatches on `AGENT_IDENTITY=google-id|eks-pod|dev`. The link accepts either
verifier while both clusters can still start a Drive. Dev token behaviour stays.

Do the dispatch on GCP first, with `google-id` as the only production value, before any AWS
cluster exists. That is a behaviour-preserving refactor and it is the riskiest code in the plan.

**Clocks.** `verifyTasksToken` checks email == `TASKS_SA_EMAIL`. The AWS tasks role gets a
verifier of the same shape (a JWT whose subject is that role, audience the link origin).

**Live tests.** `outfitter-e2e` exists so Playwright can pass IAP without a person.
`e2e-identity.sh` grants `OpenIdTokenCreator` and nothing else. The AWS live role should be
just as narrow: it can assume a test identity the staging ALB accepts, and it cannot call ECS,
ECR, or IAM.

### 3.7 Logs, metrics, budget, DNS

| GCP | AWS |
|---|---|
| Logging bucket `outfitter-sandboxes` plus the sink, read by `GcpSandboxTelemetry` | CloudWatch log group for the sandbox namespace, a filter on the agentd stream. `SandboxTelemetry` gains `CloudWatchSandboxTelemetry`. The session page calls the interface (`server.ts`). |
| `outfitterMetricsReader` (`monitoring.timeSeries.list`) | Container Insights metrics, read with a task role that can `GetMetricData` on that namespace only. |
| Budget `outfitter-monthly` | AWS Budgets on the account, same thresholds, amount set in §7. |
| Cloud DNS zone `kernal-one` in `cognitio-flow` | Stay on Cloud DNS through cutover. The flip is a record change, which is reversible. Route 53 is a later move of the zone, and it is a separate outage. ACM on the ALB (app, link) and on CloudFront (the apex). |
| `kernal-web` on Cloud Run | S3 plus CloudFront. The page is static nginx (`landing.sh`). A container on Fargate buys nothing. |

### 3.8 Atlas

Not a GCP API, but every store call is a round trip to `us-central1` today. An API in AWS
another region away pays latency and egress on each of them. PrivateLink (or an Atlas private
endpoint) wants a VPC, which this fleet does not have yet; phase 2 creates that VPC, and the
Atlas endpoint can land in it when Matthew picks the region.

Staging must not point at the production cluster unless Matthew says so (§7). A snapshot or a
second Atlas project is the default.

### 3.9 What does not get an AWS twin

- Pub/Sub. It is enabled and unused.
- A GCS snapshot bucket. The feature is not built. When it is, `SNAPSHOT_HOST_ALLOWLIST` becomes
  a per-provider host (`storage.googleapis.com` or the bucket's virtual-hosted S3 name), set by
  the deploy adapter.
- The gcloud MCP, the Google product MCP servers, and `kernal-oauth`.
- Blacksmith, Sentry, LiteLLM, Deepgram, ngrok, the GitHub App.

---

## 4. Provider abstraction

The goal is one fleet description and a switch, with GCP remaining the path a release tag takes
until the cutover commit changes the default. The GKE work already did this once inside GCP:
`SANDBOX_PROVIDER` in `config.env`, a registry, and in-flight runs still stopped through the
provider they started on. Copy that shape one level up. Do not rewrite the bash into Terraform
as the first step. The scripts are the infrastructure, they have dry-run tests, and a parallel
AWS tree can grow beside them.

### 4.1 Config shape

`deploy/config.env` keeps every value that is the same on both clouds: operators, the login
allow-list, `PREVIEW_DOMAIN`, LiteLLM URL, sandbox launch mode and cap, warm hours, the Agent
Engine project ids. Add one line:

```bash
# gcp until a cutover commit says otherwise. Unset means gcp.
HOST_PROVIDER="${HOST_PROVIDER:-gcp}"
```

Provider coordinates move to files the shared `env.sh` sources after that line:

```bash
# deploy/providers/gcp.env
PROJECT="${PROJECT:-outfitter-509211}"
REGION="${REGION:-us-central1}"
ACCOUNT="${ACCOUNT:-mgm@mgms.eu}"
AR_REPO="${AR_REPO:-outfitter}"

# deploy/providers/aws.env
AWS_ACCOUNT="${AWS_ACCOUNT:-}"          # §7
AWS_REGION="${AWS_REGION:-}"            # §7
ECR_REPO="${ECR_REPO:-outfitter}"
ECS_CLUSTER="${ECS_CLUSTER:-outfitter}"
EKS_CLUSTER="${EKS_CLUSTER:-outfitter}"
```

`env.sh` today defaults `PROJECT` / `REGION` / `ACCOUNT` itself and refuses a project that does
not look like `outfitter-*`. That guard stays on the GCP path. The AWS path refuses an empty
account or region the same way, and it does not require the `gcloud` login check.

The process, not the shell, learns the backend from env the deploy adapter sets:

| Variable | GCP value | AWS value |
|---|---|---|
| `HOST_PROVIDER` | `gcp` | `aws` |
| `SECRETS_BACKEND` | `gcp` | `aws` |
| `WAKE_BACKEND` | `cloudtasks` | `sqs` |
| `TELEMETRY_BACKEND` | `gcp` | `cloudwatch` |
| `BROWSER_AUTH` | `iap` | `alb-oidc` |
| `AGENT_IDENTITY` | `google-id` | `eks-pod` |
| `SANDBOX_PROVIDER` | `gke` (unchanged) | `eks` |

An empty `SECRETS_BACKEND` follows `HOST_PROVIDER`. Boot fails closed when `HOST_PROVIDER=aws`
and the AWS coordinates are missing, the way `assertGkeConfigured` fails when
`SANDBOX_PROVIDER=gke` and `GKE_CLUSTER` is empty (`config.ts`).

GCP deploys keep setting `GCP_PROJECT`, `GCP_REGION`, `IAP_AUDIENCE`, `CLOUD_TASKS_QUEUE`,
`TASKS_SA_EMAIL`, and `GKE_*`. AWS deploys leave those unset and set `AWS_REGION`, the queue
URL, the tasks role name, and `EKS_*`. A mixed process (GCP secrets, AWS compute) is a staging
accident, not a supported mode: the backends follow one provider.

### 4.2 Where the code lives

| Seam | Already in the repo | Add |
|---|---|---|
| Run secrets | `SecretsBroker`, `GcpSecretsBroker`, `MemorySecretsBroker` | `AwsSecretsBroker`. `main.ts` selects. |
| Operator secrets | `SecretAdmin`, `GcpSecretAdmin`, `MemorySecretAdmin` | `AwsSecretAdmin`, with the version-label mapping in §3.4. |
| Mail poke | `WakeScheduler` | `SqsWakeScheduler`. |
| Sandbox logs and stats | `SandboxTelemetry` | `CloudWatchSandboxTelemetry`. |
| Drive launch | `SandboxProvider` registry: `inprocess`, `docker`, `cloudrun`, `gke` | `eks`. Extract the CRD HTTP calls from `gke.ts` so both providers share the claim body and differ in `ClusterAuth`. |
| Browser identity | `identityFromRequest` verifies IAP | `BrowserAuth` implementation `alb-oidc`. `iap` stays the default. |
| Drive identity | `verifyAgentToken`, `agentd` `getIdToken` | Dispatch on `AGENT_IDENTITY`. Both verifiers registered during the bake. |
| Clock identity | `verifyTasksToken` | Second verifier, same function. |
| Deploy | `deploy/*.sh` call `gcloud` | `deploy/providers/gcp/` is a move of the gcloud scripts, done only as each script gains an AWS sibling, not as one rename. `deploy/providers/aws/` has the same verbs: `baseline`, `access`, `service`, `release` steps. `release.sh` calls `host_release`, which dispatches on `HOST_PROVIDER`. |
| Manifests | `deploy/gke/*.yaml` | Stay. EKS gets `deploy/eks/` and reuses the template text where it is identical. The metadata egress rule is GCP-specific and does not get copied. |
| CI | `outfitter-deploy.yml`, `gke-workflow-check.sh` | `host-workflow-check.sh`, same idea: read `HOST_PROVIDER` from `config.env` in isolation (the GKE check exists because `source config.env` under `set -u` broke every release). |

`host_release` for `gcp` is today's `release.sh` body. The first PR that introduces the function
has a test, in the style of `deploy/test/release-gke-off.test.sh` and
`service-env-gke-off.test.sh`, that the GCP dry run is unchanged.

### 4.3 How CI picks the target

The production workflow keeps deploying GCP until a commit changes `HOST_PROVIDER` and the
workflow's auth step together. A repository variable may override the file for one run; the
default when the variable is empty is the file, and the file defaults to `gcp`.

Auth step, after `host-workflow-check.sh`:

- `gcp`: `google-github-actions/auth@v2` with `GCP_WIF_PROVIDER` and `GCP_DEPLOY_SA`, as now.
- `aws`: `aws-actions/configure-aws-credentials` assuming the deploy role. No static keys.

Until the AWS scripts exist, `HOST_PROVIDER=aws` fails the workflow with a clear error. It must
not fall through into `gcloud`.

Staging uses a second workflow file, `outfitter-deploy-aws.yml`, and a second GitHub environment
`staging-aws`. It is `workflow_dispatch` until phase 7, and its OIDC trust is that file only.
A tag push therefore cannot start an AWS deploy by accident, and an AWS failure cannot take the
concurrency lock of `outfitter-deploy`. The live-test workflow grows a staging job that assumes
the live role and never the deploy role, matching the `github` vs `github-live` split.

Images: the builder job assumes `outfitter-builder` and pushes to ECR. The deploy job assumes
`outfitter-deployer` and only rolls out a tag the builder job already pushed. Same commit tag
both sides, so a bake can run the same `outfitter-v*` commit on GCP (the existing workflow) and
on AWS (the staging workflow) without the two builds inventing different tags.

---

## 5. Phases

Each phase leaves GCP serving `app.kernal.one` and `link.kernal.one`. Later phases are owner-run
where they create billed resources, on the same footing as `gke-cluster.sh` and `ci-setup.sh`
(`deploy/CLAUDE.md`).

### Phase 0. This plan

No code. Matthew answers §7, or marks the ones that can wait. Phase 1 can start without the AWS
account id. Phase 2 cannot.

### Phase 1. The seam, GCP only

Land `HOST_PROVIDER`, `deploy/providers/gcp.env`, `host-workflow-check.sh`, and the selection in
`main.ts` where the GCP class is still the only non-dev implementation. No new cloud API, no
workflow auth change.

Test: `npm test`; `shellcheck`; `deploy/test/*`; a new guard that `DRY_RUN=1 ./release.sh` with
`HOST_PROVIDER` unset or `gcp` matches the current gcloud arguments (the byte-compare pattern
the GKE-off tests use). A boot test that `HOST_PROVIDER=aws` without AWS coordinates exits
before listening.

Rollback: revert the commit. Nothing in the project has changed.

### Phase 2. AWS account baseline, no traffic

Owner-run `deploy/providers/aws/baseline.sh`, dry run first. Creates the OIDC provider, the
deploy and builder and live roles, the ECR repository, an empty ECS cluster, a VPC with private
subnets, VPC endpoints for ECR, Secrets Manager, CloudWatch, and SQS (so a NAT gateway is not
required for those calls), the SQS queue, the EventBridge schedules in a disabled state, a
budget, and empty secrets. No EKS yet (that fee starts when the cluster exists). No DNS change.

Test: dry run prints and creates nothing. After apply, a dispatched staging workflow can
`sts get-caller-identity` as the deploy role. A workflow run from a branch, from `main`, and
from any other workflow file cannot. The builder role can push a scratch image and cannot call
`ecs:UpdateService`.

Rollback: delete the AWS resources. GCP is untouched.

### Phase 3. Images in ECR

The builder job pushes `outfitter-api`, `outfitter-agent`, and `kernal-web` under the commit
tag. No rollout.

Test: the image id is the same Dockerfile CI builds. A local `docker run` of the API image with
`OUTFITTER_DEV=1` still starts. The agent image's entrypoint is unchanged.

Rollback: delete the ECR images.

### Phase 4. Staging control plane

ECS services for web and link on a staging hostname Matthew chooses (an ALB DNS name is enough;
do not take `app.kernal.one` yet). Secrets copied once from GCP. `BROWSER_AUTH=alb-oidc` with
the Google client. `SANDBOX_PROVIDER` on staging stays off or `noop` until phase 5, so a person
clicking Play on staging gets a clear "not configured" rather than a Drive on the production
cluster.

Atlas: a separate cluster or a snapshot, unless §7 says staging may use production.

Test: the release smoke checks against the staging URL (link is 401 without a token, web
redirects to Google). A member on `IAP_MEMBERS` can sign in; a Google account that is not on
the list cannot. Device login against the staging link. The live-test role, not the deploy
role, runs that check. Sentry release stays on the existing job; staging is a second
environment name, not a replacement of `production`.

Rollback: scale the ECS services to 0. Production DNS still points at Cloud Run.

### Phase 5. Sandboxes on EKS, against the staging link

Owner-run cluster create, then the controller install, then `deploy/eks/` equivalents of
`gke-iam.sh` and `gke-template.sh`. `SANDBOX_PROVIDER=eks` only on the staging task definition.
Warm pool on the same clock, schedules still disabled until the hook returns 200.

Identity: `AGENT_IDENTITY=eks-pod`. The staging link's verifier list has `eks-pod` and does not
need `google-id` until a GCP Drive is pointed at it, which it is not.

Network: ingress denied, egress 80/443 to public addresses, IMDS not usable from the model
user's uid. The pod role can write logs and cannot read secrets.

Test: `deploy/wake-bench.mjs` against staging, cold and warm, compared with the GKE numbers the
last bench recorded. `EKS_MAX_ACTIVE` (the same cap) refuses a fourth Drive. A shell in the
sandbox cannot obtain the node role's credentials. Stop, idle-stop, and a rollback of the
staging image still reap the claim.

Rollback: `SANDBOX_PROVIDER` on staging back to off, scale the pool to 0, delete claims. The
production GKE cluster is not in this path.

### Phase 6. Clocks, wakes, telemetry

Enable the EventBridge schedules. Point staging mail at SQS. Turn on
`CloudWatchSandboxTelemetry`.

Test: post mail to a staging session and see one wake, including the case where the poke is
dropped and the tick sweeps it. Warm pool scales up and down on the cron. The session page
shows that Drive's logs and a CPU series. A second post of the same mail id does not start a
second Drive (the Cloud Tasks named-task property, rebuilt on the mail id in the store).

Rollback: disable the schedules and set `WAKE_BACKEND` empty so staging uses the inline wake
only. The store still holds the mail.

### Phase 7. Cutover

Preconditions: phases 4–6 have been green for a window Matthew sets; the GCP services are still
running the same commit or the previous one; TTL on the `kernal.one` records has been lowered
ahead of time; secrets have been copied again, GCP still the source; `OUTFITTER_ORIGIN_ALIASES`
on both sides includes the origin the other side is about to stop being, for at least the agent
token lifetime (one hour), which is the mechanism `config.ts` already documents for a hostname
change.

Steps:

1. Deploy that `outfitter-v*` tag to AWS from the staging workflow, now trusted for tags as well
   as dispatch.
2. Smoke-check the ALB hostname directly, before any public record changes.
3. In Cloud DNS project `cognitio-flow`, point `app` and `link` at the ALB, and `kernal.one` /
   `www` at CloudFront. Leave the Cloud Run mappings in place so the old targets still resolve
   by their `run.app` names.
4. Watch the release smoke checks, Sentry, and a single Play on a real account.

In-flight GKE Drives are the sharp edge. Their WebSocket is aimed at the link origin they were
handed. The alias list lets them finish against whichever link still has their run. New Drives
start on EKS only after `SANDBOX_PROVIDER=eks` is what the AWS web service runs. Drain GKE
(scale the warm pool to 0, wait for claims) before deleting anything, not as part of the record
flip.

Rollback: put the Cloud DNS records back. GCP is still serving. Drives that started on EKS
during the window are stopped through the `eks` provider, which is why the registry records the
provider on the run and why both providers stay configured until the drain is done. Do not
decommission GCP in this phase.

### Phase 8. Drain GCP

After the bake Matthew agrees to: GKE pool at 0, `gke-teardown.sh`, Cloud Run services left at
min 0 then deleted, secrets and images kept for the recovery window he sets, then the Artifact
Registry repo and the unused APIs. Atlas moves region in this phase if it has not already.
Remove the GCP auth step from the production workflow only after the bake, in its own commit.

Rollback of this phase is a restore, not a record flip. That is why it is last and separate.

### Order

```
phase 0 decisions
    → phase 1 seam (no cloud spend)
        → phase 2 account baseline
            → phase 3 images
                → phase 4 staging API
                    → phase 5 EKS sandboxes
                        → phase 6 clocks and logs
                            → phase 7 DNS cutover
                                → phase 8 drain GCP
```

Phase 1 is the only phase that touches the GCP deploy path, and its test is that the path does
not change. Phases 2–6 do not edit `outfitter-deploy.yml`'s auth. Phase 7 is the first
production DNS write.

---

## 6. Risks

| Risk | Why it is real here | What keeps it small |
|---|---|---|
| Browser login | IAP is not a header this app trusts blindly; `auth.ts` verifies a Google JWT with a Cloud Run audience. An ALB misconfiguration that lets the origin through without the JWT is a public admin UI. | The app verifies `x-amzn-oidc-data`. A test account off the allow-list is part of the phase 4 check. `access.sh` stays the GCP source of members until cutover. |
| Drive identity | The metadata server is how a Drive proves it is `outfitter-agent`. A bug in the new mint either locks every Drive out or accepts a token anyone can forge. | Phase 1's dispatch defaults to today's mint. The AWS verifier is enabled only on the staging link. The email/subject check stays. |
| IMDS from the model | GKE left the metadata server reachable and relied on the service account having no power. EKS node roles are often powerful. | Pod identity, hop limit 1, the phase 5 test that a sandbox shell cannot assume the node role. |
| Warm pool lost in a "simpler" sandbox | ECS tasks look like the Cloud Run Job. The fleet already left that model. | §3.2. An `eks` provider, not a Fargate-task provider, unless §7 chooses cold starts. |
| Budget | $25 covers today's GCP shape in part because the GKE cluster fee is credited and Cloud Run scales to zero. EKS is about $73/month before pods; an ALB and, if the VPC endpoints are skipped, a NAT gateway are standing charges. | Phase 2 creates the budget before the cluster. Phase 5 is the first EKS spend, and it waits on the ceiling in §7. |
| Atlas across clouds | Store calls get slower and egress appears the moment the API leaves `us-central1`. | Staging uses its own cluster. Production cutover waits on the region decision. |
| Secret forked during the bake | Two admins, two writes. | GCP stays the only write path until phase 7. One copy, immediately before the flip. |
| Secrets Manager version semantics | Disable-and-restore is the operator page's contract. | Phase 4 includes a disable, a masked read, and a restore against a scratch secret before any real key is copied. |
| Tag trust too wide | `ci-setup.sh` exists because a branch workflow must not deploy. | The AWS trust policy copies the tag condition. The staging workflow is a different file and a different role. The tag ruleset stays. |
| Cutover strands a Drive | The link origin is the token audience. | `OUTFITTER_ORIGIN_ALIASES` on both sides for an hour. Drain GKE after the flip, not before the aliases work. |
| `cognitio-flow` DNS | The zone is not in the Outfitter project. A cutover that assumes `outfitter-deployer` can edit it will stop at the record change. | §7 asks who can edit the zone. The flip is a documented console or `gcloud dns` step in that project, not an Actions step, unless that access is granted on purpose. |
| OAuth client edit breaks IAP | One client, two redirect URIs, during the bake. | Add the ALB URI in phase 4 and confirm `app.kernal.one` still redirects to Google before any AWS traffic is real. |
| Big-bang Terraform rewrite | The scripts' dry-run tests are the safety net. Replacing them first throws that net away. | AWS scripts sit beside the gcloud scripts. Shared code is the seam in §4, not a new toolchain. |

---

## 7. Open questions for Matthew

These are the ones the repo cannot answer. Recommendations above stand until he does.

1. **AWS account.** Account id, payer, and whether an organization SCP will block GitHub OIDC,
   public ALBs, or EKS. Who else, besides the owner of `mgm@mgms.eu`, is an administrator.
2. **Region.** `us-east-1` is the usual default and is not close to Atlas in GCP `us-central1`.
   `us-east-2` or `us-west-2` do not fix that. A region next to the Atlas cluster only matters
   if Atlas is moving too (question 6). Any data-residency reason `us-central1` was chosen
   applies here.
3. **Budget ceiling.** The $25 alert does not survive EKS (about $73/month for the control
   plane) plus an ALB (about $20) plus sandbox pods. What monthly number should AWS Budgets
   enforce, and should phase 5 wait until that number is set?
4. **DNS.** Keep zone `kernal-one` in Cloud DNS project `cognitio-flow` and change records at
   cutover, or move the zone to Route 53 first? Who can edit `cognitio-flow`? The plan assumes
   the records stay where they are until phase 7.
5. **`kernal.run`.** The plan leaves previews and Local Host on the ngrok wildcard. Confirm
   that stays.
6. **Atlas.** Stay on GCP `us-central1`, move the cluster onto AWS, or dump into a new cluster.
   Public access list (today's posture) or a private endpoint into the new VPC. May staging use
   the production cluster? The plan assumes it may not.
7. **Browser login.** ALB authenticate-oidc with the existing Google client (needs a second
   redirect URI, and IAP must keep working), a new OAuth client, or sessions the app issues
   itself. The plan assumes the existing client plus a second redirect URI.
8. **Sandbox isolation.** Is gVisor required on EKS, or is a container on an ordinary node
   enough given the network policy and the powerless pod role? Firecracker via a Fargate task
   per Drive is the alternative that drops the warm pool; the plan does not take it unless he
   says cold starts are acceptable.
9. **Warm hours and the cap.** Keep 00:00–12:00 `Europe/Zagreb` and `GKE_MAX_ACTIVE=3` on the
   AWS pool?
10. **Bake.** How long GCP stays hot after the DNS flip, and who watches the flip.
11. **gcloud MCP after cutover.** Operators still use it against Google. Once this project is
    drained, is the toolset still wanted for other Google projects, or does it go too?
12. **Staging hostname.** An ALB name is enough. If he wants `staging.kernal.one`, that is a
    record in `cognitio-flow` during phase 4, earlier than the cutover.

---

## 8. What this plan does not do

- It does not change `deploy/*.sh`, the workflows, or the API. The pointer in `deploy/README.md`
  is the only other edit.
- It does not deploy, tag a release, or call `gcloud` or AWS.
- It does not pick a Terraform layout. If a later phase outgrows bash, that is a new plan; the
  seam in §4 is the part that has to exist either way.
- It does not move Kernal's laptop release, the Chrome extension, or the router.
