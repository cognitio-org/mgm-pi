#!/usr/bin/env bash
# No single quote inside an `sh -c '...'` body in any workflow. Those bodies are single-quoted, so an
# apostrophe anywhere in them -- a comment included -- ends the string, and the runner fails with a
# syntax error (or worse, splits the script silently). E9 PR8 hit this twice ("repo's", "image's").
# A body starts on a line ending in `-c '` and ends at a line holding only `'`.
#   bash outfitter/deploy/test/workflow-sh-quotes.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOWS="${HERE}/../../../.github/workflows"

scan() {
  awk -v f="$1" '
    !body && /-c '"'"'[[:space:]]*$/ { body = 1; next }
    body && /^[[:space:]]*'"'"'[[:space:]]*$/ { body = 0; next }
    body && index($0, "'"'"'") { printf "%s:%d: %s\n", f, NR, $0 }
  ' "$2"
}

fails=0
checked=0
for wf in "${WORKFLOWS}"/*.yml; do
  hits="$(scan "$(basename "${wf}")" "${wf}")"
  checked=$((checked + 1))
  if [[ -n "${hits}" ]]; then
    echo "FAIL: a single quote inside an sh -c '...' body (it ends the string):"
    echo "${hits}" | sed 's/^/    /'
    fails=$((fails + 1))
  fi
done

# The check itself must catch the bug it exists for, and pass a clean body.
probe="$(mktemp)"
trap 'rm -f "${probe}"' EXIT
printf "        run: |\n          docker run img sh -c '\n            # the image's agent\n            true\n          '\n" >"${probe}"
[[ -n "$(scan probe "${probe}")" ]] || { echo "FAIL: the check missed a quote in a probe body"; fails=$((fails + 1)); }
printf "        run: |\n          docker run img sh -c '\n            # the agent in the image\n            true\n          '\n" >"${probe}"
[[ -z "$(scan probe "${probe}")" ]] || { echo "FAIL: the check flagged a clean probe body"; fails=$((fails + 1)); }

if [[ "${checked}" -eq 0 ]]; then echo "FAIL: no workflows found under ${WORKFLOWS}"; exit 1; fi
if [[ "${fails}" -gt 0 ]]; then exit 1; fi
echo "ok: ${checked} workflows, no single quote inside an sh -c body"
