// What the composer does with a paste (docs/reports/markdown-composer.md), decided synchronously
// in the paste event from the clipboard's text/plain and text/html. The HTML converter itself
// (html-to-markdown.ts) is lazy-loaded only when this returns "html".

export type PasteChoice =
  /** Let the browser paste text/plain as usual (keeps native undo; Markdown stays as typed). */
  | { kind: "native" }
  /** Insert this Markdown instead (spreadsheet cells as a GFM table). */
  | { kind: "insert"; text: string }
  /** Convert the HTML to Markdown (async: load the converter first). */
  | { kind: "html"; html: string; fallback: string }
  /** Nothing usable: files or images only. The composer has no upload, so ignore it. */
  | { kind: "ignore" };

// Tags that carry structure worth converting. Clipboard HTML with none of these (VS Code, a
// terminal, a plain <p> of text, a code editor's coloured <span>s) pastes as plain text.
const STRUCTURE_RE = /<(h[1-6]|b|strong|em|i|a|ul|ol|li|table|pre|code|blockquote|hr|del|s)[\s>]/i;

export function choosePaste(plain: string, html: string, hasFiles: boolean, forcePlain = false): PasteChoice {
  if (forcePlain) return plain ? { kind: "native" } : { kind: "ignore" };
  if (!plain && !html) return hasFiles ? { kind: "ignore" } : { kind: "native" };
  // Spreadsheets (Sheets, Excel, Numbers) put tab-separated cells on text/plain. Their HTML is at
  // best a <table> and at worst megabytes of Excel styling, so the TSV is the better source.
  const tsv = tsvToMarkdown(plain);
  if (tsv && (!html || /<table[\s>]/i.test(html))) return { kind: "insert", text: tsv };
  if (html && STRUCTURE_RE.test(html)) return { kind: "html", html, fallback: plain };
  return plain ? { kind: "native" } : { kind: "ignore" };
}

function cellMd(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Tab-separated rows -> a GFM table, or null when `text` isn't rectangular TSV. Rectangular means
 * at least two rows and two columns, and every row has the same number of tabs (a spreadsheet
 * selection always does). Code indented with tabs, which usually starts every line with a tab, is
 * not a table. */
export function tsvToMarkdown(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (!lines.length || !lines[0]!.includes("\t")) return null;
  // Excel quotes a cell containing a newline or tab; those rows can't be split line-wise.
  if (text.includes('"') && /(^|\t)"[^"\t]*\n/.test(text)) return null;
  const rows = lines.map((l) => l.split("\t"));
  const cols = rows[0]!.length;
  if (rows.length < 2 || cols < 2 || rows.some((r) => r.length !== cols)) return null;
  if (rows.every((r) => r[0] === "")) return null;
  const cells = rows.map((r) => r.map(cellMd));
  const widths = cells[0]!.map((_, c) => Math.max(3, ...cells.map((r) => r[c]!.length)));
  const pad = widths.reduce((a, b) => a + b + 3, 1) <= 120;
  const line = (r: string[]) => "| " + r.map((t, c) => (pad ? t.padEnd(widths[c]!) : t)).join(" | ") + " |";
  // Right-align a column whose body cells are all numbers.
  const numeric = (c: number) =>
    cells.length > 1 && cells.slice(1).every((r) => r[c] === "" || /^[-+]?[$€£¥]?[\d,.]+%?$/.test(r[c]!)) && cells.slice(1).some((r) => r[c] !== "");
  const delim = "| " + widths.map((w, c) => (numeric(c) ? "-".repeat((pad ? w : 3) - 1) + ":" : "-".repeat(pad ? w : 3))).join(" | ") + " |";
  return [line(cells[0]!), delim, ...cells.slice(1).map(line)].join("\n");
}
