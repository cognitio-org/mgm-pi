// #498: the live status line above the composer while a turn runs (docs/design/
// sessions-redesign-demo.html note 7): what it's doing, for how long, and how many tokens the
// model has written this turn. The words come from data the page already has: the running tool
// row, else deriveSessionActivity's label.

import type { PiEntry } from "../api/client.ts";
import type { FlowTool } from "./flow.ts";
import { toolArgument, toolKind } from "./tool-rows.ts";

function isUser(entry: PiEntry): boolean {
  return entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "user";
}

function timeOf(entry: PiEntry): number | undefined {
  const raw = entry.timestamp;
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}

/** When this turn started: the newest prompt, or the send still on its way if that's later. */
export function turnStartedAt(entries: PiEntry[], sentAt?: number): number | undefined {
  let started: number | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isUser(entries[i]!)) continue;
    started = timeOf(entries[i]!);
    break;
  }
  if (sentAt !== undefined && (started === undefined || sentAt > started)) return sentAt;
  return started;
}

/** Output tokens the model has written since the newest prompt (each reply's usage.output). */
export function turnOutputTokens(entries: PiEntry[]): number {
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (isUser(entry)) break;
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; usage?: { output?: number } } | undefined;
    if (message?.role === "assistant" && typeof message.usage?.output === "number") total += message.usage.output;
  }
  return total;
}

/** "Running npm test", "Reading src/app.ts" -- the verb for the tool in flight. */
export function toolVerb(tool: Pick<FlowTool, "toolName" | "input">): string {
  const arg = toolArgument(tool.toolName, tool.input);
  const clip = arg.length > 48 ? `${arg.slice(0, 48).trimEnd()}…` : arg;
  switch (toolKind(tool.toolName)) {
    case "bash":
      return clip ? `Running ${clip}` : "Running a command";
    case "read":
      return clip ? `Reading ${clip}` : "Reading";
    case "search":
      return clip ? `Searching ${clip}` : "Searching";
    case "list":
      return "Looking through files";
    case "edit":
      return clip ? `Editing ${clip}` : "Editing";
    case "write":
      return clip ? `Writing ${clip}` : "Writing";
    default:
      return `Using ${tool.toolName}`;
  }
}

/** "48s", "2m 05s". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** "840", "18.4k", "1.2M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
