#!/usr/bin/env bash
# Kept for muscle memory: the whole-fleet deploy (the Job, then link, then web, from one commit) is
# now release.sh, which adds the committed-main and no-rollback guards and smoke checks. This is a
# hand run of it; routine deploys come from pushing a release tag (README.md "Deploying").
exec env MANUAL=1 "$(dirname "${BASH_SOURCE[0]}")/release.sh" "$@"
