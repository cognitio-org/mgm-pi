#!/usr/bin/env bash
# Cut a Kernal release: publish GitHub release vX.Y.Z on origin/main's head, with the next version
# worked out from the releases already published. Publishing is what builds: .github/workflows/
# release.yml validates the tag, tests, and attaches the bundles; `kernal update` and install.sh
# then read releases/latest.
#   kernal/scripts/release.sh            # next patch: v0.3.15 -> v0.3.16
#   kernal/scripts/release.sh minor      # v0.3.15 -> v0.4.0 (major: -> v1.0.0)
#   kernal/scripts/release.sh 0.4.0      # exactly this version (must be newer than the latest)
#   DRY_RUN=1 kernal/scripts/release.sh  # print the version and notes, publish nothing
#   YES=1 ...                            # skip the confirmation prompt
#
# The notes list the commits under kernal/ since the previous release, so the release page is the
# changelog. A release whose tag isn't vMAJOR.MINOR.PATCH (a typo such as vX.Y.Z) is ignored when
# picking the next version, and named so it can be deleted: while it is the newest release, it is
# what releases/latest returns. Pre-releases (v1.2.0-rc.1) are left to `gh release create` by hand.
#
# Runs on macOS's bash 3.2: no ${v,,}, no mapfile, no regex counts over 255.
set -euo pipefail

REPO="${KERNAL_RELEASE_REPO:-cognitio-org/mgm-pi}"
DRY_RUN="${DRY_RUN:-0}"
BUMP="${1:-patch}"

fail() { echo "release: $*" >&2; exit 1; }

command -v gh >/dev/null || fail "gh is required (and logged in: gh auth status)"
command -v jq >/dev/null || fail "jq is required"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "${ROOT}"
git fetch --quiet --tags origin main
TARGET="$(git rev-parse --verify "origin/main^{commit}")"

# Every published release's tag. A failed listing stops here: guessing the version is how a
# release gets published twice or out of order.
tags="$(gh release list --repo "${REPO}" --limit 200 --exclude-drafts --json tagName --jq '.[].tagName')" \
  || fail "couldn't list ${REPO}'s releases; nothing was published"

SEMVER='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
# The highest vX.Y.Z, compared numerically field by field (not sort -V: BSD sort on older macOS
# lacks it). Pre-releases and anything else are skipped, the junk ones reported.
LATEST=""
junk=""
while IFS= read -r t; do
  [[ -n "${t}" ]] || continue
  if [[ "${t}" =~ ${SEMVER} ]]; then
    LATEST="$(printf '%s\n%s\n' "${LATEST:-v0.0.0}" "${t}" \
      | awk -F'[v.]' '{ k = sprintf("%09d%09d%09d", $2, $3, $4); if (k > best) { best = k; tag = $0 } } END { print tag }')"
  elif [[ ! "${t}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-[0-9A-Za-z.-]+$ ]]; then
    junk="${junk} ${t}"
  fi
done <<<"${tags}"
[[ -n "${LATEST}" ]] || fail "no vX.Y.Z release found in ${REPO}; publish the first one by hand"
if [[ -n "${junk}" ]]; then
  echo "release: warning: releases whose tag isn't a version:${junk}" >&2
  for t in ${junk}; do echo "  delete with: gh release delete ${t} --repo ${REPO} --cleanup-tag --yes" >&2; done
fi

IFS=. read -r MAJ MIN PAT <<<"${LATEST#v}"
case "${BUMP}" in
  patch) NEXT="${MAJ}.${MIN}.$((PAT + 1))" ;;
  minor) NEXT="${MAJ}.$((MIN + 1)).0" ;;
  major) NEXT="$((MAJ + 1)).0.0" ;;
  *)
    NEXT="${BUMP#v}"
    [[ "v${NEXT}" =~ ${SEMVER} ]] || fail "'${BUMP}' is not patch, minor, major or a version like 0.4.0"
    newest="$(printf '%s\n%s\n' "${LATEST}" "v${NEXT}" \
      | awk -F'[v.]' '{ k = sprintf("%09d%09d%09d", $2, $3, $4); if (k > best) { best = k; tag = $0 } } END { print tag }')"
    [[ "${newest}" == "v${NEXT}" && "v${NEXT}" != "${LATEST}" ]] || fail "v${NEXT} is not newer than ${LATEST}"
    ;;
esac
TAG="v${NEXT}"
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  fail "tag ${TAG} already exists (a deleted release can leave its tag: git push origin :refs/tags/${TAG})"
fi

# What ships is kernal/ (scripts/package.sh bundles it). Nothing changed there: nothing to release.
CHANGES=""
if git rev-parse -q --verify "refs/tags/${LATEST}" >/dev/null; then
  [[ "$(git rev-parse "${LATEST}^{commit}")" != "${TARGET}" ]] || fail "origin/main (${TARGET:0:7}) is already released as ${LATEST}"
  CHANGES="$(git log --no-merges --format='- %s (%h)' "${LATEST}..${TARGET}" -- kernal)"
  if [[ -z "${CHANGES}" && "${FORCE:-}" != 1 ]]; then
    fail "nothing under kernal/ changed since ${LATEST}; FORCE=1 to release anyway"
  fi
else
  echo "release: warning: no local tag ${LATEST}; the notes can't list the changes" >&2
fi
NOTES="Changes since ${LATEST}:
${CHANGES:-- (not listed)}"

echo "== ${TAG} (after ${LATEST}) on origin/main ${TARGET:0:7}: $(git log -1 --format=%s "${TARGET}")"
printf '%s\n' "${NOTES}" | sed 's/^/   /'
if [[ "${DRY_RUN}" == 1 ]]; then
  echo "== DRY_RUN: nothing published"
  exit 0
fi
if [[ "${YES:-}" != 1 ]]; then
  [[ -t 0 ]] || fail "not a terminal: set YES=1 to publish without the prompt"
  printf 'Publish %s? Every laptop will be offered it. [y/N] ' "${TAG}"
  read -r answer
  case "${answer}" in y|Y|yes|YES) ;; *) fail "not published" ;; esac
fi

printf '%s\n' "${NOTES}" | gh release create "${TAG}" --repo "${REPO}" --target "${TARGET}" \
  --title "kernal ${NEXT}" --notes-file -
echo "== published ${TAG}: the release workflow builds the bundles (gh run list --repo ${REPO} --workflow release.yml)"
