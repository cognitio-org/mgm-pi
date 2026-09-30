// Compact text for admin op results (Sysop tools, #286). An agent pays for every character of a
// result, so these print one line per item, leave out empty fields, never echo the input back, and
// stop at a hard cap with a pointer to the next page instead of cutting off silently.

/** Default cap on one op's text, in characters (~3k tokens). */
export const RESULT_CAP = 12_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UUIDs print as their last 8 characters, which ops accept back; slugs stay whole. The tail, not the
 * head: pi's session ids are UUIDv7, whose first 8 characters are a timestamp shared by every session
 * started in the same minute or so, while the tail is random.
 */
export function shortId(id: string): string {
  return UUID.test(id) ? id.slice(-8) : id;
}

/** Whether `ref` names `id`: a unique prefix (4+ characters), or a UUID's printed tail. */
function refMatches(id: string, ref: string): boolean {
  return id.startsWith(ref) || (UUID.test(id) && ref.length >= 8 && id.endsWith(ref));
}

export type Resolved<T> = { ok: true; item: T } | { ok: false; error: string };

/**
 * An exact id, or a unique prefix of at least 4 characters. The error names a few candidates so
 * the agent can retry without a separate list call.
 */
export function resolveRef<T extends { id: string }>(items: T[], ref: unknown, what: string, label: (t: T) => string = (t) => shortId(t.id)): Resolved<T> {
  if (typeof ref !== "string" || !ref.trim()) return { ok: false, error: `${what} id is required` };
  const needle = ref.trim();
  const exact = items.find((t) => t.id === needle);
  if (exact) return { ok: true, item: exact };
  const matches = needle.length >= 4 ? items.filter((t) => refMatches(t.id, needle)) : [];
  if (matches.length === 1) return { ok: true, item: matches[0] };
  if (matches.length > 1) {
    return { ok: false, error: `${what} "${needle}" is ambiguous: ${matches.slice(0, 5).map(label).join(", ")}` };
  }
  const known = items.slice(0, 10).map(label).join(", ");
  return { ok: false, error: `no ${what} "${needle}"${known ? `; ${what}s: ${known}${items.length > 10 ? ", …" : ""}` : ""}` };
}

/** "3m ago", "2h ago", "5d ago", or the date for anything older than a month. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return iso.slice(0, 10);
}

/** One line, at most `max` characters, with an ellipsis when cut. */
export function clip(text: unknown, max: number): string {
  if (text === undefined || text === null || text === "") return "";
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Joins the non-empty parts of one row with two spaces. */
export function row(...parts: Array<string | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("  ");
}

/** `key: value` lines for the fields that are set. Multi-line values are indented under the key. */
export function fields(pairs: Array<[string, unknown]>): string {
  const out: string[] = [];
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const text = formatValue(value);
    if (text.includes("\n")) out.push(`${key}:\n${text.split("\n").map((l) => `  ${l}`).join("\n")}`);
    else out.push(`${key}: ${text}`);
  }
  return out.join("\n");
}

function formatValue(value: unknown): string {
  if (value === true) return "yes";
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(", ");
  }
  return String(value);
}

/** Cuts `text` at the cap, on a line boundary, and says how to get the rest. */
export function capText(text: string, cap = RESULT_CAP, more?: string): string {
  if (text.length <= cap) return text;
  const cut = text.lastIndexOf("\n", cap);
  const head = text.slice(0, cut > cap / 2 ? cut : cap);
  return `${head}\n… cut at ${cap} chars${more ? `; ${more}` : ""}`;
}

/**
 * What an update changed, one field per line: short values as `field: old → new`, long or
 * multi-line text as a line diff (`-`/`+` lines only, unchanged lines left out).
 */
export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>, keys: string[]): string {
  const out: string[] = [];
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const as = a === undefined ? "" : formatValue(a);
    const bs = b === undefined ? "" : formatValue(b);
    if (as.length <= 80 && bs.length <= 80 && !as.includes("\n") && !bs.includes("\n")) {
      out.push(`${key}: ${as || "(unset)"} → ${bs || "(unset)"}`);
      continue;
    }
    out.push(`${key}:`);
    out.push(...lineDiff(as.split("\n"), bs.split("\n")).map((l) => `  ${l}`));
  }
  return out.length ? out.join("\n") : "no changes";
}

/** Removed and added lines from an LCS of the two line lists (small inputs: tape prompts). */
function lineDiff(a: string[], b: string[]): string[] {
  if (a.length * b.length > 250_000) return [`- (${a.length} lines)`, `+ (${b.length} lines)`];
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out;
}
