#!/usr/bin/env bash
# Cut an Outfitter release: tag a commit on main `outfitter-vYYYY.MM.DD.N` (UTC date, N counts up
# within the day) and push the tag. The push is what deploys: .github/workflows/outfitter-deploy.yml
# tests that commit and runs release.sh on it. The tag's message lists the Outfitter-facing
# commits since the previous release, so `git show <tag>` is the changelog and rolling back means
# redeploying the previous tag (README.md "Rollback").
#   ./tag-release.sh              # tag origin/main's head
#   ./tag-release.sh <commit>     # tag an earlier commit on main
#   DRY_RUN=1 ./tag-release.sh    # print the tag and its message, create nothing
#
# Only a tag, never a GitHub Release: this repo's Releases are Kernal's (vX.Y.Z), and `kernal
# update` and install.sh read releases/latest -- an Outfitter Release marked "latest" would break
# every Kernal install.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "${ROOT}"
git fetch --quiet --tags origin main

TARGET="$(git rev-parse --verify "${1:-origin/main}^{commit}")"
if ! git merge-base --is-ancestor "${TARGET}" origin/main; then
  echo "tag-release: ${TARGET:0:7} is not on origin/main; merge it first." >&2
  exit 1
fi

PREV="$(git describe --tags --abbrev=0 --match 'outfitter-v*' "${TARGET}" 2>/dev/null || true)"
# What ships: the paths release.sh builds and deploys from.
PATHS=(outfitter kernal)
if [[ -n "${PREV}" ]]; then
  if [[ "$(git rev-parse "${PREV}^{commit}")" == "${TARGET}" ]]; then
    echo "tag-release: ${TARGET:0:7} is already released as ${PREV}." >&2
    exit 1
  fi
  CHANGES="$(git log --no-merges --format='- %s (%h)' "${PREV}..${TARGET}" -- "${PATHS[@]}")"
  if [[ -z "${CHANGES}" && "${FORCE:-}" != 1 ]]; then
    echo "tag-release: nothing under ${PATHS[*]} changed since ${PREV}; FORCE=1 to tag anyway." >&2
    exit 1
  fi
else
  CHANGES="- first tagged release"
fi

DAY="$(date -u +%Y.%m.%d)"
N=1
while git rev-parse -q --verify "refs/tags/outfitter-v${DAY}.${N}" >/dev/null; do
  N=$((N + 1))
done
TAG="outfitter-v${DAY}.${N}"
MESSAGE="Outfitter ${TAG#outfitter-v}

Since ${PREV:-the start}:
${CHANGES}"

echo "== ${TAG} -> ${TARGET:0:7} $(git log -1 --format=%s "${TARGET}")"
echo "${MESSAGE}" | sed 's/^/   /'
if [[ "${DRY_RUN:-}" == 1 ]]; then
  echo "== DRY_RUN: no tag created"
  exit 0
fi
git tag -a "${TAG}" -m "${MESSAGE}" "${TARGET}"
git push --quiet origin "refs/tags/${TAG}"
echo "== Pushed ${TAG}. Watch it deploy: gh run watch \$(gh run list --workflow 'Outfitter deploy' --limit 1 --json databaseId -q '.[0].databaseId')"
