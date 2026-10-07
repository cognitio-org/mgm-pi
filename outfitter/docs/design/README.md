# Outfitter web UI — design system

## Concept

Outfitter equips a fleet of cloud coding agents ("Gurus") the way an outfitter equips an
expedition — this is a working tool, not a marketing site, so the direction is "professional but a
bit quirky," never generic dark-SaaS (near-black backgrounds, purple/blue gradients, glassmorphism,
rounded pastel cards — the look this pass was explicitly asked to avoid). Two deliberate,
period-accurate looks stand in for light/dark mode instead of a single default re-skinned twice:
**light** borrows from early Macintosh System 1–6 and GEOS — warm paper, crisp 1px black rules,
striped window title bars, square corners, hard offset shadows instead of blur, a sparing 1-bit
dither on empty states and the header strip; **dark** borrows from a Commodore 64 sitting next to a
phosphor terminal — a blue-violet screen (never black), light-blue-violet borders and body text,
and phosphor green held back for exactly one meaning: "this is live." Motion follows the same rule
as the palette: steps, not eases — a blinking cursor, a chasing cassette-loading stripe — because
this theme has no blur or gradients anywhere else either. Everything respects
`prefers-reduced-motion` and neither status nor "busy" state ever relies on colour alone.

## Palette

Defined as CSS custom properties in `src/styles/theme.css`; dark is the default via
`prefers-color-scheme`, overridable either direction with `[data-theme]` (`ThemeToggle.tsx`,
persisted to `localStorage` under `outfitterTheme`, wrapped in try/catch). All pairs below were
checked against WCAG AA (4.5:1 for normal text, 3:1 for large text/UI elements) with a small
contrast script; ratios are the WCAG contrast ratio, not a percentage.

### Dark — C64 phosphor terminal

| Token | Hex | Role | Checked against | Ratio | AA |
|---|---|---|---|---|---|
| `--bg` | `#302870` | page background | — | — | — |
| `--bg-elevated` | `#3a3184` | panels, header, inputs | — | — | — |
| `--text` | `#e4e0fb` | body text | `--bg` | 9.83 | pass |
| `--text` | `#e4e0fb` | body text | `--bg-elevated` | 8.38 | pass |
| `--text-dim` | `#a89fe0` | secondary text | `--bg` | 5.23 | pass |
| `--link` | `#b3a8f0` | links, brighter than `--border` for AA on running text | `--bg` | 5.88 | pass |
| `--link` | `#b3a8f0` | links | `--bg-elevated` | 5.01 | pass |
| `--border` | `#8b7cd8` | hairlines, pill borders (UI, 3:1 target) | `--bg` | 3.59 | pass (UI) |
| `--ok` (phosphor green) | `#5cff8a` | live/running/cursor only | `--bg` | 9.70 | pass |
| `--warn` (C64 yellow) | `#f4cf3c` | queued/provisioning/stopping/degraded | `--bg` | 8.32 | pass |
| `--danger` (C64 red) | `#ff8a8a` | failed/down, brightened from a "pure" C64 red for AA | `--bg` | 5.56 | pass |
| `--danger` | `#ff8a8a` | failed/down | `--bg-elevated` | 4.74 | pass |

### Light — early Mac / GEOS paper

| Token | Hex | Role | Checked against | Ratio | AA |
|---|---|---|---|---|---|
| `--bg` | `#f1ebdd` | page background (warm paper) | — | — | — |
| `--bg-elevated` | `#fffdf8` | panels, header, inputs | — | — | — |
| `--text` | `#171512` | body text | `--bg` | 15.33 | pass |
| `--text-dim` | `#5b5548` | secondary text | `--bg` | 6.23 | pass |
| `--link` / `--accent` (GEOS blue) | `#2a4b8d` | links, primary buttons, title-bar stripe | `--bg` | 7.10 | pass |
| `--border` / `--border-strong` | `#1a1712` / `#000` | hairline rules (crisp black, per the brief) | `--bg` | 14.64 | pass |
| `--ok` | `#2e6b3e` | live/running | `--bg` | 5.37 | pass |
| `--warn` | `#8a5c10` | queued/provisioning/stopping/degraded | `--bg` | 4.88 | pass |
| `--danger` | `#b0242b` | failed/down | `--bg` | 5.64 | pass |

The contrast script (`node`, mulberry-free, just relative luminance + the WCAG formula) is not
checked in; the numbers above are reproducible from the hex values in `theme.css`.

## Type

Three self-hosted families via `@fontsource/*` (no third-party network requests — the app runs
behind IAP and should stay fully self-contained), latin subset only, two weights each to keep the
added weight modest (~140 KB across woff+woff2 for all three, browsers fetch one format):

- **Silkscreen** (`--font-display`, 400/700) — the pixel/retro display face, used *only* for the
  logo, headings, status-pill/working labels, and panel title bars. Picked over "Press Start 2P"
  (too wide at UI sizes, per the brief) and VT323 (reads more "terminal prompt" than "Chicago
  bitmap heading" — kept as a mental note, not shipped).
- **IBM Plex Sans** (`--font-body`, 400/600) — humanist sans for body copy, forms, buttons, nav.
- **IBM Plex Mono** (`--font-mono`, 400/500) — the transcript, tool call/result bodies, code,
  masked secrets, session metadata.

## Component classes

Defined in `src/styles/components.css`, styled by class name and generic element selectors so the
Gurus and Settings pages landing alongside this branch can adopt them without new CSS. Existing
class names (`status-pill`, `data-table`, `empty-state`, `form-row`, `dialog`, `entry`, …) were kept
and restyled in place, not renamed.

| Class | What it is | Notes |
|---|---|---|
| `.panel` | Window chrome: bordered box with a hard offset shadow | Pair with `.panel-titlebar` (a `<div>`) or `h2.panel-title` for the striped title bar; `.panel-body` for padded content |
| `.btn`, `.btn-primary`, `.btn-danger` | Button variants | Plain `<button>` is already styled the same as `.btn` by default — add `.btn-primary`/`.btn-danger` for emphasis. Buttons showing a `<Working>` while in flight should also be `disabled` |
| `.status-pill`, `.pill` | Status chips with colour **and** a glyph (never colour alone) | Add a state class: `running`/`up`, `queued`, `provisioning`, `idle`, `stopping`, `stopped`/`down`, `failed`, `degraded`. `.status-pill` is the existing class (kept); `.pill` is a plain alias for new pages |
| `table.data-table`, `table.table` | Data tables | Wrap in `.table-scroll` (`<div className="table-scroll"><table>…`) so a wide table scrolls within itself instead of the page — required to keep phone width scroll-free |
| `.meter`, `.meter-fill`, `.meter-warn`, `.meter-danger` | Horizontal bar for budget/context use | `<div class="meter"><div class="meter-fill" style="width:NN%"></div></div>`; add `meter-warn`/`meter-danger` on the outer element past a threshold |
| `.masked` | Masked/secret value display (monospace chip) | Used for token prefixes; wrap any partially-hidden secret in it |
| `.empty-state`, `.empty-state.dither` | Empty-state message block | Add `.dither` for the sparing 1-bit pattern texture on a genuinely empty page (not on every loading state) |
| `.form-row`, `.form-actions`, `.error-banner` | Form layout | Unchanged from the original shape, restyled |
| `.working`, `.working-sm`/`.working-lg`, `.working-stripe`, `.working-label` | Busy indicator, see below | `<Working label="Sending" />` |
| `.dither` | Sparing 1-bit dither texture | Header strip and empty states only, per the brief — don't reach for it elsewhere |
| `.sr-only` | Visually-hidden, screen-reader-only text | Utility, not theme-specific |

## Density and the conversation view

The retro chrome stays (striped title bars, hard shadows, square corners), but space goes to the
conversation first:

- **Width.** `.app-main` is capped at 1320px, not 1100px. Prose inside a transcript card wraps at
  about 100 characters (`max-width: 100ch` on its paragraphs, lists and headings), so a wide window
  gives code blocks and tables room without making paragraphs hard to read.
- **Control height by pointer.** Touch screens keep the 44px tap target. With a mouse or trackpad
  (`hover: hover` and `pointer: fine`), buttons, inputs and selects are 34px, the session title
  bar's transport buttons are 28px, and the status-bar chips are 24px. All of these are above
  WCAG 2.5.8's 24px minimum.
- **Transcript spacing.** Cards have smaller gaps and padding, and the who-marks and rail glyphs
  are slightly smaller. Prose in a message is 0.94rem with a 1.55 line height, a little larger
  than the UI around it.
- **Composer.** The editor spans the full width, and **Send** closes the controls row under it in
  the bottom-right corner, on desktop and phone alike, so no space is trapped beside a tall
  draft. Send is the largest control: 42px tall on desktop, 48px on touch, at least 7rem wide on
  desktop, with a ▶ glyph. Send mode is a `<select>` with full labels on desktop. On a phone it's
  a small native picker with the short labels (Prompt / Steer / Follow-up), which replaces the
  old three-button segmented control. The phone also drops **Aa** and the formatting toolbar; the
  editor still highlights Markdown as you type. With an empty
  draft it dims its colours rather than its opacity, so the label stays readable. The editor
  starts at three lines and grows to `min(26rem, 50vh)`. The ⇡ toggle next to **Aa** switches to
  a tall editor (`min(22rem, 40vh)` up to 70vh; on phones 34svh up to 55svh). The choice is
  remembered per browser under `outfitter.composer.tall`. The status row above the editor only
  shows while there's a send status.
- **Tool steps say what ran, in one place.** The model's work shows as one row of chips under
  the message it belongs to, on desktop and phone alike. There's no separate right-hand rail. Each
  chip names what ran: the tool name plus a short hint (the command, path or query, never raw
  JSON), e.g. `bash  npm test -- login`, or `thinking`. Hover or click opens the full input and
  output in a card just below the chip. More than four finished calls fold into one `N tools`
  chip.

  Which message a chip belongs to (`lib/beats.ts`):
  - A tool called after a message belongs to that message, because the message announced it ("I'll
    run the tests").
  - Thinking starts a new group and goes with the message that follows it.
  - Tools with no message to attach to (the start of a turn, or right after a thought) form their
    own row until a message claims them.
- **Turns.** Each of your messages gets a little extra space above it, so the transcript reads
  as exchanges rather than one long column.
- **Syntax colours.** Fenced code with a language tag is coloured by `lib/rehype-code-colour.ts`
  (lowlight/highlight.js grammars, the curated set in `lib/code-languages.ts`). The highlighter
  is its own ~42 kB gz chunk, fetched the first time a message contains a tagged fence. Until it
  arrives, and for untagged or unknown fences, code renders plain. Mermaid and html fences are
  never coloured. Tokens are `--syn-*` in `theme.css`, all AA on `--bg-inset`:

  | Token | Dark | Ratio | Light | Ratio |
  |---|---|---|---|---|
  | `--syn-keyword` (also 500 weight) | `#f4cf3c` C64 yellow | 9.7 | `#2a4b8d` GEOS blue | 6.3 |
  | `--syn-string` | `#a6f29a` | 11.1 | `#2e6b3e` | 4.7 |
  | `--syn-number` | `#ffb38a` | 8.4 | `#8a3b12` | 5.7 |
  | `--syn-comment` (also italic) | `#a39bd9` | 5.8 | `#5b5548` | 5.5 |
  | `--syn-title` (functions) | `#8fd3ff` | 9.1 | `#7a1f6b` | 7.0 |
  | `--syn-type` | `#eaa6ff` | 8.0 | `#7a4f0a` | 5.3 |
  | `--syn-attr` | `#c7bdff` | 8.5 | `#1d5c66` | 5.6 |
  | `--syn-meta` | `#ff9a9a` | 7.2 | `#b0242b` | 5.0 |
- **Long messages** (`lib/reading.ts`'s `isLongDocument`: 1200+ characters, or two or more
  headings) show in full and formatted, in a box capped at `min(55vh, 34rem)` that scrolls on its
  own, with a dashed rule underneath. A small pixel pop-out badge sits on the card's top border,
  opposite the who-mark, and opens the same text in `ReadingDialog`. This replaces the earlier
  "opening paragraph + Read button" layout, which hid the formatting and broke up the reading.

## Nerd out panel

The session page's home for operational details (#198), in `src/styles/nerd-out.css`. The
**Nerd out** chip, first in the status bar, opens it between the title bar and the transcript. It's
closed on every visit, and on a desktop it scrolls inside itself at about half the window.

- **Spec sheet** (`.spec`, `.spec-row`): pixel-face labels, a dotted leader, monospace values that
  ellipsize (the full value is the `title`). Used for the drive's run, provider, pod, node, image,
  limits and how it ended (`is-danger` / `is-ok`).
- **Strip charts** (`StripChart.tsx`, `.strip-chart`): a stepped phosphor (`--ok`) line over a dot
  grid on `--bg`, like a strip-chart recorder; a dashed `--danger` line marks a limit.
- **Drive log** (`LogViewerDialog.tsx`, `.log-viewer`): fetched only when **View logs** is
  pressed. A terminal screen on `--bg-inset` with a faint scanline, a severity tag per line (INF,
  WRN in `--warn`, ERR in `--danger`, DBG), filter, level, wrap, follow and copy. A `--warn` strip
  says the lines come from the drive itself and aren't verified; they're always plain text.
  Off-screen rows use `content-visibility: auto`.

## Busy/working indicator

`components/Working.tsx` is a reusable "the UI is sending/loading/waiting" indicator, used for
every user-initiated wait: composer send, session create, wake/stop/abort, page loads, provider
refresh, token create, and (as a "the agent is doing something" state, not a discrete action) the
session transcript while the run is `queued`/`provisioning`/`running`.

The shipped design is a **C64 cassette-loading border stripe** — alternating phosphor-green/accent
bars scrolling in discrete steps, the way a C64 flickers its screen border while a tape loads.
Two alternatives were drawn and rejected, kept as SVGs in this directory for reference:

- `alt-working-ring.svg` — an 8-point pixel "chasing light" ring. Reads as a generic spinner, which
  is the one shape this theme is explicitly trying not to reach for.
- `alt-working-wristwatch.svg` — the classic System 1–6 busy cursor. It replaces the mouse pointer
  in the real OS; redrawn as an inline icon it reads as a clock/settings glyph, not "busy," without
  a label doing the actual work.
- `alt-working-hourglass.svg` — a GEOS-style hourglass. Implies a bounded, known duration, which
  most of these waits don't have.

Usage: `<Working label="Sending" />` (size `"sm"`, inline in a button, label screen-reader-only by
default) or `<Working label="Loading fleet" size="lg" srOnly={false} />` (page/panel state, visible
label). It's `role="status"` + `aria-live="polite"` so assistive tech announces it, and the stripe
animation (plus the animated-ellipsis label suffix) is replaced by a static equivalent under
`prefers-reduced-motion`. Buttons that start a request disable themselves and swap their label for
a `<Working>` while the call is in flight, so double-submits can't happen.

## Optional floppy-drive sound

`src/lib/floppy-sound.ts` plays real floppy-drive recordings, the same two clips the kernal.one
landing page uses, served from `public/sounds/`: `launch.mp3` (~4.7s: a head seek, then the drive
reading) and `load.mp3` (~1.35s: a pair of seeks). **Off by default**; toggle it with the speaker
control in the header (`components/SoundToggle.tsx`, persisted to `localStorage` under
`outfitterSound`, wrapped in try/catch).

It only ever plays for a wait the user just started (composer send, session create, wake/stop/
abort, token create, UI-request responses) via `withFloppySound(promise)`, which wraps the call:
after `startDelayMs()` (300ms, so instant responses stay silent) it plays `launch.mp3` from the
start, seek then reading. If the wait outlasts the clip, the reading section (~2.32s to ~4.47s,
both quiet points so the seam doesn't click, chosen to stay quiet whether or not the decoder trims
the MP3 encoder delay of ~46ms) loops seamlessly through an `AudioBufferSourceNode`'s
`loopStart`/`loopEnd`, and every 2.5 to 6s a `load.mp3` seek burst is laid over it with the reading
ducked underneath, so a long wait sounds like a drive stepping between tracks rather than one
two-second loop. When the promise settles it fades out over `spinDownMs()` (250ms), and it's
hard-capped at `maxDurationMs()` (20s, counted from when the sound actually starts) regardless of
how long the call takes. Overlapping waits share one playback, reference-counted: it keeps going
while at least one of them is pending and fades only when the last settles, so a quick wait
finishing can't cut off a long one. It is never wired to background polling or SSE updates, so
playback always follows a user gesture (and never trips browser autoplay blocking). The one
non-request use is the Manual's tour (`components/tour/TourAnimation.tsx`), which plays a ~1.4s
burst when its "drives" scene appears, and only once the user has clicked or pressed a key inside
the tour, so `/manual?autoplay=1` stays silent until someone interacts with it.

The clips are fetched and decoded (`decodeAudioData`) lazily, on the first wait that has sound on,
never at page load, and cached with one shared `AudioContext`, which is suspended once nothing is
waiting and the spin-down has finished (and resumed on the next wait). Everything fails silent: no
Web Audio, a blocked context, or a failed fetch or decode just means no sound; a failed load is
retried on a later wait after a backoff (`clipRetryDelayMs`: 15s, doubling, up to 5 minutes).

The pure parts (timing constants, the preference, the loop points `readingLoopPoints`, and the
seeded seek-burst schedule `scheduleSeekBursts`) are tested in `test/floppy-sound.test.ts`, along
with the refcounting, cap, suspend and retry behaviour against a fake `AudioContext`; the sound
itself is checked by ear.

**Credits.** Excerpts from two freesound_community recordings on Pixabay, "Floppy drive on old PC"
(item 52014) and "Reading floppy disc 2" (item 35303), under the
[Pixabay Content License](https://pixabay.com/service/license-summary/). Details of the excerpts
are in `public/sounds/CREDITS.md`.

## Logo

`src/components/Logo.tsx` (`<Logo variant="mark" | "full" />`), plus static duplicates at
`src/assets/logo-mark.svg` (mark alone) and `src/assets/logo.svg` (mark + wordmark) for use outside
React, and `public/favicon.svg` (self-coloured, since a favicon has no ancestor to inherit
`currentColor` from). The mark is a pixel-grid rucksack — an outfitter equips expeditions — with a
blinking phosphor-green cursor pixel tucked at its corner, standing in for the agents ("Gurus") at
a prompt. Drawn on a 16×16 grid with square `<rect>` pixels (`shape-rendering: crispEdges`), using
`currentColor` so it re-themes for free.

Three alternative marks were drawn and rejected, kept in this directory:

- `alt-compass.svg` — reads as "navigation/maps," undersells that Gurus do work rather than just
  find the way; round dial shapes also don't hold up at 1-bit pixel sizes.
- `alt-lantern.svg` — fits "expedition," but its glow only means something in dark mode; flat and
  generic in the light GEOS theme, where nothing else is meant to glow.
- `alt-mule.svg` — needs legs and a head to read as an animal at 16×16, which eats the whole grid
  and leaves no room for a "live" accent pixel; reads as a mascot, out of step with a tool used all
  day.

## Theming mechanics

- `prefers-color-scheme` sets the default; `ThemeToggle.tsx` sets `data-theme="dark"|"light"` on
  `<html>` and persists it. `index.html` applies a stored theme before first paint (inline, tiny
  script) so there's no flash of the OS-preferred theme.
- `prefers-reduced-motion` turns off: the scanline wash (`body::before`), the running-pill glyph
  blink, the logo's cursor blink, the working indicator's stripe scroll and animated ellipsis (both
  replaced by a static equivalent, never just hidden).
- Status pills never rely on colour alone — each state has both a colour and a glyph
  (▶ running, ⧖ queued, ↻ provisioning, ⏸ idle, ● stopping, ■ stopped/down, ✗ failed, ⚠ degraded).

## Vocabulary (retro labels)

UI-only relabeling, defined once in `src/lib/vocabulary.ts` and used for nav, page titles/
subtitles, desk icons, menus, empty states and buttons. Routes, API paths, data field names and
code identifiers are unchanged — grep for `guruId`, `/api/gurus`, `sessionId`, etc. still finds the
real names. Every page subtitle reads `"<label> · <hint>"`; the same hint is the `title` tooltip on
the corresponding nav item, desk icon or button.

| Label (UI) | Plain meaning | Code name |
|---|---|---|
| Tape / Tapes | Reusable agent configuration: model, prompt, tools | `guru` / `Guru` |
| Floppy / Floppies | A conversation with an agent you can continue later | `session` / `Session` |
| Disk Box | The session list (all floppies) | `/fleet` route, `SessionSummary[]` |
| New Floppy | Start a new session | `NewSessionDialog` |
| Drive / Drives | A cloud sandbox running an agent right now | running `Session`/`Run` (provisioning/running) |
| Peripheral / Peripherals | Model and service providers, and their health | `provider` / `ProviderRow` |
| Dongle / Dongles | Personal access token for Kernal teleport | `token` / `TokenRecord` |
| Control Panel | Keys and deployment settings | `/settings` route, `OperatorSettings` |
| Sysop | Operator role: can change keys and deployment settings | `Identity.operator` |
| Manual | Help / about | (no code equivalent — a dialog only) |
| Trash | Stopped floppies | sessions with `runState` `stopped`/`failed` |
| Archive | Floppies put away: hidden from the Disk Box and read-only until restored; also the verb | `archivedAt`, `POST /api/sessions/:id/archive` · `/restore` |
| Format | Erase an archived floppy for good | `DELETE /api/sessions/:id` |
| Desk | The Outfitter desktop (home page) | `/` route, `DeskPage.tsx` |
| ▶ Play | Wake a floppy and start its run | `wake` |
| ■ Stop | Stop a floppy's run | `stop` |
| Break | Interrupt the current turn (like the C64 RUN/STOP key) | `abort` |
| ⏏ Eject | Continue this floppy on your laptop with Kernal | "Open in terminal" / `kernal --teleport` (`mgm` still works as an alias) |
| Send | Send a message | `sendMessage` (unchanged — the brief keeps this one as-is) |
| Kernal | The coding agent that runs sessions, on your laptop or in a cloud Drive | laptop/cloud agent, formerly called "mgm" in the UI; the `mgm` command still works as an alias |

## Retro error vocabulary

Every failure gets a retro headline, a plain sentence, and a useful action -- never just a red
banner (`src/lib/retro-errors.ts` for the pure headline/message/status mapping,
`src/components/{ErrorBoundary,SystemErrorDialog,NotFoundError,DeviceNotPresent,SyntaxError}.tsx`
for the rendering):

| Headline | Where | Component |
|---|---|---|
| KERNAL PANIC | An unhandled render error anywhere under the routes | `ErrorBoundary.tsx`, full-screen, `role="alert"` |
| Sorry, a system error occurred. | Any failed API call (replaces the old plain `.error-banner`) | `SystemErrorDialog.tsx`, an early-Mac bomb dialog; ID = HTTP status, body = the API's message, Restart retries / Resume dismisses |
| ?FILE NOT FOUND ERROR | The 404 route, an unknown session id | `NotFoundError.tsx`, with a link back to the Desk |
| ?DEVICE NOT PRESENT ERROR | A down Peripheral (row detail), a session whose model's provider is down, the browser offline | `DeviceNotPresent.tsx` |
| ?SYNTAX ERROR | An invalid form field (the guru form's name, the token name) | `SyntaxError.tsx`, inline beside the field |
| ?OUT OF MEMORY ERROR | The session context meter at 95%+ | inline note beside the meter |
| READY. | The session header/composer idle line, with a blinking block cursor | `lib/retro-errors.ts`'s `deriveTransportStatusLine` |
| BREAK | Flashed after Break (abort) succeeds | same |
| LOAD ERROR | Flashed when Play (wake) fails | same |

An unhandled *promise* rejection (never a render error, so `ErrorBoundary.tsx` can't see it) shows a
small dismissable banner instead of the KERNAL PANIC screen (`UnhandledRejectionBanner.tsx`).
`reduced-motion` stops every blink; both themes inherit the same `theme.css` tokens as everything
else in this document.
