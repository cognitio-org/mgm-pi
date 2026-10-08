#!/usr/bin/env bash
# Smoke test for render-mcp.sh: direct OAuth servers are dropped. A gateway OAuth server, one that
# already sends x-litellm-api-key, stays with client OAuth turned off. Header-keyed servers and
# every other top-level field are kept verbatim.
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
    "sentry": { "url": "https://router.example/sentry/mcp", "auth": "oauth", "headers": { "x-litellm-api-key": "![ -n \"$KERNAL_ROUTER_KEY\" ] || exit 1; printf 'Bearer %s' \"$KERNAL_ROUTER_KEY\"" }, "oauth": { "clientName": "kernal" } },
    "gcloud": { "url": "https://router.example/gcloud/mcp", "auth": "oauth", "lifecycle": "lazy", "approveTools": true, "headers": { "x-litellm-api-key": "Bearer ${KERNAL_ROUTER_KEY}" }, "oauth": { "clientName": "kernal" } },
    "google_cloud": { "url": "https://router.example/google_cloud/mcp", "auth": "oauth", "lifecycle": "lazy", "approveTools": true, "headers": { "x-litellm-api-key": "Bearer ${KERNAL_ROUTER_KEY}" }, "oauth": { "clientName": "kernal" } },
    "header_oauth": { "url": "https://other.example/mcp", "auth": "oauth", "headers": { "Authorization": "Bearer static" } },
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
  assert.deepStrictEqual(Object.keys(c.mcpServers).sort(), ["gcloud", "google_cloud", "litellm", "local_cmd", "sentry"]);
  assert.strictEqual(c.mcpServers.litellm.headers["x-litellm-api-key"], "Bearer ${LITELLM_AGENT_KEY}", "env placeholder kept literally");
  assert.strictEqual(c.mcpServers.sentry.auth, false, "gateway OAuth does not start a browser login");
  assert.strictEqual(c.mcpServers.sentry.oauth, undefined);
  assert.ok(c.mcpServers.sentry.headers["x-litellm-api-key"].includes("KERNAL_ROUTER_KEY"), "router key header kept");
  assert.strictEqual(c.mcpServers.gcloud.auth, false, "gcloud is header auth too");
  assert.strictEqual(c.mcpServers.gcloud.disabled, true, "gcloud ships off; agentd enables it for an operator run");
  assert.strictEqual(c.mcpServers.gcloud.approveTools, true, "approval stays on in the image");
  assert.strictEqual(c.mcpServers.google_cloud.auth, false, "google_cloud is header auth too");
  assert.strictEqual(c.mcpServers.google_cloud.disabled, true, "google_cloud ships off; agentd enables it for an operator run");
  assert.strictEqual(c.mcpServers.google_cloud.approveTools, true, "approval stays on in the image");
  assert.strictEqual(c.mcpServers.sentry.disabled, undefined, "other gateway servers stay on");
  assert.deepStrictEqual(c.settings, { toolPrefix: "short" });
' "$tmp/dest.json"

# The real kernal/.pi/mcp.json: direct OAuth goes, gateway OAuth stays as header auth, litellm stays.
bash ./render-mcp.sh ../../kernal/.pi/mcp.json "$tmp/real.json" >/dev/null
node -e '
  const fs = require("fs");
  const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const c = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const bad = Object.entries(c.mcpServers).filter(([, d]) => d && d.auth === "oauth").map(([n]) => n);
  if (bad.length) { console.error("client OAuth left in: " + bad); process.exit(1); }
  if (!c.mcpServers.google_cloud || c.mcpServers.google_cloud.disabled !== true) { console.error("google_cloud must be kept and disabled in the image"); process.exit(1); }
  if (c.mcpServers.sentry && c.mcpServers.sentry.disabled) { console.error("sentry must stay enabled"); process.exit(1); }
  if (c.mcpServers.google_cloud.approveTools !== true) { console.error("google_cloud must keep approveTools"); process.exit(1); }
  if (!c.mcpServers.litellm) { console.error("litellm MCP server was dropped"); process.exit(1); }
  for (const [name, def] of Object.entries(src.mcpServers || {})) {
    const header = def && def.headers && def.headers["x-litellm-api-key"];
    const gateway = def && def.auth === "oauth" && typeof header === "string" && header.length > 0;
    if (gateway) {
      if (!c.mcpServers[name]) { console.error(name + " was dropped"); process.exit(1); }
      if (c.mcpServers[name].auth !== false) { console.error(name + " still starts client OAuth"); process.exit(1); }
      if (c.mcpServers[name].oauth) { console.error(name + " still has an oauth block"); process.exit(1); }
      if (c.mcpServers[name].headers["x-litellm-api-key"] !== header) { console.error(name + " header changed"); process.exit(1); }
    } else if (def && def.auth === "oauth") {
      if (c.mcpServers[name]) { console.error("direct OAuth server kept: " + name); process.exit(1); }
    }
  }
' ../../kernal/.pi/mcp.json "$tmp/real.json"

echo "render-mcp.test.sh: ok"
