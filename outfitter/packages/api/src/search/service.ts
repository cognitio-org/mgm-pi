// Session search and transcripts (Sysop tools, #289): keeping `sessionChunks` in step with
// `entries`, and the two read ops agents use -- `sessions.search` and `sessions.transcript`.
// Results are compact text grouped by session (admin/render.ts rules): a header line per session,
// at most three hits under it, snippets around the match.

import type { ChunkHit, ChunkSearchMode, PiEntry, Session, SessionChunk, Store } from "../store/types.ts";
import { SearchUnavailableError } from "../store/types.ts";
import { chunkEntry, chunkSession } from "./chunker.ts";
import { renderTranscript, type TranscriptOptions } from "./transcript.ts";
import { ago, clip, row, shortId } from "../admin/render.ts";

const SESSION_CACHE_MS = 60_000;
const HITS_PER_SESSION = 3;
const SNIPPET = 200;

/** Writes chunks as entries arrive. Best effort: a failure is logged and never holds up an entry. */
export class SessionIndexer {
  private readonly store: Store;
  private readonly log: (message: string) => void;
  private readonly sessions = new Map<string, { session: Session; at: number }>();

  constructor(store: Store, log: (message: string) => void = () => {}) {
    this.store = store;
    this.log = log;
  }

  private async session(sessionId: string): Promise<Session | null> {
    const cached = this.sessions.get(sessionId);
    if (cached && Date.now() - cached.at < SESSION_CACHE_MS) return cached.session;
    const session = await this.store.sessions.findById(sessionId);
    if (!session) return null;
    if (this.sessions.size > 500) this.sessions.clear();
    // The first entry seen for a session (in this process) also refreshes its session chunk.
    if (!cached) await this.store.sessionChunks.upsertMany([chunkSession(session)]);
    this.sessions.set(sessionId, { session, at: Date.now() });
    return session;
  }

  async indexEntry(sessionId: string, entry: PiEntry): Promise<void> {
    try {
      const session = await this.session(sessionId);
      const chunk = session ? chunkEntry(session, entry) : undefined;
      if (chunk) await this.store.sessionChunks.upsertMany([chunk]);
    } catch (err) {
      this.log(`session index failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Every entry of one session again (teleport import, backfill). Returns how many chunks. */
  async reindexSession(sessionId: string): Promise<number> {
    const session = await this.store.sessions.findById(sessionId);
    if (!session) return 0;
    const rows = await this.store.entries.listForSession(sessionId);
    const chunks: SessionChunk[] = [chunkSession(session)];
    for (const r of rows) {
      const c = chunkEntry(session, r.entry);
      if (c) chunks.push(c);
    }
    for (let i = 0; i < chunks.length; i += 200) await this.store.sessionChunks.upsertMany(chunks.slice(i, i + 200));
    this.sessions.set(sessionId, { session, at: Date.now() });
    return chunks.length;
  }

  async removeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    await this.store.sessionChunks.deleteForSession(sessionId);
  }
}

/** `7d`, `12h`, `30m`, or an ISO date. Undefined for anything else. */
export function parseSince(value: unknown, now = Date.now()): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const rel = /^(\d+)\s*([mhdw])$/i.exec(value.trim());
  if (rel) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase() as "m" | "h" | "d" | "w"];
    return new Date(now - Number(rel[1]) * unit).toISOString();
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** About SNIPPET characters of `text` around the first query word it contains. */
export function snippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET) return flat;
  const lower = flat.toLowerCase();
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
  let at = -1;
  for (const w of words) {
    at = lower.indexOf(w);
    if (at >= 0) break;
  }
  if (at < 0) return clip(flat, SNIPPET);
  const start = Math.max(0, at - Math.floor(SNIPPET / 3));
  const piece = flat.slice(start, start + SNIPPET);
  return `${start > 0 ? "…" : ""}${piece}${start + SNIPPET < flat.length ? "…" : ""}`;
}

export interface SearchArgs {
  query?: unknown;
  mode?: unknown;
  owner?: unknown;
  tape?: unknown;
  repo?: unknown;
  role?: unknown;
  session?: unknown;
  since?: unknown;
  until?: unknown;
  limit?: unknown;
  explain?: unknown;
}

const MODES: ChunkSearchMode[] = ["hybrid", "text", "semantic"];
const ROLES = ["user", "assistant", "tool", "summary", "session"] as const;

export type SearchResult = { ok: true; text: string } | { ok: false; error: string };

export async function searchSessions(store: Store, callerEmail: string, args: SearchArgs, now = Date.now()): Promise<SearchResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { ok: false, error: "query is required" };
  if (query.length > 500) return { ok: false, error: "query is too long (500 characters at most)" };
  const mode = (MODES as unknown[]).includes(args.mode) ? (args.mode as ChunkSearchMode) : "hybrid";
  const sessions = Math.min(Math.max(typeof args.limit === "number" ? Math.floor(args.limit) : 10, 1), 25);
  const role = (ROLES as readonly unknown[]).includes(args.role) ? (args.role as (typeof ROLES)[number]) : undefined;
  const owner = args.owner === "me" ? callerEmail.toLowerCase() : typeof args.owner === "string" && args.owner.includes("@") ? args.owner.toLowerCase() : undefined;

  let hits: ChunkHit[];
  try {
    hits = await store.sessionChunks.search({
      text: query,
      mode,
      limit: Math.min(sessions * 5, 100),
      filter: {
        ownerEmail: owner,
        guruId: typeof args.tape === "string" && args.tape ? args.tape : undefined,
        repo: typeof args.repo === "string" && args.repo ? args.repo : undefined,
        sessionId: typeof args.session === "string" && args.session ? args.session : undefined,
        role,
        since: parseSince(args.since, now),
        until: parseSince(args.until, now),
      },
    });
  } catch (err) {
    if (err instanceof SearchUnavailableError) return { ok: false, error: `${err.message}${mode !== "text" ? "; mode:text may work" : ""}` };
    throw err;
  }
  if (!hits.length) return { ok: true, text: "no matches" };

  const order: string[] = [];
  const bySession = new Map<string, ChunkHit[]>();
  for (const h of hits) {
    const list = bySession.get(h.chunk.sessionId);
    if (!list) {
      if (order.length >= sessions) continue;
      order.push(h.chunk.sessionId);
      bySession.set(h.chunk.sessionId, [h]);
    } else if (list.length < HITS_PER_SESSION) list.push(h);
  }
  const lines: string[] = [];
  for (const id of order) {
    const s = await store.sessions.findById(id);
    lines.push(
      row(shortId(id), s ? clip(s.name ?? s.prompt, 50) || undefined : "(deleted)", s ? `tape=${shortId(s.guruId)}` : undefined, s?.repo ?? undefined, s ? ago(s.updatedAt, now) : undefined),
    );
    for (const h of bySession.get(id)!) {
      if (h.chunk.role === "session") continue;
      const who = h.chunk.role === "tool" ? `${h.chunk.tool ?? "tool"}${h.chunk.isError ? " ✗" : ""}` : h.chunk.role;
      const score = args.explain === true && typeof h.score === "number" ? ` (${h.score.toFixed(3)})` : "";
      lines.push(`  [${h.chunk.entryId}] ${who}: ${snippet(h.chunk.text, query)}${score}`);
    }
  }
  return { ok: true, text: lines.join("\n") };
}

export interface TranscriptArgs {
  id?: unknown;
  view?: unknown;
  around?: unknown;
  window?: unknown;
  from?: unknown;
  maxChars?: unknown;
  toolOutput?: unknown;
  roles?: unknown;
}

export async function sessionTranscript(store: Store, session: Session, args: TranscriptArgs, now = Date.now()): Promise<SearchResult> {
  const rows = await store.entries.listForSession(session.id);
  const opts: TranscriptOptions = {
    view: args.view === "text" ? "text" : "outline",
    toolOutput: args.toolOutput === "none" || args.toolOutput === "full" ? args.toolOutput : "trimmed",
    around: typeof args.around === "string" ? args.around : undefined,
    window: typeof args.window === "number" ? args.window : undefined,
    from: typeof args.from === "string" ? args.from : undefined,
    maxChars: typeof args.maxChars === "number" ? args.maxChars : undefined,
    roles: Array.isArray(args.roles) ? (args.roles.filter((r) => ["user", "assistant", "tool", "summary"].includes(r)) as TranscriptOptions["roles"]) : undefined,
    leafId: session.leafId,
  };
  const out = renderTranscript(rows.map((r) => r.entry), opts);
  if ("error" in out) return { ok: false, error: out.error };
  const header = row(`session ${shortId(session.id)}`, session.name ? `"${clip(session.name, 60)}"` : undefined, `tape=${shortId(session.guruId)}`, session.repo ?? undefined, ago(session.updatedAt, now), `${rows.length} entries`);
  return { ok: true, text: `${header}\n${out.text}` };
}
