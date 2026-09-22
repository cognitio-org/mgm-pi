// Composer formatting edits (toolbar buttons and shortcuts), as pure functions over
// (value, selection). Each returns one replacement plus the selection to restore afterwards, so the
// component can apply it with a single execCommand("insertText") and keep the browser's native
// undo stack (docs/reports/markdown-composer.md).

import { classifyLines } from "./md-highlight.ts";

export interface Selection {
  start: number;
  end: number;
}

/** Replace value[from, to) with `insert`, then select [selStart, selEnd) in the new value. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
}

export type FormatAction = "bold" | "italic" | "code" | "codeBlock" | "link" | "list";

const INDENT = "  ";

function lineStart(value: string, pos: number): number {
  return value.lastIndexOf("\n", pos - 1) + 1;
}

function lineEnd(value: string, pos: number): number {
  const n = value.indexOf("\n", pos);
  return n === -1 ? value.length : n;
}

/** Toggles a symmetric inline marker (** * `) around the selection. */
export function toggleWrap(value: string, sel: Selection, marker: string): TextEdit {
  const { start, end } = sel;
  const m = marker.length;
  const text = value.slice(start, end);
  // Already wrapped, markers inside the selection: "**bold**" selected.
  if (text.length >= 2 * m && text.startsWith(marker) && text.endsWith(marker)) {
    const inner = text.slice(m, text.length - m);
    return { from: start, to: end, insert: inner, selStart: start, selEnd: start + inner.length };
  }
  // Already wrapped, markers just outside the selection. A single "*" next to another "*" is part
  // of a bold marker, not an italic one.
  const before = value.slice(start - m, start);
  const after = value.slice(end, end + m);
  const sameCharBeyond = m === 1 && (value[start - m - 1] === marker || value[end + m] === marker);
  if (start >= m && before === marker && after === marker && !sameCharBeyond) {
    return { from: start - m, to: end + m, insert: text, selStart: start - m, selEnd: end - m };
  }
  // Wrap. Leading/trailing spaces stay outside the markers ("**word** ", not "**word **", which
  // would not render as bold).
  const lead = /^\s*/.exec(text)![0];
  const trail = text.length > lead.length ? /\s*$/.exec(text)![0] : "";
  const core = text.slice(lead.length, text.length - trail.length);
  const insert = lead + marker + core + marker + trail;
  const s = start + lead.length + m;
  return { from: start, to: end, insert, selStart: s, selEnd: s + core.length };
}

/** Inline code; a selection that already contains a backtick gets a double-backtick span. */
export function inlineCode(value: string, sel: Selection): TextEdit {
  const text = value.slice(sel.start, sel.end);
  if (!text.includes("`")) return toggleWrap(value, sel, "`");
  const insert = "`` " + text + " ``";
  return { from: sel.start, to: sel.end, insert, selStart: sel.start + 3, selEnd: sel.start + 3 + text.length };
}

/** Wraps the selected lines in a ``` fence, or inserts an empty fence with the caret inside. */
export function codeBlock(value: string, sel: Selection): TextEdit {
  if (sel.start === sel.end) {
    const pos = sel.start;
    const pre = pos > 0 && value[pos - 1] !== "\n" ? "\n" : "";
    const post = pos < value.length && value[pos] !== "\n" ? "\n" : "";
    const insert = pre + "```\n\n```" + post;
    const caret = pos + pre.length + 4;
    return { from: pos, to: pos, insert, selStart: caret, selEnd: caret };
  }
  const from = lineStart(value, sel.start);
  // A selection ending just after a newline doesn't include the next line.
  const endPos = sel.end > sel.start && value[sel.end - 1] === "\n" ? sel.end - 1 : sel.end;
  const to = lineEnd(value, endPos);
  const body = value.slice(from, to);
  const insert = "```\n" + body + "\n```";
  // Caret right after the opening fence, ready for a language label.
  return { from, to, insert, selStart: from + 3, selEnd: from + 3 };
}

/** [text](url). A selected URL becomes the target; otherwise the selection becomes the text.
 * The placeholder left to fill in is selected. */
export function link(value: string, sel: Selection): TextEdit {
  const text = value.slice(sel.start, sel.end).trim();
  if (/^(https?:\/\/|mailto:)\S+$/.test(text)) {
    const insert = `[text](${text})`;
    return { from: sel.start, to: sel.end, insert, selStart: sel.start + 1, selEnd: sel.start + 5 };
  }
  const label = text || "text";
  const insert = `[${label}](url)`;
  if (!text) return { from: sel.start, to: sel.end, insert, selStart: sel.start + 1, selEnd: sel.start + 5 };
  const u = sel.start + label.length + 3;
  return { from: sel.start, to: sel.end, insert, selStart: u, selEnd: u + 3 };
}

const BULLET_RE = /^(\s*)[-*+][ \t]+/;

/** Toggles "- " on every non-blank line the selection touches. */
export function toggleList(value: string, sel: Selection): TextEdit {
  const from = lineStart(value, sel.start);
  const endPos = sel.end > sel.start && value[sel.end - 1] === "\n" ? sel.end - 1 : sel.end;
  const to = lineEnd(value, endPos);
  const lines = value.slice(from, to).split("\n");
  const filled = lines.filter((l) => l.trim() !== "");
  const allBulleted = filled.length > 0 && filled.every((l) => BULLET_RE.test(l));
  const out = lines.map((l) => {
    if (l.trim() === "" && lines.length > 1) return l;
    if (allBulleted) return l.replace(BULLET_RE, "$1");
    const indent = /^\s*/.exec(l)![0];
    return indent + "- " + l.slice(indent.length);
  });
  const insert = out.join("\n");
  if (sel.start === sel.end) {
    const caret = Math.max(from, sel.start + insert.length - (to - from));
    return { from, to, insert, selStart: caret, selEnd: caret };
  }
  return { from, to, insert, selStart: from, selEnd: from + insert.length };
}

export function formatEdit(action: FormatAction, value: string, sel: Selection): TextEdit {
  switch (action) {
    case "bold":
      return toggleWrap(value, sel, "**");
    case "italic":
      return toggleWrap(value, sel, "*");
    case "code":
      return inlineCode(value, sel);
    case "codeBlock":
      return codeBlock(value, sel);
    case "link":
      return link(value, sel);
    case "list":
      return toggleList(value, sel);
  }
}

/** Which modifier makes a shortcut: Cmd on Apple platforms, Ctrl elsewhere. On a Mac, Ctrl+B/E/K
 * are the system's Emacs-style text keys (back one character, end of line, delete to end of line)
 * and must keep working, so there only Cmd counts. "either" is for tests and unknown platforms. */
export type ShortcutModifier = "meta" | "ctrl" | "either";

/** Cmd/Ctrl shortcuts: B bold, I italic, E inline code, K link, Shift+K code block. */
export function shortcutAction(
  e: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean },
  mod: ShortcutModifier = "either",
): FormatAction | null {
  const down = mod === "meta" ? e.metaKey && !e.ctrlKey : mod === "ctrl" ? e.ctrlKey && !e.metaKey : e.metaKey || e.ctrlKey;
  if (!down || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (e.shiftKey) return k === "k" ? "codeBlock" : null;
  return k === "b" ? "bold" : k === "i" ? "italic" : k === "e" ? "code" : k === "k" ? "link" : null;
}

/** True when `pos` is inside a fenced code block's body (not on a fence line itself). */
export function inCodeBlock(value: string, pos: number): boolean {
  const lines = value.slice(0, lineEnd(value, pos)).split("\n");
  return classifyLines(lines)[lines.length - 1] === "pre";
}

/** Tab / Shift+Tab inside a code block: indent or outdent every line the selection touches. A
 * collapsed caret on Tab inserts the indent at the caret instead. */
export function indentEdit(value: string, sel: Selection, outdent: boolean): TextEdit {
  if (!outdent && sel.start === sel.end) {
    const c = sel.start + INDENT.length;
    return { from: sel.start, to: sel.end, insert: INDENT, selStart: c, selEnd: c };
  }
  const from = lineStart(value, sel.start);
  const endPos = sel.end > sel.start && value[sel.end - 1] === "\n" ? sel.end - 1 : sel.end;
  const to = lineEnd(value, endPos);
  const lines = value.slice(from, to).split("\n");
  let firstDelta = 0;
  const out = lines.map((l, k) => {
    let next: string;
    if (outdent) next = l.startsWith("\t") ? l.slice(1) : l.replace(/^ {1,2}/, "");
    else next = INDENT + l;
    if (k === 0) firstDelta = next.length - l.length;
    return next;
  });
  const insert = out.join("\n");
  if (sel.start === sel.end) {
    const caret = Math.max(from, sel.start + firstDelta);
    return { from, to, insert, selStart: caret, selEnd: caret };
  }
  return {
    from,
    to,
    insert,
    // A selection starting at column 0 keeps covering the whole first line.
    selStart: sel.start === from ? from : Math.max(from, sel.start + firstDelta),
    selEnd: sel.end + insert.length - (to - from),
  };
}

const LIST_ITEM_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;

/** Enter inside a list item: continue the list ("- " -> "- ", "3. " -> "4. ", "- [x] " -> "- [ ] ").
 * Enter on an empty item ends the list by clearing its marker. Returns null when Enter should just
 * insert a plain newline (not in a list, inside a code block, a non-collapsed selection, or the
 * caret still inside the marker). */
export function continueList(value: string, sel: Selection): TextEdit | null {
  if (sel.start !== sel.end) return null;
  const pos = sel.start;
  const ls = lineStart(value, pos);
  const le = lineEnd(value, pos);
  const line = value.slice(ls, le);
  const m = LIST_ITEM_RE.exec(line);
  if (!m || pos - ls < m[0].length) return null;
  if (inCodeBlock(value, pos)) return null;
  if (line.slice(m[0].length).trim() === "" && pos === le) {
    // Empty item: end the list, keeping any quote prefix.
    const keep = m[1]!;
    return { from: ls, to: le, insert: keep, selStart: ls + keep.length, selEnd: ls + keep.length };
  }
  const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2]!;
  const insert = "\n" + m[1]! + marker + m[5]! + (m[6] ? "[ ] " : "");
  const caret = pos + insert.length;
  return { from: pos, to: pos, insert, selStart: caret, selEnd: caret };
}
