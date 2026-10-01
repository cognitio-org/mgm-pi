// recordTurn for `memory: auto` tapes (E9 §3.3 "Record"): each user prompt as its entry arrives,
// and the final assistant message of each settled turn (PR1's settle, after agentd's tailer
// flush, so the turn's entries are stored). Agent Engine extracts long-term memories from them on
// its own schedule.
//
// - Next to the session-search indexer (agentlink.ts's entry case), after redact.ts.
// - On a handle bound to the session's identity; recordTurn itself takes no userId.
// - idempotencyKey = `<session id>:<entry id>`, so a replayed entry or settle dedupes server-side
//   (pi's entry ids are 8 hex characters, unique only within a session).
// - Never tool output, tool calls or thinking: user text and assistant text blocks only.
// - Only the owner's own prompts: mail another session sent, and Outfitter's system notices, reach
//   pi as user messages too, but they are someone else's words (an A2A caller's, even), and
//   extraction would file them as the owner's facts.
// - Never for an A2A session (Session.origin === "a2a", §5.4), whatever its tape says.
// - Best effort: queued per instance, bounded, dropped on failure; never holds up an entry.

import type { PiEntry, Session, Store } from "../store/types.ts";
import { redact } from "../search/redact.ts";
import { memoryIdentity } from "./identity.ts";
import { toAgentEngineError, type MemoryService } from "./memory.ts";
import type { MemoryUsage } from "./usage.ts";

const CACHE_MS = 60_000;
const MAX_QUEUE = 200;
const MAX_CONTENT = 8_000;
/** How many of the newest entries a settle looks through for its turn (prompt to final answer). */
const SETTLE_LOOKBACK = 50;
/** The headers mail.ts puts on mail from another session (wrapAgentMail) and on its own notices. */
const RELAYED = /^\[outfitter (?:mail from session |system\])/;

export interface TurnRecord {
  sessionId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  entryId: string;
}

/** The text a turn records for this entry, or undefined when it records nothing. */
export function turnText(entry: PiEntry): { role: "user" | "assistant"; text: string } | undefined {
  if (entry.type !== "message") return undefined;
  const m = (entry.message ?? {}) as { role?: unknown; content?: unknown; stopReason?: unknown };
  let text = "";
  if (m.role === "user") {
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) text = m.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
    if (RELAYED.test(text.trimStart())) return undefined;
  } else if (m.role === "assistant") {
    if (m.stopReason === "error" || m.stopReason === "aborted") return undefined;
    const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: unknown; text?: unknown }>) : [];
    text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
  } else return undefined;
  const clean = recordableText(m.role, text);
  return clean === undefined ? undefined : { role: m.role, text: clean };
}

/**
 * One turn's text as it may be recorded, or undefined when it records nothing: empty, or a user
 * message that is relayed mail or an Outfitter notice. Redacted, then capped. Shared with the
 * laptop's `memory.record` (E9.9), which gets the text from Kernal rather than from stored entries.
 */
export function recordableText(role: "user" | "assistant", raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (role === "user" && RELAYED.test(text)) return undefined;
  // Redacted whole, then cut, so a secret can't be split into an unmatched piece.
  const clean = redact(text);
  return clean.length <= MAX_CONTENT ? clean : `${clean.slice(0, MAX_CONTENT - 1)}…`;
}

function isUserMessage(entry: PiEntry): boolean {
  return entry.type === "message" && (entry.message as { role?: unknown } | undefined)?.role === "user";
}

export class MemoryRecorder {
  private readonly store: Store;
  private readonly memory: () => MemoryService | undefined;
  private readonly log: (message: string) => void;
  private readonly usage?: MemoryUsage;
  private readonly sessions = new Map<string, { session: Session | null; at: number }>();
  /** Per session, whether the newest user message seen here was the owner's (not relayed mail), for
   * a settle whose prompt is further back than SETTLE_LOOKBACK. */
  private readonly ownPrompt = new Map<string, boolean>();
  /** Per session, the note in progress, so a turn's prompt is queued before its answer. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly queue: TurnRecord[] = [];
  private draining: Promise<void> | undefined;
  private dropped = 0;
  private lastError = 0;

  constructor(opts: { store: Store; memory: () => MemoryService | undefined; log?: (message: string) => void; usage?: MemoryUsage }) {
    this.store = opts.store;
    this.memory = opts.memory;
    this.log = opts.log ?? (() => {});
    this.usage = opts.usage;
  }

  /** The session when it records turns now, else undefined. The session is cached briefly; the
   * tape is read every time, so turning `auto` off stops recording at once. */
  private async recording(sessionId: string): Promise<{ session: Session; userId: string } | undefined> {
    if (!this.memory()) return undefined;
    let cached = this.sessions.get(sessionId);
    if (!cached || Date.now() - cached.at >= CACHE_MS) {
      if (this.sessions.size > 500) this.sessions.clear();
      cached = { session: await this.store.sessions.findById(sessionId), at: Date.now() };
      this.sessions.set(sessionId, cached);
    }
    const { session } = cached;
    if (!session) return undefined;
    // §5.4: an A2A session's prompts never reach long-term memory, even on an `auto` tape.
    if (session.origin !== undefined || session.a2aTokenId !== undefined) return undefined;
    const guru = await this.store.gurus.findById(session.guruId);
    if (guru?.memory !== "auto") return undefined;
    const id = memoryIdentity(session);
    return id && !id.a2a ? { session, userId: id.userId } : undefined;
  }

  /** Runs `work` after the session's previous note, so records keep the order entries came in. */
  private chained(sessionId: string, work: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(sessionId) ?? Promise.resolve()).then(work, work);
    this.chains.set(sessionId, next);
    void next.finally(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
    });
    return next;
  }

  /** A newly stored entry: a user prompt is recorded now. Never throws. */
  noteEntry(sessionId: string, entry: PiEntry): Promise<void> {
    return this.chained(sessionId, () => this.entry(sessionId, entry));
  }

  /** A turn settled: its final assistant message is recorded. Never throws. */
  noteSettled(sessionId: string, lastEntryId: string | undefined): Promise<void> {
    return this.chained(sessionId, () => this.settled(sessionId, lastEntryId));
  }

  private async entry(sessionId: string, entry: PiEntry): Promise<void> {
    try {
      if (!isUserMessage(entry)) return;
      const turn = turnText(entry);
      if (this.ownPrompt.size > 500) this.ownPrompt.clear();
      this.ownPrompt.set(sessionId, turn?.role === "user");
      if (turn?.role !== "user") return;
      const rec = await this.recording(sessionId);
      if (rec) this.enqueue({ sessionId, userId: rec.userId, role: "user", content: turn.text, entryId: entry.id });
    } catch (err) {
      this.warn(`memory record (entry) failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async settled(sessionId: string, lastEntryId: string | undefined): Promise<void> {
    try {
      const rec = await this.recording(sessionId);
      if (!rec) return;
      // The turn as stored: back from the settle's last entry (or the newest) to the final assistant
      // text, then on to the prompt that started it. A turn started by relayed mail answers someone
      // else's words, so its answer isn't the owner's either; one whose prompt is out of sight is
      // skipped too.
      const recent = await this.store.entries.listRecent(sessionId, SETTLE_LOOKBACK);
      let i = lastEntryId ? recent.map((r) => r.entry.id).lastIndexOf(lastEntryId) : -1;
      if (i < 0) i = recent.length - 1;
      let final: PiEntry | undefined;
      for (; i >= 0; i--) {
        const e = recent[i].entry;
        if (isUserMessage(e)) {
          if (!turnText(e)) final = undefined; // relayed, or empty
          break;
        }
        if (!final && turnText(e)?.role === "assistant") final = e;
      }
      // The prompt is out of sight (a long turn): go by the last one this instance saw.
      if (i < 0 && this.ownPrompt.get(sessionId) !== true) final = undefined;
      const turn = final ? turnText(final) : undefined;
      if (final && turn) this.enqueue({ sessionId, userId: rec.userId, role: "assistant", content: turn.text, entryId: final.id });
    } catch (err) {
      this.warn(`memory record (settle) failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private enqueue(record: TurnRecord): void {
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(record);
    // drain() clears `draining` in the same step that finds the queue empty, so a record pushed
    // after that always starts a new drain.
    this.draining ??= this.drain();
  }

  /** Waits for everything noted and queued so far (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.chains.size || this.draining) {
      await Promise.all([...this.chains.values()]);
      if (this.draining) await this.draining;
    }
  }

  private async drain(): Promise<void> {
    // One step first, so enqueue has stored this promise before it can be cleared below.
    await Promise.resolve();
    for (let r = this.queue.shift(); r; r = this.queue.shift()) {
      const memory = this.memory();
      if (!memory) {
        this.queue.length = 0;
        break;
      }
      try {
        await memory.bind({ userId: r.userId, sessionId: r.sessionId }).recordTurn({ role: r.role, content: r.content, idempotencyKey: `${r.sessionId}:${r.entryId}` });
        this.usage?.note("recordTurn");
      } catch (err) {
        this.usage?.note("recordTurn", 0, true);
        const e = toAgentEngineError(err);
        this.warn(`memory recordTurn dropped (${e.kind}): ${e.message}`);
      }
    }
    this.draining = undefined;
    if (this.dropped) {
      this.warn(`memory recordTurn queue full: dropped ${this.dropped}`);
      this.dropped = 0;
    }
  }

  /** At most one warning a minute, so an outage doesn't flood the log. */
  private warn(message: string): void {
    const now = Date.now();
    if (now - this.lastError < 60_000) return;
    this.lastError = now;
    this.log(message);
  }
}
