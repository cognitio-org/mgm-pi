#!/usr/bin/env bash
# Deploys outfitter-api, the "web" role (OUTFITTER_ROLE=web): browser REST/SSE behind IAP. See
# service.sh for what this actually does, and docs/protocol.md "Two origins" for why it's split
# from link.sh:
#   PROJECT=outfitter-509211 REGION=us-central1 ./api.sh
exec "$(dirname "${BASH_SOURCE[0]}")/service.sh" web
