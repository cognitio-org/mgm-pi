#!/usr/bin/env bash
# Bug 9 (docs/reports/cloud-fixes.md): deploys link, then web, then the agent Job, all from one
# commit -- the version-skew guard in each of those scripts (env.sh's check_deploy_skew) means a
# partial run here (e.g. link succeeds, web fails) leaves the fleet in a state the *next* deploy of
# any single component will refuse to build on top of without ALLOW_SKEW=1, rather than silently
# layering a new skew on top of the old one.
#
# Order matters: link.sh's bootstrap-deploy fallback for OUTFITTER_LINK_ORIGIN needs outfitter-link
# to already exist before api.sh runs (see service.sh's "web" branch), and the agent Job should
# roll last since it's what sandboxes actually run -- link/web changes are safe to be live slightly
# ahead of it (they don't send anything an old agentd can't already ignore safely; it's the
# opposite skew, an old web/link against a newer agentd, that this guard exists to catch).
#
#   PROJECT=outfitter-509211 REGION=us-central1 OUTFITTER_API=https://outfitter-link-xyz.run.app ./deploy-all.sh
#
# OUTFITTER_API must already be set to (or guessable as) outfitter-link's URL for agent-job.sh --
# on a brand-new project, deploy link.sh once by hand first to learn it (see agent-job.sh's own
# usage comment), then re-run this script.
set -euo pipefail
DIR="$(dirname "${BASH_SOURCE[0]}")"

echo "== deploy-all: 1/3 link =="
"${DIR}/link.sh"

echo "== deploy-all: 2/3 web =="
"${DIR}/api.sh"

echo "== deploy-all: 3/3 agent Job =="
"${DIR}/agent-job.sh"

echo "== deploy-all: done, all three components deployed from the same commit =="
