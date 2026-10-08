/**
 * The decision for one gcloud MCP call (GA-4, #494). Pure of pi: `index.ts` wires it to the MCP
 * adapter's approval broker and passes in how to ask.
 *
 * - `read`: not our business; the adapter carries on as it would (`abstain`, and `index.ts` does not
 *   even claim the request).
 * - `write`, in a Drive: the owner's web card, through the admin socket (`gcloud.run`, an operator
 *   op the API asks and audits; outfitter/packages/api/src/admin/gcloud-ops.ts).
 * - `write`, at a laptop TUI: a confirm showing the project and command, then an audit row
 *   (`gcloud.note`, best effort) through the person's `kernal login`.
 * - `write`, anywhere else (`kernal -p`, RPC with nobody watching, a Drive with no admin socket):
 *   denied. Nobody can say yes, so the answer is no.
 */
import { classifyCommand } from "./classify.ts";
import type { AdminTransport } from "../outfitter-admin/transport.ts";

export const GCLOUD_SERVER = "gcloud";

export type Decision = "abstain" | "allow_once" | "deny";

export interface Call {
  serverName: string;
  /** The MCP tool's own name (`run_gcloud_command`), not the prefixed one the model sees. */
  tool: string;
  args: Record<string, unknown>;
}

export interface Ways {
  /** A person at the TUI: asks them. Absent when there is none. */
  confirm?: (title: string, message: string, signal?: AbortSignal) => Promise<boolean>;
  /** In a Drive: the admin socket. At a laptop: the login's transport (for the audit note). */
  transport?: AdminTransport;
  /** Whether this process is a Drive (a person's TUI is never asked there). */
  drive: boolean;
  /** Tells the person why a call was refused (a toast); optional. */
  notify?: (message: string) => void;
}

/** True for the MCP server this hook guards: `gcloud`, or a plugin-prefixed `<plugin>__gcloud`. */
export function isGcloudServer(name: string): boolean {
  return name === GCLOUD_SERVER || name.endsWith(`__${GCLOUD_SERVER}`);
}

/** The gcloud server's two command tools, whatever the MCP server is called. */
export const GCLOUD_TOOLS: ReadonlySet<string> = new Set(["run_gcloud_command", "run_bq_command"]);

/**
 * The command tool behind a name, or the name unchanged. The router prefixes every upstream tool
 * with its server (`gcloud-run_gcloud_command`), and a server registered under another name gets
 * another prefix, so the base name is what identifies the tool. Only a prefix that ends in `-`,
 * `_`, `.` or `:` counts, so a lookalike such as `xrun_gcloud_command` stays unknown (and asks).
 */
export function baseTool(name: string): string {
  for (const tool of GCLOUD_TOOLS) {
    if (name === tool) return tool;
    if (name.endsWith(tool) && /[-_.:]$/.test(name.slice(0, -tool.length))) return tool;
  }
  return name;
}

/**
 * Whether this call is ours to judge: the gcloud server by name, or either command tool on any
 * server. A cloned repo's `.mcp.json` can name a server anything and point it at the same router
 * URL, so the tool name counts too.
 */
export function isGated(call: Call): boolean {
  return isGcloudServer(call.serverName) || GCLOUD_TOOLS.has(baseTool(call.tool));
}

/** Whether this call needs an answer from a person before it runs. */
export function needsApproval(call: Call): boolean {
  if (!isGated(call)) return false;
  return classifyCommand(baseTool(call.tool), call.args?.command) === "write";
}

const MAX_SHOWN = 800;

/** Agent text for a dialog: control and bidi characters become a visible mark, and it is clipped. */
export function shown(text: unknown, max = MAX_SHOWN): string {
  const flat = String(text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "�");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const NOTE_TIMEOUT_MS = 10_000;

function fields(call: Call): { project: string; command: string; tool: string } {
  const project = typeof call.args?.project === "string" ? call.args.project : "";
  const command = typeof call.args?.command === "string" ? call.args.command : "";
  return { project, command, tool: baseTool(call.tool) };
}

/** Records a laptop decision in Outfitter's audit log. Never throws and never blocks for long. */
async function note(transport: AdminTransport | undefined, call: Call, allowed: boolean): Promise<void> {
  if (!transport || transport.kind !== "laptop") return;
  try {
    await transport.call("gcloud.note", { ...fields(call), decision: allowed ? "allowed" : "denied" }, { confirmed: allowed, signal: AbortSignal.timeout(NOTE_TIMEOUT_MS) });
  } catch {
    // The audit row is best effort; the decision stands.
  }
}

export async function decide(call: Call, ways: Ways, signal?: AbortSignal): Promise<Decision> {
  if (!isGated(call)) return "abstain";
  // A read is allowed explicitly, so the adapter's own `approveTools` gate (set on the server) is the
  // fallback only when this extension is absent or broken.
  if (!needsApproval(call)) return "allow_once";
  const { project, command } = fields(call);

  if (ways.drive) {
    // The owner's web card is the only yes in a Drive; no socket means no way to ask.
    if (!ways.transport || ways.transport.kind !== "drive") {
      ways.notify?.("gcloud: denied (no approval channel in this Drive)");
      return "deny";
    }
    const reply = await ways.transport.call("gcloud.run", fields(call), { signal });
    if (reply.ok) return "allow_once";
    // Aborted while the card waited: withdraw it, so the owner isn't left a card for a call that is gone.
    if (signal?.aborted) {
      try {
        await ways.transport.call("gcloud.cancel", {}, { signal: AbortSignal.timeout(NOTE_TIMEOUT_MS) });
      } catch {
        // The card expires by itself in 10 minutes.
      }
    }
    ways.notify?.(`gcloud: denied (${reply.error})`);
    return "deny";
  }

  if (!ways.confirm) {
    ways.notify?.("gcloud: denied (a mutating command needs approval, and nobody is here to give it)");
    return "deny";
  }
  const yes = await ways.confirm(
    "gcloud: run this command?",
    `The agent wants Google's gcloud server to run a command that may change something.\n\nProject: ${shown(project || "(none)", 200)}\nCommand: ${shown(command)}\n\nIt acts as you.`,
    signal,
  );
  await note(ways.transport, call, yes);
  if (!yes) ways.notify?.("gcloud: denied by owner");
  return yes ? "allow_once" : "deny";
}
