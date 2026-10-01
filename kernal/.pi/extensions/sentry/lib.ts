/** Pure logic for the Sentry extension's event handling; tested without pi or @sentry/node. */

/** The shape of AgentEndEvent.messages this extension needs — the full AgentMessage union has many
 * more fields and variants, none of which matter here. */
export type AgentEndMessage = { role: string; stopReason?: string; errorMessage?: string };

/** The last assistant error in an agent_end's messages, if the run ended in one. Mirrors
 * kernal-report/lib.ts's lastError, which does the same walk over session entries instead of a
 * single event's message list. */
export function agentRunError(messages: AgentEndMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.stopReason === "error") return m.errorMessage || "(error without message)";
  }
  return undefined;
}

/** Span attributes for a tool_execution span: just the tool name, kept low-cardinality (no raw
 * args/results — those can hold secrets and would blow the attribute size Sentry buffers). */
export function toolSpanAttributes(toolName: string): Record<string, string> {
  return { "kernal.tool": toolName };
}
