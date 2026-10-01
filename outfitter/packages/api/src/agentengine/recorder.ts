// recordTurn for `memory: auto` tapes (E9 §3.3 "Record"): each user prompt as its entry arrives,
// and the final assistant message of each settled turn (PR1's settle, after agentd's tailer
// flush, so the turn's entries are stored). Agent Engine extracts long-term memories from them on
// its own schedule.
//
// - Next to the session-search indexer (agentlink.ts's entry case), after redact.ts.
// - On a handle bound to the session's identity; recordTurn itself takes no userId.
// - idempotencyKey = the entry id, so a replayed entry or settle dedupes server-side.
// - Never tool output, tool calls or thinking: user text and assistant text blocks only.
// - Never for an A2A session (Session.origin === "a2a", §5.4), whatever its tape says.
// - Best effort: queued per instance, bounded, dropped on failure; never holds up an entry.

import type { Guru, PiEntry, Session, Store } from "../store/types.ts";
import { redact } from "../search/redact.ts";
import { memoryIdentity } from "./identity.ts";
import { toAgentEngineError, type MemoryService } from "./memory.ts";
import type { MemoryUsage } from "./usage.ts";

const CACHE_MS = 60_000;
const MAX_QUEUE = 200;
const MAX_CONTENT = 8_000;
/** How far back a settle looks for its final assistant message when lastEntryId isn't one. */
const SETTLE_LOOKBACK = 10;

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
  } else if (m.role === "assistant") {
    if (m.stopReason === "error" || m.stopReason === "aborted") return undefined;
    const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: unknown; text?: unknown }>) : [];
    text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
  } else return undefined;
  text = text.trim();
  if (!text) return undefined;
  // Redacted whole, then cut, so a secret can't be split into an unmatched piece.
  const clean = redact(text);
  return { role: m.role, text: clean.length <= MAX_CONTENT ? clean : `${clean.slice(0, MAX_CONTENT - 1)}…` };
}

export class MemoryRecorder {
  private readonly store: Store;
  private readonly memory: () => MemoryService | undefined;
  private readonly log: (message: string) => void;
  private readonly usage?: MemoryUsage;
  private readonly sessions = new Map<string, { session: Session | null; guru: Guru | null; at: number }>();
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

  /** The session and its tape when it records turns now, else undefined. */
  private async recording(sessionId: string): Promise<{ session: Session; userId: string } | undefined> {
    if (!this.memory()) return undefined;
    let cached = this.sessions.get(sessionId);
    if (!cached || Date.now() - cached.at >= CACHE_MS) {
      const session = await this.store.sessions.findById(sessionId);
      const guru = session ? await this.store.gurus.findById(session.guruId) : null;
      if (this.sessions.size > 500) this.sessions.clear();
      cached = { session, guru, at: Date.now() };
      this.sessions.set(sessionId, cached);
    }
    const { session, guru } = cached;
    if (!session || guru?.memory !== "auto") return undefined;
    // §5.4: an A2A session's prompts never reach long-term memory, even on an `auto` tape.
    if (session.origin !== undefined) return undefined;
    const id = memoryIdentity(session);
    return id && !id.a2a ? { session, userId: id.userId } : undefined;
  }

  /** A newly stored entry: a user prompt is recorded now. Never throws. */
  async noteEntry(sessionId: string, entry: PiEntry): Promise<void> {
    try {
      const turn = turnText(entry);
      if (turn?.role !== "user") return;
      const rec = await this.recording(sessionId);
      if (rec) this.enqueue({ sessionId, userId: rec.userId, role: "user", content: turn.text, entryId: entry.id });
    } catch (err) {
      this.warn(`memory record (entry) failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A turn settled: its final assistant message is recorded. Never throws. */
  async noteSettled(sessionId: string, lastEntryId: string | undefined): Promise<void> {
    try {
      const rec = await this.recording(sessionId);
      if (!rec) return;
      let final: PiEntry | undefined;
      if (lastEntryId) {
        const row = await this.store.entries.findByEntryId(sessionId, lastEntryId);
        if (row && turnText(row.entry)?.role === "assistant") final = row.entry;
      }
      if (!final) {
        const recent = await this.store.entries.listRecent(sessionId, SETTLE_LOOKBACK);
        for (let i = recent.length - 1; i >= 0; i--) {
          const t = turnText(recent[i].entry);
          if (t?.role === "user") break; // the newest turn has no assistant text: nothing to record
          if (t?.role === "assistant") {
            final = recent[i].entry;
            break;
          }
        }
      }
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
    this.draining ??= this.drain().finally(() => (this.draining = undefined));
  }

  /** Waits for everything queued so far (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    for (let r = this.queue.shift(); r; r = this.queue.shift()) {
      const memory = this.memory();
      if (!memory) {
        this.queue.length = 0;
        return;
      }
      try {
        await memory.bind({ userId: r.userId, sessionId: r.sessionId }).recordTurn({ role: r.role, content: r.content, idempotencyKey: r.entryId });
        this.usage?.note("recordTurn");
      } catch (err) {
        this.usage?.note("recordTurn", 0, true);
        const e = toAgentEngineError(err);
        this.warn(`memory recordTurn dropped (${e.kind}): ${e.message}`);
      }
    }
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
