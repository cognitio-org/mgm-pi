#!/usr/bin/env bash
# E5.5 agent mailbox infra (EPIC.md, docs/reports/agent-messaging.md). Idempotent; run once per
# project, after link.sh has deployed outfitter-link at least once:
#   PROJECT=outfitter-509211 REGION=us-central1 ./mailbox.sh
#
# Creates:
# - Cloud Tasks queue `outfitter-wake`: one named task per posted mail, calling
#   POST <link>/api/hooks/tasks/wake with an OIDC token, retried with backoff until it returns 2xx.
# - Service account `outfitter-tasks`: the identity Cloud Tasks and Cloud Scheduler mint those OIDC
#   tokens as. The hooks accept no other caller (TASKS_SA_EMAIL, src/auth.ts verifyTasksToken).
# - IAM: outfitter-api may enqueue on that one queue and act as outfitter-tasks when it does.
# - Cloud Scheduler job `outfitter-tick`: POST <link>/api/hooks/tick every 5 minutes (reconcile
#   runs, wake sessions holding undelivered mail). Within the free tier of three jobs.
#
# Then redeploy both services (./link.sh, ./api.sh): service.sh finds this queue and service
# account itself and sets CLOUD_TASKS_QUEUE / TASKS_SA_EMAIL.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

QUEUE="${QUEUE:-outfitter-wake}"
TASKS_SA="outfitter-tasks"
TASKS_SA_EMAIL="${TASKS_SA}@${PROJECT}.iam.gserviceaccount.com"
API_SA_EMAIL="outfitter-api@${PROJECT}.iam.gserviceaccount.com"
# The tick's OIDC audience must be exactly the origin outfitter-link verifies against (its own
# OUTFITTER_ORIGIN), so re-run this after link's hostname changes (e.g. to link.kernal.one).
LINK_ORIGIN="$(deployed_origin outfitter-link)"
if [[ -z "${LINK_ORIGIN}" ]]; then
  echo "mailbox: outfitter-link is not deployed yet; run ./link.sh first." >&2
  exit 1
fi

echo "== Enabling Cloud Tasks and Cloud Scheduler =="
gcloud services enable cloudtasks.googleapis.com cloudscheduler.googleapis.com --project="${PROJECT}"

echo "== Queue ${QUEUE} =="
if ! gcloud tasks queues describe "${QUEUE}" --project="${PROJECT}" --location="${REGION}" &>/dev/null; then
  gcloud tasks queues create "${QUEUE}" --project="${PROJECT}" --location="${REGION}"
fi
# A wake is cheap and idempotent; retry for up to an hour so a Cloud Run Job quota blip or a slow
# image pull doesn't strand mail until the next tick.
gcloud tasks queues update "${QUEUE}" --project="${PROJECT}" --location="${REGION}" \
  --max-attempts=20 --min-backoff=5s --max-backoff=300s --max-retry-duration=3600s \
  --max-dispatches-per-second=5

echo "== Service account ${TASKS_SA_EMAIL} =="
if ! gcloud iam service-accounts describe "${TASKS_SA_EMAIL}" --project="${PROJECT}" &>/dev/null; then
  gcloud iam service-accounts create "${TASKS_SA}" --project="${PROJECT}" \
    --display-name="Outfitter Cloud Tasks / Scheduler caller"
fi

echo "== IAM: ${API_SA_EMAIL} enqueues on ${QUEUE} only, as ${TASKS_SA_EMAIL} =="
gcloud tasks queues add-iam-policy-binding "${QUEUE}" --project="${PROJECT}" --location="${REGION}" \
  --member="serviceAccount:${API_SA_EMAIL}" --role="roles/cloudtasks.enqueuer" >/dev/null
# actAs on this one SA is what lets a task carry an OIDC token minted as it. The hooks trust that
# email alone, so nothing else -- in particular the agent SA the sandboxes run as -- may hold
# serviceAccountUser or serviceAccountTokenCreator on outfitter-tasks.
gcloud iam service-accounts add-iam-policy-binding "${TASKS_SA_EMAIL}" --project="${PROJECT}" \
  --member="serviceAccount:${API_SA_EMAIL}" --role="roles/iam.serviceAccountUser" >/dev/null

echo "== Scheduler job outfitter-tick =="
TICK_ARGS=(
  --project="${PROJECT}" --location="${REGION}"
  --schedule="*/5 * * * *"
  --uri="${LINK_ORIGIN}/api/hooks/tick"
  --http-method=POST
  --message-body="{}"
  --oidc-service-account-email="${TASKS_SA_EMAIL}"
  --oidc-token-audience="${LINK_ORIGIN}"
)
if gcloud scheduler jobs describe outfitter-tick --project="${PROJECT}" --location="${REGION}" &>/dev/null; then
  # create takes --headers, update only --update-headers (it rejects --headers outright).
  gcloud scheduler jobs update http outfitter-tick "${TICK_ARGS[@]}" \
    --update-headers="Content-Type=application/json"
else
  gcloud scheduler jobs create http outfitter-tick "${TICK_ARGS[@]}" \
    --headers="Content-Type=application/json"
fi

echo
echo "Done. Redeploy both roles (./link.sh, then ./api.sh); service.sh picks up ${QUEUE} and ${TASKS_SA_EMAIL} itself."
