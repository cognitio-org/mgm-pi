# Outfitter easter-egg games: KERNAL GAMES

Built on top of the Dreadnought Run prototype from `docs/reports/easter-egg-research.md`. That
report still holds for licensing rationale and trigger choice (Konami code + `/ready`); this one
covers what changed and what was added: a "KERNAL GAMES" launcher menu, a full Floppy Rescue
(Choplifter-inspired) game, and a polish pass on Dreadnought Run.

**Three build passes.** The first pass (commits `af8ed88`..`58da1ea`) got the menu, both games'
logic, and a visual style in place, but a design review of the resulting screenshots/clip found the
action read as "specks in an empty window" -- legible logic, illegible presentation. A second pass
(commits `0ce3104`, `ec3d88d`) rescaled both games to a proper low-res pixel-art resolution and
rebuilt the scenery, HUD and attract-mode pacing around that. A third pass, after the owner (and his
son) played both, shrank the world again for a still-bigger helicopter/ship, made the burning farm
and the ship's hull read as the visual focus they're meant to be, fixed a Disk Box camera/sign issue,
and added "juice" (hit-flash, sparkles, score pops, varied-size debris) to both games; see
"Resolution and scale rework" and the per-game sections below. The recorded frames from that pass
still showed small flat sprites in a mostly empty, unevenly scaled window, so a fourth pass --
**"Art pass 3"**, directly below -- redid the art against measured acceptance checks. Where the
older sections below disagree with Art pass 3 (rendering details, scale, HUD placement, clip
content), Art pass 3 is the current state.

## Art pass 3

Two earlier passes reported "done" while the recorded frames still showed tiny sprites in empty
space, so this pass was verified by measurement, not by eye alone. Root causes found first:

- **Non-integer scaling.** The canvas was stretched to the frame with `width: 100%`: 855/240 =
  3.56x at 1280x860, so logical pixels became uneven 3-or-4px blocks, and in-canvas text (7px
  `fillText`) smeared. The window itself was a fixed 860px box with the canvas as a strip inside it.
- **Flat, tiny art.** One-colour sprites, a 5x7 flame sprite, a helicopter made of seven rects, and a
  Dreadnought "hull" that was mostly evenly spaced vertical lines.

### How it was measured

- **Probe + harness.** `src/easter/shared/probe.ts` is a no-op unless a harness sets
  `window.__easterProbe = []`; then each renderer records the logical-pixel rects it drew that frame
  (chopper, Floppies, first rack, roof-fire top, signs, Disk Box, beacon state, ship, turrets, drones,
  landmarks, tile kinds). A Playwright script (system Chrome) sampled the probe every 200ms for 20-30s
  per run and converted rects to screen px using the canvas's *actual* on-screen scale
  (`getBoundingClientRect().width / canvas.width`), plus the frame/titlebar boxes for the
  playfield ratio. Runs: 1280x860 and 390x844, seeded (`?seed=3708` rescue, `?seed=439` dreadnought
  -- new, see below) and unseeded.
- **Pixels.** A small scanner decodes the committed screenshots with ffmpeg (rgb24) and reports
  8-connected components of sprite colours (tolerance 14, because the app's global CRT scanline
  overlay darkens every other 2px row by ~5%).
- **Frames.** Both clips were cut into frames every 3s (`ffmpeg -vf fps=1/3`) and looked at, plus
  0.5s steps across the delivery moment; the attract autopilots were also simulated headlessly (Node
  runs the TS engines directly) across hundreds of seeds.

### Acceptance checks

| # | Check | Measured | Result |
|---|---|---|---|
| 1 | Floppy Rescue at 1280x860: chopper >= 64px wide | integer scale **5x** (canvas 1200x660 + 2px borders, logical 240x132). Chopper sprite 32 logical px -> **160px** wide (probe, 121/121 samples). PNG: its body/stripe/canopy colours alone span **105x40px** in `games-rescue-mid-desktop-dark.png` (tail boom, rotor and outline excluded) | PASS |
| 1 | Floppy >= 24px tall, visible legs and disk label | 12 logical px -> **60px** tall (probe, 617 samples); 3 rows of legs + feet, metal shutter, white label with eyes (checked in full-res crops) | PASS |
| 1 | Playfield >= 85% of the window's content area | canvas area / (frame inner area minus titlebar) = **0.95** on every sample, both games; canvas = 100% of the frame's inner width (the window now shrink-wraps the canvas) | PASS |
| 1 | 390x844: chopper >= 44px, canvas full width | scale **2x**, view 195 logical px wide -> canvas **390px = 100% of the viewport** (the game window is full-bleed on phones). Chopper **64px** (probe); PNG cabin-only bbox 42px, full sprite incl. tail rotor ~64px in a 4x crop. Floppy 24px | PASS |
| 2 | Burning farm reads as on fire whenever visible | on every sample with the building on screen (58/58 seeded, 33/33 unseeded, 51/51 phone): roof flames rise **2.21-2.67 rack heights** above the rack tops (rack = 24 logical px). Flames are procedural columns in red/orange/yellow/white-hot with a dark tip and detached tongues, re-rolled every 85ms (unbounded distinct frames, well over 3); smoke column present 58/58, sparks 58/58. They're stateless functions of time, so the farm is fully ablaze and smoking on frame one of a level. Burning cells add ground fires; racks in them scorch with glowing vents | PASS |
| 2 | "SERVER FARM" sign fully readable | fully in view on every sample where the building is (58/58, 33/33, 51/51); drawn in a foreground pass after flames, smoke and chopper, so nothing covers its lettering | PASS |
| 3 | Disk Box + sign fully in frame at level start and in attract | fully in view on every sample with the chopper at home: **39/39** seeded, **25/25** unseeded, **34/34** phone. Level start: camera 0 (engine). Samples during the 800ms crash hold (camera deliberately held on the wreck to show the explosion, then cut home) were excluded: 4 and 7 samples. Caveat: the chopper lands *in front of* the building, so for ~0.3s of its final descent it passes over the DISK BOX plate (in frame, briefly overlapped) | PASS |
| 3 | Pad landing light blinks while carrying | beacon lit on 18 samples of the seeded run (250ms blink, only while `onBoard > 0`), dim otherwise; pad edge lights chase toward the box while carrying. Visible in the clip on the flight home | PASS |
| 4 | Dreadnought hull: distinct tiles, two parallax layers, landmark at least every ~10s | every sample shows >= **12 tile kinds**: plate, seamed plate, rivet rows, vent grille, round hatch, pipe run, light strip, hazard stripe, runway, plus girder/duct/cable-tray on the lower layer. Layers: deck 1.0x (same speed as the obstacles on it), substructure 0.5x through trenches and the stepped hull edge, stars 0.1x. Landmark instances first seen at **0, 4.5, 10.8, 16.5, 21.5s**, one every 384px of deck (5-7.5s), alternating a bridge superstructure and a numbered hangar door; a landmark is on screen in 87/109 samples, never more than 1.6s without one. Antenna towers and a lit runway strip every cycle. No frame is "only vertical lines" | PASS |
| 4 | Ship and turrets >= 40px at 1280x860 | ship 28 logical -> **140px**; turret 18 -> **90px**; drone **80px** (probe). PNG: the ship's hull colours alone span 105x60px in `games-dreadnought-mid-desktop-dark.png` | PASS |
| 5 | Juice in both games; calm under reduced motion | explosion: 6-frame blast sprite (17x17, drawn 2x for the player) + tumbling debris-chunk sprites (2 rotation frames each) + sparks; hit: 150ms white silhouette of the chopper/ship, a 120ms screen flash and a 2-4px shake; pickups/boarding: 3-frame 4-point sparkles, a glint sweeping the floppy pickups; "+100"/"+600"/"+150"/"+50"/"+200" pops in the bitmap font (all seen in the clips). `prefers-reduced-motion` (Playwright `reducedMotion: "reduce"`, 0 page errors): no shake, no screen flash, no debris/sparks, flames flicker at 320ms, smoke slowed, no parallax in Dreadnought (the substructure moves with the deck); blasts and pops stay | PASS |
| 6 | Lazy chunks < 60KB gzip; tests and build pass | EasterEggRoot **1.59** + shared chunk **4.20** + DreadnoughtRun **9.49** + FloppyRescue **12.47** = **27.75KB** gzip; main `index-*.js` unchanged at 145.22KB gzip. `npm ci && npm test --workspace=@outfitter/web && npm run build`: **11 files, 120 tests passed**, build exit 0 | PASS |

### What changed

Shared (`src/easter/shared/`):

- `screen.ts` (new): `usePixelScale` picks the largest integer CSS scale that fits the viewport and,
  on narrow screens, shows a narrower slice of the world (down to 180 logical px) instead of scaling
  down non-integer. The canvas's backing store is the logical size; its CSS size is exactly
  `viewW x scale` by `132 x scale`, with `image-rendering: pixelated`.
- `font.ts` (new): a 3x5 pixel font on the logical grid for HUDs, signs, logos and score pops.
- `pixelSprite.ts`: rasterises each (sprite, palette, flip) once into an offscreen canvas and blits
  it; `drawSpriteSheared` (a pixel-exact lean instead of `ctx.rotate`), `solidPalette`,
  `ditherSprite` (checkerboard shadows), `hash2` (deterministic scenery).
- `fx.ts` (new): the blast frames, debris chunks, sparkles and smoke discs are generated from a few
  radii and a jitter hash at module load rather than typed out (same pixels, far fewer bytes);
  `particles.ts` gained chunk/star particle kinds.
- `palette.ts` (C64's 16 slots, nudged to sit with the app's dark theme), `probe.ts`, and
  `query.ts` (`?demo=1`, `?touch=1` and the new `?seed=N` for reproducible demo runs).

Floppy Rescue (`rescue/render.ts` new, `sprites.ts` redrawn):

- Night scene: raster-band sky with dithered seams, twinkling stars, moon, a banded firelight glow
  in the sky over the farm, 0.2x hills, a 0.45x town with lit windows, a textured ground band, and
  pines, bushes and lamp posts between the pads.
- The server farm: corrugated back wall with fire-lit windows, five 12x24 rack cabinets with
  blinking LEDs (scorched once their cell burns), a broken front frame, roof fire, smoke column,
  sparks, ground fires in burning cells, a foreground billboard with a warning lamp.
- The chopper: 32x14 body, 3-frame main rotor, 2-frame tail rotor, a lean of at most ~1px per 10
  columns, a ground shadow that shrinks with altitude, passenger windows that light green when
  carrying, a white hit flash, then a blink.
- Floppies: 11x12, five disk colours, 2 walk frames and a wave frame (they wave when the chopper is
  down at the farm); later rows of the queue draw behind and offset instead of stacking exactly.
- The Disk Box: a giant disk box with its smoked lid propped open, disks peeking out, a door, a
  DISK BOX plate, a beacon mast and a helipad with chasing edge lights.
- HUD moved into the dirt band under the grass line, so it never covers the sky; the old HTML HUD
  strip is now screen-reader only. The title logo is drawn in-canvas above the demo's cruise height.

Dreadnought Run (`dreadnought/render.ts` new, `sprites.ts` redrawn): see the table (check 4) for the
hull; plus a 28x14 fighter with a 3-frame engine flame and a dithered shadow on the hull below,
octagonal turrets with hazard rings and a damaged variant, quad-rotor drones, rack blocks with
LEDs, bolts and orbs, and a one-row HUD in the strip of open space above the hull.

Game logic (touched only where the art depended on it; engine tests unchanged and passing):

- **Rescue attract autopilot** (`attractInput`): lands on the coolest part of the pad instead of
  dead centre, lifts off if the fire reaches the skids, cruises lower, sidesteps falling debris.
  Simulated over the same 20 seeds for 30s each: the previous autopilot rescued nobody in any run
  (65 crashes, mostly landing into fully-lit cells); the new one delivers in 14 of 20 (38 crashes,
  mostly level-2 drone shots). About 30% of seeds give a clean first loop with no crash; `?seed=3708`
  (all six Floppies home in one trip) is used for the clip and screenshots.
- **Dreadnought attract autopilot**: `attractInput(t, state?)` -- with the state it steers to the
  nearest clear lane and fires at turrets/drones ahead; median demo survival went from 10s to 26s
  over 30 seeds. `attractInput(t)` alone behaves exactly as before (the existing test).
- **Rescue engine fixes:** on a respawn the camera cuts home (the renderer holds the old view for
  800ms so the explosion is seen), and `step()` no longer carries the previous step's `events`
  through every frame of the level-intro card. Before this fix, the level's final events (the last
  `floppyLost`, `levelComplete`) were replayed by the renderer on every frame for 2.2s.


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

World resolution is 240x132 logical px (see "Resolution and scale rework" below); constants are in
those units. This is the *second* rescale -- an original 320x176 pass shrank further by another 0.75x
ratio after the owner's playtest found the helicopter still small at a normal laptop window.

| Constant | Value | What it does |
|---|---|---|
| `GRAVITY` | 71 px/s² | constant downward pull |
| `THRUST_ACCEL` | 158 px/s² | "up" input; comfortably beats gravity so climbing feels responsive |
| `DOWN_ACCEL` | 45 px/s² | "down" input; gravity does most of the descent work |
| `H_ACCEL` | 113 px/s² | lateral thrust |
| `H_DRAG` | 2.4 /s | exponential damping on `vx` with no lateral input |
| `V_DRAG` | 0.5 /s | mild damping on `vy` so hovering settles instead of oscillating |
| `MAX_VX` / `MAX_VY` | 68 px/s | velocity caps |
| `LANDING_SAFE_VY` | 23 px/s | touch down slower than this or it's a crash |
| `CAMERA_LEAD` | 18 px | how far ahead of the player the camera looks, scaled by `vx/MAX_VX` |
| `HOME_CAMERA_LOCK_PAD` | 30 px | while the player is within this of the home pad, the camera stays pinned at 0 (Disk Box + sign always fully in frame) instead of leading away |
| fuel drain / refill | 3.0/s airborne, 34/s on home pad | route-planning tension: dry fuel kills lift (unaffected by any rescale -- percentage-based, not px) |
| `BOARD_INTERVAL_MS` | 380 | one Floppy boards per interval, landed at the farm, under capacity |
| scoring | 100/Floppy, +400 full-load (8) bonus | unaffected by any rescale |
| fire | grows 0.16/s, ignites a neighbour past 0.55 intensity | a fully-lit cell kills any Floppy standing in it and flips its rack to a scorched palette (0..1 intensity units, unaffected by any rescale) |
| level 1 width | 360 px (`levelWidth()`, `+105`/level after) | short on purpose -- see attract-mode pacing below |

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
(2-frame walk/wave, with a distinct disk-shutter label so they read as little floppy-disk
characters), debris and the drone are small character-grid sprites. The Disk Box is an actual
building (walls, roof, door, two windows, a sign on a post) sitting on its pad, not a green strip,
with a landing light on the roof peak that blinks while the helicopter is carrying Floppies home
(steady dim otherwise); the camera stays pinned at distance 0 while the player is near the pad
(`HOME_CAMERA_LOCK_PAD`), so the building and its sign are always fully in frame instead of
scrolling off the moment thrust ramps up. The server farm -- the level's visual focus -- has its own
"SERVER FARM" sign (drawn last, always on top and legible), four-frame three-tone
(orange/yellow/red) flame animation, continuous smoke puffs drifting up off any fully-lit cell,
periodic sparks, a warm glow at the base of the fire, and racks that flip to a scorched palette once
their cell is mostly lit. Background is a gradient sky with a repeating parallax pattern of
clouds/stars, and a textured ground band that scrolls with the camera. A compact C64-style HUD
(score/level/onboard/fuel/lives, plus a distance minimap with home/farm/player markers) is drawn
directly onto the canvas -- inside the game frame, not only in the larger accessible HTML HUD below
the canvas, which stays too. The camera leads the helicopter in its direction of travel instead of
just centering on it. A title screen runs a pure, unit-tested `attractInput()` autopilot flying a
full demo loop behind it (see pacing below); level intro cards ("LEVEL 2: THE SERVER FARM IS
SPREADING"); a "READY." game over screen with a blinking cursor; floating "+N" score pops and a
brief hit-flash on crashes (`shared/particles.ts`, skipped/shortened under `prefers-reduced-motion`);
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
  along the horizon (heights from a deterministic hash of their tile index, not RNG/state) -- with
  an occasional taller "bridge tower" (lit windows, an antenna mast) standing out from the regular
  ones -- mid-depth panelling with rivets, vent slits and hatches -- with an occasional big "hangar
  door" (a large recessed dark panel with a seam and a hatch light) among the regular panels -- and a
  runway-light stripe along the top/bottom edges, each layer scrolling at a different fraction of
  world speed for real parallax depth. Both "big feature" placements are a deterministic index
  modulo, same technique as the tower-height hash, so a given stretch of hull always looks the same.
- A compact C64-style HUD (score/HI/lives/distance) is drawn directly onto the canvas, same
  treatment as Floppy Rescue's, alongside the existing larger HTML HUD.
- Explosion particles (varied size, so a burst reads as chunks rather than uniform dust) + a small
  screen shake on kills/hits, a sparkle + floating "+N" score pop when a turret/drone/pickup is
  destroyed/collected, and a brief hit-flash when the ship is hit (`shared/particles.ts`), all
  skipped or shortened under `prefers-reduced-motion`.
- A title/attract screen driven by a pure `attractInput(t)` autopilot (a slow figure-eight weave
  with occasional firing).
- A pause button next to the close box, alongside the existing `P` key.
- Gamepad API support (same shared helper as Floppy Rescue).

`engine.ts` emits typed `GameEvent`s (`obstacleDestroyed`, `playerHit`, and now `pickupCollected` --
added in the third pass so a collected Floppy pickup can drive a sparkle + score pop the same way a
destroyed obstacle does; both carry an optional `score` field so the renderer never has to re-derive
the popup text) so the renderer reacts to hits/kills/pickups directly instead of re-deriving them
from before/after diffs.

## Resolution and scale rework

**Pass one.** The original prototype simulated and rendered both games at 800x440 canvas px --
not "low-res" in any meaningful sense for a ~30px-wide sprite (a 26px-wide helicopter or ship
occupied about 3.25% of the canvas width, a speck once displayed at frame size). The fix wasn't
bigger sprites; it was a smaller world: both engines' `WORLD_W`/`WORLD_H` went to 320x176 (same
1.818 aspect ratio, so `.easter-canvas`'s CSS only needed a new `aspect-ratio` value, not a new
shape), with sprite pixel sizes left close to their originals so they became a bigger fraction of
the smaller world.

**Pass two.** After playing both games, the owner found the helicopter still small at a normal
laptop window and asked for it to read at ~48 screen px wide at 1280x860 and ~36px at 390x844. Same
technique, applied again: `WORLD_W`/`WORLD_H` shrank a further 0.75x to 240x132 (still the same
aspect ratio), sprite pixel sizes stayed put, and the Floppy walker sprite grew slightly (9x10 ->
9x13, with a clearer label/shutter and a write-protect-hole detail) so it reads as "a little
character," not just a green square, at the new scale. The helicopter now measures roughly 85px wide
at 1280x860 and ~40px at 390x844 in practice -- comfortably past both targets.

In both passes, everything expressed in px/s or px/s² (gravity, thrust, drag caps, scroll speed,
bullet speed, spawn-margin distances, pad widths, ...) was rescaled by the same ratio the world
shrank by, so the *time* to cross the screen, land, etc. is unchanged between passes -- only
pixel-size constants like `PLAYER_W`/`PLAYER_H` and sprite dimensions were deliberately left alone
(that's the whole point: shrink the world, not the sprites). Anything score-, percentage- or
time-based (fuel rates, cooldowns in ms, fire intensity 0..1, points) needed no change in either
pass. The tuning tables above list the current numbers; see each `engine.ts`'s header comment for
the full rationale.

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
- **390×844 and 1280×860**: `.easter-canvas` is `width:100%; height:auto; aspect-ratio:240/132`, so
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

After Art pass 3:

```
dist/assets/EasterEggRoot-*.js   3.50 kB  gzip:  1.59 kB   (menu + router shell)
dist/assets/query-*.js           9.84 kB  gzip:  4.20 kB   (shared: sprite cache, font, FX, scaling, loop...)
dist/assets/DreadnoughtRun-*.js 24.97 kB  gzip:  9.49 kB
dist/assets/FloppyRescue-*.js   33.13 kB  gzip: 12.47 kB
```

(Vite names the shared chunk after one of its modules; it's the whole of `src/easter/shared/`.)
Total lazy-loaded gzip: **27.75 kB**, under the 60 kB budget (up from ~17.2 kB before the pass: all
art is still character grids, rules and palettes -- no images). The main bundle
(`dist/assets/index-*.js`, 468.57 kB / 145.22 kB gzip) is unchanged -- none of `src/easter/`
reaches it.

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
  `/ready?game=rescue&seed=3708`, 6s in.
- `games-rescue-mid-{desktop,mobile}-{dark,light}.png` -- mid-game action,
  `/ready?game=rescue&demo=1&seed=3708`, 9.5s in (the attract-mode autopilot keeps flying past the
  title screen so a headless screenshot shows real gameplay -- HUD, chopper at the burning farm).
- `games-dreadnought-title-{desktop,mobile}-{dark,light}.png` -- Dreadnought Run's title/attract
  screen, `/ready?game=dreadnought&seed=439`, 4s in.
- `games-dreadnought-mid-{desktop,mobile}-{dark,light}.png` -- mid-game action,
  `/ready?game=dreadnought&demo=1&seed=439`, 6s in.

`?seed=N` (Art pass 3) fixes the RNG seed so these, and the clips, are reproducible. In both themes
the canvas itself stays in the C64 palette (it's a "screen"); the window chrome around it follows
the GEOS light / C64 dark theme.

Mobile mid-game shots add `&touch=1`, which both game components read from the URL to force the
on-screen touch controls on regardless of pointer/hover media features -- Playwright's `screenshot`
CLI emulates viewport size only, not a coarse pointer, so without it a headless browser reports a
fine pointer even at phone widths and the `@media (hover: hover) and (pointer: fine)` rule that
normally hides touch controls on desktop would hide them here too.

`docs/design/floppy-rescue.webm` (~26s) and `docs/design/dreadnought-run.webm` (~23s) -- recordings
of the in-game demo (`?demo=1`, HUD visible), re-recorded after Art pass 3 with
`/ready?game=rescue&demo=1&seed=3708` and `/ready?game=dreadnought&demo=1&seed=439` (Playwright
`recordVideo`, system Chrome via `channel: "chrome"`, 1280x860, no browser download; `playwright`
lives only in a scratch directory for the one-off recording/measurement scripts -- it's not a
project dependency). Frames were extracted every 3s (`ffmpeg -i <file>.webm -vf "fps=1/3"
frame%02d.png`) and every one was looked at. Floppy Rescue's clip: level card, takeoff with the
Disk Box in frame, crossing to the farm (burning in every frame it's in), landing on the cool end of
the pad, all six Floppies boarding (six lit HUD icons), the flight home with lit passenger windows
and a blinking beacon, the "+600" pop over the Disk Box, then the level-2 card. Dreadnought Run's:
a landmark (bridge DN10, hangar 02, bridge DN12, hangar 04) in 6 of 8 sampled frames, the runway
strip, pickups, kills with blasts and "+150"/"+200"/"+50" pops, and one hit (blast, flash, lost
ship).

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
- **Design review, round 3: the ground glow rendered as an opaque block, not a fade.** The first
  attempt at "a warm glow on the ground near the fire" used a `createRadialGradient`; in a real
  screenshot it showed up as a hard-edged, fully saturated orange rectangle covering a large swath of
  the ground band, not the soft fade the gradient stops (`rgba(255,138,0,alpha)` -> `rgba(255,138,0,0)`)
  were supposed to produce. Rather than debug the gradient further, replaced it with a handful of
  small, fixed-low-alpha bars directly under each lit fire cell, bounded to that cell's own width --
  simpler, safer, and verified correct by re-screenshotting.

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
- **The attract autopilots still die sometimes** (Art pass 3 made them much better, see above): about
  70% of Floppy Rescue seeds crash at least once before the first delivery, and level-2 drone shots
  get through. The demo respawns/resets and keeps going; `?seed=` picks a clean run for recordings.
- **Level 1's fire outruns most rescues.** The whole pad is fully lit ~10-12s after play starts,
  and the flight out takes ~5s, so even the improved autopilot saves nobody on many seeds. That's
  game balance (`FIRE_GROW_PER_SEC`, the ignite threshold), which this art pass didn't touch; worth
  a human playtest.
- **A crashed chopper keeps its passengers.** On a crash the engine respawns the chopper at home
  with `onBoard` unchanged, so they're "delivered" (and scored) on the very next step. Pre-existing
  rule, left alone in an art pass; probably should zero `onBoard` (Floppies lost with the chopper).
- **The chopper lands in front of the Disk Box**, so for ~0.3s of its final descent it passes over
  the DISK BOX plate. Always fully in frame; a sign off to the side of the pad would avoid even that.
- **Phone canvas height** is still width-bound by the landscape world (195x132 logical at 2x = 390x264
  on a 390x844 phone); the touch controls take the space below. Showing more height would need a
  taller logical world on phones, which is a design call.
- **The app's dark-mode CRT scanline wash** (`base.css`, `--scanline-opacity: 0.05`) also darkens
  alternate rows of the game canvas by ~5%. It reads fine and matches the rest of the app, but it isn't strictly flat
  pixel colour; exclude `.easter-overlay` from it if that's ever unwanted.
- **Multiple simultaneous `floppyLost` events** (several Floppies burning in the same couple of
  frames) each spawn their own small blast, which can get busy. Reads as "the fire is chaotic",
  which fits the brief.
