// Pixel-art sprite data for Floppy Rescue (character grids + palettes, rendered by
// shared/pixelSprite.ts at 1 logical px per character). Everything is original art: a stubby white
// rescue chopper with a red belly stripe and passenger windows that light up green when it's
// carrying Floppies; Floppy characters (3.5" disks with a metal shutter for a hat, a label for a
// face, stick legs and waving arms, in five disk colours); server-rack cabinets with blinking LEDs
// and a scorched variant whose vents glow orange; a pine tree; the glitch drone; falling burning
// debris. Fire and smoke are procedural (see FloppyRescue.tsx) because they have to animate
// continuously at any size.

import type { Palette, Sprite } from "../shared/pixelSprite.ts";
import { C } from "../shared/palette.ts";

// --- helicopter: 32x14 body (collision box is 26x14; the sprite overhangs 3px each side) --------
export const HELI_BODY: Sprite = [
  ".................KK.............",
  "............KKKKKKKKKKKK........",
  ".KK........KBBBBBBBBBBBBKK......",
  ".KGK......KBBBBBBBBBBBBBBCK.....",
  ".KGK.....KBBBDDBDDBDDBBBBCCK....",
  ".KGGK...KBBBDDBDDBDDBBBBBCccK...",
  ".KGGGKKKKBBBBBBBBBBBBBBBBCcCCK..",
  ".KGGGGGGGBBBBBBBBBBBBBBBBCCCCCK.",
  "..KKKKKKKRRRRRRRRRRRRRRRRRRRRRK.",
  ".........KbbbbbbbbbbbbbbbbbbbbK.",
  "..........KbbbbbbbbbbbbbbbbbbK..",
  "...........KKKKKKKKKKKKKKKKKK...",
  "..............G.......G......G..",
  "..........GGGGGGGGGGGGGGGGGGGG..",
];
export const HELI_PALETTE: Palette = {
  K: C.black,
  B: C.paper,
  b: C.lightGrey,
  R: C.red,
  G: C.grey,
  C: C.cyan,
  c: C.white,
  D: C.blue,
};
/** Same chopper with Floppies at the passenger windows. */
export const HELI_PALETTE_LOADED: Palette = { ...HELI_PALETTE, D: C.lightGreen };
export const HELI_PALETTE_INVULN: Palette = { ...HELI_PALETTE, B: C.yellow, b: C.orange };

/** Main rotor, drawn 2 rows above the body: long blade, foreshortened, mid -- a 3-frame spin. */
export const ROTOR_FRAMES: Sprite[] = [
  ["...GLLLLLLLLLLLLLLLLLLLLLLLLLLG.", "................KKKK............"],
  [".........GLLLLLLLLLLLLLLG.......", "................KKKK............"],
  [".....GGLLLLLLLLLLLLLLLLLLLGG....", "................KKKK............"],
];
export const ROTOR_PALETTE: Palette = { L: C.lightGrey, G: C.grey, K: C.black };

/** Tail rotor (drawn at the fin), 2 frames. */
export const TAIL_ROTOR_FRAMES: Sprite[] = [
  ["L", "L", "L", "L", "L", "L", "L"],
  [".", ".", "G", "L", "G", ".", "."],
];

// --- Floppy characters: 11x12, walk A / walk B / wave ---------------------------------------------
const FLOPPY_TOP = [".KKKKKKKKK.", ".KCSSSSSCK.", ".KCSSsSSCK.", ".KCSSSSSCK.", ".KCCCCCCCK."];
const FLOPPY_FACE = [".KWEWWWEWK.", ".KWWEEEWWK.", ".KKKKKKKKK."];
export const FLOPPY_FRAMES: Sprite[] = [
  [...FLOPPY_TOP, "LKWWWWWWWKL", ...FLOPPY_FACE, "...L...L...", "..L.....L..", ".KK.....KK."],
  [...FLOPPY_TOP, "LKWWWWWWWKL", ...FLOPPY_FACE, "....L.L....", "....L.L....", "...KK.KK..."],
  [
    ".KKKKKKKKK.",
    "LKCSSSSSCK.",
    "LKCSSsSSCK.",
    "LKCSSSSSCK.",
    ".KCCCCCCCK.",
    ".KWWWWWWWKL",
    ...FLOPPY_FACE,
    "...L...L...",
    "...L...L...",
    "..KK...KK..",
  ],
];
const FLOPPY_BASE: Palette = { K: C.black, S: C.lightGrey, s: C.darkGrey, W: C.white, E: C.black, L: C.paper };
/** Five disk colours so a crowd of Floppies reads as individuals. */
export const FLOPPY_PALETTES: Palette[] = [C.lightGreen, C.cyan, C.yellow, C.lightRed, C.lightBlue].map((c) => ({
  ...FLOPPY_BASE,
  C: c,
}));

// --- server rack cabinet: 12x24, four units with LEDs and vents -----------------------------------
const RACK_UNIT = ["KGFFFFFFFFGK", "KGFaFbFFvvGK", "KGFFFFFFFFGK", "KGGGGGGGGGGK"];
const RACK_UNIT_2 = ["KGFFFFFFFFGK", "KGFbFaFFvvGK", "KGFFFFFFFFGK", "KGGGGGGGGGGK"];
export const RACK_SPRITE: Sprite = [
  "KKKKKKKKKKKK",
  "KGGGGGGGGGGK",
  ...RACK_UNIT,
  ...RACK_UNIT_2,
  ...RACK_UNIT,
  ...RACK_UNIT_2,
  ...RACK_UNIT,
  "KhGGGGGGGGhK",
  "KKKKKKKKKKKK",
];
export const RACK_H = RACK_SPRITE.length;
export const RACK_W = 12;
export const RACK_PALETTES: Palette[] = [
  { K: C.black, G: C.grey, F: C.darkGrey, v: C.black, h: C.lightGrey, a: C.lightGreen, b: C.darkGrey },
  { K: C.black, G: C.grey, F: C.darkGrey, v: C.black, h: C.lightGrey, a: C.darkGrey, b: C.lightGreen },
];
/** Scorched: blackened frame, red alarm LEDs, fire glowing through the vents. */
export const RACK_PALETTES_BURNING: Palette[] = [
  { K: C.black, G: C.darkGrey, F: "#1c1414", v: C.orange, h: C.grey, a: C.lightRed, b: C.red },
  { K: C.black, G: C.darkGrey, F: "#1c1414", v: C.yellow, h: C.grey, a: C.red, b: C.lightRed },
];

// --- scenery ---------------------------------------------------------------------------------------
export const PINE_SPRITE: Sprite = [
  "....K....",
  "...KgK...",
  "..KgGGK..",
  "...KGK...",
  "..KgGGK..",
  ".KgGGGGK.",
  "..KGGGK..",
  ".KgGGGGK.",
  "KgGGGGGGK",
  "KKKKTKKKK",
  "....T....",
  "....T....",
];
export const PINE_PALETTE: Palette = { K: "#16301c", G: "#2e6b3e", g: C.green, T: C.brown };

export const BUSH_SPRITE: Sprite = ["..KKK..", ".KgGGK.", "KgGGGGK", "KGGGGGK"];

export const MOON_SPRITE: Sprite = [
  "...WWWWW...",
  ".WWWWWWWPW.",
  ".WWPWWWWWW.",
  "WWWWWWWWWWP",
  "WWWWWWPWWWW",
  "WWPPWWWWWWP",
  "WWWWWWWWWPP",
  "WWWWWWWWWPP",
  ".WWWWWWWPP.",
  ".WWWWWWPPP.",
  "...PPPPP...",
];
export const MOON_PALETTE: Palette = { W: C.paper, P: C.lightBlue };

// --- glitch drone (13x8) and its shots ------------------------------------------------------------
const DRONE_BODY = [".KKKKKKKKKKK.", "KRRRRRRRRRRRK"];
export const DRONE_FRAMES: Sprite[] = [
  ["LLLLL...LLLLL", "..K.......K..", ...DRONE_BODY, "KRRWWWWWRRRRK", "KRRWEEWWRRRRK", ".KRRRRRRRRRK.", "..KK.....KK.."],
  ["..LL.....LL..", "..K.......K..", ...DRONE_BODY, "KRRWWWWWRRRRK", "KRRWWEEWRRRRK", ".KRRRRRRRRRK.", "..KK.....KK.."],
];
export const DRONE_PALETTE: Palette = { K: C.black, R: C.lightRed, W: C.white, E: C.black, L: C.lightGrey };
export const SHOT_FRAMES: Sprite[] = [
  ["YWY", "WWW", "YWY"],
  [".R.", "RYR", ".R."],
];
export const SHOT_PALETTE: Palette = { Y: C.yellow, W: C.white, R: C.lightRed };

// --- falling burning debris: a metal chunk with a 2-frame flame trail above it --------------------
export const DEBRIS_FRAMES: Sprite[] = [
  ["..R..", ".ROR.", ".OYO.", "KGLGK", "GGKGG", ".KGK."],
  [".R.R.", "..O..", ".OYO.", "KGLGK", "GGKGG", ".KGK."],
];
export const DEBRIS_PALETTE: Palette = { R: C.red, O: C.orange, Y: C.yellow, K: C.black, G: C.grey, L: C.lightGrey };

/** Tiny HUD icons: a Floppy (onboard counter) and a chopper (lives). */
export const ICON_FLOPPY: Sprite = ["KKK", "CSC", "WWW"];
export const ICON_FLOPPY_ON: Palette = { K: C.black, C: C.lightGreen, S: C.lightGrey, W: C.white };
export const ICON_FLOPPY_OFF: Palette = { K: C.darkGrey, C: C.ink, S: C.ink, W: C.darkGrey };
export const ICON_HELI: Sprite = ["..KKKKK", "G.BBBCK", "GBBBBBK", "..G..G."];
export const ICON_HELI_PALETTE: Palette = { K: C.lightGrey, B: C.paper, C: C.cyan, G: C.grey };
