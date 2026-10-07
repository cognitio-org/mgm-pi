#!/usr/bin/env bash
# Apply a patch to installed packages exactly once, on BSD (macOS) and GNU (Linux CI) patch alike.
#
#   scripts/apply-adapter-patch.sh <node_modules dir> <patch file>
#
# Applies the patch when it applies forward cleanly; does nothing when the whole patch is already
# applied; otherwise (partly applied, or the package changed under it) fails, so a build never
# ships half a fix or none. Never uses --batch: GNU patch's --batch "assumes patches are reversed
# if they look like they are", which made a reverse dry run succeed on an unpatched tree and
# shipped kernal 0.3.9 without the patch. --forward refuses a reversed-looking patch on both
# implementations, and --force makes the reverse check take the patch as given.
set -euo pipefail
dir=${1:?node_modules dir}
patch_file=${2:?patch file}
if patch -d "$dir" -p1 --forward --dry-run --fuzz=0 -s < "$patch_file" >/dev/null 2>&1; then
  patch -d "$dir" -p1 --forward --fuzz=0 -s < "$patch_file"
  echo "applied $(basename "$patch_file")"
elif patch -d "$dir" -p1 -R --force --dry-run --fuzz=0 -s < "$patch_file" >/dev/null 2>&1; then
  echo "already applied: $(basename "$patch_file")"
else
  echo "error: $(basename "$patch_file") neither applies nor is fully applied in $dir" >&2
  exit 1
fi
