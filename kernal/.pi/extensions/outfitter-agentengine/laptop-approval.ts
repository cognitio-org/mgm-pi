/**
 * Web approvals for a laptop's ops (E9.9, outfitter/docs/protocol.md "Laptop approvals").
 *
 * On a laptop the agent's shell runs as the person and can read the Dongle, so a TUI confirm can't
 * stop it from saying yes to itself. For anything that reaches other people (a shared memory, and
 * in #354 an Agent Engine agent) the API asks the owner in the Outfitter web app's approval widget
 * instead: the op comes back `{needsApproval, approvalId}`, Kernal polls `approvals.get` until the
 * person answers, then reruns the same op and args with `approvalId`. The API checks the approval
 * is theirs, approved, unused and for exactly this op and args; Kernal decides nothing.
 *
 * In print mode (`kernal -p`) nothing waits: the pending approval id comes back, and a later call
 * with the same arguments and `approvalId` runs it once it is approved. It must be in the same pi
 * session (`kernal -c -p`): the api binds the approval to the laptop session it came from.
 */
import type { AdminReply, AdminTransport, LaptopContext } from "../outfitter-admin/transport.ts";

export const APPROVAL_POLL_MS = 3_000;
export const APPROVAL_WAIT_MS = 10 * 60_000;
export const WEB_APPROVAL_HINT = "Approve in the Outfitter web app (widget)";

export interface ApprovalWait {
  /** Wait for the answer (interactive); false: return the pending id at once (print mode). */
  wait: boolean;
  /** Tells the person where to answer. */
  notify?: (message: string) => void;
  pollMs?: number;
  timeoutMs?: number;
  /** Tests: a fake clock. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** A laptop tool call's extras: its context, and how a web approval is waited for. */
export interface LaptopCall {
  laptop?: LaptopContext;
  /** Absent: don't wait (print mode); the pending approval id comes back instead. */
  approval?: ApprovalWait;
}

/** The `approvalId` a model passed back after a print-mode wait, trimmed, or undefined. */
export function approvalIdOf(params: Record<string, unknown> | undefined): string | undefined {
  const id = params?.approvalId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

export type WaitOutcome = "approved" | "denied" | "expired" | "used" | "timeout" | "cancelled";

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Polls `approvals.get {id}` until it is answered, the wait runs out, or `signal` aborts. */
export async function waitForApproval(transport: AdminTransport, id: string, signal: AbortSignal | undefined, w: Omit<ApprovalWait, "wait"> = {}): Promise<WaitOutcome> {
  const sleep = w.sleep ?? sleepFor;
  const now = w.now ?? Date.now;
  const deadline = now() + (w.timeoutMs ?? APPROVAL_WAIT_MS);
  for (;;) {
    await sleep(w.pollMs ?? APPROVAL_POLL_MS, signal);
    if (signal?.aborted) return "cancelled";
    const r = await transport.call("approvals.get", { id }, { signal });
    if (signal?.aborted) return "cancelled";
    if (r.ok && r.state && r.state !== "pending") return r.state as WaitOutcome;
    // "no such approval" or a refused id won't change; anything else (a blip) is tried again.
    if (!r.ok && /no such approval|id is required|for a laptop/.test(r.error)) return "expired";
    if (now() >= deadline) return "timeout";
  }
}

function why(outcome: Exclude<WaitOutcome, "approved">, timeoutMs: number): string {
  switch (outcome) {
    case "denied":
      return "you denied it in the Outfitter web app";
    case "expired":
      return "the approval expired or was withdrawn; ask again";
    case "used":
      return "that approval was already used; ask again";
    case "timeout":
      return `no answer in the Outfitter web app within ${Math.round(timeoutMs / 60_000)} minutes; ask again`;
    case "cancelled":
      return "cancelled while waiting for approval";
  }
}

/**
 * Calls `op` from a laptop; when the API asks for the owner's yes, waits for it in the web widget
 * (or, without `wait`, returns the pending id) and reruns with the approval. `approvalId` given:
 * a rerun the model asked for after a print-mode wait.
 */
export async function callWithWebApproval(
  transport: AdminTransport,
  op: string,
  args: Record<string, unknown>,
  opts: { laptop: LaptopContext; signal?: AbortSignal; approvalId?: string },
  w: ApprovalWait,
): Promise<AdminReply> {
  const first = await transport.call(op, args, { signal: opts.signal, laptop: opts.laptop, ...(opts.approvalId ? { approvalId: opts.approvalId } : {}) });
  if (first.ok || !first.needsApproval || !first.approvalId) return first;
  const id = first.approvalId;
  if (!w.wait) {
    return {
      ok: false,
      needsApproval: true,
      approvalId: id,
      // The approval is bound to this pi session: a later run must continue it (`kernal -c -p`).
      error: `waiting for your approval: ${WEB_APPROVAL_HINT}. Once approved, call again in this same session (kernal -c -p) with the same arguments and approvalId "${id}"; it expires in 10 minutes`,
    };
  }
  const timeoutMs = w.timeoutMs ?? APPROVAL_WAIT_MS;
  w.notify?.(`${WEB_APPROVAL_HINT}: Kernal waits up to ${Math.round(timeoutMs / 60_000)} minutes (Esc cancels).`);
  const outcome = await waitForApproval(transport, id, opts.signal, w);
  if (outcome !== "approved") return { ok: false, error: `not done: ${why(outcome, timeoutMs)}` };
  return transport.call(op, args, { signal: opts.signal, laptop: opts.laptop, approvalId: id });
}
