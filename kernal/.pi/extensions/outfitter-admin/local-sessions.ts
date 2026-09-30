/**
 * The laptop's own sessions (pi JSONL files under <agent dir>/sessions/<cwd-slug>/), for
 * session_search and session_transcript (outfitter/docs/specs/sysop-tools.md, "Local search").
 *
 * Keyword search only: each file is read once per change (by mtime and size) into short per-entry
 * texts and their word sets, held in memory, and a query matches whole words. Texts are redacted
 * with Outfitter's own patterns (_shared/redact.ts), since results can land in another session's
 * context. Nothing leaves the machine unless the person runs `/sessions sync`.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readableEntry, renderTranscript, type TranscriptEntry, type TranscriptOptions } from "../_shared/transcript.ts";
import { redact } from "../_shared/redact.ts";

export interface LocalText {
  entryId: string;
  label: string;
  text: string;
  words: Set<string>;
}

export interface LocalSession {
  id: string;
  file: string;
  cwd: string;
  name?: string;
  updatedAt: string;
  texts: LocalText[];
}

const TOOL_CHARS = 2_000;
const SNIPPET = 150;
const CAP = 12_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Words too common to rank by. */
const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "at", "by", "be", "with", "from", "this", "that"]);
const cache = new Map<string, { key: string; session: LocalSession }>();

/** A UUID's last 8 characters (pi's ids are UUIDv7: the head is a shared timestamp), else the id. */
export function shortSid(id: string): string {
  return UUID.test(id) ? id.slice(-8) : id.slice(0, 8);
}

/** Whether `ref` names `id`: a prefix of 8+ characters, or its printed tail. */
export function sidMatches(id: string, ref: string): boolean {
  return ref.length >= 8 && (id.startsWith(ref) || id.endsWith(ref));
}

export function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

export async function sessionFiles(dir: string): Promise<string[]> {
  let slugs: string[];
  try {
    slugs = await readdir(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const slug of slugs) {
    const sub = join(dir, slug);
    let names: string[];
    try {
      names = await readdir(sub);
    } catch {
      continue;
    }
    for (const n of names) if (n.endsWith(".jsonl")) files.push(join(sub, n));
  }
  return files;
}

function text(entryId: string, label: string, body: string): LocalText {
  return { entryId, label, text: body, words: new Set(wordsOf(body)) };
}

function parse(file: string, raw: string, mtime: Date): LocalSession | undefined {
  const lines = raw.split("\n").filter((l) => l.trim());
  let header: any;
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {
    return undefined;
  }
  if (header?.type !== "session" || typeof header.id !== "string") return undefined;
  const session: LocalSession = { id: header.id, file, cwd: String(header.cwd ?? ""), updatedAt: mtime.toISOString(), texts: [] };
  for (const line of lines.slice(1)) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a torn last line from a live session
    }
    if (e?.type === "session_info" && typeof e.name === "string") session.name = e.name;
    const r = e && typeof e.id === "string" ? readableEntry(e as TranscriptEntry, redact) : undefined;
    if (!r) continue;
    const label = r.role === "tool" ? `${r.tool}${r.isError ? " ✗" : ""}` : r.role;
    const body = r.role === "tool" ? r.text.slice(0, TOOL_CHARS) : [r.text, ...r.calls.map((c) => `→ ${c.name}(${c.args})`), r.failed ? `failed: ${r.failed}` : ""].filter(Boolean).join("\n");
    if (body.trim()) session.texts.push(text(r.id, label, body));
  }
  // The session's own name ranks it too, like Outfitter's session chunk.
  if (session.name) session.texts.push(text("session", "session", session.name));
  return session;
}

export async function loadSession(file: string): Promise<LocalSession | undefined> {
  let st;
  try {
    st = await stat(file);
  } catch {
    return undefined;
  }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.session;
  const session = parse(file, await readFile(file, "utf8"), st.mtime);
  if (session) cache.set(file, { key, session });
  return session;
}

export async function loadAll(dir: string): Promise<LocalSession[]> {
  const files = await sessionFiles(dir);
  // Forget files that are gone (pruned or deleted sessions).
  const present = new Set(files);
  for (const f of cache.keys()) if (f.startsWith(dir) && !present.has(f)) cache.delete(f);
  const out: LocalSession[] = [];
  for (const f of files) {
    const s = await loadSession(f);
    if (s) out.push(s);
  }
  return out;
}

export interface LocalHit {
  session: LocalSession;
  hits: Array<LocalText & { score: number }>;
  score: number;
}

/**
 * Sessions whose entries contain the query's words, best first, up to `limit`. An entry scores by the
 * share of distinct query words it contains as whole words, with conversation counting double over
 * tool output; a session by its best entries. `exclude` holds printed short ids already shown.
 */
export function searchLocal(sessions: LocalSession[], query: string, opts: { limit?: number; since?: string; exclude?: Set<string> } = {}): LocalHit[] {
  const words = [...new Set(wordsOf(query))];
  if (!words.length) return [];
  const limit = opts.limit ?? 10;
  const perSession = limit <= 5 ? 3 : 2;
  const results: LocalHit[] = [];
  for (const s of sessions) {
    if (opts.exclude?.has(shortSid(s.id))) continue;
    if (opts.since && s.updatedAt < opts.since) continue;
    const hits: Array<LocalText & { score: number }> = [];
    for (const t of s.texts) {
      const matched = words.filter((w) => t.words.has(w)).length;
      if (!matched) continue;
      const weight = ["user", "assistant", "summary", "session"].includes(t.label) ? 2 : 1;
      hits.push({ ...t, score: (matched / words.length) * weight });
    }
    if (!hits.length) continue;
    hits.sort((a, b) => b.score - a.score);
    results.push({ session: s, hits: hits.filter((h) => h.label !== "session").slice(0, perSession), score: hits.slice(0, 3).reduce((n, h) => n + h.score, 0) });
  }
  return results.sort((a, b) => b.score - a.score || b.session.updatedAt.localeCompare(a.session.updatedAt)).slice(0, limit);
}

function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return iso.slice(0, 10);
}

function snippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET) return flat;
  const lower = flat.toLowerCase();
  const word = wordsOf(query).sort((a, b) => b.length - a.length).find((w) => lower.includes(w));
  const at = word ? lower.indexOf(word) : 0;
  const start = Math.max(0, at - Math.floor(SNIPPET / 3));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + SNIPPET)}${start + SNIPPET < flat.length ? "…" : ""}`;
}

/** Cuts text at the cap on a line boundary, with a notice. */
export function capText(text: string, cap = CAP): string {
  if (text.length <= cap) return text;
  const cut = text.lastIndexOf("\n", cap);
  return `${text.slice(0, cut > cap / 2 ? cut : cap)}\n… cut at ${cap} chars; narrow the query or lower limit`;
}

/** The same shape as the cloud's results: a line per session, its best hits under it. */
export function renderLocal(results: LocalHit[], query: string, now = Date.now()): string {
  const lines: string[] = [];
  for (const r of results) {
    const s = r.session;
    lines.push([shortSid(s.id), s.name ? s.name.slice(0, 50) : "", basename(s.cwd) || s.cwd, ago(s.updatedAt, now)].filter(Boolean).join("  "));
    for (const h of r.hits) lines.push(`  [${h.entryId}] ${h.label}: ${snippet(h.text, query)}`);
  }
  return capText(lines.join("\n"));
}

export async function localTranscript(session: LocalSession, opts: TranscriptOptions): Promise<{ text: string } | { error: string }> {
  const raw = await readFile(session.file, "utf8");
  const entries: TranscriptEntry[] = [];
  let leafId: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === "session" || typeof e?.id !== "string") continue;
      entries.push(e);
      leafId = e.id;
    } catch {
      // A torn last line from a live session: skip it.
    }
  }
  const out = renderTranscript(entries, { ...opts, leafId });
  if ("error" in out) return out;
  const header = [`session ${shortSid(session.id)} (local)`, session.name ? `"${session.name.slice(0, 60)}"` : "", basename(session.cwd), ago(session.updatedAt), `${entries.length} entries`].filter(Boolean).join("  ");
  return { text: redact(`${header}\n${out.text}`) };
}
