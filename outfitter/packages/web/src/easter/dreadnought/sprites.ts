// Hand-drawn pixel-art sprites for Dreadnought Run, drawn with shared/pixelSprite.ts. Sized so a
// scale of 2 lines up with the engine's collision boxes: ship 13x7 -> 26x14 (PLAYER_W/H), turret
// 10x10 -> 20x20, drone 9x9 -> 18x18, rack unit 13x10 -> 26x20 (tiled vertically to fill a rack's
// variable height), floppy pickup 5x5 -> 10x10.

import type { Palette, Sprite } from "../shared/pixelSprite.ts";

export const SPRITE_SCALE = 2;

export const SHIP_SPRITE: Sprite = [
  ".......H.....",
  "......HHH....",
  ".....HHHHH...",
  "CCCHHHHHHHHHE",
  ".....HHHHH...",
  "......HHH....",
  ".......H.....",
];

export const SHIP_PALETTE_NORMAL: Palette = { H: "#5cff8a", C: "#e4e0fb", E: "#f4cf3c" };
export const SHIP_PALETTE_INVULN: Palette = { H: "#f4cf3c", C: "#fff6cf", E: "#ff8a8a" };

export const RACK_UNIT_SPRITE: Sprite = [
  "RRRRRRRRRRRR.",
  "R.l.l.l.l.l.R",
  "R...........R",
  "R.l.l.l.l.l.R",
  "R...........R",
  "R.l.l.l.l.l.R",
  "RRRRRRRRRRRR.",
  "R...........R",
  "R.f.........R",
  "RRRRRRRRRRRR.",
];

export const RACK_PALETTE: Palette = { R: "#8b7cd8", l: "#3a3184", f: "#ff8a8a" };

export const TURRET_SPRITE: Sprite = [
  "....TT....",
  "...TTTT...",
  "..TTTTTT..",
  ".TTTTTTTT.",
  "BBBBBBBBBB",
  ".TTTTTTTT.",
  "..TTTTTT..",
  "...TTTT...",
  "....TT....",
  "....BB....",
];
export const TURRET_PALETTE: Palette = { T: "#f4cf3c", B: "#8b7cd8" };
export const TURRET_PALETTE_DAMAGED: Palette = { T: "#ff8a8a", B: "#8b7cd8" };

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

export const FLOPPY_SPRITE: Sprite = ["FFFFF", "F...F", "FFFFF", "FGGGF", "FFFFF"];
export const FLOPPY_PALETTE: Palette = { F: "#5cff8a", G: "#241e5c" };
