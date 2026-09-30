// A Drive's admin ops (Sysop tools, #287): the `admin.request` frames agentd forwards from its admin
// socket (agentd/src/broker-socket.ts). The op runs as the session's owner, with sysop rights only
// when the owner is an operator and the tape says `adminTools: "operator"`. The tape is read again
// on every call, and again after an approval wait, so turning admin tools off in the web UI takes
// effect at once, and a call from a tape without them is refused even though the model's shell can
// reach the socket.
//
// A delete, an operator op, or a change to an admin tape waits for the owner's approval in the web
// UI (approvals.ts); there is no `confirmed` shortcut from a Drive. A write's idempotencyKey is
// remembered on the run, so a replay returns the first result instead of running again.

import { createHash } from "node:crypto";
import { isOperator } from "../auth.ts";
import type { Config } from "../config.ts";
import type { Guru, Session, Store } from "../store/types.ts";
import { hasAdminTools } from "../gurus-service.ts";
import { APPROVAL_TIMEOUT_MS, requestApproval, type ApprovalDeps } from "./approvals.ts";
import { CARD_FIELDS, approvalNeeded, resolveTarget, runAdminOp, type AdminCaller, type AdminContext, type AdminResult } from "./ops.ts";
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
const PENDING = "__pending__";

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

/**
 * What the approval card says. Every word comes from the api: the op, the resolved target's name and
 * id, the known fields a write changes, and the start of a new prompt -- never an arbitrary arg key,
 * and never an env value.
 */
export function approvalText(op: string, args: Record<string, unknown>, target?: string): { title: string; message: string } {
  const what = target ? ` ${target}` : "";
  const title = op.endsWith(".delete") ? `Allow the agent to delete${what}?` : `Allow the agent to run ${op}${what}?`;
  const parts = [`The agent in this session asked for ${op}${what}.`];
  if (!op.endsWith(".delete")) {
    const names = CARD_FIELDS.filter((k) => Object.hasOwn(args, k));
    if (names.length) parts.push(`Fields: ${names.join(", ")}.`);
    if (typeof args.systemPrompt === "string") parts.push(`New system prompt starts: "${clip(args.systemPrompt, 160)}"`);
  }
  return { title, message: parts.join(" ") };
}

function keyOf(idempotencyKey: string): string {
  return `admin_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

export class DriveAdmin {
  private readonly deps: DriveAdminDeps;

  constructor(deps: DriveAdminDeps) {
    this.deps = deps;
  }

  /** The session, tape and caller for this run as they stand now, or the refusal. */
  private async context(runId: string): Promise<{ session: Session; guru: Guru; caller: AdminCaller } | { error: string }> {
    const { store } = this.deps;
    const run = await store.runs.findById(runId);
    const session = run ? await store.sessions.findById(run.sessionId) : null;
    if (!run || !session) return { error: "this run has no session" };
    const guru = await store.gurus.findById(session.guruId);
    if (!guru || !hasAdminTools(guru)) return { error: "admin tools are off for this tape" };
    const owner = session.ownerEmail?.trim();
    if (!owner) return { error: "this session has no owner to act as" };
    return {
      session,
      guru,
      caller: {
        email: owner,
        via: "drive",
        operator: guru.adminTools === "operator" && isOperator(owner, this.deps.config.operators),
        sessionId: session.id,
        runId,
      },
    };
  }

  async handle(runId: string, op: unknown, rawArgs: unknown, idempotencyKey?: unknown): Promise<AdminResult> {
    const key = typeof idempotencyKey === "string" && idempotencyKey ? keyOf(idempotencyKey) : undefined;
    if (!key) return this.run(runId, op, rawArgs);
    const claim = await this.deps.store.runs.claimGithubIdempotency(runId, key, { ok: false, error: PENDING });
    if (claim.status === "missing") return { ok: false, error: "this run has no session" };
    if (claim.status === "existing") {
      const r = claim.record;
      if (!r.ok && r.error === PENDING) return { ok: false, error: "this write is still in progress" };
      return r.ok ? { ok: true, text: String(r.data.text ?? "") } : { ok: false, error: r.error };
    }
    const result = await this.run(runId, op, rawArgs);
    await this.deps.store.runs
      .finishGithubIdempotency(runId, key, result.ok ? { ok: true, data: { text: result.text } } : { ok: false, error: result.error })
      .catch(() => {});
    return result;
  }

  private async run(runId: string, op: unknown, rawArgs: unknown): Promise<AdminResult> {
    const { store } = this.deps;
    const first = await this.context(runId);
    if ("error" in first) return { ok: false, error: first.error };
    const args = (sanitizeArgs(rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {}) ?? {}) as Record<string, unknown>;
    const ctx: AdminContext = { store, models: this.deps.models, log: this.deps.log };

    if (!(await approvalNeeded(ctx, first.caller, op, args))) return runAdminOp(ctx, first.caller, op, args);

    const target = await resolveTarget(ctx, op, args);
    if (target && "error" in target) return { ok: false, error: target.error };
    if (target) args.id = target.id;
    const { title, message } = approvalText(String(op), args, target?.label);
    const outcome = await requestApproval({ store, ...this.deps.approval }, runId, {
      sessionId: first.session.id,
      ownerEmail: first.caller.email,
      op: String(op),
      title,
      message,
    });
    if (!outcome.approved) {
      const minutes = Math.round((this.deps.approval?.timeoutMs ?? APPROVAL_TIMEOUT_MS) / 60_000);
      const why = {
        denied: "the owner declined",
        expired: `the owner did not answer within ${minutes} minute${minutes === 1 ? "" : "s"}`,
        busy: "another admin action is waiting for the owner; try again after it",
        "run ended": "the run ended before the owner answered",
        superseded: "the approval was replaced before the owner answered",
      }[outcome.reason];
      return { ok: false, error: why, needsApproval: true };
    }
    // The wait can be long: act with the tape and rights as they are now, not as they were.
    const now = await this.context(runId);
    if ("error" in now) return { ok: false, error: now.error };
    return runAdminOp(ctx, { ...now.caller, approved: true, approvalId: outcome.approvalId }, op, args);
  }
}
