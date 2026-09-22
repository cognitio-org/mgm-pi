// Shared pixel-art effects for both games: a 6-frame explosion ("blast"), tumbling debris chunks,
// 3-frame pickup sparkles, dithered smoke discs, and "+100" score pops in the bitmap font. The
// explosion and disc sprites are generated once at module load from a few radii + a deterministic
// jitter hash rather than hand-typed grids -- same pixel-grid output, a fraction of the bytes.

import { C } from "./palette.ts";
import { drawText } from "./font.ts";
import { drawSprite, hash2, type Palette, type Sprite } from "./pixelSprite.ts";
import type { Particle, TextPopup } from "./particles.ts";

// --- explosion: 6 frames, 17x17, white-hot core -> fireball -> broken ring -> smoke --------------
const BLAST_SIZE = 17;
const BLAST_FRAME_MS = 65;
export const BLAST_FRAMES: Sprite[] = [0, 1, 2, 3, 4, 5].map((k) => {
  const rows: string[] = [];
  const c = (BLAST_SIZE - 1) / 2;
  for (let y = 0; y < BLAST_SIZE; y++) {
    let row = "";
    for (let x = 0; x < BLAST_SIZE; x++) {
      const jitter = ((hash2(x * 31 + y, k + 7) % 100) / 100 - 0.5) * 1.6;
      const d = Math.hypot(x - c, y - c) + jitter;
      const hole = hash2(x + 101 * y, k) % 100;
      let ch = ".";
      if (k === 0) ch = d < 2.2 ? "W" : d < 3.6 ? "Y" : ".";
      else if (k === 1) ch = d < 2.6 ? "W" : d < 4.6 ? "Y" : d < 5.8 ? "O" : ".";
      else if (k === 2) ch = d < 2.4 ? "Y" : d < 5 ? "O" : d < 7 ? (hole < 18 ? "." : "R") : ".";
      else if (k === 3) ch = d < 3.5 ? (hole < 50 ? "O" : "R") : d < 7.6 ? (hole < 40 ? "." : hole < 70 ? "R" : "O") : ".";
      else if (k === 4) ch = d < 4 ? (hole < 60 ? "." : "D") : d < 8 ? (hole < 55 ? "." : hole < 80 ? "G" : "R") : ".";
      else ch = d > 5 && d < 8.4 && hole > 72 ? (hole > 90 ? "G" : "D") : ".";
      row += ch;
    }
    rows.push(row);
  }
  return rows;
});
const BLAST_PALETTE: Palette = { W: C.hot, Y: C.yellow, O: C.orange, R: C.red, G: C.grey, D: C.darkGrey };
export const BLAST_LIFE_MS = BLAST_FRAMES.length * BLAST_FRAME_MS;

export interface Blast {
  x: number;
  y: number;
  ageMs: number;
  /** 1 or 2 -- a big blast (player crash) draws the same frames at 2x. */
  size: number;
}

export function spawnBlast(x: number, y: number, size = 1): Blast {
  return { x, y, ageMs: 0, size };
}

export function stepBlasts(blasts: Blast[], dtMs: number): Blast[] {
  const next: Blast[] = [];
  for (const b of blasts) {
    const ageMs = b.ageMs + dtMs;
    if (ageMs < BLAST_LIFE_MS) next.push({ ...b, ageMs });
  }
  return next;
}

export function drawBlasts(ctx: CanvasRenderingContext2D, blasts: Blast[], offX = 0): void {
  for (const b of blasts) {
    const frame = BLAST_FRAMES[Math.min(BLAST_FRAMES.length - 1, Math.floor(b.ageMs / BLAST_FRAME_MS))]!;
    const half = (BLAST_SIZE * b.size) / 2;
    drawSprite(ctx, frame, BLAST_PALETTE, b.x - offX - half, b.y - half, b.size);
  }
}

// --- debris chunks (tumbling, 2 rotation frames each) and sparkles --------------------------------
const CHUNKS: Sprite[][] = [
  [["KLG", "GGK", ".K."], [".GK", "KLG", "GK."]],
  [["LG", "GK"], ["GL", "KG"]],
  [["KGGL", ".KG."], ["LK..", "GGK.", ".GK."]],
];
const chunkPalettes = new Map<string, Palette>();
function chunkPalette(tint: string): Palette {
  let p = chunkPalettes.get(tint);
  if (!p) {
    p = { K: C.black, G: C.grey, L: tint };
    chunkPalettes.set(tint, p);
  }
  return p;
}

export const SPARKLE_FRAMES: Sprite[] = [
  [".......", ".......", "...Y...", "..YWY..", "...Y...", ".......", "......."],
  ["...Y...", "...Y...", "...W...", "YYWWWYY", "...W...", "...Y...", "...Y..."],
  ["Y.....Y", ".Y...Y.", "...W...", "..W.W..", "...W...", ".Y...Y.", "Y.....Y"],
];
const sparklePalettes = new Map<string, Palette>();
function sparklePalette(tint: string): Palette {
  let p = sparklePalettes.get(tint);
  if (!p) {
    p = { W: C.white, Y: tint };
    sparklePalettes.set(tint, p);
  }
  return p;
}

/** Draws particles: "chunk" ones as tumbling debris sprites, "star" ones as a 3-frame sparkle,
 * anything else as a 1-2px dot. No alpha anywhere -- a dying particle blinks out instead of fading,
 * which is how a C64 would have done it. */
export function drawParticles(ctx: CanvasRenderingContext2D, particles: Particle[], offX = 0): void {
  for (const p of particles) {
    const lifeFrac = p.lifeMs / p.maxLifeMs;
    if (lifeFrac < 0.2 && Math.floor(p.lifeMs / 40) % 2 === 0) continue;
    const x = p.x - offX;
    if (p.kind === "chunk") {
      const set = CHUNKS[(p.variant ?? 0) % CHUNKS.length]!;
      const frame = set[Math.floor(p.lifeMs / 90) % 2]!;
      drawSprite(ctx, frame, chunkPalette(p.color), x - 1, p.y - 1);
    } else if (p.kind === "star") {
      const idx = lifeFrac > 0.66 ? 0 : lifeFrac > 0.33 ? 1 : 2;
      drawSprite(ctx, SPARKLE_FRAMES[idx]!, sparklePalette(p.color), x - 3, p.y - 3);
    } else {
      ctx.fillStyle = lifeFrac > 0.6 && p.size <= 1 ? C.white : p.color;
      ctx.fillRect(Math.round(x), Math.round(p.y), p.size, p.size);
    }
  }
}

/** "+100" score pops in the bitmap font, black drop shadow, blinking out over their last 150ms. */
export function drawPopups(ctx: CanvasRenderingContext2D, popups: TextPopup[], offX = 0): void {
  for (const p of popups) {
    if (p.lifeMs < 150 && Math.floor(p.lifeMs / 50) % 2 === 0) continue;
    drawText(ctx, p.text, p.x - offX, p.y, p.color, { align: "center", shadow: C.black });
  }
}

// --- smoke discs: radius 1..6, lit top-left, shaded bottom-right ----------------------------------
export const DISCS: Sprite[] = [1, 2, 3, 4, 5, 6].map((r) => {
  const size = r * 2 + 1;
  const rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let row = "";
    for (let x = 0; x < size; x++) {
      const dx = x - r;
      const dy = y - r;
      const d = Math.hypot(dx, dy);
      if (d > r + 0.35) row += ".";
      else if (dx + dy < -r * 0.7 && d > r * 0.35) row += "L";
      else if (dx + dy > r * 0.8) row += "D";
      else row += "M";
    }
    rows.push(row);
  }
  return rows;
});

/** Smoke palettes from fresh (light grey, just off the fire) to old (dissolving into the night). */
export const SMOKE_PALETTES: Palette[] = [
  { L: "#c8c8c8", M: C.lightGrey, D: "#888888" },
  { L: C.lightGrey, M: "#888888", D: C.grey },
  { L: "#888888", M: C.grey, D: "#56526e" },
  { L: C.grey, M: "#56526e", D: "#443c78" },
  { L: "#56526e", M: "#443c78", D: "#3a3280" },
];

export function drawDisc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, palette: Palette): void {
  const idx = Math.max(0, Math.min(DISCS.length - 1, Math.round(r) - 1));
  const disc = DISCS[idx]!;
  drawSprite(ctx, disc, palette, x - (idx + 1), y - (idx + 1));
}
