#!/usr/bin/env bash
# Deletes per-platform packages/binaries for every platform other than this build's own -- same
# trick scripts/package.sh uses for a laptop bundle, generalized: npm packages that ship native
# code for multiple OS/CPU targets do it two ways, and both show up heavily here:
#   1. a package per platform (npm's optionalDependencies convention -- @esbuild/linux-x64,
#      @napi-rs/foo-darwin-arm64-gnu, sherpa-onnx-linux-arm64, ...): the whole directory is
#      platform-specific, whatever is inside it (a raw ELF/Mach-O binary, not necessarily a
#      .node/.so/.dylib file -- esbuild's platform packages are exactly this and are NOT caught by
#      extension matching alone).
#   2. a single package with one binary per platform inside it (a `.node` addon, occasionally
#      `.dylib`/`.so`): matched by filename instead.
# `npm ci` in this build environment was observed installing every platform's optional dependency
# regardless of the package-lock.json's os/cpu fields (see docs/reports/image-trim.md) -- e.g. one
# esbuild install pulled in binaries for all ~26 platforms it publishes, ~285 MB for a package that
# only ever runs one of them. Whatever the cause, this script's job is the same either way: only
# this build's own platform should survive.
#
# Usage: strip-native-binaries.sh <node_modules dir> <dpkg arch: amd64|arm64>
set -euo pipefail
DIR="${1:?node_modules dir}"
ARCH="${2:?amd64 or arm64}"

case "$ARCH" in
  amd64) arch_re='x64|x86_64' ;;
  arm64) arch_re='arm64|aarch64' ;;
  *) echo "strip-native-binaries: unsupported arch '$ARCH' (want amd64 or arm64)" >&2; exit 1 ;;
esac
# A directory or filename that names ANY platform (os+arch, either order, with an optional libc
# suffix like -gnu/-musl/-msvc).
platform_re='(^|[-_.])(darwin|linux|win32|windows|android|freebsd|netbsd|openbsd|sunos|aix|openharmony)[-_](x64|x86_64|arm64|aarch64|arm|ia32|x86|mips64el|mips64|ppc64le|ppc64|riscv64|s390x|loong64|universal)([-_](gnu|musl|musleabihf|gnueabihf|msvc))?($|[-_.])'
platform_re_rev='(^|[-_.])(x64|x86_64|arm64|aarch64)[-_](darwin|linux|win32|apple|android)($|[-_.])'
# This build's own platform, linux only (this image only ever runs on Linux). platform_re_rev above
# also matches the reversed "x64-linux" order (a form some packages use, e.g. napi-rs's
# arch-then-os convention), so keep_re must recognize both orders too -- otherwise a package that
# names itself in the reversed order gets matched as "some platform" by platform_re_rev, fails to
# match the forward-only keep_re, and is deleted even though it is this build's own platform.
keep_re="(^|[-_.])linux[-_](${arch_re})([-_](gnu|musl))?(\$|[-_.])"
keep_re_rev="(^|[-_.])(${arch_re})[-_]linux(\$|[-_.])"

if [[ ! -d "$DIR" ]]; then
  echo "strip-native-binaries: $DIR does not exist, nothing to do"
  exit 0
fi

before=$(du -sh "$DIR" 2>/dev/null | cut -f1)
removed=0

# Pass 1: whole per-platform package directories (covers both conventions above; deleting the
# directory also removes any binary a Pass 2 file-extension scan would otherwise have to find).
while IFS= read -r d; do
  base=$(basename "$d")
  if [[ "$base" =~ $platform_re || "$base" =~ $platform_re_rev ]] && [[ ! "$base" =~ $keep_re ]] && [[ ! "$base" =~ $keep_re_rev ]]; then
    rm -rf "$d"
    removed=$((removed + 1))
  fi
done < <(find "$DIR" -mindepth 1 -type d | sort -r)

# Pass 2: stray platform-tagged binary files not already caught by directory removal above.
while IFS= read -r f; do
  base=$(basename "$f")
  if [[ "$base" =~ $platform_re || "$base" =~ $platform_re_rev ]] && [[ ! "$base" =~ $keep_re ]] && [[ ! "$base" =~ $keep_re_rev ]]; then
    rm -f "$f"
    removed=$((removed + 1))
  fi
done < <(find "$DIR" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" \) 2>/dev/null)

after=$(du -sh "$DIR" 2>/dev/null | cut -f1)
echo "strip-native-binaries: $DIR $before -> $after (kept linux/$ARCH, removed $removed paths)"
