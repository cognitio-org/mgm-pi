#!/usr/bin/env bash
# Apply a patch to installed packages exactly once, on BSD (macOS) and GNU (Linux CI) patch alike.
#
#   scripts/apply-adapter-patch.sh <node_modules dir> <patch file>
#
# Does nothing when the whole patch is already applied; applies it when it applies forward cleanly;
# otherwise (partly applied, or the package changed under it) fails with patch's own output, so a
# build never ships half a fix or none. The "already applied" check runs first: a pure-insertion
# hunk can still apply forward on a patched tree, which would insert it twice.
#
# Never uses --batch: GNU patch's --batch "assumes patches are reversed if they look like they are",
# which made a reverse dry run succeed on an unpatched tree and shipped kernal 0.3.9 without the
# patch. --force takes the patch exactly as given (no reversal guessing, no questions on the tty).
set -euo pipefail
dir=${1:?node_modules dir}
patch_file=${2:?patch file}
name=$(basename "$patch_file")
if patch -d "$dir" -p1 -R --force --dry-run --fuzz=0 -s < "$patch_file" >/dev/null 2>&1; then
  echo "already applied: $name"
elif forward=$(patch -d "$dir" -p1 --force --dry-run --fuzz=0 < "$patch_file" 2>&1); then
  patch -d "$dir" -p1 --force --fuzz=0 -s < "$patch_file"
  echo "applied $name"
else
  echo "error: $name neither applies nor is fully applied in $dir:" >&2
  printf '%s\n' "$forward" >&2
  exit 1
fi
