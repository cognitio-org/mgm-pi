#!/usr/bin/env bash
# Session search (Sysop tools, #289): creates the Atlas Search and auto-embedded Vector Search
# indexes on `sessionChunks`, and backfills chunks for existing sessions.
#
#   DRY_RUN=1 ./atlas-search.sh            # safe: prints what would change, and the counts
#   ./atlas-search.sh                      # creates/updates the two indexes
#   BACKFILL=1 ./atlas-search.sh           # ...and chunks every existing session
#
# Owner-run (see CLAUDE.md): building the vector index makes Atlas embed every chunk through Voyage,
# billed per token, and Automated Embedding must be enabled for the Atlas org first. The indexes
# take two of the Free tier's three search/vector indexes. SESSION_SEARCH_EMBED_MODEL overrides the
# model (default voyage-4-lite).
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

URI="$(gcloud secrets versions access latest --secret=outfitter-mongodb-uri --project="${PROJECT}")"
ARGS=()
[[ -n "${DRY_RUN:-}" ]] && ARGS+=(--dry-run)
[[ -n "${BACKFILL:-}" ]] && ARGS+=(--backfill)
cd ../packages/api
MONGODB_URI="${URI}" node src/search/ensure-indexes.ts "${ARGS[@]+"${ARGS[@]}"}"
