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

/**
 * What leaves the laptop, trimmed of who sent it: the machine's hostname (`server_name`, which
 * @sentry/node fills in, and which is usually the person's name) is dropped, and the home directory
 * in any path or message becomes `~`. The event is plain JSON, so one pass over its text catches
 * stack frames, exception values and breadcrumbs alike.
 */
export function scrubEvent<E extends object>(event: E, home: string): E {
  const { server_name: _host, ...rest } = event as E & { server_name?: string };
  if (!home || home === "/") return rest as E;
  const text = JSON.stringify(rest);
  const needle = JSON.stringify(home).slice(1, -1);
  return JSON.parse(text.split(needle).join("~")) as E;
}
