// Maps a raw pi session entry (PiEntry, exactly as agentd/api hands it to the browser -- see
// outfitter/docs/protocol.md's "entry" frame and @earendil-works/pi-coding-agent's SessionEntry /
// @earendil-works/pi-ai's Message union) to a flat list of small, renderable view items. One entry
// can produce several items (an assistant message's content array mixes text/thinking/tool calls).
//
// Kept deliberately dumb: no markdown rendering, no syntax highlighting -- just enough structure
// for SessionTranscript's minimal components (see ../components/entries).

import type { PiEntry } from "../api/client.ts";

export type UserImage = { mimeType: string; data: string };

export type EntryView =
  | { kind: "user"; id: string; text: string; images?: UserImage[] }
  | { kind: "assistant-text"; id: string; text: string }
  | { kind: "assistant-thinking"; id: string; text: string }
  | { kind: "tool-call"; id: string; toolName: string; toolCallId: string; input: unknown; interrupted?: boolean }
  | { kind: "tool-result"; id: string; toolName: string; toolCallId: string; text: string; isError: boolean }
  | { kind: "system"; id: string; text: string }
  | { kind: "model-change"; id: string; provider: string; modelId: string }
  | { kind: "thinking-level-change"; id: string; thinkingLevel: string }
  | { kind: "compaction"; id: string; summary: string }
  /** An assistant message that ended in an error or was aborted. `hidden`: pi dropped it from the
   * model's context with a context_edit, which it does before retrying (so a retry follows). */
  | { kind: "assistant-failed"; id: string; stopReason: "error" | "aborted"; errorMessage: string; hidden?: boolean }
  /** A context_edit that isn't a retry of a failed attempt (an extension edited the model's context). */
  | { kind: "context-edit"; id: string; targetId: string; replaced: boolean }
  | { kind: "custom"; id: string; customType: string; captureId?: string; title?: string; url?: string; text?: string }
  | { kind: "label"; id: string; targetId: string; label?: string }
  | { kind: "session-info"; id: string; name?: string }
  | { kind: "unknown"; id: string; entryType: string };

/** Appended to a failed assistant entry's id for its assistant-failed view. */
const FAILED_SUFFIX = "#failed";

/** pi customType for a browser capture (docs/specs/chrome-companion.md §14). */
export const BROWSER_CAPTURE_TYPE = "outfitter.browser.capture";

/** pi customType for the optional Playwright check before checkpoint (docs/protocol.md). */
export const PLAYWRIGHT_CHECK_TYPE = "outfitter.playwright";

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

// pi image blocks are `{ type: "image", data, mimeType }` with raw base64 — no `data:` prefix.
// Only user messages carry them; other roles stay text-only.
function imagesOf(content: unknown): UserImage[] {
  if (!Array.isArray(content)) return [];
  const images: UserImage[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (b.type !== "image" || typeof b.data !== "string" || typeof b.mimeType !== "string") continue;
    images.push({ mimeType: b.mimeType, data: b.data });
  }
  return images;
}

/** `data` is raw base64, not a data URL. */
export function imageSrc(image: UserImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function userView(id: string, content: unknown): EntryView {
  const text = textOf(content);
  const images = imagesOf(content);
  if (images.length === 0) return { kind: "user", id, text };
  return { kind: "user", id, text, images };
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
          return [userView(id, message.content)];
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
          const { stopReason, errorMessage } = message as { stopReason?: string; errorMessage?: string };
          const failed = stopReason === "error" || stopReason === "aborted";
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
                // A call in a reply that failed or was stopped never ran: pi executes no tool calls
                // from such a message, and its arguments may be cut off mid-stream.
                ...(failed ? { interrupted: true } : {}),
              });
          });
          if (failed)
            views.push({ kind: "assistant-failed", id: `${id}${FAILED_SUFFIX}`, stopReason: stopReason as "error" | "aborted", errorMessage: errorMessage ?? "" });
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
    // pi 0.87: hides (replacement null) or replaces an earlier message in the model's context only;
    // the transcript keeps the message. entriesToViews folds a retry's edit into the failed row.
    case "context_edit":
      return [{ kind: "context-edit", id, targetId: String(entry.targetId ?? ""), replaced: entry.replacement != null }];
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
      if (customType === PLAYWRIGHT_CHECK_TYPE) {
        return [{ kind: "custom", id, customType, text: textField(entry.data, "text") }];
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

// LiteLLM's and undici's wording for a stream that closed partway (#278: a local model behind
// ngrok dropped every reply that ran past about five minutes).
const DROPPED = /APIConnectionError|payload is not completed|ECONNRESET|socket hang up|terminated|SSLError/i;

/** The failed row's headline and one-line explanation. */
export function failedAttemptCopy(view: Extract<EntryView, { kind: "assistant-failed" }>): { headline: string; note: string } {
  if (view.stopReason === "aborted") return { headline: "Reply stopped", note: "The reply was stopped before it finished." };
  const cause = DROPPED.test(view.errorMessage) ? "The connection to the model dropped" : "The model call failed";
  return view.hidden
    ? { headline: "Attempt failed, retrying", note: `${cause}. pi hid this attempt from the model and tried again.` }
    : { headline: "Model call failed", note: `${cause}.` };
}

export function entriesToViews(entries: PiEntry[]): EntryView[] {
  const views = entries.flatMap(entryToViews);
  // pi retries a failed model call after hiding the failed attempt from the model with a
  // context_edit. That edit is the failed row's "retrying", not a line of its own.
  const failedById = new Map<string, Extract<EntryView, { kind: "assistant-failed" }>>();
  for (const view of views) if (view.kind === "assistant-failed") failedById.set(view.id.slice(0, -FAILED_SUFFIX.length), view);
  return views.flatMap((view): EntryView[] => {
    if (view.kind !== "context-edit") return [view];
    const failed = failedById.get(view.targetId);
    if (!failed || view.replaced) return [view];
    failed.hidden = true;
    return [];
  });
}
