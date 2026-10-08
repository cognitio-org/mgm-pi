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
/** The router's combined toolset (GB-5, #541): cloudcli + Cloud Run + Logging + Monitoring + Firestore. */
export const GOOGLE_CLOUD_SERVER = "google_cloud";

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

/** True for an MCP server this hook guards: `gcloud` or `google_cloud`, or a plugin-prefixed `<plugin>__<name>`. */
export function isGcloudServer(name: string): boolean {
  for (const server of [GCLOUD_SERVER, GOOGLE_CLOUD_SERVER]) {
    if (name === server || name.endsWith(`__${server}`)) return true;
  }
  return false;
}

/** The gcloud server's two command tools, whatever the MCP server is called. */
export const GCLOUD_TOOLS: ReadonlySet<string> = new Set(["run_gcloud_command", "run_bq_command"]);

/**
 * Google's product tools by router server, as `<server>-<tool>` names them. READ is the static
 * allow-list, taken from `readOnlyHint` in Google's tools/list (2026-10-08): only these, under the
 * right product, run unasked. Anything else, known or not, asks.
 */
const READ_BY_PRODUCT: Readonly<Record<string, ReadonlySet<string>>> = {
  cloudrun: new Set(["get_service", "list_services"]),
  cloudlogging: new Set(["list_log_entries", "list_log_names", "get_bucket", "list_buckets", "get_view", "list_views"]),
  cloudmonitoring: new Set([
    "list_timeseries", "query_range", "get_alert_policy", "list_alert_policies", "get_alert", "list_alerts",
    "list_metric_descriptors", "list_dashboards", "get_dashboard",
  ]),
  // Firestore: empty on purpose. The names were not available when this was written, so every
  // firestore tool asks until a verified read-only name is added here.
  firestore: new Set<string>(),
};

/** Product tools whose readOnlyHint is false (Cloud Run deploys). */
export const PRODUCT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "deploy_service_from_image", "deploy_service_from_archive", "deploy_service_from_file_contents",
]);

export const PRODUCT_READ_TOOLS: ReadonlySet<string> = new Set(Object.values(READ_BY_PRODUCT).flatMap((s) => [...s]));
export const FIRESTORE_READ_TOOLS: ReadonlySet<string> = READ_BY_PRODUCT.firestore;

const PRODUCT_PREFIX = /(?:^|[-_.:])(gcloud|cloudrun|cloudlogging|cloudmonitoring|firestore)[-_.:]([^]+)$/;

/**
 * The router prefix a tool name carries (`cloudrun-list_services`: product `cloudrun`, tool
 * `list_services`), or null. The prefix must start the name or follow a `-`, `_`, `.` or `:`. A bare
 * generic name (`get_dashboard`) carries none, so it is not Google's.
 */
export function productOf(name: string): { product: string; tool: string } | null {
  const m = PRODUCT_PREFIX.exec(name);
  return m ? { product: m[1], tool: m[2] } : null;
}

/** Tool names of the command tools, longest first (none is the tail of another). */
const COMMAND_TOOLS = [...GCLOUD_TOOLS];

/**
 * The known tool behind a name, or the name unchanged. The router prefixes every upstream tool with
 * its server (`gcloud-run_gcloud_command`, `cloudrun-deploy_service_from_image`); a command tool is
 * recognised after any `-`, `_`, `.` or `:` boundary (a renamed server), and a product tool only
 * under its own product's prefix. Lookalikes such as `xrun_gcloud_command` stay unknown (and ask).
 */
export function baseTool(name: string): string {
  for (const tool of COMMAND_TOOLS) {
    if (name === tool) return tool;
    if (name.endsWith(tool) && /[-_.:]$/.test(name.slice(0, -tool.length))) return tool;
  }
  const p = productOf(name);
  if (p && (READ_BY_PRODUCT[p.product]?.has(p.tool) || (p.product === "cloudrun" && PRODUCT_WRITE_TOOLS.has(p.tool)))) return p.tool;
  return name;
}

/**
 * Whether this call is ours to judge: the gcloud / google_cloud server by name; a tool name with one
 * of the router's Google prefixes on any server (a project's `.mcp.json` can rename the server, but
 * the router's prefix still says whose tool it is); or either command tool bare. A bare generic name
 * such as `get_dashboard` on another server is not ours: that server's own `approveTools` applies.
 */
export function isGated(call: Call): boolean {
  return isGcloudServer(call.serverName) || GCLOUD_TOOLS.has(baseTool(call.tool)) || productOf(call.tool) !== null;
}

/** Whether this call needs an answer from a person before it runs. */
export function needsApproval(call: Call): boolean {
  if (!isGated(call)) return false;
  const base = baseTool(call.tool);
  if (GCLOUD_TOOLS.has(base)) return classifyCommand(base, call.args?.command) === "write";
  // A product tool: only the static read-only list, under its own product, runs unasked.
  const p = productOf(call.tool);
  return !(p && READ_BY_PRODUCT[p.product]?.has(p.tool));
}

const MAX_SHOWN = 800;

/** Agent text for a dialog: control and bidi characters become a visible mark, and it is clipped. */
export function shown(text: unknown, max = MAX_SHOWN): string {
  const flat = String(text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "�");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const NOTE_TIMEOUT_MS = 10_000;

const MAX_SUMMARY = 600;

/** `projects/X` found in the argument values (`name`, `parent`, ...), or "". */
function projectFromArgs(args: Record<string, unknown>): string {
  for (const value of Object.values(args)) {
    const m = typeof value === "string" ? /(?:^|\/)projects\/([^/\s]+)/.exec(value) : null;
    if (m) return `projects/${m[1]}`;
  }
  return "";
}

/** What the card and the audit row get: the base tool name, the project, and the command (or, for a product tool, its arguments as one clipped line). */
function fields(call: Call): { project: string; command: string; tool: string } {
  const tool = baseTool(call.tool);
  const args = call.args && typeof call.args === "object" ? call.args : {};
  const own = typeof args.project === "string" ? args.project : "";
  if (GCLOUD_TOOLS.has(tool)) return { project: own, command: typeof args.command === "string" ? args.command : "", tool };
  let json: string;
  try {
    json = JSON.stringify(args) ?? "";
  } catch {
    json = "(arguments could not be shown)";
  }
  return { project: own || projectFromArgs(args), command: shown(json === "{}" ? "(no arguments)" : json, MAX_SUMMARY), tool };
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
  const { project, command, tool } = fields(call);

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
    GCLOUD_TOOLS.has(tool) ? "gcloud: run this command?" : `gcloud: run ${shown(tool, 80)}?`,
    GCLOUD_TOOLS.has(tool)
      ? `The agent wants Google's gcloud server to run a command that may change something.\n\nProject: ${shown(project || "(none)", 200)}\nCommand: ${shown(command)}\n\nIt acts as you.`
      : `The agent wants to call the Google Cloud tool ${shown(tool, 80)}, which may change something.\n\nProject: ${shown(project || "(none)", 200)}\nArguments: ${shown(command)}\n\nIt acts as you.`,
    signal,
  );
  await note(ways.transport, call, yes);
  if (!yes) ways.notify?.("gcloud: denied by owner");
  return yes ? "allow_once" : "deny";
}
