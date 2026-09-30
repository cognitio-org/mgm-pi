// Approvals for a Drive's admin ops (Sysop tools, #287). A delete or an operator op from a Drive's
// agent waits here until the session's owner says yes or no in the web UI. The decision is made
// outside the sandbox (the web role, under IAP), so nothing the model or its shell does can answer
// it: pi's own ui.confirm would come back through agentd, which the sandbox controls.
//
// The request lives on the run (Run.pendingAdminApproval), because the agent's socket is on the
// link role and the owner's click lands on the web role: they share only the store. The waiting side
// polls the run; the web side shows it as a confirm card through the same channel pi's own
// questions use (sse.ts, GET /api/sessions/:id), with id `admin:<approvalId>`, and
// POST /api/sessions/:id/ui-response records the decision (routes/sessions.ts).

import { randomUUID } from "node:crypto";
import type { AdminApproval, Run, Store } from "../store/types.ts";

export const APPROVAL_UI_PREFIX = "admin:";
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export type ApprovalOutcome =
  | { approved: true; approvalId: string; by: string }
  | { approved: false; reason: "denied" | "expired" | "busy" | "run ended" };

export interface ApprovalDeps {
  store: Store;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Holds the op on the run and waits for the owner's decision, the timeout, or the run ending. */
export async function requestApproval(
  deps: ApprovalDeps,
  runId: string,
  ask: { op: string; title: string; message: string },
): Promise<ApprovalOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? 1500;

  const run = await deps.store.runs.findById(runId);
  if (!run) return { approved: false, reason: "run ended" };
  if (run.pendingAdminApproval && !run.pendingAdminApproval.decision && Date.parse(run.pendingAdminApproval.expiresAt) > now()) {
    return { approved: false, reason: "busy" };
  }
  const approval: AdminApproval = {
    id: randomUUID(),
    op: ask.op,
    title: ask.title,
    message: ask.message,
    requestedAt: new Date(now()).toISOString(),
    expiresAt: new Date(now() + timeoutMs).toISOString(),
  };
  await deps.store.runs.update(runId, { pendingAdminApproval: approval, updatedAt: approval.requestedAt });

  const clear = () => deps.store.runs.update(runId, { pendingAdminApproval: null, updatedAt: new Date(now()).toISOString() });
  for (;;) {
    await sleep(pollMs);
    const current = await deps.store.runs.findById(runId);
    const held = current?.pendingAdminApproval;
    if (!current || current.state === "stopped" || current.state === "failed" || held?.id !== approval.id) {
      if (held?.id === approval.id) await clear();
      return { approved: false, reason: "run ended" };
    }
    if (held.decision) {
      await clear();
      return held.decision === "approved"
        ? { approved: true, approvalId: approval.id, by: held.decidedBy ?? "" }
        : { approved: false, reason: "denied" };
    }
    if (now() >= Date.parse(approval.expiresAt)) {
      await clear();
      return { approved: false, reason: "expired" };
    }
  }
}

/** The pending approval as pi's confirm request, for the web session page's existing card. */
export function approvalUiRequest(run: Pick<Run, "pendingAdminApproval"> | null | undefined): Record<string, unknown> | undefined {
  const a = run?.pendingAdminApproval;
  if (!a || a.decision) return undefined;
  return { type: "extension_ui_request", id: `${APPROVAL_UI_PREFIX}${a.id}`, method: "confirm", title: a.title, message: a.message };
}

/**
 * Records the owner's answer from the web UI. Only the session's owner, as a person (not a Dongle),
 * may answer, and only a pending approval with this id.
 */
export async function decideApproval(
  store: Store,
  run: Run,
  approvalId: string,
  decider: { email: string; viaToken?: boolean },
  ownerEmail: string | undefined,
  approved: boolean,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (decider.viaToken) return { ok: false, status: 403, error: "approve admin actions in the Outfitter web UI" };
  if (!ownerEmail || ownerEmail.toLowerCase() !== decider.email.toLowerCase()) {
    return { ok: false, status: 403, error: "only the session's owner can approve its admin actions" };
  }
  const held = run.pendingAdminApproval;
  if (!held || held.id !== approvalId || held.decision) return { ok: false, status: 409, error: "that approval is no longer pending" };
  await store.runs.update(run.id, {
    pendingAdminApproval: { ...held, decision: approved ? "approved" : "denied", decidedBy: decider.email, decidedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  });
  return { ok: true };
}
