// GA-4 (#494): approval cards for the mutating commands an agent sends to Google's remote gcloud
// MCP server. The MCP call itself never passes through the api -- it goes agent -> router -> Google
// -- so Kernal (extensions/gcloud-approval) asks first, through these ops, and only then lets the
// adapter run the tool:
//
// - `gcloud.run`, from a Drive: an `operator` op, so the session's owner (a sysop, on an
//   `adminTools: operator` tape) is asked on a web card (drive.ts) and the answer is audited. It
//   runs nothing; "ok" means the owner said yes. A refusal (declined, expired) is audited too.
//   On `gcloud.run` rows, `ok` means the owner approved, not that the command ran or succeeded (the
//   call goes agent -> router -> Google afterwards, and the API never sees its result).
// - `gcloud.note`, from a laptop: the person said yes or no in the TUI, and this writes the audit
//   row. Refused from a Drive, whose decisions are the owner's card, not the model's word.
//
// The command is the agent's text: the card shows it clipped and labelled, and a command with
// hidden characters is refused before anyone is asked.

import { hasHidden } from "../untrusted.ts";
import { clip } from "./render.ts";
import { registerAdminOp, type AdminResult } from "./ops.ts";

const MAX_COMMAND = 4000;
const MAX_PROJECT = 200;
const TOOLS = ["run_gcloud_command", "run_bq_command"] as const;
/**
 * Google's product tools (GB-5, #541) and the router server each belongs to, for the card's title.
 * Kernal sends the tool's base name; `command` is then a one-line summary of its arguments.
 */
export const PRODUCT_TOOLS: Readonly<Record<string, string>> = {
  get_service: "cloudrun", list_services: "cloudrun",
  deploy_service_from_image: "cloudrun", deploy_service_from_archive: "cloudrun", deploy_service_from_file_contents: "cloudrun",
  list_log_entries: "cloudlogging", list_log_names: "cloudlogging", get_bucket: "cloudlogging", list_buckets: "cloudlogging", get_view: "cloudlogging", list_views: "cloudlogging",
  list_timeseries: "cloudmonitoring", query_range: "cloudmonitoring", get_alert_policy: "cloudmonitoring", list_alert_policies: "cloudmonitoring", get_alert: "cloudmonitoring",
  list_alerts: "cloudmonitoring", list_metric_descriptors: "cloudmonitoring", list_dashboards: "cloudmonitoring", get_dashboard: "cloudmonitoring",
};
/** A tool name we have no table entry for (a Firestore tool, a new Google tool): shown as sent, once it is plainly a name. */
const OTHER_TOOL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

/** `project` and `command` as sent, or the reason they can't be asked about. */
export function gcloudArgs(args: Record<string, unknown>): { project: string; command: string; tool: string } | { error: string } {
  const project = typeof args.project === "string" ? args.project.trim() : "";
  const command = typeof args.command === "string" ? args.command.trim() : "";
  const sent = typeof args.tool === "string" ? args.tool.trim() : "";
  const tool = (TOOLS as readonly string[]).includes(sent) || Object.hasOwn(PRODUCT_TOOLS, sent) || OTHER_TOOL.test(sent) ? sent : "run_gcloud_command";
  if (!command) return { error: "command is required" };
  if (command.length > MAX_COMMAND) return { error: `command is longer than ${MAX_COMMAND} characters` };
  if (project.length > MAX_PROJECT) return { error: "project is too long" };
  if (hasHidden(command) || hasHidden(project)) return { error: "the command has hidden characters; not asked" };
  return { project, command, tool };
}

/** The card's question: a command tool is "a gcloud command"; a product tool is named with its server. */
export function gcloudTitle(tool: string): string {
  if (tool === "run_bq_command") return "Allow the agent to run a bq command?";
  if (tool === "run_gcloud_command") return "Allow the agent to run a gcloud command?";
  const product = Object.hasOwn(PRODUCT_TOOLS, tool) ? `${PRODUCT_TOOLS[tool]} ` : "";
  return `Allow the agent to run ${product}${tool}?`;
}

/** What the audit row's `target` holds: tool, project and command, flattened and clipped. */
export function gcloudTarget(a: { project: string; command: string; tool: string }): string {
  return clip(`${a.tool} ${a.project || "(no project)"} :: ${a.command}`, 480);
}

registerAdminOp("gcloud.run", {
  kind: "operator",
  capability: "admin",
  async refused(_ctx, args) {
    const a = gcloudArgs(args);
    return "error" in a ? a.error : undefined;
  },
  card(args) {
    const a = gcloudArgs(args);
    if ("error" in a) return { title: "Allow a gcloud command?", message: a.error };
    return {
      title: gcloudTitle(a.tool),
      message:
        a.tool === "run_gcloud_command" || a.tool === "run_bq_command"
          ? `The agent in this session asked Google's gcloud server to run this. It acts as you. Project: ${a.project || "(none)"}. Command (the agent's text): ${clip(a.command, 600)}`
          : `The agent in this session asked Google Cloud to run ${a.tool}. It acts as you. Project: ${a.project || "(none)"}. Arguments (the agent's text): ${clip(a.command, 600)}`,
    };
  },
  async run(_ctx, caller, args): Promise<AdminResult & { target?: string }> {
    const a = gcloudArgs(args);
    if ("error" in a) return { ok: false, error: a.error };
    if (!caller.approved) return { ok: false, error: "needs approval", needsApproval: true };
    return { ok: true, text: "approved", target: gcloudTarget(a) };
  },
});

/** `gcloud.note` calls per user per hour. */
export const NOTE_LIMIT_PER_HOUR = 60;
const noteTimes = new Map<string, number[]>();

function noteAllowed(email: string, now: number): boolean {
  const recent = (noteTimes.get(email) ?? []).filter((t) => now - t < 3_600_000);
  const ok = recent.length < NOTE_LIMIT_PER_HOUR;
  if (ok) recent.push(now);
  noteTimes.set(email, recent);
  return ok;
}

/**
 * A laptop's own account of its TUI decision. It is the caller's word, so the row is never
 * `approved: true` (ops.ts `auditNote`); `detail` says it is self-reported. Operators only, and
 * rate limited, so a laptop agent can't fill the log or pose as an approver.
 */
registerAdminOp("gcloud.note", {
  kind: "write",
  capability: "admin",
  laptop: true,
  auditNote: true,
  async run(ctx, caller, args): Promise<AdminResult & { target?: string; detail?: string }> {
    if (caller.via !== "token") return { ok: false, error: "a Drive's gcloud decisions are its approval cards" };
    if (!caller.listedOperator) return { ok: false, error: "sysop rights required" };
    const a = gcloudArgs(args);
    if ("error" in a) return { ok: false, error: a.error };
    if (!noteAllowed(caller.email.toLowerCase(), ctx.now?.() ?? Date.now())) return { ok: false, error: "too many gcloud notes; try again later" };
    const target = gcloudTarget(a);
    return args.decision === "allowed"
      ? { ok: true, text: "noted", target, detail: "self-reported: allowed in the Kernal TUI" }
      : { ok: false, error: "declined in the Kernal TUI", target, detail: "self-reported: denied in the Kernal TUI" };
  },
});

/**
 * A Drive's gcloud call was aborted (the model cancelled, the extension went away): withdraw its
 * pending card instead of leaving it for the owner until it expires. DriveAdmin sees the card go and
 * ends the waiting `gcloud.run` as a refusal, which is audited.
 */
registerAdminOp("gcloud.cancel", {
  kind: "write",
  capability: "admin",
  async run(ctx, caller): Promise<AdminResult & { target?: string }> {
    if (caller.via !== "drive" || !caller.runId) return { ok: false, error: "gcloud.cancel is for a Drive" };
    const held = await ctx.store.adminApprovals.get(caller.runId);
    if (!held || held.decision || held.op !== "gcloud.run") return { ok: true, text: "nothing pending" };
    await ctx.store.adminApprovals.clear(caller.runId, held.id);
    return { ok: true, text: "cancelled", target: held.id };
  },
});
