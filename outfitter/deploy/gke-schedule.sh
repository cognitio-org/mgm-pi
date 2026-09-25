#!/usr/bin/env bash
# Cost guardrail for the GKE warm pool (docs/specs/gke-sandbox-provider.md §5.3;
# gke-sandbox-provider-plan.md §1 "Warm hours"). Two Cloud Scheduler HTTP jobs call the link role's
# POST /api/hooks/warm-pool {"replicas":N} hook, authenticated exactly like mailbox.sh's
# outfitter-tick (an OIDC token as outfitter-tasks, audience = link's own origin). One time, by
# hand, after mailbox.sh (creates outfitter-tasks) and link.sh (deploys outfitter-link) have run:
#   DRY_RUN=1 ./gke-schedule.sh
#   PROJECT=outfitter-509211 REGION=us-central1 ./gke-schedule.sh
# Idempotent: describes each job first, updates it if present.
#
# NOTE: the /api/hooks/warm-pool route itself ships with PR2 (#128), not this PR. Both jobs will
# call it and get a 404 (or, once link starts routing but before that handler exists, whatever the
# generic not-found response is) until #128 merges and outfitter-link is redeployed with it -- they
# aren't harmful meanwhile, just ineffective.
#
# Defaults (owner decision, gke-sandbox-provider-plan.md §1, changed 2026-09-26 "for now"): 00:00 up,
# 12:00 down, every day,
# Europe/Zagreb, 1 replica. Override with WARM_UP_CRON/WARM_DOWN_CRON/WARM_TZ/WARM_REPLICAS.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

[[ -n "${GKE_CLUSTER:-}" ]] || deploy_fail "GKE_CLUSTER is empty in config.env; nothing to schedule"

TASKS_SA_EMAIL="outfitter-tasks@${PROJECT}.iam.gserviceaccount.com"
if ! gcloud_exists iam service-accounts describe "${TASKS_SA_EMAIL}" --project="${PROJECT}"; then
  deploy_fail "${TASKS_SA_EMAIL} doesn't exist; run ./mailbox.sh first"
fi
# Same origin link itself verifies OIDC audiences against (env.sh deployed_origin), so the two sides
# can't disagree even if a domain mapping turns Ready between deploys -- same reasoning as
# mailbox.sh's outfitter-tick.
LINK_ORIGIN="$(deployed_origin outfitter-link)"
if [[ -z "${LINK_ORIGIN}" ]]; then
  echo "gke-schedule: outfitter-link is not deployed yet; run ./link.sh first." >&2
  exit 1
fi

WARM_UP_CRON="${WARM_UP_CRON:-0 0 * * *}"
WARM_DOWN_CRON="${WARM_DOWN_CRON:-0 12 * * *}"
WARM_TZ="${WARM_TZ:-Europe/Zagreb}"
WARM_REPLICAS="${WARM_REPLICAS:-1}"

# run <cmd...> -- execute, or with DRY_RUN=1 print it instead (gke-cluster.sh's convention).
# deploy/CLAUDE.md documents DRY_RUN=1 as safe for every owner-run GKE script, this one included.
run() {
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    printf '   DRY_RUN:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

echo "== Enabling Cloud Scheduler =="
run gcloud services enable cloudscheduler.googleapis.com --project="${PROJECT}"

# create_or_update <job name> <cron> <json body>
create_or_update() {
  local name="$1" schedule="$2" body="$3"
  local args=(
    --project="${PROJECT}" --location="${REGION}"
    --schedule="${schedule}" --time-zone="${WARM_TZ}"
    --uri="${LINK_ORIGIN}/api/hooks/warm-pool"
    --http-method=POST
    --message-body="${body}"
    --oidc-service-account-email="${TASKS_SA_EMAIL}"
    --oidc-token-audience="${LINK_ORIGIN}"
  )
  if gcloud_exists scheduler jobs describe "${name}" --project="${PROJECT}" --location="${REGION}"; then
    # create takes --headers, update only --update-headers (it rejects --headers outright, same as
    # mailbox.sh's outfitter-tick).
    run gcloud scheduler jobs update http "${name}" "${args[@]}" \
      --update-headers="Content-Type=application/json"
  else
    run gcloud scheduler jobs create http "${name}" "${args[@]}" \
      --headers="Content-Type=application/json"
  fi
}

echo "== outfitter-warm-up: ${WARM_UP_CRON} ${WARM_TZ} -> replicas=${WARM_REPLICAS} =="
create_or_update outfitter-warm-up "${WARM_UP_CRON}" "{\"replicas\":${WARM_REPLICAS}}"

echo "== outfitter-warm-down: ${WARM_DOWN_CRON} ${WARM_TZ} -> replicas=0 =="
create_or_update outfitter-warm-down "${WARM_DOWN_CRON}" '{"replicas":0}'

echo
echo "Done. release.sh's audience-drift check now also covers these two jobs."
