// E3.8 (EPIC.md "Gurus page" / "session header"): derives model, thinking level and context use
// from the transcript entries SessionPage already has -- zero protocol change (docs/protocol.md's
// `entry` frames already carry model_change/thinking_level_change entries and each assistant
// message's provider/model/usage, exactly as pi writes them to its own session JSONL).
//
// Mirrors pi's own AgentSession.getContextUsage() (dist/core/agent-session.js): context tokens come
// from the newest assistant message's usage (skipping aborted/error turns), and
// calculateContextTokens (dist/core/compaction/compaction.js) is `usage.totalTokens ||
// (input + output + cacheRead + cacheWrite)`.

import type { PiEntry } from "../api/client.ts";

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface SessionContextUsage {
  tokens: number;
  /** Absent when GET /api/models has no row (or no contextWindow) for the resolved model. */
  window?: number;
  /** 0-100, only set alongside `window`. */
  percent?: number;
}

export interface SessionHeaderInfo {
  /** "provider/model", from the newest of a model_change entry or an assistant message's own
   * provider/model field (whichever is more recent in the transcript). */
  model?: string;
  /** From the newest thinking_level_change entry. */
  thinking?: string;
  context?: SessionContextUsage;
}

/** pi's calculateContextTokens: prefers the native totalTokens field, else sums the components.
 * Returns undefined (not 0) when there's nothing usable, so callers can tell "no usage yet" apart
 * from "usage was all zero". */
function contextTokensFromUsage(usage: UsageLike | undefined): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) return usage.totalTokens;
  const sum = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return sum > 0 ? sum : undefined;
}

interface AssistantMessageLike {
  role?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  usage?: UsageLike;
}

/** Looks up a model's context window from GET /api/models' rows (SessionPage fetches them once and
 * passes a lookup in), by exact "provider/id" match. */
export type WindowLookup = (modelId: string) => number | undefined;

/** Pure derivation over a session's entries (in tree/arrival order, as the API and SSE stream
 * already hand them to the page) -- no network, no React, fully unit-testable. */
export function deriveSessionHeader(entries: PiEntry[], windowFor?: WindowLookup): SessionHeaderInfo {
  let model: string | undefined;
  let thinking: string | undefined;
  let contextTokens: number | undefined;

  for (const entry of entries) {
    if (entry.type === "model_change") {
      const provider = String(entry.provider ?? "");
      const modelId = String(entry.modelId ?? "");
      if (provider && modelId) model = `${provider}/${modelId}`;
      continue;
    }
    if (entry.type === "thinking_level_change") {
      const level = entry.thinkingLevel;
      if (typeof level === "string" && level) thinking = level;
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.message as AssistantMessageLike | undefined;
    if (!message || message.role !== "assistant") continue;

    if (message.provider && message.model) model = `${message.provider}/${message.model}`;

    // Mirrors pi's getAssistantUsage: skip aborted/error turns, and a zero/empty usage never
    // overwrites a previously-known good reading.
    if (message.stopReason === "aborted" || message.stopReason === "error") continue;
    const tokens = contextTokensFromUsage(message.usage);
    if (tokens !== undefined) contextTokens = tokens;
  }

  const context: SessionContextUsage | undefined =
    contextTokens === undefined
      ? undefined
      : (() => {
          const window = model ? windowFor?.(model) : undefined;
          return window && window > 0
            ? { tokens: contextTokens, window, percent: (contextTokens / window) * 100 }
            : { tokens: contextTokens };
        })();

  return { model, thinking, context };
}
