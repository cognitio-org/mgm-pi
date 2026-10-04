/**
 * AI agent monitoring (#424): what Kernal's agent runs, model calls and tool calls look like as
 * Sentry gen_ai spans and counters. Pure functions over pi's event payloads, so the tests check
 * every attribute name and every redaction without pi or @sentry/node; index.ts wires them up.
 *
 * Span names, ops and attribute keys follow Sentry's conventions as shipped with @sentry/node 11.2.0
 * (@sentry/conventions 0.24: `gen_ai.invoke_agent` / `gen_ai.chat` / `gen_ai.execute_tool`,
 * `gen_ai.usage.*`, `gen_ai.cost.*`, `gen_ai.input.messages` and so on), using the current keys, not
 * their deprecated aliases. Sentry's AI Agents views read exactly these.
 *
 * Content (prompts, outputs, tool arguments and results) is a separate signal (agentContent):
 *   - every string goes through _shared/redact.ts first, then is cut to FIELD_LIMIT_BYTES of UTF-8;
 *   - the system prompt is never recorded (pi's `context` event leaves it out, and nothing here asks
 *     for it), so whatever it embeds stays on the laptop;
 *   - a run records at most RUN_CONTENT_BUDGET_BYTES of it, so a long run can't grow one transaction
 *     past what Sentry accepts;
 *   - the home directory becomes `~` at send time, like every other string (lib.ts scrubEvent).
 */
import { redact } from "../_shared/redact.ts";

/** One content attribute's size, in UTF-8 bytes, after redaction. */
export const FIELD_LIMIT_BYTES = 8 * 1024;
/** All the content one agent run records, across its spans. */
export const RUN_CONTENT_BUDGET_BYTES = 256 * 1024;
const TRUNCATED = "…[truncated]";

export const AGENT_NAME = "kernal";

export type Attributes = Record<string, string | number | boolean>;

/** The counters (Sentry.metrics.count), each sent only while the metrics signal is on. */
export const METRICS = {
  agentRuns: "kernal.agent.runs",
  toolCalls: "kernal.tool.calls",
  modelCalls: "kernal.model.calls",
  inputTokens: "kernal.tokens.input",
  outputTokens: "kernal.tokens.output",
  costUsd: "kernal.model.cost_usd",
  errors: "kernal.errors",
} as const;

// ---------- text ----------

/** `text` cut to at most `maxBytes` of UTF-8, on a character boundary, marked when cut. */
export function truncateUtf8(text: string, maxBytes = FIELD_LIMIT_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const room = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATED, "utf8"));
  let cut = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
  // A cut through a multi-byte character decodes to U+FFFD; drop it.
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return cut + TRUNCATED;
}

/** Redacted, then truncated: the order matters, a cut must not leave half a key unrecognised. */
export function cleanText(text: string, maxBytes = FIELD_LIMIT_BYTES): string {
  return truncateUtf8(redact(text), maxBytes);
}

/** Any value as redacted JSON text (strings as they are), truncated. Never throws. */
export function cleanValue(value: unknown, maxBytes = FIELD_LIMIT_BYTES): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v)) ?? "";
  } catch {
    text = "[unserializable]";
  }
  return cleanText(text, maxBytes);
}

// ---------- pi's messages, in the conventions' shape ----------

type Part =
  | { type: "text"; content: string }
  | { type: "tool_call"; id?: string; name?: string; arguments?: unknown }
  | { type: "tool_call_response"; id?: string; result: string };
type ConvMessage = { role: "user" | "assistant" | "tool"; parts: Part[]; finish_reason?: string };

/** pi's content (a string, or text/thinking/toolCall/image blocks) as text parts; thinking and images
 * are left out (neither is the conversation as the person reads it, and images are large). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
}

/** One pi message (user, assistant, toolResult) in the gen_ai.input/output.messages shape, strings
 * redacted and each cut to `partBytes`; undefined for anything else (custom entries, summaries). */
export function toConvMessage(m: any, partBytes = FIELD_LIMIT_BYTES): ConvMessage | undefined {
  if (!m || typeof m !== "object") return undefined;
  if (m.role === "user") {
    const text = textOf(m.content);
    return { role: "user", parts: text ? [{ type: "text", content: cleanText(text, partBytes) }] : [] };
  }
  if (m.role === "assistant") {
    const parts: Part[] = [];
    const text = textOf(m.content);
    if (text) parts.push({ type: "text", content: cleanText(text, partBytes) });
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === "toolCall") parts.push({ type: "tool_call", id: c.id, name: c.name, arguments: cleanValue(c.arguments ?? {}, partBytes) });
    }
    return { role: "assistant", parts, ...(m.stopReason ? { finish_reason: finishReason(m.stopReason) } : {}) };
  }
  if (m.role === "toolResult") {
    return { role: "tool", parts: [{ type: "tool_call_response", id: m.toolCallId, result: cleanText(textOf(m.content), partBytes) }] };
  }
  return undefined;
}

/**
 * The newest messages that fit in `maxBytes` as one JSON array, oldest first (the conventions'
 * order): a model call's input is the whole conversation so far, and its end is what the call was
 * about. The newest message alone is always kept, cut harder if it has to be.
 */
export function messagesJson(messages: readonly unknown[], maxBytes = FIELD_LIMIT_BYTES): string {
  const kept: string[] = [];
  let size = 2; // the brackets
  for (let i = messages.length - 1; i >= 0; i--) {
    const conv = toConvMessage(messages[i], Math.floor(maxBytes / 2));
    if (!conv || conv.parts.length === 0) continue;
    let json = JSON.stringify(conv);
    const comma = kept.length ? 1 : 0;
    if (size + comma + Buffer.byteLength(json, "utf8") > maxBytes) {
      if (kept.length) break;
      // Even the newest is too big: its parts again, each with an equal share of the room.
      const share = Math.max(64, Math.floor((maxBytes - 256) / conv.parts.length) - 64);
      json = JSON.stringify(toConvMessage(messages[i], share));
      if (size + Buffer.byteLength(json, "utf8") > maxBytes) break;
    }
    kept.unshift(json);
    size += comma + Buffer.byteLength(json, "utf8");
  }
  return `[${kept.join(",")}]`;
}

// ---------- the three span kinds ----------

/** pi's stopReason as an OpenTelemetry finish reason. */
export function finishReason(stopReason: string | undefined): string {
  switch (stopReason) {
    case "toolUse": return "tool_call";
    case "stop": case "length": case "error": case "aborted": return stopReason;
    default: return stopReason ?? "unknown";
  }
}

/** The run's span: `invoke_agent kernal`. `conversationId` is pi's session id (a random UUID), which
 * lets Sentry put a session's runs together. */
export function agentSpanStart(opts: { model?: { id?: string; provider?: string }; conversationId?: string }): { name: string; op: string; attributes: Attributes } {
  return {
    name: `invoke_agent ${AGENT_NAME}`,
    op: "gen_ai.invoke_agent",
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": AGENT_NAME,
      ...(opts.model?.id ? { "gen_ai.request.model": opts.model.id } : {}),
      ...(opts.model?.provider ? { "gen_ai.provider.name": opts.model.provider } : {}),
      ...(opts.conversationId ? { "gen_ai.conversation.id": opts.conversationId } : {}),
    },
  };
}

/** One model call: `chat <model>`, started when pi builds the request (its `context` event). */
export function chatSpanStart(model: { id?: string; provider?: string } | undefined): { name: string; op: string; attributes: Attributes } {
  return {
    name: `chat ${model?.id ?? "unknown"}`,
    op: "gen_ai.chat",
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": AGENT_NAME,
      "gen_ai.response.streaming": true,
      ...(model?.id ? { "gen_ai.request.model": model.id } : {}),
      ...(model?.provider ? { "gen_ai.provider.name": model.provider } : {}),
    },
  };
}

/** The finished model call (pi's AssistantMessage) as attributes. pi counts `input` without the
 * cached tokens; Sentry's `gen_ai.usage.input_tokens` includes them, so they are added back. Cost
 * only when pi priced the call (a model without a price reads 0, which would claim it was free). */
export function chatSpanEnd(m: any): Attributes {
  const u = m?.usage ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
  const output = num(u.output);
  const c = u.cost ?? {};
  const total = num(c.total);
  return {
    "gen_ai.response.model": String(m?.responseModel ?? m?.model ?? "unknown"),
    ...(m?.provider ? { "gen_ai.provider.name": String(m.provider) } : {}),
    ...(typeof m?.responseId === "string" ? { "gen_ai.response.id": m.responseId } : {}),
    "gen_ai.response.finish_reasons": JSON.stringify([finishReason(m?.stopReason)]),
    "gen_ai.usage.input_tokens": input,
    "gen_ai.usage.output_tokens": output,
    "gen_ai.usage.total_tokens": input + output,
    ...(num(u.cacheRead) ? { "gen_ai.usage.cache_read.input_tokens": num(u.cacheRead) } : {}),
    ...(num(u.cacheWrite) ? { "gen_ai.usage.cache_creation.input_tokens": num(u.cacheWrite) } : {}),
    ...(typeof u.reasoning === "number" ? { "gen_ai.usage.reasoning.output_tokens": u.reasoning } : {}),
    ...(total > 0 ? {
      "gen_ai.cost.total_tokens": total,
      "gen_ai.cost.input_tokens": num(c.input) + num(c.cacheRead) + num(c.cacheWrite),
      "gen_ai.cost.output_tokens": num(c.output),
    } : {}),
  };
}

/** One tool call: `execute_tool <name>`. */
export function toolSpanStart(toolName: string): { name: string; op: string; attributes: Attributes } {
  return {
    name: `execute_tool ${toolName}`,
    op: "gen_ai.execute_tool",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.agent.name": AGENT_NAME, "gen_ai.tool.name": toolName, "kernal.tool": toolName },
  };
}

/** The tool's outcome, for the span and the counter. */
export function toolOutcome(isError: boolean): Attributes {
  return { "kernal.tool.outcome": isError ? "error" : "ok" };
}

// ---------- content, within the run's budget ----------

/** The content a run may still record; `take` answers the attributes that fit, or none. */
export class ContentBudget {
  private left: number;
  constructor(bytes = RUN_CONTENT_BUDGET_BYTES) { this.left = bytes; }
  take(attributes: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(attributes)) {
      const size = Buffer.byteLength(v, "utf8");
      if (size > this.left) { out["kernal.content.dropped"] = "run content budget reached"; continue; }
      this.left -= size;
      out[k] = v;
    }
    return out;
  }
}

/** `build(room)` as JSON within FIELD_LIMIT_BYTES: JSON escaping can grow the text (quotes,
 * newlines), so the room shrinks until it fits. */
function fitJson(build: (room: number) => unknown): string {
  let room = FIELD_LIMIT_BYTES - 128;
  let json = JSON.stringify(build(room));
  while (Buffer.byteLength(json, "utf8") > FIELD_LIMIT_BYTES && room > 256) {
    room = Math.floor(room / 2);
    json = JSON.stringify(build(room));
  }
  return json;
}

/** The run's prompt (before_agent_start) and final answer (agent_end's last assistant text). */
export function agentInputContent(prompt: string): Record<string, string> {
  return { "gen_ai.input.messages": fitJson((room) => [{ role: "user", parts: [{ type: "text", content: cleanText(prompt, room) }] }]) };
}

export function agentOutputContent(messages: readonly any[]): Record<string, string> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const text = textOf(m.content);
    if (!text) continue;
    return { "gen_ai.output.messages": fitJson((room) => [{ role: "assistant", parts: [{ type: "text", content: cleanText(text, room) }], finish_reason: finishReason(m.stopReason) }]) };
  }
  return {};
}

/** A model call's input (the conversation pi sends, system prompt excluded) and output. */
export function chatInputContent(messages: readonly unknown[]): Record<string, string> {
  return { "gen_ai.input.messages": messagesJson(messages) };
}

export function chatOutputContent(m: unknown): Record<string, string> {
  const json = messagesJson([m]);
  return json === "[]" ? {} : { "gen_ai.output.messages": json };
}

export function toolArgsContent(args: unknown): Record<string, string> {
  return { "gen_ai.tool.call.arguments": cleanValue(args ?? {}) };
}

/** A tool's result: pi's `{ content: [...] }` as its text, anything else as JSON. */
export function toolResultContent(result: unknown): Record<string, string> {
  const r = result as { content?: unknown } | null;
  const text = r && typeof r === "object" && Array.isArray(r.content) ? textOf(r.content) : undefined;
  return { "gen_ai.tool.call.result": text !== undefined ? cleanText(text) : cleanValue(result ?? "") };
}
