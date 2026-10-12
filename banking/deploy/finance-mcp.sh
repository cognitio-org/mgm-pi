#!/usr/bin/env bash
# Create the finance MCP Cloud Run service and let its runtime account read two secrets:
# kernal_wise_key (the Wise API key) and kernal-finance-mcp-token (the caller bearer).
# The Wise key is not mounted into the container and is not registered on router.kernal.one.
#
#   DRY_RUN=1 bash deploy/finance-mcp.sh
#   bash deploy/finance-mcp.sh
#
# After it is up, register the URL as an HTTP MCP on the gateway with allow_all_keys left
# off, and leave wise out of the shared x-mcp-servers list.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-outfitter-509211}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-kernal-finance-mcp}"
SA_NAME="${SA_NAME:-kernal-finance-mcp}"
TOKEN_SECRET="${TOKEN_SECRET:-kernal-finance-mcp-token}"
WISE_SECRET="${WISE_SECRET:-kernal_wise_key}"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

cd "$(dirname "$0")/.."

gc() {
  gcloud --configuration=outfitter "$@"
}

run() {
  if [ -n "${DRY_RUN:-}" ]; then
    printf 'would run: %s\n' "$*"
    return 0
  fi
  "$@"
}

echo "Finance MCP · ${SERVICE} in ${PROJECT_ID} (${REGION})"
[ -n "${DRY_RUN:-}" ] && echo "DRY_RUN=1: nothing will change."

command -v gcloud >/dev/null || { echo "gcloud missing" >&2; exit 1; }

if gc iam service-accounts describe "$SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "service account exists"
else
  run gc iam service-accounts create "$SA_NAME" --project="$PROJECT_ID" --display-name="Finance MCP runtime"
fi

add_token_version() {
  if [ -n "${DRY_RUN:-}" ]; then
    echo "would add a token version from a temp file"
    return 0
  fi
  umask 077
  local tmp value
  tmp="$(mktemp)"
  # RETURN runs even when versions add fails, so the bearer does not stay in $TMPDIR.
  trap 'rm -f "$tmp"' RETURN
  value="$(openssl rand -base64 48 | tr -d '\n+/=')"
  value="${value:0:48}"
  if [ "${#value}" -lt 20 ]; then
    unset value
    echo "generated caller token is too short" >&2
    return 1
  fi
  printf '%s' "$value" >"$tmp"
  unset value
  if ! gc secrets versions add "$TOKEN_SECRET" --project="$PROJECT_ID" --data-file="$tmp"; then
    return 1
  fi
}

if gc secrets describe "$TOKEN_SECRET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  enabled="$(gc secrets versions list "$TOKEN_SECRET" --project="$PROJECT_ID" --filter='state=ENABLED' --format='value(name)' --limit=1 2>/dev/null || true)"
  if [ -n "$enabled" ]; then
    echo "caller token version exists"
  else
    add_token_version
  fi
else
  run gc secrets create "$TOKEN_SECRET" --project="$PROJECT_ID" --replication-policy=automatic
  add_token_version
fi
trap - RETURN
unset enabled

bind() {
  local i
  for i in 1 2 3 4 5 6; do
    if run gc secrets add-iam-policy-binding "$1" \
      --project="$PROJECT_ID" \
      --member="serviceAccount:${SA}" \
      --role=roles/secretmanager.secretAccessor \
      --quiet
    then
      return 0
    fi
    [ -n "${DRY_RUN:-}" ] && return 0
    sleep 5
  done
  echo "could not grant secretAccessor on $1" >&2
  return 1
}

for secret in "$WISE_SECRET" "$TOKEN_SECRET"; do
  bind "$secret"
done

# One instance: wise_statement reads the balance index written by wise_balances on local disk.
# Public invoker plus the app bearer: LiteLLM has one Authorization header, and that header
# is the app token rather than a Google identity token.
run gc run deploy "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --source=. \
  --service-account="$SA" \
  --allow-unauthenticated \
  --max-instances=1 \
  --min-instances=0 \
  --concurrency=4 \
  --port=8080 \
  --memory=512Mi \
  --timeout=120 \
  --set-secrets="FINANCE_MCP_TOKEN=${TOKEN_SECRET}:latest" \
  --quiet

echo "Deployed ${SERVICE}. The Wise key stays in Secret Manager. Register the service URL separately."
