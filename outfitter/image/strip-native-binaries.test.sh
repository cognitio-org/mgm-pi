#!/usr/bin/env bash
# Tiny smoke test for strip-native-binaries.sh: builds a temp node_modules with forward-order
# ("linux-x64"), reversed-order ("x64-linux") and foreign-platform ("darwin-arm64") package
# directories, runs the script against it, and asserts what survives. Regression test for the bug
# where keep_re only recognized the forward order and so deleted a build's own platform whenever it
# was named in the reversed order (see the Dockerfile comment near strip-native-binaries.sh usage
# and image-trim.md section 8).
#
# Usage: bash strip-native-binaries.test.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

modules="$tmp/node_modules"
mkdir -p \
  "$modules/@napi-rs/foo-linux-x64-gnu" \
  "$modules/@napi-rs/foo-x64-linux-gnu" \
  "$modules/@napi-rs/foo-darwin-arm64" \
  "$modules/@napi-rs/foo-win32-x64-msvc" \
  "$modules/some-package"
touch \
  "$modules/@napi-rs/foo-linux-x64-gnu/index.node" \
  "$modules/@napi-rs/foo-x64-linux-gnu/index.node" \
  "$modules/@napi-rs/foo-darwin-arm64/index.node" \
  "$modules/@napi-rs/foo-win32-x64-msvc/index.node" \
  "$modules/some-package/index.js"

bash ./strip-native-binaries.sh "$modules" amd64 >/dev/null

fail=0
assert_kept() {
  if [[ ! -d "$1" ]]; then echo "FAIL: expected kept, but removed: $1" >&2; fail=1; fi
}
assert_removed() {
  if [[ -d "$1" ]]; then echo "FAIL: expected removed, but kept: $1" >&2; fail=1; fi
}

# Forward order ("linux-x64"): this build's own platform -- must survive.
assert_kept "$modules/@napi-rs/foo-linux-x64-gnu"
# Reversed order ("x64-linux"): also this build's own platform -- must survive (the bug this test
# guards against: keep_re alone would not match this, and it would be deleted).
assert_kept "$modules/@napi-rs/foo-x64-linux-gnu"
# Foreign platforms: must be removed either way.
assert_removed "$modules/@napi-rs/foo-darwin-arm64"
assert_removed "$modules/@napi-rs/foo-win32-x64-msvc"
# Platform-agnostic package: untouched.
assert_kept "$modules/some-package"

if [[ "$fail" -eq 0 ]]; then
  echo "strip-native-binaries.test.sh: PASS"
else
  exit 1
fi
