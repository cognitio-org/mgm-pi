/**
 * Gemini sometimes ends a successful call with finish_reason STOP, a thought, and no answer
 * part (https://discuss.ai.google.dev/t/finishreason-stop-but-parts-is-missing-inside-candidate/99331).
 * Pi treats stop with no tool call as the end of the turn. These helpers decide when that
 * happened, how many times we have already asked the model to continue, and what to record.
 * The thought text never leaves the assistant message: details and the log carry only the fields below.
 */

export const GEMINI_EMPTY_STOP_TYPE = "kernal.gemini-empty-stop";

/** Two continuations per user turn. The third detection records a cap and stops asking. */
export const MAX_CONTINUATIONS = 2;

export const CONTINUE_INSTRUCTION =
  "You stopped after a thought and sent no reply. Call the next tool or write the reply.";

export interface EmptyStopDetails {
  attempt: number;
  responseId: string | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  model: string | null;
  action: "continue" | "capped";
}

export interface AssistantTurn {
  role?: string;
  model?: unknown;
  stopReason?: unknown;
  content?: unknown;
  responseId?: unknown;
  usage?: { output?: unknown; reasoning?: unknown };
}

export interface BranchEntry {
  id?: string;
  type?: string;
  customType?: string;
  message?: AssistantTurn;
  details?: unknown;
  data?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Model id only. A non-Gemini model on the same proxy does not qualify. */
export function isGeminiModel(model: unknown): boolean {
  return typeof model === "string" && model.toLowerCase().includes("gemini");
}

export function hasVisibleText(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const b = block as { type?: unknown; text?: unknown };
    return b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0;
  });
}

export function hasToolCall(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "toolCall");
}

/** True when this assistant turn is Gemini's thought-only STOP and nothing else. */
export function isGeminiEmptyStop(message: AssistantTurn | undefined, toolResults: readonly unknown[] | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (!isGeminiModel(message.model)) return false;
  if (message.stopReason !== "stop") return false;
  if (toolResults && toolResults.length > 0) return false;
  if (hasToolCall(message.content)) return false;
  if (hasVisibleText(message.content)) return false;
  return true;
}

function markerAction(entry: BranchEntry): string | undefined {
  if (entry.customType !== GEMINI_EMPTY_STOP_TYPE) return undefined;
  const bag = entry.type === "custom" ? entry.data : entry.type === "custom_message" ? entry.details : undefined;
  if (!bag || typeof bag !== "object") return undefined;
  const action = (bag as { action?: unknown }).action;
  return typeof action === "string" ? action : undefined;
}

/**
 * Attempt number for this detection: one more than the continue markers sitting after the
 * last user message, or after the last assistant message that actually said something or
 * called a tool. The current assistant is skipped. Thought-only assistants in between are
 * neither a marker nor a reset.
 */
export function nextAttempt(branch: readonly BranchEntry[], messageEntryId: string | undefined): number {
  let continuations = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (messageEntryId && entry.id === messageEntryId) continue;
    if (markerAction(entry) === "continue") {
      continuations++;
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role === "user") break;
    if (role === "assistant" && (hasVisibleText(entry.message.content) || hasToolCall(entry.message.content))) break;
  }
  return continuations + 1;
}

export function emptyStopDetails(message: AssistantTurn, attempt: number, action: EmptyStopDetails["action"]): EmptyStopDetails {
  return {
    attempt,
    responseId: typeof message.responseId === "string" ? message.responseId : null,
    outputTokens: finiteNumber(message.usage?.output),
    reasoningTokens: finiteNumber(message.usage?.reasoning),
    model: typeof message.model === "string" ? message.model : null,
    action,
  };
}

/** One stderr line. The thought text is not a field, so it cannot appear here. */
export function emptyStopLogLine(details: EmptyStopDetails): string {
  return `gemini-empty-stop ${JSON.stringify(details)}`;
}

export interface EmptyStopDecision {
  action: EmptyStopDetails["action"];
  details: EmptyStopDetails;
}

export function decideEmptyStop(
  message: AssistantTurn | undefined,
  toolResults: readonly unknown[] | undefined,
  branch: readonly BranchEntry[],
  messageEntryId: string | undefined,
): EmptyStopDecision | undefined {
  if (!isGeminiEmptyStop(message, toolResults)) return undefined;
  const attempt = nextAttempt(branch, messageEntryId);
  const action = attempt <= MAX_CONTINUATIONS ? "continue" : "capped";
  return { action, details: emptyStopDetails(message!, attempt, action) };
}
