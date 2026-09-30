// Maps a raw pi session entry (PiEntry, exactly as agentd/api hands it to the browser -- see
// outfitter/docs/protocol.md's "entry" frame and @earendil-works/pi-coding-agent's SessionEntry /
// @earendil-works/pi-ai's Message union) to a flat list of small, renderable view items. One entry
// can produce several items (an assistant message's content array mixes text/thinking/tool calls).
//
// Kept deliberately dumb: no markdown rendering, no syntax highlighting -- just enough structure
// for SessionTranscript's minimal components (see ../components/entries).

import type { PiEntry } from "../api/client.ts";
import { GEMINI_EMPTY_STOP_TYPE, geminiEmptyStopAction, geminiEmptyStopNote } from "./gemini-empty-stop.ts";

export type UserImage = { mimeType: string; data: string };

export type RetryState = "retried" | "retrying" | "cancelled";

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
  /** An assistant message that ended in an error or was aborted. `retry` is set when pi hid it from
   * the model with a context_edit, which it writes before a retry's backoff: "retried" once a later
   * reply exists, "retrying" while the run is still going, "cancelled" when it stopped without one. */
  | { kind: "assistant-failed"; id: string; stopReason: "error" | "aborted"; errorMessage: string; retry?: RetryState }
  /** Context edits that aren't a failed attempt's retry: pi's own overflow recovery (a cut-off reply
   * and its tool results) or an extension's. Consecutive ones are one line; `count` of them. */
  | { kind: "context-edit"; id: string; count: number; replaced: boolean }
  | { kind: "custom"; id: string; customType: string; captureId?: string; title?: string; url?: string; text?: string }
  | { kind: "label"; id: string; targetId: string; label?: string }
  | { kind: "session-info"; id: string; name?: string }
  | { kind: "unknown"; id: string; entryType: string };

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
            views.push({ kind: "assistant-failed", id: `${id}#failed`, stopReason: stopReason as "error" | "aborted", errorMessage: errorMessage ?? "" });
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
      return [{ kind: "context-edit", id, count: 1, replaced: entry.replacement != null }];
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
      if (customType === GEMINI_EMPTY_STOP_TYPE) return [geminiEmptyStopView(entry)];
      return [{ kind: "custom", id, customType }];
    }
    case "custom_message":
      // display is otherwise ignored, so a hidden continuation would show up as a system line
      // of the model instruction. Only this marker is special-cased.
      if (String(entry.customType ?? "") === GEMINI_EMPTY_STOP_TYPE) return [geminiEmptyStopView(entry)];
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
// ngrok dropped every reply that ran past about five minutes). undici's is exactly "terminated".
const DROPPED = /APIConnectionError|payload is not completed|ECONNRESET|socket hang up|^(?:TypeError: )?terminated$|SSLError/i;

/** The failed row's headline and one-line explanation. */
export function failedAttemptCopy(view: Extract<EntryView, { kind: "assistant-failed" }>): { headline: string; note: string } {
  if (view.stopReason === "aborted") return { headline: "Reply stopped", note: "The reply was stopped before it finished." };
  const cause = DROPPED.test(view.errorMessage) ? "The connection to the model dropped" : "The model call failed";
  switch (view.retry) {
    case "retried":
      return { headline: "Attempt failed, retried", note: `${cause}. pi hid this attempt from the model and tried again.` };
    case "retrying":
      return { headline: "Attempt failed, retrying", note: `${cause}. pi hid this attempt from the model and is trying again.` };
    case "cancelled":
      return { headline: "Attempt failed", note: `${cause}. pi hid this attempt from the model, but the retry was stopped.` };
    default:
      return { headline: "Model call failed", note: `${cause}.` };
  }
}

function geminiEmptyStopView(entry: PiEntry): EntryView {
  const text = geminiEmptyStopNote(geminiEmptyStopAction(entry));
  return { kind: "custom", id: entry.id, customType: GEMINI_EMPTY_STOP_TYPE, ...(text ? { text } : {}) };
}

function isAssistantEntry(entry: PiEntry): boolean {
  return entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "assistant";
}

/** Ids of entries a later context_edit hid from the model (replacement null). */
export function hiddenEntryIds(entries: PiEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) if (entry.type === "context_edit" && entry.replacement == null) ids.add(String(entry.targetId ?? ""));
  return ids;
}

/** `runSettled`: the run is idle, stopped, or failed, so a hidden attempt with no later reply was
 * not retried after all (Stop during pi's backoff). */
export function entriesToViews(entries: PiEntry[], options?: { runSettled?: boolean }): EntryView[] {
  // pi retries a failed model call after hiding the failed attempt from the model with a
  // context_edit. That edit is the failed row's retry state, not a line of its own.
  const hidden = hiddenEntryIds(entries);
  const retryOf = new Map<string, RetryState>();
  const failedIds = new Set<string>();
  let laterReply = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (!isAssistantEntry(entry)) continue;
    const stopReason = (entry.message as { stopReason?: string }).stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      failedIds.add(entry.id);
      if (hidden.has(entry.id)) retryOf.set(entry.id, laterReply ? "retried" : options?.runSettled ? "cancelled" : "retrying");
    }
    laterReply = true;
  }
  const out: EntryView[] = [];
  for (const entry of entries) {
    if (entry.type === "context_edit" && entry.replacement == null && failedIds.has(String(entry.targetId ?? ""))) continue;
    for (const view of entryToViews(entry)) {
      const last = out.at(-1);
      if (view.kind === "context-edit" && last?.kind === "context-edit" && last.replaced === view.replaced) {
        out[out.length - 1] = { ...last, count: last.count + 1 };
        continue;
      }
      const retry = retryOf.get(entry.id);
      out.push(view.kind === "assistant-failed" && retry ? { ...view, retry } : view);
    }
  }
  return out;
}
