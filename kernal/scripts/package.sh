#!/usr/bin/env bash
# Build a self-contained kernal bundle for one platform:
#   scripts/package.sh <version> <platform>     platform = darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64
# Output: dist/kernal-<version>-<platform>.tar.gz (+ .sha256). Needs: node, npm, curl, tar, shasum/sha256sum.
# The bundle = pi's official standalone binary for the pinned pi version + this repo's .pi config
# (extensions, settings, mcp.json) + the extension packages installed from .pi/npm's lockfile + the
# launcher. Users need no Node; they copy .env.example to .env and run bin/kernal.
set -euo pipefail
VERSION="${1:?version (e.g. 0.1.0)}"; PLATFORM="${2:?platform}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_VERSION=$(node -p "require('$ROOT/package.json').dependencies['@earendil-works/pi-coding-agent'].replace(/^[^0-9]*/, '')")
NAME="kernal-$VERSION-$PLATFORM"; STAGE="$ROOT/dist/$NAME"; OUT="$ROOT/dist/$NAME.tar.gz"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

echo "== kernal $VERSION for $PLATFORM on pi $PI_VERSION"
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

# 2. kernal config, extensions, docs, launcher
mkdir -p "$STAGE/.pi/npm" "$STAGE/bin"
cp -R "$ROOT/.pi/extensions" "$STAGE/.pi/"
cp "$ROOT/.pi/mcp.json" "$STAGE/.pi/"
mkdir -p "$STAGE/.pi/agent"; cp "$ROOT/.pi/agent/lsp.json" "$STAGE/.pi/agent/"   # pi-lsp reads it via PI_AGENT_DIR
# Packages pi must not load as extensions. open-codebase-index used to live here: pi loads a package
# extension through jiti, which hands the Bun-compiled binary a data: URL of the transpiled 1 MB
# entry and trips NameTooLong. It now ships and is loaded by .pi/extensions/kernal-codebase-index,
# which requires the package's CommonJS build from disk instead. Set BUNDLE_EXCLUDE to drop others.
BUNDLE_EXCLUDE="${BUNDLE_EXCLUDE-}"
node -e '
  const fs = require("fs"); const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const ex = process.argv[2].split(",").filter(Boolean);
  s.packages = (s.packages || []).filter((p) => !ex.some((e) => p === "npm:" + e || p.endsWith("/" + e)));
  fs.writeFileSync(process.argv[3], JSON.stringify(s, null, 2) + "\n");
' "$ROOT/.pi/settings.json" "$BUNDLE_EXCLUDE" "$STAGE/.pi/settings.json"
# A pristine copy of what this release ships: the next upgrade compares the user's settings.json with
# it to tell the user's own changes from this release's defaults (install.sh, connect/settings.ts).
cp "$STAGE/.pi/settings.json" "$STAGE/.pi/settings.shipped.json"
cp "$ROOT/.pi/npm/package.json" "$ROOT/.pi/npm/package-lock.json" "$STAGE/.pi/npm/"
# kernal's vendored fork of pi-listen (#250), loaded from ./npm/vendor/pi-listen in settings.json.
cp -R "$ROOT/.pi/npm/vendor" "$STAGE/.pi/npm/vendor"
find "$STAGE/.pi/npm/vendor" \( -name node_modules -o -name .DS_Store -o -name .omc \) -prune -exec rm -rf {} +
# pi skips a missing local package silently, so a bundle without voice would pass the smoke test.
test -f "$STAGE/.pi/npm/vendor/pi-listen/extensions/voice.ts" || { echo "vendored pi-listen missing from the bundle" >&2; exit 1; }
cp "$ROOT"/bin/* "$STAGE/bin/"; chmod +x "$STAGE"/bin/*
cp "$ROOT/README.md" "$STAGE/"; cp -R "$ROOT/docs" "$STAGE/docs"
# Kernal's own skills (outfitter-admin, #290), loaded through settings.json's "skills": ["../skills"].
cp -R "$ROOT/skills" "$STAGE/skills"
cp "$ROOT/../.env.example" "$STAGE/.env.example" 2>/dev/null || cp "$ROOT/.env.example" "$STAGE/.env.example"
mkdir -p "$STAGE/.codebase-index"; cp "$ROOT/.codebase-index/config.json" "$STAGE/.codebase-index/config.json"
echo "$VERSION" > "$STAGE/VERSION"; echo "pi $PI_VERSION" >> "$STAGE/VERSION"
# bin/kernal runs some .ts entry points with node before pi starts (kernal login/logout/whoami).
# Node takes a .ts file's module type from the nearest package.json; without one here it
# climbs out of the install and can find e.g. ~/package.json with "type": "commonjs", which turns
# `import` into a SyntaxError (v0.3.0, `kernal login`). This file stops that walk, like kernal/'s own
# package.json does in a source checkout.
printf '{\n  "name": "kernal-bundle",\n  "private": true,\n  "type": "module"\n}\n' > "$STAGE/package.json"

# Chrome companion. install.sh copies these out of the bundle onto stable paths
# (~/.kernal/chrome). The versioned directory moves on every upgrade, so Chrome
# must not load the extension from inside the bundle.
CHROME_SRC="$ROOT/../chrome"
[[ -d "$CHROME_SRC/extension" && -d "$CHROME_SRC/host" && -f "$CHROME_SRC/extension-id" ]] \
  || { echo "chrome companion sources missing at $CHROME_SRC" >&2; exit 1; }
mkdir -p "$STAGE/chrome"
cp -R "$CHROME_SRC/extension" "$STAGE/chrome/extension"
cp -R "$CHROME_SRC/host" "$STAGE/chrome/host"
cp "$CHROME_SRC/extension-id" "$STAGE/chrome/extension-id"

# 3. extension packages, exactly as locked. --legacy-peer-deps: the packages peer-depend on pi's own
#    packages, which the pi binary provides at runtime (no copy needed). Then drop native binaries
#    built for other platforms (open-codebase-index ships all six in one package, ~250 MB).
(cd "$STAGE/.pi/npm" && npm ci --legacy-peer-deps --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
# pi-mcp-adapter 2.37.0 treats a stored refresh token as already signed in, so explicit
# /mcp-auth never opens the browser, and it reuses a client registered for an earlier callback
# port. npm ci replaces these files; reapply until the pin moves.
# apply-adapter-patch.sh applies it once, skips it when already applied, and fails on anything in
# between, so a build never ships half the fix or none of it.
"$ROOT/scripts/apply-adapter-patch.sh" "$STAGE/.pi/npm/node_modules" "$ROOT/scripts/patches/pi-mcp-adapter-force-reauth.patch"
# Verify the result, not the tool: 0.3.9 shipped unpatched because a guard misjudged the tree.
MCP_ADAPTER="$STAGE/.pi/npm/node_modules/pi-mcp-adapter"
grep -q 'skipStaleClient(): void' "$MCP_ADAPTER/mcp-oauth-provider.ts" \
  && grep -q 'authProvider.skipStaleClient()' "$MCP_ADAPTER/mcp-auth-flow.ts" \
  && grep -q 'forceReauthorization: true,' "$MCP_ADAPTER/commands.ts" \
  || { echo "package.sh: the staged pi-mcp-adapter is missing the re-auth patch" >&2; exit 1; }
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

# 4b. Pin every package to the exact version installed from the lockfile, in both the settings this
# bundle runs with and its pristine shipped copy. A bundle's packages are part of the release: they
# are what the release gate tested, and they change only with Kernal itself. pi skips pinned packages in
# its startup "Package Updates Available" check and in `pi update --extensions`, so a bundle stops
# telling users to run a command that is wrong for it. The repo's own settings stay unpinned, so a
# source checkout still reports new package versions to whoever maintains Kernal.
node -e '
  const fs = require("fs"), path = require("path");
  const [nm, ...files] = process.argv.slice(1);
  const nameOf = (spec) => { const at = spec.lastIndexOf("@"); return at > 0 ? spec.slice(0, at) : spec; };
  for (const file of files) {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    s.packages = (s.packages || []).map((p) => {
      if (typeof p !== "string" || !p.startsWith("npm:")) return p;
      const name = nameOf(p.slice(4));
      const manifest = path.join(nm, name, "package.json");
      if (!fs.existsSync(manifest)) return p;   // not installed here (excluded): leave it as configured
      return `npm:${name}@${JSON.parse(fs.readFileSync(manifest, "utf8")).version}`;
    });
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  }
' "$STAGE/.pi/npm/node_modules" "$STAGE/.pi/settings.json" "$STAGE/.pi/settings.shipped.json"
echo "pinned: $(node -p "require('$STAGE/.pi/settings.json').packages.filter(p => /@\d/.test(p)).length") packages to their installed versions"

# 4c. Packages pi cannot load inside its compiled binary are pre-bundled into one CommonJS file.
bash "$ROOT/scripts/prebundle.sh" "$STAGE/.pi/npm/node_modules"
echo "packages: $(du -sh "$STAGE/.pi/npm/node_modules" | cut -f1) (excluded: ${BUNDLE_EXCLUDE:-none})"

# with_timeout <seconds> <cmd...>: GNU timeout where there is one. The macOS build runner has none
# (v0.3.2's darwin build failed on "timeout: command not found"), so use perl's alarm there, which
# both runners ship.
with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"
  else perl -e 'alarm shift @ARGV; exec @ARGV or die "exec: $!\n"' "$secs" "$@"; fi
}
# 4. smoke test the bundle offline: the pi binary must load our extensions and list our providers.
# `kernal --teleport` (#426) must give its usage error without an id, and with an unknown id reach the
# teleport extension inside pi (a clean "no session" error), not fail to load a module.
if [[ "$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')" == "$PLATFORM" ]]; then
  SMOKE_HOME=$(mktemp -d)   # never the stage: macOS writes Library/ etc. into $HOME
  ( cd "$STAGE" && printf 'LITELLM_AGENT_KEY=test\nOPENROUTER_API_KEY=test\n' > .env \
    && KERNAL_NO_DISCOVERY=1 KERNAL_SKIP_LMS=1 HOME="$SMOKE_HOME" ./bin/kernal --list-models > "$ROOT/dist/$NAME.smoke.txt" 2>&1 \
    && grep -qE "^lmstudio" "$ROOT/dist/$NAME.smoke.txt" && grep -qE "^litellm" "$ROOT/dist/$NAME.smoke.txt" \
    && { KERNAL_NO_DISCOVERY=1 KERNAL_SKIP_LMS=1 HOME="$SMOKE_HOME" LMSTUDIO_BASE_URL=http://127.0.0.1:9/v1 with_timeout 25 ./bin/kernal -p --no-session --model lmstudio/qwen/qwen3.6-35b-a3b "x" >> "$ROOT/dist/$NAME.smoke.txt" 2>&1 || true; } \
    && ! grep -q "Failed to load extension" "$ROOT/dist/$NAME.smoke.txt" \
    && { HOME="$SMOKE_HOME" ./bin/kernal whoami >> "$ROOT/dist/$NAME.smoke.txt" 2>&1 || true; } \
    && grep -q "not signed in" "$ROOT/dist/$NAME.smoke.txt" \
    && { KERNAL_NO_DISCOVERY=1 KERNAL_SKIP_LMS=1 HOME="$SMOKE_HOME" ./bin/kernal --teleport > "$ROOT/dist/$NAME.teleport.txt" 2>&1 || true; } \
    && grep -q "Usage: kernal --teleport" "$ROOT/dist/$NAME.teleport.txt" \
    && { KERNAL_NO_DISCOVERY=1 KERNAL_SKIP_LMS=1 HOME="$SMOKE_HOME" KERNAL_TELEPORT_STORE="$SMOKE_HOME/teleport-store" LMSTUDIO_BASE_URL=http://127.0.0.1:9/v1 with_timeout 60 ./bin/kernal --teleport kernal-smoke-no-such-id -p --no-session --model lmstudio/qwen/qwen3.6-35b-a3b </dev/null >> "$ROOT/dist/$NAME.teleport.txt" 2>&1 || true; } \
    && grep -q 'no session "kernal-smoke-no-such-id" in the store' "$ROOT/dist/$NAME.teleport.txt" \
    && ! grep -qE "ERR_MODULE_NOT_FOUND|Cannot find (package|module)" "$ROOT/dist/$NAME.teleport.txt" \
    && cat "$ROOT/dist/$NAME.teleport.txt" >> "$ROOT/dist/$NAME.smoke.txt" && rm -f "$ROOT/dist/$NAME.teleport.txt" \
    && rm -f .env && echo "smoke ok: $(grep -cE '^(lmstudio|litellm|openrouter)' "$ROOT/dist/$NAME.smoke.txt") models listed" ) \
    || { echo "smoke test failed:"; tail -20 "$ROOT/dist/$NAME.smoke.txt"; tail -20 "$ROOT/dist/$NAME.teleport.txt" 2>/dev/null; exit 1; }
else
  echo "(cross-platform build: smoke test skipped)"
fi
# the smoke run may have written settings (pi records e.g. the changelog version); ship the pristine copy
cp "$STAGE/.pi/settings.shipped.json" "$STAGE/.pi/settings.json"
rm -rf "$STAGE/.pi/agents"
rm -rf "${SMOKE_HOME:-/nonexistent}" "$STAGE/Library" "$STAGE/.pi/sessions" "$STAGE/.pi/trust.json" "$STAGE/.pi/auth.json" "$STAGE/.pi/models-store.json" "$STAGE/.pi/mcp-cache.json" "$STAGE/.pi/agent/trust" "$STAGE/.pi/kernal-defaults-synced.json"

# 4b. shared keys shipped in the bundle's .env (private-repo distribution to family users).
#     DEEPGRAM_API_KEY: from the CI secret, or from ~/localllm/.env when building locally. /setup
#     merges into this file; install.sh keeps a user's existing .env and only adds missing keys.
if [[ -z "${DEEPGRAM_API_KEY:-}" && -f "$HOME/localllm/.env" ]]; then DEEPGRAM_API_KEY=$(grep '^DEEPGRAM_API_KEY=' "$HOME/localllm/.env" | cut -d= -f2- || true); fi
if [[ -n "${DEEPGRAM_API_KEY:-}" ]]; then
  printf '# Shared voice key (pi-listen Deepgram streaming); /setup adds the rest.\nDEEPGRAM_API_KEY=%s\n' "$DEEPGRAM_API_KEY" > "$STAGE/.env"
  echo "bundle .env: DEEPGRAM_API_KEY included"
else
  echo "bundle .env: no DEEPGRAM_API_KEY available; voice falls back to the local model"
fi

# 5. archive + checksum
tar czf "$OUT" -C "$ROOT/dist" "$NAME"
(cd "$ROOT/dist" && sha "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
