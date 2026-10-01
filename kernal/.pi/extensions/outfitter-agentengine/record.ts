/**
 * Opt-in recording of laptop turns into Agent Engine memory (outfitter/docs/specs/atlas-agent-
 * engine-and-a2a.md §3.5). Off unless the person set `kernal.memoryRecord: true` (`/memory record
 * on`), the same opt-in the session-search upload has.
 *
 * - After each turn (pi's `agent_end`), the turn's user prompt and its final assistant message, as
 *   stored in the session (entry ids from the session file): text blocks only. Never tool calls,
 *   tool results or thinking.
 * - Redacted here (_shared/redact.ts) and again by the API, which also drops relayed mail and
 *   Outfitter's notices.
 * - Queued and sent in the background in batches (op `memory.record`, keyed `laptop:<pi session
 *   id>:<entry id>`, so a resend dedupes). Bounded; dropped on failure; never holds up a turn.
 */
import { redact } from "../_shared/redact.ts";
import type { AdminTransport, LaptopContext } from "../outfitter-admin/transport.ts";

const MAX_QUEUE = 100;
const BATCH = 20;
const MAX_TEXT = 8_000;

export interface Turn {
  entryId: string;
  role: "user" | "assistant";
  text: string;
}

type Entry = { type?: string; id?: string; message?: { role?: string; content?: unknown; stopReason?: string } };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

/** Redacted whole, then cut, so a secret can't be split into an unmatched piece. */
export function cleanText(raw: string): string {
  const clean = redact(raw.trim());
  return clean.length <= MAX_TEXT ? clean : `${clean.slice(0, MAX_TEXT - 1)}…`;
}

/**
 * The last turn on a branch (oldest first, as getBranch returns it): its user prompt and final
 * assistant text, minus entries already sent. Nothing when the newest user entry has no text.
 */
export function lastTurn(branch: readonly Entry[], sent: ReadonlySet<string> = new Set()): Turn[] {
  let final: Turn | undefined;
  let seenAssistant = false;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e?.type !== "message" || typeof e.id !== "string") continue;
    const role = e.message?.role;
    // Only the turn's last assistant message is its answer; an earlier one is a step between tools.
    if (role === "assistant") {
      if (seenAssistant) continue;
      seenAssistant = true;
      if (e.message?.stopReason === "error" || e.message?.stopReason === "aborted") continue;
      const text = textOf(e.message?.content).trim();
      if (text) final = { entryId: e.id, role: "assistant", text: cleanText(text) };
      continue;
    }
    if (role === "user") {
      const text = textOf(e.message?.content).trim();
      if (!text) return [];
      const turn: Turn[] = [{ entryId: e.id, role: "user", text: cleanText(text) }];
      if (final) turn.push(final);
      return turn.filter((t) => !sent.has(t.entryId));
    }
  }
  return [];
}

/** The background queue: `note` after each turn, `flush` at shutdown. */
export class TurnRecorder {
  private readonly queue: Array<Turn & { laptop: LaptopContext }> = [];
  private readonly sent = new Set<string>();
  private draining: Promise<void> | undefined;
  private warned = false;
  private readonly transport: AdminTransport;
  private readonly warn: (message: string) => void;

  constructor(transport: AdminTransport, warn: (message: string) => void = () => {}) {
    this.transport = transport;
    this.warn = warn;
  }

  /** Queues the branch's last turn for `laptop`'s session. Never throws, never waits. */
  note(branch: readonly Entry[], laptop: LaptopContext): void {
    try {
      for (const t of lastTurn(branch, this.sent)) {
        this.sent.add(t.entryId);
        if (this.queue.length >= MAX_QUEUE) this.queue.shift();
        this.queue.push({ ...t, laptop });
      }
      if (this.sent.size > 5_000) this.sent.clear();
      if (this.queue.length) this.draining ??= this.drain();
    } catch {
      // Best effort.
    }
  }

  /** Waits for what is queued, at most `ms`. */
  async flush(ms = 2_000): Promise<void> {
    if (!this.draining) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.draining, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
  }

  private async drain(): Promise<void> {
    await Promise.resolve();
    while (this.queue.length) {
      // One session per batch: the API binds a call to one session id.
      const sessionId = this.queue[0].laptop.sessionId;
      const batch: Array<Turn & { laptop: LaptopContext }> = [];
      while (batch.length < BATCH && this.queue.length && this.queue[0].laptop.sessionId === sessionId) batch.push(this.queue.shift()!);
      const turns = batch.map(({ entryId, role, text }) => ({ entryId, role, text }));
      try {
        const reply = await this.transport.call("memory.record", { turns }, { laptop: batch[0].laptop });
        if (!reply.ok) this.once(`memory: recording failed: ${reply.error}`);
      } catch (err) {
        this.once(`memory: recording failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.draining = undefined;
  }

  /** The first failure is reported once per process; the rest are dropped quietly. */
  private once(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.warn(message);
  }
}
