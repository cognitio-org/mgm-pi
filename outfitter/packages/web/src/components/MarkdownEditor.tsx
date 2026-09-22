import { useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Markdown } from "./Markdown.tsx";
import { highlightLines } from "../lib/md-highlight.ts";
import { continueList, formatEdit, inCodeBlock, indentEdit, shortcutAction, type FormatAction, type TextEdit } from "../lib/md-edit.ts";
import { choosePaste } from "../lib/paste-choice.ts";
import { composerKeyAction, type EnterMode } from "../lib/composer-keys.ts";

// The composer's Markdown-aware input (docs/reports/markdown-composer.md).
//
// A native <textarea> with transparent text sits over an aria-hidden <pre> that shows the same
// text, highlighted. The textarea keeps everything native: caret, selection, undo, IME,
// spellcheck, autocorrect, the phone keyboard. The <pre> only has to lay the text out identically,
// which it does by sharing the textarea's font, padding, border, wrapping and scroll position
// (styles/markdown-editor.css). Every edit this component makes goes through
// execCommand("insertText"), so Cmd/Ctrl+Z undoes it like typing.

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  enterMode: EnterMode;
  placeholder: string;
  disabled?: boolean;
  /** Phones: the toolbar shows only after the composer's "Aa" button opens it. */
  toolsOpen: boolean;
  toolbarId: string;
}

const TOOLS: Array<{ action: FormatAction; label: string; keys: string; aria: string; glyph: string }> = [
  { action: "bold", label: "Bold", keys: "Mod+B", aria: "Meta+B Control+B", glyph: "B" },
  { action: "italic", label: "Italic", keys: "Mod+I", aria: "Meta+I Control+I", glyph: "I" },
  { action: "code", label: "Inline code", keys: "Mod+E", aria: "Meta+E Control+E", glyph: "`c`" },
  { action: "codeBlock", label: "Code block", keys: "Mod+Shift+K", aria: "Meta+Shift+K Control+Shift+K", glyph: "```" },
  { action: "link", label: "Link", keys: "Mod+K", aria: "Meta+K Control+K", glyph: "Link" },
  { action: "list", label: "Bulleted list", keys: "", aria: "", glyph: "• List" },
];

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const modName = (keys: string) => keys.replace("Mod", MAC ? "⌘" : "Ctrl");

// Chrome's insertText is quadratic in the number of lines inserted: 100 lines take ~10 ms, 400
// take ~100 ms, a 700-line (20 KB) paste takes ~3 s. Above this many lines the edit is applied
// directly instead, which is instant but is not on the undo stack.
const UNDOABLE_MAX_LINES = 150;

/** Replaces [from, to) through the browser's editing pipeline so it lands on the undo stack. Uses
 * setRangeText plus a synthetic input event for very large inserts, and where execCommand is
 * unavailable (jsdom). */
function applyEdit(ta: HTMLTextAreaElement, e: TextEdit): void {
  ta.focus();
  ta.setSelectionRange(e.from, e.to);
  let done = false;
  let lines = 0;
  for (let k = e.insert.indexOf("\n"); k !== -1 && lines <= UNDOABLE_MAX_LINES; k = e.insert.indexOf("\n", k + 1)) lines++;
  try {
    done = lines <= UNDOABLE_MAX_LINES && document.execCommand("insertText", false, e.insert);
  } catch {
    done = false;
  }
  if (!done) {
    ta.setRangeText(e.insert, e.from, e.to, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  ta.setSelectionRange(e.selStart, e.selEnd);
}

/** Brings the mirror from `prev` to `next` lines, replacing only the run between their common
 * prefix and suffix: typing touches one line of DOM, however long the draft. */
function patchMirror(pre: HTMLPreElement, prev: string[], next: string[]): void {
  const span = (html: string) => `<span>${html}</span>`;
  if (pre.children.length !== prev.length) {
    pre.innerHTML = next.map(span).join("");
    return;
  }
  let p = 0;
  while (p < prev.length && p < next.length && prev[p] === next[p]) p++;
  let s = 0;
  while (s < prev.length - p && s < next.length - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  for (let k = prev.length - s - 1; k >= p; k--) pre.children[k]!.remove();
  const html = next.slice(p, next.length - s).map(span).join("");
  if (!html) return;
  const before = pre.children[p];
  if (before) before.insertAdjacentHTML("beforebegin", html);
  else pre.insertAdjacentHTML("beforeend", html);
}

export function MarkdownEditor({ value, onChange, onSend, enterMode, placeholder, disabled, toolsOpen, toolbarId }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLPreElement>(null);
  const [preview, setPreview] = useState(false);
  // Set by Cmd/Ctrl+Shift+V's keydown, read by the paste event that follows it.
  const plainPaste = useRef(false);
  // The mirror's current lines (highlightLines output), one <span> child each.
  const shown = useRef<string[]>([]);
  const shownLength = useRef(0);
  // If a highlight pass ever takes longer than a frame's worth, later passes move to rAF so typing
  // itself never waits on them.
  const slow = useRef(false);
  const raf = useRef(0);

  // Mirror, scroll and height, after every value change and before paint.
  useLayoutEffect(() => {
    const ta = taRef.current;
    const pre = mirrorRef.current;
    if (!ta || !pre) return;
    const render = () => {
      const t0 = performance.now();
      patchMirror(pre, shown.current, (shown.current = highlightLines(ta.value)));
      slow.current = performance.now() - t0 > 12;
      // Auto-grow up to the CSS max-height, then scroll. Once the box is at its max and the draft
      // isn't shrinking, skip the height:auto round trip (a forced reflow of the whole draft).
      const cs = getComputedStyle(ta);
      const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const max = parseFloat(cs.maxHeight) || Infinity;
      const full = ta.offsetHeight >= max && ta.value.length >= shownLength.current;
      shownLength.current = ta.value.length;
      if (!full) {
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight + borders, max)}px`;
      }
      // A visible scrollbar narrows the textarea's text box; narrow the mirror's to match.
      const scrollbar = ta.offsetWidth - ta.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      pre.style.paddingRight = scrollbar > 0 ? `calc(${cs.paddingRight} + ${scrollbar}px)` : "";
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    };
    cancelAnimationFrame(raf.current);
    if (slow.current) raf.current = requestAnimationFrame(render);
    else render();
  }, [value, preview]);

  useLayoutEffect(() => () => cancelAnimationFrame(raf.current), []);

  function syncScroll() {
    const ta = taRef.current;
    const pre = mirrorRef.current;
    if (ta && pre) {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    }
  }

  function format(action: FormatAction) {
    const ta = taRef.current;
    if (!ta || disabled) return;
    applyEdit(ta, formatEdit(action, ta.value, { start: ta.selectionStart, end: ta.selectionEnd }));
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const ta = e.currentTarget;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "v") {
      plainPaste.current = true;
      return;
    }
    const shortcut = shortcutAction(e);
    if (shortcut) {
      e.preventDefault();
      format(shortcut);
      return;
    }
    const sel = { start: ta.selectionStart, end: ta.selectionEnd };
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Only inside a fenced code block; elsewhere Tab moves focus as usual.
      if (inCodeBlock(ta.value, sel.start)) {
        e.preventDefault();
        applyEdit(ta, indentEdit(ta.value, sel, e.shiftKey));
      }
      return;
    }
    const action = composerKeyAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        isComposing: e.nativeEvent.isComposing,
        keyCode: e.keyCode,
      },
      enterMode,
    );
    if (action === "send") {
      e.preventDefault();
      onSend();
    } else if (action === "newline") {
      const edit = continueList(ta.value, sel);
      if (edit) {
        e.preventDefault();
        applyEdit(ta, edit);
      }
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const ta = e.currentTarget;
    const cd = e.clipboardData;
    const forcePlain = plainPaste.current;
    plainPaste.current = false;
    if (!cd) return;
    const types = Array.from(cd.types ?? []);
    const plain = cd.getData("text/plain");
    const html = types.includes("text/html") ? cd.getData("text/html") : "";
    const choice = choosePaste(plain, html, types.includes("Files"), forcePlain);
    if (choice.kind === "native") return;
    e.preventDefault();
    if (choice.kind === "ignore") return;
    const before = ta.value;
    const from = ta.selectionStart;
    const to = ta.selectionEnd;
    const insert = (text: string) => {
      // If the draft changed while the converter loaded, paste at the caret as it is now.
      const [a, b] = ta.value === before ? [from, to] : [ta.selectionStart, ta.selectionEnd];
      applyEdit(ta, { from: a, to: b, insert: text, selStart: a + text.length, selEnd: a + text.length });
    };
    if (choice.kind === "insert") {
      insert(choice.text);
      return;
    }
    // Loaded on the first HTML paste only (a separate chunk; see the report for sizes).
    import("../lib/html-to-markdown.ts")
      .then((m) => {
        let md = "";
        try {
          md = m.htmlToMarkdown(choice.html);
        } catch {
          md = "";
        }
        insert(md || choice.fallback);
      })
      .catch(() => insert(choice.fallback));
  }

  function togglePreview() {
    const next = !preview;
    setPreview(next);
    // Back to the textarea when leaving preview, so keyboard users land where they were typing.
    if (!next) requestAnimationFrame(() => taRef.current?.focus());
  }

  return (
    <div className="md-editor-wrap">
      <div
        id={toolbarId}
        className={`md-toolbar${toolsOpen ? " open" : ""}`}
        role="group"
        aria-label="Formatting"
      >
        {TOOLS.map((t) => (
          <button
            key={t.action}
            type="button"
            className={`md-tool md-tool-${t.action}`}
            aria-label={t.keys ? `${t.label} (${modName(t.keys)})` : t.label}
            aria-keyshortcuts={t.aria || undefined}
            title={t.keys ? `${t.label} (${modName(t.keys)})` : t.label}
            disabled={disabled || preview}
            // Keep focus (and the selection) in the textarea, and the phone keyboard up.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format(t.action)}
          >
            <span aria-hidden="true">{t.glyph}</span>
          </button>
        ))}
        <button
          type="button"
          className="md-tool md-tool-preview"
          aria-pressed={preview}
          onClick={togglePreview}
        >
          Preview
        </button>
      </div>
      <div className={`md-editor${disabled ? " is-disabled" : ""}`} hidden={preview}>
        <pre ref={mirrorRef} className="md-editor-mirror" aria-hidden="true" />
        <textarea
          ref={taRef}
          className="md-editor-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          onKeyUp={() => (plainPaste.current = false)}
          onPaste={onPaste}
          placeholder={placeholder}
          aria-label="Message"
          disabled={disabled}
          spellCheck
        />
      </div>
      {preview && (
        <div className="md-preview" role="region" aria-label="Message preview" tabIndex={0}>
          {value.trim() ? <Markdown text={value} /> : <p className="md-preview-empty">Nothing to preview.</p>}
        </div>
      )}
    </div>
  );
}
