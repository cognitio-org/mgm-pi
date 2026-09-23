// Maps a raw pi session entry (PiEntry, exactly as agentd/api hands it to the browser -- see
// outfitter/docs/protocol.md's "entry" frame and @earendil-works/pi-coding-agent's SessionEntry /
// @earendil-works/pi-ai's Message union) to a flat list of small, renderable view items. One entry
// can produce several items (an assistant message's content array mixes text/thinking/tool calls).
//
// Kept deliberately dumb: no markdown rendering, no syntax highlighting -- just enough structure
// for SessionTranscript's minimal components (see ../components/entries).

import type { PiEntry } from "../api/client.ts";

export type EntryView =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant-text"; id: string; text: string }
  | { kind: "assistant-thinking"; id: string; text: string }
  | { kind: "tool-call"; id: string; toolName: string; toolCallId: string; input: unknown }
  | { kind: "tool-result"; id: string; toolName: string; toolCallId: string; text: string; isError: boolean }
  | { kind: "system"; id: string; text: string }
  | { kind: "model-change"; id: string; provider: string; modelId: string }
  | { kind: "thinking-level-change"; id: string; thinkingLevel: string }
  | { kind: "compaction"; id: string; summary: string }
  | { kind: "custom"; id: string; customType: string; captureId?: string; title?: string; url?: string }
  | { kind: "label"; id: string; targetId: string; label?: string }
  | { kind: "session-info"; id: string; name?: string }
  | { kind: "unknown"; id: string; entryType: string };

/** pi customType for a browser capture (docs/specs/chrome-companion.md §14). */
export const BROWSER_CAPTURE_TYPE = "outfitter.browser.capture";

function textField(data: unknown, key: string): string {
  if (!data || typeof data !== "object") return "";
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text: string } => typeof c === "object" && c !== null && (c as { type?: string }).type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

/** Flattens one PiEntry into zero or more EntryView items, in the order they should render. */
export function entryToViews(entry: PiEntry): EntryView[] {
  const id = entry.id;

  switch (entry.type) {
    case "message": {
      const message = entry.message as
        | { role: "user"; content: unknown }
        | { role: "system"; content: unknown }
        | { role: "assistant"; content: unknown[] }
        | { role: "toolResult"; toolName: string; toolCallId: string; content: unknown; isError: boolean }
        | undefined;
      if (!message) return [{ kind: "unknown", id, entryType: "message" }];

      switch (message.role) {
        case "user":
          return [{ kind: "user", id, text: textOf(message.content) }];
        case "system":
          return [{ kind: "system", id, text: textOf(message.content) }];
        case "toolResult":
          return [
            {
              kind: "tool-result",
              id,
              toolName: message.toolName,
              toolCallId: message.toolCallId,
              text: textOf(message.content),
              isError: Boolean(message.isError),
            },
          ];
        case "assistant": {
          const blocks = Array.isArray(message.content) ? message.content : [];
          const views: EntryView[] = [];
          blocks.forEach((block, i) => {
            // pi's persisted content blocks (pi-ai's AssistantMessage content): text {text},
            // thinking {thinking, thinkingSignature}, toolCall {id, name, arguments}.
            const b = block as { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
            const blockId = `${id}#${i}`;
            if (b.type === "text") views.push({ kind: "assistant-text", id: blockId, text: b.text ?? "" });
            else if (b.type === "thinking") views.push({ kind: "assistant-thinking", id: blockId, text: b.thinking ?? "" });
            else if (b.type === "toolCall")
              views.push({
                kind: "tool-call",
                id: blockId,
                toolName: b.name ?? "unknown",
                toolCallId: b.id ?? blockId,
                input: b.arguments ?? {},
              });
          });
          return views;
        }
        default:
          return [{ kind: "unknown", id, entryType: "message" }];
      }
    }
    case "model_change":
      return [{ kind: "model-change", id, provider: String(entry.provider ?? ""), modelId: String(entry.modelId ?? "") }];
    // Bug 5b (docs/reports/cloud-fixes.md): pi's own thinking_level_change entry
    // (docs/session-format.md: `{type:"thinking_level_change", thinkingLevel, ...}`) had no case
    // here, so it fell through to "unknown" and rendered as "unrecognized entry:
    // thinking_level_change" in the transcript -- a normal, expected entry, not an error.
    case "thinking_level_change":
      return [{ kind: "thinking-level-change", id, thinkingLevel: String(entry.thinkingLevel ?? "") }];
    case "compaction":
      return [{ kind: "compaction", id, summary: String(entry.summary ?? "") }];
    case "custom": {
      const customType = String(entry.customType ?? "");
      // GroupedEntry is this view unchanged (thinking.ts). The jpeg route needs captureId;
      // title and url are the text under the image.
      if (customType === BROWSER_CAPTURE_TYPE) {
        return [
          {
            kind: "custom",
            id,
            customType,
            captureId: textField(entry.data, "captureId"),
            title: textField(entry.data, "title"),
            url: textField(entry.data, "url"),
          },
        ];
      }
      return [{ kind: "custom", id, customType }];
    }
    case "custom_message":
      return [{ kind: "system", id, text: textOf(entry.content) }];
    case "label":
      return [{ kind: "label", id, targetId: String(entry.targetId ?? ""), label: entry.label as string | undefined }];
    case "session_info":
      return [{ kind: "session-info", id, name: entry.name as string | undefined }];
    default:
      return [{ kind: "unknown", id, entryType: entry.type }];
  }
}

export function entriesToViews(entries: PiEntry[]): EntryView[] {
  return entries.flatMap(entryToViews);
}
