// Pure helpers for collapsing "assistant-thinking" EntryViews into one collapsed row per run of
// consecutive thinking blocks -- see docs/reports/mobile-desk.md's "Thinking, Kernal naming, error
// vocabulary" section. Kept dumb and framework-free so every piece here is unit-testable without a
// DOM: EntryItem.tsx / SessionPage.tsx own the actual rendering (desktop <details>, mobile chip).

import type { EntryView } from "./entry-view.ts";

export interface ThinkingBlock {
  id: string;
  text: string;
}

export interface ThinkingGroupView {
  kind: "thinking-group";
  id: string;
  blocks: ThinkingBlock[];
}

/** Anything SessionPage renders after grouping: every non-thinking EntryView passes through
 * unchanged, and every run of one-or-more consecutive "assistant-thinking" views becomes a single
 * ThinkingGroupView. */
export type GroupedEntry = ThinkingGroupView | Exclude<EntryView, { kind: "assistant-thinking" }>;

const ELLIPSIS = "…";

/** First ~`maxChars` characters of `text`, whitespace collapsed to single spaces, with a trailing
 * ellipsis when it was actually truncated (never on text that already fit). Empty/whitespace-only
 * text returns "". */
export function thinkingPreview(text: string, maxChars = 80): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars).trimEnd()}${ELLIPSIS}`;
}

/** Word count for the collapsed-row label ("142 words") -- splits on whitespace, dropping empty
 * runs so leading/trailing/repeated whitespace never inflates the count. */
export function thinkingWordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** "142 words" / "1 word" -- the plain-language half of the accessible label. */
export function thinkingWordLabel(text: string): string {
  const n = thinkingWordCount(text);
  return `${n} word${n === 1 ? "" : "s"}`;
}

/** `{expanded ? "Hide" : "Show"} thinking, 142 words` -- the full accessible label for a
 * collapsed/expandable thinking row (desktop <summary> and the mobile chip both use this). */
export function thinkingAccessibleLabel(text: string, expanded: boolean): string {
  return `${expanded ? "Hide" : "Show"} thinking, ${thinkingWordLabel(text)}`;
}

/** Groups consecutive "assistant-thinking" views into one ThinkingGroupView each, leaving every
 * other view (including single thinking blocks -- a "group" of one is still a group, so EntryItem
 * only needs to handle one shape) untouched and in order. Pure: same input always produces
 * structurally-equal output, and a group's id is derived from its first block's id so re-grouping
 * the same still-in-progress run (one more thinking block streamed in) keeps a stable React key. */
export function groupThinkingBlocks(views: EntryView[]): GroupedEntry[] {
  const out: GroupedEntry[] = [];
  let run: ThinkingBlock[] = [];

  function flush() {
    if (run.length === 0) return;
    out.push({ kind: "thinking-group", id: `thinking-group:${run[0]!.id}`, blocks: run });
    run = [];
  }

  for (const view of views) {
    if (view.kind === "assistant-thinking") {
      run.push({ id: view.id, text: view.text });
    } else {
      flush();
      out.push(view as GroupedEntry);
    }
  }
  flush();

  return out;
}
