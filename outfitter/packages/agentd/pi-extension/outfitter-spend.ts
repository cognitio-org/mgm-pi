/**
 * E2.11: a pi extension loaded only under agentd (renderGuru adds `-e <this file>` when
 * RunControllerDeps.spendExtensionPath is set -- see ../src/guru.ts and ../src/run.ts), so a run's
 * cost is real even though agentd itself never sees the LiteLLM response headers pi's own HTTP
 * client received. mgm's own `connect` extension (mgm/.pi/extensions/connect) already does this same
 * parsing for the *interactive* TUI's `/budget` panel; this is a separate, minimal instance of the
 * same idea for the cloud run path, self-contained (no import from mgm/) so this package doesn't
 * depend on mgm's own layout inside the sandbox image.
 *
 * On every `after_provider_response` event whose headers are LiteLLM's (`x-litellm-call-id`
 * present), appends one JSON line to `OUTFITTER_SPEND_FILE`:
 *   { keySpend?, keyMax?, modelGroup?, callId?, usage? }
 * `usage` is pi's own cost estimate for *this* response only (the delta in the session's running
 * LiteLLM cost total since the previous line), not a cumulative total -- agentd's SpendTailer
 * (../src/pi.ts) accumulates it into the run's `costEstimate` as it tails this file.
 *
 * No-ops entirely (registers no hook) when OUTFITTER_SPEND_FILE isn't set, so loading this file
 * outside agentd (it never is, by construction, but this keeps the extension safe either way) does
 * nothing.
 */
import { appendFileSync } from "node:fs";

// ---------- pure, unit-tested logic ----------

export interface SpendHeaders {
  litellm: boolean;
  keySpend?: number;
  keyMax?: number;
  modelGroup?: string;
  callId?: string;
}

/** Same contract as mgm/.pi/extensions/connect/lib.ts's parseSpendHeaders: only trust
 * x-litellm-key-spend/-max-budget (per-call cost reads 0 on a streamed response); `litellm` is true
 * only when x-litellm-call-id is present at all, i.e. this response actually went through the
 * LiteLLM router. */
export function parseSpendHeaders(headers: Record<string, string> | undefined): SpendHeaders {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) h[k.toLowerCase()] = v;
  if (!("x-litellm-call-id" in h)) return { litellm: false };
  const num = (key: string) => {
    const n = Number(h[key]);
    return Number.isFinite(n) && h[key] !== undefined && h[key] !== "" ? n : undefined;
  };
  return {
    litellm: true,
    keySpend: num("x-litellm-key-spend"),
    keyMax: num("x-litellm-key-max-budget"),
    modelGroup: h["x-litellm-model-group"],
    callId: h["x-litellm-call-id"],
  };
}

/** Sums pi's own cost accounting (message.usage.cost.total) across every LiteLLM-served assistant
 * turn recorded so far -- the same field mgm's connect extension's sessionEstimate reads. */
export function sessionCostTotal(entries: readonly unknown[], provider = "litellm"): number {
  let total = 0;
  for (const e of entries as any[]) {
    if (e?.type === "message" && e.message?.role === "assistant" && e.message.provider === provider) {
      total += e.message.usage?.cost?.total ?? 0;
    }
  }
  return total;
}

export interface SpendLogLine {
  keySpend?: number;
  keyMax?: number;
  modelGroup?: string;
  callId?: string;
  usage?: number;
}

/** Builds the JSON line to append: `usage` is the increase in `sessionCostTotal` since
 * `previousTotal` (this call's own contribution), never negative (a compaction or session edit could
 * otherwise make the running total go down). */
export function buildSpendLogLine(headers: SpendHeaders, currentTotal: number, previousTotal: number): SpendLogLine {
  return {
    keySpend: headers.keySpend,
    keyMax: headers.keyMax,
    modelGroup: headers.modelGroup,
    callId: headers.callId,
    usage: Math.max(0, currentTotal - previousTotal),
  };
}

// ---------- extension wiring ----------

/** Loosely typed on purpose: this file ships in packages/agentd (which does not depend on
 * @earendil-works/pi-coding-agent -- it only runs inside the sandbox image, where pi loads it
 * directly via `-e`, same as mgm's own extensions). See ../src/guru.ts's RenderOptions doc. */
type PiExtensionApi = {
  on(event: "after_provider_response", handler: (ev: { headers?: Record<string, string> }, ctx: any) => void | Promise<void>): void;
  on(event: "session_start", handler: (ev: unknown, ctx: any) => void | Promise<void>): void;
};

export default function outfitterSpend(pi: PiExtensionApi): void {
  const spendFile = process.env.OUTFITTER_SPEND_FILE;
  if (!spendFile) return; // not running under agentd (or agentd didn't wire it up); nothing to do

  // A resumed session already has assistant turns (with their own cost) in its history. Starting
  // previousTotal at 0 would make the very first after_provider_response's delta equal to the whole
  // session's historical cost, not just this response's. `session_start` fires once, before any new
  // provider call, so its entries are exactly the prior history to baseline against; the
  // after_provider_response handler below also lazily initialises from its own ctx (before computing
  // the delta) as a fallback in case session_start doesn't fire first for some reason.
  let warned = false;
  let previousTotal: number | undefined;

  pi.on("session_start", (_ev, ctx) => {
    if (previousTotal === undefined) previousTotal = sessionCostTotal(ctx?.sessionManager?.getEntries?.() ?? []);
  });

  pi.on("after_provider_response", (ev, ctx) => {
    const headers = parseSpendHeaders(ev.headers);
    if (!headers.litellm) return;
    const entries = ctx?.sessionManager?.getEntries?.() ?? [];
    if (previousTotal === undefined) previousTotal = sessionCostTotal(entries);
    const currentTotal = sessionCostTotal(entries);
    const line = buildSpendLogLine(headers, currentTotal, previousTotal);
    previousTotal = currentTotal;
    try {
      appendFileSync(spendFile, `${JSON.stringify(line)}\n`);
    } catch (err: any) {
      // Best-effort: a write failure must not break the agent turn, but it must be visible: the
      // first cloud sessions lost every spend line to a permission error that this swallowed.
      if (!warned) {
        warned = true;
        process.stderr.write(`outfitter-spend: cannot append to ${spendFile}: ${err?.message ?? err}\n`);
      }
    }
  });
}
