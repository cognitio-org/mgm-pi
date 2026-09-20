#!/usr/bin/env bash
# Deploys outfitter-link, the "link" role (OUTFITTER_ROLE=link): /agent/ws and /api/hooks/*,
# --allow-unauthenticated, no IAP. See service.sh for what this actually does, and
# docs/protocol.md "Two origins" for why it's split from api.sh:
#   PROJECT=outfitter-509211 REGION=us-central1 ./link.sh
exec "$(dirname "${BASH_SOURCE[0]}")/service.sh" link
