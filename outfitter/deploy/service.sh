#!/usr/bin/env bash
# Build outfitter-api's image with Cloud Build and deploy it to Cloud Run as one of the two roles
# (EPIC.md E2.7, src/config.ts's OutfitterRole, docs/protocol.md "Two origins"): IAP is service-wide
# on Cloud Run, so it can't gate just the browser routes while still letting agentd's WebSocket and
# the unauthenticated ngrok webhook through -- the same image is deployed twice instead, picking its
# routes by OUTFITTER_ROLE. `web` (`outfitter-api`) serves browser REST/SSE behind IAP; `link`
# (`outfitter-link`) serves only `/agent/ws` and `/api/hooks/*`, `--allow-unauthenticated`, each
# authenticating its own requests.
#
# Routine deploys go through release.sh (GitHub Actions runs it on every green main; see
# README.md "Deploying"), which calls link.sh and api.sh -- the two-line wrappers around this:
#   ./link.sh && ./api.sh
# This script only builds and rolls out a revision. Who can reach the services (IAP, its OAuth
# client and members, the public link role's invoker binding) is access.sh's job, run by hand when
# access changes, so a routine deploy can never widen or narrow access, and the CI deployer never
# needs IAP or IAM-admin rights. The one exception is a brand-new service (the bootstrap below),
# which is created with its access flags so the web role is never briefly public.
#
# Docs consulted (also see docs/reports/api.md "gcloud commands you were least sure about"):
# - Enabling IAP directly on a Cloud Run service (the --iap flag) and granting the IAP service
#   agent run.invoker: https://cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run.
#   `gcloud run deploy --iap` worked as-is (no `gcloud beta` needed).
# - Domain-level IAP access via `gcloud iap web add-iam-policy-binding`: same page; its own example
#   only shows `--member=user:...`. `domain:mgmonteleone.com` is the standard IAM member syntax
#   used everywhere else in gcloud, but this exact command with a domain member is unconfirmed by
#   the doc text itself -- verify the binding actually took (`gcloud iap web get-iam-policy`)
#   before relying on it to gate real access.
# - IAP_AUDIENCE: the `aud` claim IAP signs into x-goog-iap-jwt-assertion for a service with IAP
#   enabled directly on Cloud Run is `/projects/PROJECT_NUMBER/locations/REGION/services/SERVICE`
#   (JWT payload claims table, "aud (Audience)" row, "Cloud Run") --
#   https://cloud.google.com/iap/docs/signed-headers-howto. See src/auth.ts for where it's
#   verified. Computed below from `gcloud projects describe`, not hand-set.
set -euo pipefail

ROLE="${1:-}"
if [[ "${ROLE}" != "web" && "${ROLE}" != "link" ]]; then
  echo "usage: $(basename "${BASH_SOURCE[0]}") <web|link>" >&2
  exit 1
fi

# shellcheck source=env.sh
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
AR_REPO="${AR_REPO:-outfitter}"
CLOUDRUN_JOB="${CLOUDRUN_JOB:-outfitter-agent}"
if [[ "${ROLE}" == "web" ]]; then
  SERVICE="outfitter-api"
else
  SERVICE="outfitter-link"
fi

# TUNNEL_DOMAIN_LMSTUDIO, LITELLM_BASE_URL, PROVIDER_POLL_MS, IDLE_STOP_SECONDS and
# OUTFITTER_OPERATORS come from config.env (via env.sh), so every deploy sets the same values.

API_SA_EMAIL="outfitter-api@${PROJECT}.iam.gserviceaccount.com"
AGENT_SA_EMAIL="outfitter-agent@${PROJECT}.iam.gserviceaccount.com"

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # outfitter/, the workspace root
deploy_guard outfitter
CURRENT_IMAGE="$(deployed_image service "${SERVICE}")"
regression_guard "${CURRENT_IMAGE}"
# The tag is the commit the image was built from: regression_guard and release.sh read it back.
TAG="$(commit_tag)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/outfitter-api:${TAG}"

# existing_secrets() is defined in env.sh (sourced above); the secret list is identical for both
# roles -- see README.md's Secret Manager section for what each role actually reads.
#
# E2.10 provider status service (src/providers-status.ts, src/config.ts) adds three env vars beyond
# what was already here: NGROK_API_KEY (secret, below -- ngrok's /endpoints reconciler poll; the
# ngrok webhook itself keeps using NGROK_WEBHOOK_SECRET, unrelated), LITELLM_BASE_URL (plain, in
# ENV_VARS below -- same var name/default as kernal's .env.example), and PROVIDER_POLL_MS (plain, ENV_VARS,
# default 5 minutes). LITELLM_ADMIN_KEY was already mounted here (it predates E2.10) and is now also
# read by the provider status service's LiteLLM probe, falling back to the default guru LiteLLM key
# (outfitter-litellm-key-default, secrets.ts's SecretsBroker.defaultLitellmKey) when unset. #389
# (central-auth.md §5.1) mints per-user device and run keys with the same LITELLM_ADMIN_KEY, on both
# roles (link mints at device login, runs start on both); litellm-admin.sh lists its routes.
SECRETS="$(existing_secrets MONGODB_URI=outfitter-mongodb-uri:latest GITHUB_PAT=outfitter-github-pat:latest LITELLM_ADMIN_KEY=outfitter-litellm-admin:latest LOCAL_TUNNEL_TOKEN=outfitter-local-tunnel-token:latest NGROK_API_KEY=outfitter-ngrok-api-key:latest NGROK_GOOGLE_OAUTH=outfitter-ngrok-google-oauth:latest)"
# #252 web voice: the Deepgram Member key POST /api/voice/token mints browser tokens with. Web role
# only (the exception to "identical for both roles"): link serves no voice route, and this key can
# mint tokens and read usage, unlike the usage-only key kernal bundles ship.
if [[ "${ROLE}" == "web" ]]; then
  VOICE_SECRET="$(existing_secrets DEEPGRAM_API_KEY=outfitter-deepgram-key:latest)"
  [[ -n "${VOICE_SECRET}" ]] && SECRETS="${SECRETS:+${SECRETS},}${VOICE_SECRET}"
fi
# #384 Local Host router entries (docs/specs/local-host.md §3.5): a separate /model/*-only key
# (KEY=local-hosts ./litellm-admin.sh), link role only, where heartbeats and the tick run router
# sync. Never on web: unlike LITELLM_ADMIN_KEY it can rewrite router deployments. Mounted once the
# secret exists; without it the api registers no router listener.
if [[ "${ROLE}" == "link" ]]; then
  ROUTER_SECRET="$(existing_secrets LOCAL_HOST_ROUTER_KEY=outfitter-litellm-admin-key:latest)"
  [[ -n "${ROUTER_SECRET}" ]] && SECRETS="${SECRETS:+${SECRETS},}${ROUTER_SECRET}"
fi
# E9 Agent Engine (config.env): link role only, where the admin socket's memory and ae ops run. Each
# service account secret is mounted only when its project id is set and the secret exists.
if [[ "${ROLE}" == "link" ]]; then
  AE_PAIRS=()
  [[ -n "${AGENT_ENGINE_MEMORY_PROJECT_ID:-}" ]] && AE_PAIRS+=(AGENT_ENGINE_MEMORY_SA=outfitter-agentengine-memory-sa:latest)
  [[ -n "${AGENT_ENGINE_AGENTS_PROJECT_ID:-}" ]] && AE_PAIRS+=(AGENT_ENGINE_AGENTS_SA=outfitter-agentengine-agents-sa:latest)
  if (( ${#AE_PAIRS[@]} > 0 )); then
    AE_SECRET="$(existing_secrets "${AE_PAIRS[@]}")"
    [[ -n "${AE_SECRET}" ]] && SECRETS="${SECRETS:+${SECRETS},}${AE_SECRET}"
  fi
fi

# Both roles run the same image, so whichever deploys second reuses the first one's build.
if image_exists "${IMAGE}"; then
  echo "== Reusing ${IMAGE} (already built for this commit) =="
else
  echo "== Building ${IMAGE} with Cloud Build (packages/api/Dockerfile, context outfitter/) =="
  build_api_image "${SOURCE_DIR}" "${IMAGE}"
fi

# OUTFITTER_ORIGIN is this service's own URL: agentd's token audience (auth.ts verifyAgentToken,
# per-service, not shared between outfitter-api and outfitter-link) and the base for any links the
# UI prints. Cloud Run only hands out that URL once the service exists, so a brand-new service gets
# one bootstrap deploy first (unauthenticated, no IAP, no secrets) purely to learn it. Every later
# run just reads the existing service's URL and skips straight to the real deploy below.
DEPLOYED_ORIGIN="$(deployed_origin "${SERVICE}")"
if ! PUBLIC_ORIGIN="$(public_origin "${SERVICE}")"; then
  echo "error: could not work out ${SERVICE}'s public origin; set OUTFITTER_ORIGIN to deploy anyway" >&2
  exit 1
fi
ORIGIN="${OUTFITTER_ORIGIN:-}"
if [[ -z "${ORIGIN}" ]]; then
  # OUTFITTER_ORIGIN is a token audience on the link role, so it only ever changes on purpose: keep
  # what's deployed unless ALLOW_ORIGIN_CHANGE=1 (then take the Ready custom domain, env.sh
  # public_origin). A brand-new service has nothing deployed and takes public_origin directly.
  if [[ -z "${DEPLOYED_ORIGIN}" || "${DEPLOYED_ORIGIN}" == "${PUBLIC_ORIGIN}" ]]; then
    ORIGIN="${PUBLIC_ORIGIN}"
  elif [[ "${ALLOW_ORIGIN_CHANGE:-}" == 1 ]]; then
    echo "   origin: changing ${DEPLOYED_ORIGIN} -> ${PUBLIC_ORIGIN} (ALLOW_ORIGIN_CHANGE=1)"
    ORIGIN="${PUBLIC_ORIGIN}"
  else
    echo "   origin: keeping ${DEPLOYED_ORIGIN}; ${PUBLIC_ORIGIN} is available (re-run with ALLOW_ORIGIN_CHANGE=1 to switch, README.md \"kernal.one\")"
    ORIGIN="${DEPLOYED_ORIGIN}"
  fi
fi
BOOTSTRAPPED=""
if [[ -z "${ORIGIN}" ]]; then
  # Deliberately status.url, not public_origin: a service that does not exist yet cannot have a
  # Ready domain mapping, so its first origin is always its run.app URL.
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    deploy_fail "${SERVICE} doesn't exist yet; creating a service (and its access) is a one-time step for the owner: ./link.sh or ./api.sh by hand, then ./access.sh"
  fi
  BOOTSTRAPPED=1
  # The web role is created behind IAP from its very first revision (unreachable until access.sh
  # grants the IAP service agent run.invoker); only the link role is public.
  BOOTSTRAP_AUTH=(--allow-unauthenticated)
  [[ "${ROLE}" == "web" ]] && BOOTSTRAP_AUTH=(--no-allow-unauthenticated --iap)
  echo "== Bootstrap deploy (no prior revision, no OUTFITTER_ORIGIN given) to learn the service URL =="
  gcloud run deploy "${SERVICE}" \
    --project="${PROJECT}" \
    --region="${REGION}" \
    --image="${IMAGE}" \
    --min-instances=0 \
    --cpu=0.5 \
    --memory=512Mi \
    --service-account="${API_SA_EMAIL}" \
    "${BOOTSTRAP_AUTH[@]}"
  ORIGIN="$(gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" \
    --format='value(status.url)')"
fi

# ROLE-specific pieces: auth flags at deploy time, and OUTFITTER_ROLE/IAP_AUDIENCE in the env.
# SANDBOX_PROVIDER (from config.env via env.sh -- gke-sandbox-provider-plan.md §5 item 9; a switch
# is "edit config.env, tag a release", not a flag to this script) and CLOUDRUN_JOB go to BOTH
# roles: the provider is constructed at boot (config validation), even though only the web role
# ever wakes a run. Without them the API defaults to the in-process dev provider and refuses to
# start (the link revision 00005 failure).
# Every other origin this service answers on (its run.app URL, a custom domain, the origin it had
# before) is also accepted as a token audience (config.ts tokenAudiences), so an origin change
# doesn't strand running sandboxes or queued Cloud Tasks minted for the old one. ';'-separated:
# --set-env-vars splits on commas.
RUN_APP_URL="$(gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" \
  --format='value(status.url)')"
ORIGIN_ALIASES=""
for alias in "${RUN_APP_URL}" "${DEPLOYED_ORIGIN}" "${PUBLIC_ORIGIN}"; do
  if [[ -n "${alias}" && "${alias}" != "${ORIGIN}" && ";${ORIGIN_ALIASES};" != *";${alias};"* ]]; then
    ORIGIN_ALIASES="${ORIGIN_ALIASES:+${ORIGIN_ALIASES};}${alias}"
  fi
done
ENV_VARS="OUTFITTER_ROLE=${ROLE},OUTFITTER_ORIGIN=${ORIGIN},OUTFITTER_ORIGIN_ALIASES=${ORIGIN_ALIASES},AGENT_SA_EMAIL=${AGENT_SA_EMAIL},GCP_PROJECT=${PROJECT},GCP_REGION=${REGION},TUNNEL_DOMAIN_LMSTUDIO=${TUNNEL_DOMAIN_LMSTUDIO},SANDBOX_PROVIDER=${SANDBOX_PROVIDER},CLOUDRUN_JOB=${CLOUDRUN_JOB},IDLE_STOP_SECONDS=${IDLE_STOP_SECONDS},LITELLM_BASE_URL=${LITELLM_BASE_URL},PROVIDER_POLL_MS=${PROVIDER_POLL_MS}"
# E5.5 (deploy/mailbox.sh): both roles need these -- web schedules wake tasks, link verifies the
# OIDC token on /api/hooks/tasks/wake and /api/hooks/tick. Looked up from what mailbox.sh created
# when not given, for the same reason as OUTFITTER_LINK_ORIGIN below: --set-env-vars replaces the
# whole environment, so a plain re-run used to drop them (on 2026-09-22 the tick 401'd from 13:55
# until they were restored). Absent infra keeps the mailbox on its inline-wake-only path.
if [[ -z "${CLOUD_TASKS_QUEUE:-}" ]] && gcloud_exists tasks queues describe outfitter-wake \
    --project="${PROJECT}" --location="${REGION}"; then
  CLOUD_TASKS_QUEUE="outfitter-wake"
fi
if [[ -z "${TASKS_SA_EMAIL:-}" ]] && gcloud_exists iam service-accounts describe \
    "outfitter-tasks@${PROJECT}.iam.gserviceaccount.com" --project="${PROJECT}"; then
  TASKS_SA_EMAIL="outfitter-tasks@${PROJECT}.iam.gserviceaccount.com"
fi
if [[ -n "${TASKS_SA_EMAIL:-}" ]]; then
  ENV_VARS="${ENV_VARS},TASKS_SA_EMAIL=${TASKS_SA_EMAIL}"
  [[ -n "${CLOUD_TASKS_QUEUE:-}" ]] && ENV_VARS="${ENV_VARS},CLOUD_TASKS_QUEUE=${CLOUD_TASKS_QUEUE}"
  echo "   mailbox: queue=${CLOUD_TASKS_QUEUE:-<none>} tasks SA=${TASKS_SA_EMAIL}"
else
  echo "   note: mailbox infra not found (run ./mailbox.sh); Cloud Tasks wakes and /api/hooks/* auth stay off" >&2
fi
# GKE_* (config.env, gke-sandbox-provider.md §4.4): both roles need the same values -- the provider
# is constructed at boot even though only the web role ever wakes a run (SANDBOX_PROVIDER's own
# comment above). Added only when GKE_CLUSTER is set, so a deploy with GKE off ships byte-identical
# env vars to before this existed.
if [[ -n "${GKE_CLUSTER:-}" ]]; then
  ENV_VARS="${ENV_VARS},GKE_CLUSTER=${GKE_CLUSTER},GKE_LOCATION=${GKE_LOCATION},GKE_NAMESPACE=${GKE_NAMESPACE},GKE_WARM_POOL=${GKE_WARM_POOL},GKE_LAUNCH_MODE=${GKE_LAUNCH_MODE},GKE_MAX_ACTIVE=${GKE_MAX_ACTIVE}"
  echo "   gke: cluster=${GKE_CLUSTER} location=${GKE_LOCATION} namespace=${GKE_NAMESPACE} pool=${GKE_WARM_POOL} mode=${GKE_LAUNCH_MODE} maxActive=${GKE_MAX_ACTIVE}"
fi
# #217 Drive previews, both roles (link answers agentd's preview.open and runs the tick's sweep).
# PREVIEW_ALLOW is who may open a secure preview: the people IAP lets into Outfitter, i.e.
# IAP_MEMBERS plus the operators, ';'-separated because --set-env-vars splits on commas.
if [[ -n "${PREVIEW_DOMAIN:-}" ]]; then
  PREVIEW_ALLOW="$(tr ',' ';' <<<"${IAP_MEMBERS:-}")${OUTFITTER_OPERATORS:+;${OUTFITTER_OPERATORS}}"
  ENV_VARS="${ENV_VARS},PREVIEW_DOMAIN=${PREVIEW_DOMAIN},PREVIEW_ALLOW=${PREVIEW_ALLOW#;}"
  echo "   previews: https://<id>.${PREVIEW_DOMAIN}, secure previews open to: ${PREVIEW_ALLOW#;}"
fi
# #390 device login (docs/specs/central-auth.md §1.6), both roles: web checks it when a person
# approves a device code, link at the token exchange, at every refresh and on every Dongle use.
# The same people as PREVIEW_ALLOW: IAP_MEMBERS plus the operators, ';'-separated.
LOGIN_ALLOW="$(tr ',' ';' <<<"${IAP_MEMBERS:-}")${OUTFITTER_OPERATORS:+;${OUTFITTER_OPERATORS}}"
ENV_VARS="${ENV_VARS},OUTFITTER_LOGIN_ALLOW=${LOGIN_ALLOW#;}"
echo "   device login open to: ${LOGIN_ALLOW#;}"
# #399 CA-10: Drives get per-run LiteLLM keys only (config.env; 0 = no shared-key fallback when a
# mint fails). Both roles, so whichever builds a run.spec reads the same value.
ENV_VARS="${ENV_VARS},OUTFITTER_RUN_KEY_FALLBACK=${OUTFITTER_RUN_KEY_FALLBACK:-0}"
if [[ "${ROLE}" == "link" ]]; then
  # Where POST /api/device/code sends the person to approve: the web role's public origin
  # (app.kernal.one), read from its Ready domain mapping (env.sh public_origin) unless given.
  if [[ -z "${OUTFITTER_WEB_ORIGIN:-}" ]]; then
    OUTFITTER_WEB_ORIGIN="$(public_origin outfitter-api || true)"
  fi
  if [[ -n "${OUTFITTER_WEB_ORIGIN:-}" ]]; then
    ENV_VARS="${ENV_VARS},OUTFITTER_WEB_ORIGIN=${OUTFITTER_WEB_ORIGIN}"
    echo "   device approval page: ${OUTFITTER_WEB_ORIGIN}/device"
  else
    echo "   warning: no web origin found for outfitter-api; device login would send people to ${ORIGIN}/device. Set OUTFITTER_WEB_ORIGIN." >&2
  fi
fi
if [[ "${ROLE}" == "web" ]]; then
  # Needed both for IAP_AUDIENCE (below) and for the run.invoker binding further down.
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
  # See the "IAP_AUDIENCE" doc comment above.
  IAP_AUDIENCE="/projects/${PROJECT_NUMBER}/locations/${REGION}/services/${SERVICE}"
  ENV_VARS="${ENV_VARS},IAP_AUDIENCE=${IAP_AUDIENCE}"
  # OUTFITTER_LINK_ORIGIN (E4.1b, src/config.ts): the outfitter-link service's own URL, surfaced on
  # GET /api/me so the web UI's Tokens page can print the exact OUTFITTER_API value a laptop needs
  # (env.sh has no way to know it from inside this "web" deploy -- it's a different Cloud Run
  # service). Chicken-and-egg on a brand-new project: deploy the "link" role once first (its own
  # bootstrap deploy above learns its URL the same way OUTFITTER_ORIGIN does here), then re-run
  # `./api.sh` with OUTFITTER_LINK_ORIGIN set (or exported in the shell) so it lands in this env
  # list; omitted or empty, the Tokens page just tells the operator to ask for the link URL.
  # Required, not cosmetic: every sandbox this service wakes is told to dial this origin (config.ts
  # sandboxOrigin), and the API refuses to start without it. Read from the deployed link service's
  # own OUTFITTER_ORIGIN (env.sh deployed_origin) when not given, so the audience sandboxes mint
  # tokens for is exactly the one link verifies, and a re-run can never drop it (--set-env-vars
  # replaces the whole environment). Deploy link before web when its hostname changes.
  if [[ -z "${OUTFITTER_LINK_ORIGIN:-}" ]]; then
    OUTFITTER_LINK_ORIGIN="$(deployed_origin outfitter-link)"
  fi
  if [[ -z "${OUTFITTER_LINK_ORIGIN:-}" ]]; then
    echo "error: could not find the outfitter-link service's URL; deploy it first (./link.sh) or set OUTFITTER_LINK_ORIGIN" >&2
    exit 1
  fi
  echo "   link origin: ${OUTFITTER_LINK_ORIGIN}"
  ENV_VARS="${ENV_VARS},OUTFITTER_LINK_ORIGIN=${OUTFITTER_LINK_ORIGIN}"
  # #252/#257 web voice (config.env): the Deepgram project the voice key belongs to, for per-person
  # usage. Not secret. Empty leaves it out.
  [[ -n "${DEEPGRAM_PROJECT_ID:-}" ]] && ENV_VARS="${ENV_VARS},DEEPGRAM_PROJECT_ID=${DEEPGRAM_PROJECT_ID}"
fi
# OUTFITTER_OPERATORS (EPIC.md Decisions table, src/config.ts), on BOTH roles. The web role uses it
# for /api/operator/* (src/auth.ts's requireOperator); the link role needs it too, because it mints
# device keys (operators' keys list the gcloud MCP server, GA-2), mints Drive run keys (operator tapes),
# decides a Drive's operator admin tools (admin/drive.ts) and runs the operator-key reconcile on the
# tick. Link identities come from verified device/run tokens, so the list grants nothing by itself.
# Separated by ';' here, not ',' -- `gcloud run deploy --set-env-vars` splits its whole value on
# commas, so a comma-separated operator list would be sliced into separate env vars; config.ts's
# parser also accepts ',' and whitespace for a locally-set env var, but this script must use ';'.
# Defaults to the two current operators (config.env); override by exporting OUTFITTER_OPERATORS.
ENV_VARS="${ENV_VARS},OUTFITTER_OPERATORS=${OUTFITTER_OPERATORS}"
# E9 Agent Engine (config.env): link role only, each var only when set. Not secret.
if [[ "${ROLE}" == "link" ]]; then
  [[ -n "${AGENT_ENGINE_BASE_URL:-}" ]] && ENV_VARS="${ENV_VARS},AGENT_ENGINE_BASE_URL=${AGENT_ENGINE_BASE_URL}"
  for AE_VAR in AGENT_ENGINE_MEMORY_PROJECT_ID AGENT_ENGINE_MEMORY_SA_EXPIRES_AT AGENT_ENGINE_AGENTS_PROJECT_ID AGENT_ENGINE_AGENTS_SA_EXPIRES_AT; do
    [[ -n "${!AE_VAR:-}" ]] && ENV_VARS="${ENV_VARS},${AE_VAR}=${!AE_VAR}"
  done
fi
# What's running, for the web app's version indicator (GET /api/version): the commit this deploy
# ships and, when the deploy came from a release tag (outfitter-deploy.yml sets GITHUB_REF_NAME),
# that tag. OUTFITTER_RELEASE can be exported by hand for a manual deploy.
ENV_VARS="${ENV_VARS},OUTFITTER_BUILD_COMMIT=${TAG}"
RELEASE_TAG="${OUTFITTER_RELEASE:-}"
if [[ -z "${RELEASE_TAG}" && "${GITHUB_REF_NAME:-}" == outfitter-v* ]]; then RELEASE_TAG="${GITHUB_REF_NAME}"; fi
if [[ -n "${RELEASE_TAG}" ]]; then ENV_VARS="${ENV_VARS},OUTFITTER_RELEASE=${RELEASE_TAG}"; fi

# Request timeout: Cloud Run's default is 300s, which was silently capping BOTH roles' long-lived
# connections -- the agentd WebSocket on "link" (agentd only reconnects proactively at 55 min, see
# packages/agentd/src/link.ts's RECONNECT_AFTER_MS) and the browser's SSE stream on "web"
# (GET /api/sessions/:id/stream, packages/api/src/routes/sessions.ts) were both getting cut every
# 5 minutes (`link closed` code 1006, docs/reports/cloud-fixes.md). This was previously set to 20m
# only on the one-off bootstrap deploy above, never on the real deploy below, so every real
# deployment silently reverted to the 300s default. Both roles now get an explicit --timeout here:
# "link" needs to comfortably exceed agentd's 55-minute proactive reconnect, so 3600s (1h). "web"
# would be fine at 300s for plain REST calls, but the SSE stream is a long-held connection on this
# same role -- EventSource auto-reconnects on a server-side cut, but a cut every 5 minutes still
# means periodic reconnect churn and a brief gap in live updates, so "web" gets the same 3600s
# rather than a "sane REST value" that would keep clipping the stream.
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-3600}"

# No access flags here: gcloud leaves --iap and the invoker binding alone when they're absent, so an
# existing service keeps what access.sh (or the bootstrap above) set.

# Again, right before rolling out: the build above can take many minutes, and a newer revision may
# have gone out meanwhile (from CI, or someone else's hand run).
CURRENT_IMAGE="$(deployed_image service "${SERVICE}")"
regression_guard "${CURRENT_IMAGE}"

# Bug 9 (docs/reports/cloud-fixes.md): refuse (or, with ALLOW_SKEW=1, warn) if the other role's
# service or the agent Job is currently deployed at a different commit -- see env.sh's
# check_deploy_skew. Skipped for the bootstrap deploy above (no secrets/real env yet either; it
# exists purely to learn ORIGIN) since that revision never serves real traffic.
check_deploy_skew "${TAG}" "${ROLE}"

echo "== Deploying ${SERVICE} (OUTFITTER_ROLE=${ROLE}, OUTFITTER_ORIGIN=${ORIGIN}, timeout=${DEPLOY_TIMEOUT}s, build-commit=${TAG}) =="
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --min-instances=0 \
  --cpu=0.5 \
  --memory=512Mi \
  --timeout="${DEPLOY_TIMEOUT}" \
  --service-account="${API_SA_EMAIL}" \
  --update-labels="build-commit=${TAG}" \
  --set-secrets="${SECRETS}" \
  --set-env-vars="${ENV_VARS}"

if [[ -n "${BOOTSTRAPPED}" ]]; then
  echo "== New service: run ./access.sh next to set up IAP and its members =="
fi
echo "== Done: ${SERVICE} ${ORIGIN} now runs ${TAG} =="
