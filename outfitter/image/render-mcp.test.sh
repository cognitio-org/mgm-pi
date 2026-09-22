#!/usr/bin/env bash
# Smoke test for render-mcp.sh: OAuth servers are dropped, header-keyed servers and every other
# top-level field are kept verbatim.
#
# Usage: bash render-mcp.test.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/src.json" <<'JSON'
{
  "settings": { "toolPrefix": "short" },
  "mcpServers": {
    "litellm": { "url": "https://litellm.example/mcp/", "headers": { "x-litellm-api-key": "Bearer ${LITELLM_AGENT_KEY}" } },
    "google_admin": { "url": "https://g.example/mcp", "auth": "oauth", "oauth": { "clientName": "kernal agent" } },
    "augment_admin": { "url": "https://a.example/mcp", "auth": "oauth", "directTools": false },
    "local_cmd": { "command": "node", "args": ["server.js"] }
  }
}
JSON

bash ./render-mcp.sh "$tmp/src.json" "$tmp/dest.json" >/dev/null

node -e '
  const assert = require("assert");
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  assert.deepStrictEqual(Object.keys(c.mcpServers).sort(), ["litellm", "local_cmd"]);
  assert.strictEqual(c.mcpServers.litellm.headers["x-litellm-api-key"], "Bearer ${LITELLM_AGENT_KEY}", "env placeholder kept literally");
  assert.deepStrictEqual(c.settings, { toolPrefix: "short" });
' "$tmp/dest.json"

# The real kernal/.pi/mcp.json: every OAuth server goes, litellm stays.
bash ./render-mcp.sh ../../kernal/.pi/mcp.json "$tmp/real.json" >/dev/null
node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const bad = Object.entries(c.mcpServers).filter(([, d]) => d.auth === "oauth").map(([n]) => n);
  if (bad.length) { console.error("OAuth servers left in: " + bad); process.exit(1); }
  if (!c.mcpServers.litellm) { console.error("litellm MCP server was dropped"); process.exit(1); }
' "$tmp/real.json"

echo "render-mcp.test.sh: ok"
