// #498: the Knight Rider scanner (docs/design/sessions-redesign-demo.html note 14): a 5px strip of
// pixel segments across the transcript/composer seam while a turn runs. The head eases back and
// forth with a glow and a fading trail; under reduced motion the whole strip pulses gently instead.
//
// The geometry and the frame are pure functions of the width and the clock, so they're testable;
// KnightRiderScanner.tsx only paints them.

export const SEGMENT_PX = 6;
export const GAP_PX = 2;
/** One full sweep, there and back. */
export const PERIOD_MS = 1900;
/** Every segment's resting glow, so the strip reads as a strip when the head is elsewhere. */
export const BASE_ALPHA = 0.13;

export interface ScannerLayout {
  /** Segments that fit. */
  count: number;
  /** Left inset that centres the row. */
  offset: number;
  step: number;
}

export function scannerLayout(width: number): ScannerLayout {
  const step = SEGMENT_PX + GAP_PX;
  const count = Math.max(1, Math.floor((width + GAP_PX) / step));
  return { count, offset: (width - (count * step - GAP_PX)) / 2, step };
}

export interface ScannerFrame {
  /** Head position in segments, eased; 0 .. count-1. */
  head: number;
  /** +1 sweeping right, -1 sweeping left. */
  dir: 1 | -1;
  /** Lit segments behind the head: index and opacity, brightest last. */
  trail: Array<{ index: number; alpha: number }>;
}

/** Where the head is at time `t`, and its trail. */
export function scannerFrame(count: number, t: number): ScannerFrame {
  const p = (((t % PERIOD_MS) + PERIOD_MS) % PERIOD_MS) / PERIOD_MS;
  const tri = p < 0.5 ? p * 2 : 2 - p * 2;
  const head = (0.5 - 0.5 * Math.cos(tri * Math.PI)) * (count - 1);
  const dir = p < 0.5 ? 1 : -1;
  const length = Math.max(5, Math.round(count * 0.14));
  const trail: ScannerFrame["trail"] = [];
  for (let k = length; k >= 0; k--) {
    const index = Math.round(head - dir * k);
    if (index < 0 || index >= count) continue;
    trail.push({ index, alpha: Math.pow(1 - k / (length + 1), 1.8) });
  }
  return { head, dir, trail };
}

/** Reduced motion: every segment breathes together, between about 0.1 and 0.8. */
export function pulseAlpha(t: number): number {
  return 0.45 + 0.35 * Math.sin(t / 400);
}

/** Paints one frame. `color` is the strip's resolved colour (the canvas's CSS `color`). */
export function drawScanner(ctx: CanvasRenderingContext2D, width: number, height: number, t: number, color: string, reduced: boolean): void {
  const { count, offset, step } = scannerLayout(width);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = color;
  ctx.globalAlpha = BASE_ALPHA;
  for (let i = 0; i < count; i++) ctx.fillRect(offset + i * step, 0, SEGMENT_PX, height);
  if (reduced) {
    ctx.globalAlpha = pulseAlpha(t);
    for (let i = 0; i < count; i++) ctx.fillRect(offset + i * step, 0, SEGMENT_PX, height);
    ctx.globalAlpha = 1;
    return;
  }
  const frame = scannerFrame(count, t);
  for (const { index, alpha } of frame.trail) {
    ctx.globalAlpha = alpha;
    ctx.fillRect(offset + index * step, 0, SEGMENT_PX, height);
  }
  ctx.globalAlpha = 1;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.fillRect(offset + Math.round(frame.head) * step - 1, 0, SEGMENT_PX + 2, height);
  ctx.shadowBlur = 0;
}
