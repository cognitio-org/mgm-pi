// Pixel-art data for Dreadnought Run, drawn with shared/pixelSprite.ts. Original art throughout: the
// dreadnought is seen from above (light from the top-left: lit top/left plate edges, dark
// bottom/right seams), built from 16x16 hull tiles -- plain plates, seamed plates, rivet rows,
// vent grilles, round hatches, hazard stripes, pipe runs, runway asphalt -- in C64 greys, over a
// deeper C64-blue substructure layer (girders, ducts, cable trays) that scrolls at half speed and
// shows through trenches and the stepped hull edge. Tiles and the round/octagonal sprites are
// generated from small rules at module load rather than typed out cell by cell.

import type { Palette, Sprite } from "../shared/pixelSprite.ts";
import { C } from "../shared/palette.ts";

export const TILE = 16;

function grid(w: number, h: number, fn: (x: number, y: number) => string): Sprite {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) row += fn(x, y);
    rows.push(row);
  }
  return rows;
}

/** Deck plate base: lit top/left edge, dark bottom/right seam. */
function plate(x: number, y: number): string {
  if (y === TILE - 1 || x === TILE - 1) return "D";
  if (y === 0 || x === 0) return "L";
  return "M";
}

const corner = (x: number, y: number) => (x === 2 || x === 13) && (y === 2 || y === 13);

export const HULL_TILES: Record<string, Sprite> = {
  plate: grid(TILE, TILE, (x, y) => (corner(x, y) ? "H" : corner(x - 1, y - 1) ? "D" : plate(x, y))),
  seam: grid(TILE, TILE, (x, y) => (y === 7 && x > 0 ? "D" : y === 8 && x < 15 ? "L" : corner(x, y) ? "H" : plate(x, y))),
  rivets: grid(TILE, TILE, (x, y) =>
    (y === 4 || y === 11) && x % 3 === 1 && x < 15 ? "H" : (y === 5 || y === 12) && x % 3 === 2 ? "D" : plate(x, y),
  ),
  vent: grid(TILE, TILE, (x, y) => {
    if (x < 2 || x > 13 || y < 2 || y > 13) return plate(x, y);
    if (x === 2 || y === 2) return "D";
    if (x === 13 || y === 13) return "L";
    return y % 2 === 1 ? "K" : "L";
  }),
  hatch: grid(TILE, TILE, (x, y) => {
    const dx = x - 7.5;
    const dy = y - 7.5;
    const d = Math.hypot(dx, dy);
    if (d < 1.2) return "Y";
    if (d < 5) {
      if (Math.abs(dy) < 1 && Math.abs(dx) < 4) return "K"; // handle bar
      return dx + dy < -3.5 ? "H" : dx + dy > 4 ? "D" : "M";
    }
    if (d < 6.3) {
      const a = Math.atan2(dy, dx);
      if (Math.abs(Math.sin(a * 4)) < 0.25) return "H"; // bolts
      return dx + dy < 0 ? "D" : "L";
    }
    return plate(x, y);
  }),
  hazard: grid(TILE, TILE, (x, y) => (y >= 5 && y <= 10 ? ((x + y) % 6 < 3 ? "Y" : "K") : y === 4 || y === 11 ? "D" : plate(x, y))),
  pipes: grid(TILE, TILE, (x, y) => {
    const band = (top: number) => (y === top ? "H" : y === top + 1 ? "L" : y === top + 2 ? "M" : y === top + 3 ? "D" : "");
    const p = band(3) || band(9);
    if (p) return x % 8 === 5 ? (y === 3 || y === 9 ? "K" : "D") : p; // pipe clamps
    return plate(x, y);
  }),
  lights: grid(TILE, TILE, (x, y) => ((y === 7 || y === 8) && (x === 4 || x === 11) ? "o" : corner(x, y) ? "H" : plate(x, y))),
  runwayEdge: grid(TILE, TILE, (x, y) => (y === 2 ? "Y" : y === 1 || y === 3 ? "k" : y === 0 ? "D" : "k")),
  runwayMid: grid(TILE, TILE, (x, y) => ((y === 7 || y === 8) && x >= 3 && x <= 11 ? "W" : "k")),
  runwayChevron: grid(TILE, TILE, (x, y) => {
    const v = Math.abs(y - 7.5);
    const d = x - 3 - (7 - v) * 0.8;
    return d >= 0 && d < 3 ? "Y" : "k";
  }),
};

export const HULL_PALETTE: Palette = {
  K: C.black,
  D: C.darkGrey,
  M: C.grey,
  L: "#959595",
  H: "#c4c4c4",
  Y: C.yellow,
  o: C.cyan,
  k: "#2a2a2a",
  W: C.paper,
};

/** Half-speed substructure seen through trenches: girders, ducts, a cable tray with status lights. */
export const FAR_TILES: Record<string, Sprite> = {
  girder: grid(TILE, TILE, (x, y) => (x === y || x === TILE - 1 - y ? "l" : x === 0 || y === 0 ? "b" : "B")),
  duct: grid(TILE, TILE, (x, y) => (x % 8 === 1 ? "l" : x % 8 === 2 ? "B" : x % 8 === 6 ? "b" : y % 8 === 0 ? "b" : "B")),
  tray: grid(TILE, TILE, (x, y) => (y === 5 || y === 10 ? "l" : y > 5 && y < 10 ? (x % 4 === 1 && y === 7 ? "c" : "b") : "B")),
};
export const FAR_PALETTE: Palette = { B: C.blue, b: C.ink, l: "#6c5eb5", c: C.cyan };

// --- player ship: 28x14 twin-wing fighter, nose right ---------------------------------------------
const pad = (rows: string[], w: number) => rows.map((r) => r.padEnd(w, "."));
export const SHIP_SPRITE: Sprite = pad(
  [
    "..KKKK",
    "..KLLLKK",
    "...KLLLLKK",
    "....KWWWWLKKKK",
    ".KKKKWWWWWWWWWKKK",
    "KBBKWWWCCCCWWWWWWKKK",
    "KBBKWWCcccCCWWWWWWWWKKK",
    "KBBKWWCCCCCCWWWWWWWWWWSRK",
    "KBBKSSSSSSSSSSSSSSSSKKK",
    ".KKKKSSSSSSSSSSSKKK",
    "....KSSSSLKKKK",
    "...KLLLLKK",
    "..KLLLKK",
    "..KKKK",
  ],
  28,
);
export const SHIP_PALETTE: Palette = {
  K: C.black,
  W: C.paper,
  S: C.lightBlue,
  L: C.cyan,
  C: C.cyan,
  c: C.white,
  B: C.orange,
  R: C.lightRed,
};
export const SHIP_PALETTE_INVULN: Palette = { ...SHIP_PALETTE, W: C.yellow, S: C.orange };
export const SHIP_FLAME_FRAMES: Sprite[] = [
  ["..RO", ".ROY", "ROYW", "ROYW", ".ROY", "..RO"],
  ["...R", "..RO", ".ROY", ".ROY", "..RO", "...R"],
  ["..RO", "RROY", "ROYW", "ROYW", "RROY", "..RO"],
];
export const FLAME_PALETTE: Palette = { R: C.red, O: C.orange, Y: C.yellow, W: C.hot };

// --- turret: 18x18 octagonal gun emplacement, barrel aimed left at the player ---------------------
function turret(damaged: boolean): Sprite {
  return grid(18, 18, (x, y) => {
    const dx = x - 8.5;
    const dy = y - 8.5;
    // barrel: rows 8-9 from the left edge to the dome
    if (x <= 7 && (y === 8 || y === 9)) return y === 8 ? "L" : "G";
    if (x <= 7 && (y === 7 || y === 10)) return "K";
    const d = Math.max(Math.abs(dx), Math.abs(dy), (Math.abs(dx) + Math.abs(dy)) * 0.74);
    if (d > 8.6) return ".";
    if (d > 7.6) return "K";
    if (d > 6.2) {
      const seg = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * 12);
      return seg % 2 === 0 ? "Y" : "O";
    }
    if (d > 5.3) return "K";
    if (d < 1.6) return damaged ? "d" : "R";
    if (damaged && (x + y * 3) % 7 === 0) return "K"; // cracks
    return dx + dy < -2.5 ? "L" : dx + dy > 3 ? "D" : "G";
  });
}
export const TURRET_SPRITE = turret(false);
export const TURRET_SPRITE_DAMAGED = turret(true);
export const TURRET_PALETTE: Palette = {
  K: C.black,
  Y: C.yellow,
  O: C.orange,
  G: C.grey,
  L: C.lightGrey,
  D: C.darkGrey,
  R: C.lightRed,
  d: C.red,
};
export const TURRET_PALETTE_DAMAGED: Palette = { ...TURRET_PALETTE, Y: C.red, O: C.darkGrey, L: C.grey };

// --- drone: 16x16 quad-rotor, spinning rotors (2 frames) and a blinking eye -----------------------
function drone(frame: number): Sprite {
  const rotors = [
    [3.5, 3.5],
    [12.5, 3.5],
    [3.5, 12.5],
    [12.5, 12.5],
  ];
  return grid(16, 16, (x, y) => {
    const cx = x - 7.5;
    const cy = y - 7.5;
    const body = Math.hypot(cx, cy);
    if (body < 1.3) return frame === 0 ? "W" : "E";
    if (body < 3.6) return cx + cy < -2 ? "r" : "R";
    if (body < 4.6) return "K";
    for (const [rx, ry] of rotors) {
      const d = Math.hypot(x - rx!, y - ry!);
      if (d < 1) return "K";
      if (d < 3.6) {
        const a = Math.atan2(y - ry!, x - rx!);
        return Math.cos(2 * a + frame * Math.PI * 0.5) > 0.3 ? "P" : ".";
      }
    }
    if (Math.abs(Math.abs(cx) - Math.abs(cy)) < 0.8) return "K"; // arms
    return ".";
  });
}
export const DRONE_FRAMES: Sprite[] = [drone(0), drone(1)];
export const DRONE_PALETTE: Palette = { K: C.black, R: C.lightRed, r: C.white, W: C.white, E: C.red, P: C.lightGrey };

// --- floppy pickup: 12x12 3.5" disk seen from above, with a glint that sweeps across -------------
export const PICKUP_SPRITE: Sprite = [
  "KKKKKKKKKKK.",
  "KFFSSSSSSFFK",
  "KFFSSssSSFFK",
  "KFFSSssSSFFK",
  "KFFSSSSSSFFK",
  "KFFFFFFFFFFK",
  "KFWWWWWWWWFK",
  "KFWbbbbbbWFK",
  "KFWWWWWWWWFK",
  "KFWbbbbWWWFK",
  "KFWWWWWWWWFK",
  "KKKKKKKKKKKK",
];
export const PICKUP_PALETTE: Palette = { K: C.black, F: C.lightGreen, S: C.lightGrey, s: C.darkGrey, W: C.white, b: C.lightBlue };

// --- shots ----------------------------------------------------------------------------------------
export const BOLT_SPRITE: Sprite = [".bCWWWW.", "bCWWWWWW", ".bCWWWW."];
export const BOLT_PALETTE: Palette = { b: C.lightBlue, C: C.cyan, W: C.white };
export const ORB_FRAMES: Sprite[] = [
  [".KKK.", "KRYRK", "KYWYK", "KRYRK", ".KKK."],
  [".KKK.", "KYRYK", "KRWRK", "KYRYK", ".KKK."],
];
export const ORB_PALETTE: Palette = { K: C.black, R: C.lightRed, Y: C.yellow, W: C.white };

export const ICON_SHIP: Sprite = ["KK.....", "KWWWK..", "KWCWWWK", "KWWWK..", "KK....."];
export const ICON_SHIP_PALETTE: Palette = { K: C.lightBlue, W: C.paper, C: C.cyan };
