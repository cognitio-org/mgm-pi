# Outfitter easter-egg games: KERNAL GAMES

Built on top of the Dreadnought Run prototype from `docs/reports/easter-egg-research.md`. That
report still holds for licensing rationale and trigger choice (Konami code + `/ready`); this one
covers what changed and what was added: a "KERNAL GAMES" launcher menu, a full Floppy Rescue
(Choplifter-inspired) game, and a polish pass on Dreadnought Run.

**Two build passes.** The first pass (commits `af8ed88`..`58da1ea`) got the menu, both games'
logic, and a visual style in place, but a design review of the resulting screenshots/clip found the
action read as "specks in an empty window" -- legible logic, illegible presentation. A second pass
(commits `0ce3104`, `ec3d88d`) rescaled both games to a proper low-res pixel-art resolution and
rebuilt the scenery, HUD and attract-mode pacing around that; see "Resolution and scale rework"
below. Everything in this report describes the current (second-pass) state.

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

World resolution is 320x176 logical px (see "Resolution and scale rework" below); constants are in
those units.

| Constant | Value | What it does |
|---|---|---|
| `GRAVITY` | 95 px/s² | constant downward pull |
| `THRUST_ACCEL` | 210 px/s² | "up" input; comfortably beats gravity so climbing feels responsive |
| `DOWN_ACCEL` | 60 px/s² | "down" input; gravity does most of the descent work |
| `H_ACCEL` | 150 px/s² | lateral thrust |
| `H_DRAG` | 2.4 /s | exponential damping on `vx` with no lateral input |
| `V_DRAG` | 0.5 /s | mild damping on `vy` so hovering settles instead of oscillating |
| `MAX_VX` / `MAX_VY` | 90 px/s | velocity caps |
| `LANDING_SAFE_VY` | 30 px/s | touch down slower than this or it's a crash |
| `CAMERA_LEAD` | 24 px | how far ahead of the player the camera looks, scaled by `vx/MAX_VX` |
| fuel drain / refill | 3.0/s airborne, 34/s on home pad | route-planning tension: dry fuel kills lift (unaffected by the resolution rescale -- percentage-based, not px) |
| `BOARD_INTERVAL_MS` | 380 | one Floppy boards per interval, landed at the farm, under capacity |
| scoring | 100/Floppy, +400 full-load (8) bonus | unaffected by the rescale |
| fire | grows 0.16/s, ignites a neighbour past 0.55 intensity | a fully-lit cell kills any Floppy standing in it (0..1 intensity units, unaffected by the rescale) |
| level 1 width | 480 px (`levelWidth()`, `+140`/level after) | short on purpose -- see attract-mode pacing below |

These were hand-picked for "thrust, gravity, momentum, tilt, gentle-landing-required" without a
human playtester in the loop (this was built end-to-end by an agent); they pass every physics/
landing test and read correctly in the recorded attract-mode clip, but a human pass to nudge feel
(particularly `THRUST_ACCEL`/`H_ACCEL` responsiveness) would be the natural next step.

**Levels**: level 1 starts with 6 Floppies and no drone; each level adds 2 more Floppies (capped at
16), a faster-spreading fire, more frequent falling debris, and from level 2 a patrolling "glitch"
drone that fires aimed shots (`Drone` in `engine.ts`). A level ends (advancing with score/lives/fuel
carried over) once every Floppy is either delivered or lost to fire and nobody's onboard -- so a
level can't soft-lock even if fire wipes out the whole pool before you reach it.

**Rendering** (`FloppyRescue.tsx` + `sprites.ts`): the helicopter is drawn from primitive rects
(organic silhouette, 2-frame rotor spin, tilt rotation -- easier to get right this way than a
hand-typed character grid); racks (tiled into a two-row "building"), flame frames, Floppy walkers
(2-frame walk/wave), debris and the drone are small character-grid sprites. The Disk Box is an
actual building (walls, roof, door, two windows, a sign on a post) sitting on its pad, not a green
strip; the server farm has its own "SERVER FARM" sign. Background is a gradient sky with a
repeating parallax pattern of clouds/stars, and a textured ground band that scrolls with the
camera. A compact C64-style HUD (score/level/onboard/fuel/lives, plus a distance minimap with
home/farm/player markers) is drawn directly onto the canvas -- inside the game frame, not only in
the larger accessible HTML HUD below the canvas, which stays too. The camera leads the helicopter
in its direction of travel instead of just centering on it. A title screen runs a pure, unit-tested
`attractInput()` autopilot flying a full demo loop behind it (see pacing below); level intro cards
("LEVEL 2: THE SERVER FARM IS SPREADING"); a "READY." game over screen with a blinking cursor;
rotor-chop/board/deliver/crash/floppy-lost Web Audio synthesis (`sound.ts`, same approach as
`src/lib/floppy-sound.ts`) gated by the app's sound toggle.

**Controls**: keyboard arrows/WASD; touch = a left-thumb virtual stick (drag, 8-directional, with a
deadzone) plus a LIFT button; Gamepad API (left stick/d-pad + a face button doubling as LIFT, start
button pauses).

### 3. Dreadnought Run polish (`src/easter/dreadnought/`)

Kept the prototype's rules (scroll speed ramps with distance, rack/turret obstacles, bullet
collisions, pickups) and replaced the placeholder triangle-and-grid rendering:

- Hand-drawn pixel-art sprites (`sprites.ts`): ship (with a damaged/invulnerable palette swap),
  rack units (tiled to fill variable-height racks), turret (damaged palette past one hit), and a
  **new enemy type**, a "drone" that sine-sweeps vertically and fires on its own cooldown, unlocked
  past 360px of distance so the first stretch of a run stays just racks + turrets.
- The hull is now an actual hull, not a bare grid: `drawHull()` layers distant tower silhouettes
  along the horizon (heights from a deterministic hash of their tile index, not RNG/state), mid-depth
  panelling with rivets and vent slits, and a runway-light stripe along the top/bottom edges, each
  scrolling at a different fraction of world speed for real parallax depth.
- A compact C64-style HUD (score/HI/lives/distance) is drawn directly onto the canvas, same
  treatment as Floppy Rescue's, alongside the existing larger HTML HUD.
- Explosion particles + a small screen shake on kills/hits (`shared/particles.ts`), skipped under
  `prefers-reduced-motion`.
- A title/attract screen driven by a pure `attractInput(t)` autopilot (a slow figure-eight weave
  with occasional firing).
- A pause button next to the close box, alongside the existing `P` key.
- Gamepad API support (same shared helper as Floppy Rescue).

`engine.ts` now emits typed `GameEvent`s (`obstacleDestroyed`, `playerHit`) so the renderer reacts
to hits/kills directly instead of re-deriving them from before/after diffs.

## Resolution and scale rework

The first pass simulated and rendered both games at 800x440 canvas px. That's not "low-res" in any
meaningful sense for a ~30px-wide sprite -- a 26px-wide helicopter or ship occupies about 3.25% of
the canvas width, which reads as a speck once the canvas is displayed at frame size. The fix wasn't
bigger sprites; it was a smaller world. Both engines' `WORLD_W`/`WORLD_H` are now 320x176 (the same
1.818 aspect ratio as before, so `.easter-canvas`'s CSS didn't need to change shape, just its
`aspect-ratio` value), and `.easter-canvas` still scales that canvas up to fill the frame via the
`image-rendering: pixelated` it already had -- so the same hand-drawn sprites, kept at close to
their original absolute pixel sizes (a 26px ship is now ~8% of a 320px-wide world instead of
3.25% of an 800px-wide one), read as legible chunky pixel art instead of getting lost.

Everything expressed in px/s or px/s² (gravity, thrust, drag caps, scroll speed, bullet speed,
spawn-margin distances, pad widths, ...) was rescaled by the same ratio the world shrank by, so the
*time* to cross the screen, land, etc. is unchanged -- only pixel-size constants like `PLAYER_W`/
`PLAYER_H` and sprite dimensions were deliberately left close to their original values. Anything
score-, percentage- or time-based (fuel rates, cooldowns in ms, fire intensity 0..1, points) needed
no change at all. `docs/reports/games.md`'s tuning tables above list the current (rescaled) numbers;
see each `engine.ts`'s header comment for the full rationale.

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
- **390×844 and 1280×860**: `.easter-canvas` is `width:100%; height:auto; aspect-ratio:320/176`, so
  the frame scales to fit a phone-width viewport without distorting the pixel art; verified in the
  mobile screenshots below. Below 480px wide, a media query drops `.easter-frame`'s width cap (it
  now uses the full viewport width) and sizes up the titlebar, in-frame HUD, help text, buttons and
  touch controls so the whole modal reads as filling the screen -- the canvas itself stays
  width-bound by its fixed, non-distorted 320:176 aspect ratio (a landscape world on a portrait
  screen can't also be height-bound without either cropping the world or stretching the pixel art;
  making the chrome around it bigger was the fix that didn't compromise the art).
- **60fps target, fixed-timestep, pauses when hidden**: `shared/fixedStep.ts`, used by both games.
- **Code-split**: nothing under `src/easter/` is imported eagerly from `App.tsx` except the Konami
  listener and the `/ready` route wiring (a few bytes). Each game is its own `React.lazy` chunk, so
  picking one from the menu never fetches the other's code.

## Chunk sizes

```
dist/assets/pixelSprite-*.js     2.47 kB  gzip:  1.14 kB   (shared sprite renderer)
dist/assets/EasterEggRoot-*.js   3.50 kB  gzip:  1.59 kB   (menu + router shell)
dist/assets/DreadnoughtRun-*.js 13.52 kB  gzip:  5.17 kB
dist/assets/FloppyRescue-*.js   20.65 kB  gzip:  7.90 kB
```

Total lazy-loaded gzip: **15.80 kB**, well under the ~60 kB budget (up from 14.66 kB before the
hull/background/HUD additions in this pass, still comfortably inside it). The main bundle
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

## Screenshots and video

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

Mobile mid-game shots add `&touch=1`, which both game components read from the URL to force the
on-screen touch controls on regardless of pointer/hover media features -- Playwright's `screenshot`
CLI emulates viewport size only, not a coarse pointer, so without it a headless browser reports a
fine pointer even at phone widths and the `@media (hover: hover) and (pointer: fine)` rule that
normally hides touch controls on desktop would hide them here too.

`docs/design/floppy-rescue.webm` (~22s) and `docs/design/dreadnought-run.webm` (~17s) -- recordings
of each game's title-screen attract mode (Playwright `recordVideo`, system Chrome via
`channel: "chrome"`, 1280×860, no browser download; `playwright` was installed with `--no-save` for
the one-off recording script and removed afterward -- it's not a project dependency). Both were
reviewed frame-by-frame before committing: `ffmpeg -i <file>.webm -vf "fps=1/3" frame%02d.png`,
then each frame read and checked for legible, non-static action. Floppy Rescue's clip shows a full
takeoff -> cross to the farm -> land/board -> fly home -> land/unload loop completing inside the
recording (level 1 is deliberately short -- `levelWidth(1) = 480` -- specifically so this fits well
under 20s); Dreadnought Run's shows continuous dodging/firing with racks, turrets and a drone
visible throughout.

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
- **Design review, round 2: both games were illegible at their shipped resolution.** Reviewing the
  round-1 screenshots and clip found the ship/helicopter and everything else reading as tiny specks
  in a mostly empty 800x440 canvas -- see "Resolution and scale rework" above for the fix (shrink the
  world to 320x176, not the sprites) and the rest of this report for the scenery/HUD/attract-mode
  work that went with it.
- **The title-screen help text could land on top of the scene behind it.** The attract-mode demo
  keeps flying behind the title overlay by design, so its scenery (the Disk Box sign, in particular)
  could be anywhere on screen; the help line had no background and its position depended on how
  tall the centered flex stack above it happened to be, so it sometimes rendered directly on top of
  the sign, both text unreadable. Fixed by giving the title name/subtitle/help line their own solid
  background chips and anchoring help to the bottom of the overlay instead of wherever the centered
  stack ended.

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
- **The attract-mode autopilot (both games) can still die mid-demo** (a debris hit or an enemy
  bullet at the wrong moment) -- the demo just respawns/resets and keeps going, which still reads
  fine on camera (see the reviewed clips), but a slightly more conservative autopilot could avoid it
  entirely if that ever looks distracting in a longer recording.
- **Mobile canvas height** is inherently width-bound by the games' fixed 320:176 (landscape)
  aspect ratio -- the chrome around it (HUD, touch controls, buttons) now fills the rest of the
  screen, but the canvas itself can't also grow to fill height without either cropping the visible
  world or stretching the pixel art. Worth a deliberate design call later if a taller in-game view on
  phones becomes a priority (e.g. a narrower logical resolution used only below some viewport width).
