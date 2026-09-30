// Transcript copy for kernal's Gemini thought-only STOP marker (kernal/.pi/extensions/kernal-gemini-stop).
// The model instruction stays in the custom_message content and is not rendered. Read-aloud speaks
// assistant messages only, so this note is a custom view on purpose.

import type { PiEntry } from "../api/client.ts";

export const GEMINI_EMPTY_STOP_TYPE = "kernal.gemini-empty-stop";

export const GEMINI_EMPTY_STOP_CONTINUE =
  "Gemini ended this turn with a thought and no reply. Asking it to continue.";

export const GEMINI_EMPTY_STOP_CAPPED =
  "Gemini ended this turn with a thought and no reply, twice. Not asking again.";

export function geminiEmptyStopNote(action: unknown): string | undefined {
  if (action === "continue") return GEMINI_EMPTY_STOP_CONTINUE;
  if (action === "capped") return GEMINI_EMPTY_STOP_CAPPED;
  return undefined;
}

/** Continue markers store the action on custom_message `details`; the cap stores it on custom `data`. */
export function geminiEmptyStopAction(entry: PiEntry): unknown {
  const bag = entry.type === "custom" ? entry.data : entry.details;
  if (!bag || typeof bag !== "object") return undefined;
  return (bag as { action?: unknown }).action;
}
