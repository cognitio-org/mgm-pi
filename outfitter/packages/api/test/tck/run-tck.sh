#!/usr/bin/env bash
# E9 PR6: runs the A2A TCK against the scripted test build (sut.ts) and decides the run with
# check_results.py against known-defects.txt.
#
#   TCK_DIR=/path/to/a2a-tck test/tck/run-tck.sh [must|should|may]
#
# TCK_DIR is a checkout of github.com/a2aproject/a2a-tck at TCK_COMMIT with its dependencies
# installed (`uv sync --frozen`, or any venv; PYTHON defaults to $TCK_DIR/.venv/bin/python).
# "must" fails on any MUST failure that isn't a known TCK defect; "should" and "may" only report.
# The A2A key is written to a private temp file and passed to the TCK through the environment,
# never printed.
set -euo pipefail

TCK_COMMIT="263b9cf"
LEVEL="${1:-must}"
HERE="$(cd "$(dirname "$0")" && pwd)"
API="$(cd "$HERE/../.." && pwd)"
TCK_DIR="${TCK_DIR:?set TCK_DIR to an a2a-tck checkout at ${TCK_COMMIT}}"
PYTHON="${PYTHON:-$TCK_DIR/.venv/bin/python}"
PORT="${PORT:-9797}"

have="$(git -C "$TCK_DIR" rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
[ "$have" = "$TCK_COMMIT" ] || echo "warning: $TCK_DIR is at $have, known-defects.txt is for $TCK_COMMIT" >&2

work="$(mktemp -d)"
key_file="$work/key"
sut_pid=""
cleanup() {
  if [ -n "$sut_pid" ]; then kill "$sut_pid" 2>/dev/null || true; wait "$sut_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/.well-known/agent-card.json" 2>/dev/null; then
  echo "something already listens on port $PORT" >&2
  exit 1
fi
(cd "$API" && PORT="$PORT" KEY_FILE="$key_file" exec node test/tck/sut.ts >"$work/sut.log" 2>&1) &
sut_pid=$!
for _ in $(seq 1 60); do
  if [ -s "$key_file" ] && curl -fsS -o /dev/null "http://127.0.0.1:$PORT/.well-known/agent-card.json" 2>/dev/null; then break; fi
  if ! kill -0 "$sut_pid" 2>/dev/null; then cat "$work/sut.log"; echo "the TCK SUT exited" >&2; exit 1; fi
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/.well-known/agent-card.json" || { cat "$work/sut.log"; echo "the TCK SUT did not come up" >&2; exit 1; }

rm -f "$TCK_DIR/reports/junitreport.xml"
set +e
(
  cd "$TCK_DIR" &&
    TCK_AUTH="Bearer $(cat "$key_file")" PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}" \
      "$PYTHON" run_tck.py --sut-host "http://localhost:$PORT" --transport jsonrpc --level "$LEVEL" -- -p tck_auth_plugin -rs
)
tck_status=$?
set -e
echo "run_tck.py exited $tck_status" >&2

if [ ! -f "$TCK_DIR/reports/junitreport.xml" ]; then
  tail -n 50 "$work/sut.log" >&2
  echo "no JUnit report: the TCK did not run" >&2
  exit 1
fi
cp "$TCK_DIR/reports/junitreport.xml" "$TCK_DIR/reports/junit-$LEVEL.xml"
if [ "$LEVEL" = "must" ]; then
  python3 "$HERE/check_results.py" "$TCK_DIR/reports/junitreport.xml" "$HERE/known-defects.txt"
else
  python3 "$HERE/check_results.py" "$TCK_DIR/reports/junitreport.xml" "$HERE/known-defects.txt" --report-only
fi
