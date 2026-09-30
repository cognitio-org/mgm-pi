/** The open assistant message's thinking text (#285), or null when this pi event isn't one.
 * An empty string means a thinking block has started and no words have arrived.
 * pi's `partial` is the response so far: thinking blocks grow across `thinking_delta`
 * and are complete at `thinking_end`. Token deltas other than this stay off the store. */
export function liveThoughtTextFromEvent(event: { type?: string; assistantMessageEvent?: unknown }): string | null {
  if (event.type !== "message_update") return null;
  const update = event.assistantMessageEvent;
  if (!update || typeof update !== "object") return null;
  const kind = (update as { type?: unknown }).type;
  if (kind !== "thinking_start" && kind !== "thinking_delta" && kind !== "thinking_end") return null;
  return thinkingTextFromPartial((update as { partial?: unknown }).partial);
}

function thinkingTextFromPartial(partial: unknown): string {
  if (!partial || typeof partial !== "object") return "";
  const content = (partial as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; thinking?: unknown };
    if (rec.type !== "thinking" || typeof rec.thinking !== "string" || rec.thinking.length === 0) continue;
    parts.push(rec.thinking);
  }
  return parts.join("\n\n");
}

/** An assistant message entry is the open thought landing in the transcript. Tool results
 * and user lines are not: a thought can still be streaming around them. */
export function isAssistantMessageEntry(entry: { type?: string; message?: unknown }): boolean {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return false;
  return (entry.message as { role?: unknown }).role === "assistant";
}
