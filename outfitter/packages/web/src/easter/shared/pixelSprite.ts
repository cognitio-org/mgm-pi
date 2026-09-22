// Hand-drawn pixel-art sprites: each sprite is a small grid of characters, one per logical pixel,
// mapped to a colour via a palette object. No image assets, no third-party art -- everything is
// `ctx.fillRect` at a fixed pixel scale with `imageSmoothingEnabled = false` set once by the
// caller, matching the app-wide "image-rendering: pixelated / crispEdges" pixel-grid language (see
// docs/design/README.md). "." is always transparent (skipped).

export type Sprite = string[];
export type Palette = Record<string, string>;

/** Draws `sprite` at (x, y) in world units, each character cell rendered as a `scale`x`scale`
 * square. Pass `flipX: true` to mirror horizontally (used for e.g. a pickup's shimmer frame). */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  palette: Palette,
  x: number,
  y: number,
  scale: number,
): void {
  for (let row = 0; row < sprite.length; row++) {
    const line = sprite[row]!;
    for (let col = 0; col < line.length; col++) {
      const ch = line[col]!;
      if (ch === ".") continue;
      const color = palette[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x + col * scale), Math.round(y + row * scale), scale, scale);
    }
  }
}

export function spriteSize(sprite: Sprite, scale: number): [number, number] {
  const h = sprite.length;
  const w = sprite[0]?.length ?? 0;
  return [w * scale, h * scale];
}
