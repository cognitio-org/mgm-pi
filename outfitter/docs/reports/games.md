# Outfitter easter-egg games: KERNAL GAMES

Built on top of the Dreadnought Run prototype from `docs/reports/easter-egg-research.md`. That
report still holds for licensing rationale and trigger choice (Konami code + `/ready`); this one
covers what changed and what was added: a "KERNAL GAMES" launcher menu, a full Floppy Rescue
(Choplifter-inspired) game, and a polish pass on Dreadnought Run.

## What's there

### 1. KERNAL GAMES menu (`src/easter/menu/`)

Opening the easter egg with no game pre-selected (`openEasterEgg()`, the Konami code, or `/ready`
with no `?game=`) shows a GEOS-style dialog, "KERNAL GAMES", with two cartridge tiles (Floppy
Rescue, Dreadnought Run), each showing its persisted high score. `openEasterEgg("rescue" |
"dreadnought")` skips it and drops straight into that game (`EasterEggRoot.tsx`'s `initialGame`).

- Keyboard: Arrow keys/Tab move focus and wrap, Shift+Tab moves backward, Enter/Space loads the
  focused cartridge, Escape closes. Pure logic in `menu/menuNav.ts` (`handleMenuKey`), unit tested
  in `test/easter-menu-nav.test.ts` (7 cases) so the navigation rules don't need a DOM to verify.
- Touch/click: each tile is a real `<button>`, tap/click loads it directly.
- The menu is wrapped in the same `.easter-overlay`/`.easter-frame` modal chrome the games use
  (full-screen dim backdrop, centered frame) -- this was missing in an early pass (see "What broke
  and got fixed" below) and is now consistent everywhere.
- Escape/close-box inside a game always returns to this menu first; a second Escape/close from the
  menu itself exits the whole easter egg back to the app, per the brief's "exit back to the menu
  then the app."

### 2. Floppy Rescue (`src/easter/rescue/`) -- the main game

Inspired by Choplifter, not a copy: no shared names, sprites, sounds, or level layout. Fly a pixel
helicopter from the Disk Box (home pad, left) out over a scrolling landscape to a burning server
farm (right), land next to it, let little Floppy characters board (capacity 8), fly them home and
land to unload for score.

**Flight feel / physics** (`engine.ts`, all hand-rolled, no engine dependency) -- pure
`(state, input, dtMs) -> state`, unit tested in `test/rescue-engine.test.ts` (23 cases: physics,
landing rules, pickup/capacity, fire spread, scoring, level progression, attract-mode autopilot).
Tuning constants, documented inline and here for reference:

| Constant | Value | What it does |
|---|---|---|
| `GRAVITY` | 260 px/s² | constant downward pull |
| `THRUST_ACCEL` | 560 px/s² | "up" input; comfortably beats gravity so climbing feels responsive |
| `DOWN_ACCEL` | 160 px/s² | "down" input; gravity does most of the descent work |
| `H_ACCEL` | 420 px/s² | lateral thrust |
| `H_DRAG` | 2.4 /s | exponential damping on `vx` with no lateral input |
| `V_DRAG` | 0.5 /s | mild damping on `vy` so hovering settles instead of oscillating |
| `MAX_VX` / `MAX_VY` | 230 px/s | velocity caps |
| `LANDING_SAFE_VY` | 78 px/s | touch down slower than this or it's a crash |
| fuel drain / refill | 3.0/s airborne, 34/s on home pad | route-planning tension: dry fuel kills lift |
| `BOARD_INTERVAL_MS` | 420 | one Floppy boards per interval, landed at the farm, under capacity |
| scoring | 100/Floppy, +400 full-load (8) bonus | |
| fire | grows 0.16/s, ignites a neighbour past 0.55 intensity | a fully-lit cell kills any Floppy standing in it |

These were hand-picked for "thrust, gravity, momentum, tilt, gentle-landing-required" without a
human playtester in the loop (this was built end-to-end by an agent); they pass every physics/
landing test and read correctly in the recorded attract-mode clip, but a human pass to nudge feel
(particularly `THRUST_ACCEL`/`H_ACCEL` responsiveness) would be the natural next step.

**Levels**: level 1 starts with 6 Floppies and no drone; each level adds 2 more Floppies (capped at
16), a faster-spreading fire, more frequent falling debris, and from level 2 a patrolling "glitch"
drone that fires aimed shots (`Drone` in `engine.ts`). A level ends (advancing with score/lives/fuel
carried over) once every Floppy is either delivered or lost to fire and nobody's onboard -- so a
level can't soft-lock even if fire wipes out the whole pool before you reach it.

**Rendering** (`FloppyRescue.tsx` + `sprites.ts`): hand-drawn pixel-art sprites (helicopter that
tilts with horizontal velocity, rack units, flame frames, Floppy walkers, the drone) on a two-layer
parallax landscape; a title screen with a pure, unit-tested `attractInput()` autopilot flying a
demo loop behind it; level intro cards ("LEVEL 2: THE SERVER FARM IS SPREADING"); a "READY." game
over screen with a blinking cursor; a fuel meter reusing the app's existing `.meter` component
class (warn/danger thresholds); rotor-chop/board/deliver/crash/floppy-lost Web Audio synthesis
(`sound.ts`, same approach as `src/lib/floppy-sound.ts`) gated by the app's sound toggle.

**Controls**: keyboard arrows/WASD; touch = a left-thumb virtual stick (drag, 8-directional, with a
deadzone) plus a LIFT button; Gamepad API (left stick/d-pad + a face button doubling as LIFT, start
button pauses).

### 3. Dreadnought Run polish (`src/easter/dreadnought/`)

Kept the prototype's rules (scroll speed ramps with distance, rack/turret obstacles, bullet
collisions, pickups) and replaced the placeholder triangle-and-grid rendering:

- Hand-drawn pixel-art sprites (`sprites.ts`): ship (with a damaged/invulnerable palette swap),
  rack units (tiled to fill variable-height racks), turret (damaged palette past one hit), and a
  **new enemy type**, a "drone" that sine-sweeps vertically and fires on its own cooldown, unlocked
  past 900px of distance so the first stretch of a run stays just racks + turrets.
- A three-layer parallax hull backdrop (`drawParallaxHull`) instead of one flat scrolling grid.
- Explosion particles + a small screen shake on kills/hits (`shared/particles.ts`), skipped under
  `prefers-reduced-motion`.
- A title/attract screen driven by a pure `attractInput(t)` autopilot (a slow figure-eight weave
  with occasional firing).
- A pause button next to the close box, alongside the existing `P` key.
- Gamepad API support (same shared helper as Floppy Rescue).

`engine.ts` now emits typed `GameEvent`s (`obstacleDestroyed`, `playerHit`) so the renderer reacts
to hits/kills directly instead of re-deriving them from before/after diffs.

## Shared infrastructure (`src/easter/shared/`)

- `highscore.ts` -- per-game localStorage key (`GameId: "rescue" | "dreadnought"`), try/catch
  wrapped like the app's existing `floppy-sound.ts`/`ThemeToggle.tsx` persistence. Dreadnought kept
  its original key (`outfitterEasterHighScore`) so existing high scores from the prototype survive.
- `motion.ts` -- `prefers-reduced-motion` detection, shared by both games' calm-mode notice.
- `gamepad.ts` -- minimal Gamepad API polling (`readGamepadDirection`/`readGamepadButtons`), no
  event model beyond what the browser exposes (it's poll-only).
- `fixedStep.ts` -- the fixed-timestep loop (`useFixedStepLoop`, 60Hz target with a capped
  catch-up accumulator) both games drive their simulation with. Tears the whole `requestAnimationFrame`
  loop down (not just skips ticks) on `visibilitychange` -> hidden, and restarts it on -> visible,
  so a backgrounded tab burns zero CPU on either game.
- `particles.ts` -- explosion particles + screen-shake state, deliberately kept outside the pure
  engines since it's a rendering flourish, not game logic.
- `pixelSprite.ts` -- draws a small character-grid "sprite" (one `fillRect` per cell) at a given
  scale; both games' `sprites.ts` files are just data (arrays of strings + a palette) consumed by
  this one renderer.

## Respecting the shared constraints

- **Pause**: `P` and an on-screen pause button in both games; `togglePause` in each engine.
- **Escape/close box**: exits back to the menu, then the app (see menu section above).
- **High scores**: per game, localStorage, try/catch (`shared/highscore.ts`).
- **`prefers-reduced-motion`**: a "calmer mode" opt-in notice before play in both games (matching
  the prototype's existing approach); once acknowledged, screen shake and explosion particles are
  skipped, the scrolling backdrop/parallax stops scrolling, and invulnerability shows as a steady
  highlight instead of a blink.
- **Both themes**: everything reuses `theme.css` tokens via the existing `.easter-*` classes (see
  screenshots below in both GEOS light and C64 dark).
- **390×844 and 1280×860**: `.easter-canvas` is `width:100%; height:auto; aspect-ratio:800/440`, so
  the frame scales down to fit a phone-width viewport; verified in the mobile screenshots below.
- **60fps target, fixed-timestep, pauses when hidden**: `shared/fixedStep.ts`, used by both games.
- **Code-split**: nothing under `src/easter/` is imported eagerly from `App.tsx` except the Konami
  listener and the `/ready` route wiring (a few bytes). Each game is its own `React.lazy` chunk, so
  picking one from the menu never fetches the other's code.

## Chunk sizes

```
dist/assets/pixelSprite-BmD15YtP.js     2.47 kB  gzip:  1.14 kB   (shared sprite renderer)
dist/assets/EasterEggRoot-CNVUK-ER.js   3.50 kB  gzip:  1.59 kB   (menu + router shell)
dist/assets/DreadnoughtRun-CeeeJwAX.js 12.91 kB  gzip:  4.91 kB
dist/assets/FloppyRescue-Evo0wOH5.js   18.12 kB  gzip:  7.02 kB
```

Total lazy-loaded gzip: **14.66 kB**, well under the ~60 kB budget. The main bundle
(`dist/assets/index-*.js`, 468.57 kB / 145.22 kB gzip) is unchanged in shape from before this work
-- none of `src/easter/` reaches it.

## Tests

```
$ cd outfitter && npm ci && npm test --workspace=@outfitter/web && npm run build
...
 Test Files  11 passed (11)
      Tests  120 passed (120)
```

New/changed test files:
- `test/rescue-engine.test.ts` -- 23 cases: physics (thrust/gravity/momentum/tilt), landing rules
  (safe vs. crash), pickup/capacity, fire spread, scoring, level progression, attract-mode autopilot.
- `test/dreadnought-engine.test.ts` (renamed from `easter-engine.test.ts`) -- 18 cases: the original
  14 plus drone spawn/sine-sweep, `GameEvent` emission, and `attractInput` determinism.
- `test/easter-menu-nav.test.ts` -- 7 cases covering the menu's keyboard navigation logic.

`npm run build` passes clean (`tsc --noEmit` across the monorepo, `vite build` clean).

## Screenshots

All in `docs/design/screenshots/games-*.png`, taken against a local `packages/api` server
(`OUTFITTER_DEV=1`, in-process sandbox) with
`npx -y playwright@1.57.0 screenshot -b chromium --channel=chrome ...`:

- `games-menu-{desktop,mobile}-{dark,light}.png` -- the KERNAL GAMES menu, `/ready`.
- `games-rescue-title-{desktop,mobile}-{dark,light}.png` -- Floppy Rescue's title/attract screen,
  `/ready?game=rescue`.
- `games-rescue-mid-{desktop,mobile}-{dark,light}.png` -- mid-game action, `/ready?game=rescue&demo=1`
  (the attract-mode autopilot keeps flying past the title screen so a headless screenshot shows
  real gameplay -- HUD, fuel meter, helicopter in flight).
- `games-dreadnought-title-{desktop,mobile}-{dark,light}.png` -- Dreadnought Run's title/attract
  screen, `/ready?game=dreadnought`.
- `games-dreadnought-mid-{desktop,mobile}-{dark,light}.png` -- mid-game action,
  `/ready?game=dreadnought&demo=1`.

`docs/design/floppy-rescue.webm` -- a ~21s recording of Floppy Rescue's title-screen attract mode
(Playwright `recordVideo`, system Chrome via `channel: "chrome"`, 1280×860, no browser download;
`playwright` was installed with `--no-save` for the one-off recording script and removed
afterward -- it's not a project dependency).

As documented in the original prototype report, Playwright's `screenshot` CLI emulates viewport
size only, not touch/coarse-pointer input, so the on-screen touch controls (virtual stick, LIFT/
FIRE/UP/DOWN buttons, which key off `pointer: fine`/`hover: hover`) don't appear in the mobile
screenshots even at phone width -- they render correctly on an actual touch device.

## What broke and got fixed along the way

- **Menu had no modal chrome.** The first screenshot pass showed `GameMenu` laid out inline at the
  top of the page with no dimmed backdrop -- it wasn't wrapped in the `.easter-overlay`/
  `.easter-frame` treatment both games use. Fixed in the second commit; menu now centers as a
  proper full-screen modal in both themes/sizes (see screenshots).
- **`?demo=1` only drove the title screen.** Initially the attract-mode autopilot stopped as soon
  as `startGame()` fired, leaving an idle, unpiloted ship for "mid-game" screenshots. Extended it so
  `?demo=1` keeps the same `attractInput` autopilot flying during real "game" state too.
- **Stale-server race, not a code bug**: partway through screenshotting, every `.js` asset 404'd
  from the local `packages/api` server while `.css`/fonts kept working. Root cause was simply that
  the dev API process had been started a moment before a `vite build` finished writing its final
  JS chunk, so `@fastify/static`'s directory scan raced the filesystem write; a clean restart after
  the build fixed it immediately. Not a regression in this branch's code -- noted here in case
  anyone hits the same "assets suddenly 404" symptom against a hot-reloaded local API.

## What's left

- **Human playtesting pass on Floppy Rescue's flight feel.** The constants above pass every
  physics/landing test and look right in the recorded clip, but only a human hand on the keyboard
  can say whether `THRUST_ACCEL`/`H_ACCEL` want to be a little snappier or floatier.
- **Global/shared high scores** are out of scope per the brief (localStorage only); a natural next
  step if this becomes a permanent feature.
- **`SYS 64738` / composer-triggered entry points**, per the original research report: still
  deferred until the header/composer rework in flight lands with a stable place to add them.
- **A second Dreadnought Run mini-boss / spread-shot turret variant** for even more late-run
  variety -- the brief only asked for "one more enemy type" (the drone), which is done.
- **Desk trigger wiring**: `openEasterEgg(game?: "rescue" | "dreadnought")` is the stable entry
  point the desk UI (owned by another workstream) can call once it's ready to add its own trigger
  surface (a hidden menu item, a `SYS 64738` command, etc.) beyond the existing Konami code and
  `/ready` route.
