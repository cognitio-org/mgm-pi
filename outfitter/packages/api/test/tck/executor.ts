// E9 PR6: the A2A TCK's fake executor (docs/specs/atlas-agent-engine-and-a2a.md, Delivery PR6).
// The TCK scripts its system under test by messageId prefix (`tck-*`, the reference SUT's
// tck/sut/a2a-python/sut_agent.py and tck/scenarios/*.feature). Instead of a Drive, this plays
// agentd against the REAL handler, A2ATasks and store: it moves the task's run to running, records
// pi's acceptance of the mail and its settle through TurnWaiters, writes the turn's entries, and
// raises a pending `input` request. Every A2A state the TCK sees is then derived by A2ATasks.refresh
// exactly as in production.

import { randomUUID } from "node:crypto";
import type { TestApp } from "../helpers.ts";
import type { A2ATask } from "../../src/store/types.ts";

/** What the reference SUT replies for each prefix the TCK sends (text artifacts come from the
 * turn's final assistant message, the real path). File, url, data and chunked artifacts are the
 * scripted handler's (sut.ts). */
const REPLIES: Array<[prefix: string, text: string | undefined]> = [
  ["tck-stream-artifact-chunked", undefined],
  ["tck-stream-artifact-text", "Streamed text content"],
  ["tck-stream-artifact-file", undefined],
  ["tck-stream-ordering-001", "Ordered output"],
  ["tck-stream-001", "Stream hello from TCK"],
  ["tck-stream-002", undefined],
  ["tck-stream-003", "Stream task lifecycle"],
  ["tck-artifact-text", "Generated text content"],
  ["tck-artifact-file-url", undefined],
  ["tck-artifact-file", undefined],
  ["tck-artifact-data", undefined],
  ["tck-complete-task", "Hello from TCK"],
];

/** The reference SUT holds this one WORKING for 2x its 2 s streaming timeout. */
const RESUBSCRIBE_PREFIX = "test-resubscribe-message-id";
const RESUBSCRIBE_MS = 4_000;

interface Script {
  phase: "new" | "working" | "asking" | "done";
  since: number;
  runId?: string;
  seq: number;
}

export interface TckExecutorOptions {
  /** How long a task stays WORKING before it settles (a stream sees the WORKING update first). */
  workMs?: number;
  tickMs?: number;
}

export class TckExecutor {
  private readonly app: TestApp;
  private readonly workMs: number;
  private readonly tickMs: number;
  private readonly scripts = new Map<string, Script>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(app: TestApp, opts: TckExecutorOptions = {}) {
    this.app = app;
    this.workMs = opts.workMs ?? 600;
    this.tickMs = opts.tickMs ?? 50;
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      this.tick()
        .catch((err) => console.error("tck executor:", err))
        .finally(() => {
          this.busy = false;
        });
    }, this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    for (const row of await this.app.store.a2aTasks.listOpen(1000)) {
      if (!row.sessionId || !row.mailId || !row.waiterId) continue;
      let script = this.scripts.get(row.id);
      if (!script) {
        script = { phase: "new", since: Date.now(), seq: 0 };
        this.scripts.set(row.id, script);
      }
      if (script.phase !== "done") await this.step(row, script);
    }
  }

  private async step(row: A2ATask, script: Script): Promise<void> {
    const store = this.app.store;
    const sessionId = row.sessionId!;
    const messageId = row.messageId ?? "";
    if (script.phase === "new") {
      // A follow-up reuses its context's run; a new task's session got one from the inline wake.
      const run = (await store.runs.findActiveForSession(sessionId)) ?? (await this.app.runs.wake(sessionId));
      await store.runs.update(run.id, { state: "running", updatedAt: new Date().toISOString() });
      script.runId = run.id;
      script.seq = (await store.entries.maxSeq(sessionId)) + 1;
      await this.app.turns.noteMailAccepted(sessionId, run.id, row.mailId!, script.seq);
      // pi stores the mail's text as the turn's user entry.
      const mail = await store.mail.findById(row.mailId!);
      script.seq++;
      await store.entries.insertIfNew(
        sessionId,
        script.seq,
        { id: `tck-${randomUUID()}`, parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: mail?.text ?? "" }] } },
        { runId: run.id },
      );
      // A tool call, so WORKING carries the latest tool name as its status text.
      await this.entry(sessionId, script, [{ type: "toolCall", id: randomUUID(), name: "bash", arguments: {} }]);
      script.phase = "working";
      script.since = Date.now();
      return;
    }
    const runId = script.runId!;
    if (script.phase === "working") {
      const hold = messageId.startsWith(RESUBSCRIBE_PREFIX) ? RESUBSCRIBE_MS : this.workMs;
      if (Date.now() - script.since < hold) return;
      if (messageId.startsWith("tck-input-required")) {
        await this.ask(runId, `tck-ask-${row.id}`);
        script.phase = "asking";
        return;
      }
      if (messageId.startsWith("tck-reject-task")) {
        await this.app.turns.cancel(row.waiterId!, "rejected by the TCK script");
        script.phase = "done";
        return;
      }
      const scripted = REPLIES.find(([prefix]) => messageId.startsWith(prefix));
      await this.settle(sessionId, script, scripted ? scripted[1] : `Unhandled messageId prefix: ${messageId}`);
      return;
    }
    if (script.phase === "asking") {
      const run = await store.runs.findById(runId);
      // Answered (A2ATasks.answer cleared it, and queued the ui_response for this run). Like the
      // reference SUT, the answer's own messageId says what happens next: another question, or done.
      if (!run || run.pendingUiRequest) return;
      const answers = (await store.a2aTasks.findForToken(row.tokenId, row.id))?.answerKeys ?? [];
      if ((answers.at(-1) ?? "").startsWith("tck-input-required")) {
        await this.ask(runId, `tck-ask-${row.id}-${answers.length}`);
        return;
      }
      await this.settle(sessionId, script, "Thanks, done.");
    }
  }

  /** pi's `input` dialog, as agentlink stores it. */
  private async ask(runId: string, id: string): Promise<void> {
    await this.app.store.runs.update(runId, {
      pendingUiRequest: { type: "extension_ui_request", id, method: "input", title: "Which file should change?" },
      updatedAt: new Date().toISOString(),
    });
  }

  private async entry(sessionId: string, script: Script, content: unknown[]): Promise<string> {
    const id = `tck-${randomUUID()}`;
    script.seq++;
    await this.app.store.entries.insertIfNew(
      sessionId,
      script.seq,
      { id, parentId: null, type: "message", message: { role: "assistant", content } },
      { runId: script.runId },
    );
    return id;
  }

  private async settle(sessionId: string, script: Script, text: string | undefined): Promise<void> {
    const last = await this.entry(sessionId, script, text ? [{ type: "text", text }] : [{ type: "toolCall", id: randomUUID(), name: "edit", arguments: {} }]);
    script.seq++;
    await this.app.turns.noteSettled(sessionId, script.runId!, script.seq, last);
    script.phase = "done";
  }
}
