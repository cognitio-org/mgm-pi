// Compact session transcripts for agents (Sysop tools, #289): the `sessions.transcript` op, and the
// same rules for a laptop's local sessions (Kernal keeps a copy of this file; a drift test holds the
// two together). An agent pays for every character, so the default view is an outline -- one line
// per turn -- and the text view drops thinking, trims tool output, folds repeats, and stops at a cap
// with a cursor for the next page.
//
// Kept free of api imports (types are local) so the Kernal copy is this file unchanged.

export interface TranscriptEntry {
  id: string;
  parentId?: string | null;
  type: string;
  [key: string]: unknown;
}

export interface TranscriptOptions {
  view?: "outline" | "text";
  /** Only these roles. Default: all. */
  roles?: Array<"user" | "assistant" | "tool" | "summary">;
  /** Tool output in the text view: none (errors keep one line), trimmed (default), or full. */
  toolOutput?: "none" | "trimmed" | "full";
  /** Show the `window` entries either side of this entry id (or unique prefix). */
  around?: string;
  window?: number;
  /** Start after this entry id (or unique prefix): the previous page's `more: from=` cursor. */
  from?: string;
  maxChars?: number;
  /** The tip of the branch to read (pi's leaf); absent means insertion order. */
  leafId?: string;
}

export interface TranscriptResult {
  text: string;
  /** Pass as `from` for the next page; absent on the last page. */
  next?: string;
}

export type EntryRole = "user" | "assistant" | "tool" | "summary";
type Role = EntryRole;

/** The readable part of one entry (also what the search chunker indexes). */
export interface ReadableEntry {
  id: string;
  role: Role;
  text: string;
  calls: Array<{ name: string; args: string }>;
  tool?: string;
  isError?: boolean;
  failed?: string;
  timestamp?: string;
}
type Row = ReadableEntry;

const DEFAULT_MAX = 12_000;
const OUTLINE_CLIP = 160;
const TRIMMED_TOOL = 300;
const TRIMMED_TOOL_ERROR = 600;
const FULL_TOOL = 8_000;
const TEXT_CLIP = 4_000;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function cutBlock(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}… (+${t.length - max + 1} chars)`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const block = b as { type?: string; text?: unknown };
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function compactArgs(args: unknown, max = 120, scrub?: (s: string) => string): string {
  if (scrub && args !== undefined) {
    // Scrub the whole value before anything is cut, so a secret can't be split past the pattern.
    try {
      args = JSON.parse(scrub(JSON.stringify(args)));
    } catch {
      args = scrub(String(args));
    }
  }
  let text: string;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    text = Object.entries(args as Record<string, unknown>)
      .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v.length > 60 ? `${v.slice(0, 59)}…` : v) : JSON.stringify(v)}`)
      .join(" ");
  } else {
    text = typeof args === "string" ? args : JSON.stringify(args ?? "");
  }
  return clip(text, max);
}

function isoOf(ts: unknown): string | undefined {
  if (typeof ts === "string" && ts) return ts;
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(ts).toISOString();
  return undefined;
}

/** The readable part of one entry, or undefined for entries without any (model changes, labels,
 * custom data, the system prompt). Thinking is dropped. `scrub` (the search chunker's redaction)
 * runs over whole texts and arguments before anything is cut. */
export function readableEntry(entry: TranscriptEntry, scrub?: (s: string) => string): ReadableEntry | undefined {
  const row = rowOf(entry, scrub);
  if (!row) return undefined;
  const m = (entry.message ?? {}) as Record<string, unknown>;
  const timestamp = isoOf(entry.timestamp) ?? isoOf(m.timestamp);
  return timestamp ? { ...row, timestamp } : row;
}

function rowOf(entry: TranscriptEntry, scrub?: (s: string) => string): Row | undefined {
  const row = rawRow(entry, scrub);
  if (!row || !scrub) return row;
  return { ...row, text: scrub(row.text), ...(row.failed ? { failed: scrub(row.failed) } : {}) };
}

function rawRow(entry: TranscriptEntry, scrub?: (s: string) => string): Row | undefined {
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return typeof entry.summary === "string" && entry.summary ? { id: entry.id, role: "summary", text: entry.summary, calls: [] } : undefined;
  }
  if (entry.type !== "message") return undefined;
  const m = (entry.message ?? {}) as Record<string, unknown>;
  switch (m.role) {
    case "user":
      return { id: entry.id, role: "user", text: textOf(m.content), calls: [] };
    case "assistant": {
      const blocks = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
      const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
      const calls = blocks.filter((b) => b.type === "toolCall").map((b) => ({ name: String(b.name ?? "tool"), args: compactArgs(b.arguments, 120, scrub) }));
      const failed = m.stopReason === "error" || m.stopReason === "aborted" ? String(m.errorMessage || m.stopReason) : undefined;
      if (!text && !calls.length && !failed) return undefined;
      return { id: entry.id, role: "assistant", text, calls, ...(failed ? { failed } : {}) };
    }
    case "toolResult":
      return { id: entry.id, role: "tool", tool: String(m.toolName ?? "tool"), text: textOf(m.content), calls: [], isError: m.isError === true };
    case "bashExecution": {
      const exit = typeof m.exitCode === "number" && m.exitCode !== 0;
      return { id: entry.id, role: "tool", tool: "bash", text: `$ ${String(m.command ?? "")}\n${typeof m.output === "string" ? m.output : ""}`, calls: [], isError: exit };
    }
    default:
      return undefined;
  }
}

/** The active branch, root first: from the leaf up through parentId. Insertion order without one. */
function branch(entries: TranscriptEntry[], leafId?: string): TranscriptEntry[] {
  if (!leafId) return entries;
  const byId = new Map(entries.map((e) => [e.id, e]));
  if (!byId.has(leafId)) return entries;
  const path: TranscriptEntry[] = [];
  const seen = new Set<string>();
  for (let e = byId.get(leafId); e && !seen.has(e.id); e = e.parentId ? byId.get(e.parentId) : undefined) {
    seen.add(e.id);
    path.push(e);
  }
  return path.reverse();
}

function findIndex(rows: Row[], ref: string | undefined): number | { error: string } | undefined {
  if (!ref) return undefined;
  const exact = rows.findIndex((r) => r.id === ref);
  if (exact >= 0) return exact;
  const hits = rows.map((r, i) => (r.id.startsWith(ref) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 1) return hits[0];
  return { error: hits.length ? `entry "${ref}" is ambiguous` : `no entry "${ref}" in this session's transcript` };
}

function outlineLine(r: Row): string | undefined {
  const tag = `[${r.id}]`;
  if (r.role === "tool") return r.isError ? `${tag} ✗ ${r.tool}: ${clip(r.text, 120)}` : undefined;
  if (r.role === "assistant") {
    const calls = r.calls.length ? ` → ${r.calls.map((c) => c.name).join(", ")}` : "";
    const failed = r.failed ? ` ✗ ${clip(r.failed, 80)}` : "";
    return `${tag} assistant: ${clip(r.text, OUTLINE_CLIP) || "(tools only)"}${calls}${failed}`;
  }
  return `${tag} ${r.role}: ${clip(r.text, OUTLINE_CLIP)}`;
}

function textBlock(r: Row, toolOutput: "none" | "trimmed" | "full"): string | undefined {
  const tag = `[${r.id}]`;
  if (r.role === "tool") {
    if (toolOutput === "none") return r.isError ? `${tag} ✗ ${r.tool}: ${clip(r.text, 160)}` : undefined;
    const max = toolOutput === "full" ? FULL_TOOL : r.isError ? TRIMMED_TOOL_ERROR : TRIMMED_TOOL;
    return `${tag} ${r.isError ? "✗ " : ""}${r.tool} ⇒ ${cutBlock(r.text, max)}`;
  }
  const lines: string[] = [];
  if (r.text) lines.push(`${tag} ${r.role}: ${cutBlock(r.text, TEXT_CLIP)}`);
  for (const c of r.calls) lines.push(`${lines.length ? "  " : `${tag} `}→ ${c.name}(${c.args})`);
  if (r.failed) lines.push(`${lines.length ? "  " : `${tag} `}✗ reply failed: ${clip(r.failed, 200)}`);
  return lines.join("\n") || undefined;
}

export function renderTranscript(entries: TranscriptEntry[], opts: TranscriptOptions = {}): TranscriptResult | { error: string } {
  const view = opts.view ?? "outline";
  const toolOutput = opts.toolOutput ?? "trimmed";
  const maxChars = Math.min(Math.max(opts.maxChars ?? DEFAULT_MAX, 500), 50_000);
  const roles = opts.roles?.length ? new Set(opts.roles) : undefined;

  if (opts.around && opts.from) return { error: "use around or from, not both" };
  const readable = (list: TranscriptEntry[]) => list.map((e) => rowOf(e)).filter((r): r is Row => !!r);
  let rows = readable(branch(entries, opts.leafId));
  let note: string | undefined;
  // A search hit can sit on a branch the session later left: read that branch up to it instead.
  if (opts.around && findIndex(rows, opts.around) !== undefined && typeof findIndex(rows, opts.around) === "object") {
    const all = readable(entries);
    const hit = findIndex(all, opts.around);
    if (typeof hit === "number") {
      rows = readable(branch(entries, all[hit].id));
      note = "(this entry is on an earlier branch of the session)";
    }
  }

  const around = findIndex(rows, opts.around);
  if (around && typeof around === "object") return around;
  const from = findIndex(rows, opts.from);
  if (from && typeof from === "object") return from;
  if (typeof around === "number") {
    const w = Math.min(Math.max(opts.window ?? 6, 1), 50);
    rows = rows.slice(Math.max(0, around - w), around + w + 1);
  } else if (typeof from === "number") {
    rows = rows.slice(from + 1);
  }
  if (roles) rows = rows.filter((r) => roles.has(r.role));

  const out: string[] = note ? [note] : [];
  let used = note ? note.length + 1 : 0;
  let next: string | undefined;
  let lastTool: { key: string; count: number; index: number } | undefined;
  let hiddenTools = 0;
  // Outline: a run of tool-only steps (assistant calls with no words, and their ok results) is one
  // line -- `[first..last] 9 tool steps: bash×5, read×2, git` -- instead of a line per step.
  let steps: { first: string; last: string; count: number; tools: Map<string, number>; index: number } | undefined;
  const stepsLine = (st: NonNullable<typeof steps>) =>
    `[${st.first}${st.count > 1 ? `..${st.last}` : ""}] ${st.count} tool step${st.count === 1 ? "" : "s"}: ${[...st.tools].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(", ")}`;
  for (const r of rows) {
    let line: string | undefined;
    if (view === "outline") {
      const toolsOnly = r.role === "assistant" && !r.text && !r.failed && r.calls.length > 0;
      if (toolsOnly) {
        if (steps && out[steps.index] === stepsLine(steps)) {
          steps.count++;
          steps.last = r.id;
          for (const c of r.calls) steps.tools.set(c.name, (steps.tools.get(c.name) ?? 0) + 1);
          const updated = stepsLine(steps);
          used += updated.length - out[steps.index].length;
          out[steps.index] = updated;
          continue;
        }
        steps = { first: r.id, last: r.id, count: 1, tools: new Map(), index: out.length };
        for (const c of r.calls) steps.tools.set(c.name, (steps.tools.get(c.name) ?? 0) + 1);
        line = stepsLine(steps);
      } else {
        line = outlineLine(r);
        if (!line && r.role === "tool") hiddenTools++;
        else if (line) steps = undefined;
      }
    } else {
      line = textBlock(r, toolOutput);
      // Fold a tool result identical to the previous one into a count.
      if (line && r.role === "tool") {
        const key = `${r.tool}\u0000${r.isError}\u0000${r.text}`;
        if (lastTool && lastTool.key === key) {
          lastTool.count++;
          const folded = out[lastTool.index].replace(/ \(×\d+\)$/, "") + ` (×${lastTool.count})`;
          used += folded.length - out[lastTool.index].length;
          out[lastTool.index] = folded;
          continue;
        }
        lastTool = { key, count: 1, index: out.length };
      } else if (line) {
        lastTool = undefined;
      }
    }
    if (!line) continue;
    // Even a first line longer than the cap is cut to it.
    if (line.length > maxChars) line = `${line.slice(0, maxChars - 1)}…`;
    if (used + line.length + 1 > maxChars && out.length > 0) {
      steps = undefined;
      next = out.length ? rows[rows.indexOf(r) - 1]?.id : undefined;
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  if (view === "outline" && hiddenTools) out.push(`(${hiddenTools} ok tool results not shown; view text for them)`);
  if (next) out.push(`more: from=${next}`);
  return { text: out.join("\n") || "(nothing to show)", ...(next ? { next } : {}) };
}
