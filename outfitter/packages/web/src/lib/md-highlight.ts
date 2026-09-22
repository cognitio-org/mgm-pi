// Live Markdown highlighting for the composer (docs/reports/markdown-composer.md).
//
// The composer draws a mirrored <pre> behind a transparent-text <textarea>. This module turns the
// draft into the <pre>'s contents. Two hard rules follow from that design:
//  1. The concatenated token text must equal the input exactly, character for character. The
//     overlay only colours text, it never adds, drops or reorders any, or the caret drifts.
//  2. It must be cheap: it runs on every keystroke. It is one pass over the lines plus a sticky
//     regex per inline candidate, with no lookbehind (Safari before 16.4 rejects it at parse time,
//     which would break the whole Session chunk on an older iPhone).
//
// It is a highlighter, not a parser: it approximates CommonMark/GFM closely enough to colour what
// the user is typing. Known gaps are listed in the report.

export type TokenClass =
  | "h" // heading line text
  | "mk" // syntax marker: # > ** _ ` [ ]( ) and friends, dimmed
  | "b" // bold
  | "i" // italic
  | "s" // strikethrough
  | "code" // inline code
  | "fence" // ``` fence line
  | "lang" // the fence's language label
  | "pre" // fenced code block body
  | "link" // link text
  | "url" // link target / bare URL
  | "li" // list marker
  | "q" // blockquote text
  | "pipe" // table pipe
  | "tdelim" // table delimiter row |---|:--:|
  | "hr"; // horizontal rule

export interface Token {
  text: string;
  cls?: TokenClass;
}

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/;
const HEADING_RE = /^( {0,3})(#{1,6})(?=[ \t]|$)/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^( {0,3}>[ \t]?)/;
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const TASK_RE = /^\[[ xX]\](?=[ \t])/;
// A GFM delimiter row: at least one pipe or a leading/trailing pipe, cells of -, with optional colons.
const TDELIM_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** Split into lines, keeping each line's own "\n" out of the line (it is re-added as plain text). */
function splitLines(src: string): string[] {
  return src.split("\n");
}

function isTableDelim(line: string): boolean {
  return line.includes("-") && line.includes("|") && TDELIM_RE.test(line);
}

/** Marks which lines are inside a fenced code block ("fence" = an opening/closing fence line,
 * "pre" = a body line) and which lines belong to a pipe table ("tdelim" / "row"). */
export type LineKind = "text" | "fence" | "pre" | "tdelim" | "row";

export function classifyLines(lines: string[]): LineKind[] {
  const kinds: LineKind[] = new Array(lines.length).fill("text");
  let open: { ch: string; len: number } | null = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    const m = FENCE_RE.exec(line);
    if (open) {
      if (m && m[2]![0] === open.ch && m[2]!.length >= open.len && m[3]!.trim() === "") {
        kinds[n] = "fence";
        open = null;
      } else {
        kinds[n] = "pre";
      }
      continue;
    }
    // A backtick fence's info string may not contain a backtick.
    if (m && !(m[2]![0] === "`" && m[3]!.includes("`"))) {
      kinds[n] = "fence";
      open = { ch: m[2]![0]!, len: m[2]!.length };
    }
  }
  // Tables: a delimiter row plus the header line above it and the pipe lines below it.
  for (let n = 1; n < lines.length; n++) {
    if (kinds[n] !== "text" || kinds[n - 1] !== "text") continue;
    if (!isTableDelim(lines[n]!) || !lines[n - 1]!.includes("|")) continue;
    kinds[n - 1] = "row";
    kinds[n] = "tdelim";
    let k = n + 1;
    while (k < lines.length && kinds[k] === "text" && lines[k]!.includes("|") && lines[k]!.trim() !== "") {
      kinds[k] = "row";
      k++;
    }
    n = k - 1;
  }
  return kinds;
}

// Inline candidates: where a construct could start. Everything between candidates is plain text.
const INLINE_START = /[`*_~[<!\\]|https?:\/\//g;
// Every span is capped (200 characters, 2000 for URLs). Without a cap, a long line of unclosed
// openers ("*a *b *c ...") makes each candidate scan to the end of the line: quadratic, and a
// 20 KB single-line paste would stall typing. A real span longer than the cap is left uncoloured.
const CODE_Y = /(`+)([^`\n]|[^`\n][^\n]{0,200}?[^`\n])\1(?!`)/y;
const STRONG_Y = /(\*\*|__)(?=\S)([^\n]{0,200}?\S)\1/y;
const EM_Y = /([*_])(?=\S)([^\n]{0,200}?\S)\1/y;
const STRIKE_Y = /(~~)(?=\S)([^\n]{0,200}?\S)~~/y;
const LINK_Y = /(!?\[)([^\]\n]{0,200})(\]\()([^()\s]{0,2000}(?:[ \t]+"[^"\n]{0,200}")?)(\))/y;
const AUTOLINK_Y = /<(https?:\/\/[^\s<>]{1,2000}|mailto:[^\s<>]{1,500})>/y;
const BARE_URL_Y = /https?:\/\/[^\s<>()`]{0,2000}[^\s<>()`.,;:!?'"]/y;
const WORD_CHAR = /[A-Za-z0-9]/;

function push(out: Token[], text: string, cls?: TokenClass) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.cls === cls) last.text += text;
  else out.push(cls ? { text, cls } : { text });
}

/** Highlights one line's inline constructs, appending to `out`. `base` is the class for plain text
 * (e.g. "h" inside a heading, "q" inside a quote). */
export function tokenizeInline(line: string, out: Token[], base?: TokenClass): void {
  let plainFrom = 0;
  INLINE_START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_START.exec(line))) {
    const at = m.index;
    const ch = line[at]!;
    let matched: Token[] | null = null;
    let end = at;
    const tryAt = (re: RegExp): RegExpExecArray | null => {
      re.lastIndex = at;
      return re.exec(line);
    };
    if (ch === "\\") {
      // A backslash escape: skip the escaped character so `\*` never opens emphasis.
      INLINE_START.lastIndex = at + 2;
      continue;
    } else if (ch === "`") {
      const c = tryAt(CODE_Y);
      if (c) {
        matched = [
          { text: c[1]!, cls: "mk" },
          { text: c[2]!, cls: "code" },
          { text: c[1]!, cls: "mk" },
        ];
        end = at + c[0].length;
      } else {
        // An unmatched run of backticks: skip the whole run, not one tick at a time.
        let k = at;
        while (line[k] === "`") k++;
        INLINE_START.lastIndex = k;
        continue;
      }
    } else if (ch === "*" || ch === "_") {
      const prev = at > 0 ? line[at - 1]! : "";
      // Intraword underscores (snake_case) are never emphasis in GFM.
      if (ch === "_" && prev && WORD_CHAR.test(prev)) continue;
      const s = tryAt(STRONG_Y);
      if (s && !(ch === "_" && WORD_CHAR.test(line[at + s[0].length] ?? ""))) {
        matched = [{ text: s[1]!, cls: "mk" }, { text: s[2]!, cls: "b" }, { text: s[1]!, cls: "mk" }];
        end = at + s[0].length;
      } else if (line[at + 1] !== ch) {
        const e = tryAt(EM_Y);
        if (e && !(ch === "_" && WORD_CHAR.test(line[at + e[0].length] ?? ""))) {
          matched = [{ text: e[1]!, cls: "mk" }, { text: e[2]!, cls: "i" }, { text: e[1]!, cls: "mk" }];
          end = at + e[0].length;
        }
      } else {
        // "**" that didn't close: step over both so the second isn't retried as italic.
        INLINE_START.lastIndex = at + 2;
        continue;
      }
    } else if (ch === "~") {
      const s = tryAt(STRIKE_Y);
      if (s) {
        matched = [{ text: "~~", cls: "mk" }, { text: s[2]!, cls: "s" }, { text: "~~", cls: "mk" }];
        end = at + s[0].length;
      }
    } else if (ch === "[" || ch === "!") {
      const l = tryAt(LINK_Y);
      if (l) {
        matched = [
          { text: l[1]!, cls: "mk" },
          { text: l[2]!, cls: "link" },
          { text: l[3]!, cls: "mk" },
          { text: l[4]!, cls: "url" },
          { text: l[5]!, cls: "mk" },
        ];
        end = at + l[0].length;
      }
    } else if (ch === "<") {
      const a = tryAt(AUTOLINK_Y);
      if (a) {
        matched = [{ text: "<", cls: "mk" }, { text: a[1]!, cls: "url" }, { text: ">", cls: "mk" }];
        end = at + a[0].length;
      }
    } else if (ch === "h") {
      const prev = at > 0 ? line[at - 1]! : "";
      if (!WORD_CHAR.test(prev)) {
        const u = tryAt(BARE_URL_Y);
        if (u) {
          matched = [{ text: u[0], cls: "url" }];
          end = at + u[0].length;
        }
      }
    }
    if (!matched) continue;
    push(out, line.slice(plainFrom, at), base);
    for (const t of matched) push(out, t.text, t.cls);
    plainFrom = end;
    INLINE_START.lastIndex = end;
  }
  push(out, line.slice(plainFrom), base);
}

function tokenizeTableRow(line: string, out: Token[]) {
  // Split on unescaped pipes, and pipes outside inline code.
  let from = 0;
  let inCode = false;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === "\\") {
      k++;
      continue;
    }
    if (c === "`") inCode = !inCode;
    else if (c === "|" && !inCode) {
      tokenizeInline(line.slice(from, k), out);
      push(out, "|", "pipe");
      from = k + 1;
    }
  }
  tokenizeInline(line.slice(from), out);
}

function tokenizeLine(line: string, kind: LineKind): Token[] {
  const out: Token[] = [];
  if (!line) return out;
  if (kind === "pre") {
    push(out, line, "pre");
    return out;
  }
  if (kind === "fence") {
    const m = FENCE_RE.exec(line)!;
    push(out, m[1]! + m[2]!, "fence");
    const info = m[3]!;
    const lead = /^[ \t]*/.exec(info)![0];
    const lang = /^[^\s{]+/.exec(info.slice(lead.length))?.[0] ?? "";
    push(out, lead, "fence");
    push(out, lang, "lang");
    push(out, info.slice(lead.length + lang.length), "fence");
    return out;
  }
  if (kind === "tdelim") {
    for (const part of line.split(/(\|)/)) push(out, part, part === "|" ? "pipe" : "tdelim");
    return out;
  }
  if (kind === "row") {
    tokenizeTableRow(line, out);
    return out;
  }
  const h = HEADING_RE.exec(line);
  if (h) {
    push(out, h[0], "mk");
    tokenizeInline(line.slice(h[0].length), out, "h");
    return out;
  }
  if (HR_RE.test(line)) {
    push(out, line, "hr");
    return out;
  }
  let rest = line;
  let base: TokenClass | undefined;
  // Quotes may nest and may contain a list: "> - item".
  let q: RegExpExecArray | null;
  while ((q = QUOTE_RE.exec(rest))) {
    push(out, q[1]!, "mk");
    rest = rest.slice(q[1]!.length);
    base = "q";
  }
  const li = LIST_RE.exec(rest);
  if (li) {
    push(out, li[1]!, base);
    push(out, li[2]! + li[3]!, "li");
    rest = rest.slice(li[0].length);
    const task = TASK_RE.exec(rest);
    if (task) {
      push(out, task[0], "li");
      rest = rest.slice(task[0].length);
    }
  }
  tokenizeInline(rest, out, base);
  return out;
}

/** Tokens per line (the "\n"s between lines are not included). */
export function tokenizeLines(src: string): Token[][] {
  const lines = splitLines(src);
  const kinds = classifyLines(lines);
  return lines.map((line, n) => tokenizeLine(line, kinds[n]!));
}

/** Tokenizes a whole draft. `tokens.map(t => t.text).join("") === src` always holds. */
export function tokenizeMarkdown(src: string): Token[] {
  const out: Token[] = [];
  tokenizeLines(src).forEach((line, n) => {
    if (n > 0) push(out, "\n");
    for (const t of line) push(out, t.text, t.cls);
  });
  return out;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESC[c]!);
}

/** The overlay's markup, one string per source line, each ending in its "\n" except the last. The
 * editor wraps each in a <span> and, on an edit, replaces only the lines that changed, so a
 * keystroke in a 20 KB draft touches one line of DOM instead of re-parsing thousands of spans.
 *
 * Every character of the draft is escaped, so the draft can never inject markup; the only tags
 * are the <span class="mdh-*"> written here. An empty last line (the draft ends in "\n", or is
 * empty) gets a space so the <pre>'s last line has height, as the textarea's does. */
export function highlightLines(src: string): string[] {
  const lines = tokenizeLines(src);
  const last = lines.length - 1;
  return lines.map((tokens, n) => {
    let html = "";
    for (const t of tokens) html += t.cls ? `<span class="mdh-${t.cls}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text);
    return n < last ? html + "\n" : html || " ";
  });
}
