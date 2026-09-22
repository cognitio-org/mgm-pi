// A 3x5 pixel font for everything drawn inside the game canvases (HUDs, signs, score pops). The
// browser's own fillText at a 7px size on a low-res canvas comes out as a blurry anti-aliased smear
// once the canvas is scaled up; this draws each glyph as fillRects on the logical pixel grid, so text
// is exactly as crisp as the sprites around it. Each glyph is five octal digits, one per row, bit 4 =
// left column.

const GLYPHS: Record<string, string> = {
  A: "25755", B: "65656", C: "34443", D: "65556", E: "74647", F: "74644", G: "34553", H: "55755",
  I: "72227", J: "11152", K: "55655", L: "44447", M: "57755", N: "65555", O: "25552", P: "65644",
  Q: "25563", R: "65655", S: "34216", T: "72222", U: "55557", V: "55552", W: "55775", X: "55255",
  Y: "55222", Z: "71247",
  "0": "75557", "1": "26227", "2": "61247", "3": "61216", "4": "55711", "5": "74616", "6": "34757",
  "7": "71122", "8": "75757", "9": "75716",
  " ": "00000", ":": "02020", ".": "00002", "-": "00700", "+": "02720", "/": "11244", "%": "51245",
  "!": "22202", "*": "05250", "?": "61202", "'": "22000", ",": "00024", "(": "12221", ")": "42224",
  "=": "07070",
};

export const GLYPH_W = 3;
export const GLYPH_H = 5;
export const GLYPH_ADVANCE = 4;

/** Width in logical px of `text` at `scale` (no trailing gap). */
export function textWidth(text: string, scale = 1): number {
  return Math.max(0, text.length * GLYPH_ADVANCE - 1) * scale;
}

export interface TextOptions {
  scale?: number;
  /** Drop-shadow colour drawn 1px down-right first (C64-style), or omitted for none. */
  shadow?: string;
  align?: "left" | "center" | "right";
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  opts: TextOptions = {},
): void {
  const scale = opts.scale ?? 1;
  const upper = text.toUpperCase();
  let startX = Math.round(x);
  if (opts.align === "center") startX = Math.round(x - textWidth(upper, scale) / 2);
  else if (opts.align === "right") startX = Math.round(x - textWidth(upper, scale));
  const y0 = Math.round(y);
  if (opts.shadow) paint(ctx, upper, startX + scale, y0 + scale, opts.shadow, scale);
  paint(ctx, upper, startX, y0, color, scale);
}

function paint(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, scale: number): void {
  ctx.fillStyle = color;
  for (let i = 0; i < text.length; i++) {
    const glyph = GLYPHS[text[i]!] ?? GLYPHS["?"]!;
    const gx = x + i * GLYPH_ADVANCE * scale;
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = glyph.charCodeAt(row) - 48;
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits & (4 >> col)) ctx.fillRect(gx + col * scale, y + row * scale, scale, scale);
      }
    }
  }
}

/** Text on a solid chip (2px padding, optional 1px border), for signs and HUD labels that must stay
 * legible over busy scenery. Returns the chip's width. */
export function drawTextChip(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fg: string,
  bg: string,
  border?: string,
): number {
  const w = textWidth(text) + 4;
  const h = GLYPH_H + 4;
  const rx = Math.round(x);
  const ry = Math.round(y);
  if (border) {
    ctx.fillStyle = border;
    ctx.fillRect(rx - 1, ry - 1, w + 2, h + 2);
  }
  ctx.fillStyle = bg;
  ctx.fillRect(rx, ry, w, h);
  drawText(ctx, text, rx + 2, ry + 2, fg);
  return w;
}
