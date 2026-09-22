#!/usr/bin/env bash
# Renders a build-time kernal/.pi/settings.json with TUI/laptop-only packages removed, so the cloud
# sandbox image doesn't ship pi-listen (voice, needs a mic), pi-powerline-footer (renders into a
# terminal footer) or pi-lsp (editor-integration LSP, no editor in the sandbox). Same technique as
# kernal/scripts/package.sh's BUNDLE_EXCLUDE: filter the real settings.json's `packages` array by
# name, from the real file, so this can't drift from kernal/.pi/settings.json (the source of truth for
# a laptop install) the way a hand-maintained second settings.json would.
#
# Usage: render-settings.sh <src settings.json> <dest settings.json> [comma,exclude,list]
set -euo pipefail
SRC="${1:?source settings.json}"
DEST="${2:?dest settings.json}"
# open-codebase-index is excluded too: its embeddings point at LM Studio on the laptop (see
# kernal/README.md), so in a cloud sandbox it is 140 MB of dead weight, and its native addon does not
# load on arm64 builds.
EXCLUDE="${3:-pi-listen,pi-powerline-footer,pi-lsp,open-codebase-index}"

node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const ex = process.argv[2].split(",").filter(Boolean);
  s.packages = (s.packages || []).filter((p) => !ex.some((e) => p === "npm:" + e || p.endsWith("/" + e)));
  fs.writeFileSync(process.argv[3], JSON.stringify(s, null, 2) + "\n");
' "$SRC" "$EXCLUDE" "$DEST"

echo "render-settings: image settings.json excludes: ${EXCLUDE:-none}"
