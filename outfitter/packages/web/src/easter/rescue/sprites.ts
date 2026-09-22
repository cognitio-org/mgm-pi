// Hand-drawn pixel-art sprites for Floppy Rescue, drawn with shared/pixelSprite.ts. The helicopter
// is 15x9 at scale 2 -> 30x18 (close to PLAYER_W/H, drawn a hair taller for the rotor disc). A
// little Floppy character is 5x7 at scale 2 -> 10x14. The rack unit tiles vertically like
// Dreadnought's, and a fire overlay is drawn per-cell from its own tiny flame sprite blended by
// intensity (see FloppyRescue.tsx).

import type { Palette, Sprite } from "../shared/pixelSprite.ts";

export const SPRITE_SCALE = 2;

// Facing right (flies left when tilted the other way -- FloppyRescue.tsx flips via ctx.scale(-1,1)).
export const HELI_SPRITE: Sprite = [
  ".......R.......",
  "RRRRRRRRRRRRRRR",
  ".......|.......",
  "....CCCCCCC....",
  "...CCCCCCCCC...",
  "BBBCCCCCCCCC...",
  "..B.........S..",
  "..B.........S..",
  "...............",
];

export const HELI_PALETTE: Palette = { R: "#8b7cd8", "|": "#8b7cd8", C: "#5cff8a", B: "#3a3184", S: "#3a3184" };
export const HELI_PALETTE_INVULN: Palette = { R: "#f4cf3c", "|": "#f4cf3c", C: "#f4cf3c", B: "#3a3184", S: "#3a3184" };

export const FLOPPY_WALKER_SPRITE: Sprite = ["FFFFF", "F...F", "FFFFF", ".GGG.", "F.G.F", ".GGG.", "F...F"];
export const FLOPPY_WALKER_PALETTE: Palette = { F: "#5cff8a", G: "#241e5c" };

export const RACK_UNIT_SPRITE: Sprite = [
  "RRRRRRRRRRRR.",
  "R.l.l.l.l.l.R",
  "R...........R",
  "R.l.l.l.l.l.R",
  "R...........R",
  "RRRRRRRRRRRR.",
];
export const RACK_PALETTE: Palette = { R: "#8b7cd8", l: "#3a3184" };

export const FLAME_SPRITES: Sprite[] = [
  [".F.", "FFF", "FGF"],
  [".G.", "FFF", "FGF"],
];
export const FLAME_PALETTE: Palette = { F: "#ff8a8a", G: "#f4cf3c" };

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
