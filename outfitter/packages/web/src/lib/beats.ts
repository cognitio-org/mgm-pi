// Groups a transcript (already passed through groupThinkingBlocks) into beats.
// A beat is one message and the work around it, shown as one row of chips under the text:
// - thinking starts a new beat: it is what the model did before writing, so it goes with the
//   message that follows it (and so do tools called after that thought, before any text);
// - a tool called after a message, with no thinking in between, belongs to that message: the
//   message announced it ("I'll run the tests") and the chip sits right under those words;
// - tools with no message to attach to (the start of a turn, or after a thought) form a
//   tools-only beat until a message arrives and claims them.
// A tool call and the result that share a toolCallId are one rail item, including when an
// assistant-text closed the run between them: the result fills the call in place and does not
// start a second item. A call with no result is running only while its turn still is: the next
// user message, or a run that has gone idle, stopped, or failed, ends it.

import type { GroupedEntry, ThinkingBlock } from "./thinking.ts";

export interface RailThinking {
  kind: "thinking";
  id: string;
  blocks: ThinkingBlock[];
}

export interface RailTool {
  kind: "tool";
  id: string;
  toolName: string;
  toolCallId: string;
  /** Present once a call has been seen. Omitted on an orphan result. */
  input?: unknown;
  /** Omitted while the call is still running. */
  output?: string;
  isError: boolean;
  running: boolean;
  /** The reply carrying this call failed or was stopped, so the call never ran. */
  interrupted?: boolean;
}

export type RailItem = RailThinking | RailTool;

/** Id of the row that shows a thought before its message is an entry (#285). */
export const STREAMED_THOUGHT_ID = "live-thought";

export function railThinkingText(item: RailThinking): string {
  return item.blocks.map((block) => block.text).join("\n\n");
}

/** A thinking rail item for text that is still streaming and not in the transcript yet. */
export function streamedThoughtItem(text: string): RailThinking {
  return { kind: "thinking", id: STREAMED_THOUGHT_ID, blocks: [{ id: STREAMED_THOUGHT_ID, text }] };
}

type UserView = Extract<GroupedEntry, { kind: "user" }>;

type PassView = Extract<
  GroupedEntry,
  {
    kind:
      | "system"
      | "model-change"
      | "thinking-level-change"
      | "compaction"
      | "assistant-failed"
      | "context-edit"
      | "custom"
      | "label"
      | "session-info"
      | "unknown";
  }
>;

export interface UserBeat {
  kind: "user";
  id: string;
  /** The whole user view, so a later field (images) rides along without regrouping. */
  view: UserView;
}

export interface PassThroughBeat {
  kind: "passthrough";
  id: string;
  view: PassView;
}

export interface AssistantBeat {
  kind: "assistant";
  id: string;
  /** The prose's own view id. `id` is the first rail item's when there is one, which may belong to
   * an earlier entry; this one always names the entry the prose came from. */
  proseId: string;
  prose: string;
  rail: RailItem[];
}

export interface ToolsOnlyBeat {
  kind: "tools-only";
  id: string;
  rail: RailItem[];
}

export type Beat = UserBeat | PassThroughBeat | AssistantBeat | ToolsOnlyBeat;

export type RailGlyph =
  | { kind: "single"; item: RailItem }
  | { kind: "batch"; id: string; tools: RailTool[] };

/** Finished non-error tools beyond this stay as one glyph. Thinking, errors, and running or interrupted calls do not count. */
const COLLAPSE_AT = 4;

function isFinishedTool(item: RailItem): item is RailTool {
  return item.kind === "tool" && !item.running && !item.isError && !item.interrupted;
}

export function collapseRail(items: RailItem[]): RailGlyph[] {
  const finished = items.filter(isFinishedTool);
  if (finished.length <= COLLAPSE_AT) return items.map((item) => ({ kind: "single", item }));

  const batch: RailGlyph = { kind: "batch", id: finished[0]!.id, tools: finished };
  const glyphs: RailGlyph[] = [];
  let placed = false;
  for (const item of items) {
    if (isFinishedTool(item)) {
      if (!placed) {
        glyphs.push(batch);
        placed = true;
      }
      continue;
    }
    glyphs.push({ kind: "single", item });
  }
  return glyphs;
}

export function groupBeats(views: GroupedEntry[], options?: { runSettled?: boolean }): Beat[] {
  const beats: Beat[] = [];
  let rail: RailItem[] = [];
  // The message that later tools attach to: the latest prose of this turn, until a thought or
  // anything that isn't the model's own work comes between.
  let lastProse: AssistantBeat | null = null;
  // Where a new tool item goes: under the latest message, or onto the open tools-only rail.
  const toolRail = (): RailItem[] => (rail.length === 0 && lastProse ? lastProse.rail : rail);
  // The unpaired half of a tool (a running call, or a result that arrived first).
  const pending = new Map<string, RailTool>();
  // Calls whose turn already ended. A result that shows up later still fills the same item.
  const closed = new Map<string, RailTool>();

  function flushTools() {
    if (rail.length === 0) return;
    beats.push({ kind: "tools-only", id: rail[0]!.id, rail });
    rail = [];
  }

  function finishOpenCalls() {
    for (const [id, item] of pending) {
      if (item.running) item.running = false;
      closed.set(id, item);
    }
    pending.clear();
  }

  for (const view of views) {
    switch (view.kind) {
      case "user":
        finishOpenCalls();
        flushTools();
        lastProse = null;
        beats.push({ kind: "user", id: view.id, view });
        break;
      case "system":
      case "model-change":
      case "thinking-level-change":
      case "compaction":
      case "assistant-failed":
      case "context-edit":
      case "custom":
      case "label":
      case "session-info":
      case "unknown":
        flushTools();
        lastProse = null;
        beats.push({ kind: "passthrough", id: view.id, view });
        break;
      case "thinking-group":
        lastProse = null;
        rail.push({ kind: "thinking", id: view.id, blocks: view.blocks });
        break;
      case "tool-call": {
        const existing = pending.get(view.toolCallId) ?? closed.get(view.toolCallId);
        if (existing && existing.output !== undefined && existing.input === undefined) {
          existing.input = view.input;
          existing.toolName = view.toolName || existing.toolName;
          existing.running = false;
          pending.delete(view.toolCallId);
          closed.delete(view.toolCallId);
          break;
        }
        const item: RailTool = {
          kind: "tool",
          id: view.id,
          toolName: view.toolName,
          toolCallId: view.toolCallId,
          input: view.input,
          isError: false,
          running: !view.interrupted,
          ...(view.interrupted ? { interrupted: true } : {}),
        };
        toolRail().push(item);
        if (!view.interrupted) pending.set(view.toolCallId, item);
        break;
      }
      case "tool-result": {
        const existing = pending.get(view.toolCallId) ?? closed.get(view.toolCallId);
        if (existing && (existing.running || existing.output === undefined)) {
          existing.output = view.text;
          existing.isError = view.isError;
          existing.running = false;
          if (!existing.toolName) existing.toolName = view.toolName;
          pending.delete(view.toolCallId);
          closed.delete(view.toolCallId);
          break;
        }
        const item: RailTool = {
          kind: "tool",
          id: view.id,
          toolName: view.toolName,
          toolCallId: view.toolCallId,
          output: view.text,
          isError: view.isError,
          running: false,
        };
        toolRail().push(item);
        pending.set(view.toolCallId, item);
        break;
      }
      case "assistant-text": {
        const beat: AssistantBeat = { kind: "assistant", id: rail[0]?.id ?? view.id, proseId: view.id, prose: view.text, rail };
        beats.push(beat);
        lastProse = beat;
        rail = [];
        break;
      }
      default: {
        const unreachable: never = view;
        throw new Error(`unexpected view ${(unreachable as { kind: string }).kind}`);
      }
    }
  }

  if (options?.runSettled) finishOpenCalls();
  flushTools();
  return beats;
}

/** The open turn's thought (#285). A tool call is often in the same message as the thinking,
 * and on the web role that message arrives after the tokens, so hiding the bubble as soon as
 * a tool is on the rail means the words never appear. The bubble keeps the latest thought on
 * this tools-only beat until the model writes a sentence or the run leaves `running`. */
export function liveThinkingItem(beats: Beat[], runLive: boolean): RailThinking | null {
  if (!runLive) return null;
  const last = beats[beats.length - 1];
  if (!last || last.kind !== "tools-only") return null;
  for (let i = last.rail.length - 1; i >= 0; i--) {
    const item = last.rail[i];
    if (item?.kind === "thinking") return item;
  }
  return null;
}
