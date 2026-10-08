/**
 * Operator-only MCP servers on a laptop (#493, epic #497). `.pi/mcp.json` ships `gcloud` with
 * `disabled: true`: pi-mcp-adapter connects to every enabled server at start-up, so a non-operator
 * would see "Failed to connect to gcloud" and a dead entry in /mcp-auth. Outfitter lists the servers a
 * device's router key is admitted to (`routerKey.mcpServers`, delivered at login and re-mint), and
 * connect switches on the gated ones that list names, in the agent dir's mcp.json, before the
 * adapter reads it. Only the `disabled` flag of a gated name changes.
 *
 * Never throws. Skipped in a Drive (agentd's mcp-gate does the same job from run.spec) and in a
 * source checkout (the file is tracked there; an operator who develops Kernal can `/mcp enable gcloud`).
 * A change reaches the adapter on the next start when connect runs after it. The router's key grant is
 * the real boundary; this only keeps a server nobody can use out of the way.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Must match agentd/src/mcp-gate.ts, api central/gcloud-mcp.ts and image/render-mcp.sh (a test checks). */
export const GATED_MCP_SERVERS: readonly string[] = ["gcloud", "google_cloud"];

export function applyLaptopMcpGate(agentDir: string | undefined, admitted: readonly string[] | undefined, log: (line: string) => void = () => {}): boolean {
  if (!agentDir) return false;
  if (existsSync(join(dirname(agentDir), ".git"))) return false;
  const path = join(agentDir, "mcp.json");
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
    const servers = config.mcpServers;
    if (!servers || typeof servers !== "object") return false;
    const wanted = new Set((admitted ?? []).filter((n) => GATED_MCP_SERVERS.includes(n)));
    let changed = false;
    for (const name of GATED_MCP_SERVERS) {
      const def = servers[name];
      if (!def || typeof def !== "object") continue;
      if (wanted.has(name) && def.disabled === true) { delete def.disabled; changed = true; }
      else if (!wanted.has(name) && def.disabled !== true) { def.disabled = true; changed = true; }
    }
    if (!changed) return false;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmp, path);
    return true;
  } catch (err) {
    log(`mcp gate: could not update ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
