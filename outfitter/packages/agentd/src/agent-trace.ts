/**
 * AI agent monitoring for a Drive (#424): pi's RPC events (protocol.ts PiRpcEvent; pi's
 * docs/json.md) as Sentry's gen_ai spans, the shape Sentry's AI Agents view reads:
 *   - gen_ai.invoke_agent: one per pi agent run (agent_start .. agent_end), a root span, with the
 *     run's token and cost totals. A Drive's run (one sandbox) holds many of these, one per prompt
 *     it works on: a run can last hours, and a span that long would never be seen until it ended.
 *   - gen_ai.chat: one per model call (an assistant message_start .. message_end): model, provider,
 *     input/output/cache tokens, cost when pi knows it, finish reason, time to first chunk; the
 *     span's own duration is the latency.
 *   - gen_ai.execute_tool: one per tool call (tool_execution_start .. _end): tool name, outcome.
 * With content on (fleet setting telemetry.sentry.agentContent), the spans also carry what was said:
 * the prompt and final answer on invoke_agent, each call's new input (prompt or tool results) and
 * output on chat, and a tool's arguments and result on execute_tool. Every such field passes
 * through scrubContent first: the run's own secrets matched exactly, then redact.ts's patterns,
 * then cut to CONTENT_FIELD_MAX bytes.
 *
 * Nothing happens while agent traces are off (sentry.ts agentTraceSignals): RunController only
 * builds an AgentTracer when they are on.
 */
import * as Sentry from "@sentry/node";
import type { PiRpcEvent } from "./protocol.js";
import { redact } from "./redact.js";
import { AGENT_ROOT_ATTRIBUTE, AGENT_ROOT_VALUE, agentMetrics } from "./sentry.js";

/** One content field's cap, in UTF-8 bytes, after redaction. */
export const CONTENT_FIELD_MAX = 8 * 1024;
/** What is read of a payload before redaction, so a tool that printed megabytes costs a bounded
 * amount of regex work. Far above CONTENT_FIELD_MAX: a secret the pre-cut splits lies in what the
 * final cut drops anyway. */
const CONTENT_SCAN_MAX = 64 * 1024;

type Attr = string | number | boolean;

/** The part of a Sentry span this module uses; tests pass a recorder. */
export interface SpanLike {
  setAttribute(key: string, value: Attr | undefined): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  updateName(name: string): unknown;
  end(): void;
}

export interface SpanStart {
  name: string;
  op: string;
  attributes: Record<string, Attr>;
  /** Absent: a root span (its own transaction). */
  parent?: SpanLike;
}

export type StartSpan = (opts: SpanStart) => SpanLike;

/** Sentry's own: a root span is forced to be a transaction, never a child of whatever span is
 * active where pi's stream callback runs (begin()'s run.start, long ended). */
export const sentryStartSpan: StartSpan = (opts) =>
  Sentry.startInactiveSpan({
    name: opts.name,
    op: opts.op,
    attributes: opts.attributes,
    ...(opts.parent ? { parentSpan: opts.parent as Sentry.Span } : { parentSpan: null, forceTransaction: true }),
  }) as unknown as SpanLike;

const STATUS_OK = { code: 1 };
const STATUS_ERROR = (message: string) => ({ code: 2, message });

/** Text cut to `max` UTF-8 bytes, never mid-character, marked when cut. */
export function truncateBytes(text: string, max = CONTENT_FIELD_MAX): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= max) return text;
  const marker = `…[truncated ${bytes - max} bytes]`;
  const keep = Math.max(0, max - Buffer.byteLength(marker));
  // A cut through a multi-byte character decodes as U+FFFD; drop that partial character.
  const head = Buffer.from(text).subarray(0, keep).toString("utf8").replace(/�+$/, "");
  return head + marker;
}

/** A content field as it may leave the Drive: JSON for anything not a string, the run's own
 * secrets replaced exactly, secret-shaped strings redacted, and the result at most `max` bytes. */
export function scrubContent(value: unknown, secrets: readonly string[] = [], max = CONTENT_FIELD_MAX): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = "[unserialisable]";
    }
  }
  if (text.length > CONTENT_SCAN_MAX) text = text.slice(0, CONTENT_SCAN_MAX);
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  return truncateBytes(redact(text), max);
}

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

interface PiMessage {
  role?: string;
  content?: unknown;
  model?: string;
  responseModel?: string;
  provider?: string;
  usage?: Usage;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
}

/** A message's content as Sentry's message parts (gen_ai.input/output.messages): text, tool calls
 * and tool results. Thinking stays out: it is the model's scratchpad, not what it said. */
function parts(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", content }];
  if (!Array.isArray(content)) return [];
  const out: unknown[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === "text" && typeof block.text === "string") out.push({ type: "text", content: block.text });
    else if (block?.type === "toolCall") out.push({ type: "tool_call", id: block.id, name: block.name, arguments: block.arguments });
    else if (block?.type === "image") out.push({ type: "image" });
  }
  return out;
}

/** A tool result's text (pi's `{ content: [{ type: "text", text }], details }`), or the value. */
function toolResultText(result: unknown): unknown {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content)) {
    const texts = content.filter((c): c is { type: string; text: string } => c?.type === "text" && typeof c.text === "string").map((c) => c.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return result;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface AgentTracerOptions {
  /** gen_ai.agent.name. */
  agentName: string;
  /** gen_ai.conversation.id: the Outfitter session, so a session's agent runs group together. */
  conversationId?: string;
  /** Record prompts, responses and tool input/output (redacted, truncated). */
  content: boolean;
  /** The run's own secrets, matched exactly in content (read at each use: a token can rotate). */
  secrets?: () => readonly string[];
  startSpan?: StartSpan;
  now?: () => number;
}

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  calls: number;
  tools: number;
}

export class AgentTracer {
  private readonly opts: AgentTracerOptions;
  private readonly startSpan: StartSpan;
  private readonly now: () => number;
  private agent: { span: SpanLike; totals: Totals; prompt?: unknown[] } | undefined;
  private chat: { span: SpanLike; startedAt: number; firstChunkAt?: number } | undefined;
  private readonly tools = new Map<string, { span: SpanLike; startedAt: number; name: string }>();
  /** Content only: what was added since the last model call (a prompt, tool results). */
  private pendingInput: unknown[] = [];
  private lastOutput: unknown[] | undefined;

  constructor(opts: AgentTracerOptions) {
    this.opts = opts;
    this.startSpan = opts.startSpan ?? sentryStartSpan;
    this.now = opts.now ?? (() => performance.now());
  }

  /** Feeds one pi event; anything this module doesn't trace is ignored. Never throws. */
  observe(event: PiRpcEvent): void {
    try {
      this.handle(event);
    } catch {
      // Monitoring must never disturb the run.
    }
  }

  /** Ends whatever is open (pi exited, the run is stopping), marked as cut short. */
  close(reason = "cancelled"): void {
    try {
      this.endAgent(STATUS_ERROR(reason));
    } catch {
      // as observe
    }
  }

  private scrub(value: unknown): string {
    return scrubContent(value, this.opts.secrets?.() ?? []);
  }

  private handle(event: PiRpcEvent): void {
    switch (event.type) {
      case "agent_start":
        this.startAgent();
        return;
      case "message_start":
        if ((event.message as PiMessage | undefined)?.role === "assistant") this.startChat(event.message as PiMessage);
        return;
      case "message_update":
        if (this.chat && this.chat.firstChunkAt === undefined) this.chat.firstChunkAt = this.now();
        return;
      case "message_end":
        this.messageEnd((event.message ?? {}) as PiMessage);
        return;
      case "tool_execution_start":
        this.startTool(String(event.toolCallId ?? ""), String(event.toolName ?? "tool"), event.args);
        return;
      case "tool_execution_end":
        this.endTool(String(event.toolCallId ?? ""), String(event.toolName ?? "tool"), event.result, event.isError === true);
        return;
      case "agent_end":
        this.endAgent(STATUS_OK, event.messages);
        return;
    }
  }

  private startAgent(): void {
    if (this.agent) this.endAgent(STATUS_ERROR("superseded")); // a missed agent_end
    const attributes: Record<string, Attr> = { [AGENT_ROOT_ATTRIBUTE]: AGENT_ROOT_VALUE, "gen_ai.agent.name": this.opts.agentName };
    if (this.opts.conversationId) attributes["gen_ai.conversation.id"] = this.opts.conversationId;
    this.agent = {
      span: this.startSpan({ name: `invoke_agent ${this.opts.agentName}`, op: "gen_ai.invoke_agent", attributes }),
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0, tools: 0 },
    };
    this.pendingInput = [];
    this.lastOutput = undefined;
  }

  private startChat(message: PiMessage): void {
    if (!this.agent) return;
    if (this.chat) this.chat.span.end(); // a model call whose end never came
    const model = message.model ?? "";
    const attributes: Record<string, Attr> = { "gen_ai.operation.name": "chat" };
    if (model) attributes["gen_ai.request.model"] = model;
    if (message.provider) attributes["gen_ai.provider.name"] = message.provider;
    this.chat = {
      span: this.startSpan({ name: model ? `chat ${model}` : "chat", op: "gen_ai.chat", attributes, parent: this.agent.span }),
      startedAt: this.now(),
    };
  }

  private messageEnd(message: PiMessage): void {
    if (!this.agent) return;
    if (message.role === "user") {
      if (this.opts.content) {
        const entry = { role: "user", parts: parts(message.content) };
        this.pendingInput.push(entry);
        this.agent.prompt ??= [entry];
      }
      return;
    }
    if (message.role === "toolResult") {
      if (this.opts.content) {
        this.pendingInput.push({ role: "tool", parts: [{ type: "tool_call_response", id: message.toolCallId, result: toolResultText({ content: message.content }) }] });
      }
      return;
    }
    if (message.role !== "assistant") return;
    if (!this.chat) this.startChat(message);
    const chat = this.chat;
    if (!chat) return;
    this.chat = undefined;
    const span = chat.span;
    const model = message.model ?? "";
    const usage = message.usage ?? {};
    const input = num(usage.input);
    const output = num(usage.output);
    const cacheRead = num(usage.cacheRead);
    const cacheWrite = num(usage.cacheWrite);
    const cost = num(usage.cost?.total);
    if (model) {
      span.updateName(`chat ${model}`);
      span.setAttribute("gen_ai.request.model", model);
    }
    span.setAttribute("gen_ai.response.model", message.responseModel ?? (model || undefined));
    if (message.provider) span.setAttribute("gen_ai.provider.name", message.provider);
    // Sentry's input_tokens include cached ones; pi's `input` is the uncached part.
    span.setAttribute("gen_ai.usage.input_tokens", input + cacheRead + cacheWrite);
    span.setAttribute("gen_ai.usage.output_tokens", output);
    span.setAttribute("gen_ai.usage.cache_read.input_tokens", cacheRead);
    span.setAttribute("gen_ai.usage.cache_creation.input_tokens", cacheWrite);
    span.setAttribute("gen_ai.usage.total_tokens", num(usage.totalTokens) || input + output + cacheRead + cacheWrite);
    if (cost > 0) {
      span.setAttribute("gen_ai.cost.total_tokens", cost);
      span.setAttribute("gen_ai.cost.input_tokens", num(usage.cost?.input) + num(usage.cost?.cacheRead) + num(usage.cost?.cacheWrite));
      span.setAttribute("gen_ai.cost.output_tokens", num(usage.cost?.output));
    }
    if (message.stopReason) span.setAttribute("gen_ai.response.finish_reasons", message.stopReason);
    if (chat.firstChunkAt !== undefined) span.setAttribute("gen_ai.response.time_to_first_chunk", (chat.firstChunkAt - chat.startedAt) / 1000);
    if (this.opts.content) {
      if (this.pendingInput.length > 0) span.setAttribute("gen_ai.input.messages", this.scrub(this.pendingInput));
      const out = [{ role: "assistant", parts: parts(message.content), ...(message.stopReason ? { finish_reason: message.stopReason } : {}) }];
      span.setAttribute("gen_ai.output.messages", this.scrub(out));
      this.lastOutput = out;
    }
    this.pendingInput = [];
    span.setStatus(message.stopReason === "error" ? STATUS_ERROR("internal_error") : message.stopReason === "aborted" ? STATUS_ERROR("cancelled") : STATUS_OK);
    span.end();

    const t = this.agent.totals;
    t.input += input;
    t.output += output;
    t.cacheRead += cacheRead;
    t.cacheWrite += cacheWrite;
    t.cost += cost;
    t.calls++;
    const attrs = { ...(model ? { model } : {}), ...(message.provider ? { provider: message.provider } : {}) };
    agentMetrics.distribution("gen_ai.chat.duration", this.now() - chat.startedAt, "millisecond", attrs);
    agentMetrics.count("gen_ai.tokens.input", attrs, input + cacheRead + cacheWrite);
    agentMetrics.count("gen_ai.tokens.output", attrs, output);
    if (cost > 0) agentMetrics.distribution("gen_ai.cost", cost, "usd", attrs);
  }

  private startTool(id: string, name: string, args: unknown): void {
    if (!this.agent) return;
    this.tools.get(id)?.span.end();
    const attributes: Record<string, Attr> = { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name };
    if (this.opts.content && args !== undefined) attributes["gen_ai.tool.call.arguments"] = this.scrub(args);
    const span = this.startSpan({ name: `execute_tool ${name}`, op: "gen_ai.execute_tool", attributes, parent: this.agent.span });
    this.tools.set(id, { span, startedAt: this.now(), name });
  }

  private endTool(id: string, name: string, result: unknown, isError: boolean): void {
    const tool = this.tools.get(id);
    if (!tool) return;
    this.tools.delete(id);
    const outcome = isError ? "error" : "ok";
    tool.span.setAttribute("outfitter.tool.outcome", outcome);
    if (this.opts.content && result !== undefined) tool.span.setAttribute("gen_ai.tool.call.result", this.scrub(toolResultText(result)));
    tool.span.setStatus(isError ? STATUS_ERROR("tool_error") : STATUS_OK);
    tool.span.end();
    if (this.agent) this.agent.totals.tools++;
    agentMetrics.count("gen_ai.tool_calls", { tool: tool.name || name, outcome });
    agentMetrics.distribution("gen_ai.tool.duration", this.now() - tool.startedAt, "millisecond", { tool: tool.name || name, outcome });
  }

  private endAgent(status: { code: number; message?: string }, messages?: unknown): void {
    for (const tool of this.tools.values()) {
      tool.span.setStatus(STATUS_ERROR("cancelled"));
      tool.span.end();
    }
    this.tools.clear();
    if (this.chat) {
      this.chat.span.setStatus(STATUS_ERROR("cancelled"));
      this.chat.span.end();
      this.chat = undefined;
    }
    const agent = this.agent;
    if (!agent) return;
    this.agent = undefined;
    const span = agent.span;
    const t = agent.totals;
    span.setAttribute("gen_ai.usage.input_tokens", t.input + t.cacheRead + t.cacheWrite);
    span.setAttribute("gen_ai.usage.output_tokens", t.output);
    span.setAttribute("gen_ai.usage.cache_read.input_tokens", t.cacheRead);
    span.setAttribute("gen_ai.usage.cache_creation.input_tokens", t.cacheWrite);
    span.setAttribute("gen_ai.usage.total_tokens", t.input + t.output + t.cacheRead + t.cacheWrite);
    if (t.cost > 0) span.setAttribute("gen_ai.cost.total_tokens", t.cost);
    span.setAttribute("outfitter.agent.model_calls", t.calls);
    span.setAttribute("outfitter.agent.tool_calls", t.tools);
    if (this.opts.content) {
      if (agent.prompt) span.setAttribute("gen_ai.input.messages", this.scrub(agent.prompt));
      const final = this.lastOutput ?? lastAssistant(messages);
      if (final) span.setAttribute("gen_ai.output.messages", this.scrub(final));
    }
    span.setStatus(status);
    span.end();
    this.pendingInput = [];
    this.lastOutput = undefined;
  }
}

/** agent_end's last assistant message, as output messages. */
function lastAssistant(messages: unknown): unknown[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as PiMessage;
    if (m?.role === "assistant") return [{ role: "assistant", parts: parts(m.content) }];
  }
  return undefined;
}
