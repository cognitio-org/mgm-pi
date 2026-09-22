// Dreadnought Run's renderer: one frame of GameState onto the low-res logical canvas (viewW x 132,
// integer-scaled in CSS -- see shared/screen.ts). Pure drawing, no game logic.
//
// The dreadnought, seen from above, scrolling left under the ship:
//   space + stars (0.1x) -> substructure layer (0.5x: girders, ducts, cable trays in C64 blue)
//   -> the deck (1.0x, the same speed as the obstacles sitting on it): 16x16 grey hull tiles in
//      7 rows, broken by trenches and a stepped outer edge so the half-speed layer shows through,
//      with drop shadows onto it -> structures on the deck: antenna towers, a lit runway strip,
//      and every CYCLE columns (384px, ~7.5s at the starting scroll speed) a big landmark,
//      alternating a stepped bridge tower (lit windows, spinning radar, mast) and a hangar door
//      (hazard-striped frame, ribbed doors, painted bay number, warning lights)
//   -> pickups, obstacles (with shadows), shots, particles, blasts, ship, score pops, HUD.
// Everything on the hull is a deterministic function of its world column, so a stretch of ship
// always looks the same when it scrolls past.

import { PLAYER_H, PLAYER_MAX_Y, PLAYER_MIN_Y, PLAYER_X, WORLD_H, type GameState, type Obstacle } from "./engine.ts";
import { C } from "../shared/palette.ts";
import { drawText } from "../shared/font.ts";
import { ditherSprite, drawSprite, flashPalette, hash2, solidPalette, type Palette, type Sprite } from "../shared/pixelSprite.ts";
import { drawBlasts, drawParticles, drawPopups, type Blast } from "../shared/fx.ts";
import { shakeOffset, type FlashState, type Particle, type ShakeState, type TextPopup } from "../shared/particles.ts";
import { probe, probeActive, probeReset } from "../shared/probe.ts";
import {
  BOLT_PALETTE,
  BOLT_SPRITE,
  DRONE_FRAMES,
  DRONE_PALETTE,
  FAR_PALETTE,
  FAR_TILES,
  FLAME_PALETTE,
  HULL_PALETTE,
  HULL_TILES,
  ICON_SHIP,
  ICON_SHIP_PALETTE,
  ORB_FRAMES,
  ORB_PALETTE,
  PICKUP_PALETTE,
  PICKUP_SPRITE,
  SHIP_FLAME_FRAMES,
  SHIP_PALETTE,
  SHIP_PALETTE_INVULN,
  SHIP_SPRITE,
  TILE,
  TURRET_PALETTE,
  TURRET_PALETTE_DAMAGED,
  TURRET_SPRITE,
  TURRET_SPRITE_DAMAGED,
} from "./sprites.ts";

export interface DreadnoughtFrame {
  state: GameState;
  viewW: number;
  particles: Particle[];
  blasts: Blast[];
  popups: TextPopup[];
  shake: ShakeState | null;
  flash: FlashState | null;
  reducedMotion: boolean;
  screen: "title" | "game";
  highScore: number;
}

// --- hull layout ----------------------------------------------------------------------------------
const HULL_Y0 = PLAYER_MIN_Y; // 8: outer rim
const HULL_Y1 = PLAYER_MAX_Y + PLAYER_H; // 124
const DECK_Y0 = HULL_Y0 + 2; // first tile row
const ROWS = 7; // 7 x 16 = 112px of deck, y 10..122
const CYCLE = 24; // columns per landmark cycle
const LANDMARK_K0 = 8;
const LANDMARK_COLS = 4;
const RUNWAY_K0 = 14;
const RUNWAY_K1 = 21;
const RUNWAY_BOTTOM: Sprite = [...HULL_TILES.runwayEdge!].reverse();
const SHADOW = "#0e0b2e";

/** A 2x2 checkerboard fill in the shadow colour: shadows are dithered (see-through, C64-style),
 * never opaque blobs. Patterns anchor to the canvas origin, so adjacent shadows mesh seamlessly. */
let shadowPattern: CanvasPattern | null | undefined;
function shadowFill(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  if (shadowPattern === undefined) {
    shadowPattern = null;
    if (typeof document !== "undefined") {
      const c = document.createElement("canvas");
      c.width = 2;
      c.height = 2;
      const pctx = c.getContext("2d");
      if (pctx) {
        pctx.fillStyle = SHADOW;
        pctx.fillRect(0, 0, 1, 1);
        pctx.fillRect(1, 1, 1, 1);
        shadowPattern = ctx.createPattern(c, "repeat");
      }
    }
  }
  return shadowPattern ?? SHADOW;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Is there deck at world column c, tile row r? Trenches every cycle, stepped edges on rows 0/6. */
function deckAt(c: number, r: number): boolean {
  if (r < 0 || r >= ROWS) return false;
  const k = mod(c, CYCLE);
  if (k < 2) return false; // trench between hull sections
  if (r === 0) return (k >= 2 && k <= 9) || (k >= 13 && k <= 19);
  if (r === ROWS - 1) return (k >= 4 && k <= 12) || (k >= 16 && k <= 22);
  return true;
}

function tileFor(c: number, r: number): [string, Sprite] {
  const k = mod(c, CYCLE);
  if (k >= RUNWAY_K0 && k <= RUNWAY_K1 && r >= 2 && r <= 4) {
    if (k === RUNWAY_K0) return ["runway", HULL_TILES.runwayChevron!];
    if (r === 2) return ["runway", HULL_TILES.runwayEdge!];
    if (r === 4) return ["runway", RUNWAY_BOTTOM];
    return ["runway", HULL_TILES.runwayMid!];
  }
  const h = hash2(c, r * 31 + 7) % 100;
  const kind =
    h < 34 ? "plate" : h < 48 ? "seam" : h < 60 ? "rivets" : h < 71 ? "vent" : h < 80 ? "hatch" : h < 88 ? "pipes" : h < 95 ? "lights" : "hazard";
  return [kind, HULL_TILES[kind]!];
}

const HULL_PALETTE_DIM: Palette = { ...HULL_PALETTE, o: "#2a5a60" };

// --- layers ----------------------------------------------------------------------------------------
function drawSpace(ctx: CanvasRenderingContext2D, viewW: number, distance: number, t: number): void {
  ctx.fillStyle = C.black;
  ctx.fillRect(0, 0, viewW, WORLD_H);
  const par = distance * 0.1;
  for (let i = 0; i < 40; i++) {
    const h = hash2(i, 5);
    const x = Math.round(mod((h % 400) - par * (1 + (h % 3) * 0.5), 400));
    if (x >= viewW) continue;
    const y = (h >> 9) % WORLD_H;
    ctx.fillStyle = (h >> 4) % 5 === 0 && Math.floor(t / 300 + i) % 4 === 0 ? C.white : (h >> 6) % 2 ? C.lightBlue : C.grey;
    ctx.fillRect(x, y, 1, 1);
  }
}

function drawFar(ctx: CanvasRenderingContext2D, viewW: number, off: number, kinds: Set<string>): void {
  const first = Math.floor(off / TILE);
  const shift = Math.round(off - first * TILE);
  const names = Object.keys(FAR_TILES);
  for (let i = 0; i * TILE - shift < viewW; i++) {
    const c = first + i;
    for (let r = 0; r < 8; r++) {
      const name = names[hash2(c, r + 99) % names.length]!;
      const y = HULL_Y0 + r * TILE - 4;
      drawSprite(ctx, FAR_TILES[name]!, FAR_PALETTE, i * TILE - shift, y);
      kinds.add(`tile:far-${name}`);
    }
  }
  // the substructure only exists inside the hull band
  ctx.fillStyle = C.black;
  ctx.fillRect(0, 0, viewW, HULL_Y0);
  ctx.fillRect(0, HULL_Y1, viewW, WORLD_H - HULL_Y1);
}

function drawDeck(ctx: CanvasRenderingContext2D, viewW: number, off: number, t: number, kinds: Set<string>): void {
  const first = Math.floor(off / TILE) - 1;
  const shift = Math.round(off - Math.floor(off / TILE) * TILE);
  const cols = Math.ceil(viewW / TILE) + 2;
  // shadows first: every deck tile casts a 4px shadow down-right onto the substructure
  ctx.fillStyle = SHADOW;
  for (let i = 0; i < cols; i++) {
    const c = first + i;
    const x = (i - 1) * TILE - shift;
    for (let r = 0; r < ROWS; r++) {
      if (!deckAt(c, r)) continue;
      const y = DECK_Y0 + r * TILE;
      if (!deckAt(c + 1, r)) ctx.fillRect(x + TILE, y + 4, 5, TILE);
      if (!deckAt(c, r + 1) && r < ROWS - 1) ctx.fillRect(x + 4, y + TILE, TILE, 5);
    }
  }
  // outer rim of the hull band (skipped across trenches)
  for (let i = 0; i < cols; i++) {
    const c = first + i;
    const x = (i - 1) * TILE - shift;
    if (mod(c, CYCLE) < 2) continue;
    ctx.fillStyle = C.darkGrey;
    ctx.fillRect(x, HULL_Y0, TILE, 2);
    ctx.fillRect(x, HULL_Y1 - 2, TILE, 2);
    ctx.fillStyle = "#959595";
    ctx.fillRect(x, HULL_Y0, TILE, 1);
    ctx.fillRect(x, HULL_Y1 - 2, TILE, 1);
  }
  const blink = Math.floor(t / 450);
  for (let i = 0; i < cols; i++) {
    const c = first + i;
    const x = (i - 1) * TILE - shift;
    for (let r = 0; r < ROWS; r++) {
      if (!deckAt(c, r)) continue;
      const [kind, tile] = tileFor(c, r);
      const pal = kind === "lights" && (blink + hash2(c, r)) % 3 === 0 ? HULL_PALETTE_DIM : HULL_PALETTE;
      const y = DECK_Y0 + r * TILE;
      drawSprite(ctx, tile, pal, x, y);
      kinds.add(`tile:${kind}`);
      // a bright lip where the deck ends above a gap
      if (!deckAt(c, r - 1) && r > 0) {
        ctx.fillStyle = "#c4c4c4";
        ctx.fillRect(x, y, TILE, 1);
      }
      if (!deckAt(c - 1, r)) {
        ctx.fillStyle = "#c4c4c4";
        ctx.fillRect(x, y, 1, TILE);
      }
    }
  }
}

/** Chasing runway lights along both edges of the runway strip. */
function drawRunwayLights(ctx: CanvasRenderingContext2D, viewW: number, off: number, t: number, reducedMotion: boolean): void {
  const first = Math.floor(off / TILE) - 1;
  const shift = Math.round(off - Math.floor(off / TILE) * TILE);
  const chase = reducedMotion ? 0 : Math.floor(t / 70);
  for (let i = 0; i < Math.ceil(viewW / TILE) + 2; i++) {
    const c = first + i;
    const k = mod(c, CYCLE);
    if (k <= RUNWAY_K0 || k > RUNWAY_K1) continue;
    const x = (i - 1) * TILE - shift;
    for (let j = 0; j < 2; j++) {
      const lx = x + 4 + j * 8;
      const lit = reducedMotion ? true : mod(c * 2 + j - chase, 8) < 2;
      for (const ly of [DECK_Y0 + 2 * TILE + 5, DECK_Y0 + 5 * TILE - 6]) {
        ctx.fillStyle = lit ? C.white : "#6a5a20";
        ctx.fillRect(lx, ly, 2, 1);
        if (lit) {
          ctx.fillStyle = C.yellow;
          ctx.fillRect(lx - 1, ly, 1, 1);
          ctx.fillRect(lx + 2, ly, 1, 1);
          ctx.fillRect(lx, ly - 1, 2, 1);
          ctx.fillRect(lx, ly + 1, 2, 1);
        }
      }
    }
  }
}

function drawAntenna(ctx: CanvasRenderingContext2D, x: number, baseY: number, t: number, phase: number): void {
  // shadow falls down-right
  ctx.fillStyle = SHADOW;
  for (let i = 0; i < 12; i++) ctx.fillRect(x + 5 + i, baseY + 3 + Math.floor(i / 2), 1, 1);
  ctx.fillStyle = C.black;
  ctx.fillRect(x, baseY - 1, 9, 7);
  ctx.fillStyle = C.darkGrey;
  ctx.fillRect(x + 1, baseY, 7, 5);
  ctx.fillStyle = "#959595";
  ctx.fillRect(x + 1, baseY, 7, 1);
  // mast
  ctx.fillStyle = C.lightGrey;
  ctx.fillRect(x + 4, baseY - 17, 1, 17);
  ctx.fillStyle = C.darkGrey;
  ctx.fillRect(x + 5, baseY - 16, 1, 16);
  ctx.fillStyle = C.lightGrey;
  ctx.fillRect(x + 1, baseY - 13, 7, 1);
  ctx.fillRect(x + 2, baseY - 8, 5, 1);
  const on = Math.floor(t / 400 + phase) % 2 === 0;
  ctx.fillStyle = on ? C.lightRed : C.red;
  ctx.fillRect(x + 3, baseY - 19, 3, 2);
  if (on) {
    ctx.fillStyle = C.white;
    ctx.fillRect(x + 4, baseY - 19, 1, 1);
  }
}

function drawBridgeTower(ctx: CanvasRenderingContext2D, x0: number, t: number, n: number, reducedMotion: boolean): void {
  // A stepped superstructure seen from above at a slight angle: each deck is a roof (lit top-left
  // edge) with its south wall visible underneath, the forward (right) corners raked back like a
  // ship's bridge. Base deckhouse with portholes -> bridge deck with a continuous window band and
  // bridge wings -> a radar platform with a sweeping scanner -> a lattice mast. Plus a funnel.
  ctx.fillStyle = shadowFill(ctx);
  ctx.fillRect(x0 + 10, 30, 56, 76);
  const deck = (x: number, y: number, w: number, h: number, wall: number, rake: number, roof: string) => {
    for (let j = -1; j < h + wall + 1; j++) {
      const cut = Math.max(0, rake - Math.max(0, j));
      ctx.fillStyle = C.black;
      ctx.fillRect(x - 1, y + j, w + 2 - cut, 1);
      if (j < 0 || j >= h + wall) continue;
      ctx.fillStyle = j < h ? (j === 0 ? C.white : roof) : C.darkGrey;
      ctx.fillRect(x, y + j, w - cut, 1);
      if (j < h) {
        ctx.fillStyle = C.white;
        ctx.fillRect(x, y + j, 1, 1);
      }
    }
  };
  const windows = (x: number, y: number, w: number, step: number, size: number, color: string, seed: number) => {
    for (let wx = x; wx < x + w; wx += step) {
      const on = (hash2(wx, seed) + (reducedMotion ? 0 : Math.floor(t / 1700))) % 6 !== 0;
      ctx.fillStyle = on ? color : C.black;
      ctx.fillRect(wx, y, size, 2);
    }
  };
  // base deckhouse
  deck(x0 + 2, 44, 58, 40, 8, 10, "#959595");
  windows(x0 + 4, 87, 46, 5, 2, C.yellow, n);
  ctx.fillStyle = C.grey;
  for (let i = 0; i < 5; i++) ctx.fillRect(x0 + 6 + i * 4, 74, 2, 6); // roof vents
  drawText(ctx, `DN${10 + (n % 80)}`, x0 + 30, 75, C.darkGrey);
  // funnel, venting a glow
  ctx.fillStyle = C.black;
  ctx.fillRect(x0 + 45, 64, 12, 16);
  ctx.fillStyle = C.darkGrey;
  ctx.fillRect(x0 + 46, 65, 10, 14);
  ctx.fillStyle = C.black;
  ctx.fillRect(x0 + 47, 66, 8, 5);
  ctx.fillStyle = Math.floor(t / 200) % 2 === 0 || reducedMotion ? C.orange : C.red;
  ctx.fillRect(x0 + 48, 67, 6, 3);
  // bridge deck with bridge wings and the window band across its front
  deck(x0 - 2, 52, 8, 6, 3, 0, C.lightGrey);
  deck(x0 + 10, 30, 40, 24, 7, 8, C.lightGrey);
  ctx.fillStyle = C.cyan;
  ctx.fillRect(x0 + 11, 56, 30, 3);
  ctx.fillStyle = C.white;
  for (let wx = x0 + 12; wx < x0 + 40; wx += 6) ctx.fillRect(wx, 56, 2, 1);
  ctx.fillStyle = C.black;
  for (let wx = x0 + 15; wx < x0 + 41; wx += 6) ctx.fillRect(wx, 56, 1, 3);
  // radar platform + sweeping scanner
  deck(x0 + 18, 22, 18, 12, 4, 4, "#c4c4c4");
  const cx = x0 + 26;
  const cy = 28;
  const a = reducedMotion ? 0.6 : Math.floor(t / 90) * (Math.PI / 8);
  ctx.fillStyle = C.black;
  ctx.fillRect(Math.round(cx - Math.cos(a) * 5), Math.round(cy - Math.sin(a) * 2) - 1, 1, 3);
  for (let r = -5; r <= 5; r++) {
    ctx.fillStyle = r === 0 ? C.black : C.lightGreen;
    ctx.fillRect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r * 0.4), 1, 1);
  }
  // lattice mast behind the platform, with a yardarm and a blinking red tip
  ctx.fillStyle = C.lightGrey;
  ctx.fillRect(x0 + 40, 9, 1, 26);
  ctx.fillRect(x0 + 43, 9, 1, 26);
  for (let y = 11; y < 34; y += 4) ctx.fillRect(x0 + 41, y, 2, 1);
  ctx.fillRect(x0 + 36, 14, 12, 1);
  ctx.fillStyle = Math.floor(t / 350) % 2 === 0 ? C.lightRed : C.red;
  ctx.fillRect(x0 + 40, 7, 4, 2);
}

function drawHangarDoor(ctx: CanvasRenderingContext2D, x0: number, t: number, n: number, reducedMotion: boolean): void {
  const x = x0 + 2;
  const y = 26;
  const w = 60;
  const h = 76;
  // hazard-striped frame
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const edge = i < 3 || j < 3 || i >= w - 3 || j >= h - 3;
      if (!edge) continue;
      ctx.fillStyle = (i + j) % 6 < 3 ? C.yellow : C.black;
      ctx.fillRect(x + i, y + j, 1, 1);
    }
  }
  // recess shadow (top/left inside the frame -- the doors sit below deck level)
  ctx.fillStyle = C.black;
  ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
  // two ribbed door leaves with a centre split
  const leafW = (w - 6 - 4) / 2;
  for (let leaf = 0; leaf < 2; leaf++) {
    const lx = x + 5 + leaf * (leafW + 2);
    const ly = y + 5;
    const lh = h - 10;
    ctx.fillStyle = C.darkGrey;
    ctx.fillRect(lx, ly, leafW, lh);
    for (let ry = ly + 3; ry < ly + lh - 1; ry += 6) {
      ctx.fillStyle = C.grey;
      ctx.fillRect(lx, ry, leafW, 1);
      ctx.fillStyle = "#2a2a2a";
      ctx.fillRect(lx, ry + 1, leafW, 1);
    }
  }
  // painted bay number across both leaves
  drawText(ctx, String((n % 9) + 1).padStart(2, "0"), x + w / 2, y + 26, "#c4c4c4", { scale: 3, align: "center", shadow: C.black });
  // warning lights in the frame corners, alternating
  const phase = reducedMotion ? 0 : Math.floor(t / 300) % 2;
  const corners: Array<[number, number]> = [
    [x + 4, y + 4],
    [x + w - 7, y + 4],
    [x + 4, y + h - 7],
    [x + w - 7, y + h - 7],
  ];
  corners.forEach(([lx, ly], i) => {
    ctx.fillStyle = (i + phase) % 2 === 0 ? C.orange : C.red;
    ctx.fillRect(lx, ly, 3, 3);
    if ((i + phase) % 2 === 0) {
      ctx.fillStyle = C.yellow;
      ctx.fillRect(lx + 1, ly + 1, 1, 1);
    }
  });
}

function drawStructures(
  ctx: CanvasRenderingContext2D,
  viewW: number,
  off: number,
  t: number,
  reducedMotion: boolean,
): void {
  const first = Math.floor(off / TILE) - LANDMARK_COLS - 1;
  const shift = off - Math.floor(off / TILE) * TILE;
  const cols = Math.ceil(viewW / TILE) + LANDMARK_COLS + 3;
  for (let i = 0; i < cols; i++) {
    const c = first + i;
    const k = mod(c, CYCLE);
    const n = Math.floor(c / CYCLE);
    const x = Math.round((c - Math.floor(off / TILE)) * TILE - shift);
    if (k === 4) drawAntenna(ctx, x + 4, DECK_Y0 + 12, t, n);
    if (k === 18) drawAntenna(ctx, x + 3, DECK_Y0 + 6 * TILE + 8, t, n + 1);
    if (k === LANDMARK_K0) {
      if (x > viewW || x + LANDMARK_COLS * TILE < -8) continue;
      if (n % 2 === 0) drawBridgeTower(ctx, x, t, n, reducedMotion);
      else drawHangarDoor(ctx, x, t, n, reducedMotion);
      if (probeActive()) probe(`landmark:${n % 2 === 0 ? "bridge" : "hangar"}:${n}`, x, 10, LANDMARK_COLS * TILE, 112);
    }
  }
}

// --- obstacles -------------------------------------------------------------------------------------
function drawRack(ctx: CanvasRenderingContext2D, o: Obstacle, t: number): void {
  const x = Math.round(o.x);
  const y = Math.round(o.y);
  const { w, h } = o;
  ctx.fillStyle = shadowFill(ctx);
  ctx.fillRect(x + 4, y + 4, w, h);
  ctx.fillStyle = C.black;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = C.ink;
  ctx.fillRect(x + 1, y + 1, w - 2, h - 5);
  ctx.fillStyle = C.lightBlue;
  ctx.fillRect(x + 1, y + 1, w - 2, 1);
  ctx.fillRect(x + 1, y + 1, 1, h - 5);
  // units: a separator line, a row of LEDs, a vent slot
  for (let uy = y + 3, u = 0; uy < y + h - 7; uy += 7, u++) {
    ctx.fillStyle = C.blue;
    ctx.fillRect(x + 2, uy + 5, w - 4, 1);
    for (let j = 0; j < 4; j++) {
      const on = (hash2(Math.round(o.y) * 7 + u, j) + Math.floor(t / 180)) % 3 !== 0;
      ctx.fillStyle = on ? (j === 3 ? C.yellow : C.lightGreen) : C.darkGrey;
      ctx.fillRect(x + 3 + j * 3, uy + 1, 2, 1);
    }
    ctx.fillStyle = C.black;
    ctx.fillRect(x + w - 9, uy + 1, 6, 2);
  }
  // south face (its height, seen at an angle)
  ctx.fillStyle = C.blue;
  ctx.fillRect(x + 1, y + h - 4, w - 2, 3);
  ctx.fillStyle = C.lightRed;
  ctx.fillRect(x + w - 5, y + h - 3, 2, 1);
}

// --- HUD -------------------------------------------------------------------------------------------
function pad6(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(6, "0");
}

/** One row of status in the strip of open space above the hull (y 0-7), so it never covers the
 * ship, which flies over the hull band below it. */
function drawHud(ctx: CanvasRenderingContext2D, state: GameState, highScore: number, viewW: number): void {
  ctx.fillStyle = C.black;
  ctx.fillRect(0, 0, viewW, HULL_Y0);
  drawText(ctx, "SCORE", 2, 1, C.lightBlue);
  drawText(ctx, pad6(state.score), 22, 1, C.white);
  drawText(ctx, "HI", 48, 1, C.lightBlue);
  drawText(ctx, pad6(Math.max(highScore, state.score)), 57, 1, C.yellow);
  drawText(ctx, "DIST", 84, 1, C.lightBlue);
  drawText(ctx, String(Math.floor(state.distance)).padStart(5, "0"), 101, 1, C.white);
  for (let i = 0; i < Math.max(0, state.lives); i++) drawSprite(ctx, ICON_SHIP, ICON_SHIP_PALETTE, 125 + i * 9, 1);
}

// --- frame -----------------------------------------------------------------------------------------
export function drawDreadnought(canvas: HTMLCanvasElement | null, f: DreadnoughtFrame): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  const { state, viewW, reducedMotion } = f;
  const t = state.t;
  probeReset();
  probe("view", 0, 0, viewW, WORLD_H);

  ctx.save();
  const [sx, sy] = reducedMotion ? [0, 0] : shakeOffset(f.shake);
  ctx.translate(Math.round(sx), Math.round(sy));

  const kinds = new Set<string>();
  const d = state.distance;
  drawSpace(ctx, viewW, reducedMotion ? 0 : d, t);
  // reduced motion: no parallax (the substructure moves with the deck instead of at half speed)
  drawFar(ctx, viewW, reducedMotion ? d : d * 0.5, kinds);
  drawDeck(ctx, viewW, d, t, kinds);
  drawRunwayLights(ctx, viewW, d, t, reducedMotion);
  drawStructures(ctx, viewW, d, t, reducedMotion);
  if (probeActive()) for (const k of kinds) probe(k, 0, 0, 0, 0);

  // pickups: a floppy with a glint sweeping across it
  for (const p of state.pickups) {
    const px = Math.round(p.x - 6);
    const py = Math.round(p.y - 6);
    drawSprite(ctx, ditherSprite(PICKUP_SPRITE), solidPalette(PICKUP_PALETTE, SHADOW), px + 3, py + 3);
    drawSprite(ctx, PICKUP_SPRITE, PICKUP_PALETTE, px, py);
    const g = Math.floor((t % 1100) / 55) - 4;
    if (g >= 0 && g < 12) {
      ctx.fillStyle = C.white;
      ctx.fillRect(px + g, py + 1, 1, 1);
      if (g > 0) ctx.fillRect(px + g - 1, py + 2, 1, 1);
    }
  }

  for (const o of state.obstacles) {
    if (o.kind === "rack") {
      drawRack(ctx, o, t);
    } else if (o.kind === "turret") {
      const damaged = o.hp <= 1;
      const sprite = damaged ? TURRET_SPRITE_DAMAGED : TURRET_SPRITE;
      drawSprite(ctx, ditherSprite(sprite), solidPalette(TURRET_PALETTE, SHADOW), o.x + 3, o.y + 3);
      drawSprite(ctx, sprite, damaged ? TURRET_PALETTE_DAMAGED : TURRET_PALETTE, o.x, o.y);
      if (probeActive()) probe("turret", o.x, o.y, 18, 18);
    } else {
      const frame = DRONE_FRAMES[Math.floor(t / 60) % 2]!;
      drawSprite(ctx, ditherSprite(frame), solidPalette(DRONE_PALETTE, SHADOW), o.x + 6, o.y + 7);
      drawSprite(ctx, frame, DRONE_PALETTE, o.x, o.y);
      if (probeActive()) probe("drone", o.x, o.y, 16, 16);
    }
  }

  for (const b of state.bullets) drawSprite(ctx, BOLT_SPRITE, BOLT_PALETTE, b.x - 4, b.y - 1);
  for (const b of state.enemyBullets) drawSprite(ctx, ORB_FRAMES[Math.floor(t / 80) % 2]!, ORB_PALETTE, b.x - 2, b.y - 2);

  drawParticles(ctx, f.particles);
  drawBlasts(ctx, f.blasts);

  // the ship, its shadow on the hull far below, and its engine flame
  const invuln = state.invulnMs > 0;
  const blinkOff = !reducedMotion && invuln && state.invulnMs < 1050 && Math.floor(t / 90) % 2 === 0;
  const sy0 = Math.round(state.playerY);
  drawSprite(ctx, ditherSprite(SHIP_SPRITE), solidPalette(SHIP_PALETTE, SHADOW), PLAYER_X + 5, sy0 + 10);
  if (!blinkOff) {
    const pal = invuln ? (state.invulnMs >= 1050 ? flashPalette(SHIP_PALETTE) : SHIP_PALETTE_INVULN) : SHIP_PALETTE;
    drawSprite(ctx, SHIP_FLAME_FRAMES[reducedMotion ? 0 : Math.floor(t / 50) % SHIP_FLAME_FRAMES.length]!, FLAME_PALETTE, PLAYER_X - 5, sy0 + 4);
    drawSprite(ctx, SHIP_SPRITE, pal, PLAYER_X - 1, sy0);
  }
  if (probeActive()) probe("ship", PLAYER_X - 1, sy0, 28, 14);

  drawPopups(ctx, f.popups);

  if (f.flash && !reducedMotion) {
    ctx.globalAlpha = (f.flash.remainingMs / f.flash.maxMs) * 0.4;
    ctx.fillStyle = f.flash.color;
    ctx.fillRect(-4, -4, viewW + 8, WORLD_H + 8);
    ctx.globalAlpha = 1;
  }

  if (f.screen === "game") drawHud(ctx, state, f.highScore, viewW);
  else {
    drawText(ctx, "DREADNOUGHT", viewW / 2, 16, C.yellow, { scale: 2, align: "center", shadow: C.black });
    drawText(ctx, "RUN", viewW / 2, 30, C.cyan, { scale: 3, align: "center", shadow: C.black });
    drawText(ctx, `HI ${pad6(f.highScore)}`, viewW / 2, 50, C.white, { align: "center", shadow: C.black });
  }
  ctx.restore();
}
