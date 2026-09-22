#!/usr/bin/env bash
# Pre-compiles every pi extension the sandbox loads, at image build time, so a woken sandbox does not
# pay for it on every start (docs/reports/startup-trim.md).
#
# pi loads extensions (kernal's .ts ones and the packages', TypeScript or ESM) through jiti, which
# transforms each module with Babel and keeps the result in a file cache under $TMPDIR/jiti (os
# tmpdir; /tmp/jiti in the image). A fresh Cloud Run container starts with that cache empty, so every
# wake re-transformed ~100 modules before pi could answer -- the largest single item in pi's start-up.
# jiti keys each cache entry on the module's absolute path and a hash of its source, so running pi
# once here, as the same user and from the same paths the sandbox uses, leaves a cache every later
# start hits. It is safe by construction: an edited or moved file simply misses and is re-compiled.
#
# pi starts in RPC mode with no session, answers one get_state and exits when stdin closes. Anything
# the start-up adds to the agent dir (mcp-cache.json, auth.json, models-store.json, ...) or to $HOME
# is removed again so no per-run state is baked into the image; only the compile cache stays.
#
# Usage (as the user pi runs as, with PI_CODING_AGENT_DIR set):
#   prewarm-extensions.sh <pi bin> [extra pi args, e.g. --extension <path> ...]
set -euo pipefail
PI="${1:?pi binary}"; shift
AGENT_DIR="${PI_CODING_AGENT_DIR:?PI_CODING_AGENT_DIR must be set}"
CACHE="${TMPDIR:-/tmp}/jiti"

work=$(mktemp -d)
# Top-level entries of the agent dir and $HOME before pi runs; anything pi adds is removed after.
agent_before=$(ls -A "$AGENT_DIR")
home_before=$(ls -A "$HOME")
remove_new() {   # remove_new <dir> <listing before>
  local entry
  for entry in $(ls -A "$1"); do
    grep -qxF "$entry" <<<"$2" || rm -rf "${1:?}/$entry"
  done
}
cleanup() {
  rm -rf "$work"
  remove_new "$AGENT_DIR" "$agent_before"
  remove_new "$HOME" "$home_before"
}
trap cleanup EXIT

# No LiteLLM key and no network discovery: only module loading is wanted here, not a working model.
printf '{"id":"prewarm","type":"get_state"}\n' \
  | (cd "$work" && env -u LITELLM_AGENT_KEY -u LITELLM_API_KEY KERNAL_NO_DISCOVERY=1 \
       timeout 180 "$PI" --mode rpc --no-session "$@") > "$work/out.jsonl" 2> "$work/err.log" || true

if ! grep -q '"id":"prewarm"' "$work/out.jsonl"; then
  echo "prewarm-extensions: pi never answered; stderr follows" >&2
  cat "$work/err.log" >&2
  exit 1
fi
count=$(find "$CACHE" -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" -eq 0 ]; then
  echo "prewarm-extensions: no jiti cache written under $CACHE" >&2
  exit 1
fi
echo "prewarm-extensions: $count compiled modules cached in $CACHE ($(du -sh "$CACHE" | cut -f1))"
