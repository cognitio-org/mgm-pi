#!/usr/bin/env bash
# Pre-bundle pi packages that pi's compiled binary cannot load as extensions.
#   scripts/prebundle.sh <node_modules dir>        # default: .pi/npm/node_modules
#   PREBUNDLE=a,b scripts/prebundle.sh <dir>       # which packages (default: open-codebase-index)
#
# pi loads a package extension through jiti, which hands the runtime a data: URL of the transpiled
# source; open-codebase-index's 1 MB entry trips Bun's NameTooLong. Requiring the package's own
# CommonJS build fails too: its dependencies are ESM-only and Bun cannot require(esm). esbuild
# inlines every dependency into one CommonJS file that require() loads straight from disk.
# Details that matter: `import.meta.url` must be shimmed (the package calls createRequire with it);
# the native addon stays external and is found relative to the output, so the bundle is written into
# the package's own dist/; tiktoken reads its wasm from the calling file's directory, so it is
# copied alongside. .pi/extensions/kernal-codebase-index loads the result.
set -euo pipefail
NM="${1:-.pi/npm/node_modules}"
PREBUNDLE="${PREBUNDLE-open-codebase-index}"
ESBUILD="${ESBUILD_VERSION:-esbuild@0.25.0}"
for p in ${PREBUNDLE//,/ }; do
  src="$NM/$p/dist/pi-extension.js"
  if [[ ! -f "$src" ]]; then echo "prebundle: $p has no dist/pi-extension.js, skipped" >&2; continue; fi
  out="$NM/$p/dist/pi-extension.kernal.cjs"
  npx --yes "$ESBUILD" --bundle --platform=node --target=node22 --format=cjs "--external:*.node" \
    "--banner:js=const __kernal_import_meta_url = require('node:url').pathToFileURL(__filename).href;" \
    "--define:import.meta.url=__kernal_import_meta_url" \
    --outfile="$out" "$src" >/dev/null
  [[ -f "$NM/tiktoken/tiktoken_bg.wasm" ]] && cp "$NM/tiktoken/tiktoken_bg.wasm" "$NM/$p/dist/"
  echo "prebundled: $p ($(du -h "$out" | cut -f1))"
  # pi installs a package's skills only for packages it manages itself, and this one is loaded by
  # our own extension instead, so its skill (which tells the model to reach for the index before
  # grepping) has to be copied into the agent's skills directory by hand.
  agent="$(cd -P "$NM/../.." && pwd)"
  if [[ -d "$NM/$p/skills" ]]; then
    mkdir -p "$agent/skills"
    cp -R "$NM/$p/skills/." "$agent/skills/"
    echo "skills: $(ls "$NM/$p/skills" | tr '\n' ' ')→ $agent/skills"
  fi
done
