#!/usr/bin/env bash
# Renders the cloud sandbox image's MCP config from kernal/.pi/mcp.json with every server that
# authenticates by interactive OAuth ("auth": "oauth") removed. In a sandbox nobody can complete a
# browser sign-in and there is no OS keychain to keep a token in, so pi-mcp-adapter's attempt to
# reach those servers (google_admin, augment_admin) failed on every start after two network probes
# -- and the adapter holds the first prompt until its start-up connections settle
# (docs/reports/startup-trim.md). Servers that authenticate with a header (litellm, keyed by the
# run's own LITELLM_AGENT_KEY) are kept. Same technique as render-settings.sh: filtered from the real
# file at build time, so the laptop install is untouched and the two cannot drift apart.
#
# Usage: render-mcp.sh <src mcp.json> <dest mcp.json>
set -euo pipefail
SRC="${1:?source mcp.json}"
DEST="${2:?dest mcp.json}"

node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const dropped = [];
  for (const [name, def] of Object.entries(c.mcpServers || {})) {
    if (def && def.auth === "oauth") { delete c.mcpServers[name]; dropped.push(name); }
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(c, null, 2) + "\n");
  console.log("render-mcp: image mcp.json drops OAuth servers: " + (dropped.join(",") || "none"));
' "$SRC" "$DEST"
