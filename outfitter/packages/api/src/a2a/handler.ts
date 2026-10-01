// E9 §5.1: our A2ARequestHandler (the @a2a-js/sdk interface its JsonRpcTransportHandler calls) on
// the a2aTasks store, instead of the SDK's DefaultRequestHandler, whose in-process event bus can't
// serve several Cloud Run instances and accepts client contextIds. The SDK parses and serialises;
// this maps its types to A2ATasks and back.
//
// The caller's key arrives as the call context's user (A2AKeyUser), set by routes/a2a.ts after
// it verified the bearer.

import { randomUUID } from "node:crypto";
import {
  Message,
  Role,
  TaskState,
  type AgentCard,
  type Artifact,
  type Part,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatus,
} from "@a2a-js/sdk";
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
import { isTokenActive } from "../tokens.ts";
import { A2A_REPO_RE, SKILL_ID_RE, a2aTapeProblem } from "./keys.ts";
import { extendedCard, OUTFITTER_TASK_EXTENSION, publicCard } from "./card.ts";
import { A2ATaskNotAnswerable, A2ATaskNotFound, isTerminal, type A2AKey, type A2ATasks, type StartTaskInput } from "./tasks.ts";

/** The verified key, as the SDK's call-context user, with the request's lifetime: `signal` aborts
 * when the client goes away, which ends a stream's polling at once. */
export class A2AKeyUser implements User {
  readonly key: A2AKey;
  readonly signal: AbortSignal | undefined;
  constructor(key: A2AKey, signal?: AbortSignal) {
    this.key = key;
    this.signal = signal;
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
/** An open stream re-checks that its key is still active every this many polls (1 min at the
 * default 2 s): a key revoked or expired since the request closes its streams. */
const STREAM_KEY_RECHECK_POLLS = 30;

/** A key already holds config.a2aStreamsPerKey open streams (across instances). routes/a2a.ts
 * sends it as HTTP 429, like the request rate limit, before any SSE starts. */
export class A2AStreamLimitError extends Error {
  constructor(limit: number) {
    super(`over ${limit} open streams for this key; close one, or poll GetTask`);
  }
}

export interface A2AHandlerOptions {
  store: Store;
  config: Config;
  tasks: A2ATasks;
}

/** Builds the handler routes/a2a.ts serves (a test seam: the TCK build's scripted handler). */
export type A2AHandlerFactory = (opts: A2AHandlerOptions) => OutfitterA2AHandler;

export class OutfitterA2AHandler implements A2ARequestHandler {
  protected readonly opts: A2AHandlerOptions;
  private readonly card: AgentCard;
  private readonly blockingWaits = new Map<string, number>();
  /** Stream polls of one task on this instance share one refresh per half poll interval. */
  private readonly polls = new Map<string, { at: number; task: Promise<A2ATask> }>();

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

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    const key = keyOf(context);
    const accepted = await this.accept(params, context);
    let task = accepted.task;
    // A repeated messageId gets the task as it is: retries must not each hold a waiting request.
    if (params.configuration?.returnImmediately !== true && accepted.fresh) task = await this.waitBlocking(key, task);
    return this.wireTask(task, params.configuration?.historyLength);
  }

  /**
   * The message part of SendMessage and SendStreamingMessage: a new task, a follow-up in a
   * context, or (with a taskId) the answer to an INPUT_REQUIRED task. `fresh` is false for a
   * repeated messageId.
   */
  protected async accept(params: SendMessageRequest, context: ServerCallContext): Promise<{ task: A2ATask; fresh: boolean }> {
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

    if (message.taskId) {
      // §5.3 "Message to an existing task": INPUT_REQUIRED takes the text as its answer (input and
      // editor requests only; A2ATasks.answer). Terminal: -32004. Anything else: -32602.
      const existing = await this.opts.tasks.peek(key, message.taskId).catch(rethrowNotFound);
      if (message.contextId && message.contextId !== existing.contextId) {
        throw new RequestMalformedError("taskId and contextId don't belong together");
      }
      try {
        const answered = await this.opts.tasks.answer(key, existing.id, message.messageId, prompt, historyMessage(message, prompt));
        return { task: answered.task, fresh: answered.applied };
      } catch (err) {
        if (!(err instanceof A2ATaskNotAnswerable)) return rethrowNotFound(err);
        if (isTerminal(err.task.state)) {
          throw new UnsupportedOperationError("the task has finished; send a new message with its contextId to continue");
        }
        if (err.task.state === "input-required") throw new RequestMalformedError(err.message);
        throw new RequestMalformedError("the task is working; wait for it or cancel it");
      }
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
    return { task: started.task, fresh: !started.repeated };
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

  /**
   * §5.3 "Streaming": the Task, then a statusUpdate per change of state or status text (the row is
   * polled every A2A_STREAM_POLL_MS, so a change made on any link instance shows), the result's
   * artifactUpdate before the final statusUpdate, then close. Closes on a terminal or interrupted
   * (INPUT_REQUIRED) state, as A2A §3.1.2 has it, and at A2A_STREAM_MAX_MS.
   */
  async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    const key = keyOf(context);
    const release = await this.claimStream(key);
    try {
      const { task } = await this.accept(params, context);
      yield* this.follow(key, task, context, true, params.configuration?.historyLength);
    } finally {
      await release();
    }
  }

  /** SubscribeToTask: the same stream for an existing task, open until it is terminal. A terminal
   * task is UnsupportedOperation (-32004), A2A §3.1.6. */
  async *resubscribe(params: SubscribeToTaskRequest, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    const key = keyOf(context);
    if (!params.id) throw new RequestMalformedError("id is required");
    const task = await this.opts.tasks.get(key, params.id).catch(rethrowNotFound);
    if (isTerminal(task.state)) throw new UnsupportedOperationError("the task has finished; GetTask returns its result");
    const release = await this.claimStream(key);
    try {
      yield* this.follow(key, task, context, false);
    } finally {
      await release();
    }
  }

  /**
   * One of the key's open streams, counted in the store across every link instance (a2aTasks
   * slots), or A2AStreamLimitError. A slot names its own expiry (the stream's longest life plus a
   * minute), so one left by a crashed instance is reclaimed. Returns the release.
   */
  private async claimStream(key: A2AKey): Promise<() => Promise<void>> {
    const limit = this.opts.config.a2aStreamsPerKey;
    const slots = this.opts.store.a2aTasks;
    const slotKey = `${key.id}#streams`;
    const slot = `${Date.now() + this.opts.config.a2aStreamMaxMs + 60_000}:${randomUUID()}`;
    if (!(await slots.claimSlot(slotKey, slot, limit))) {
      for (const held of await slots.listSlots(slotKey)) {
        if (Number(held.split(":")[0]) < Date.now()) await slots.releaseSlot(slotKey, held);
      }
      if (!(await slots.claimSlot(slotKey, slot, limit))) throw new A2AStreamLimitError(limit);
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await slots.releaseSlot(slotKey, slot).catch(() => undefined);
    };
  }

  /** The task for a stream's poll; streams of one task on this instance share a refresh. */
  private pollTask(key: A2AKey, id: string): Promise<A2ATask> {
    const k = `${key.id}:${id}`;
    const now = Date.now();
    const shared = this.polls.get(k);
    if (shared && now - shared.at < this.opts.config.a2aStreamPollMs / 2) return shared.task;
    const task = this.opts.tasks.get(key, id);
    this.polls.set(k, { at: now, task });
    const forget = () => {
      if (this.polls.get(k)?.task === task) this.polls.delete(k);
    };
    task.then(
      () => setTimeout(forget, this.opts.config.a2aStreamPollMs).unref?.(),
      forget,
    );
    return task;
  }

  private async *follow(
    key: A2AKey,
    first: A2ATask,
    context: ServerCallContext,
    closeOnInterrupt: boolean,
    historyLength?: number,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    yield { payload: { $case: "task", value: this.wireTask(first, historyLength) } };
    const done = (t: A2ATask) => isTerminal(t.state) || (closeOnInterrupt && t.state === "input-required");
    if (done(first)) return;
    const signal = signalOf(context);
    const deadline = Date.now() + this.opts.config.a2aStreamMaxMs;
    let polls = 0;
    let last = first;
    while (!signal?.aborted) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      await sleep(Math.min(this.opts.config.a2aStreamPollMs, left), signal);
      if (signal?.aborted) return;
      if (++polls % STREAM_KEY_RECHECK_POLLS === 0 && !(await this.keyActive(key))) return;
      let current: A2ATask;
      try {
        current = await this.pollTask(key, last.id);
      } catch (err) {
        if (err instanceof A2ATaskNotFound) return;
        throw err;
      }
      if (current.state === last.state && current.statusText === last.statusText && current.questionId === last.questionId) continue;
      if (current.state === "completed") {
        for (const value of this.artifactEvents(current)) yield { payload: { $case: "artifactUpdate", value } };
      }
      yield {
        payload: {
          $case: "statusUpdate",
          value: { taskId: current.id, contextId: current.contextId, status: wireStatus(current), metadata: undefined },
        },
      };
      last = current;
      if (done(current)) return;
    }
  }

  /** The key is still there, unrevoked and unexpired (an open stream outlives its auth check). */
  private async keyActive(key: A2AKey): Promise<boolean> {
    const token = await this.opts.store.tokens.findById(key.id);
    return !!token && token.kind === "a2a" && isTokenActive(token);
  }

  /** The task's artifacts (on COMPLETED: the result). The TCK build overrides it for its scripts. */
  protected artifactsOf(task: A2ATask): Artifact[] {
    return resultArtifacts(task);
  }

  /** The artifacts as stream events, each whole (no chunks). */
  protected artifactEvents(task: A2ATask): TaskArtifactUpdateEvent[] {
    return this.artifactsOf(task).map((artifact) => ({
      taskId: task.id,
      contextId: task.contextId,
      artifact,
      append: false,
      lastChunk: true,
      metadata: undefined,
    }));
  }

  protected wireTask(task: A2ATask, historyLength?: number): Task {
    return toWireTask(task, historyLength, this.artifactsOf(task));
  }

  async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    const key = keyOf(context);
    if (!params.id) throw new RequestMalformedError("id is required");
    const task = await this.opts.tasks.get(key, params.id).catch(rethrowNotFound);
    return this.wireTask(task, params.historyLength);
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
      tasks: page.map((t) => this.wireTask(t, params.historyLength)),
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
    return this.wireTask(canceled);
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

function signalOf(context: ServerCallContext): AbortSignal | undefined {
  const user = context.user;
  return user instanceof A2AKeyUser ? user.signal : undefined;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
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

function dataPart(value: Record<string, unknown>): Part {
  return { content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" };
}

/**
 * §5.3 "Result artifact", on COMPLETED: one artifact with a text part (the turn's final assistant
 * message) and, for a repo task, a data part {branch, head, compareUrl, prUrl?} in camelCase
 * (integrations/agent-engine/README.md "Server contract"). Nothing when the result has neither.
 */
export function resultArtifacts(task: A2ATask): Artifact[] {
  if (task.state !== "completed" || !task.result) return [];
  const { text, branch, head, compareUrl, prUrl } = task.result;
  const parts: Part[] = [];
  // Redacted on the way out too (tasks.ts redacts what it stores): secret-shaped strings never
  // leave over A2A, whatever wrote the row.
  if (text) parts.push(textPart(redact(text)));
  if (branch && head) {
    parts.push(dataPart({ branch, head, ...(compareUrl ? { compareUrl } : {}), ...(prUrl ? { prUrl } : {}) }));
  }
  if (parts.length === 0) return [];
  return [
    {
      artifactId: `${task.id}-result`,
      name: "result",
      description: "The task's final answer, and the branch it pushed",
      parts,
      metadata: undefined,
      extensions: [],
    },
  ];
}

function wireStatus(task: A2ATask): TaskStatus {
  return {
    state: STATE_TO_WIRE[task.state],
    // Status text includes an INPUT_REQUIRED question (tasks.ts questionText); every Task and
    // streaming statusUpdate goes through here.
    message: task.statusText ? agentMessage(task, redact(task.statusText)) : undefined,
    timestamp: task.updatedAt,
  };
}

/** The row as an A2A Task. `history` is the caller's message, then its answers to INPUT_REQUIRED
 * (historyLength 0: none). */
export function toWireTask(task: A2ATask, historyLength?: number, artifacts: Artifact[] = resultArtifacts(task)): Task {
  let history: Message[] = [];
  for (const json of [...(task.message !== undefined ? [task.message] : []), ...(task.replies ?? [])]) {
    history.push({ ...Message.fromJSON(json), taskId: task.id, contextId: task.contextId });
  }
  if (historyLength !== undefined) history = historyLength <= 0 ? [] : history.slice(-historyLength);
  return {
    id: task.id,
    contextId: task.contextId,
    status: wireStatus(task),
    artifacts,
    history,
    metadata: undefined,
  };
}
