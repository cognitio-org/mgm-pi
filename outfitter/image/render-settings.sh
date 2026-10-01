#!/usr/bin/env bash
# Renders a build-time kernal/.pi/settings.json with TUI/laptop-only packages removed, so the cloud
# sandbox image doesn't ship pi-listen (voice, needs a mic), pi-powerline-footer (renders into a
# terminal footer) or pi-lsp (editor-integration LSP, no editor in the sandbox). Same technique as
# kernal/scripts/package.sh's BUNDLE_EXCLUDE: filter the real settings.json's `packages` array by
# name, from the real file, so this can't drift from kernal/.pi/settings.json (the source of truth for
# a laptop install) the way a hand-maintained second settings.json would.
#
# It also adds `subagents.agentExcludeDirs` (E9 PR8, spec §8): pi-subagents ranks a repo's own
# `.pi/agents/*.md` and `.agents/*.md` above its builtin and user agents, so a cloned repo could
# redefine `worker` (or the image's `coder`) with other tools or another prompt. The repo is cloned at
# /workspace, so pruning that tree from agent discovery drops its agent *files*; /home/agent/.agents
# (the agent user's ~/.agents, writable by anything the model runs) goes too. This file is
# pi-subagents' *user* settings in the image (PI_CODING_AGENT_DIR=/opt/kernal/.pi), and user and
# project exclusions are combined, so a repo can add exclusions but not remove these.
# Not covered: the repo's `.pi/settings.json` is still read as project settings (`agentOverrides`,
# which reaches `coder` too, `disableBuiltins`, `defaultModel`, `defaultExtensions`, and
# `agentScanDirs`/`packages` pointing outside /workspace), and so is `package.json` `pi.subagents`,
# whose agents rank above builtins. That is why tapes reachable over A2A get no `subagent` tool at all
# (EPIC.md E9.8).
#
# Usage: render-settings.sh <src settings.json> <dest settings.json> [comma,exclude,list]
# SUBAGENT_EXCLUDE_DIRS (comma list, default /workspace,/home/agent/.agents) overrides the pruned
# trees; tests use it.
set -euo pipefail
SRC="${1:?source settings.json}"
DEST="${2:?dest settings.json}"
# open-codebase-index is excluded too: its embeddings point at LM Studio on the laptop (see
# kernal/README.md), so in a cloud sandbox it is 140 MB of dead weight, and its native addon does not
# load on arm64 builds.
EXCLUDE="${3:-pi-listen,pi-powerline-footer,pi-lsp,open-codebase-index}"
AGENT_EXCLUDE="${SUBAGENT_EXCLUDE_DIRS:-/workspace,/home/agent/.agents}"

node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const ex = process.argv[2].split(",").filter(Boolean);
  s.packages = (s.packages || []).filter((p) => !ex.some((e) => p === "npm:" + e || p.endsWith("/" + e)));
  const agentEx = process.argv[4].split(",").map((d) => d.trim()).filter(Boolean);
  if (agentEx.length) s.subagents = { ...(s.subagents || {}), agentExcludeDirs: agentEx };
  fs.writeFileSync(process.argv[3], JSON.stringify(s, null, 2) + "\n");
' "$SRC" "$EXCLUDE" "$DEST" "$AGENT_EXCLUDE"

echo "render-settings: image settings.json excludes: ${EXCLUDE:-none}; subagent definitions ignored under: ${AGENT_EXCLUDE:-none}"
