#!/usr/bin/env bash
# Builds the outfitter-agent sandbox image. Must run with the repo root as build context (the
# Dockerfile COPYs both mgm/ and outfitter/), so this script cd's there regardless of cwd.
#
# Targets linux/amd64 by default: Cloud Run Jobs (E1.1) run amd64, and at least one native
# dependency (open-codebase-index's Rust addon) links against glibc's libmvec, which Debian only
# ships for x86_64 -- an arm64 build of this image (e.g. on an Apple Silicon dev laptop, this
# script's own default host arch) fails to load that extension at runtime even though the addon
# file itself is present and correctly selected (docs/reports/image-trim.md). Override with
# OUTFITTER_IMAGE_PLATFORM=linux/arm64 for a faster local build when you don't need that extension
# to actually run (e.g. just checking the build succeeds or the image size).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PLATFORM="${OUTFITTER_IMAGE_PLATFORM:-linux/amd64}"
docker buildx build --platform "$PLATFORM" --load -f outfitter/image/Dockerfile -t outfitter-agent .
