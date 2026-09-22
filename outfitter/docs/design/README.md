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

`src/lib/floppy-sound.ts` synthesizes a motor hum plus irregular head-seek clicks with the Web
Audio API — no audio files, no sampled recordings. **Off by default**; toggle it with the speaker
control in the header (`components/SoundToggle.tsx`, persisted to `localStorage` under
`outfitterSound`, wrapped in try/catch). It sounds like a low, slightly detuned engine hum with a
scatter of short square-wave "ticks" layered on top, fading up over ~150ms and spinning down over
~250ms — closer to a 1541 than a hard drive.

It only ever plays for a wait the user just started (composer send, session create, wake/stop/
abort, token create, UI-request responses) via `withFloppySound(promise)`, which wraps the call:
starts after `startDelayMs()` (300ms, so instant responses stay silent), loops while the promise is
pending, stops with the spin-down fade when it settles, and is hard-capped at `maxDurationMs()`
(20s) regardless of how long the underlying call takes. It is never wired to background polling or
SSE updates, so playback always follows a user gesture (this also means it never trips browser
autoplay blocking). One shared `AudioContext` is created lazily on first use and reused; every
method is wrapped so a browser without Web Audio, or a blocked/suspended context, fails silently
instead of throwing.

The scheduling is pure and seeded (`makeRng` — mulberry32 — and `scheduleSeekClicks`), tested in
`test/floppy-sound.test.ts`; the audio graph itself (oscillators, gain envelopes) is not unit
tested since there's no meaningful assertion to make on it — it was verified by ear during this
pass (see `docs/reports/design-pass.md`).

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
