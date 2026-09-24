#!/usr/bin/env bash
# No backticks inside an unquoted heredoc in any deploy script. An unquoted delimiter (<<YAML, not
# <<'YAML') makes bash run every `...` in the body as a command substitution -- including ones in
# YAML comments. PR #130 round 2 found `patch` in a ci-setup.sh Role comment: it ran /usr/bin/patch
# reading the operator's terminal, and ci-setup.sh hung. shellcheck at CI's -S warning filters the
# relevant check (SC2006), so this test is the guard.
#   bash outfitter/deploy/test/heredoc-backticks.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fails=0
checked=0
for script in "${HERE}"/../*.sh; do
  # Print "file:line: text" for each body line of an unquoted heredoc that contains a backtick.
  # An unquoted opener is <<WORD or <<-WORD with no quote before WORD; the body ends at a line that
  # is exactly WORD (optionally tab-indented, for <<-).
  hits="$(awk -v f="$(basename "${script}")" '
    !in_doc && match($0, /<<-?[A-Za-z_][A-Za-z0-9_]*/) {
      word = substr($0, RSTART, RLENGTH); sub(/^<<-?/, "", word)
      in_doc = 1; next
    }
    in_doc {
      line = $0; sub(/^\t+/, "", line)
      if (line == word) { in_doc = 0; next }
      if (index($0, "`")) printf "%s:%d: %s\n", f, NR, $0
    }
  ' "${script}")"
  checked=$((checked + 1))
  if [[ -n "${hits}" ]]; then
    echo "FAIL: backticks inside an unquoted heredoc (bash runs them):"
    echo "${hits}" | sed 's/^/    /'
    fails=$((fails + 1))
  fi
done

# The check itself must catch the bug it exists for.
probe="$(mktemp)"
trap 'rm -f "${probe}"' EXIT
printf 'cat <<YAML\n  # `patch` here would run\nYAML\n' >"${probe}"
if awk '!d && /<<-?[A-Za-z_]/{d=1; next} d && $0=="YAML"{d=0; next} d && index($0,"`"){found=1} END{exit !found}' "${probe}"; then
  echo "ok: the check detects a backtick in an unquoted heredoc"
else
  echo "FAIL: the check misses a backtick in an unquoted heredoc"; fails=$((fails + 1))
fi

if (( fails == 0 )); then
  echo "ok: no backticks in unquoted heredocs across ${checked} deploy scripts"
  echo "0 failed"
else
  echo "${fails} failed"; exit 1
fi
