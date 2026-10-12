/**
 * Approval cards for mutating gcloud MCP calls (GA-4, #494, epic #497). Google's remote gcloud MCP
 * server (`gcloud`, via the router) has `run_gcloud_command` and `run_bq_command`, which are not
 * read-only. pi-mcp-adapter lets another extension broker the approval of any MCP call (event
 * `pi-mcp-adapter:tool-approval-request`; claimed synchronously, answered later), whichever way the
 * model reaches it: its `mcp` proxy tool, a direct tool, or a script.
 *
 * This extension claims every call to the gcloud server, and every call to either command tool on any
 * server (a project's `.mcp.json` can rename the server). A read is answered `allow_once` and a write
 * is asked, so with `approveTools: true` on the server the adapter's own gate is the fallback if this
 * extension is missing or broken (its dialog on a laptop, a headless refusal in a Drive or `-p`).
 * "allow_once" is the only yes it gives, never a session grant: every mutating command is asked again.
 * The decision itself is hook.ts; this file only finds who can be asked.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { personHere } from "../_shared/person.ts";
import { adminTransport, hasAdminCapability } from "../outfitter-admin/transport.ts";
import { checkConfigFiles, googleServersFromFiles } from "./config-check.ts";
import { decide, isGated, type Ways } from "./hook.ts";

/** pi-mcp-adapter's MCP_TOOL_APPROVAL_REQUEST_EVENT (its export is a string literal). */
export const APPROVAL_REQUEST_EVENT = "pi-mcp-adapter:tool-approval-request";
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

interface Request {
  serverName: string;
  originalToolName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  claim(handler: () => Promise<"allow_once" | "deny" | "abstain"> | "allow_once" | "deny" | "abstain"): boolean;
}

export interface Deps {
  ways?: (ctx: any) => Ways;
  /** Where startup warnings go (default: the TUI toast, else stderr). */
  warn?: (message: string, ctx: any) => void;
  /** The mcp.json locations to check at session start. */
  configDirs?: (ctx: any) => { agentDir?: string; cwd?: string };
}

/** Tests pass `deps`; pi calls this with `pi` alone, and the environment decides. */
export default function (pi: ExtensionAPI, deps?: Deps) {
  // The adapter's request carries no pi context; the last one any event gave us is the TUI's.
  let ctx: any;
  // Servers configured at the router's Google path under another name (the request carries no URL).
  let googleServers = new Set<string>();
  const remember = (_event: unknown, c: any) => {
    ctx = c;
  };
  const warn = (m: string, c: any) => {
    if (deps?.warn) return deps.warn(m, c);
    if (typeof c?.ui?.notify === "function") c.ui.notify(m, "warning");
    else console.error(`kernal: ${m}`);
  };

  pi.on("session_start", ((_e: unknown, c: any) => {
    ctx = c;
    const dirs = deps?.configDirs ? deps.configDirs(c) : { agentDir: safeAgentDir(), cwd: c?.cwd };
    for (const w of checkConfigFiles(dirs)) warn(w, c);
    googleServers = googleServersFromFiles(dirs);
  }) as any);
  pi.on("before_agent_start", remember as any);
  pi.on("tool_call", remember as any);

  const waysFor = (c: any): Ways => {
    if (deps?.ways) return deps.ways(c);
    const drive = !!process.env.OUTFITTER_SESSION_ID;
    const notify = (m: string) => c?.ui?.notify?.(m, "warning");
    if (drive) return { drive, transport: hasAdminCapability("admin") ? adminTransport() : undefined, notify };
    return {
      drive,
      transport: adminTransport(),
      notify,
      confirm: personHere(c, "confirm") ? (title, message, signal) => c.ui.confirm(title, message, { signal, timeout: CONFIRM_TIMEOUT_MS }) : undefined,
    };
  };

  pi.events.on(APPROVAL_REQUEST_EVENT, (data: unknown) => {
    const req = data as Request;
    if (!req || typeof req.claim !== "function") return;
    const call = { serverName: String(req.serverName), tool: String(req.originalToolName), args: req.args ?? {}, googleServer: googleServers.has(String(req.serverName)) };
    if (!isGated(call)) return;
    const claimed = req.claim(() => decide(call, waysFor(ctx), req.signal));
    if (!claimed) {
      // Another extension answered first; we can neither ask nor deny. Say so where it can be seen.
      warn(`gcloud approval: another extension claimed the approval for ${call.tool}; its answer applies, not the owner's card`, ctx);
      console.error(`kernal: gcloud approval for ${call.tool} on "${call.serverName}" was claimed by another extension first`);
    }
  });
}

function safeAgentDir(): string | undefined {
  try {
    return getAgentDir();
  } catch {
    return undefined;
  }
}
