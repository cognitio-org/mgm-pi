#!/usr/bin/env bash
# Build a self-contained mgm bundle for one platform:
#   scripts/package.sh <version> <platform>     platform = darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64
# Output: dist/mgm-<version>-<platform>.tar.gz (+ .sha256). Needs: node, npm, curl, tar, shasum/sha256sum.
# The bundle = pi's official standalone binary for the pinned pi version + this repo's .pi config
# (extensions, settings, mcp.json) + the extension packages installed from .pi/npm's lockfile + the
# launcher. Users need no Node; they copy .env.example to .env and run bin/mgm.
set -euo pipefail
VERSION="${1:?version (e.g. 0.1.0)}"; PLATFORM="${2:?platform}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_VERSION=$(node -p "require('$ROOT/package.json').dependencies['@earendil-works/pi-coding-agent'].replace(/^[^0-9]*/, '')")
NAME="mgm-$VERSION-$PLATFORM"; STAGE="$ROOT/dist/$NAME"; OUT="$ROOT/dist/$NAME.tar.gz"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

echo "== mgm $VERSION for $PLATFORM on pi $PI_VERSION"
rm -rf "$STAGE" "$OUT" "$OUT.sha256"; mkdir -p "$STAGE" "$ROOT/dist"

# 1. pi's official binary (+ its assets), checksum-verified
PI_TGZ="$ROOT/dist/pi-$PI_VERSION-$PLATFORM.tar.gz"
if [[ ! -f "$PI_TGZ" ]]; then
  curl -fsSL -o "$PI_TGZ" "https://github.com/earendil-works/pi/releases/download/v$PI_VERSION/pi-$PLATFORM.tar.gz"
  curl -fsSL -o "$ROOT/dist/pi-$PI_VERSION-SHA256SUMS" "https://github.com/earendil-works/pi/releases/download/v$PI_VERSION/SHA256SUMS"
  expected=$(grep "pi-$PLATFORM.tar.gz" "$ROOT/dist/pi-$PI_VERSION-SHA256SUMS" | awk '{print $1}')
  actual=$(sha "$PI_TGZ" | awk '{print $1}')
  [[ "$expected" == "$actual" ]] || { echo "pi tarball checksum mismatch" >&2; exit 1; }
fi
tar xzf "$PI_TGZ" -C "$STAGE"          # → $STAGE/pi/pi + assets
[[ -x "$STAGE/pi/pi" ]] || { echo "pi binary missing after extract" >&2; exit 1; }

# 2. mgm config, extensions, docs, launcher
mkdir -p "$STAGE/.pi/npm" "$STAGE/bin"
cp -R "$ROOT/.pi/extensions" "$STAGE/.pi/"
cp "$ROOT/.pi/mcp.json" "$STAGE/.pi/"
# open-codebase-index cannot load under pi's Bun-compiled binary (its single-file extension trips a
# NameTooLong in the binary's module loader; reproduced on pi 0.85.1 and 0.86.1). Bundles ship
# without it; source installs (npm pi under Node) keep it. Everything else loads as under Node.
BUNDLE_EXCLUDE="${BUNDLE_EXCLUDE:-open-codebase-index}"
node -e '
  const fs = require("fs"); const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const ex = process.argv[2].split(",").filter(Boolean);
  s.packages = (s.packages || []).filter((p) => !ex.some((e) => p === "npm:" + e || p.endsWith("/" + e)));
  fs.writeFileSync(process.argv[3], JSON.stringify(s, null, 2) + "\n");
' "$ROOT/.pi/settings.json" "$BUNDLE_EXCLUDE" "$STAGE/.pi/settings.json"
cp "$ROOT/.pi/npm/package.json" "$ROOT/.pi/npm/package-lock.json" "$STAGE/.pi/npm/"
cp "$ROOT/bin/mgm" "$STAGE/bin/mgm"; chmod +x "$STAGE/bin/mgm"
cp "$ROOT/README.md" "$STAGE/"; cp -R "$ROOT/docs" "$STAGE/docs"
cp "$ROOT/../.env.example" "$STAGE/.env.example" 2>/dev/null || cp "$ROOT/.env.example" "$STAGE/.env.example"
mkdir -p "$STAGE/.codebase-index"; cp "$ROOT/.codebase-index/config.json" "$STAGE/.codebase-index/config.json"
echo "$VERSION" > "$STAGE/VERSION"; echo "pi $PI_VERSION" >> "$STAGE/VERSION"

# 3. extension packages, exactly as locked. --legacy-peer-deps: the packages peer-depend on pi's own
#    packages, which the pi binary provides at runtime (no copy needed). Then drop native binaries
#    built for other platforms (open-codebase-index ships all six in one package, ~250 MB).
(cd "$STAGE/.pi/npm" && npm ci --legacy-peer-deps --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
case "$PLATFORM" in
  darwin-arm64) keep='darwin[-_]arm64|arm64[-_]darwin|aarch64[-_]apple' ;;
  darwin-x64)   keep='darwin[-_]x64|x64[-_]darwin|x86_64[-_]apple' ;;
  linux-x64)    keep='linux[-_]x64|x64[-_]linux|x86_64[-_]linux' ;;
  linux-arm64)  keep='linux[-_]arm64|arm64[-_]linux|aarch64[-_]linux' ;;
esac
while IFS= read -r f; do
  base=$(basename "$f")
  if [[ "$base" =~ (darwin|linux|win32|windows)[-_](x64|arm64|x86_64|aarch64)|(x64|arm64|x86_64|aarch64)[-_](darwin|linux|win32|apple) ]] && [[ ! "$base" =~ $keep ]]; then rm -f "$f"; fi
done < <(find "$STAGE/.pi/npm/node_modules" \( -name "*.node" -o -name "*.dylib" -o -name "*.so" \))
for e in ${BUNDLE_EXCLUDE//,/ }; do rm -rf "$STAGE/.pi/npm/node_modules/$e"; done
echo "packages: $(du -sh "$STAGE/.pi/npm/node_modules" | cut -f1) (excluded: ${BUNDLE_EXCLUDE:-none})"

# 4. smoke test the bundle offline: the pi binary must load our extensions and list our providers
if [[ "$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')" == "$PLATFORM" ]]; then
  SMOKE_HOME=$(mktemp -d)   # never the stage: macOS writes Library/ etc. into $HOME
  ( cd "$STAGE" && printf 'LITELLM_AGENT_KEY=test\nOPENROUTER_API_KEY=test\n' > .env \
    && MGM_NO_DISCOVERY=1 MGM_SKIP_LMS=1 HOME="$SMOKE_HOME" ./bin/mgm --list-models > "$ROOT/dist/$NAME.smoke.txt" 2>&1 \
    && grep -qE "^lmstudio" "$ROOT/dist/$NAME.smoke.txt" && grep -qE "^litellm" "$ROOT/dist/$NAME.smoke.txt" \
    && { MGM_NO_DISCOVERY=1 MGM_SKIP_LMS=1 HOME="$SMOKE_HOME" LMSTUDIO_BASE_URL=http://127.0.0.1:9/v1 timeout 25 ./bin/mgm -p --no-session --model lmstudio/qwen/qwen3.6-35b-a3b "x" >> "$ROOT/dist/$NAME.smoke.txt" 2>&1 || true; } \
    && ! grep -q "Failed to load extension" "$ROOT/dist/$NAME.smoke.txt" \
    && rm -f .env && echo "smoke ok: $(grep -cE '^(lmstudio|litellm|openrouter)' "$ROOT/dist/$NAME.smoke.txt") models listed" ) \
    || { echo "smoke test failed:"; tail -20 "$ROOT/dist/$NAME.smoke.txt"; exit 1; }
else
  echo "(cross-platform build: smoke test skipped)"
fi
rm -rf "${SMOKE_HOME:-/nonexistent}" "$STAGE/Library" "$STAGE/.pi/sessions" "$STAGE/.pi/trust.json" "$STAGE/.pi/auth.json" "$STAGE/.pi/models-store.json" "$STAGE/.pi/mcp-cache.json"

# 5. archive + checksum
tar czf "$OUT" -C "$ROOT/dist" "$NAME"
(cd "$ROOT/dist" && sha "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
