// Hand-drawn pixel-art sprites: each sprite is a small grid of characters, one per logical pixel,
// mapped to a colour via a palette object. No image assets, no third-party art. "." is always
// transparent (skipped).
//
// Each (sprite, palette, flip) combination is rasterised once into a tiny offscreen canvas and then
// blitted with drawImage at integer logical coordinates onto the game's low-res canvas -- so a
// 16x16 hull tile costs one drawImage per frame instead of 256 fillRects, and every sprite lands
// exactly on the logical pixel grid (the visible canvas is scaled up by an integer factor with
// `image-rendering: pixelated`, see shared/screen.ts).

export type Sprite = string[];
export type Palette = Record<string, string>;

const cache = new WeakMap<Sprite, WeakMap<Palette, [HTMLCanvasElement | null, HTMLCanvasElement | null]>>();

function rasterise(sprite: Sprite, palette: Palette, flipX: boolean): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const h = sprite.length;
  const w = sprite.reduce((m, row) => Math.max(m, row.length), 0);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  for (let row = 0; row < h; row++) {
    const line = sprite[row]!;
    for (let col = 0; col < line.length; col++) {
      const ch = line[col]!;
      if (ch === ".") continue;
      const color = palette[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(flipX ? w - 1 - col : col, row, 1, 1);
    }
  }
  return canvas;
}

/** The cached raster for (sprite, palette, flipX). Palettes are cached by identity, so keep them
 * as module-level constants rather than building a fresh object every frame. */
export function spriteImage(sprite: Sprite, palette: Palette, flipX = false): HTMLCanvasElement | null {
  let byPalette = cache.get(sprite);
  if (!byPalette) {
    byPalette = new WeakMap();
    cache.set(sprite, byPalette);
  }
  let pair = byPalette.get(palette);
  if (!pair) {
    pair = [null, null];
    byPalette.set(palette, pair);
  }
  const idx = flipX ? 1 : 0;
  if (!pair[idx]) pair[idx] = rasterise(sprite, palette, flipX);
  return pair[idx];
}

/** Draws `sprite` with its top-left at (x, y) in logical px (rounded to the pixel grid). `scale` is
 * an integer multiplier for the rare sprite drawn chunkier than 1:1. */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  palette: Palette,
  x: number,
  y: number,
  scale = 1,
  flipX = false,
): void {
  const img = spriteImage(sprite, palette, flipX);
  if (!img) return;
  ctx.drawImage(img, Math.round(x), Math.round(y), img.width * scale, img.height * scale);
}

/** Draws `sprite` column by column with a per-column vertical offset of `round((col - pivot) *
 * slope)` -- a pixel-exact "tilt" (a shear, not a rotation), so a leaning helicopter stays on the
 * pixel grid instead of turning into an anti-aliased smear the way ctx.rotate() would. */
export function drawSpriteSheared(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  palette: Palette,
  x: number,
  y: number,
  slope: number,
  flipX = false,
): void {
  const img = spriteImage(sprite, palette, flipX);
  if (!img) return;
  const pivot = img.width / 2;
  const rx = Math.round(x);
  const ry = Math.round(y);
  for (let col = 0; col < img.width; col++) {
    const dy = Math.round((col - pivot) * slope);
    ctx.drawImage(img, col, 0, 1, img.height, rx + col, ry + dy, 1, img.height);
  }
}

export function spriteSize(sprite: Sprite, scale = 1): [number, number] {
  const h = sprite.length;
  const w = sprite.reduce((m, row) => Math.max(m, row.length), 0);
  return [w * scale, h * scale];
}

const solidCache = new WeakMap<Palette, Map<string, Palette>>();
/** The same palette with every colour replaced by `color` -- a silhouette, for a drop shadow or a
 * one-frame white "hit flash". Cached, so it's safe to call every frame. */
export function solidPalette(palette: Palette, color: string): Palette {
  let byColor = solidCache.get(palette);
  if (!byColor) {
    byColor = new Map();
    solidCache.set(palette, byColor);
  }
  let out = byColor.get(color);
  if (!out) {
    out = {};
    for (const k of Object.keys(palette)) out[k] = color;
    byColor.set(color, out);
  }
  return out;
}

const ditherCache = new WeakMap<Sprite, Sprite>();
/** The sprite with every other pixel (checkerboard) made transparent -- drawn with a solidPalette
 * it's a see-through C64-style drop shadow instead of an opaque black blob. */
export function ditherSprite(sprite: Sprite): Sprite {
  let out = ditherCache.get(sprite);
  if (!out) {
    out = sprite.map((row, y) => row.replace(/./g, (ch, x: number) => ((x + y) % 2 === 0 ? ch : ".")));
    ditherCache.set(sprite, out);
  }
  return out;
}

/** White silhouette for a hit flash. */
export function flashPalette(palette: Palette): Palette {
  return solidPalette(palette, "#ffffff");
}

/** A tiny deterministic integer hash, for "which tile/prop goes here" decisions that must look the
 * same every time a stretch of world scrolls into view, with no RNG state. */
export function hash2(a: number, b = 0): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
