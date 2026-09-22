# Mermaid diagram rendering in the transcript

## What

A fenced code block with language `mermaid` anywhere markdown is rendered in the transcript
(assistant text, user text, system entries, compaction summaries -- all of it goes through
`components/Markdown.tsx`) now renders as a diagram instead of a code block. Everything else
markdown does is unchanged.

New files, all under `packages/web/src/`:

- `lib/mermaid-fence.ts` -- pure helpers (`isMermaidFence`, `fenceLanguage`,
  `codeChildrenToSource`) for detecting a ` ```mermaid ` fence inside react-markdown's `code`
  component override.
- `lib/mermaid-safety.ts` -- the security gate: `isSvgRoot`, `isSafeMermaidMarkup`,
  `isSafeMermaidSvg`. Pure string/DOM-parsing functions, no mermaid import.
- `lib/mermaid-theme.ts` -- maps our `theme.css` custom properties onto mermaid's `theme: "base"`
  `themeVariables` (`buildMermaidThemeVariables`), plus `readThemeTokensFromDocument` /
  `DEFAULT_THEME_TOKENS`.
- `hooks/useDebouncedValue.ts` -- generic trailing-edge debounce hook, `undefined` until the value
  has been stable for the delay (including the very first value).
- `components/MermaidDiagram.tsx` -- the render pipeline: lazy-load, debounce, mermaid.render,
  safety gate, toolbar, error fallback.
- `components/MermaidEnlargeDialog.tsx` -- full-screen pan/zoom view of an already-rendered SVG.
- `styles/mermaid.css` -- the surrounding chrome (box, toolbar, loading/error states, enlarge
  dialog). Diagram colors themselves come from mermaid's `themeVariables`, not this file.

Changed files:

- `components/Markdown.tsx` -- ~6 lines: `code` routes a `language-mermaid` fence to
  `MermaidDiagram` instead of a `<code>`; `pre` skips its usual `.md-pre` wrapper for that one
  case so the diagram gets its own box.
- `style.css` -- one `@import` line for `styles/mermaid.css`.
- `package.json` / `package-lock.json` -- added `mermaid@^12`.

`Composer.tsx` and the session page's live-update wiring were left untouched, per the parallel
work happening on those files.

## Security choices

Transcript text is untrusted model output (same trust boundary `Markdown.tsx` already documents
for the rest of markdown rendering). Three independent layers:

1. **mermaid config**: `mermaid.initialize({ startOnLoad: false, securityLevel: "strict",
   htmlLabels: false, ... })`. `securityLevel: "strict"` sanitizes label content (strips
   `<script>`, event-handler attributes, `javascript:` URLs) and disables mermaid's click-callback
   feature. `htmlLabels: false` was added after visual testing found that `securityLevel: "strict"`
   alone does **not** stop mermaid from wrapping flowchart node/edge labels in
   `<foreignObject><div>...</div></foreignObject>` for HTML-based text sizing -- that's still "raw
   HTML inside the SVG" as far as this boundary is concerned, so it's turned off outright and
   mermaid always emits plain SVG `<text>`.
2. **Render call**: `mermaid.render(id, text)` returns an SVG string (never used with
   `startOnLoad`/auto-DOM-injection). The result is checked with `isSvgRoot` (parses it and
   confirms a single `<svg>` root, no parser error) before anything else happens to it.
3. **Independent re-check**: `lib/mermaid-safety.ts`'s `isSafeMermaidSvg` combines `isSvgRoot` with
   a second, mermaid-independent string scan (`isSafeMermaidMarkup`) for `<script`, `on[a-z]+=`,
   `javascript:`, and `<foreignObject` (defense in depth even though config already disables it).
   Only if both checks pass does the SVG string reach `dangerouslySetInnerHTML`; otherwise the
   block renders as an error ("Rendered diagram failed a security check and was not displayed.")
   with the source shown as plain text, same as a parse failure.

This was exercised for real: an early version without `htmlLabels: false` had every flowchart
(not sequence/other diagram types, which don't use `foreignObject`) trip the security gate during
visual verification, which is how the `htmlLabels: false` fix was found.

### Testing the security check

mermaid cannot actually execute inside this project's vitest environment (jsdom): a real
`mermaid.render()` call throws `getBBox is not a function` even for a trivial `flowchart TD\nA-->B`
diagram, because mermaid's layout code calls SVG measurement APIs jsdom doesn't implement. This is
noted in `test/mermaid-safety.test.ts` and `test/mermaid-diagram.test.tsx`. Two things were done
instead, per the task's fallback instruction:

- `test/mermaid-safety.test.ts` tests the sanitizing gate as a **pure function**, directly, against
  SVG strings shaped like what a `securityLevel: "strict"` render would (or, for the attack cases,
  would not) produce: a `<script>` tag, an `onclick`/`onerror` attribute, a `javascript:` URL, a
  `<foreignObject>`, case variants of all of the above, and a non-`<svg>` root.
- `test/mermaid-diagram.test.tsx` mocks the `"mermaid"` module (`vi.mock`) so `MermaidDiagram`'s
  own orchestration is exercised end-to-end without a real render: it verifies the strict/
  `htmlLabels: false` config is actually passed to `mermaid.initialize`, and that an SVG containing
  `<script>` is rejected and never reaches the DOM (`container.innerHTML` is asserted not to
  contain it) even when `mermaid.render` itself "successfully" returns it.

## Lazy loading / chunk size

`mermaid` is dynamic-`import()`ed inside `MermaidDiagram.tsx`, cached at module scope
(`mermaidModulePromise`) so a transcript with several diagrams only fetches it once, and only
triggered once a diagram block has scrolled into view (`IntersectionObserver`, `rootMargin: "200px"`;
falls back to "just render" if `IntersectionObserver` is unavailable). While loading/rendering, the
existing `<Working label="Drawing diagram…" size="lg" srOnly={false} />` indicator is shown.

Verified with `npm run build` (`packages/web`):

- `SessionPage-*.js` (the lazy page chunk `EntryItem`/`Markdown`/`MermaidDiagram` live in):
  **182.5 kB / 56.1 kB gzip** -- confirmed by grep that it contains only the dynamic-`import()`
  filename pointer to mermaid's own chunk, plus this project's own `MermaidDiagram` code (one
  occurrence of the literal `"securityLevel"` from our config object); it does not contain
  mermaid's `"securityLevel"` string five times over the way `mermaid.core-*.js` does.
- `index-*.js` (the main/eager bundle): **313.0 kB / 97.0 kB gzip** -- no mermaid reference at all.
- `mermaid.core-*.js` (mermaid's own runtime, lazy-loaded on first mermaid block): **682.4 kB /
  166.3 kB gzip**.
- mermaid itself further code-splits per diagram type (`flowDiagram-*.js` 64 kB, `sequenceDiagram-
  *.js` 119 kB, `elk-*.js` 1.47 MB for the rarely-used ELK layout engine, etc.) -- these are
  mermaid's own lazy chunks, fetched only for the diagram types actually used on a page, not
  something this change controls directly.

So: `mermaid` (and its considerable weight) is fully out of both the main bundle and the
session-page chunk, and is only fetched the first time a `mermaid` fence actually scrolls into
view.

## Streaming / debounce

`useDebouncedValue(source, 500)` returns `undefined` until `source` has been stable for 500ms --
deliberately including the very first render, since a diagram block can mount mid-stream (the
first chunk of a still-growing fence). `MermaidDiagram` only starts the load/render pipeline once
it has a defined, debounced value; every change to `source` (including the initial one) restarts
the 500ms timer. Once a diagram has rendered once, a later source change keeps showing the last
good render while the new one debounces, rather than flashing back to the loading state.

## Streaming / errors, controls, theming, layout

- **Errors**: a `mermaid.render` rejection, or a result that fails the security gate, shows the
  raw source as a normal `.md-pre` code block with a small "diagram error" badge and the parser's
  message inside a collapsed `<details>` -- never a blank or broken area.
- **Controls**: each successfully-rendered diagram gets a small toolbar -- **Source** toggles
  between the diagram and its raw text (and disables Enlarge while in source view), **Copy**
  copies the mermaid source to the clipboard (same `navigator.clipboard.writeText` + 2s "Copied!"
  pattern already used elsewhere in this codebase), **Enlarge** opens `MermaidEnlargeDialog`: a
  full-screen `.dialog` with Pointer-Events-based pan (single pointer drag) and pinch-zoom (two
  pointers) plus wheel-to-zoom, a Reset button, and closes on Escape or the close button. Verified
  manually in the browser: pointer/wheel zoom, drag pan, and Escape-to-close all work.
- **Theme**: `theme: "base"` + `themeVariables` built from the live `--bg`/`--text`/`--border`/etc.
  custom properties (`lib/mermaid-theme.ts`), re-read via a `MutationObserver` on `data-theme` and
  a `prefers-color-scheme` media-query listener, so toggling the theme re-renders any open diagram
  in the new palette. Verified live in the browser: toggling dark/light re-colors an already-open
  diagram without a page reload.
- **Layout**: `.mermaid-canvas` caps its height (`max-height: 340px`) and scrolls both axes inside
  itself; verified no page-level horizontal overflow at 390px width (`document.documentElement
  .scrollWidth === clientWidth`, checked live). Enlarge is the way to see a diagram taller than the
  cap.

## Verification

- `cd outfitter && npm ci && npm test --workspace=@outfitter/web && npm run build` -- all green
  (190/190 tests, clean build) after a fresh `npm ci`.
- Visual: ran the API locally in memory mode, imported a session (`PUT
  /api/sessions/:id/import`) with an assistant message containing a flowchart and a sequence
  diagram, and a second assistant message with a deliberately malformed ` ```mermaid ` block, then
  screenshotted `/sessions/<id>` with `playwright@1.57.0` at 1280x860 and 390x844, dark and light:
  - `docs/design/screenshots/mermaid-desktop-dark.png`
  - `docs/design/screenshots/mermaid-desktop-light.png`
  - `docs/design/screenshots/mermaid-mobile-dark.png`
  - `docs/design/screenshots/mermaid-mobile-light.png`

  All four show the flowchart and sequence diagram rendered natively themed (C64 dark /
  GEOS-paper light), with the toolbar and no page overflow at phone width. A fifth, interactive
  pass in the browser (not screenshotted, described above) additionally exercised the error
  fallback, Source/Copy/Enlarge controls, pan/zoom/Escape in the enlarge dialog, and the live
  theme-toggle re-render.

## What's left

- mermaid's own per-diagram-type chunks (flowchart ~64 kB, sequence ~119 kB gzip'd smaller, ELK
  layout ~1.47 MB) are fetched by mermaid itself on demand; nothing here controls that further, but
  it's worth knowing the `elk-*` chunk exists if a future diagram type change makes it load more
  often than expected.
- `Composer.tsx` and the session page's live-update/streaming-append wiring were explicitly out of
  scope (parallel work) and were not touched; `useDebouncedValue`'s "undefined until settled,
  including on mount" behavior was designed against the existing `EntryItem`/`Markdown` re-render
  pattern, not against that other change, so it's worth a quick look once both land together.
- Pinch/pan in the enlarge dialog was verified with wheel-zoom, drag-pan and Escape in a real
  browser; true multi-touch pinch was not verified on an actual iPhone (only via the pointer-event
  code path, which unifies mouse and touch), since no physical/simulated multi-touch device was
  available in this environment.
