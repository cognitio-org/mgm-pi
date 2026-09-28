// #255 spoken replies: what of a reply is worth hearing. A guru's reply is markdown written for the
// eye, with code blocks, links, tables and file paths. Read aloud as is, it's noise. This keeps the
// prose, says "(code omitted)" where a code block was, reads link text without the URL, drops
// markdown punctuation, and splits the rest into sentences, so the first one plays while the others
// are still being synthesized. Modelled on pi-listen's tts-text-filter.ts. Pure, so it's tested
// without a DOM.

/** Markdown reply → plain text to speak. Empty when nothing is worth saying (all code, say). */
export function prepareForSpeech(markdown: string): string {
  let t = markdown.replace(/\r\n?/g, "\n");
  // Fenced code blocks (``` or ~~~, any language): a short marker instead.
  t = t.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, " (code omitted) ");
  // An unterminated fence runs to the end.
  t = t.replace(/^(```|~~~)[^\n]*\n[\s\S]*$/m, " (code omitted) ");
  // Tables: rows of pipes aren't speech.
  t = t.replace(/^\s*\|.*\|\s*$/gm, "");
  // Images disappear; links keep their text; bare URLs go.
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // A URL doesn't take the sentence's closing punctuation with it.
  t = t.replace(/<?https?:\/\/[^\s)>]*[^\s)>.,;:!?]>?/g, "");
  // Inline code: keep a short word (a command, a name), drop anything long.
  t = t.replace(/`([^`\n]+)`/g, (_m, code: string) => (code.length <= 24 && !/[{};=<>]/.test(code) ? code : "that"));
  // HTML tags, headings, emphasis, list markers, block quotes, rules.
  t = t.replace(/<\/?[a-z][^>]*>/gi, "");
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  // Emphasis; underscores only at word edges, so my_var_name keeps its underscores.
  t = t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(?<!\w)__(.+?)__(?!\w)/g, "$1");
  t = t.replace(/\*(\S.*?\S|\S)\*/g, "$1").replace(/(?<!\w)_(\S.*?\S|\S)_(?!\w)/g, "$1");
  t = t.replace(/~~(.+?)~~/g, "$1");
  // Rules before list markers: "* * *" would otherwise lose one star and read as "* *".
  t = t.replace(/^\s*([-*_]\s*){3,}$/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "").replace(/^\s*\d+[.)]\s+/gm, "");
  t = t.replace(/^\s*>\s?/gm, "");
  // A list item or heading without a full stop still ends a sentence when read aloud.
  t = t.replace(/([^.!?:;,\s])\n+/g, "$1.\n");
  t = t.replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  // Repeated markers from several code blocks in a row.
  t = t.replace(/(\(code omitted\)[.\s]*){2,}/g, "(code omitted) ");
  return t === "(code omitted)" || t === "(code omitted)." ? "" : t;
}

/** Splits text into sentences for speaking one at a time, merging very short ones into the next and
 * breaking any over `max` characters at a comma or space. */
export function splitSentences(text: string, max = 280): string[] {
  const raw = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [];
  const out: string[] = [];
  let carry = "";
  for (const piece of raw) {
    const s = (carry ? `${carry} ` : "") + piece.trim();
    if (!piece.trim()) continue;
    if (s.length < 20 && raw.length > 1) {
      carry = s;
      continue;
    }
    carry = "";
    out.push(...breakLong(s, max));
  }
  if (carry) out.push(...breakLong(carry, max));
  return out.filter(Boolean);
}

function breakLong(s: string, max: number): string[] {
  const parts: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(", ", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** The text of an assistant reply entry (its text blocks, not thinking or tool calls), or "" when
 * the entry isn't one. */
export function replyText(entry: { type?: unknown; message?: unknown }): string {
  if (entry.type !== "message") return "";
  const m = entry.message as { role?: unknown; content?: unknown } | undefined;
  if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return "";
  return m.content
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}
