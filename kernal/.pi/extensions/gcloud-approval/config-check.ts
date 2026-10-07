/**
 * Startup self-check (GA-4, #494): the approval hook is a layer on top of the adapter's own
 * `approveTools` gate. With `approveTools: true` on the gcloud server, an absent or broken hook falls
 * back to the adapter's dialog (or a headless refusal); without it the fallback is "run". So warn when
 * a gcloud server is configured without it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GCLOUD_SERVER } from "./hook.ts";

/** A server entry that is, or points at, Google's gcloud MCP (through the router or directly). */
export function looksLikeGcloud(name: string, def: any): boolean {
  if (name === GCLOUD_SERVER || name.endsWith(`__${GCLOUD_SERVER}`)) return true;
  const url = typeof def?.url === "string" ? def.url : "";
  return url.includes("/gcloud/mcp") || url.includes("cloudcli.googleapis.com");
}

/** One warning per gcloud-looking server in `config` (an mcp.json) that lacks `approveTools: true`. */
export function configWarnings(config: any, source: string): string[] {
  const servers = config && typeof config === "object" ? config.mcpServers : undefined;
  if (!servers || typeof servers !== "object") return [];
  const out: string[] = [];
  for (const [name, def] of Object.entries<any>(servers)) {
    if (!looksLikeGcloud(name, def)) continue;
    const own = def?.approveTools;
    const effective = own !== undefined ? own : config.settings?.approveTools;
    if (effective !== true) out.push(`gcloud MCP server "${name}" in ${source} has no approveTools: true; if the approval hook fails, its commands would run unasked`);
  }
  return out;
}

/** Reads the usual mcp.json locations (best effort) and returns every warning. */
export function checkConfigFiles(dirs: { agentDir?: string; cwd?: string }): string[] {
  const files = [
    dirs.agentDir && join(dirs.agentDir, "mcp.json"),
    dirs.cwd && join(dirs.cwd, ".pi", "mcp.json"),
    dirs.cwd && join(dirs.cwd, ".mcp.json"),
  ].filter((f): f is string => !!f);
  const out: string[] = [];
  for (const file of files) {
    try {
      if (existsSync(file)) out.push(...configWarnings(JSON.parse(readFileSync(file, "utf8")), file));
    } catch {
      // Unreadable or not JSON: the adapter will say so.
    }
  }
  return out;
}
