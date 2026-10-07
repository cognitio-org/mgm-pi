/**
 * Approval cards for mutating gcloud MCP calls (GA-4, #494, epic #497). The MCP server named
 * `gcloud` (Google's remote gcloud, via the router) has `run_gcloud_command` and `run_bq_command`,
 * which are not read-only. pi-mcp-adapter lets another extension broker the approval of any MCP call
 * (event `pi-mcp-adapter:tool-approval-request`; claimed synchronously, answered later), whichever
 * way the model reaches it: its `mcp` proxy tool, a direct tool, or a script. So this extension
 * listens, and claims only a call to the gcloud server that classify.ts doesn't call a plain read.
 * Reads are not claimed, and nothing else on the bus is touched. "allow_once" is the only yes it
 * gives, never a session grant: every mutating command is asked again.
 *
 * The decision itself is hook.ts; this file only finds who can be asked.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { personHere } from "../_shared/person.ts";
import { adminTransport, hasAdminCapability } from "../outfitter-admin/transport.ts";
import { decide, isGcloudServer, needsApproval, type Ways } from "./hook.ts";

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

/** Tests pass `deps`; pi calls this with `pi` alone, and the environment decides. */
export default function (pi: ExtensionAPI, deps?: { ways?: (ctx: any) => Ways }) {
  // The adapter's request carries no pi context; the last one any event gave us is the TUI's.
  let ctx: any;
  const remember = (_event: unknown, c: any) => {
    ctx = c;
  };
  pi.on("session_start", remember as any);
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
    if (!req || typeof req.claim !== "function" || !isGcloudServer(String(req.serverName))) return;
    const call = { serverName: req.serverName, tool: req.originalToolName, args: req.args ?? {} };
    // A read is left to the adapter, unclaimed.
    if (!needsApproval(call)) return;
    req.claim(() => decide(call, waysFor(ctx), req.signal));
  });
}
