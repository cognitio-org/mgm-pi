// Floppy Rescue's renderer: draws one frame of a GameState onto the low-res logical canvas
// (viewW x WORLD_H, scaled up by an integer factor in CSS -- see shared/screen.ts). Pure drawing,
// no game logic: everything that animates on its own (fire, smoke, sparks, blinking lights, the
// sky) is a deterministic function of state.t, so the burning farm is already fully ablaze and
// smoking on the very first frame of a level instead of "warming up" from nothing.
//
// Layers, back to front: sky bands (cached) -> stars + moon -> fire glow in the sky over the farm ->
// far hills (0.2x parallax) -> town silhouette (0.45x) -> ground -> props -> Disk Box -> server farm
// (wall, racks, roof fire, smoke, sparks, sign) -> Floppies -> ground fires -> hazards -> particles
// -> helicopter -> score pops -> HUD.

import { CAPACITY, FARM_PAD_W, GROUND_Y, HOME_PAD_W, playerTilt, WORLD_H, WORLD_W, type GameState } from "./engine.ts";
import { C } from "../shared/palette.ts";
import { drawText, drawTextChip, textWidth } from "../shared/font.ts";
import { drawSprite, drawSpriteSheared, flashPalette, hash2, type Palette } from "../shared/pixelSprite.ts";
import { drawBlasts, drawDisc, drawParticles, drawPopups, SMOKE_PALETTES, type Blast } from "../shared/fx.ts";
import type { FlashState, Particle, ShakeState, TextPopup } from "../shared/particles.ts";
import { probe, probeActive, probeReset } from "../shared/probe.ts";
import { shakeOffset } from "../shared/particles.ts";
import {
  BUSH_SPRITE,
  DEBRIS_FRAMES,
  DEBRIS_PALETTE,
  DRONE_FRAMES,
  DRONE_PALETTE,
  FLOPPY_FRAMES,
  FLOPPY_PALETTES,
  HELI_BODY,
  HELI_PALETTE,
  HELI_PALETTE_INVULN,
  HELI_PALETTE_LOADED,
  ICON_FLOPPY,
  ICON_FLOPPY_OFF,
  ICON_FLOPPY_ON,
  ICON_HELI,
  ICON_HELI_PALETTE,
  MOON_PALETTE,
  MOON_SPRITE,
  PINE_PALETTE,
  PINE_SPRITE,
  RACK_H,
  RACK_PALETTES,
  RACK_PALETTES_BURNING,
  RACK_SPRITE,
  RACK_W,
  ROTOR_FRAMES,
  ROTOR_PALETTE,
  SHOT_FRAMES,
  SHOT_PALETTE,
  TAIL_ROTOR_FRAMES,
} from "./sprites.ts";

export interface RescueFrame {
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
  /** +1 facing right, -1 facing left (sticky: keeps the last direction of travel while hovering). */
  facing: 1 | -1;
  /** Engine-space camera to show instead of state.cameraX (held on a crash site briefly). */
  cameraXOverride?: number;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function bayer(x: number, y: number): number {
  return BAYER4[(y & 3) * 4 + (x & 3)]! / 16;
}

// --- cached backdrops -------------------------------------------------------------------------------
function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  return ctx ? [c, ctx] : null;
}

/** Night sky as C64 raster bands with ordered-dither seams between them. */
const SKY_BANDS: Array<[number, string]> = [
  [0, C.night],
  [22, C.ink],
  [48, C.bg],
  [76, "#3a3184"],
];
let skyCache: { w: number; canvas: HTMLCanvasElement } | null = null;
function skyCanvas(w: number): HTMLCanvasElement | null {
  if (skyCache && skyCache.w === w) return skyCache.canvas;
  const made = makeCanvas(w, GROUND_Y);
  if (!made) return null;
  const [canvas, ctx] = made;
  for (let i = 0; i < SKY_BANDS.length; i++) {
    const [y0, color] = SKY_BANDS[i]!;
    const y1 = SKY_BANDS[i + 1]?.[0] ?? GROUND_Y;
    ctx.fillStyle = color;
    ctx.fillRect(0, y0, w, y1 - y0);
    const next = SKY_BANDS[i + 1];
    if (next) {
      // 4-row dithered seam: the next band's colour bleeds up in a Bayer ramp
      ctx.fillStyle = next[1];
      for (let r = 0; r < 4; r++) {
        const y = y1 - 4 + r;
        for (let x = 0; x < w; x++) if (bayer(x, y) < (r + 1) / 5) ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  skyCache = { w, canvas };
  return canvas;
}

/** Firelight reflected in the sky over the farm: a dithered half-ellipse, two flicker variants. */
const GLOW_W = 176;
const GLOW_H = 84;
const glowCache: Array<HTMLCanvasElement | null> = [];
function glowCanvas(variant: number): HTMLCanvasElement | null {
  if (glowCache[variant] !== undefined) return glowCache[variant]!;
  const made = makeCanvas(GLOW_W, GLOW_H);
  if (!made) return null;
  const [canvas, ctx] = made;
  // Banded like a C64 raster: solid rings of warmer colour, with an ordered-dither seam only in the
  // few pixels where one ring hands over to the next (no speckle out in the open sky).
  const ramp = [null, "#3c2a78", "#4e2a6c", "#66305a", "#823846"];
  const strength = variant === 0 ? 1 : 0.9;
  for (let y = 0; y < GLOW_H; y++) {
    for (let x = 0; x < GLOW_W; x++) {
      const dx = (x - GLOW_W / 2) / (GLOW_W / 2);
      const dy = (GLOW_H - y) / GLOW_H;
      const i = Math.max(0, 1 - Math.hypot(dx, dy)) * strength * (ramp.length - 1);
      const band = Math.floor(i);
      const frac = i - band;
      const level = frac > 0.8 && bayer(x, y) < (frac - 0.8) * 5 ? band + 1 : band;
      const color = ramp[Math.min(ramp.length - 1, level)];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  glowCache[variant] = canvas;
  return canvas;
}

/** 64x20 ground tile: grass lip, then dirt with specks and pebbles. */
let groundCache: HTMLCanvasElement | null | undefined;
function groundTile(): HTMLCanvasElement | null {
  if (groundCache !== undefined) return groundCache;
  const h = WORLD_H - GROUND_Y;
  const made = makeCanvas(64, h);
  if (!made) return (groundCache = null);
  const [canvas, ctx] = made;
  ctx.fillStyle = C.brown;
  ctx.fillRect(0, 0, 64, h);
  for (let x = 0; x < 64; x++) {
    ctx.fillStyle = hash2(x, 1) % 5 === 0 ? C.lightGreen : C.green;
    ctx.fillRect(x, 0, 1, 1);
    ctx.fillStyle = "#2e6b3e";
    ctx.fillRect(x, 1, 1, 1 + (hash2(x, 2) % 3 === 0 ? 1 : 0));
    ctx.fillStyle = "#16301c";
    ctx.fillRect(x, 3, 1, 1);
    for (let y = 4; y < h; y++) {
      const r = hash2(x * 7 + y, 3) % 23;
      if (r === 0) ctx.fillStyle = "#8a6a2e";
      else if (r < 3) ctx.fillStyle = "#4a3010";
      else continue;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  for (let i = 0; i < 5; i++) {
    const px = (hash2(i, 9) % 60) + 1;
    const py = 7 + (hash2(i, 10) % (h - 9));
    ctx.fillStyle = C.grey;
    ctx.fillRect(px, py, 3, 2);
    ctx.fillStyle = C.lightGrey;
    ctx.fillRect(px, py, 2, 1);
  }
  groundCache = canvas;
  return canvas;
}

// --- procedural fire, smoke, sparks -----------------------------------------------------------------
/** A row of flame columns rising from baseY: red outer, orange, yellow, white-hot core, with a
 * darker tip and the odd detached tongue. `frame` picks the flicker (the caller advances it every
 * ~85ms, so it's a many-frame loop, never a static sprite). */
function drawFlames(
  ctx: CanvasRenderingContext2D,
  x0: number,
  w: number,
  baseY: number,
  height: number,
  frame: number,
  seed: number,
): number {
  let minTop = baseY;
  for (let i = 0; i < w; i++) {
    const u = (i + 0.5) / w;
    const env = Math.pow(Math.sin(Math.PI * u), 0.6);
    const wob = Math.sin(i * 0.9 + frame * 2.1 + seed) * 0.13 + Math.sin(i * 0.33 - frame * 1.4 + seed * 2) * 0.2;
    const n = (hash2(i + seed * 97, frame) % 100) / 100;
    const h = Math.round(height * env * (0.6 + wob + n * 0.32));
    if (h <= 1) continue;
    const x = Math.round(x0 + i);
    const top = baseY - h;
    if (top < minTop) minTop = top;
    ctx.fillStyle = "#6b1f1a";
    ctx.fillRect(x, top, 1, 1);
    ctx.fillStyle = C.red;
    ctx.fillRect(x, top + 1, 1, h - 1);
    const ho = Math.round(h * 0.74);
    ctx.fillStyle = C.orange;
    ctx.fillRect(x, baseY - ho, 1, ho);
    const hy = Math.round(h * 0.45);
    ctx.fillStyle = C.yellow;
    ctx.fillRect(x, baseY - hy, 1, hy);
    const hw = Math.round(h * 0.2 * env);
    if (hw > 0) {
      ctx.fillStyle = C.hot;
      ctx.fillRect(x, baseY - hw, 1, hw);
    }
    if (n > 0.84 && h > 8) {
      ctx.fillStyle = n > 0.93 ? C.orange : C.red;
      ctx.fillRect(x, top - 3 - (frame % 3) * 2, 1, 2);
    }
  }
  return minTop;
}

/** Probe helper in world coords (see shared/probe.ts); converts to on-canvas logical px. */
let probeCamX = 0;
function probeW(name: string, x: number, y: number, w: number, h: number): void {
  if (probeActive()) probe(name, x - probeCamX, y, w, h);
}

/** A continuous smoke column: puff k is born every PERIOD ms and its position is a pure function of
 * its age, so the column is already full-height on frame one (no warm-up) and costs no state. */
function drawSmoke(ctx: CanvasRenderingContext2D, x0: number, w: number, baseY: number, t: number): void {
  const PERIOD = 115;
  const LIFE = 4200;
  const kNow = Math.floor(t / PERIOD);
  const kMin = Math.floor((t - LIFE) / PERIOD);
  for (let k = kMin; k <= kNow; k++) {
    const age = t - k * PERIOD;
    if (age < 0 || age > LIFE) continue;
    const h = hash2(k, 991);
    const a = age / 1000;
    const x = x0 + (h % w) + a * 6 + Math.sin(a * 1.6 + (h % 10)) * 2.5;
    const y = baseY - a * 18 - ((h >> 8) % 8);
    const r = 2 + a * 1.1 + ((h >> 4) % 2);
    const pal = SMOKE_PALETTES[Math.min(SMOKE_PALETTES.length - 1, Math.floor((age / LIFE) * SMOKE_PALETTES.length))]!;
    drawDisc(ctx, x, y, r, pal);
  }
}

function drawSparks(ctx: CanvasRenderingContext2D, x0: number, w: number, baseY: number, t: number): void {
  const PERIOD = 38;
  const LIFE = 950;
  const kNow = Math.floor(t / PERIOD);
  for (let k = Math.floor((t - LIFE) / PERIOD); k <= kNow; k++) {
    const age = t - k * PERIOD;
    if (age < 0 || age > LIFE) continue;
    const h = hash2(k, 313);
    const a = age / 1000;
    const x = x0 + (h % w) + (((h >> 6) % 50) - 25) * a;
    const y = baseY - ((h >> 12) % 12) - (50 + ((h >> 3) % 45)) * a + 38 * a * a;
    ctx.fillStyle = age < 140 ? C.white : age < 420 ? C.yellow : age < 720 ? C.orange : C.red;
    ctx.fillRect(Math.round(x), Math.round(y), 1, (h & 1) === 0 && age < 400 ? 2 : 1);
  }
}

// --- scenery ---------------------------------------------------------------------------------------
function drawStars(ctx: CanvasRenderingContext2D, viewW: number, camX: number, t: number): void {
  const par = camX * 0.06;
  for (let i = 0; i < 46; i++) {
    const h = hash2(i, 77);
    const x = Math.round(((h % 400) - par + 400) % 400);
    if (x >= viewW) continue;
    const y = 2 + ((h >> 9) % 58);
    const twinkle = (h >> 3) % 7 === 0 && Math.floor(t / 400 + i) % 3 === 0;
    ctx.fillStyle = twinkle ? C.white : (h >> 5) % 3 === 0 ? C.lightBlue : C.paper;
    ctx.fillRect(x, y, 1, 1);
    if (twinkle) {
      ctx.fillStyle = C.lightBlue;
      ctx.fillRect(x - 1, y, 1, 1);
      ctx.fillRect(x + 1, y, 1, 1);
      ctx.fillRect(x, y - 1, 1, 1);
      ctx.fillRect(x, y + 1, 1, 1);
    }
  }
}

function drawHills(ctx: CanvasRenderingContext2D, viewW: number, camX: number): void {
  const par = camX * 0.2;
  for (let x = 0; x < viewW; x++) {
    const wx = x + par;
    const h = Math.round(22 + 7 * Math.sin(wx * 0.031) + 4 * Math.sin(wx * 0.083 + 1.7));
    ctx.fillStyle = "#2a2270";
    ctx.fillRect(x, GROUND_Y - h, 1, h);
    ctx.fillStyle = "#4a40a0";
    ctx.fillRect(x, GROUND_Y - h, 1, 1);
  }
}

function drawTown(ctx: CanvasRenderingContext2D, viewW: number, camX: number, t: number): void {
  const par = camX * 0.45;
  const first = Math.floor(par / 15) - 1;
  const last = Math.floor((par + viewW) / 15) + 1;
  for (let i = first; i <= last; i++) {
    const h = hash2(i, 55);
    if (h % 4 === 0) continue; // gaps in the skyline
    const bw = 8 + (h % 6);
    const bh = 9 + ((h >> 4) % 17);
    const bx = Math.round(i * 15 + ((h >> 8) % 4) - par);
    const by = GROUND_Y - bh;
    ctx.fillStyle = C.night;
    ctx.fillRect(bx, by, bw, bh);
    if ((h >> 12) % 3 === 0) ctx.fillRect(bx + 2, by - 4, 1, 4); // rooftop antenna
    for (let wy = by + 2; wy < GROUND_Y - 2; wy += 3) {
      for (let wx = bx + 1; wx < bx + bw - 1; wx += 2) {
        const w = hash2(wx * 13 + wy, i);
        if (w % 5 !== 0) continue;
        const flick = w % 37 === 0 && Math.floor(t / 900) % 2 === 0;
        ctx.fillStyle = flick ? C.ink : w % 3 === 0 ? C.cyan : C.yellow;
        ctx.fillRect(wx, wy, 1, 1);
      }
    }
  }
}

function drawGround(ctx: CanvasRenderingContext2D, viewW: number, camX: number): void {
  const tile = groundTile();
  if (!tile) return;
  const start = Math.floor(camX / 64) * 64;
  for (let x = start; x < camX + viewW; x += 64) ctx.drawImage(tile, x, GROUND_Y);
}

function drawLampPost(ctx: CanvasRenderingContext2D, x: number, t: number): void {
  ctx.fillStyle = C.black;
  ctx.fillRect(x - 1, GROUND_Y - 20, 3, 20);
  ctx.fillStyle = C.grey;
  ctx.fillRect(x, GROUND_Y - 20, 1, 20);
  ctx.fillRect(x, GROUND_Y - 20, 5, 1);
  ctx.fillStyle = C.black;
  ctx.fillRect(x + 3, GROUND_Y - 19, 4, 2);
  ctx.fillStyle = C.yellow;
  ctx.fillRect(x + 4, GROUND_Y - 18, 2, 1);
  ctx.fillStyle = "#8a6a2e";
  ctx.fillRect(x + 1, GROUND_Y, 8, 1);
}

function drawProps(ctx: CanvasRenderingContext2D, state: GameState, camX: number, viewW: number, t: number): void {
  const SLOT = 17;
  const first = Math.floor(camX / SLOT) - 1;
  const last = Math.floor((camX + viewW) / SLOT) + 1;
  for (let s = first; s <= last; s++) {
    const h = hash2(s, 404);
    const wx = s * SLOT + (h % 7);
    if (wx < 0 || wx > state.levelW - 8) continue;
    if (wx > state.homeX - 16 && wx < state.homeX + HOME_PAD_W + 12) continue;
    if (wx > state.farmX - 70 && wx < state.farmX + FARM_PAD_W + 10) continue;
    const kind = (h >> 8) % 10;
    if (kind < 5) drawSprite(ctx, PINE_SPRITE, PINE_PALETTE, wx - 4, GROUND_Y - 12);
    else if (kind < 7) drawSprite(ctx, BUSH_SPRITE, PINE_PALETTE, wx - 3, GROUND_Y - 4);
    else if (kind === 7) drawLampPost(ctx, wx, t);
    if (kind < 5 && (h >> 12) % 2 === 0) drawSprite(ctx, BUSH_SPRITE, PINE_PALETTE, wx + 3, GROUND_Y - 4);
  }
}

// --- Disk Box: home base, a giant disk storage box with its smoked lid propped open ---------------
function drawDiskBox(ctx: CanvasRenderingContext2D, state: GameState, t: number, reducedMotion: boolean): void {
  const carrying = state.onBoard > 0;
  // bx leaves room for the lid, which leans back 5px left of the box: the whole building, lid and
  // beacon included, sits inside x >= 3 so it's fully on screen whenever the camera is home.
  const bx = 6;
  const bw = 58;
  const bTop = GROUND_Y - 30;
  // lid: smoked translucent plastic, hinged at the back, leaning back-left behind the disks
  for (let r = 0; r < 16; r++) {
    const y = bTop - 1 - r;
    const lx = bx + 2 - Math.round(r * 0.35);
    for (let x = lx; x < lx + bw - 4; x++) {
      if ((x + y) % 2 === 0) continue;
      ctx.fillStyle = C.cyan;
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.fillStyle = C.lightBlue;
    ctx.fillRect(lx, y, 1, 1);
    ctx.fillRect(lx + bw - 5, y, 1, 1);
  }
  ctx.fillStyle = C.lightBlue;
  ctx.fillRect(bx + 2 - 5, bTop - 17, bw - 4, 1);
  // floppies filed inside, tops sticking out
  const diskColors = [C.lightGreen, C.lightRed, C.yellow, C.cyan, C.lightBlue];
  for (let i = 0; i < 5; i++) {
    const dx = bx + 5 + i * 10;
    const dh = 7 + (hash2(i, 12) % 5);
    const dy = bTop - dh;
    ctx.fillStyle = C.black;
    ctx.fillRect(dx - 1, dy - 1, 10, dh + 1);
    ctx.fillStyle = diskColors[i]!;
    ctx.fillRect(dx, dy, 8, dh);
    ctx.fillStyle = C.white;
    ctx.fillRect(dx + 1, dy + 1, 6, 2);
    ctx.fillStyle = C.lightGrey;
    ctx.fillRect(dx + 2, dy + 4, 4, 2);
  }
  // box body
  ctx.fillStyle = C.black;
  ctx.fillRect(bx - 1, bTop - 1, bw + 2, GROUND_Y - bTop + 1);
  ctx.fillStyle = C.lightGrey;
  ctx.fillRect(bx, bTop, bw, GROUND_Y - bTop);
  ctx.fillStyle = C.white;
  ctx.fillRect(bx, bTop, bw, 1);
  ctx.fillStyle = C.grey;
  ctx.fillRect(bx + bw - 3, bTop + 1, 3, GROUND_Y - bTop - 1);
  ctx.fillRect(bx, bTop + 3, bw - 3, 1);
  // door (where the Floppies file in)
  ctx.fillStyle = C.black;
  ctx.fillRect(bx + 4, GROUND_Y - 14, 12, 14);
  ctx.fillStyle = C.darkGrey;
  ctx.fillRect(bx + 5, GROUND_Y - 13, 10, 13);
  ctx.fillStyle = C.yellow;
  for (let y = GROUND_Y - 12; y < GROUND_Y; y += 3) ctx.fillRect(bx + 6, y, 8, 1);
  // the sign: a label plate across the box front, black on white
  const label = "DISK BOX";
  const lw = textWidth(label) + 4;
  drawTextChip(ctx, label, bx + bw / 2 - lw / 2 + 4, bTop + 4, C.black, C.white, C.black);
  probeW("diskBoxSign", bx + bw / 2 - lw / 2 + 3, bTop + 3, lw + 2, 11);
  probeW("diskBox", bx - 3, bTop - 17, bw + 4, GROUND_Y - bTop + 17);
  // landing beacon on a mast at the box's right corner: blinks green while carrying Floppies home
  const mx = bx + bw - 6;
  ctx.fillStyle = C.black;
  ctx.fillRect(mx - 1, bTop - 10, 3, 10);
  ctx.fillStyle = C.grey;
  ctx.fillRect(mx, bTop - 10, 1, 10);
  const lit = carrying && (reducedMotion || Math.floor(t / 250) % 2 === 0);
  ctx.fillStyle = C.black;
  ctx.fillRect(mx - 2, bTop - 14, 5, 5);
  ctx.fillStyle = lit ? C.lightGreen : "#2e6b3e";
  ctx.fillRect(mx - 1, bTop - 13, 3, 3);
  probeW(lit ? "beaconOn" : "beaconOff", mx - 2, bTop - 14, 5, 5);
  if (lit) {
    ctx.fillStyle = C.white;
    ctx.fillRect(mx, bTop - 12, 1, 1);
    ctx.fillStyle = C.lightGreen;
    for (const [ox, oy] of [
      [-4, -12],
      [4, -12],
      [0, -17],
      [-3, -15],
      [3, -15],
      [-5, -12],
      [5, -12],
    ] as const) {
      ctx.fillRect(mx + ox, bTop + oy, 1, 1);
    }
  }
  // helipad slab in front, with edge lights that chase toward the box while carrying
  const px = state.homeX;
  ctx.fillStyle = C.black;
  ctx.fillRect(px - 1, GROUND_Y - 4, HOME_PAD_W + 2, 5);
  ctx.fillStyle = C.grey;
  ctx.fillRect(px, GROUND_Y - 3, HOME_PAD_W, 3);
  ctx.fillStyle = C.lightGrey;
  ctx.fillRect(px, GROUND_Y - 3, HOME_PAD_W, 1);
  const chase = Math.floor(t / 110);
  for (let i = 0; i < 7; i++) {
    const lx = px + 2 + i * 7;
    const on = carrying ? (reducedMotion ? true : (6 - i + chase) % 7 < 2) : i % 2 === 0;
    ctx.fillStyle = on ? (carrying ? C.lightGreen : C.yellow) : C.darkGrey;
    ctx.fillRect(lx, GROUND_Y - 2, 2, 1);
  }
}

// --- the burning server farm -------------------------------------------------------------------------
function drawFarm(ctx: CanvasRenderingContext2D, state: GameState, t: number, reducedMotion: boolean): void {
  const fx = Math.round(state.farmX);
  const W = FARM_PAD_W;
  const wallTop = GROUND_Y - 42;
  const frame = Math.floor(t / (reducedMotion ? 320 : 85));
  const maxI = state.fireCells.reduce((m, c) => Math.max(m, c.intensity), 0);

  // smoke column rising from the roof fire (behind the flames)
  drawSmoke(ctx, fx - 2, W + 4, wallTop - 18, reducedMotion ? t * 0.35 : t);
  probeW("smoke", fx - 2, 0, W + 30, wallTop - 18);

  // back wall: corrugated metal, windows lit by the fire inside
  ctx.fillStyle = C.black;
  ctx.fillRect(fx - 4, wallTop - 1, W + 8, GROUND_Y - wallTop + 1);
  ctx.fillStyle = "#2a2438";
  ctx.fillRect(fx - 3, wallTop, W + 6, GROUND_Y - wallTop);
  ctx.fillStyle = "#3a3450";
  for (let x = fx - 2; x < fx + W + 3; x += 3) ctx.fillRect(x, wallTop, 1, GROUND_Y - wallTop);
  for (let i = 0; i < 6; i++) {
    const wx = fx + 2 + i * 10;
    const flick = hash2(i, frame >> 1) % 3;
    ctx.fillStyle = C.black;
    ctx.fillRect(wx - 1, wallTop + 3, 8, 7);
    ctx.fillStyle = flick === 0 ? C.yellow : C.orange;
    ctx.fillRect(wx, wallTop + 4, 6, 5);
    ctx.fillStyle = C.red;
    ctx.fillRect(wx, wallTop + 8, 6, 1);
  }

  // roof fire: the whole roofline burning, always -- flames rise 30-45px over the rack tops
  const flameTop = drawFlames(ctx, fx - 6, W + 12, wallTop + 2, 34 + maxI * 8, frame, 3);
  probeW("roofFire", fx - 6, flameTop, W + 12, wallTop + 2 - flameTop);
  probeW("rack", fx + 1, GROUND_Y - 3 - RACK_H, RACK_W, RACK_H);

  // front frame: two pillars and a broken lintel
  ctx.fillStyle = C.black;
  ctx.fillRect(fx - 5, wallTop - 3, 5, GROUND_Y - wallTop + 3);
  ctx.fillRect(fx + W, wallTop - 3, 5, GROUND_Y - wallTop + 3);
  ctx.fillRect(fx - 5, wallTop - 3, 22, 5);
  ctx.fillRect(fx + W - 10, wallTop - 3, 15, 5);
  ctx.fillStyle = C.grey;
  ctx.fillRect(fx - 4, wallTop - 2, 3, GROUND_Y - wallTop + 2);
  ctx.fillRect(fx + W + 1, wallTop - 2, 3, GROUND_Y - wallTop + 2);
  ctx.fillRect(fx - 4, wallTop - 2, 20, 3);
  ctx.fillRect(fx + W - 9, wallTop - 2, 13, 3);
  ctx.fillStyle = C.lightGrey;
  ctx.fillRect(fx - 4, wallTop - 2, 20, 1);
  ctx.fillRect(fx + W - 9, wallTop - 2, 13, 1);

  // rack cabinets inside
  const cellAt = (x: number) => state.fireCells.find((c) => x >= c.x && x < c.x + c.w);
  for (let i = 0; i < 5; i++) {
    const rx = fx + 1 + i * 12;
    const burning = (cellAt(rx + RACK_W / 2)?.intensity ?? 0) >= 0.5;
    const blink = Math.floor(t / (burning ? 140 : 380) + i) % 2;
    drawSprite(ctx, RACK_SPRITE, (burning ? RACK_PALETTES_BURNING : RACK_PALETTES)[blink]!, rx, GROUND_Y - 3 - RACK_H);
  }

  // farm pad
  ctx.fillStyle = C.black;
  ctx.fillRect(fx - 1, GROUND_Y - 4, W + 2, 5);
  ctx.fillStyle = C.darkGrey;
  ctx.fillRect(fx, GROUND_Y - 3, W, 3);
  ctx.fillStyle = C.yellow;
  for (let x = fx + 1; x < fx + W - 2; x += 6) ctx.fillRect(x, GROUND_Y - 3, 3, 1);

  // embers/sparks thrown up out of the roof fire
  if (!reducedMotion) {
    drawSparks(ctx, fx - 2, W + 4, wallTop - 6, t);
    probeW("sparks", fx - 2, 0, W + 4, wallTop);
  }

}

/** The SERVER FARM billboard on two posts, left of the building, with a warning lamp. Drawn as a
 * foreground layer (after the chopper) so nothing -- flames, smoke, the chopper climbing out --
 * ever covers its lettering. */
function drawFarmSign(ctx: CanvasRenderingContext2D, state: GameState, t: number, reducedMotion: boolean): void {
  const fx = Math.round(state.farmX);
  const sx = fx - 62;
  const sy = GROUND_Y - 40;
  ctx.fillStyle = C.black;
  ctx.fillRect(sx + 5, sy + 10, 3, GROUND_Y - sy - 10);
  ctx.fillRect(sx + 39, sy + 10, 3, GROUND_Y - sy - 10);
  ctx.fillStyle = C.grey;
  ctx.fillRect(sx + 6, sy + 10, 1, GROUND_Y - sy - 10);
  ctx.fillRect(sx + 40, sy + 10, 1, GROUND_Y - sy - 10);
  const signW = drawTextChip(ctx, "SERVER FARM", sx, sy, C.black, C.white, C.black);
  probeW("farmSign", sx - 1, sy - 1, signW + 2, 11);
  const warn = reducedMotion || Math.floor(t / 300) % 2 === 0;
  ctx.fillStyle = C.black;
  ctx.fillRect(sx + 20, sy - 5, 5, 4);
  ctx.fillStyle = warn ? C.lightRed : C.red;
  ctx.fillRect(sx + 21, sy - 4, 3, 3);
}

/** Ground-level fire in each burning cell, in front of the Floppies (this is the hazard itself). */
function drawCellFires(ctx: CanvasRenderingContext2D, state: GameState, t: number, reducedMotion: boolean): void {
  const frame = Math.floor(t / (reducedMotion ? 320 : 75));
  state.fireCells.forEach((cell, i) => {
    if (cell.intensity <= 0) return;
    drawFlames(ctx, cell.x - 2, cell.w + 4, GROUND_Y - 1, 6 + cell.intensity * 18, frame + i * 3, 11 + i);
  });
}

// --- player -----------------------------------------------------------------------------------------
function drawHeli(ctx: CanvasRenderingContext2D, state: GameState, facing: 1 | -1, reducedMotion: boolean): void {
  const { playerX: px, playerY: py, t } = state;
  // ground shadow, shrinking with altitude
  const alt = GROUND_Y - (py + 14);
  const sw = Math.max(6, 26 - Math.round(alt / 4));
  ctx.fillStyle = "#16301c";
  ctx.fillRect(Math.round(px + 13 - sw / 2), GROUND_Y, sw, 1);

  const invuln = state.invulnMs > 0;
  if (invuln && !reducedMotion && state.invulnMs < 1350 && Math.floor(t / 90) % 2 === 0) return; // blink
  let palette: Palette = state.onBoard > 0 ? HELI_PALETTE_LOADED : HELI_PALETTE;
  if (invuln) palette = state.invulnMs > 1350 ? flashPalette(HELI_PALETTE) : HELI_PALETTE_INVULN;
  const flip = facing < 0;
  // a gentle nose-down lean in the direction of travel: at most ~1px per 10 columns, so the shear
  // reads as a tilt rather than a broken sprite
  const slope = playerTilt(state.playerVx) * 0.2;
  const x = px - 3;
  const rotorFrame = reducedMotion ? 0 : Math.floor(t / 45) % ROTOR_FRAMES.length;
  drawSpriteSheared(ctx, HELI_BODY, palette, x, py, slope, flip);
  probeW("heli", x, py - 2, 32, 16);
  drawSpriteSheared(ctx, ROTOR_FRAMES[rotorFrame]!, invuln && state.invulnMs > 1350 ? flashPalette(ROTOR_PALETTE) : ROTOR_PALETTE, x, py - 2, slope, flip);
  const tailCol = flip ? 32 : -1;
  const tailDy = Math.round((tailCol - 16) * slope);
  const tail = TAIL_ROTOR_FRAMES[reducedMotion ? 0 : Math.floor(t / 60) % 2]!;
  drawSprite(ctx, tail, ROTOR_PALETTE, x + tailCol, py + 1 + tailDy);
}

// --- HUD ----------------------------------------------------------------------------------------------
function pad6(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(6, "0");
}

function drawHud(ctx: CanvasRenderingContext2D, state: GameState, highScore: number, viewW: number, t: number): void {
  // The dashboard lives in the dirt band under the grass line, below all the action, so it never
  // covers the chopper or the sky it flies in.
  ctx.save();
  ctx.translate(0, GROUND_Y + 1);
  // score panel, left
  ctx.fillStyle = C.lightBlue;
  ctx.fillRect(1, 1, 114, 18);
  ctx.fillStyle = C.ink;
  ctx.fillRect(2, 2, 112, 16);
  drawText(ctx, "SCORE", 4, 4, C.lightBlue);
  drawText(ctx, pad6(state.score), 25, 4, C.white);
  drawText(ctx, "HI", 52, 4, C.lightBlue);
  drawText(ctx, pad6(Math.max(highScore, state.score)), 61, 4, C.yellow);
  for (let i = 0; i < Math.max(0, state.lives); i++) drawSprite(ctx, ICON_HELI, ICON_HELI_PALETTE, 87 + i * 9, 4);
  // fuel bar, blinking red when low
  const fuel = Math.max(0, Math.min(100, state.fuel));
  const low = fuel < 25;
  drawText(ctx, "FUEL", 4, 11, low && Math.floor(t / 250) % 2 === 0 ? C.lightRed : C.lightBlue);
  ctx.fillStyle = C.black;
  ctx.fillRect(21, 11, 26, 5);
  ctx.fillStyle = low ? C.lightRed : fuel < 50 ? C.yellow : C.lightGreen;
  ctx.fillRect(22, 12, Math.round((24 * fuel) / 100), 3);
  drawText(ctx, `LV${state.level}`, 51, 11, C.lightBlue);
  for (let i = 0; i < CAPACITY; i++) {
    drawSprite(ctx, ICON_FLOPPY, i < state.onBoard ? ICON_FLOPPY_ON : ICON_FLOPPY_OFF, 67 + i * 4, 11);
  }
  // distance minimap, top-right
  const mw = Math.min(62, viewW - 126);
  const mx = viewW - mw - 3;
  ctx.fillStyle = C.lightBlue;
  ctx.fillRect(mx - 1, 1, mw + 2, 11);
  ctx.fillStyle = C.ink;
  ctx.fillRect(mx, 2, mw, 9);
  ctx.fillStyle = C.brown;
  ctx.fillRect(mx + 2, 8, mw - 4, 1);
  const at = (v: number) => mx + 2 + Math.round((Math.max(0, Math.min(state.levelW, v)) / state.levelW) * (mw - 5));
  ctx.fillStyle = C.lightGreen;
  ctx.fillRect(at(state.homeX), 6, 2, 2);
  const farmBlink = Math.floor(t / 200) % 2 === 0;
  ctx.fillStyle = farmBlink ? C.orange : C.red;
  ctx.fillRect(at(state.farmX + FARM_PAD_W / 2), 5, 2, 3);
  ctx.fillStyle = C.white;
  ctx.fillRect(at(state.playerX + 13), 3 + Math.round(((state.playerY + 7) / GROUND_Y) * 4), 2, 1);
  ctx.restore();
}

// --- frame ------------------------------------------------------------------------------------------
export function drawRescue(canvas: HTMLCanvasElement | null, f: RescueFrame): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  const { state, viewW, reducedMotion, screen } = f;
  const t = state.t;

  // The engine's camera frames a WORLD_W-wide view; on a narrower screen, map it onto the same
  // [0, levelW - viewW] range so the home lock (cameraX 0) still shows the whole Disk Box.
  const maxEngineCam = Math.max(1, state.levelW - WORLD_W);
  const maxViewCam = Math.max(0, state.levelW - viewW);
  const engineCam = f.cameraXOverride ?? state.cameraX;
  const camX = Math.round(Math.min(maxViewCam, (engineCam / maxEngineCam) * maxViewCam));
  probeReset();
  probeCamX = camX;
  probe("view", 0, 0, viewW, WORLD_H);
  if (f.cameraXOverride !== undefined) probe("crashHold", 0, 0, 0, 0);

  ctx.save();
  const [sx, sy] = reducedMotion ? [0, 0] : shakeOffset(f.shake);
  ctx.translate(Math.round(sx), Math.round(sy));

  const sky = skyCanvas(viewW);
  if (sky) ctx.drawImage(sky, 0, 0);
  drawStars(ctx, viewW, camX, t);
  drawSprite(ctx, MOON_SPRITE, MOON_PALETTE, Math.round(viewW * 0.62 - camX * 0.04), 14);

  // firelight over the farm sits in the sky, behind the hills and town
  const glow = glowCanvas(reducedMotion ? 0 : Math.floor(t / 170) % 2);
  if (glow) ctx.drawImage(glow, Math.round(state.farmX + FARM_PAD_W / 2 - GLOW_W / 2 - camX), GROUND_Y - GLOW_H);
  drawHills(ctx, viewW, camX);
  drawTown(ctx, viewW, camX, t);

  ctx.save();
  ctx.translate(-camX, 0);
  drawGround(ctx, viewW, camX);
  drawProps(ctx, state, camX, viewW, t);
  drawDiskBox(ctx, state, t, reducedMotion);
  if (state.farmX - 90 < camX + viewW) drawFarm(ctx, state, t, reducedMotion);

  // Floppies waiting at the farm: walk in place, or wave when the chopper is down at the farm
  const heliAtFarm = state.playerY + 14 >= GROUND_Y - 1 && Math.abs(state.playerX + 13 - (state.farmX + FARM_PAD_W / 2)) < 40;
  // The engine lines Floppies up four to a row (every 4th shares a spot); draw the later rows
  // first, a couple of px further back and half a slot over, so the crowd overlaps like a queue
  // instead of stacking sprites exactly on top of each other.
  const order = state.floppies.map((fl, i) => ({ fl, i, row: Math.floor(i / 4) })).sort((a, b) => b.row - a.row);
  for (const { fl, i, row } of order) {
    if (!fl.alive || fl.boarded) continue;
    const phase = Math.floor(t / 220 + i) % 2;
    const frame = reducedMotion ? 0 : heliAtFarm && phase === 0 ? 2 : phase;
    const fxp = Math.round(fl.x) - 5 + (row % 2) * 6;
    const fyp = GROUND_Y - 12 - Math.min(row, 2) * 2;
    drawSprite(ctx, FLOPPY_FRAMES[frame]!, FLOPPY_PALETTES[i % FLOPPY_PALETTES.length]!, fxp, fyp);
    probeW("floppy", fxp, fyp, 11, 12);
  }
  drawCellFires(ctx, state, t, reducedMotion);

  for (const d of state.debris) drawSprite(ctx, DEBRIS_FRAMES[Math.floor(t / 90) % 2]!, DEBRIS_PALETTE, d.x - 2, d.y - 4);
  if (state.drone) {
    drawSprite(ctx, DRONE_FRAMES[Math.floor(t / 70) % 2]!, DRONE_PALETTE, state.drone.x - 6, state.drone.y - 4);
  }
  for (const b of state.droneBullets) drawSprite(ctx, SHOT_FRAMES[Math.floor(t / 80) % 2]!, SHOT_PALETTE, b.x - 1, b.y - 1);

  drawParticles(ctx, f.particles);
  drawBlasts(ctx, f.blasts);
  drawHeli(ctx, state, f.facing, reducedMotion);
  if (state.farmX - 90 < camX + viewW) drawFarmSign(ctx, state, t, reducedMotion);
  drawPopups(ctx, f.popups);
  ctx.restore();

  if (f.flash && !reducedMotion) {
    ctx.globalAlpha = (f.flash.remainingMs / f.flash.maxMs) * 0.4;
    ctx.fillStyle = f.flash.color;
    ctx.fillRect(-4, -4, viewW + 8, WORLD_H + 8);
    ctx.globalAlpha = 1;
  }

  if (screen === "game") drawHud(ctx, state, f.highScore, viewW, t);
  else {
    // title logo in the bitmap font, chunky 2x, with a hard drop shadow
    // (kept above the attract demo's cruise altitude, so the logo never sits on the chopper)
    drawText(ctx, "FLOPPY", viewW / 2, 7, C.yellow, { scale: 3, align: "center", shadow: C.black });
    drawText(ctx, "RESCUE", viewW / 2, 25, C.lightGreen, { scale: 3, align: "center", shadow: C.black });
    drawText(ctx, `HI ${pad6(f.highScore)}`, viewW / 2, 44, C.white, { align: "center", shadow: C.black });
  }
  ctx.restore();
}
