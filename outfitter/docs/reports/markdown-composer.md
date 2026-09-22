# Markdown-aware composer

The owner asked three things about the Floppy (session) page's input box:

- "is it possible that the input box can properly display/handle markdown?"
- "Live highlighting while typing, do that as a separate PR"
- "The support for tables is mostly for the ability to paste in html or markdown content and have it display correctly."

This change adds live highlighting while typing, a formatting toolbar with shortcuts, Preview,
and paste conversion from HTML and spreadsheets to GFM. Tables get the most attention. Everything
lives in `packages/web`. The Enter-mode switch (`composerKeyAction`, cloud-fixes §12) and the
status slot (cloud-fixes §11) work as before.

## What

| Area | Behaviour |
| --- | --- |
| Highlighting | Headings, bold, italic, strikethrough, inline code, fenced code with a language label, links, autolinks and bare URLs, lists and task items, blockquotes, pipe tables (pipes, delimiter row, cell content) and horizontal rules. It uses theme colours, and every pair passes AA in both themes (below). |
| Toolbar | Bold, Italic, Inline code, Code block, Link, Bulleted list, and a Preview toggle. On phones (≤ 700 px) it is folded behind one **Aa** button in the composer's top row. |
| Shortcuts | Cmd/Ctrl+B, Cmd/Ctrl+I, Cmd/Ctrl+E (inline code), Cmd/Ctrl+K (link), Cmd/Ctrl+Shift+K (code block). |
| Tab | Inside a fenced code block, Tab indents (2 spaces, or every selected line) and Shift+Tab outdents. Everywhere else Tab moves focus as normal. |
| Enter in a list | Continues the list: `- ` → `- `, `9. ` → `10. `, `- [x] ` → `- [ ] `, and `> - ` keeps the quote. Enter on an empty item ends the list. This only happens when the Enter-mode switch makes the key a newline: Shift+Enter in "Enter sends" mode, or Enter in "Enter = new line" mode. |
| Preview | Renders the draft with the transcript's own `Markdown` component (react-markdown + remark-gfm, Mermaid included). The button has `aria-pressed`. The textarea stays mounted but hidden, so the draft and its undo history survive the round trip. |
| Paste | HTML from web pages, Google Docs, Word, Confluence or GitHub becomes Markdown. Tab-separated spreadsheet cells become a GFM table. Markdown pasted as plain text is kept exactly as pasted. Cmd/Ctrl+Shift+V always pastes plain text. Images and files are ignored. |

## How

### Overlay editor (`components/MarkdownEditor.tsx`, `styles/markdown-editor.css`)

A native `<textarea>` with transparent text (`color` and `-webkit-text-fill-color`, with the caret
colour set explicitly) sits over an `aria-hidden` `<pre>` that shows the same text, highlighted. The
browser still owns the caret, selection, undo, IME, spellcheck, autocorrect and the phone keyboard.
There is no editor library.

The layers stay aligned because one CSS rule sets every property that moves a glyph on both
elements: font, size, line-height, letter and word spacing, kerning, ligatures, tab size, padding,
border width and wrapping. The `<pre>` copies the textarea's `scrollTop`/`scrollLeft` on every
scroll and render. When a classic scrollbar narrows the textarea's text box, the `<pre>` gets the
same extra right padding. Mirror spans only change colour, underline, italic and weight 500. IBM
Plex Mono ships a real 500 face with the same advance widths, so no glyph moves.

On phones both layers switch to 16 px together, so the iOS zoom-on-focus rule still holds. A
real-browser check confirmed a computed `font-size` of 16 px on both at 390 px in Chrome and WebKit.
The textarea grows with its content up to `min(22rem, 45vh)`, or `38svh` on phones, and then scrolls.

**Alignment check.** The textarea's own glyphs were painted red over the mirror. Aligned layers show
one crisp glyph. Drift would show as doubled text. The only visible difference is the italic slant,
which is a slant in place and not a shift. Chrome and WebKit agree:
`docs/design/screenshots/markdown-composer-align-{chrome-390,webkit-390,webkit-1280}.png`. In both
engines `scrollHeight` and `clientWidth` are identical for the textarea and the mirror at 390 and
1280 px.

**Rendering cost.** Each source line is one `display: block` span in the mirror. On an edit the
editor diffs the new per-line HTML against what it last rendered and replaces only the changed run
(`patchMirror`). So a keystroke rebuilds one line of DOM, and only that line is laid out again. If a
render ever takes more than 12 ms, later renders move to `requestAnimationFrame` so typing never
waits on them.

### Tokenizer (`lib/md-highlight.ts`)

This is a pure, line-based highlighter, not a parser:

- `classifyLines` marks fence lines, fence bodies and table rows.
- `tokenizeLine` handles block markers, then runs inline sticky regexes at candidate characters
  only.
- `highlightLines` returns escaped HTML per line. The only tags it can produce are its own
  `<span class="mdh-*">`.

Two invariants are tested:

- The token text always joins back to the exact input, so the caret can't drift.
- The draft can never inject markup.

There is no regex lookbehind, because Safari before 16.4 rejects it at parse time and that would
break the Session chunk. Inline spans are capped at 200 characters (2000 for URLs), so a
pathological single-line paste stays linear.

| Measurement | Result |
| --- | --- |
| Tokenize + HTML, 20 KB mixed Markdown (vitest, Node) | **1.4 ms** median |
| Keystroke with 20 KB in the draft, to the next frame, Chrome | **3.7 ms** median, 5.2 ms max |
| Keystroke with 20 KB in the draft, to the next frame, WebKit | **7 ms** median, 8 ms max |
| First render of a 20 KB insert, to the next frame | 41 ms Chrome, 69 ms WebKit (one-off) |
| Pathological 20 KB line of unclosed `*a ` | ~40–115 ms depending on load, linear (asserted < 250 ms) |

### Edits and undo (`lib/md-edit.ts`)

Every edit is a pure function of (value, selection) that returns one replacement plus the selection
to restore. The component applies it with `document.execCommand("insertText")`, so Cmd/Ctrl+Z undoes
toolbar actions, list continuation, indentation and converted pastes like typing. Playwright
confirmed this in Chrome and WebKit: Bold followed by undo, and a Google Docs paste followed by undo
and redo.

One exception is measured and deliberate. Chrome's `insertText` gets slower with the square of the
number of inserted lines: 100 lines take 10 ms, 400 take 100 ms, and a 700-line (20 KB) insert takes
about 3 s. Inserts over 150 lines therefore use `setRangeText` plus an `input` event instead. That is
instant but not undoable. The same path is used where `execCommand` doesn't exist (jsdom).

### Paste (`lib/paste-choice.ts`, `lib/html-to-markdown.ts`)

`choosePaste` decides synchronously inside the paste event:

1. Cmd/Ctrl+Shift+V was pressed: paste natively as plain text.
2. The clipboard `text/plain` is **rectangular TSV** and there is no HTML, or the HTML is a
   `<table>`: build a GFM table synchronously. Rectangular TSV means at least 2 rows and 2 columns,
   the same tab count on every row, and not every row starting with a tab, which rules out
   tab-indented code. Numeric columns are right-aligned. Excel's often-huge HTML is never parsed.
3. The HTML contains structure (`h1–6 b strong em i a ul ol li table pre code blockquote hr del s`):
   `preventDefault`, lazy-load the converter, convert, and insert. If conversion returns nothing,
   the plain text is inserted instead. If the draft changed while the chunk was loading, the result
   goes in at the current caret.
4. Otherwise paste natively. This covers Markdown copied as text and colour-only HTML from VS Code
   or a terminal, so it stays exactly as copied and keeps native undo.
5. Only files or images on the clipboard: ignore them, since there is no upload feature.

The converter parses with `DOMParser` into an inert document: scripts don't run and images don't
load. It walks the DOM and emits text only, so it never inserts HTML. It handles:

- **Junk removal**: `script`, `style`, `head`, comments (including Word's `<!--[if …]-->`), `o:p`,
  `svg`, `img`, form controls, `display:none`, `mso-list:Ignore` bullets, and Wikipedia citation
  `<sup>` and edit links.
- **Google Docs**: the `<b style="font-weight:normal" id="docs-internal-guid-…">` wrapper is treated
  as a plain container, and `span` weight and style become bold and italic. A monospace-font span
  becomes inline code. A nested `<ul>` that sits directly inside `<ul>` attaches to the item before
  it.
- **Word**: `mso-list:lN levelM` paragraphs are rebuilt into nested bulleted or numbered lists and
  split by list id. `&nbsp;`-only paragraphs are dropped.
- **Code**: the language comes from `language-*`/`lang-*`, GitHub's `highlight-source-*`, a
  `data-lang` attribute, or Confluence's `brush: x`. The fence gets longer when the code itself
  contains a fence.
- **Tables → GFM**:
  - Cells are laid out on a grid, so `rowspan`/`colspan` land in the right columns.
  - The header is the `<thead>` rows, else leading all-`<th>` rows, else the first row (Docs and
    Word have no `<th>`).
  - Several header rows merge into one ("Height" over "m"/"ft" becomes "Height m", "Height ft").
  - Redundant `**` in header cells is stripped.
  - Alignment comes from what all body cells agree on (`align` or `text-align`), else the header's
    `align` attribute. A `<th>`'s inline `text-align` is ignored, because Chrome serialises the
    browser's default centring into clipboard HTML.
  - Pipes are escaped. Line breaks and paragraphs inside a cell become spaces.
  - Columns that are empty everywhere are dropped.
  - Columns are padded so the source reads as a table, unless that would pass 120 characters.
- **Other elements**: links are kept only for `http(s):` and `mailto:` (the text is kept either
  way). Task-list checkboxes, `<del>`/`<s>` and `<br>` (a hard break in text, a space in cells) are
  handled. Markdown characters in plain web text are escaped, but `snake_case` is left alone.

## Library choice and sizes

**Converter: custom, not turndown + turndown-plugin-gfm.** Bundled with esbuild, turndown 7.2.4 plus
the GFM plugin is 12.8 kB minified / 4.7 kB gzip. The custom chunk is **8.8 kB / 3.8 kB**. Size is
not the deciding factor, though. turndown-plugin-gfm was last released in 2018, and it `keep`s any
table whose first row isn't all `<th>` as **raw HTML**. Google Docs and Word tables never have
`<th>`, tables are the priority, and the draft must never contain HTML. Fixing that means rewriting
the table rules, spans and Word lists anyway, and at that point the library does little of the work.

**Highlighter and editor**: no library. The brief rules out CodeMirror, Monaco and ProseMirror. The
overlay plus a roughly 300-line tokenizer covers the brief.

Bundle sizes from `vite build`, before (main @ 750bf8b) and after:

| Chunk | Before | After | Change |
| --- | --- | --- | --- |
| `index-*.js` (main) | 316.90 kB / 98.30 kB gzip | 316.90 kB / 98.30 kB gzip | **0** |
| `SessionPage-*.js` | 190.83 kB / 58.69 kB gzip | 205.45 kB / 63.95 kB gzip | +14.6 kB / +5.3 kB gzip |
| `html-to-markdown-*.js` (lazy, first HTML paste) | — | 8.79 kB / 3.81 kB gzip | new |
| `index-*.css` (all pages) | 44.60 kB / 9.09 kB gzip | 48.73 kB / 9.86 kB gzip | +4.1 kB / +0.8 kB gzip |

The main JS bundle is byte-identical in size. The Session chunk grows by the tokenizer, the edit
functions, the paste decision and the editor component. The converter loads only on the first HTML
paste. The CSS is global, as all of this app's CSS is.

## Accessibility

- The textarea keeps `aria-label="Message"`. The mirror is `aria-hidden`.
- The toolbar is a labelled `role="group"` ("Formatting"). Each button has an `aria-label` that
  includes its shortcut, plus `aria-keyshortcuts`. Preview has `aria-pressed`. **Aa** has
  `aria-expanded` and `aria-controls`.
- Toolbar buttons `preventDefault` on `mousedown`, so a click keeps focus and selection in the
  textarea and keeps the phone keyboard up. They stay ordinary tab stops for keyboard users.
- The preview is a focusable `role="region"` ("Message preview"). Leaving preview returns focus to
  the textarea.
- Keyboard-only use works end to end:
  1. Shift+Tab from the textarea reaches the toolbar, Enter or Space runs a button, and the shortcuts
     work.
  2. Tab leaves the textarea unless the caret is in a code block.
  3. Enter-mode behaviour is unchanged.
- Colour contrast on `--bg-elevated`:
  - **C64 dark** (`#3a3184`): heading 7.1, markers 5.4, code 8.2, link 6.2, quote 6.7, list 6.2,
    table 6.6, language label 4.55 (white on accent).
  - **GEOS light** (`#fffdf8`): heading 8.3, markers 7.3, code 7.6, link 8.3, quote 9.5, list 5.7,
    table 6.3, label 8.3. On the code background the lowest pair is 4.7.

## Tests and fixtures

`npm test` in `packages/web` runs 370 tests. 56 of them are new:

| File | Tests | Covers |
| --- | --- | --- |
| `test/md-highlight.test.ts` | 16 | Exact round-trip; each construct; snake_case, escapes and code spans; unclosed fences; per-line output; escaping; 20 KB speed; linear pathological lines. |
| `test/md-edit.test.ts` | 14 | Toggles; spaces kept outside markers; code block, link and list; the shortcut map; list continuation (bullets, numbers, tasks, quotes, splitting, ending); inCodeBlock; indent/outdent. |
| `test/html-to-markdown.test.ts` | 16 | The fixtures below; escaping; unsafe links; long fences; `<br>`; task lists; colspan; `choosePaste` rules (TSV, ragged TSV, tab-indented code, native Markdown, VS Code HTML, Shift paste, files). |
| `test/markdown-editor.test.tsx` | 10 | The Composer in jsdom: label and mirror; toolbar labels, `aria-expanded` and `aria-controls`; toolbar and shortcut edits; list continuation in both Enter modes, with Send still working; Tab only in code; Preview and `aria-pressed`; async HTML paste; TSV paste; Markdown and files left alone; Cmd+Shift+V. |

Fixtures are in `packages/web/test/fixtures/paste/`:

- **Captured** from real Chrome clipboards with Playwright (select, press Cmd+C, read
  `navigator.clipboard`), with Chrome's inline computed styles intact:
  - `github-readme.html`: the turndown README, including headings with anchor icons, highlighted
    `pre` blocks and copy buttons.
  - `wikipedia-table.html` and `.txt`: a sortable wikitable with two header rows,
    rowspan/colspan, citations and images.
- **Constructed** to match what each app writes to the clipboard, because they need an account
  or a desktop app:
  - `google-docs.html`: the guid wrapper, styled spans, a nested list and a header-less table.
  - `word.html`: Word 15 `<head>` and styles, `mso-list` paragraphs, `<o:p>`, conditional
    comments, and a MsoTableGrid table.
  - `confluence.html`: a code macro with `brush:`, a note macro, `confluenceTable` with
    `text-align`, a nested `ol`, plus script, style and a comment.
  - `google-sheets.html`/`.txt` and `excel.txt`: TSV with CRLF line endings and an empty cell.

Full run: `cd outfitter && npm ci && npm test && npm run build` passes.

## Screenshots

Chrome, taken against a local server on :8132 from this worktree (in-memory Mongo, in-process
sandbox), at 390x844 and 1280x860, in dark and light. The run shows FAILED because the demo Tape
points at a model that doesn't exist; the composer is unaffected.

- `docs/design/screenshots/markdown-composer-highlight-{390,1280}-{dark,light}.png`: typed draft
  with a heading, emphasis, list, quote, a `ts` code block and a table. The toolbar is open on phones.
- `…-toolbar-…`: after selecting a word and pressing **B**.
- `…-preview-…`: Preview pressed.
- `…-paste-gdocs-…`: the Google Docs fixture pasted through the real clipboard (Cmd+V) and
  converted, scrolled to its table.
- `…-align-chrome-390.png`, `…-align-webkit-{390,1280}.png`,
  `…-webkit-highlight-390-dark.png`: alignment checks and WebKit rendering.

## Known limits

- **Highlighting is approximate.** There are no setext headings, no nested emphasis colouring (bold
  inside italic gets one class), no inline code spanning lines, no reference-style links, and no
  indented (4-space) code blocks. Spans over 200 characters on one line are left uncoloured.
- **Very large inserts aren't undoable in one step.** An insert of more than 150 lines (a big
  converted paste) skips `execCommand` because of Chrome's slowdown. Native plain-text pastes of any
  size keep undo.
- **Tables**: body `rowspan` leaves the spanned cells empty rather than repeating the value. Lists,
  quotes and code inside a cell are flattened to text. There is no `<br>` in cells, because
  react-markdown shows raw HTML as text.
- **Word**: alignment set on a cell's inner `<p align>` isn't picked up. Word's picture of the
  selection (`image/png`) is ignored because text is preferred.
- **Safari Cmd+Shift+V**: Safari's own "paste and match style" is Opt+Shift+Cmd+V. Cmd+Shift+V is
  handled when the browser fires a paste for it.
- **Phones**: the toolbar row scrolls sideways if it doesn't fit, and Preview is behind **Aa** along
  with the other tools. This was checked in Playwright's WebKit and Chrome mobile emulation, not on
  a physical iPhone.
