/**
 * The admin tool definitions (outfitter/docs/specs/sysop-tools.md, "Token efficiency"). Every
 * definition is paid for on every turn, so there are few tools, each with an `action`, one-line
 * descriptions, and field lists in a description rather than a schema per field. How to use them
 * together lives in the outfitter-admin skill, which pi loads only when it is needed.
 *
 * Results are the API's compact text, passed through unchanged.
 */
import type { AdminReply, AdminTransport } from "./transport.ts";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Asks the person to approve a delete (laptop TUI). Undefined when nobody can be asked. */
export type Confirm = (title: string, message: string) => Promise<boolean>;

const TAPE_FIELDS =
  "Tape fields: name, model (provider/id), fallbackModel, thinking, systemPrompt, appendSystemPrompt, tools[], excludeTools[], env{}, branchPrefix, mergeFromCloud, browserIde, playwrightBeforeCheckpoint, allowExternalHtmlResources.";

export interface AdminToolDef {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Maps the tool's params to an op and its args. */
  toOp: (params: Record<string, any>) => { op: string; args: Record<string, unknown> } | { error: string };
}

function actionOf(params: Record<string, any>, allowed: readonly string[]): string | undefined {
  const a = typeof params.action === "string" ? params.action.trim() : "";
  return allowed.includes(a) ? a : undefined;
}

function withFields(params: Record<string, any>, keys: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const k of keys) if (params[k] !== undefined) args[k] = params[k];
  const fields = params.fields;
  if (fields && typeof fields === "object" && !Array.isArray(fields)) Object.assign(args, fields);
  return args;
}

const TAPE_ACTIONS = ["list", "get", "meta", "create", "update", "delete"] as const;
const ENV_ACTIONS = ["list", "get", "create", "update"] as const;
const SESSION_ACTIONS = ["list", "get"] as const;

export const ADMIN_TOOLS: AdminToolDef[] = [
  {
    name: "outfitter_tapes",
    label: "Outfitter tapes",
    description: "Manage Outfitter tapes (saved agent setups). meta lists models and limits. delete asks the user.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: TAPE_ACTIONS },
        id: { type: "string", description: "Tape id or unique prefix; optional slug on create." },
        fields: { type: "object", description: `create/update only. ${TAPE_FIELDS}` },
        query: { type: "string", description: "list: filter by id, name or model." },
        models: { type: "string", description: "meta: filter the model list." },
        limit: { type: "number" },
      },
    },
    toOp(p) {
      const action = actionOf(p, TAPE_ACTIONS);
      if (!action) return { error: `action must be one of: ${TAPE_ACTIONS.join(", ")}` };
      return { op: `tapes.${action}`, args: withFields(p, ["id", "query", "models", "limit"]) };
    },
  },
  {
    name: "outfitter_environments",
    label: "Outfitter environments",
    description: "Manage Outfitter environments (repo, base branch and env presets for new sessions).",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ENV_ACTIONS },
        id: { type: "string", description: "Environment id or unique prefix." },
        fields: { type: "object", description: "create/update only: name, repo (owner/name), baseBranch, env{}." },
        limit: { type: "number" },
      },
    },
    toOp(p) {
      const action = actionOf(p, ENV_ACTIONS);
      if (!action) return { error: `action must be one of: ${ENV_ACTIONS.join(", ")}` };
      return { op: `environments.${action}`, args: withFields(p, ["id", "limit"]) };
    },
  },
  {
    name: "outfitter_sessions",
    label: "Outfitter sessions",
    description: "List or inspect Outfitter sessions (floppies): tape, owner, repo, status, run state, cost.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: SESSION_ACTIONS },
        id: { type: "string", description: "get: session id or 8+ char prefix." },
        tape: { type: "string", description: "list: only this tape's sessions." },
        owner: { type: "string", enum: ["me"], description: "list: only mine." },
        status: { type: "string", enum: ["open", "closed"] },
        archived: { type: "boolean", description: "list: archived sessions instead." },
        limit: { type: "number" },
      },
    },
    toOp(p) {
      const action = actionOf(p, SESSION_ACTIONS);
      if (!action) return { error: `action must be one of: ${SESSION_ACTIONS.join(", ")}` };
      return { op: `sessions.${action}`, args: withFields(p, ["id", "tape", "owner", "status", "archived", "limit"]) };
    },
  },
];

export const PROMPT_SNIPPET = "outfitter_*: administer Outfitter (tapes, environments, sessions) without calling its API.";
export const PROMPT_GUIDELINES = [
  "outfitter_*: use these, not curl or the web API. Load the outfitter-admin skill before building or changing a tape.",
];

function text(reply: AdminReply): ToolResult {
  return reply.ok ? { content: [{ type: "text", text: reply.text }] } : { content: [{ type: "text", text: reply.error }], isError: true };
}

/**
 * Runs one tool call. A delete that needs approval is asked in the TUI on a laptop and sent again
 * confirmed; in a Drive the API itself waits for the web approval, so it never comes back here
 * with needsApproval unless it was denied or timed out.
 */
export async function runTool(
  def: AdminToolDef,
  params: Record<string, any>,
  transport: AdminTransport,
  confirm?: Confirm,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const mapped = def.toOp(params ?? {});
  if ("error" in mapped) return { content: [{ type: "text", text: mapped.error }], isError: true };
  const first = await transport.call(mapped.op, mapped.args, { signal });
  if (first.ok || !first.needsApproval) return text(first);
  if (transport.kind !== "laptop" || !confirm) {
    return text({ ok: false, error: "needs approval: ask the user to run this in the Kernal TUI or the Outfitter web UI" });
  }
  const target = typeof mapped.args.id === "string" ? ` ${mapped.args.id}` : "";
  const yes = await confirm(`Outfitter: ${mapped.op}${target}?`, `The agent wants to run ${mapped.op}${target}.`);
  if (!yes) return text({ ok: false, error: "the user declined" });
  return text(await transport.call(mapped.op, mapped.args, { confirmed: true, signal }));
}
