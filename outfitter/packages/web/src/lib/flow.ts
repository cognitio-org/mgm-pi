// #498: the transcript as one flowing column, in the order things happened (docs/design/
// sessions-redesign-demo.html notes 4-6). beats.ts groups tools under the message that announced
// them, for the old chip rail; this keeps the order instead, so a turn reads top to bottom:
// thought, prose, tool rows, prose.
//
// A tool call and its result that share a toolCallId are one item, wherever the result lands (the
// same rules as beats.ts: a call with no result is running only while its turn still is). Two or
// more finished look-ups in a row (read, grep, find, ls) fold into one "Read 3 files" item.

import type { PiEntry } from "../api/client.ts";
import type { GroupedEntry, ThinkingBlock } from "./thinking.ts";
import { isLookup, toolKind } from "./tool-rows.ts";

export interface FlowTool {
  kind: "tool";
  id: string;
  toolName: string;
  toolCallId: string;
  /** Absent on an orphan result. */
  input?: unknown;
  /** Absent while the call is running. */
  output?: string;
  isError: boolean;
  running: boolean;
  /** The reply carrying this call failed or was stopped, so the call never ran. */
  interrupted?: boolean;
}

type UserView = Extract<GroupedEntry, { kind: "user" }>;
type PassView = Exclude<GroupedEntry, { kind: "user" | "assistant-text" | "thinking-group" | "tool-call" | "tool-result" }>;

export type FlowItem =
  | { kind: "user"; id: string; view: UserView }
  | { kind: "prose"; id: string; text: string }
  | { kind: "thinking"; id: string; blocks: ThinkingBlock[]; seconds?: number }
  | FlowTool
  | { kind: "lookups"; id: string; tools: FlowTool[] }
  | { kind: "passthrough"; id: string; view: PassView };

/** The entry a view came from: view ids are the entry id, or `<entry id>#<block>` (entry-view.ts). */
export function entryIdOf(viewId: string): string {
  const id = viewId.startsWith("thinking-group:") ? viewId.slice("thinking-group:".length) : viewId;
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

function timeOf(entry: PiEntry | undefined): number | undefined {
  const raw = entry?.timestamp;
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}

/** How long each thinking reply took, by entry id: from the entry before it (the prompt or the last
 * tool result) to the reply itself. That covers the whole model call, which is what "Thought for
 * 4s" means to a reader. Missing timestamps leave the entry out. */
export function thinkingSeconds(entries: PiEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (!message.content.some((b) => (b as { type?: string })?.type === "thinking")) continue;
    const end = timeOf(entry);
    const start = timeOf(entries[i - 1]);
    if (end === undefined || start === undefined || end < start) continue;
    out.set(entry.id, Math.max(1, Math.round((end - start) / 1000)));
  }
  return out;
}

function foldLookups(items: FlowItem[]): FlowItem[] {
  const out: FlowItem[] = [];
  let run: FlowTool[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: "lookups", id: run[0]!.id, tools: run });
    else out.push(...run);
    run = [];
  };
  for (const item of items) {
    const foldable = item.kind === "tool" && isLookup(toolKind(item.toolName)) && !item.running && !item.isError && !item.interrupted;
    if (foldable) {
      run.push(item);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

export function buildFlow(views: GroupedEntry[], options?: { runSettled?: boolean; seconds?: Map<string, number> }): FlowItem[] {
  const items: FlowItem[] = [];
  // The unpaired half of a tool (a running call, or a result that arrived first).
  const pending = new Map<string, FlowTool>();
  // Calls whose turn already ended. A result that shows up later still fills the same item.
  const closed = new Map<string, FlowTool>();

  function finishOpenCalls() {
    for (const [id, item] of pending) {
      item.running = false;
      closed.set(id, item);
    }
    pending.clear();
  }

  for (const view of views) {
    switch (view.kind) {
      case "user":
        finishOpenCalls();
        items.push({ kind: "user", id: view.id, view });
        break;
      case "assistant-text":
        if (view.text.trim()) items.push({ kind: "prose", id: view.id, text: view.text });
        break;
      case "thinking-group": {
        const seconds = options?.seconds?.get(entryIdOf(view.id));
        items.push({ kind: "thinking", id: view.id, blocks: view.blocks, ...(seconds !== undefined ? { seconds } : {}) });
        break;
      }
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
        const item: FlowTool = {
          kind: "tool",
          id: view.id,
          toolName: view.toolName,
          toolCallId: view.toolCallId,
          input: view.input,
          isError: false,
          running: !view.interrupted,
          ...(view.interrupted ? { interrupted: true } : {}),
        };
        items.push(item);
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
        const item: FlowTool = {
          kind: "tool",
          id: view.id,
          toolName: view.toolName,
          toolCallId: view.toolCallId,
          output: view.text,
          isError: view.isError,
          running: false,
        };
        items.push(item);
        pending.set(view.toolCallId, item);
        break;
      }
      default:
        items.push({ kind: "passthrough", id: view.id, view });
        break;
    }
  }
  if (options?.runSettled) finishOpenCalls();
  return foldLookups(items);
}

/** The thought still being written (#285): the newest thinking item, while the run is live and no
 * prose has come after it. Tool rows after it don't end it -- the same reply often calls tools. */
export function liveThinkingId(items: FlowItem[], runLive: boolean): string | null {
  if (!runLive) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "thinking") return item.id;
    if (item.kind !== "tool" && item.kind !== "lookups") return null;
  }
  return null;
}

/** #273: the newest `vscode` call that ran, whose chip is the live one. */
export function lastVsCodeToolId(items: FlowItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "tool" && item.toolName === "vscode" && !item.isError && !item.interrupted) return item.id;
  }
  return undefined;
}

/** The tool running right now, for the live status line's verb. */
export function runningTool(items: FlowItem[]): FlowTool | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "tool" && item.running) return item;
  }
  return null;
}
