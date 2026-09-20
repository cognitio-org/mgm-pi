#!/usr/bin/env bash
# Builds the outfitter-agent sandbox image. Must run with the repo root as build context (the
# Dockerfile COPYs both mgm/ and outfitter/), so this script cd's there regardless of cwd.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
docker build -f outfitter/image/Dockerfile -t outfitter-agent .
