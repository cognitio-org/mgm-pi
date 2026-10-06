#!/usr/bin/env bash
# Renders the cloud sandbox image's MCP config from kernal/.pi/mcp.json.
#
# A sandbox cannot open a browser or an OS keychain, and pi-mcp-adapter holds the first prompt
# until its start-up connections settle (docs/reports/startup-trim.md). A server whose only login
# is that browser flow (google_admin, augment_admin) is removed: it failed on every start after
# two network probes, and it can never succeed here.
#
# A gateway OAuth server is different. It already sends x-litellm-api-key, and LiteLLM vaults the
# upstream token under the calling key's user id. A Drive run key is that same person, so once
# they have signed in on a laptop the gateway attaches the token. The image keeps the server and
# turns client OAuth off (auth: false). Custom headers then authenticate the call, and a missing
# token is one failed connection instead of a browser login. The laptop file is not modified.
#
# Usage: render-mcp.sh <src mcp.json> <dest mcp.json>
set -euo pipefail
SRC="${1:?source mcp.json}"
DEST="${2:?dest mcp.json}"

node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const dropped = [];
  const kept = [];
  for (const [name, def] of Object.entries(c.mcpServers || {})) {
    if (!def || def.auth !== "oauth") continue;
    const header = def.headers && def.headers["x-litellm-api-key"];
    if (typeof header === "string" && header.length > 0) {
      def.auth = false;
      delete def.oauth;
      kept.push(name);
    } else {
      delete c.mcpServers[name];
      dropped.push(name);
    }
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(c, null, 2) + "\n");
  console.log("render-mcp: image mcp.json keeps gateway OAuth as header auth: " + (kept.join(",") || "none") + "; drops direct OAuth: " + (dropped.join(",") || "none"));
' "$SRC" "$DEST"
