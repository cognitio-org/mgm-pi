// Approvals for a Drive's admin ops (Sysop tools, #287). A delete, an operator op, or a change to an
// admin tape from a Drive's agent waits here until the session's owner says yes or no in the web UI.
// The decision is made outside the sandbox (the web role, under IAP), so nothing the model or its
// shell does can answer it: pi's own ui.confirm would come back through agentd, which the sandbox
// controls.
//
// The request lives in the `adminApprovals` collection, one per run, because the agent's socket is
// on the link role and the owner's click lands on the web role: they share only the store. Claim,
// decide and clear are conditional writes, so two requests or a late click can't overwrite each
// other. The waiting side polls; the web side shows it to the owner as a confirm card through the
// channel pi's own questions use (sse.ts, GET /api/sessions/:id), marked `source: "outfitter"` so the
// page can tell it from a card the model raised, with id `admin:<approvalId>`; POST
// /api/sessions/:id/ui-response records the decision (routes/sessions.ts).

import { randomUUID } from "node:crypto";
import type { AdminApproval, Store } from "../store/types.ts";

export const APPROVAL_UI_PREFIX = "admin:";
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;
/** Set by the api on its own cards; agentlink.ts strips it from every pi event. */
export const APPROVAL_SOURCE = "outfitter";

export type ApprovalOutcome =
  | { approved: true; approvalId: string; by: string }
  | { approved: false; reason: "denied" | "expired" | "busy" | "run ended" | "superseded" };

export interface ApprovalDeps {
  store: Store;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ApprovalAsk {
  sessionId: string;
  ownerEmail: string;
  op: string;
  title: string;
  message: string;
}

/** Holds the op for the run and waits for the owner's decision, the timeout, or the run ending. */
export async function requestApproval(deps: ApprovalDeps, runId: string, ask: ApprovalAsk): Promise<ApprovalOutcome> {
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? 1500;

  const approval: AdminApproval = {
    id: randomUUID(),
    runId,
    sessionId: ask.sessionId,
    ownerEmail: ask.ownerEmail.toLowerCase(),
    op: ask.op,
    title: ask.title,
    message: ask.message,
    requestedAt: iso(),
    expiresAt: new Date(now() + timeoutMs).toISOString(),
  };
  if (!(await deps.store.adminApprovals.claim(approval, approval.requestedAt))) return { approved: false, reason: "busy" };

  const clear = () => deps.store.adminApprovals.clear(runId, approval.id);
  for (;;) {
    await sleep(pollMs);
    const [held, run] = await Promise.all([deps.store.adminApprovals.get(runId), deps.store.runs.findById(runId)]);
    if (held?.id !== approval.id) return { approved: false, reason: "superseded" };
    if (!run || run.state === "stopped" || run.state === "failed") {
      await clear();
      return { approved: false, reason: "run ended" };
    }
    if (held.decision) {
      await clear();
      return held.decision === "approved" ? { approved: true, approvalId: approval.id, by: held.decidedBy ?? "" } : { approved: false, reason: "denied" };
    }
    if (iso() >= approval.expiresAt) {
      await clear();
      return { approved: false, reason: "expired" };
    }
  }
}

/** A pending, unexpired approval as pi's confirm request, for the owner's session page. */
export function approvalUiRequest(approval: AdminApproval | null | undefined, nowIso = new Date().toISOString()): Record<string, unknown> | undefined {
  if (!approval || approval.decision || approval.expiresAt <= nowIso) return undefined;
  return {
    type: "extension_ui_request",
    id: `${APPROVAL_UI_PREFIX}${approval.id}`,
    method: "confirm",
    title: approval.title,
    message: approval.message,
    source: APPROVAL_SOURCE,
  };
}

/** A signed-in person (IAP or dev), never a token: only a person answers an approval. */
export function isPerson(viewer: { email?: string; viaToken?: boolean } | undefined): viewer is { email: string; viaToken?: false } {
  return !!viewer?.email && !viewer.viaToken;
}

/** Whether this viewer may see and answer the run's approval: its owner, as a person. */
export function mayAnswer(approval: Pick<AdminApproval, "ownerEmail">, viewer: { email?: string; viaToken?: boolean } | undefined): boolean {
  return isPerson(viewer) && viewer.email.toLowerCase() === approval.ownerEmail;
}

/** Records the owner's answer from the web UI. */
export async function decideApproval(
  store: Store,
  runId: string,
  approvalId: string,
  decider: { email: string; viaToken?: boolean },
  approved: boolean,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (decider.viaToken) return { ok: false, status: 403, error: "approve admin actions in the Outfitter web UI" };
  const held = await store.adminApprovals.get(runId);
  if (!held || held.id !== approvalId) return { ok: false, status: 409, error: "that approval is no longer pending" };
  if (!mayAnswer(held, decider)) return { ok: false, status: 403, error: "only the session's owner can approve its admin actions" };
  const decided = await store.adminApprovals.decide(runId, approvalId, approved ? "approved" : "denied", decider.email, new Date().toISOString());
  return decided ? { ok: true } : { ok: false, status: 409, error: "that approval is no longer pending" };
}
