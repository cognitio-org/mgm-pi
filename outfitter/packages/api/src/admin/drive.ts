// A Drive's admin ops (Sysop tools, #287): the `admin.request` frames agentd forwards from its admin
// socket (agentd/src/broker-socket.ts). The op runs as the session's owner, with sysop rights only
// when the owner is an operator and the tape says `adminTools: "operator"`. The tape is read again
// on every call, so turning admin tools off in the web UI takes effect at once, and a call from a
// tape without them is refused even though the model's shell can reach the socket.
//
// A delete, an operator op, or a change to an admin tape waits for the owner's approval in the web
// UI (approvals.ts); there is no `confirmed` shortcut from a Drive.

import { isOperator } from "../auth.ts";
import type { Config } from "../config.ts";
import type { Store } from "../store/types.ts";
import { hasAdminTools } from "../gurus-service.ts";
import { requestApproval, type ApprovalDeps } from "./approvals.ts";
import { approvalNeeded, runAdminOp, type AdminCaller, type AdminContext, type AdminResult } from "./ops.ts";
import { clip } from "./render.ts";

export interface DriveAdminDeps {
  store: Store;
  config: Pick<Config, "operators">;
  models: AdminContext["models"];
  log?: (message: string) => void;
  /** Tests shorten the approval wait and its poll. */
  approval?: Omit<ApprovalDeps, "store">;
}

const MAX_DEPTH = 8;

/** A copy of `value` without keys that could reach an object's prototype. JSON.parse makes
 * `__proto__` an own key; nothing downstream should ever see one. */
export function sanitizeArgs(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((v) => sanitizeArgs(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = sanitizeArgs(v, depth + 1);
  }
  return out;
}

/** What the approval card says: the op, its target, and which fields a write touches (never values). */
export function approvalText(op: string, args: Record<string, unknown>): { title: string; message: string } {
  const target = typeof args.id === "string" ? ` ${clip(args.id, 60)}` : "";
  const fieldNames = Object.keys(args).filter((k) => k !== "id");
  const verb = op.endsWith(".delete") ? "delete" : "run";
  const title = verb === "delete" ? `Allow the agent to delete${op.startsWith("tapes.") ? " tape" : ""}${target}?` : `Allow the agent to run ${op}${target}?`;
  const parts = [`The agent in this session asked for ${op}${target}.`];
  if (fieldNames.length) parts.push(`Fields: ${clip(fieldNames.join(", "), 200)}.`);
  if (typeof args.systemPrompt === "string") parts.push(`New system prompt starts: "${clip(args.systemPrompt, 160)}"`);
  return { title, message: parts.join(" ") };
}

export class DriveAdmin {
  private readonly deps: DriveAdminDeps;

  constructor(deps: DriveAdminDeps) {
    this.deps = deps;
  }

  async handle(runId: string, op: unknown, rawArgs: unknown): Promise<AdminResult> {
    const { store } = this.deps;
    const run = await store.runs.findById(runId);
    const session = run ? await store.sessions.findById(run.sessionId) : null;
    if (!run || !session) return { ok: false, error: "this run has no session" };
    const guru = await store.gurus.findById(session.guruId);
    if (!guru || !hasAdminTools(guru)) return { ok: false, error: "admin tools are off for this tape" };
    const owner = session.ownerEmail?.trim();
    if (!owner) return { ok: false, error: "this session has no owner to act as" };

    const args = (sanitizeArgs(rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {}) ?? {}) as Record<string, unknown>;
    const caller: AdminCaller = {
      email: owner,
      via: "drive",
      operator: guru.adminTools === "operator" && isOperator(owner, this.deps.config.operators),
      sessionId: session.id,
      runId,
    };
    const ctx: AdminContext = { store, models: this.deps.models, log: this.deps.log };

    if (await approvalNeeded(ctx, caller, op, args)) {
      const { title, message } = approvalText(String(op), args);
      const outcome = await requestApproval({ store, ...this.deps.approval }, runId, { op: String(op), title, message });
      if (!outcome.approved) {
        const why = {
          denied: "the owner declined",
          expired: "the owner did not answer within 10 minutes",
          busy: "another admin action is waiting for the owner; try again after it",
          "run ended": "the run ended before the owner answered",
        }[outcome.reason];
        return { ok: false, error: why, needsApproval: true };
      }
      return runAdminOp(ctx, { ...caller, approved: true, approvalId: outcome.approvalId }, op, args);
    }
    return runAdminOp(ctx, caller, op, args);
  }
}
