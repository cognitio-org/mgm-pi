// Pixel-art sprites for Floppy Rescue. The helicopter is drawn from primitive rects directly in
// FloppyRescue.tsx (organic silhouette, rotor animation, tilt rotation -- easier to get right with
// rects than a hand-typed character grid). Everything else here is a small character-grid "sprite"
// via shared/pixelSprite.ts: a rack unit (tiled vertically to fill a rack's height, with rivets and
// a vent so it doesn't read as a flat block), a flame (two frames, flicker), a Floppy walker (two
// frames: legs mid-stride, arm raised/lowered -- a little wave), a stray debris chunk, and the
// glitch drone.

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

export const FLAME_SPRITES: Sprite[] = [
  ["..F..", ".FFF.", "FFFFF", "FGGGF", ".GGG.", "..G.."],
  ["..G..", ".FGF.", "FFFFF", "GFFFG", ".FFF.", "..F.."],
];
export const FLAME_PALETTE: Palette = { F: "#ff8a8a", G: "#f4cf3c" };

export const FLOPPY_WALKER_SPRITES: Sprite[] = [
  [
    ".FFFFF...",
    "F.....F.A",
    "FFFFFFF.A",
    "F.WWW.F..",
    "F.....F..",
    ".FFFFF...",
    "..L..L...",
    "..L..L...",
    ".L....L..",
    ".........",
  ],
  [
    ".FFFFF...",
    "F.....F..",
    "FFFFFFF..",
    "F.WWW.F..",
    "F.....F..",
    ".FFFFF...",
    "..L..L...",
    ".L....L..",
    "L......L.",
    ".........",
  ],
];
export const FLOPPY_PALETTE: Palette = { F: "#5cff8a", W: "#241e5c", L: "#241e5c", A: "#f4cf3c" };

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
