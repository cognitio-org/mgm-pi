// Operator-only MCP servers in a Drive (#493, epic #497). The image's mcp.json ships a gated server
// (today `gcloud`, Google's remote gcloud through the router) switched off: `disabled: true`, which
// pi-mcp-adapter honours (no connection, no tools). The api turns it on for one run through
// run.spec.mcp.enable, only when the tape has `adminTools: operator` AND the owner is an operator
// (api/src/central/gcloud-mcp.ts gcloudRun, the same test as the admin socket). agentd flips the flag
// in the agent dir's mcp.json before pi starts.
//
// This is a tidy-up, not the security boundary: pi runs as a user that can edit that file. The
// boundary is the run key, which the router admits to `gcloud` only for such a run (GA-2). A server
// switched on for a run whose key lacks the grant is hidden by the router, never another user's token.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The servers run.spec.mcp may switch on. Anything else in the list is ignored. */
export const GATED_MCP_SERVERS: readonly string[] = ["gcloud"];

export interface McpGateResult {
  /** Gated servers left on for this run. */
  enabled: string[];
  /** Gated servers (re)disabled. */
  disabled: string[];
}

/** Rewrites `<agentDir>/mcp.json` so each gated server is enabled exactly when `enable` lists it.
 * Never throws: a missing or unreadable file means the image has no such server, and the run goes on.
 * Returns undefined when nothing needed changing. */
export async function applyMcpGate(
  agentDir: string | undefined,
  enable: readonly string[] | undefined,
  onLog: (line: string) => void = () => {},
): Promise<McpGateResult | undefined> {
  if (!agentDir) return undefined;
  const path = join(agentDir, "mcp.json");
  try {
    const config = JSON.parse(await readFile(path, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
    const servers = config.mcpServers;
    if (!servers || typeof servers !== "object") return undefined;
    const wanted = new Set((enable ?? []).filter((name) => GATED_MCP_SERVERS.includes(name)));
    const result: McpGateResult = { enabled: [], disabled: [] };
    let changed = false;
    for (const name of GATED_MCP_SERVERS) {
      const def = servers[name];
      if (!def || typeof def !== "object") continue;
      if (wanted.has(name)) {
        if (def.disabled === true) {
          delete def.disabled;
          changed = true;
        }
        result.enabled.push(name);
      } else {
        if (def.disabled !== true) {
          def.disabled = true;
          changed = true;
        }
        result.disabled.push(name);
      }
    }
    if (!changed) return undefined;
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
    onLog(`mcp: gated servers on: ${result.enabled.join(",") || "none"}; off: ${result.disabled.join(",") || "none"}`);
    return result;
  } catch (err) {
    onLog(`mcp: could not apply the operator gate to ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
