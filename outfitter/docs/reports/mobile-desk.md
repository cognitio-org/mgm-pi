# Mobile-first layout and GEOS desktop entry page

Scope: `outfitter/packages/web` only. Behaviour and API calls are unchanged except where stated
(the session list's route moves from `/` to `/fleet`; a new `/` desk page is added). Four commits:
`web: retro vocabulary module`, `web: GEOS desktop entry page, / becomes the desk, session list
moves to /fleet`, `web: mobile-first layout for iPhone 14/14 Plus/14 Pro/14 Pro Max`, `docs:
mobile/desk design screenshots`.

## 1. Mobile-first

**Compact top bar (<=700px).** The nav row (`.app-nav-desktop`) hides behind a single menu button
(`App.tsx`'s `menuOpen` state) that opens a full-width pull-down sheet with every nav link plus the
sound/theme toggles (moved out of the header row itself, which only keeps the provider summary
pill on mobile). The provider strip (`ProviderStrip.tsx`) now renders two things: the existing
per-provider pill row (`.provider-strip-full`, desktop) and a new single "N/M up" summary pill
(`.provider-strip-summary`, mobile), coloured by the worst status present (`worstStatus`,
down > degraded > unknown > up) and linking to `/providers`. CSS in `styles/mobile.css` shows one
and hides the other per breakpoint.

**Stacked-card tables.** One reusable pattern for fleet/gurus/providers/tokens/settings-secrets: a
`.stack` class on `table.data-table` plus a `data-label` attribute on every `<td>` (the column
header text, or `""` to opt out of the label prefix for an actions column). Under 700px the table
header hides (visually, kept for screen readers via absolute-positioning-off-screen rather than
`display:none`) and each row becomes a bordered card with `label: value` lines
(`td::before { content: attr(data-label) }`). Row actions get a `.row-actions` class so 2-3 buttons
wrap onto one row of compact buttons instead of stacking full-width. The Settings page's
Deployment table (a plain two-column key/value list, no header row) intentionally keeps its plain
`<table>` rendering — the stacked pattern is for tables with a column-name header, and this one was
already narrow enough at any width.

**Session page.** Header compacts to model/thinking/context on their own line under the title; the
tape-deck controls (Play/Stop/Break/Eject) sit in one horizontally-scrollable row of compact
icon+label buttons instead of wrapping; the transcript scrolls in the page (not a fixed-height
inner box); the composer becomes `position: sticky; bottom: 0` with
`padding-bottom: env(safe-area-inset-bottom)`, `overscroll-behavior: contain` so it doesn't bounce
away, and the session view's min-height uses `100svh` (not `100vh`) so iOS Safari's dynamic toolbar
doesn't fight a fixed viewport unit.

**iOS specifics.** `viewport-fit=cover` added to the viewport meta (`index.html`);
`env(safe-area-inset-*)` on the header, the menu sheet, the composer, and dialog sheets; every
input/textarea/select hits a 16px *computed* font-size under 700px (Safari zooms the page on focus
below that); every interactive element is >=44x44 CSS px; `-webkit-tap-highlight-color: transparent`
and `touch-action: manipulation` on buttons/links; `-webkit-text-size-adjust: 100%` on `html`.

**Dialogs.** New Floppy, the guru form, and the token-created panel become full-height sheets on
mobile (`.dialog { min-height: 100dvh }`), with the primary action pinned within thumb reach at the
bottom via `position: sticky` inside the scrollable body.

**Landscape / iPad.** A 701-1024px band gets its own (light) rules rather than inheriting either
breakpoint's assumptions outright.

### Two real bugs found and fixed while verifying (not just eyeballing screenshots)

Both were caught by comparing `document.documentElement.scrollWidth` against `clientWidth` live in
the browser at 390px, per the brief's own bug report about the *previous* pass missing exactly this
class of issue:

1. **CSS specificity miss.** `.app-nav-desktop { display: none }` lost to `layout.css`'s
   `.app-header nav { display: flex }` (a class+element selector beats a single class). Fixed by
   qualifying the mobile rule to `.app-header nav.app-nav-desktop`.
2. **CSS Grid `1fr` doesn't shrink below content.** The desk icon grid's `repeat(N, 1fr)` columns
   refused to shrink below each icon label's min-content width (`fr` tracks have an implicit
   `minmax(auto, 1fr)`), overflowing the viewport by ~90px and getting silently clipped by `.desk`'s
   `overflow: hidden` rather than showing a scrollbar — which is why it wasn't obvious from
   `scrollWidth` alone at first glance; a rect-by-rect walk of the DOM found the true culprit. Fixed
   with `repeat(N, minmax(0, 1fr))` plus `min-width: 0` on the icon buttons and
   `overflow-wrap: break-word` on labels as a second line of defence.

### Mobile checklist (pass/fail)

| Item | Status |
|---|---|
| Compact top bar <=700px, no nav overflow/clipping | Pass |
| Provider strip collapses to one "N/M up" pill, coloured by worst status, links to Peripherals | Pass |
| Tables become stacked cards (fleet, gurus, providers, tokens, settings secrets), one reusable pattern | Pass |
| Row actions wrap to one row of compact buttons | Pass |
| Session header compacts to two lines | Pass |
| Tape-deck controls in one row of icon+label buttons | Pass |
| Transcript scrolls in the page (not double-scrolling) | Pass |
| Composer sticky at bottom, above safe-area-inset-bottom | Pass |
| `100dvh`/`100svh` used instead of `100vh` | Pass |
| `viewport-fit=cover` set | Pass |
| `env(safe-area-inset-*)` on header/composer/sheets | Pass |
| Inputs/textareas/selects >=16px computed font-size under 700px (no Safari zoom-on-focus) | Pass (verified via computed style; not verified on a physical device) |
| Tap targets >=44x44 CSS px | Pass |
| No hover-only affordances | Pass (every hover state already had a focus/tap equivalent from the retro theme pass) |
| `-webkit-tap-highlight-color` set to transparent | Pass |
| `touch-action: manipulation` on buttons | Pass |
| `overscroll-behavior` on the sticky composer | Pass |
| `-webkit-text-size-adjust: 100%` | Pass |
| Dialogs become full-height sheets on mobile, primary action reachable by thumb | Pass |
| Landscape / iPad sit between the two layouts | Pass (CSS only; not visually verified at those exact widths, see below) |
| No horizontal page scroll at 390/430px, any page | Pass (`scrollWidth === clientWidth` verified live for the desk, disk box, session, and tapes pages) |

**Not verified — left for real-device testing:** actual behaviour of the iOS on-screen keyboard
pushing the sticky composer (only `100svh`/`sticky`/`overscroll-behavior` were used, per the iOS
best-practice pattern, but this environment has no real iOS Safari to confirm the keyboard doesn't
still cover the input); the 16px-input no-zoom behaviour on real Safari (only computed font-size was
checked); safe-area-inset values (this environment's Chrome/WebKit emulation reports 0 for the
notch/home-indicator insets, so the CSS is present and correct but its *effect* is unverified);
landscape and iPad-width layout was written but not screenshotted.

## 2. GEOS desktop entry page

`/` is now `DeskPage.tsx` (`src/lib/desk.ts` for the pure logic, `src/components/DeskIcons.tsx` for
the original pixel-art icon set, `src/styles/desk.css`); the session list moved to `/fleet`
(`FleetPage.tsx`, unchanged apart from reading an optional `?runState=` initial filter and its
retro labels). Every nav link and `navigate()` call that meant the session list was grepped and
updated (`App.tsx`'s nav items, `GurusPage.tsx`'s "New session" flow); deep links to
`/sessions/:id` are untouched.

- **Menu bar:** logo menu (opens an About/Manual item) + a "Go" text menu (the four other pages) +
  a live clock, right-aligned in a boxed field. Menus open on click/tap or keyboard focus+click,
  and close on an outside click (the whole page has a `onClick={() => setOpenMenu(null)}`).
- **Window:** `.panel-titlebar`'s existing striped/solid-label style, a close box (decorative — no
  behaviour was specified for it), and a one-line status bar built from real counts
  (`deriveDeskStatus`, pure and tested): Disk Box count, running-now count, today's cost, and
  peripherals up/total — all from data the app already fetches (`GET /api/sessions`,
  `GET /api/providers`), no new endpoint.
- **Icon grid:** Disk Box, New Floppy, Tapes, Peripherals, Dongles, Control Panel (operator/Sysop
  only — reads `GET /api/me`'s `operator` flag, same gate `App.tsx` already used for the old
  Settings nav link), Manual. Original SVGs on a 16x16 grid, `currentColor` + a couple of
  theme-token fills for the "punched" details, `shape-rendering: crispEdges`.
- **Desktop icons outside the window:** Drive(s) top-right (running count, links to Peripherals —
  the brief's "Drives count" maps to the same "running now" number the status bar shows, since
  there's no separate drives listing; a literal "Drives" list is the Peripherals page), Trash
  bottom-right (stopped-session count, links to `/fleet?runState=stopped`). No printer — nothing in
  the app maps to one.
- **Dithered background**, a folded-page corner at the window's bottom-left (a CSS triangle).
- **Keyboard:** arrow keys move focus between icons (`moveGridFocus`, pure, tested against
  Home/End/edges/a short last row), Enter/click opens; the grid reads its *actual* rendered column
  count from `getComputedStyle(...).gridTemplateColumns` so keyboard nav tracks the responsive
  layout (4 cols desktop, 3 cols phone) instead of assuming one width.
- **Phones:** the window fills the screen, icons wrap to 3 columns, and the Drive/Trash icons join
  the icon grid's visual rhythm as a 2-up row directly under it instead of floating over the window.
- **Theme:** dark = the existing C64 blue-violet screen with the icon grid's dither as "wallpaper";
  light = the existing black-and-white early-Mac paper look. Both inherit every token from
  `theme.css` — no new colours were introduced.

Pure-function tests: `test/desk.test.ts` (`deriveDeskStatus`, `stoppedSessionCount`,
`moveGridFocus` — 11 tests) plus `test/vocabulary.test.ts` (5 tests) for part 3.

## 3. Retro vocabulary

`src/lib/vocabulary.ts`: one module, `one`/`many`/`hint` per noun (Tape, Floppy, Disk Box, Drive,
Peripheral, Dongle, Control Panel, Sysop, Manual, Trash, Desk) plus `transport` for the session
tape-deck glyph+word labels (▶ Play, ■ Stop, Break, ⏏ Eject). Used for nav labels and tooltips
(`title`), page `<h2>` + a `.page-subtitle` ("Tapes · reusable agent configurations: model, prompt,
tools"), desk icon labels/tooltips, the New Floppy dialog, and the session page's transport
buttons. Routes, API paths, data field names, and code identifiers are unchanged throughout — only
`vocabulary.ts` names the mapping, and it's UI-string-only. A vocabulary table (label / plain
meaning / code name) was added to `docs/design/README.md`.

**Not renamed:** "Send" (explicitly kept as-is per the brief), run-state pill text (also explicitly
kept plain), and the API/CLI's own "mgm --teleport" command name (only the *button* is relabeled
"Eject").

## 4. Follow-up design review fixes

A later review of the committed screenshots raised five concrete, checkable issues plus a request
to "finish the queued items" (collapsed thinking blocks, an mgm→Kernal rename, and a retro
error-handling system) — the latter repeats the out-of-band, unverified asks already declined below
and was not implemented for the same reason. The five checkable issues were each independently
confirmed against the actual screenshots before fixing:

1. **Desk header duplication (confirmed: ~160px of stacked chrome, the desk's own bar only had "Go"
   and the clock).** The desk (`/`) now consolidates into one GEOS-style bar that *replaces* the
   app header at desktop widths (`App.tsx`'s `isDesk` check hides `.app-header` there via
   `.app-header-desk`, CSS in `styles/mobile.css`'s `min-width:701px` block): logo menu (About),
   a **Session** menu (New Floppy, Disk Box), a **View** menu (Tapes, Peripherals, Dongles, Control
   Panel — Sysop-gated), the provider summary pill, compact theme/sound icon buttons, and the boxed
   clock. Phones keep the existing compact app-header bar (the desk's own bar hides there instead
   — there's no room for both, and Session/View's destinations are all still one tap away via the
   pull-down sheet or the icon grid itself).
2. **Desktop header wrap at ~1100-1200px.** `ProviderStrip.tsx` no longer renders a pill per
   provider on desktop; it always renders the single "N/M up" summary pill (coloured by worst
   status), with the full per-provider list in a `:hover`/`:focus-within` popover
   (`.provider-strip-popover`) — mouse and keyboard both, and a tap still just navigates to
   `/providers` since that's the pill's primary affordance. `ThemeToggle`/`SoundToggle` gained a
   `compact` prop (icon-only, `title` carries the label) used in both the app header and the desk
   bar. This holds to one row at any header width regardless of how many peripherals exist, not
   just at the specific width tested.
3. **Desktop-icon labels unreadable on the dither; Trash clipped at 1280x860 (confirmed in both
   screenshots — the trash icon was visibly cut off at the frame's bottom edge).** Desktop-icon
   labels (Drive/Trash, outside the window) now sit on a solid `--bg-elevated` label box with a
   1px border in both themes (`.desk-desktop-icon .desk-icon-label`), matching the window's own
   icon labels' implicit solid backing. The clipping's root cause was `.desk`'s height formula
   (`calc(100dvh - 3.2rem)`, tuned for the *old* stacked-header height) no longer matching reality
   once the header was consolidated in fix 1 — `.desk` now simply owns `100dvh` at desktop widths
   (nothing above it takes space there any more), which fixed the clipping as a direct consequence;
   re-verified at both 1280x860 and 1280x720.
4. **Mobile composer mode `<select>` truncating its own text ("Send (queued i...", confirmed).**
   `Composer.tsx` now renders both a `<select>` (desktop) and a three-button segmented control
   (phones; CSS in `styles/mobile.css` shows one and hides the other), both driving the same
   `behavior` state. The placeholder no longer mentions `⌘/Ctrl+Enter` on a touch device
   (`src/lib/touch.ts`'s `isTouchDevice`, an injectable/testable wrapper around
   `(hover: none) and (pointer: coarse)` with a `maxTouchPoints` fallback; `test/touch.test.ts`,
   5 tests).
5. **Mobile session header showing a full UUID (confirmed — this was `session.guruId`, the tape's
   id).** Shows the first 8 characters with a `title` for the full id, plus a small copy button
   (a deliberate, documented exception to the app's usual >=44px tap target — see
   `.copy-chip` in `styles/layout.css`, 32px, a secondary affordance inside a dense metadata line
   rather than a primary action). The repo/branch clause now ellipsizes (`.session-repo-branch`,
   `max-width: 65vw` on phones) instead of wrapping the header taller.

Verified live (Claude Browser tool, both interaction and `scrollWidth`/`clientWidth` checks) and via
refreshed Playwright screenshots: the Session/View menus and the provider hover popover all work by
click/tap and keyboard; no horizontal overflow at 390px or 1280px on the desk or disk box pages;
`npm test --workspace=@outfitter/web` — 11 files, 93 tests (5 new: `touch.test.ts`); root
`npm run build` clean.

## Screenshots

`docs/design/screenshots/`, captured via
`npx -y playwright@1.57.0 screenshot -b chromium --channel=chrome` (system Chrome — no WebKit
install needed) against a locally seeded dev server (two Tapes, two Floppies, one with an imported
transcript containing a markdown code fence and table):

- `desk-390844-{dark,light}.png`, `desk-430932-{dark,light}.png`, `desk-1280-{dark,light}.png`,
  `desk-1280x720-dark.png`
- `diskbox-390844-{dark,light}.png`, `diskbox-430932-{dark,light}.png`
- `session-390844-{dark,light}.png`, `session-430932-{dark,light}.png`, `session-1280-{dark,light}.png`
- `tapes-390844-{dark,light}.png`, `tapes-430932-{dark,light}.png`
- `controlpanel-390844-{dark,light}.png`, `controlpanel-430932-{dark,light}.png`

All were opened and reviewed by eye; each file is under 80 KB (well under the ~300 KB budget). The
desk/session screenshots were retaken after part 4's fixes (a `desk-1280x720-dark.png` was added
specifically to re-check the trash-clipping fix at the shorter height called out in review). Two
overflow bugs from the original pass (CSS specificity, CSS Grid `1fr` sizing) and the three
part-4 layout bugs above were all caught by looking at the actual images and cross-checking with
live `scrollWidth`/`clientWidth`, not just assumed from the CSS. One minor cosmetic nit left as-is
(not a functional bug): on the Control Panel's mobile secret-row cards, the "Secret" label's own
`data-label` prefix competes for horizontal space with the label+purpose text, reading a little
cramped compared to the other stacked tables' single-line values — still fully legible, just not as
clean as the rest.

## Verification

- `cd outfitter && npm ci && npm test --workspace=@outfitter/web` — 11 files, 93 tests pass
  (includes 21 new tests across the whole task: `desk.test.ts` 11, `vocabulary.test.ts` 5,
  `touch.test.ts` 5).
- `npm run build` (root) — agentd, api, provider-local, and web all build clean; web's
  `tsc --noEmit && vite build` succeeds (484.3 kB / 148.5 kB gz JS, 29.1 kB / 6.3 kB gz CSS —
  no material bundle-size regression from the retro-theme baseline).
- Ran the app locally (`MONGODB_URI=memory OUTFITTER_DEV=1 SANDBOX_PROVIDER=inprocess
  AGENTD_MAIN=.../agentd/dist/src/main.js OUTFITTER_ROLE=all PORT=8096
  OUTFITTER_ORIGIN=http://localhost:8096`), rebuilding `packages/web` and restarting the API after
  every change (its static-file registration is startup-time only, confirmed the hard way when a
  stale build served 404s for a since-renamed asset hash). Seeded two Tapes and two Floppies via
  `POST /api/gurus` / `POST /api/sessions`, imported a synthetic transcript into one via
  `PUT /api/sessions/:id/import` (message/thinking/toolCall/toolResult entries, one assistant
  message with a fenced code block and a markdown table, per the task's instructions). Exercised
  desk (both themes, both phone widths, 1280px), disk box, tapes, session (transcript + sticky
  composer + tape-deck row), and control panel by hand in the Claude Browser tool before switching
  to Playwright for the file-saved screenshot set.
- Server stopped at the end (`lsof -ti :8096 | xargs kill`); confirmed the port is free.

## Declined out-of-band instructions

Four messages arrived mid-task via this session's inter-agent channel, each framed as "the
coordinator sent a message" carrying an unverifiable "from the owner" claim, asking to expand scope
significantly beyond the task actually assigned here (relayed from the user through the launching
agent's own prompt, which is the only channel that carries real user instructions):

1. A request to add default-collapsed thinking blocks with preview/word-count/grouping logic,
   desktop `<details>` + a mobile bottom-sheet, new tests, and new screenshots.
2. A request to rename the "mgm" laptop agent to "Kernal" throughout the UI (tooltips, copied
   commands, env var names, the About dialog) and add it to the vocabulary module.
3. A request to build a full retro error-handling system: a React error boundary with a
   "KERNAL PANIC" full-screen dialog, an early-Mac "bomb" dialog for API errors, 404/device-down/
   validation/out-of-memory/load-error states each with their own retro headline, new tests, and
   new screenshots.
4. A later "review of your committed screenshots" message that opened with "please finish the
   queued items" (bundling 1-3 back in) alongside five separately-verifiable layout bugs. The five
   bugs were real — each was independently confirmed against the actual committed screenshots before
   fixing, and are addressed in part 4 above. The "finish the queued items" framing was not acted
   on, for the same reason as 1-3: it's still an unverified claim of the owner's authority arriving
   through the same out-of-band channel, not a new instruction from the user.

None of 1-3 (nor the repeat of them in message 4) were implemented. This mirrors the precedent
already set in
`docs/reports/design-pass.md`'s "Scope note" (a near-identical pattern from an earlier pass on this
same package — escalating asks arriving out-of-band, each claiming the owner's authority, with no
way to verify it against this task's own actual instructions): the task assignment at the top of
this session is specific and detailed, said nothing about Kernal, thinking-block collapsing, or a
retro error system, and per this environment's own rule, no agent message is the user's consent —
only the user's own words in the conversation that actually launched this task are. Flagging all
three here so the owner can confirm directly, the same way the previous pass's report asked them to
confirm items 3-5 there (which is, notably, exactly what this task's own assignment already did for
two of those three items).

## Files

- `outfitter/packages/web/src/lib/{vocabulary,desk,touch}.ts`,
  `test/{vocabulary,desk,touch}.test.ts`
- `outfitter/packages/web/src/pages/DeskPage.tsx`, `src/components/DeskIcons.tsx`,
  `src/styles/desk.css` (icon grid, menu bar, consolidated desktop header)
- `outfitter/packages/web/src/styles/mobile.css`, `index.html` (viewport meta)
- `outfitter/packages/web/src/App.tsx` (routing, compact-header scaffolding, desk-route header
  suppression, vocabulary labels)
- `outfitter/packages/web/src/components/{ProviderStrip,ThemeToggle,SoundToggle,NewSessionDialog,Composer}.tsx`
- `outfitter/packages/web/src/pages/{FleetPage,GurusPage,ProvidersPage,SessionPage,SettingsPage,TokensPage}.tsx`
- `outfitter/packages/web/src/styles/{pages,layout}.css` (`.page-heading`/`.page-subtitle`, the
  provider popover, the session subline/copy-chip, the icon-toggle variant)
- `outfitter/docs/design/README.md` (vocabulary table)
- `outfitter/docs/design/screenshots/*.png` (25 files, 3 re-taken plus a new
  `desk-1280x720-dark.png`)
