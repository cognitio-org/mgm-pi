// E9 §5.1: our A2ARequestHandler (the @a2a-js/sdk interface its JsonRpcTransportHandler calls) on
// the a2aTasks store, instead of the SDK's DefaultRequestHandler, whose in-process event bus can't
// serve several Cloud Run instances and accepts client contextIds. The SDK parses and serialises;
// this maps its types to A2ATasks and back.
//
// The caller's key arrives as the call context's user (A2AKeyUser), set by routes/a2a.ts after
// it verified the bearer.

import { Message, Role, TaskState, type AgentCard, type Artifact, type Part, type Task } from "@a2a-js/sdk";
import type {
  CancelTaskRequest,
  DeleteTaskPushNotificationConfigRequest,
  GetExtendedAgentCardRequest,
  GetTaskPushNotificationConfigRequest,
  GetTaskRequest,
  ListTaskPushNotificationConfigsRequest,
  ListTaskPushNotificationConfigsResponse,
  ListTasksRequest,
  ListTasksResponse,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  TaskPushNotificationConfig,
} from "@a2a-js/sdk";
import type { A2ARequestHandler, ServerCallContext, User } from "@a2a-js/sdk/server";
import {
  ContentTypeNotSupportedError,
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import type { Config } from "../config.ts";
import { MAIL_MAX_TEXT } from "../mail.ts";
import { redact } from "../search/redact.ts";
import type { A2ATask, A2ATaskState, Store } from "../store/types.ts";
import { A2A_REPO_RE, SKILL_ID_RE, a2aTapeProblem } from "./keys.ts";
import { extendedCard, OUTFITTER_TASK_EXTENSION, publicCard } from "./card.ts";
import { A2ATaskNotFound, isTerminal, type A2AKey, type A2ATasks, type StartTaskInput } from "./tasks.ts";

/** The verified key, as the SDK's call-context user. */
export class A2AKeyUser implements User {
  readonly key: A2AKey;
  constructor(key: A2AKey) {
    this.key = key;
  }
  get isAuthenticated(): boolean {
    return true;
  }
  get userName(): string {
    return this.key.id;
  }
}

const STATE_TO_WIRE: Record<A2ATaskState, TaskState> = {
  submitted: TaskState.TASK_STATE_SUBMITTED,
  working: TaskState.TASK_STATE_WORKING,
  "input-required": TaskState.TASK_STATE_INPUT_REQUIRED,
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  canceled: TaskState.TASK_STATE_CANCELED,
  rejected: TaskState.TASK_STATE_REJECTED,
};

const BRANCH_RE = /^[A-Za-z0-9_./-]{1,255}$/;
const LIST_PAGE_DEFAULT = 50;
const LIST_PAGE_MAX = 100;
const BLOCKING_POLL_MS = 1_000;
/** Blocking SendMessage waits one key may hold at once on this instance; more return at once. */
const BLOCKING_WAITS_PER_KEY = 2;
const TITLE_MAX = 80;
const MESSAGE_ID_MAX = 128;
/** The caller's text kept for `history`: enough to recognise the task, not a second copy of it. */
const HISTORY_TEXT_MAX = 4_000;

export interface A2AHandlerOptions {
  store: Store;
  config: Config;
  tasks: A2ATasks;
}

export class OutfitterA2AHandler implements A2ARequestHandler {
  private readonly opts: A2AHandlerOptions;
  private readonly card: AgentCard;
  private readonly blockingWaits = new Map<string, number>();

  constructor(opts: A2AHandlerOptions) {
    this.opts = opts;
    this.card = publicCard(opts.config);
  }

  async getAgentCard(): Promise<AgentCard> {
    return this.card;
  }

  async getAuthenticatedExtendedAgentCard(_params: GetExtendedAgentCardRequest, context: ServerCallContext): Promise<AgentCard> {
    const key = keyOf(context);
    const tapes = [];
    for (const id of key.scope.tapes) {
      const guru = await this.opts.store.gurus.findById(id);
      if (guru && !a2aTapeProblem(guru)) tapes.push({ id: guru.id, name: guru.name });
    }
    return extendedCard(this.opts.config, tapes);
  }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    const key = keyOf(context);
    const message = params.message;
    if (!message) throw new RequestMalformedError("message is required");
    if (!message.messageId) throw new RequestMalformedError("message.messageId is required");
    if (message.messageId.length > MESSAGE_ID_MAX) throw new RequestMalformedError(`message.messageId is over ${MESSAGE_ID_MAX} characters`);
    if (message.role !== Role.ROLE_USER) throw new RequestMalformedError("message.role must be ROLE_USER");
    const ext = extensionParams(message.metadata);
    if (ext.requested && context.requestedExtensions?.includes(OUTFITTER_TASK_EXTENSION)) {
      context.addActivatedExtension(OUTFITTER_TASK_EXTENSION);
    }
    const prompt = promptFrom(message.parts);
    const historyLength = params.configuration?.historyLength;

    let task: A2ATask;
    if (message.taskId) {
      // §5.3 "Message to an existing task". INPUT_REQUIRED replies are PR6; nothing here produces
      // that state yet, so no A2A message can answer a UI request.
      const existing = await this.opts.tasks.get(key, message.taskId).catch(rethrowNotFound);
      if (message.contextId && message.contextId !== existing.contextId) {
        throw new RequestMalformedError("taskId and contextId don't belong together");
      }
      if (isTerminal(existing.state)) {
        throw new UnsupportedOperationError("the task has finished; send a new message with its contextId to continue");
      }
      throw new RequestMalformedError("the task is working; wait for it or cancel it");
    }

    const input: StartTaskInput = {
      messageId: message.messageId,
      prompt,
      title: titleOf(prompt),
      ...(message.contextId ? { contextId: message.contextId } : {}),
      ...(ext.skill !== undefined ? { skill: ext.skill } : {}),
      ...(ext.repo !== undefined ? { repo: ext.repo } : {}),
      ...(ext.baseBranch !== undefined ? { baseBranch: ext.baseBranch } : {}),
      message: historyMessage(message, prompt),
    };
    const started = await this.opts.tasks.start(key, input).catch(rethrowNotFound);
    task = started.task;

    // A repeated messageId gets the task as it is: retries must not each hold a waiting request.
    const repeated = started.repeated;
    if (params.configuration?.returnImmediately !== true && !repeated) task = await this.waitBlocking(key, task);
    return toWireTask(task, historyLength);
  }

  /** §5.3 blocking SendMessage: poll the row until terminal or interrupted, at most the cap
   * (25 s), then return the task as it is. A documented deviation for long tasks. */
  private async waitBlocking(key: A2AKey, task: A2ATask): Promise<A2ATask> {
    const held = this.blockingWaits.get(key.id) ?? 0;
    if (held >= BLOCKING_WAITS_PER_KEY) return task;
    this.blockingWaits.set(key.id, held + 1);
    try {
      const deadline = Date.now() + this.opts.config.a2aBlockingCapMs;
      let current = task;
      while (!isTerminal(current.state) && current.state !== "input-required") {
        const left = deadline - Date.now();
        if (left <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(BLOCKING_POLL_MS, left)));
        current = await this.opts.tasks.get(key, current.id);
      }
      return current;
    } finally {
      const left = (this.blockingWaits.get(key.id) ?? 1) - 1;
      if (left <= 0) this.blockingWaits.delete(key.id);
      else this.blockingWaits.set(key.id, left);
    }
  }

  async *sendMessageStream(_params: SendMessageRequest, _context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    // PR6 seam: stream the Task, then a statusUpdate per change (polling the row every 2 s), then
    // artifactUpdate and the final statusUpdate (§5.3 "Streaming"). The card says streaming:false
    // until then.
    throw new UnsupportedOperationError("streaming is not supported yet; use SendMessage with returnImmediately and GetTask");
  }

  async *resubscribe(_params: SubscribeToTaskRequest, _context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    // PR6 seam: SubscribeToTask, same polling stream as sendMessageStream.
    throw new UnsupportedOperationError("streaming is not supported yet; poll GetTask");
  }

  async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    const key = keyOf(context);
    if (!params.id) throw new RequestMalformedError("id is required");
    const task = await this.opts.tasks.get(key, params.id).catch(rethrowNotFound);
    return toWireTask(task, params.historyLength);
  }

  async listTasks(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const key = keyOf(context);
    const pageSize = params.pageSize ?? LIST_PAGE_DEFAULT;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > LIST_PAGE_MAX) {
      throw new RequestMalformedError(`pageSize must be 1 to ${LIST_PAGE_MAX}`);
    }
    if (params.historyLength !== undefined && params.historyLength < 0) throw new RequestMalformedError("historyLength must not be negative");
    const before = params.pageToken ? decodeCursor(params.pageToken) : undefined;
    const state = stateFromWire(params.status);
    let updatedAfter: string | undefined;
    if (params.statusTimestampAfter) {
      const ms = Date.parse(params.statusTimestampAfter);
      if (!Number.isFinite(ms)) throw new RequestMalformedError("statusTimestampAfter must be a timestamp");
      updatedAfter = new Date(ms).toISOString();
    }
    const { tasks, total } = await this.opts.tasks.list(key, {
      ...(params.contextId ? { contextId: params.contextId } : {}),
      ...(state ? { state } : {}),
      ...(updatedAfter ? { updatedAfter } : {}),
      ...(before ? { before } : {}),
      limit: pageSize + 1,
    });
    const page = tasks.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      tasks: page.map((t) => toWireTask(t, params.historyLength)),
      nextPageToken: tasks.length > pageSize && last ? encodeCursor(last) : "",
      pageSize,
      totalSize: total,
    };
  }

  async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    const key = keyOf(context);
    if (!params.id) throw new RequestMalformedError("id is required");
    const canceled = await this.opts.tasks.cancel(key, params.id).catch(rethrowNotFound);
    if (!canceled) throw new TaskNotCancelableError("the task has already finished");
    return toWireTask(canceled);
  }

  async createTaskPushNotificationConfig(_p: TaskPushNotificationConfig, _c: ServerCallContext): Promise<TaskPushNotificationConfig> {
    throw new PushNotificationNotSupportedError("push notifications are not supported");
  }

  async getTaskPushNotificationConfig(_p: GetTaskPushNotificationConfigRequest, _c: ServerCallContext): Promise<TaskPushNotificationConfig> {
    throw new PushNotificationNotSupportedError("push notifications are not supported");
  }

  async listTaskPushNotificationConfigs(
    _p: ListTaskPushNotificationConfigsRequest,
    _c: ServerCallContext,
  ): Promise<ListTaskPushNotificationConfigsResponse> {
    throw new PushNotificationNotSupportedError("push notifications are not supported");
  }

  async deleteTaskPushNotificationConfig(_p: DeleteTaskPushNotificationConfigRequest, _c: ServerCallContext): Promise<void> {
    throw new PushNotificationNotSupportedError("push notifications are not supported");
  }
}

function keyOf(context: ServerCallContext): A2AKey {
  const user = context.user;
  // routes/a2a.ts always sets it; anything else is a wiring bug, never a caller's way in.
  if (!(user instanceof A2AKeyUser)) throw new Error("a2a: no verified key on the call context");
  return user.key;
}

function rethrowNotFound(err: unknown): never {
  if (err instanceof A2ATaskNotFound) throw new TaskNotFoundError(err.message);
  throw err;
}

interface ExtensionParams {
  requested: boolean;
  skill?: string;
  repo?: string;
  baseBranch?: string;
}

/** `message.metadata[OUTFITTER_TASK_EXTENSION]`, validated: skill a tape id, repo `owner/name`, a
 * plain base branch. Anything else is -32602, never passed through. */
function extensionParams(metadata: Record<string, unknown> | undefined): ExtensionParams {
  const raw = metadata?.[OUTFITTER_TASK_EXTENSION];
  if (raw === undefined || raw === null) return { requested: false };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RequestMalformedError("the outfitter-task metadata must be an object");
  const { skill, repo, baseBranch } = raw as Record<string, unknown>;
  const out: ExtensionParams = { requested: true };
  if (skill !== undefined && skill !== null) {
    if (typeof skill !== "string" || !SKILL_ID_RE.test(skill)) throw new RequestMalformedError("skill must be a tape id");
    out.skill = skill;
  }
  if (repo !== undefined && repo !== null) {
    if (typeof repo !== "string" || !A2A_REPO_RE.test(repo.trim())) throw new RequestMalformedError("repo must be owner/name");
    out.repo = repo.trim();
  }
  if (baseBranch !== undefined && baseBranch !== null) {
    if (
      typeof baseBranch !== "string" ||
      !BRANCH_RE.test(baseBranch) ||
      baseBranch.includes("..") ||
      baseBranch.startsWith("-") ||
      baseBranch.startsWith("/") ||
      baseBranch.startsWith("refs/") ||
      baseBranch.endsWith("/") ||
      baseBranch.endsWith(".lock")
    ) {
      throw new RequestMalformedError("baseBranch must be a plain branch name");
    }
    out.baseBranch = baseBranch;
  }
  return out;
}

/** §5.3: the text parts, then each data part as fenced JSON. Raw and url parts are refused. */
function promptFrom(parts: Part[]): string {
  if (!Array.isArray(parts) || parts.length === 0) throw new RequestMalformedError("message.parts is empty");
  const pieces: string[] = [];
  for (const part of parts) {
    const content = part.content;
    if (content?.$case === "text") pieces.push(content.value);
    else if (content?.$case === "data") pieces.push(fencedJson(content.value));
    else throw new ContentTypeNotSupportedError("only text and data parts are supported");
  }
  const prompt = pieces.join("\n\n");
  if (!prompt.trim()) throw new RequestMalformedError("the message has no text");
  if (prompt.length > MAIL_MAX_TEXT) throw new RequestMalformedError(`the message is over ${MAIL_MAX_TEXT} characters`);
  return prompt;
}

/** A fence longer than any backtick run inside, so the JSON can't close it early. */
function fencedJson(value: unknown): string {
  const json = JSON.stringify(value ?? null, null, 2) ?? "null";
  const longest = Math.max(0, ...[...json.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}json\n${json}\n${fence}`;
}

/** The caller's message for `history`, as A2A JSON: its ids and role, and its text capped. */
function historyMessage(message: Message, prompt: string): unknown {
  const text = prompt.length > HISTORY_TEXT_MAX ? `${prompt.slice(0, HISTORY_TEXT_MAX)}…` : prompt;
  return Message.toJSON({ ...message, parts: [textPart(text)], metadata: undefined });
}

function titleOf(prompt: string): string {
  const line = prompt.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("```")) ?? "task";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function stateFromWire(state: TaskState | undefined): A2ATaskState | undefined {
  if (state === undefined || state === TaskState.TASK_STATE_UNSPECIFIED) return undefined;
  const match = (Object.entries(STATE_TO_WIRE) as [A2ATaskState, TaskState][]).find(([, wire]) => wire === state);
  if (!match) throw new RequestMalformedError("unknown status");
  return match[0];
}

function encodeCursor(task: A2ATask): string {
  return Buffer.from(JSON.stringify({ c: task.createdAt, i: task.id }), "utf8").toString("base64url");
}

function decodeCursor(token: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof parsed.c === "string" && typeof parsed.i === "string" && parsed.c.length <= 40 && parsed.i.length <= 64) {
      return { createdAt: parsed.c, id: parsed.i };
    }
  } catch {
    // fall through
  }
  throw new RequestMalformedError("pageToken is not one this server issued");
}

function textPart(value: string): Part {
  return { content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" };
}

function agentMessage(task: A2ATask, text: string): Message {
  return {
    messageId: `${task.id}-status`,
    contextId: task.contextId,
    taskId: task.id,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

/**
 * The row as an A2A Task. `history` is the caller's message (historyLength 0: none). On COMPLETED,
 * one artifact with the final assistant text. PR6 seam: the data part {branch, head, compareUrl,
 * prUrl?} joins it there, from A2ATaskResult.
 */
export function toWireTask(task: A2ATask, historyLength?: number): Task {
  let history: Message[] = [];
  if (task.message !== undefined) {
    const original = Message.fromJSON(task.message);
    history = [{ ...original, taskId: task.id, contextId: task.contextId }];
  }
  if (historyLength !== undefined) history = historyLength <= 0 ? [] : history.slice(-historyLength);
  const artifacts: Artifact[] = [];
  if (task.state === "completed" && task.result?.text) {
    artifacts.push({
      artifactId: `${task.id}-result`,
      name: "result",
      description: "The task's final answer",
      parts: [textPart(redact(task.result.text))],
      metadata: undefined,
      extensions: [],
    });
  }
  return {
    id: task.id,
    contextId: task.contextId,
    status: {
      state: STATE_TO_WIRE[task.state],
      message: task.statusText ? agentMessage(task, redact(task.statusText)) : undefined,
      timestamp: task.updatedAt,
    },
    artifacts,
    history,
    metadata: undefined,
  };
}
