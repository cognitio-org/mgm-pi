/**
 * The laptop's own sessions (pi JSONL files under <agent dir>/sessions/<cwd-slug>/), for
 * session_search and session_transcript (outfitter/docs/specs/sysop-tools.md, "Local search").
 *
 * Keyword search only: each file is read once per change (by mtime and size) into short per-entry
 * texts held in memory, and a query counts its words in them. Nothing leaves the machine unless the
 * person opts in to `/sessions sync`, which uploads a session to Outfitter's index.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readableEntry, renderTranscript, type TranscriptEntry, type TranscriptOptions } from "../_shared/transcript.ts";

export interface LocalSession {
  id: string;
  file: string;
  cwd: string;
  name?: string;
  updatedAt: string;
  texts: Array<{ entryId: string; label: string; text: string; at?: string }>;
}

const TOOL_CHARS = 2_000;
const cache = new Map<string, { key: string; session: LocalSession }>();

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
      continue;
    }
    if (e?.type === "session_info" && typeof e.name === "string") session.name = e.name;
    const r = e && typeof e.id === "string" ? readableEntry(e as TranscriptEntry) : undefined;
    if (!r) continue;
    const label = r.role === "tool" ? `${r.tool}${r.isError ? " ✗" : ""}` : r.role;
    const body = r.role === "tool" ? r.text.slice(0, TOOL_CHARS) : [r.text, ...r.calls.map((c) => `→ ${c.name}(${c.args})`), r.failed ? `failed: ${r.failed}` : ""].filter(Boolean).join("\n");
    if (body.trim()) session.texts.push({ entryId: r.id, label, text: body, at: r.timestamp });
  }
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
  const out: LocalSession[] = [];
  for (const f of await sessionFiles(dir)) {
    const s = await loadSession(f);
    if (s) out.push(s);
  }
  return out;
}

export interface LocalHit {
  session: LocalSession;
  hits: Array<{ entryId: string; label: string; text: string; score: number }>;
  score: number;
}

/**
 * Sessions whose entries contain the query's words, best first, up to `limit`. An entry scores by
 * how many distinct query words it has (so one long listing can't win by repeating a word), with
 * user and assistant words counting double over tool output; a session by its best entries.
 */
export function searchLocal(sessions: LocalSession[], query: string, opts: { limit?: number; since?: string; exclude?: Set<string> } = {}): LocalHit[] {
  const words = [...new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length >= 2))];
  if (!words.length) return [];
  const results: LocalHit[] = [];
  for (const s of sessions) {
    if (opts.exclude?.has(s.id)) continue;
    if (opts.since && s.updatedAt < opts.since) continue;
    const hits = [];
    for (const t of s.texts) {
      const lower = t.text.toLowerCase();
      const matched = words.filter((w) => lower.includes(w)).length;
      if (!matched) continue;
      const weight = t.label === "user" || t.label === "assistant" || t.label === "summary" ? 2 : 1;
      hits.push({ entryId: t.entryId, label: t.label, text: t.text, score: (matched / words.length) * weight });
    }
    if (!hits.length) continue;
    hits.sort((a, b) => b.score - a.score);
    const best = hits.slice(0, 3);
    results.push({ session: s, hits: best, score: best.reduce((n, h) => n + h.score, 0) });
  }
  return results.sort((a, b) => b.score - a.score || b.session.updatedAt.localeCompare(a.session.updatedAt)).slice(0, opts.limit ?? 10);
}

function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return iso.slice(0, 10);
}

function snippet(text: string, query: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  const word = query.toLowerCase().split(/\W+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length).find((w) => lower.includes(w));
  const at = word ? lower.indexOf(word) : 0;
  const start = Math.max(0, at - Math.floor(max / 3));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + max)}${start + max < flat.length ? "…" : ""}`;
}

/** The same shape as the cloud's results: a line per session, its best hits under it. */
export function renderLocal(results: LocalHit[], query: string, now = Date.now()): string {
  const lines: string[] = [];
  for (const r of results) {
    const s = r.session;
    lines.push([s.id.slice(0, 8), s.name ? s.name.slice(0, 50) : "", basename(s.cwd) || s.cwd, ago(s.updatedAt, now)].filter(Boolean).join("  "));
    for (const h of r.hits) lines.push(`  [${h.entryId}] ${h.label}: ${snippet(h.text, query)}`);
  }
  return lines.join("\n");
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
  const header = [`session ${session.id.slice(0, 8)} (local)`, session.name ? `"${session.name.slice(0, 60)}"` : "", basename(session.cwd), ago(session.updatedAt), `${entries.length} entries`].filter(Boolean).join("  ");
  return { text: `${header}\n${out.text}` };
}
