// Pixel-art sprites for Floppy Rescue. The helicopter is drawn from primitive rects directly in
// FloppyRescue.tsx (organic silhouette, rotor animation, tilt rotation -- easier to get right with
// rects than a hand-typed character grid). Everything else here is a small character-grid "sprite"
// via shared/pixelSprite.ts: a rack unit (tiled vertically to fill a rack's height, with rivets and
// a vent -- plus a scorched/damaged palette once fire reaches it), a flame (four frames, three-tone
// C64 orange/yellow/red flicker), a Floppy walker (two frames: legs mid-stride, a waving arm, and a
// visible disk-shutter label so it reads as a little floppy-disk character, not a blob), a stray
// debris chunk, and the glitch drone.

import type { Palette, Sprite } from "../shared/pixelSprite.ts";

export const SPRITE_SCALE = 1;

export const RACK_UNIT_SPRITE: Sprite = [
  "RRRRRRRRRRRR",
  "R.o......o.R",
  "R..........R",
  "R.===..===.R",
  "R..........R",
  "R.o......o.R",
  "R....l..l..R",
  "RRRRRRRRRRRR",
];
export const RACK_PALETTE: Palette = { R: "#8b7cd8", o: "#3a3184", "=": "#241e5c", l: "#5cff8a" };
// Once fire reaches a rack's cell: scorched frame, dark vents, and the status lights flip to a red
// alarm instead of phosphor green.
export const RACK_PALETTE_DAMAGED: Palette = { R: "#3a2e1a", o: "#241a10", "=": "#120d08", l: "#ff8a8a" };

export const FLAME_SPRITES: Sprite[] = [
  ["..Y..", ".OOO.", ".OOO.", "RRRRR", "RRRRR", ".RRR.", "..R.."],
  ["..Y..", "..Y..", ".OOO.", "OOOOO", "RRRRR", "RRRRR", ".RRR."],
  [".Y...", "OO...", "OOO..", "RRRR.", "RRRRR", ".RRR.", "..R.."],
  ["...Y.", "..OO.", ".OOO.", ".RRRR", "RRRRR", ".RRR.", "..R.."],
];
export const FLAME_PALETTE: Palette = { Y: "#f4cf3c", O: "#ff8a00", R: "#ff5a1f" };

export const SMOKE_COLOR = "#4a3f6e";
export const SPARK_COLOR = "#f4cf3c";

export const FLOPPY_WALKER_SPRITES: Sprite[] = [
  [
    "..FFFFF..",
    ".F.....F.",
    "F.......F.A",
    "FFFFFFFFF",
    "F.WWWWW.F",
    "F.WWWWW.F",
    "F.......F",
    "FFFFFFFFF",
    "F...O...F",
    ".F.....F.",
    "..FFFFF..",
    "...L.L...",
    "..L...L..",
  ],
  [
    "..FFFFF..",
    ".F.....F.",
    "F.......F",
    "FFFFFFFFF",
    "F.WWWWW.F",
    "F.WWWWW.F",
    "F.......F",
    "FFFFFFFFF",
    "F...O...F",
    ".F.....F.",
    "..FFFFF..",
    "..L...L..",
    ".L.....L.",
  ],
];
export const FLOPPY_PALETTE: Palette = { F: "#5cff8a", W: "#e4e0fb", O: "#241e5c", L: "#241e5c", A: "#f4cf3c" };

export const DEBRIS_SPRITE: Sprite = ["FF", "FF"];
export const DEBRIS_PALETTE: Palette = { F: "#f4cf3c" };

export const DRONE_SPRITE: Sprite = [
  "...DD....",
  "..DDDD...",
  ".DDDDDD..",
  "DDGGGGDD.",
  ".DDDDDD..",
  "..DDDD...",
  "...DD....",
];
export const DRONE_PALETTE: Palette = { D: "#ff8a8a", G: "#241e5c" };
