# The Manual: glossary + animated tour

## What

Adds an in-app Manual (`/manual` in `packages/web`): a ~75-second self-playing pixel-art tour of
Outfitter's retro vocabulary, a glossary (table on desktop, cards on mobile), "how a typical task
goes" in five steps, and a table of the retro error messages and what they mean. A first-visit
`TourOffer` dialog ("Take the 75-second tour?") is mounted on the Manual page itself for now, ready
for the desk/entry page (landing alongside this branch from another agent) to mount instead.

The same term list is also written out as plain docs at `docs/glossary.md` for GitHub readers who
never open the app.

## Where

All new files, plus the minimum edits needed to wire them in, per the merge constraints for this
branch (another agent is reworking `packages/web` concurrently -- mobile layout, a GEOS desktop
entry page at `/`, `src/lib/vocabulary.ts`, error screens):

- `packages/web/src/lib/glossary.ts` -- the term list (label/meaning/code name/glyph/link),
  the error-message table, and the five typical-task steps. Carries a note for whoever lands
  `src/lib/vocabulary.ts`: this file is shaped so its `label`/`meaning` strings can later be sourced
  from that module instead of being hardcoded here, once it exists.
- `packages/web/src/components/tour/tour-timeline.ts` -- pure scene-timeline math (which scene is
  active at time *t*, next/previous, total duration). No DOM, unit tested.
- `packages/web/src/components/tour/scenes.tsx` -- the nine original pixel-art scenes (opening,
  Kernal, Tapes, Floppies, Drives, Disk Box, Eject, Peripherals/Dongles/Control Panel, closing),
  drawn the same way as `Logo.tsx`/`Working.tsx`: square `<rect>`/`<text>` SVG, `crispEdges`,
  `currentColor` plus the theme's `--ok`/`--warn`/`--accent` tokens.
- `packages/web/src/components/tour/TourAnimation.tsx` -- orchestrates playback: play/pause,
  previous/next, skip, a segmented progress bar, always-visible captions (`aria-live="polite"`),
  a short floppy-sound burst on the Drives scene (only if the header's sound toggle is already on --
  see below), and a `prefers-reduced-motion` fallback that swaps the whole thing for a static
  step-by-step storyboard (no autoplay, no CSS motion, same content).
- `packages/web/src/components/tour/TourOffer.tsx` -- the first-visit GEOS dialog, remembered in
  `localStorage` (`outfitterTourOffered`, try/catch), exported standalone for later reuse.
- `packages/web/src/styles/tour.css` -- every tour/Manual-page style, including the
  `body.tour-chrome-off` rules the recorder uses (see below). Imported from `src/style.css` with
  one added `@import` line.
- `packages/web/src/pages/ManualPage.tsx` -- assembles the animation, glossary, task steps and
  error table; reads `?autoplay=1`/`?chrome=0` for the recorder.
- `packages/web/src/App.tsx` -- one new import and one new `<Route path="/manual" .../>` line.
- `packages/web/scripts/record-tour.mjs` -- the Playwright recorder (below).
- `packages/web/test/tour-timeline.test.ts`, `packages/web/test/glossary.test.ts` -- unit tests.
- `docs/glossary.md` -- plain-markdown copy of the glossary/task-steps/error-table for GitHub.
- `docs/design/tour.webm` (and `tour.gif` if ffmpeg was available) -- the recorded tour.
- `docs/design/screenshots/manual-*.png` -- a handful of reviewed screenshots (see below).

## The animation

Nine scenes, pure SVG/CSS/React, no video files and no new heavy runtime dependency:

1. **Opening** -- flickering C64 border stripes, "PRESS PLAY ON TAPE ... LOADING".
2. **Kernal** -- a pixel CPU/ROM chip character with blinking eyes and a cursor "mouth", "READY."
3. **Tapes** -- a cassette labelled with a model name clicks into a deck.
4. **Floppies** -- a 5.25" floppy labelled "Fix login bug" slides out of the Disk Box.
5. **Drives** -- the floppy goes into a drive inside a small cloud; the drive light blinks, the
   disk spins, and the Kernal chip's output scrolls. If the user has turned the header's floppy
   sound on (`src/lib/floppy-sound.ts`, off by default), this scene also plays a ~1.4s burst of it
   via the existing `playFloppyAfterDelay()` helper -- it never autoplays sound on its own.
6. **Disk Box** -- the floppy returns among others, some marked stopped; a Play badge spins one up.
7. **Eject** -- the floppy flies to a laptop; a terminal shows `$ kernal --teleport 01a0bb9f`.
8. **Peripherals / Dongles / Control Panel** -- a three-beat pan across a modem, a hardware-key
   dongle, and a padlocked control panel marked "(Sysop only)".
9. **Closing** -- "READY." plus "Start a new floppy" (`/`) and "Replay".

Total runtime is ~75s (`totalDurationMs()` in `tour-timeline.ts`, unit tested to stay in a
70-80s band). Every caption/meaning line is real, always-rendered text with `aria-live="polite"`,
so the story holds up with the animation off. Under `prefers-reduced-motion`, `TourAnimation`
renders the same nine scenes as a static storyboard stepped with Previous/Next -- no autoplay, no
CSS animation (`tour.css`'s `@media (prefers-reduced-motion: reduce)` block also hard-disables
every keyframe as a second line of defence). Controls are plain, keyboard-reachable
`<button>`s; the progress bar is a `role="tablist"` of clickable segments that jump to a scene.

## How to replay / re-record

In-app: visit `/manual` (or click "Take the tour" from the first-visit offer). `?autoplay=1`
starts playback immediately; `?chrome=0` hides everything but the monitor (toggled via a
`body.tour-chrome-off` class set by `ManualPage.tsx`, styled entirely in `tour.css` -- no changes
to `App.tsx`'s layout needed).

To re-record `docs/design/tour.webm` (and `tour.gif`, if `ffmpeg` is on `PATH`):

```sh
cd outfitter
npm run build --workspaces --if-present   # web dist/ + agentd dist/ + provider-local dist/
cd packages/api
MONGODB_URI=memory OUTFITTER_DEV=1 SANDBOX_PROVIDER=inprocess \
  AGENTD_MAIN=$PWD/../agentd/dist/src/main.js OUTFITTER_ROLE=all PORT=8097 \
  OUTFITTER_ORIGIN=http://localhost:8097 node src/main.ts &

cd ../web
npm run record-tour -- --url http://localhost:8097
# or: node scripts/record-tour.mjs --url http://localhost:8097 [--out ../../docs/design]
```

The script (`packages/web/scripts/record-tour.mjs`) uses `playwright-core` (added as a
devDependency, pinned to `1.57.0` to match the screenshot commands used below) against the
**system** Chrome via `channel: "chrome"` -- it never downloads a bundled browser. It opens
`/manual?autoplay=1&chrome=0` at 1280x720 with `recordVideo`, waits for the closing "READY."
caption (capped at 95s), writes `docs/design/tour.webm`, and if `ffmpeg` is found on `PATH` also
renders an optimised 640px-wide `docs/design/tour.gif` via a two-pass palette
(`palettegen`/`paletteuse`).

This machine had `ffmpeg` available (Homebrew, `/opt/homebrew/bin/ffmpeg`), so both `tour.webm` and
`tour.gif` were generated and committed.

## Screenshots

Reviewed and committed to `docs/design/screenshots/`:

- `manual-mobile-dark.png`, `manual-mobile-light.png` -- 390x844, both themes. No horizontal
  overflow (`document.body.scrollWidth <= window.innerWidth` checked directly in the browser);
  the glossary table becomes stacked cards below 640px per the brief.
- `manual-desktop-dark.png`, `manual-desktop-light.png` -- 1280x860, both themes. Glossary renders
  as a `table.data-table` wrapped in `.table-scroll`; error table and task-steps panels match the
  existing `.panel`/`.panel-titlebar` chrome from `docs/design/README.md`.

Captured with `npx -y playwright@1.57.0 screenshot -b chromium --channel=chrome --viewport-size=...
--color-scheme=... --wait-for-timeout 1200 --full-page http://localhost:8097/manual <file>` against
the same locally running API described above (rebuilt after each source change). The
`--wait-for-timeout` flag matters here: without it the CLI screenshots before React finishes its
first paint and captures a mostly-blank frame -- not a real bug, just a CLI timing quirk, worth
noting for whoever reruns this.

Spot-checked interactively in the browser (Kernal, Floppies, Disk Box scenes advancing correctly
via Next/progress-segment clicks; the "READY." chip face and blinking cursor render as designed in
both themes).

## Tests

`packages/web/test/tour-timeline.test.ts` (13 tests): total duration in a 70-80s band, every scene
has a non-empty caption/meaning/duration, `sceneAtTime` resolves correctly at 0, mid-scene, exact
boundaries, past the end (clamped + `done`), negative time (clamped to start),
next/previous/clamp behaviour at both ends, and a reduced-motion "step through every scene exactly
once" walk.

`packages/web/test/glossary.test.ts` (6 tests): every glossary term has a non-empty
label/meaning/codeName/glyph, no duplicate term or error ids, all 14 required terms from the brief
are present, every error message has a message and meaning, and there are exactly 5 typical-task
steps.

`cd outfitter && npm ci && npm test --workspace=@outfitter/web && npm run build` -- all green
(91 tests across 10 files; typecheck + `vite build` clean; the pre-existing 5-package build via
`npm run build --workspaces --if-present` also verified clean, needed to stand up the API for
screenshots/recording).

## What's left

- The first-visit `TourOffer` is mounted on `/manual` itself for now, per the brief ("mount it on
  the Manual page itself for now"). Once the desk/GEOS entry page lands from the concurrent agent,
  it should mount `TourOffer` there instead (it's already exported standalone with a `tourPath`
  prop) so new users see the offer before ever opening the Manual.
- `src/lib/glossary.ts` has a note for reading labels/meanings from `src/lib/vocabulary.ts` once
  that module exists on this branch -- it doesn't yet, so nothing imports it.
- No nav link to `/manual` was added to the header (`App.tsx` was limited to the one route line);
  the desk's Manual icon (mentioned in the brief) is presumably the intended entry point once that
  page lands.
- The Manual page's own panel styling (`.manual-page .panel-title`/`.panel` border tweaks) lives in
  `tour.css` since that was the only new stylesheet permitted -- if `pages.css` grows a general
  "stacked panels" pattern later, this could move there instead.
