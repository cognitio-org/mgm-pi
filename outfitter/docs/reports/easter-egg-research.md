# A Commodore 64 easter egg for Outfitter

The owner grew up on **David's Midnight Magic** (Broderbund, pinball), **Choplifter**
(Broderbund/Sega, helicopter hostage rescue) and **Uridium** (Hewson, Andrew Braybrook's fast
horizontal-scrolling shooter). This report surveys four ways to put a C64-flavoured easter egg in
the Outfitter web UI, with licensing checked against primary/authoritative sources, and ends with
a recommendation. Part 2 documents the prototype that was built from that recommendation.

Everything here targets `outfitter/packages/web` (Vite + React + TypeScript), and must be
lazy-loaded so it costs nothing in the main bundle until triggered.

## 1. Emulating a real C64 in the browser

### Emulator cores

| Project | What it is | License | Notes |
|---|---|---|---|
| **VICE** | The reference C64/C128/VIC-20/PET/PLUS4/CBM-II emulator; the source nearly every other browser port wraps | GPLv2 (or later), per the [VICE homepage](https://vice-emu.sourceforge.io/) and its `COPYING` file | C source, not built for the web on its own |
| **vice.js** ([rjanicek/vice.js](https://github.com/rjanicek/vice.js)) | Emscripten build of VICE for the browser | Inherits VICE's GPLv2 (repo ships VICE source under the same license); unmaintained (no commits in years) | The most direct "VICE in WASM" option, but stale |
| **vice-libretro** ([libretro/vice-libretro](https://github.com/libretro/vice-libretro), mirrored at [EmulatorJS/vice-libretro](https://github.com/EmulatorJS/vice-libretro)) | VICE packaged as a libretro core | GPLv2, same lineage | Actively maintained as part of the libretro ecosystem |
| **EmulatorJS** ([EmulatorJS/EmulatorJS](https://github.com/EmulatorJS/EmulatorJS)) | A web frontend for RetroArch/libretro cores, including the VICE core above, distributed via npm (`@emulatorjs/core-vice_x64`) | EmulatorJS's own frontend code and the VICE core it loads are both GPL (VICE's GPLv2 propagates to the core build); EmulatorJS's docs explicitly recommend embedding it **in an iframe** for SPA integration ([How To Embed](https://emulatorjs.org/docs/embed/)) | Best-maintained option found; still GPL |

**GPL implication for Outfitter:** VICE and every WASM/libretro build of it found is GPLv2 (or
later). GPL code linked into our bundle (even as a WASM binary served alongside our JS) would put
the combined work under GPL's copyleft terms for that artifact, which is not something to take on
lightly for a proprietary internal tool. The standard mitigation — and what EmulatorJS's own docs
recommend for other reasons too — is to load the GPL emulator in a **sandboxed `<iframe>`** served
as its own static asset bundle, never `import`ed into the React app's module graph. An iframe is a
separate origin/document; it doesn't create a combined work with the surrounding app the way
linking would, and `sandbox="allow-scripts"` (no `allow-same-origin`, no network beyond what's
inlined) keeps it inert with respect to the rest of Outfitter. This is architecturally sound but
adds real complexity (a second build target, message-passing for pause/exit/high-score, careful
CSP) for a feature that's supposed to be a light touch.

No actively-maintained "jsc64" project was found under that name in this search; most current C64
JS/WASM emulation activity funnels through VICE (directly or via libretro/EmulatorJS) or through
newer hobby projects that are far less mature/maintained than VICE.

### System ROMs (KERNAL / BASIC / CHARGEN)

The original Commodore 64 KERNAL, BASIC and character ROMs are **still under copyright**. Per
discussion on the [Lemon64 "Commodore 64 ROM Copyrights" thread](https://www.lemon64.com/forum/viewtopic.php?t=73857)
(citing the chain of Commodore IP sales), the Commodore ROM assets — from the 1976 PET ROMs through
the last Amiga ROMs — ended up with **Cloanto**, the company behind Amiga Forever, which has been
protective of them; the same thread notes Cloanto declined to license the KERNAL even to David
Murray's Commander X16 project. Bundling the real ROMs with Outfitter would be straightforward
copyright infringement.

**Open replacement:** the [MEGA65 `open-roms` project](https://github.com/MEGA65/open-roms) is
building from-scratch, unencumbered KERNAL/BASIC replacement ROMs specifically so MEGA65-class
hardware doesn't need Commodore's originals — see the project's own framing on its
[GitHub Pages site](https://mega65.github.io/open-roms/) ("we respect... the intellectual property
rights of the copyright owners... [so] we have decided to develop our own"). As of this research
it is **not yet 100% compatible**: community discussion on
[Lemon64's "Open-Source ROM replacements" thread](https://www.lemon64.com/forum/viewtopic.php?t=71468)
describes it as good enough to boot and run some software with a working screen editor and IEC
loading, but not a drop-in KERNAL for arbitrary commercial titles, and the project's own docs note
that a "hybrid" ROM built against the *original* BASIC can't legally be redistributed at all. Using
OpenROMs is legally clean but adds a real compatibility tax on top of the emulator/iframe work
above.

### The three named games — rights today

- **David's Midnight Magic** (pinball, David Snider, Broderbund 1982). Broderbund the publisher no
  longer exists as an independent company: it was bought by The Learning Company in 1998, which
  Mattel bought in 1999, then broke up in 2000 — its entertainment titles (including the Myst
  series) went to **Ubisoft**, while the "Broderbund" brand name itself went to Riverdeep and today
  labels unrelated productivity software (see the [Broderbund Wikipedia article](https://en.wikipedia.org/wiki/Broderbund)
  and [Red Orb Entertainment](https://en.wikipedia.org/wiki/Red_Orb_Entertainment)). No source
  found in this search states David's Midnight Magic specifically was ever placed in the public
  domain or freeware-released by any rights holder; copies circulate on archive sites (e.g.
  [archive.org](https://archive.org/details/Davids_Midnight_Magic_1984_Broderbund)) as historical
  preservation, not as a license grant. **Treat it as still under someone's copyright** (most
  likely whichever Ubisoft/Riverdeep-adjacent entity inherited Broderbund's back catalog), not
  legally free to distribute.
- **Choplifter** (Dan Gorlin, Broderbund 1982; Sega licensed and built an arcade/console lineage
  from it). Per [Wikipedia](https://en.wikipedia.org/wiki/Choplifter) and the
  [Sega Wiki](https://sega.fandom.com/wiki/Choplifter), Sega's versions were a license from
  Broderbund, and the underlying IP traces back through the same Broderbund breakup above. Same
  conclusion: not established as free to distribute.
- **Uridium** (Andrew Braybrook, published by Hewson Consultants, 1986). Hewson Consultants ceased
  operating decades ago; the [Uridium Wikipedia article](https://en.wikipedia.org/wiki/Uridium) and
  [Graftgold Wikipedia article](https://en.wikipedia.org/wiki/Graftgold) (Braybrook's studio) don't
  identify a current corporate rights holder, and this search found no statement from Braybrook or
  any publisher placing Uridium in the public domain or under an open license. Notably, **Uridium
  is one of the pack-in games on Retro Games Ltd.'s officially licensed "TheC64 Mini/Maxi"**
  hardware (confirmed via its published game list, e.g. summarized at
  [Armchair Arcade](https://armchairarcade.com/perspectives/2025/11/14/retro-games-ltd-thec64-mini-black-edition-game-list-and-where-to-buy-in-the-us/)),
  which only happens because Retro Games Ltd secured a license — strong secondary evidence that
  Uridium's rights are actively held and licensed commercially, not free.

**Bottom line for all three:** none is legally free to bundle. All three sit with a rights holder
(directly or through corporate succession) that licenses them commercially today.

### Legitimate ways to play the real originals today (personal use, separate from Outfitter)

Kept intentionally short and separate from anything we'd ship:

- **Uridium** is confirmed included on **[TheC64 Mini/Maxi](https://retrogames.biz/products/thec64-mini/)**
  hardware from Retro Games Ltd, an officially licensed retro console — a legitimate commercial way
  to play it today.
- **[Antstream Arcade](https://www.antstream.com/)** bills itself as "the world's largest
  officially licensed retro game streaming platform" and lists 352 C64 titles among 1,300+ overall
  ([Antstream on Wikipedia](https://en.wikipedia.org/wiki/Antstream_Arcade),
  [Antstream's own C64 write-up](https://www.antstream.com/post/hidden-gems-of-antstream-commodore-64));
  it's subscription-based and whether these three specific titles are on it wasn't confirmed in
  this pass — worth checking antstream.com directly before assuming any one game is present.
- For Choplifter and David's Midnight Magic specifically, no current first-party re-release was
  identified in this search; the owner's best bet is checking whether Antstream (or another
  officially-licensed service) currently carries them, since Broderbund's back catalog is
  fragmented across Ubisoft/Riverdeep successors and there's no single obvious storefront.
- None of this is something Outfitter should link to or bundle — it's personal-use information for
  the owner, kept here for reference only.

### "Bring your own file" mode

The owner has confirmed they no longer have any of their own `.prg`/`.d64`/`.crt` files, so this
path isn't practical for them right now — noted here only for completeness, not prototyped.
Technically it's the cleanest legal position an in-app emulator could take: a `<input type=file>`
(or drag-and-drop) that reads a file the user already owns entirely client-side (`FileReader`,
never uploaded anywhere), handed to an emulator core running in a sandboxed iframe. Outfitter would
ship no ROM and no game — it would be a general-purpose player for files the user supplies, similar
in spirit to how a video tag doesn't "contain" whatever video you open in it. The main residual
legal question is the **KERNAL/BASIC ROM** the emulator itself needs to boot anything (see above);
OpenROMs sidesteps that but only handles some software, while shipping the real KERNAL would still
infringe Cloanto's copyright regardless of what game file the user supplies.

## 2. Freely licensed C64 homebrew

Modern C64 homebrew is a real, active scene (CSDb, itch.io, various demoparties), but this search
did **not find a specific, verifiably-licensed** (explicit redistribution grant, not just "free
download") title in the pinball, helicopter-rescue, or horizontal-shooter genres that could be
named here with confidence. itch.io's [C64 tag](https://itch.io/games/free/tag-commodore-64) and
[Homebrew collection](https://itch.io/c/1780333/c64-homebrew) surface many free-to-download C64
games, and "free download" pages exist for genre-adjacent titles like
[Basic Pinball](https://gbg-games.itch.io/simple-pinball) (note: that one is a modern
non-C64 pinball toy, not C64 homebrew) — but "downloadable for free" is not the same as "licensed
for redistribution inside another product," and this pass could not verify an explicit license
(MIT/CC0/etc.) on a C64-genre match without opening and reading each release's own terms
individually. **This option should not be pursued without a follow-up pass that opens specific
CSDb/itch.io release pages and reads their stated licenses one at a time** — don't ship a homebrew
binary on the strength of "it's on a free-games site."

## 3. Original mini-games inspired by the three (our code, our IP)

All three ideas below are inspired-by only: no shared names, sprites, sounds, music, or level
layouts with the originals, consistent with how "inspired by" is generally treated distinctly from
derivative/infringing use.

| Idea | What makes it fun in 1–3 min | Engine needs | Touch controls | Size |
|---|---|---|---|---|
| **One-table pinball** ("KERNAL" rollover lane instead of naming real targets) | Flipper timing, a couple of ramps/bumpers, chasing a high score | Real ball physics (gravity, restitution, flipper impulse) benefits a lot from a physics engine — matter.js (~90 KB min) or planck.js (~70 KB, box2d-derived) rather than hand-rolled, which is easy to get "floaty" or "sticky" wrong | Two tap zones (left/right flipper) | Medium-large (engine + table logic) |
| **Helicopter rescue** ("little Floppies" from a burning server farm to a Disk Box) | Gravity/thrust feel (a mini Lunar-Lander-ish loop), rescue-then-return tension, a timer or fuel gauge | Hand-rolled 2D physics is plenty (thrust vector, gravity, simple AABB collision) — no engine dependency needed | Two zones (thrust, strafe) or a virtual stick | Small |
| **Fast horizontal scroller over a "dreadnought" data center** | Constant forward motion reads as fast/exciting immediately, dodge+shoot loop is easy to learn, escalating scroll speed raises tension without new mechanics | Hand-rolled: scrolling background, AABB collision, simple enemy-fire patterns — no physics engine needed | Two zones (up/down) + a fire button, or drag-to-move + auto-fire | Small |

The **dreadnought scroller** was judged the most delightful-per-line-of-code for this crowd: it
needs no physics dependency (smallest lazy chunk), its "constant rightward motion + escalating
speed" loop is legible in under a minute even to a kid who's never seen the source material, and
"a dreadnought made of racks and blinking lights" is a very natural re-skin of Outfitter's own
fleet-of-agents theme (which the design docs already lean into — see `docs/design/README.md`'s C64
dark palette). The **helicopter rescue** is the strongest runner-up and probably the single most
fun-per-minute concept for a kid specifically (rescue-and-return has an obvious, satisfying loop,
and "little Floppies" as rescuees is a cute, on-brand joke) — it's a good next build if there's
appetite for a second easter egg later. **Pinball** is the best "David's Midnight Magic" homage but
carries the most engine risk/weight for the smallest fun-per-minute payoff in this format, so it's
the low priority of the three.

## 4. Triggers

| Trigger | Discoverability | Interference risk | Verdict |
|---|---|---|---|
| Konami code (↑↑↓↓←→←→ B A) anywhere outside a form field | Medium — a well-known meme among exactly the people likely to go looking for an easter egg | Very low if scoped to `document`-level keydown *and* explicitly ignored while focus is in an `<input>`/`<textarea>`/`<select>`/contenteditable | **Recommended** |
| `SYS 64738` typed into some menu/command surface | High flavor, but needs a text-command surface that doesn't exist yet in the header/menu (nothing currently accepts arbitrary typed commands there) | Low, if it only fires on an exact match in a dedicated field | Good **second** trigger once such a surface exists |
| `LOAD"*",8,1` + `RUN` in the composer, without sending to the agent | Highest flavor (an actual C64 boot incantation) but risky: the composer's job is to send text to a live coding agent, so intercepting specific text there needs to be airtight (never swallow it if it's ambiguously close to something a user meant to send) and the composer is being actively reworked by another agent right now | Medium — easy to get wrong mid-rework | Defer until the composer rework lands; wire it there deliberately, not as a rushed add-on |
| 5 clicks on the logo | Very discoverable once you notice the logo is clickable-ish | Low, but "5 rapid clicks" has to be careful not to fire on normal double-click-ish navigation | Fine, but lower flavor than Konami code for this crowd |
| Double-click the trash | N/A — no trash icon exists in this app | — | Not applicable here |

**Recommendation: Konami code** as the primary trigger — it needs no new UI surface, it's the
single lowest-risk-of-interference option (a global listener that explicitly ignores form fields),
and it's genuinely discoverable by "the curious" without being stumbled into by accident. A
`SYS 64738` command-field trigger is a good complementary addition once the header/menu rework
lands with a place to type it. The composer `LOAD"*",8,1`/`RUN` idea is the most delightful but
should be added by/with whoever owns the composer rework, once that surface stabilizes, rather than
grafted on now.

## Recommendation

**Build the original "dreadnought" horizontal-scrolling mini-game** (Section 3), triggered by the
**Konami code** (Section 4), with a hidden `/ready` route as a stable secondary entry point for
testing. This avoids all licensing risk entirely (Section 1: every real emulator core found is
GPL, every ROM is still copyrighted, all three named games are still commercially rights-held), is
the smallest to build and ship (no physics-engine dependency, no iframe sandboxing, no ROM
question), fits the existing GEOS/C64 visual language with zero new design language, and reads as
"fast and fun" in well under a minute — the format this crowd (owner + son) will get the most
replay value from. **Runner-up:** the helicopter-rescue concept, as a second easter egg later if
there's appetite — likely the single most fun concept for a kid, at slightly more build cost
(gravity/thrust feel takes some tuning) but still no physics-engine dependency.

Effort estimates (both exclude the Section 1 emulator path, which is effort-heavy end to end: a
second build target for the iframe bundle, ROM/compatibility work, and message-passing plumbing,
likely multiple days even before touching any licensing negotiation):

- **Dreadnought scroller (built below):** ~1 day for a genuinely playable version (this
  prototype); another ~1–2 days for a "full version" — see the Prototype section below for exactly
  what that adds.
- **Helicopter rescue runner-up:** similarly ~1 day for a playable core loop, plus extra tuning
  time for the thrust/gravity feel to not feel floaty or twitchy, which is the one place this idea
  costs more than the scroller.
- **Pinball:** ~2–3 days minimum once a physics engine is wired in and a table is tuned to feel
  good, plus the added lazy-chunk weight of matter.js/planck.js.

---

## Prototype

Implemented as designed above: an original, from-scratch horizontal scroller called **"Dreadnought
Run"** (no shared names/art/sound/layout with Uridium), triggered by the Konami code anywhere
outside a form field.

### How to launch it

- **Primary trigger:** anywhere in the app outside a text field, type the Konami code:
  `↑ ↑ ↓ ↓ ← → ← → b a`. Wired in `src/App.tsx` via `useKonamiCode(openEasterEgg)`
  (`src/easter/useKonamiCode.ts`, `src/easter/openEasterEgg.ts`), which dynamically imports the
  whole game on first trigger — nothing about the game is in the main bundle until then.
- **Secondary/testing entry point:** navigate to `/ready` (a nod to the C64's `READY.` prompt),
  wired as a normal `<Route>` in `src/App.tsx` pointing at `src/easter/EasterEggPage.tsx`, which
  `React.lazy`-loads the same `EasterEgg` component.
- Where the *final* production trigger should eventually also live, once the desk/composer/header
  rework in flight lands: a `SYS 64738` command in whatever command surface the reworked header
  ends up with, and/or `LOAD"*",8,1` + `RUN` recognized (and swallowed, never sent to the agent) in
  the reworked composer — see the Triggers table above for why those weren't wired now.

### Controls

- **Desktop/keyboard:** Arrow keys or WASD to move up/down, Space (or →) to fire, `P` to pause,
  `Escape` to exit.
- **Touch (phone/tablet):** on-screen UP / DOWN / FIRE buttons (shown only on coarse-pointer/no-hover
  devices via `@media (hover: hover) and (pointer: fine)`, so they never clutter a mouse+keyboard
  session).
- Exit is always available via the on-screen `X` close box or Escape.

### What it is

A small ship skims low over a scrolling "dreadnought" (a data-center hull rendered as a grid),
dodging server racks (instant hit) and turrets (shoot them for points before they shoot back),
grabbing stray "Floppies" for bonus score. Scroll speed ramps up with distance for escalating
tension. Three lives, a persistent high score, game-over/restart flow, and a pause overlay.

### Respecting the constraints

- **Code-split:** `src/easter/openEasterEgg.ts` and `EasterEggPage.tsx` both reach the actual game
  via `import("./EasterEgg.tsx")`; nothing in `src/easter/` is imported eagerly from `App.tsx`
  except the trigger wiring itself (a hook and a one-line route), which together add only a few
  bytes to the main bundle. Verified lazy chunk size below.
- **Full-screen with a C64 border:** `.easter-overlay`/`.easter-frame` in `src/styles/easter.css`
  (imported once from `src/style.css`), styled with the app's existing GEOS/C64 theme tokens so it
  re-themes for free between light and dark.
- **Pausable, Escape/close-box exit:** `P` toggles pause (`togglePause` in `engine.ts`), Escape and
  the `X` button both call `onClose`.
- **Keyboard and touch controls:** see above.
- **`prefers-reduced-motion`:** on load, if the OS prefers reduced motion, the game shows a notice
  explaining that this is a fast-scrolling game and asks for explicit opt-in before starting
  (`easter-calm-notice` in `EasterEgg.tsx`); if the player proceeds anyway, the backdrop grid stops
  scrolling and the invulnerability blink becomes a steady highlight instead of a flashing one
  (`draw()`'s `reducedMotion` branch), rather than pretending the whole genre can be made fully
  static.
- **Sound off unless the app's sound toggle is on:** `src/easter/sound.ts` gates every sound effect
  behind `isSoundEnabled()` from the existing `src/lib/floppy-sound.ts`, and reuses its Web-Audio
  (synthesized, no audio files) approach and try/catch-everywhere defensiveness.
- **High score in localStorage, try/catch:** `readHighScore`/`writeHighScoreIfBetter` in
  `engine.ts`, wrapped in try/catch exactly like the app's existing `floppy-sound.ts`/
  `ThemeToggle.tsx` persistence.
- **No copyrighted assets:** everything is hand-drawn `<canvas>` shapes and synthesized tones; no
  emulator, no ROM, no third-party game file.

### Tests

`packages/web/test/easter-engine.test.ts` — 14 unit tests against the pure `src/easter/engine.ts`
simulation (no canvas/DOM involved): initial state, deterministic RNG, pause no-op, player movement
and clamping, difficulty ramp, fire-rate cooldown, bullet travel/culling, spawn behavior, collision
(obstacle hit costs a life and grants invulnerability; running out of lives ends the game; a bullet
destroys a turret and scores; a pickup scores and is removed), and pause toggling. Full suite:

```
$ cd outfitter && npm ci && npm test --workspace=@outfitter/web && npm run build
...
 Test Files  9 passed (9)
      Tests  86 passed (86)   (14 of these are the new easter-egg tests)
```

`npm run build` also passed (`tsc --noEmit` clean across the monorepo, `vite build` clean).

### Lazy chunk size

```
dist/assets/EasterEgg-NaHS8OZM.js   9.60 kB   │ gzip: 3.75 kB
```

That's the entire game — engine, renderer, sound, React component — split out of
`dist/assets/index-*.js` (467 kB / 145 kB gzip, unchanged in shape from before this work) and only
fetched the moment `openEasterEgg()` or `/ready` runs.

### Screenshots

`docs/design/screenshots/easter-desktop.png` (1280×860) and
`docs/design/screenshots/easter-mobile.png` (390×844), both taken against a local
`packages/api` server (`OUTFITTER_DEV=1`, in-process sandbox) navigated straight to `/ready`. Note:
the Playwright CLI's `screenshot` command emulates viewport size only, not touch/coarse-pointer
input, so the on-screen touch controls (which key off `pointer: fine`/`hover: hover`) don't appear
in either screenshot even at phone width — they do render on an actual touch device or with a
proper device-emulation profile (e.g. Chrome DevTools' device toolbar, or Playwright's `devices["iPhone ..."]`
preset rather than a bare `--viewport-size`).

### What a full version would add

- **More enemy/obstacle variety** — a second turret type with a spread shot, a slow-moving "patrol"
  obstacle, maybe a one-off mini-boss at a distance milestone, for longer-run variety beyond the
  current two obstacle kinds.
- **A title/attract screen** with a brief demo loop and instructions, instead of dropping straight
  into gameplay — closer to how the real machines behaved, and gives the calm-mode notice a more
  natural home.
- **Global/shared high scores** are explicitly out of scope (the brief asked for localStorage only)
  but would be the natural next step if this becomes a real feature — e.g. an authenticated
  `/api/easter-egg/highscores` endpoint.
- **A second, composer-triggered entry point** (`LOAD"*",8,1` + `RUN`) and a `SYS 64738` menu-bar
  command, once the header/composer rework in flight lands and there's a stable place to add them
  without fighting an active rewrite.
- **Gamepad support** (the Gamepad API) — trivial to bolt onto the existing `GameInput` shape, main
  cost is the polling loop and a controller-detected UI hint.
- **A short "attract mode" easter-egg-of-the-easter-egg**: if left idle at the calm-motion notice or
  game-over screen for a while, cycle a couple of C64-style status messages (`READY.`, a blinking
  cursor) — cheap, in-theme polish.
